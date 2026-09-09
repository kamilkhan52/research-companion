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
from collections.abc import Callable
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
#: How specific a title must be before it may stand in for a paper's identity. A title is NOT an
#: identifier — distinct publications share exact titles, and "Artificial Intelligence" or "Deep
#: Learning" would otherwise match whichever record the index ranks first and cache its count
#: forever. Papers below this floor are reachable by arXiv id or DOI, which cannot be ambiguous;
#: giving up on the rest is the cheap side of the trade, because a wrong count is undetectable
#: downstream while a missing one is obvious.
MIN_TITLE_CHARS = 15
MIN_TITLE_WORDS = 4
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

#: Distinguishes "no cache entry" from an entry whose value is None. See `annotate_nodes`.
_UNCACHED = object()

def annotate_nodes(nodes: list[dict], cache: dict, *, client: httpx.Client | None = None,
                   sleep=time.sleep, should_stop: Callable[[], bool] | None = None) -> None:
    """Set node["citation_count"] (int, or None when unknown) on every node, fetching what the
    cache doesn't already have and updating `cache` (persisted by the caller via the graph
    store). Never raises: citation counts are an enrichment, not a build dependency."""
    own = client is None
    client = client or httpx.Client(timeout=TIMEOUT_S)
    before = len(cache)
    # OpenAlex gets its own client: a different host, its own polite-pool identification, and its
    # own API key — all of which `openalex.make_client` attaches in one place. Building a bare
    # client here is what left this step unkeyed on a $0.10/day allowance, which one pass of
    # `OPENALEX_MAX_LOOKUPS` searches exhausts (see `openalex.make_client`).
    openalex = openalex_mod.make_client(timeout=TIMEOUT_S)
    try:
        _fetch_missing(
            nodes, cache, client, sleep, openalex_client=openalex,
            should_stop=should_stop,
        )
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
        # Absent from the cache is NOT the same as cached-as-None, and conflating them loses data.
        # A cached None is a definitive miss: we asked and nothing matched, so it is authoritative
        # and must be able to clear a stale count. Absent means we never got an answer this run —
        # rate limited, past the lookup budget, or the cache handed to us was empty — so a count
        # the node already carried is kept rather than replaced with None.
        #
        # Scope, so this is not mistaken for more than it is: on the normal build path
        # `graph.build_nodes_and_edges` constructs FRESH node dicts, so nothing is carried in and
        # this branch does not fire. The durable store there is the persisted cache
        # (`reference-graph.json` → `citations`, the dict this is called with), not the nodes.
        # What this does protect is any caller that re-annotates nodes already holding counts —
        # which is how a maintenance re-run erased 54 of 402 resolved counts in one pass.
        cached = cache.get(cache_key(n), _UNCACHED)
        if cached is not _UNCACHED:
            n["citation_count"] = cached
        elif not isinstance(n.get("citation_count"), int):
            n["citation_count"] = None
    resolved = sum(1 for n in nodes if n.get("citation_count") is not None)
    intentionally_stopped = should_stop is not None and should_stop()
    if nodes and not resolved and not intentionally_stopped:
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


#: A trailing parenthetical that annotates rather than names: "(Radford et al., 2019)", "(2019)".
#: Requires "et al" or a 4-digit year INSIDE the parentheses, so a parenthetical that is part of
#: the title survives — "(GPT-4)", "(Extended Abstract)" have neither and are left alone.
_TRAILING_ANNOTATION_RE = re.compile(
    r"\s*\((?=[^()]*(?:\bet\s+al\b|\b(?:19|20)\d{2}\b))[^()]*\)\s*$", re.IGNORECASE)


