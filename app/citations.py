"""Global citation counts for graph nodes, via Semantic Scholar (free; optional API key for
higher limits). Feeds the recommendation score: an external work cited 5,000 times in the wild
matters differently than one cited 30 times, even at the same in-project citation count.

Two lookups, both best-effort and routed through the shared account-wide request pacer:
  * batch by id (ARXIV:/DOI:) — one POST covers up to 500 nodes.
  * title match for nodes without ids — one GET per title, capped to the most promising nodes,
    and gives up quietly on 429s.

Results are cached in the graph store (node id -> count), so counts accumulate across builds
and a paper is never looked up twice. Counts drift upward over time, but for ranking purposes
staleness is harmless.
"""
from __future__ import annotations

import re
import time
from urllib.parse import quote

import httpx

from . import logging_config, semantic_scholar
from . import openalex as openalex_mod

S2_BATCH_URL = "https://api.semanticscholar.org/graph/v1/paper/batch"
S2_MATCH_URL = "https://api.semanticscholar.org/graph/v1/paper/search/match"
BATCH_CHUNK = 500
#: Title lookups per build. Without a key the endpoint is throttled hard and shared with everyone
#: else, so 25 is all that can be attempted before it starts refusing; with a key the account gets
#: a guaranteed 1 request/second, and the whole point of having one is that a project's long tail
#: resolves in a single build instead of creeping up over many. Results are cached either way.
MAX_TITLE_LOOKUPS = 25
MAX_TITLE_LOOKUPS_WITH_KEY = 400
TIMEOUT_S = 30.0

#: OpenAlex covers papers Semantic Scholar cannot resolve from a title, and needs no key. Used
#: only as a fallback, and only with a match check — see `_openalex_citation_count`.
OPENALEX_WORKS_URL = "https://api.openalex.org/works"
OPENALEX_SEARCH_URL = OPENALEX_WORKS_URL
#: Word-count bounds for accepting a title as the same paper. See `_same_paper_title`: a stored
#: title is often a truncation of the full one, but a title that continues for long enough is a
#: different paper.
MIN_TITLE_WORDS = 4
MAX_TITLE_TAIL_WORDS = 6
#: Candidates to consider per title. More than one because OpenAlex holds duplicate records for
#: the same paper — an exact-title match returned "Attention Is All You Need" with 6,598 citations
#: while the canonical record has far more — so the best-matching title is not enough on its own.
OPENALEX_CANDIDATES = 5
#: Bounds on the OpenAlex stage. Anonymous use is budgeted below a few hundred searches a day and
#: answers 429 beyond that, and an unpaced loop over a large graph would both exhaust that and, at
#: one 30s timeout per call, run for hours inside a graph build. So: paced like Semantic Scholar,
#: capped per build, given a wall-clock budget, and stopped dead on the first 429.
OPENALEX_MAX_LOOKUPS = 120
OPENALEX_MIN_INTERVAL_S = 0.2
OPENALEX_BUDGET_S = 180.0
OPENALEX_REQUEST_TIMEOUT_S = 10.0
#: Identify ourselves the way the existing OpenAlex integration does — from deployment
#: configuration (`RC_CONTACT_EMAIL`), never a hardcoded address in the repo.


def _api_key() -> str:
    return semantic_scholar.api_key()


def _redacted(message: str) -> str:
    """A failure message with the configured API key removed.

    Not theoretical: a malformed key makes h11 raise `Illegal header value b'<the whole key>'`,
    so logging the exception text verbatim would write the operator's Semantic Scholar key into
    the logs — and the messages worth logging are exactly the ones raised while that key is in
    an outgoing header.
    """
    key = _api_key()
    return message.replace(key, "***") if key else message


def _headers() -> dict:
    key = _api_key()
    return {"x-api-key": key} if key else {}


def _external_id(node: dict) -> str | None:
    if node.get("arxiv_id"):
        return f"ARXIV:{node['arxiv_id']}"
    if node.get("doi"):
        return f"DOI:{node['doi']}"
    return None


log = logging_config.get("citations")

def annotate_nodes(nodes: list[dict], cache: dict, *, client: httpx.Client | None = None,
                   sleep=time.sleep) -> None:
    """Set node["citation_count"] (int, or None when unknown) on every node, fetching what the
    cache doesn't already have and updating `cache` (persisted by the caller via the graph
    store). Never raises: citation counts are an enrichment, not a build dependency."""
    own = client is None
    client = client or httpx.Client(timeout=TIMEOUT_S)
    before = len(cache)
    # OpenAlex gets its own client: a different host, and it asks callers to identify themselves
    # so requests land in its faster "polite pool" rather than the anonymous one.
    openalex = httpx.Client(timeout=TIMEOUT_S, headers=openalex_mod._headers())
    try:
        _fetch_missing(nodes, cache, client, sleep, openalex_client=openalex)
    except Exception as e:  # noqa: BLE001 — enrichment must never fail the build
        # Logged, not just swallowed. A build that quietly resolved NOTHING is
        # indistinguishable from one that was never asked to, and that is exactly how a graph
        # of 402 papers ended up with zero citation counts and no trace of why.
        log.warning("citation enrichment stopped early (%s): %s",
                    type(e).__name__, _redacted(str(e))[:200])
    finally:
        openalex.close()
        if own:
            client.close()
    for n in nodes:
        n["citation_count"] = cache.get(cache_key(n))
    resolved = sum(1 for n in nodes if n.get("citation_count") is not None)
    if nodes and not resolved:
        # The one outcome worth a warning on its own: the enrichment ran and produced nothing.
        log.warning("citation enrichment resolved 0 of %d nodes (cache %d -> %d)",
                    len(nodes), before, len(cache))
    else:
        log.info("citation counts: %d of %d nodes (cache %d -> %d)",
                 resolved, len(nodes), before, len(cache))


