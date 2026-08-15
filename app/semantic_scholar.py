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

from . import config, spend_control

BASE_URL = "https://api.semanticscholar.org/graph/v1"
REFERENCE_FIELDS = (
    "contexts,intents,isInfluential,title,authors,year,venue,externalIds,url"
)
SEARCH_FIELDS = (
    "paperId,title,abstract,authors,year,venue,externalIds,url,citationCount,"
    "influentialCitationCount,fieldsOfStudy,publicationTypes,publicationDate,openAccessPdf"
)
# Inbound-edge fields for the forward delta (DR-052 PR 2). Two things this deliberately does NOT
# ask for, both measured live 2026-08-14 (docs/corpus-neighbourhood-spec.md §3):
#
# - `intents`, S2's own citation-intent labels, look like exactly the significance signal lane 1
#   wants. Their coverage is ~70% on pre-2024 citing papers and ~18% on 2024+ — 0 of the 300
#   newest citers of "Attention Is All You Need" carried one — because the classifier needs a
#   parsed full text and runs a year or two behind. For MONITORING, which is about the newest
#   papers by construction, that is a signal that is absent exactly when it is needed. We take
#   the raw `contexts` sentences instead (44-76% even on brand-new citers) and classify them
#   ourselves in PR 3.
# - Deep pagination. `/citations` returns newest-first and dies past offset ~10,000, and the
#   delta only ever needs the newest page per anchor.
#
# `citingPaper.*` subfields are listed explicitly on purpose: asking for edge fields alone
# (`fields=intents`) silently omits the citingPaper object entirely, leaving rows with no way to
# identify the citer.
CITATION_FIELDS = (
    "contexts,isInfluential,"
    "citingPaper.paperId,citingPaper.title,citingPaper.abstract,citingPaper.year,"
    "citingPaper.authors,citingPaper.venue,citingPaper.externalIds,citingPaper.url,"
    "citingPaper.citationCount,citingPaper.referenceCount,citingPaper.publicationTypes,"
    "citingPaper.publicationDate"
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
                # Final boundary, AFTER pacing sleep. An operator can enable the emergency stop
                # while a request waits its turn; checking only before acquiring/sleeping would
                # still dispatch that now-disabled request.
                spend_control.require_enabled()
                return request()
            finally:
                self._last_completed = self._clock()


_PACER = RequestPacer()


def paced_request(
    request: Callable[[], httpx.Response],
    *,
    pacer: RequestPacer | None = None,
) -> httpx.Response:
    """Run any Semantic Scholar request through spend control and account-wide pacing.

    Citation enrichment and Discovery recall call this helper directly rather than `_request`, so
    the kill switch belongs here to cover the provider structurally instead of per endpoint.
    """
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


def _headers(key: str | None, *, required: bool = True) -> dict[str, str]:
    effective = (key if key is not None else api_key()).strip()
    if not effective:
        if required:
            raise SemanticScholarError(
                "No Semantic Scholar API key is configured. Add one in Settings."
            )
        return {}
    return {"x-api-key": effective}


def _request(
    client: httpx.Client,
    path: str,
    *,
    params: dict[str, Any],
    key: str | None = None,
    pacer: RequestPacer = _PACER,
    sleep: Callable[[float], None] = time.sleep,
    require_key: bool = True,
) -> httpx.Response:
    headers = _headers(key, required=require_key)
    response: httpx.Response | None = None
    for attempt in range(MAX_RETRIES):
        try:
            spend_control.require_enabled()
            response = paced_request(
                lambda: client.get(path, params=params, headers=headers), pacer=pacer
            )
        except spend_control.ProviderSpendDisabled as exc:
            raise SemanticScholarError(str(exc)) from exc
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


def _normalize_search_result(row: dict[str, Any]) -> dict[str, Any] | None:
    title = str(row.get("title") or "").strip()
    paper_id = str(row.get("paperId") or "").strip()
    if not title or not paper_id:
        return None
    external_ids = row.get("externalIds") or {}
    if not isinstance(external_ids, dict):
        external_ids = {}
    raw_authors = row.get("authors") or []
    raw_fields = row.get("fieldsOfStudy") or []
    raw_types = row.get("publicationTypes") or []
    doi = external_ids.get("DOI")
    arxiv_id = external_ids.get("ArXiv") or external_ids.get("ARXIV")
    open_access = row.get("openAccessPdf") or {}
    if not isinstance(open_access, dict):
        open_access = {}
    pdf_url = str(open_access.get("url") or "").strip()
    if not pdf_url and arxiv_id:
        pdf_url = f"https://arxiv.org/pdf/{arxiv_id}"
    return {
        "provider": "semantic_scholar",
        "paper_id": paper_id,
        "title": title,
        "abstract": str(row.get("abstract") or "").strip(),
        "authors": [
            str(author.get("name") or "").strip()
            for author in raw_authors
            if isinstance(author, dict) and author.get("name")
        ],
        "author_ids": [
            str(author.get("authorId") or "").strip()
            for author in raw_authors
            if isinstance(author, dict) and author.get("authorId")
        ],
        "year": row.get("year") if isinstance(row.get("year"), int) else None,
        "venue": str(row.get("venue") or "").strip(),
        "arxiv_id": arxiv_id,
        "doi": doi,
        "url": f"https://doi.org/{doi}" if doi else str(row.get("url") or "").strip(),
        "provider_url": str(row.get("url") or "").strip(),
        "pdf_url": pdf_url,
        "citation_count": (
            row.get("citationCount") if isinstance(row.get("citationCount"), int) else None
        ),
        "influential_citation_count": (
            row.get("influentialCitationCount")
            if isinstance(row.get("influentialCitationCount"), int)
            else None
        ),
        "fields_of_study": [
            str(value).strip() for value in raw_fields if str(value).strip()
        ],
        "publication_types": [
            str(value).strip() for value in raw_types if str(value).strip()
        ],
        "publication_date": str(row.get("publicationDate") or "").strip() or None,
        "category": str(raw_fields[0]).strip() if raw_fields else "",
    }


def search_papers(
    query: str,
    limit: int = 25,
    *,
    key: str | None = None,
    client: httpx.Client | None = None,
    pacer: RequestPacer = _PACER,
    sleep: Callable[[float], None] = time.sleep,
) -> list[dict[str, Any]]:
    """Relevance search across Semantic Scholar's cross-venue corpus.

    Unlike reference-graph metadata, discovery may use the documented anonymous tier when no
    key is configured. The shared pacer still serializes every request account-wide; rate limits
    and provider failures surface as SemanticScholarError so discovery can degrade to arXiv.
    """
    query = query.strip()
    if not query:
        return []
    own_client = client is None
    client = client or httpx.Client(base_url=BASE_URL, timeout=TIMEOUT_S)
    try:
        response = _request(
            client,
            "/paper/search",
            params={
                "query": query,
                "limit": max(1, min(100, int(limit))),
                "fields": SEARCH_FIELDS,
            },
            key=key,
            pacer=pacer,
            sleep=sleep,
            require_key=False,
        )
        payload = response.json()
        if not isinstance(payload, dict):
            raise TypeError("search response is not an object")
        rows = payload.get("data")
        if rows is None:
            rows = []
        if not isinstance(rows, list):
            raise TypeError("search data is not a list")
        return [
            normalized
            for row in rows
            if isinstance(row, dict)
            and (normalized := _normalize_search_result(row)) is not None
        ]
    except (TypeError, ValueError) as exc:
        raise SemanticScholarError(
            "Semantic Scholar returned malformed search metadata."
        ) from exc
    finally:
        if own_client:
            client.close()


def bulk_search_papers(
    query: str,
    limit: int = 2_000,
    *,
    from_date: str | None = None,
    key: str | None = None,
    client: httpx.Client | None = None,
    pacer: RequestPacer = _PACER,
    sleep: Callable[[float], None] = time.sleep,
    should_cancel: Callable[[], bool] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Wide, cursor-paged recall through Semantic Scholar's ``paper/search/bulk`` endpoint.

    The ordinary relevance endpoint tops out at 100 rows. Bulk returns up to 1,000 per page and
    a continuation token, which is the reservoir Discovery needs before semantic screening. It
    remains account-wide paced and anonymous-capable like ``search_papers``. The audit explicitly
    reports whether the continuation was exhausted: callers must not advance a durable frontier
    when a configured cap truncated the result set.
    """
    query = query.strip()
    cap = max(1, min(8_000, int(limit)))
    if not query:
        return [], {"pages": 0, "complete": True, "next_token": None}
    own_client = client is None
    client = client or httpx.Client(base_url=BASE_URL, timeout=TIMEOUT_S)
    output: list[dict[str, Any]] = []
    token: str | None = None
    pages = 0
    seen_tokens: set[str] = set()
    cancelled = should_cancel or (lambda: False)
    try:
        while len(output) < cap:
            if cancelled():
                return output, {"pages": pages, "complete": False, "next_token": token,
                                "rows": len(output), "cancelled": True}
            # Bulk defaults to a much smaller page. Ask for the documented maximum so a
            # 2,000-row lane is two paced requests rather than roughly twenty.
            params: dict[str, Any] = {
                "query": query,
                "fields": SEARCH_FIELDS,
                "limit": min(1_000, cap - len(output)),
            }
            if token:
                params["token"] = token
            if from_date:
                params["publicationDateOrYear"] = f"{from_date}:"
            response = _request(
                client, "/paper/search/bulk", params=params, key=key, pacer=pacer,
                sleep=sleep, require_key=False)
            pages += 1
            try:
                payload = response.json()
                if not isinstance(payload, dict):
                    raise TypeError("bulk response is not an object")
                rows = payload.get("data") or []
                if not isinstance(rows, list):
                    raise TypeError("bulk data is not a list")
            except (TypeError, ValueError) as exc:
                raise SemanticScholarError(
                    "Semantic Scholar returned malformed bulk-search metadata.") from exc
            for row in rows:
                if isinstance(row, dict) and (
                    normalized := _normalize_search_result(row)
                ) is not None:
                    output.append(normalized)
                    if len(output) >= cap:
                        break
            raw_token = payload.get("token")
            next_token = str(raw_token).strip() if raw_token else None
            if not next_token or not rows:
                token = None
                break
            if next_token in seen_tokens:
                raise SemanticScholarError("Semantic Scholar repeated a bulk-search token.")
            seen_tokens.add(next_token)
            token = next_token
        return output, {"pages": pages, "complete": token is None,
                        "next_token": token, "rows": len(output), "cancelled": False}
    finally:
        if own_client:
            client.close()


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


def _normalize_citation(row: dict[str, Any]) -> dict[str, Any] | None:
    """One inbound edge: who cites us, and the sentences in which they do it."""
    citing = row.get("citingPaper")
    if not isinstance(citing, dict):
        return None
    paper_id = str(citing.get("paperId") or "").strip()
    title = str(citing.get("title") or "").strip()
    if not paper_id or not title:
        return None
    external = citing.get("externalIds") if isinstance(citing.get("externalIds"), dict) else {}
    authors = [
        str(a.get("name") or "").strip()
        for a in (citing.get("authors") or [])
        if isinstance(a, dict) and str(a.get("name") or "").strip()
    ]
    contexts = [
        str(c).strip() for c in (row.get("contexts") or [])
        if isinstance(c, (str, int, float)) and str(c).strip()
    ]
    return {
        "paper_id": paper_id,
        "title": title,
        "abstract": str(citing.get("abstract") or ""),
        "year": citing.get("year"),
        "authors": authors[:12],
        "venue": str(citing.get("venue") or ""),
        "doi": str(external.get("DOI") or "").lower(),
        "arxiv_id": str(external.get("ArXiv") or ""),
        "url": str(citing.get("url") or ""),
        "citation_count": citing.get("citationCount"),
        "reference_count": citing.get("referenceCount"),
        "publication_types": [t for t in (citing.get("publicationTypes") or []) if t],
        "publication_date": str(citing.get("publicationDate") or ""),
        # The lane-1 evidence. `contexts` is what the reader is eventually shown ("cited your
        # Foo et al. in Methods, as the approach they extend"), and what PR 3 classifies.
        "contexts": contexts[:8],
        "is_influential": bool(row.get("isInfluential")),
    }


def citing_papers(
    identifier: str,
    *,
    limit: int = 100,
    key: str | None = None,
    client: httpx.Client | None = None,
    pacer: RequestPacer = _PACER,
    sleep: Callable[[float], None] = time.sleep,
) -> list[dict[str, Any]]:
    """The newest papers citing one resolved paper, with the citation contexts.

    ONE page, newest-first, no pagination — this serves the forward DELTA (DR-052), where the
    stored citer-id set is the memory and each sweep only has to reach back far enough to cover
    what has appeared since the last one. Walking the full citer list of a well-cited paper
    would be both pointless and impossible (the endpoint stops returning rows past offset
    ~10,000).
    """
    if not identifier.strip():
        raise SemanticScholarError("A Semantic Scholar paper identifier is required.")
    own_client = client is None
    client = client or httpx.Client(base_url=BASE_URL, timeout=TIMEOUT_S)
    encoded = quote(identifier.strip(), safe=":")
    try:
        response = _request(
            client,
            f"/paper/{encoded}/citations",
            params={"fields": CITATION_FIELDS, "offset": 0, "limit": max(1, min(limit, 1000))},
            key=key,
            pacer=pacer,
            sleep=sleep,
        )
        try:
            payload = response.json()
            if not isinstance(payload, dict):
                raise TypeError("citation response is not an object")
            rows = payload.get("data") or []
        except (TypeError, ValueError) as exc:
            raise SemanticScholarError(
                "Semantic Scholar returned malformed citation metadata."
            ) from exc
        if not isinstance(rows, list):
            raise SemanticScholarError("Semantic Scholar citations were not a list.")
        return [
            edge for row in rows
            if isinstance(row, dict) and (edge := _normalize_citation(row)) is not None
        ]
    finally:
        if own_client:
            client.close()