def lookup_title(title: str) -> str:
    """The stored title reduced to what a bibliographic index will actually match.

    Reading lists carry titles with the citation appended — "Language Models are Unsupervised
    Multitask Learners (Radford et al., 2019)". Semantic Scholar's match endpoint answers those
    with a hard 404: it is looking up a paper by title, and that is not the paper's title. Two of
    the three annotated titles sampled from a real build 404'd raw and resolved correctly once the
    annotation was removed (29,621 and 15,136 citations), so this is the difference between a
    number and nothing at all.

    Deliberately ONE narrow rule rather than general title cleaning. Every looser normalization
    tried here has been wrong in the expensive direction — matching a neighbouring paper.

    It is still not safe on its own, which is why callers try the ORIGINAL title first and only
    fall back to this: a trailing parenthetical can be part of the real title. "The Blessings of
    Multiple Causes: A Reply to Ogburn et al. (2019)" is an actual arXiv paper, and cleaning it
    yields "…A Reply to Ogburn et al." — which would both miss the real record and, worse, match
    some other paper that genuinely has the shortened title.
    """
    return _TRAILING_ANNOTATION_RE.sub("", title or "").strip()


def _specific_enough(title: str) -> bool:
    """Whether a title may be used as a paper's identity at all. See `MIN_TITLE_CHARS`."""
    normalized = _normalized_title(lookup_title(title))
    return len(normalized) >= MIN_TITLE_CHARS and len(normalized.split()) >= MIN_TITLE_WORDS


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
    if not q:
        return False
    # Word breaks are NOT ignored, though doing so would recover a hyphenation variant like
    # "pretraining" vs "pre-training" (1 of 120 lookups in a live sample). Tried and reverted:
    # concatenating collapses genuinely different words — "Resigning" == "Re-signing", and
    # "A therapist's guide" == "A the rapist's guide". That trades a missing count for the chance
    # of a WRONG one, which is the trade this whole predicate exists to refuse.
    return q == c


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
    should_stop: Callable[[], bool] | None = None,
) -> None:
    stopped = should_stop or (lambda: False)
    missing = [n for n in nodes if cache_key(n) not in cache]

    # 1) batch by external id — cheap, do every node that has one.
    with_ids = [(n, _external_id(n)) for n in missing]
    with_ids = [(n, eid) for n, eid in with_ids if eid]
    for start in range(0, len(with_ids), BATCH_CHUNK):
        if stopped():
            break
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
    # The length floor applies to the title we will actually SEND: an annotation is not evidence
    # that the title is specific enough to match on.
    titled = [n for n in missing if not _external_id(n) and cache_key(n) not in cache
              and _specific_enough(n.get("title", ""))]
    titled.sort(key=lambda n: (n.get("significant_cited_by_count", 0),
                               n.get("cited_by_project_count", 0)), reverse=True)
    budget = MAX_TITLE_LOOKUPS_WITH_KEY if _api_key() else MAX_TITLE_LOOKUPS
    stop = False
    for n in titled[:budget]:
        if stop or stopped():
            break
        # The stored title FIRST, then the annotation-stripped form. Order matters: a trailing
        # parenthetical can be part of the real title ("…A Reply to Ogburn et al. (2019)"), and
        # asking with the cleaned form first would both miss that paper and risk matching a
        # different one that really is called "…A Reply to Ogburn et al.". The fallback only runs
        # when the stored title finds nothing, so it costs a second request on misses alone.
        stored = (n.get("title") or "").strip()
        attempts = [stored]
        cleaned = lookup_title(stored)
        if cleaned != stored and len(cleaned) >= MIN_TITLE_CHARS:
            attempts.append(cleaned)

        for title in attempts:
            if stopped():
                stop = True
                break
            resp = semantic_scholar.paced_request(
                lambda title=title: client.get(
                    S2_MATCH_URL,
                    headers=_headers(),
                    # Only fields this endpoint actually supports. `matchScore` was requested here
                    # and never read, and Semantic Scholar answers an unsupported field with
                    #   400 {"error":"Unrecognized or unsupported fields: [matchScore]"}
                    # — so EVERY title lookup 400'd. That is the whole reason coverage sat at
                    # 186/402: the only route for the ~190 papers with no arXiv id or DOI returned
                    # nothing, for every node, on every build. Adding a field here without checking
                    # it against the endpoint's schema silently disables the entire step.
                    params={"query": title, "fields": "title,citationCount"},
                ),
                pacer=pacer,
            )
            if resp.status_code == 429:
                stop = True
                break
            if resp.status_code >= 500:
                # Transient and specific to this request. Skipping the NODE and carrying on is
                # right; breaking out would let one flaky response cost the other 399 lookups,
                # and there is no other route for these papers.
                log.info("title lookup for %r got HTTP %s; skipping this paper",
                         title[:60], resp.status_code)
                break
            if resp.status_code not in (200, 404):
                # A 4xx is OUR request being wrong — systemic, identical for every node, and worth
                # stopping on. Falling through silently is exactly how a 400 on every single
                # lookup went unnoticed: the step looked like it ran, and resolved nothing.
                log.warning("title lookup failed with HTTP %s: %s",
                            resp.status_code, _redacted(resp.text)[:200])
                stop = True
                break
            if resp.status_code == 404:
                continue        # this phrasing found nothing; try the next one
            rows = (resp.json() or {}).get("data") or []
            # This endpoint returns the CLOSEST title match, not a paper identity, so the count
            # is only recorded when the title we sent comes back verbatim.
            if rows and isinstance(rows[0], dict) and _same_paper_title(
                    title, rows[0].get("title") or ""):
                cache[cache_key(n)] = rows[0].get("citationCount")
                break
            cache[cache_key(n)] = None
        else:
            # Every phrasing 404'd or failed verification: a definitive miss, recorded so it is
            # not retried on every build.
            cache.setdefault(cache_key(n), None)

    # 3) OpenAlex for whatever Semantic Scholar still could not place. A different index with
    #    different coverage and no key requirement, so it reaches papers S2 simply does not hold —
    #    and the ones left here are the long tail that `significant_cited_by_count` and discovery
    #    depend on. Only a verified match is recorded (see `_openalex_citation_count`); an
    #    unverified one would be a wrong number, which nothing downstream could detect.
    if openalex_client is None:
        return          # no OpenAlex client supplied (tests inject one deliberately)
    still_missing = [
        n for n in nodes
        if cache.get(cache_key(n)) is None and _specific_enough(n.get("title", ""))
    ]
    deadline = time.monotonic() + OPENALEX_BUDGET_S
    for n in still_missing[:OPENALEX_MAX_LOOKUPS]:
        if stopped():
            log.info("openalex fallback stopped by discovery skip")
            break
        if time.monotonic() >= deadline:
            log.info("openalex fallback stopped at its time budget")
            break
        # Each request gets only what is left of the budget, recomputed per request rather than
        # shared between the two — reusing one value let a single node consume nearly twice its
        # allowance — and with no floor, so an exhausted budget stops instead of granting another
        # second.
        #
        # Honest limit: httpx's timeout is per-operation, so a server delivering one byte inside
        # every interval can still outlast this. A true total-time bound needs the streaming
        # reader `safe_fetch` implements for exactly that reason. Not used here because that guard
        # exists for URLs an attacker chooses, and this is a fixed metadata endpoint whose replies
        # are a few hundred bytes; the cost of being wrong is a slow build, not a compromise.
        def _budget() -> float:
            return min(OPENALEX_REQUEST_TIMEOUT_S, deadline - time.monotonic())

        if _budget() <= 0:
            break
        count = _openalex_by_id(n, openalex_client, timeout=_budget())
        if count is None and not stopped() and _budget() > 0:
            count = _openalex_citation_count(
                lookup_title(n["title"]), openalex_client, timeout=_budget())
        if count is _THROTTLED:
            log.info("openalex fallback stopped: rate limited")
            break
        if isinstance(count, int):
            cache[cache_key(n)] = count
        if not stopped():
            sleep(OPENALEX_MIN_INTERVAL_S)