def _normalized_title(title: str) -> str:
    """Lowercased alphanumeric words, so punctuation and casing do not decide a match."""
    # Strips punctuation but KEEPS non-ASCII letters: an earlier version dropped them, so
    # "α-divergence" and "β-divergence" normalized identically and one paper's count could be
    # cached against the other.
    return " ".join(re.sub(r"[^\w ]", " ", (title or "").lower(), flags=re.UNICODE).split())


def _same_paper_title(query: str, candidate: str) -> bool:
    """Whether `candidate` names the same paper as `query`. Exact, after normalization.

    A character-ratio test rated "Attention Is All You Need" and "Attention Is *Not* All You Need"
    a 0.93 match, and because this fallback takes the highest count among matches, a NEAR-miss is
    more dangerous than a distant one — it is both plausible and wrong.

    An earlier version also accepted a short trailing difference, to catch stored titles that were
    truncated. That is too loose in the direction that costs: it accepts "A Survey of Large
    Language Models" against "A Survey of Large Language Models for Medicine", and a base paper
    against its "… Part II". Coverage bought that way is coverage of the wrong numbers, and once
    cached under the node id it is never revisited. Papers whose stored title is truncated are
    reached by identifier instead, which cannot be ambiguous.
    """
    q, c = _normalized_title(query), _normalized_title(candidate)
    return bool(q) and q == c


#: Returned instead of a count when OpenAlex rate-limits us, so the caller stops rather than
#: spending the rest of the budget collecting 429s.
_THROTTLED = object()


def cache_key(node: dict) -> str:
    """Cache key for a node's citation count: its id PLUS the identity the count was resolved
    from.

    The id alone is a slug, and a slug outlives the paper's metadata. Correcting a wrong arXiv id
    on an existing entry — exactly what happens after a mis-retrieval — would otherwise keep
    serving the previous paper's citation count forever, because the cache would still hit. Adding
    the identity means a corrected id simply misses and re-resolves.
    """
    identity = (node.get("arxiv_id") or node.get("doi") or _normalized_title(node.get("title", "")))
    return f"{node['id']}|{identity}"


def _openalex_by_id(node: dict, client: httpx.Client, *, timeout: float = OPENALEX_REQUEST_TIMEOUT_S):
    """OpenAlex's count for a node with a known arXiv id or DOI.

    Tried before any title matching, because an identifier IS the paper — there is nothing to
    verify and nothing to get wrong. It also recovers exactly the cases the strict title rule
    gives up on, such as a stored title that was truncated.
    """
    lookup = openalex_mod._work_lookup_id(arxiv_id=node.get("arxiv_id"), doi=node.get("doi"))
    if not lookup:
        return None
    try:
        resp = client.get(f"{OPENALEX_WORKS_URL}/{quote(lookup, safe=':./')}",
                          params={"select": "cited_by_count"}, timeout=timeout)
        if resp.status_code == 429:
            return _THROTTLED
        if resp.status_code != 200:
            return None
        count = (resp.json() or {}).get("cited_by_count")
    except Exception:  # noqa: BLE001 — a fallback that fails is just an unresolved node
        return None
    return count if isinstance(count, int) else None


def _openalex_citation_count(title: str, client: httpx.Client, *, timeout: float = OPENALEX_REQUEST_TIMEOUT_S):
    """OpenAlex's count for `title`, or None when nothing matches it closely enough.

    Two checks, both learned from real failures on this project's graph rather than added
    defensively:

    The title must actually match. OpenAlex's relevance search answers every query with
    *something* — it offered TinyBERT for BERT — and recording that would put ~0 against a paper
    with over a hundred thousand citations. A number that is wrong is worse than one that is
    missing, because nothing downstream can tell.

    Among the titles that do match, take the HIGHEST count. OpenAlex keeps duplicate records for
    the same work (a preprint and its published version, an indexing artefact), and the top
    relevance hit is not reliably the canonical one — an exact-title match for "Attention Is All
    You Need" returned 6,598 while the real record has far more. The canonical record is the one
    the citations accumulated on.
    """
    try:
        resp = client.get(
            OPENALEX_SEARCH_URL,
            params={"search": title, "per-page": OPENALEX_CANDIDATES,
                    "select": "display_name,cited_by_count"},
            timeout=timeout,
        )
        if resp.status_code == 429:
            return _THROTTLED
        if resp.status_code != 200:
            return None
        rows = (resp.json() or {}).get("results") or []
    except Exception:  # noqa: BLE001 — a fallback that fails is just an unresolved node
        return None

    best: int | None = None
    for row in rows:
        if not isinstance(row, dict):
            continue
        if not _same_paper_title(title, row.get("display_name") or ""):
            continue
        count = row.get("cited_by_count")
        if isinstance(count, int) and (best is None or count > best):
            best = count
    return best


