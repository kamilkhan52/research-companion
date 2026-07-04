"""Global citation counts for graph nodes, via Semantic Scholar (free; optional API key for
higher limits). Feeds the recommendation score: an external work cited 5,000 times in the wild
matters differently than one cited 30 times, even at the same in-project citation count.

Two lookups, both best-effort:
  * batch by id (ARXIV:/DOI:) — one POST covers up to 500 nodes; reliable and unthrottled.
  * title match for nodes without ids — one GET per title and aggressively rate-limited without
    a key, so it's paced, capped to the most promising nodes, and gives up quietly on 429s.

Results are cached in the graph store (node id -> count), so counts accumulate across builds
and a paper is never looked up twice. Counts drift upward over time, but for ranking purposes
staleness is harmless.
"""
from __future__ import annotations

import os
import time

import httpx

from . import config

S2_BATCH_URL = "https://api.semanticscholar.org/graph/v1/paper/batch"
S2_MATCH_URL = "https://api.semanticscholar.org/graph/v1/paper/search/match"
BATCH_CHUNK = 500
MAX_TITLE_LOOKUPS = 25          # per build; cached, so coverage grows build over build
TITLE_LOOKUP_INTERVAL_S = 1.2   # pacing for the unauthenticated match endpoint
TIMEOUT_S = 30.0


def _api_key() -> str:
    return (os.environ.get("SEMANTIC_SCHOLAR_API_KEY") or os.environ.get("S2_API_KEY")
            or config.load_settings().get("semantic_scholar_api_key") or "")


def _headers() -> dict:
    key = _api_key()
    return {"x-api-key": key} if key else {}


def _external_id(node: dict) -> str | None:
    if node.get("arxiv_id"):
        return f"ARXIV:{node['arxiv_id']}"
    if node.get("doi"):
        return f"DOI:{node['doi']}"
    return None


def annotate_nodes(nodes: list[dict], cache: dict, *, client: httpx.Client | None = None,
                   sleep=time.sleep) -> None:
    """Set node["citation_count"] (int, or None when unknown) on every node, fetching what the
    cache doesn't already have and updating `cache` (persisted by the caller via the graph
    store). Never raises: citation counts are an enrichment, not a build dependency."""
    own = client is None
    client = client or httpx.Client(timeout=TIMEOUT_S)
    try:
        _fetch_missing(nodes, cache, client, sleep)
    except Exception:
        pass  # enrichment only — a failed/interrupted fetch must never fail the build
    finally:
        if own:
            client.close()
    for n in nodes:
        n["citation_count"] = cache.get(n["id"])


def _fetch_missing(nodes: list[dict], cache: dict, client: httpx.Client, sleep) -> None:
    missing = [n for n in nodes if n["id"] not in cache]

    # 1) batch by external id — cheap, do every node that has one.
    with_ids = [(n, _external_id(n)) for n in missing]
    with_ids = [(n, eid) for n, eid in with_ids if eid]
    for start in range(0, len(with_ids), BATCH_CHUNK):
        chunk = with_ids[start:start + BATCH_CHUNK]
        resp = client.post(S2_BATCH_URL, params={"fields": "citationCount"},
                           headers=_headers(), json={"ids": [eid for _, eid in chunk]})
        if resp.status_code != 200:
            break
        for (n, _eid), row in zip(chunk, resp.json(), strict=False):
            # null row = S2 doesn't know this id: record the miss so we don't retry every build.
            cache[n["id"]] = row.get("citationCount") if isinstance(row, dict) else None

    # 2) title match for id-less nodes — throttled without a key, so pace, cap to the nodes
    #    that actually influence recommendations (most-cited-in-project first), and stop at the
    #    first 429 (the endpoint stays throttled once it starts).
    titled = [n for n in missing if not _external_id(n) and n["id"] not in cache
              and n.get("kind") == "external" and len(n.get("title", "")) >= 15]
    titled.sort(key=lambda n: (n.get("significant_cited_by_count", 0),
                               n.get("cited_by_project_count", 0)), reverse=True)
    for n in titled[:MAX_TITLE_LOOKUPS]:
        resp = client.get(S2_MATCH_URL, headers=_headers(),
                          params={"query": n["title"], "fields": "citationCount,matchScore"})
        if resp.status_code == 429:
            break
        if resp.status_code == 200:
            rows = (resp.json() or {}).get("data") or []
            if rows and isinstance(rows[0], dict):
                cache[n["id"]] = rows[0].get("citationCount")
            else:
                cache[n["id"]] = None
        elif resp.status_code == 404:
            cache[n["id"]] = None  # definitive miss — don't retry every build
        sleep(TITLE_LOOKUP_INTERVAL_S)
