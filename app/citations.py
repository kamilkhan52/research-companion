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

import httpx

from . import logging_config, semantic_scholar

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
OPENALEX_SEARCH_URL = "https://api.openalex.org/works"
#: Word-count bounds for accepting a title as the same paper. See `_same_paper_title`: a stored
#: title is often a truncation of the full one, but a title that continues for long enough is a
#: different paper.
MIN_TITLE_WORDS = 4
MAX_TITLE_TAIL_WORDS = 6
#: Candidates to consider per title. More than one because OpenAlex holds duplicate records for
#: the same paper — an exact-title match returned "Attention Is All You Need" with 6,598 citations
#: while the canonical record has far more — so the best-matching title is not enough on its own.
OPENALEX_CANDIDATES = 5
#: OpenAlex asks callers to identify themselves; requests that do are served from a faster pool.
OPENALEX_HEADERS = {"User-Agent": "Scholiast (https://scholiast.io; mailto:kaamilkhaan52@gmail.com)"}


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
    openalex = httpx.Client(timeout=TIMEOUT_S, headers=OPENALEX_HEADERS)
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
        n["citation_count"] = cache.get(n["id"])
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
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", (title or "").lower()).split())


def _same_paper_title(query: str, candidate: str) -> bool:
    """Whether `candidate` names the same paper as `query`.

    Word-level rather than fuzzy, and that is the point. A character-ratio test rated
    "Attention Is All You Need" and "Attention Is *Not* All You Need" as a 0.93 match — and since
    the fallback takes the highest count among matches, a near-miss title is MORE dangerous than a
    distant one, not less. One inserted word can change a title into a different paper's.

    So: the same words, or the candidate is the query plus a short tail. The tail allows a node
    whose stored title was truncated ("BERT: Pre-training of deep bidirectional transformers") to
    match the full record, while a genuinely longer, different title does not.
    """
    q, c = _normalized_title(query).split(), _normalized_title(candidate).split()
    if not q or not c:
        return False
    if q == c:
        return True
    shorter, longer = (q, c) if len(q) <= len(c) else (c, q)
    return (
        len(shorter) >= MIN_TITLE_WORDS
        and longer[:len(shorter)] == shorter
        and len(longer) - len(shorter) <= MAX_TITLE_TAIL_WORDS
    )


def _openalex_citation_count(title: str, client: httpx.Client) -> int | None:
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
        )
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
    missing = [n for n in nodes if n["id"] not in cache]

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
            cache[n["id"]] = row.get("citationCount") if isinstance(row, dict) else None

    # 2) title match for id-less nodes — throttled without a key, so pace, cap to the nodes
    #    that actually influence recommendations (most-cited-in-project first), and stop at the
    #    first 429 (the endpoint stays throttled once it starts).
    titled = [n for n in missing if not _external_id(n) and n["id"] not in cache
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
                params={"query": title, "fields": "citationCount,matchScore"},
            ),
            pacer=pacer,
        )
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

    # 3) OpenAlex for whatever Semantic Scholar still could not place. A different index with
    #    different coverage and no key requirement, so it reaches papers S2 simply does not hold —
    #    and the ones left here are the long tail that `significant_cited_by_count` and discovery
    #    depend on. Only a verified match is recorded (see `_openalex_citation_count`); an
    #    unverified one would be a wrong number, which nothing downstream could detect.
    if openalex_client is None:
        return          # no OpenAlex client supplied (tests inject one deliberately)
    still_missing = [
        n for n in nodes
        if cache.get(n["id"]) is None and len(n.get("title", "")) >= 15
    ]
    for n in still_missing[:MAX_TITLE_LOOKUPS_WITH_KEY]:
        count = _openalex_citation_count(n["title"], openalex_client)
        if count is not None:
            cache[n["id"]] = count