def _fetch_missing(
    nodes: list[dict],
    cache: dict,
    client: httpx.Client,
    sleep,
    *,
    pacer: semantic_scholar.RequestPacer | None = None,
    openalex_client: httpx.Client | None = None,
) -> None:
    missing = [n for n in nodes if cache_key(n) not in cache]

    # 1) batch by external id — cheap, do every node that has one.
    with_ids = [(n, _external_id(n)) for n in missing]
    with_ids = [(n, eid) for n, eid in with_ids if eid]
    for start in range(0, len(with_ids), BATCH_CHUNK):
        chunk = with_ids[start:start + BATCH_CHUNK]
        ids = [eid for _, eid in chunk]
        resp = semantic_scholar.paced_request(
            lambda ids=ids: client.post(
                S2_BATCH_URL,
                params={"fields": "citationCount"},
                headers=_headers(),
                json={"ids": ids},
            ),
            pacer=pacer,
        )
        if resp.status_code != 200:
            break
        for (n, _eid), row in zip(chunk, resp.json(), strict=False):
            # null row = S2 doesn't know this id: record the miss so we don't retry every build.
            cache[cache_key(n)] = row.get("citationCount") if isinstance(row, dict) else None

    # 2) title match for id-less nodes — throttled without a key, so pace, cap to the nodes
    #    that actually influence recommendations (most-cited-in-project first), and stop at the
    #    first 429 (the endpoint stays throttled once it starts).
    titled = [n for n in missing if not _external_id(n) and cache_key(n) not in cache
              and len(n.get("title", "")) >= 15]
    titled.sort(key=lambda n: (n.get("significant_cited_by_count", 0),
                               n.get("cited_by_project_count", 0)), reverse=True)
    budget = MAX_TITLE_LOOKUPS_WITH_KEY if _api_key() else MAX_TITLE_LOOKUPS
    for n in titled[:budget]:
        title = n["title"]
        resp = semantic_scholar.paced_request(
            lambda title=title: client.get(
                S2_MATCH_URL,
                headers=_headers(),
                params={"query": title, "fields": "title,citationCount,matchScore"},
            ),
            pacer=pacer,
        )
        if resp.status_code == 429:
            break
        if resp.status_code == 200:
            rows = (resp.json() or {}).get("data") or []
            # Verified the same way as the OpenAlex fallback. This endpoint returns the CLOSEST
            # title match, not a paper identity, and the count was previously taken on trust — a
            # hazard at 25 lookups a build and sixteen times the exposure at 400. `matchScore` was
            # requested and never read, which is the same mistake in a different form.
            if rows and isinstance(rows[0], dict) and _same_paper_title(
                    title, rows[0].get("title") or ""):
                cache[cache_key(n)] = rows[0].get("citationCount")
            else:
                cache[cache_key(n)] = None
        elif resp.status_code == 404:
            cache[cache_key(n)] = None  # definitive miss — don't retry every build

    # 3) OpenAlex for whatever Semantic Scholar still could not place. A different index with
    #    different coverage and no key requirement, so it reaches papers S2 simply does not hold —
    #    and the ones left here are the long tail that `significant_cited_by_count` and discovery
    #    depend on. Only a verified match is recorded (see `_openalex_citation_count`); an
    #    unverified one would be a wrong number, which nothing downstream could detect.
    if openalex_client is None:
        return          # no OpenAlex client supplied (tests inject one deliberately)
    still_missing = [
        n for n in nodes
        if cache.get(cache_key(n)) is None and len(n.get("title", "")) >= 15
    ]
    deadline = time.monotonic() + OPENALEX_BUDGET_S
    for n in still_missing[:OPENALEX_MAX_LOOKUPS]:
        if time.monotonic() >= deadline:
            log.info("openalex fallback stopped at its time budget")
            break
        # Each request gets only what is left of the budget, capped. httpx's timeout is
        # per-operation — a server that trickles bytes never trips it — so the between-nodes
        # deadline check alone does not bound total elapsed time.
        remaining = max(1.0, min(OPENALEX_REQUEST_TIMEOUT_S, deadline - time.monotonic()))
        count = _openalex_by_id(n, openalex_client, timeout=remaining)
        if count is None:
            count = _openalex_citation_count(n["title"], openalex_client, timeout=remaining)
        if count is _THROTTLED:
            log.info("openalex fallback stopped: rate limited")
            break
        if isinstance(count, int):
            cache[cache_key(n)] = count
        sleep(OPENALEX_MIN_INTERVAL_S)
