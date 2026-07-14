"""Semantic Scholar Academic Graph client for reference-graph metadata.

The approved API key is limited to one request per second cumulatively across endpoints.
All production Semantic Scholar graph requests must go through this module's shared pacer so
concurrent graph jobs cannot independently satisfy a local delay while collectively exceeding
the account limit. Callers remain responsible for running network work in background jobs.
"""
from __future__ import annotations

import os
import re
import threading
import time
from collections.abc import Callable
from typing import Any
from urllib.parse import quote

import httpx

from . import config

BASE_URL = "https://api.semanticscholar.org/graph/v1"
REFERENCE_FIELDS = (
    "contexts,intents,isInfluential,title,authors,year,venue,externalIds,url"
)
MIN_REQUEST_INTERVAL_S = 1.1
MAX_RETRIES = 3
TIMEOUT_S = 45.0


class SemanticScholarError(Exception):
    pass


class RequestPacer:
    """Serialize requests and keep their completion times safely over one second apart.

    Completion-to-next-start pacing is intentionally more conservative than start-to-start.
    Holding the lock through the request also makes the account-wide limit true across
    concurrent graph jobs in this single-process deployment.
    """

    def __init__(
        self,
        interval: float = MIN_REQUEST_INTERVAL_S,
        *,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.interval = max(0.0, interval)
        self._sleep = sleep
        self._clock = clock
        self._lock = threading.Lock()
        self._last_completed: float | None = None

    def call(self, request: Callable[[], httpx.Response]) -> httpx.Response:
        with self._lock:
            if self._last_completed is not None:
                remaining = self.interval - (self._clock() - self._last_completed)
                if remaining > 0:
                    self._sleep(remaining)
            try:
                return request()
            finally:
                self._last_completed = self._clock()


_PACER = RequestPacer()


def paced_request(
    request: Callable[[], httpx.Response],
    *,
    pacer: RequestPacer | None = None,
) -> httpx.Response:
    """Run any Semantic Scholar request through the account-wide pacing boundary."""
    return (pacer or _PACER).call(request)


def api_key() -> str:
    return (
        os.environ.get("SEMANTIC_SCHOLAR_API_KEY")
        or os.environ.get("S2_API_KEY")
        or config.load_settings().get("semantic_scholar_api_key")
        or ""
    ).strip()


def paper_identifier(*, arxiv_id: str | None = None, doi: str | None = None) -> str | None:
    if arxiv_id:
        clean = re.sub(r"v\d+$", "", arxiv_id.strip(), flags=re.IGNORECASE)
        return f"ARXIV:{clean}"
    if doi:
        clean = doi.strip()
        for prefix in ("https://doi.org/", "http://doi.org/", "https://dx.doi.org/"):
            if clean.lower().startswith(prefix):
                clean = clean[len(prefix):]
                break
        return f"DOI:{clean}" if clean else None
    return None


def _headers(key: str | None) -> dict[str, str]:
    effective = (key if key is not None else api_key()).strip()
    if not effective:
        raise SemanticScholarError(
            "No Semantic Scholar API key is configured. Add one in Settings."
        )
    return {"x-api-key": effective}


def _request(
    client: httpx.Client,
    path: str,
    *,
    params: dict[str, Any],
    key: str | None = None,
    pacer: RequestPacer = _PACER,
    sleep: Callable[[float], None] = time.sleep,
) -> httpx.Response:
    headers = _headers(key)
    response: httpx.Response | None = None
    for attempt in range(MAX_RETRIES):
        try:
            response = paced_request(
                lambda: client.get(path, params=params, headers=headers), pacer=pacer
            )
        except httpx.HTTPError as exc:
            if attempt + 1 == MAX_RETRIES:
                raise SemanticScholarError(f"Semantic Scholar request failed: {exc}") from exc
            sleep(2.0 * (attempt + 1))
            continue
        if response.status_code != 429:
            break
        if attempt + 1 < MAX_RETRIES:
            raw_retry = response.headers.get("retry-after", "2")
            try:
                retry_after = float(raw_retry)
            except ValueError:
                retry_after = 2.0
            sleep(max(retry_after, 2.0 * (attempt + 1)))
    if response is None:
        raise SemanticScholarError("Semantic Scholar request produced no response.")
    if response.status_code >= 400:
        raise SemanticScholarError(f"Semantic Scholar returned HTTP {response.status_code}.")
    return response


def resolve_paper(
    title: str,
    *,
    key: str | None = None,
    client: httpx.Client | None = None,
    pacer: RequestPacer = _PACER,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, Any] | None:
    """Resolve a title to Semantic Scholar's best paper match."""
    if not title.strip():
        return None
    own_client = client is None
    client = client or httpx.Client(base_url=BASE_URL, timeout=TIMEOUT_S)
    try:
        response = _request(
            client,
            "/paper/search/match",
            params={"query": title.strip(), "fields": "title,externalIds"},
            key=key,
            pacer=pacer,
            sleep=sleep,
        )
        payload = response.json()
        if not isinstance(payload, dict):
            raise TypeError("paper response is not an object")
        rows = payload.get("data")
        if rows is None:
            rows = []
        if not isinstance(rows, list):
            raise TypeError("paper data is not a list")
        return rows[0] if rows and isinstance(rows[0], dict) else None
    except (TypeError, ValueError) as exc:
        raise SemanticScholarError("Semantic Scholar returned malformed paper metadata.") from exc
    finally:
        if own_client:
            client.close()


def _normalize_reference(row: dict[str, Any]) -> dict[str, Any] | None:
    cited = row.get("citedPaper")
    if not isinstance(cited, dict) or not cited.get("title"):
        return None
    external_ids = cited.get("externalIds") or {}
    if not isinstance(external_ids, dict):
        external_ids = {}
    raw_contexts = row.get("contexts") or []
    raw_intents = row.get("intents") or []
    if not isinstance(raw_contexts, list):
        raw_contexts = []
    if not isinstance(raw_intents, list):
        raw_intents = []
    return {
        "provider": "semantic_scholar",
        "paper_id": cited.get("paperId"),
        "title": str(cited.get("title") or "").strip(),
        "authors": [
            str(author.get("name") or "").strip()
            for author in (cited.get("authors") or [])
            if isinstance(author, dict) and author.get("name")
        ],
        "venue": str(cited.get("venue") or "").strip(),
        "year": cited.get("year") if isinstance(cited.get("year"), int) else None,
        "arxiv_id": external_ids.get("ArXiv") or external_ids.get("ARXIV"),
        "doi": external_ids.get("DOI"),
        "url": cited.get("url"),
        "contexts": [str(value).strip() for value in raw_contexts if str(value).strip()],
        "intents": [str(value).strip() for value in raw_intents if str(value).strip()],
        "is_influential": bool(row.get("isInfluential")),
    }


def references(
    identifier: str,
    *,
    key: str | None = None,
    client: httpx.Client | None = None,
    pacer: RequestPacer = _PACER,
    sleep: Callable[[float], None] = time.sleep,
) -> list[dict[str, Any]]:
    """Fetch every outbound reference edge for one resolved paper, with pagination."""
    if not identifier.strip():
        raise SemanticScholarError("A Semantic Scholar paper identifier is required.")
    own_client = client is None
    client = client or httpx.Client(base_url=BASE_URL, timeout=TIMEOUT_S)
    output: list[dict[str, Any]] = []
    offset = 0
    encoded = quote(identifier.strip(), safe=":")
    try:
        while True:
            response = _request(
                client,
                f"/paper/{encoded}/references",
                params={"fields": REFERENCE_FIELDS, "offset": offset, "limit": 1000},
                key=key,
                pacer=pacer,
                sleep=sleep,
            )
            try:
                payload = response.json()
                if not isinstance(payload, dict):
                    raise TypeError("reference response is not an object")
                rows = payload.get("data")
                if rows is None:
                    rows = []
            except (TypeError, ValueError) as exc:
                raise SemanticScholarError(
                    "Semantic Scholar returned malformed reference metadata."
                ) from exc
            if not isinstance(rows, list):
                raise SemanticScholarError("Semantic Scholar references were not a list.")
            output.extend(
                ref for row in rows
                if isinstance(row, dict) and (ref := _normalize_reference(row)) is not None
            )
            next_offset = payload.get("next")
            if next_offset is None or not rows:
                return output
            try:
                offset = int(next_offset)
            except (TypeError, ValueError) as exc:
                raise SemanticScholarError(
                    "Semantic Scholar returned an invalid pagination cursor."
                ) from exc
    finally:
        if own_client:
            client.close()
