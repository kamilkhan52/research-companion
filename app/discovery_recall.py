"""Recall: build a wide candidate pool out of what the reader has already chosen to read.

The pipeline this replaces generated keyword queries and kept the first ~50 hits, so the quality
of one LLM's query writing decided everything and a paper that no query happened to name could
not be found at all. These channels invert that: they start from the project's own library and
reference graph, where the evidence is specific to this reader rather than to a search string.

Slice 1 ships three channels. All are cheap by construction — OpenAlex prices a single work by id
at zero and a filter page at $0.0001, so the whole of R1+R2 for a typical project costs under a
cent, and R5 costs nothing because the numbers are already computed and sitting in the graph store.

  R1  anchor resolution     reading list -> OpenAlex work ids          free
  R2  forward-citation      who cites those works                      $0.0001 / 200 rows
  R5  graph recommendations already ranked in the reference graph      free, in-process

Slice 2 adds the two independent wide-recall lanes and returns frontier updates for the caller to
commit only after the candidate reservoir and final result are durable:

  R3  OpenAlex topic sweep  top project topics over a rolling decade
  R4  S2 bulk search        broad goal queries, up to 1,000 rows per page

Every candidate carries `channels` and `provenance`, because "cited by *Attention Is All You Need*,
which is paper 3 on your list" is both the reason the result is good and the thing the deterministic
gate uses to know it must not apply a generic popularity floor to it.
"""
from __future__ import annotations

import hashlib
import os
import re
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta

import httpx

from . import jobs, logging_config, openalex, semantic_scholar, store
from .openalex import BASE as OPENALEX_BASE

log = logging_config.get("discovery.recall")

#: How many of the reader's papers to chase citations from. The most-connected papers dominate the
#: useful results, and each anchor costs a request, so this is a cost/recall dial rather than a
#: correctness one.
MAX_ANCHORS = 25

#: OpenAlex returns at most 200 rows per page; one page per anchor is plenty for slice 1.
CITES_PER_PAGE = 200
MAX_CITES_PAGES = 1

TOP_TOPIC_COUNT = 6
TOPIC_PER_PAGE = 200
MAX_TOPIC_PAGES = 30
TOPIC_HORIZON_YEARS = 10
BULK_QUERY_COUNT = 4
BULK_ROWS_PER_QUERY = 2_000

#: OpenAlex accepts a DOI list in one filter call. 50 keeps the URL comfortably short.
DOI_BATCH = 50

TIMEOUT_S = 30.0


def concurrency() -> int:
    """How many OpenAlex requests run at once. Bounded 1-12; 1 restores serial behaviour."""
    try:
        n = int(os.environ.get("RC_DISCOVERY_RECALL_CONCURRENCY", "8"))
    except ValueError:
        n = 8
    return max(1, min(12, n))


# ---------- R1: anchor resolution ----------

def _arxiv_doi(arxiv_id: str) -> str:
    return f"10.48550/arXiv.{store.arxiv_base_id(arxiv_id)}"


def resolve_anchors(papers: list, *, client: httpx.Client, cache: dict,
                    s2_lookup: Callable[[str], str | None] | None = None) -> list[dict]:
    """Map reading-list papers to OpenAlex work ids. Free, and cached so it is paid once ever.

    Two hops, because arXiv ids do not reliably resolve. **OpenAlex canonicalises a published
    paper to its published version and drops the arXiv DOI entirely** — "Attention Is All You
    Need" is `W2626778328` with DOI `10.65215/2q58a426` and has no arXiv DOI at all. So no variant
    of the arXiv DOI will ever find it, and the fallback has to hop through an external id:

      1. `GET /works/doi:10.48550/arXiv.<id>`  — works for preprints OpenAlex has not merged
      2. on 404: Semantic Scholar `paper/ARXIV:<id>?fields=externalIds` -> published DOI,
         then one batched `GET /works?filter=doi:a|b|c` for everything that resolved

    A paper that resolves by neither route is skipped, not retried — it simply contributes no
    anchor, and the other channels still cover it.
    """
    anchors: list[dict] = []
    unresolved: list[tuple[str, str]] = []       # (slug, arxiv_id) needing the S2 hop

    # Resolution is free per call but NOT free in time: an unresolved paper costs an OpenAlex
    # lookup and possibly a Semantic Scholar hop through the shared ~1 req/s pacer. A 400-paper
    # library would therefore spend several minutes resolving anchors that `chase_citations` was
    # only ever going to use MAX_ANCHORS of. Cached anchors stay free, so they are never budgeted.
    budget = MAX_ANCHORS

    to_look_up: list = []
    for paper in papers:
        slug = getattr(paper, "slug", "") or ""
        arxiv_id = getattr(paper, "arxiv_id", "") or ""
        if not slug:
            continue
        cached = cache.get(slug)
        if cached:
            # Slice 1 stored just the work-id string. Accept it forever, while new cache rows also
            # retain topics so R3 does not have to re-fetch a free-but-slow anchor every run.
            work_id = cached.get("openalex_id") if isinstance(cached, dict) else cached
            topics = cached.get("topics") if isinstance(cached, dict) else []
            anchors.append({"slug": slug, "openalex_id": work_id,
                            "title": getattr(paper, "title", "") or "",
                            "topics": topics or []})
            continue
        if not arxiv_id or budget <= 0:
            continue
        budget -= 1
        to_look_up.append(paper)

    # The first hop is one independent free OpenAlex request per paper, so it fans out. The S2
    # fallback below does NOT: it goes through an account-wide pacer, and parallelising it would
    # trade latency for 429s.
    works = jobs.run_parallel(
        to_look_up,
        lambda p: _get_work(client, f"doi:{_arxiv_doi(getattr(p, 'arxiv_id', ''))}"),
        max_workers=concurrency(), thread_name_prefix="discover-anchor")

    for paper, work in zip(to_look_up, works, strict=True):
        slug = getattr(paper, "slug", "")
        if isinstance(work, dict) and work.get("id"):
            cache[slug] = {"openalex_id": work["id"], "topics": work.get("topics") or []}
            anchors.append({"slug": slug, "openalex_id": work["id"],
                            "title": getattr(paper, "title", "") or "",
                            "topics": work.get("topics") or []})
        else:
            unresolved.append((slug, getattr(paper, "arxiv_id", "") or ""))

    if unresolved:
        anchors.extend(_resolve_via_s2(unresolved, papers, client=client, cache=cache,
                                       s2_lookup=s2_lookup))
    return anchors


def _get_work(client: httpx.Client, lookup: str) -> dict | None:
    """One free single-work lookup. Any non-200 is a miss, not an error — this is best-effort."""
    try:
        resp = client.get(f"{OPENALEX_BASE}/works/{lookup}",
                          params={"select": "id,topics,cited_by_count"}, timeout=TIMEOUT_S)
    except httpx.HTTPError:
        return None
    if resp.status_code != 200:
        return None
    try:
        data = resp.json()
    except ValueError:
        return None
    return data if isinstance(data, dict) and data.get("id") else None


def hydrate_anchor_topics(anchors: list[dict], *, client: httpx.Client, cache: dict) -> None:
    """One-time upgrade for slice-1 cache rows that retained only an OpenAlex work id.

    Existing production projects have already paid the latency to resolve their anchors, but
    those rows predate R3 and contain no topic fingerprint. Single-work lookups are free; fetch
    only the bounded anchors missing topics, update them in place, and persist through the caller's
    existing graph-store save. Once upgraded, later runs make zero requests here.
    """
    missing = [anchor for anchor in anchors[:MAX_ANCHORS]
               if anchor.get("openalex_id") and not anchor.get("topics")]
    if not missing:
        return
    works = jobs.run_parallel(
        missing, lambda anchor: _get_work(client, _work_key(anchor["openalex_id"])),
        max_workers=concurrency(), thread_name_prefix="discover-anchor-topics")
    for anchor, work in zip(missing, works, strict=True):
        if not isinstance(work, dict):
            continue
        topics = work.get("topics") or []
        if not topics:
            continue
        anchor["topics"] = topics
        slug = str(anchor.get("slug") or "")
        if slug:
            cache[slug] = {"openalex_id": work["id"], "topics": topics}


def _default_s2_doi(arxiv_id: str) -> str | None:
    """The published DOI Semantic Scholar knows for an arXiv id, through the shared pacer."""
    def request():
        return httpx.get(
            f"{semantic_scholar.BASE_URL}/paper/ARXIV:{store.arxiv_base_id(arxiv_id)}",
            params={"fields": "externalIds"},
            headers=semantic_scholar._headers(semantic_scholar.api_key(), required=False),
            timeout=TIMEOUT_S)
    try:
        resp = semantic_scholar.paced_request(request)
    except Exception:  # noqa: BLE001 — a miss here just means no anchor for this paper
        return None
    if resp.status_code != 200:
        return None
    try:
        doi = ((resp.json() or {}).get("externalIds") or {}).get("DOI")
    except ValueError:
        return None
    return str(doi).strip().lower() if doi else None


def _resolve_via_s2(unresolved: list[tuple[str, str]], papers: list, *,
                    client: httpx.Client, cache: dict,
                    s2_lookup: Callable[[str], str | None] | None) -> list[dict]:
    lookup = s2_lookup or _default_s2_doi
    titles = {getattr(p, "slug", ""): (getattr(p, "title", "") or "") for p in papers}

    by_doi: dict[str, str] = {}
    for slug, arxiv_id in unresolved:
        doi = lookup(arxiv_id)
        if doi:
            by_doi[doi] = slug
    if not by_doi:
        return []

    found: list[dict] = []
    dois = list(by_doi)
    for start in range(0, len(dois), DOI_BATCH):
        chunk = dois[start:start + DOI_BATCH]
        try:
            resp = client.get(f"{OPENALEX_BASE}/works",
                              params={"filter": f"doi:{'|'.join(chunk)}",
                                      "select": "id,doi,topics", "per-page": DOI_BATCH},
                              timeout=TIMEOUT_S)
        except httpx.HTTPError:
            continue
        if resp.status_code != 200:
            continue
        try:
            rows = (resp.json() or {}).get("results") or []
        except ValueError:
            continue
        for row in rows:
            doi = re.sub(r"^https?://(?:dx\.)?doi\.org/", "",
                         str(row.get("doi") or ""), flags=re.IGNORECASE).lower()
            slug = by_doi.get(doi)
            if slug and row.get("id"):
                cache[slug] = {"openalex_id": row["id"], "topics": row.get("topics") or []}
                found.append({"slug": slug, "openalex_id": row["id"],
                              "title": titles.get(slug, ""), "topics": row.get("topics") or []})
    return found


# ---------- R2: forward-citation chase ----------

def _work_key(openalex_id: str) -> str:
    return str(openalex_id or "").rsplit("/", 1)[-1]


def chase_citations(anchors: list[dict], *, client: httpx.Client,
                    from_year: int | None = None) -> list[dict]:
    """Papers that cite the reader's own papers — the highest-precision channel in the pipeline.

    Run PER ANCHOR rather than OR-ing the ids together, which costs one request each but is what
    lets a candidate say which of your papers it descends from. That provenance is the difference
    between "here are some papers about your topic" and "this builds on the paper you read on
    Tuesday", and the gate relies on it to waive the citation floor.
    """
    usable = [a for a in anchors[:MAX_ANCHORS] if _work_key(a.get("openalex_id"))]

    def one(anchor: dict) -> list[dict]:
        key = _work_key(anchor["openalex_id"])
        filters = [f"cites:{key}"]
        if from_year:
            filters.append(f"publication_year:{from_year}-")
        try:
            resp = client.get(
                f"{OPENALEX_BASE}/works",
                params={"filter": ",".join(filters), "sort": "cited_by_count:desc",
                        "per-page": CITES_PER_PAGE,
                        "select": "id,doi,title,abstract_inverted_index,publication_year,"
                                  "cited_by_count,type,primary_location,authorships"},
                timeout=TIMEOUT_S)
        except httpx.HTTPError:
            log.info("citation chase unreachable for %s; skipping", key)
            return []
        if resp.status_code != 200:
            return []
        try:
            rows = (resp.json() or {}).get("results") or []
        except ValueError:
            return []
        found = []
        for row in rows:
            candidate = _from_openalex(row)
            if not candidate:
                continue
            candidate["channels"] = ["cites"]
            candidate["provenance"] = [{
                "channel": "cites", "anchor_slug": anchor.get("slug"),
                "anchor_title": anchor.get("title"),
            }]
            found.append(candidate)
        return found

    # One independent request per anchor, so they run concurrently. OpenAlex has no per-second
    # limit we are near (a page costs $0.0001 against a $1/day allowance) and `httpx.Client` is
    # thread-safe. Semantic Scholar is deliberately NOT parallelised anywhere in this module — it
    # is paced account-wide, and fanning out would simply trade latency for 429s.
    batches = jobs.run_parallel(usable, one, max_workers=concurrency(),
                                thread_name_prefix="discover-cites")
    out: list[dict] = []
    for batch in batches:
        if isinstance(batch, Exception):
            log.info("citation chase failed for one anchor (%s)", type(batch).__name__)
            continue
        out.extend(batch)
    return out


def _from_openalex(row: dict) -> dict | None:
    title = str(row.get("title") or "").strip()
    if not title:
        return None
    doi = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", str(row.get("doi") or ""),
                 flags=re.IGNORECASE).lower()
    landing = ((row.get("primary_location") or {}).get("landing_page_url")) or ""
    arxiv_id = ""
    match = re.search(r"arxiv\.org/abs/([0-9]{4}\.[0-9]{4,5})", landing)
    if match:
        arxiv_id = match.group(1)
    authors = [((a.get("author") or {}).get("display_name") or "")
               for a in (row.get("authorships") or [])]
    inverted = row.get("abstract_inverted_index") or {}
    abstract = ""
    if isinstance(inverted, dict):
        positioned = [
            (position, str(word))
            for word, positions in inverted.items()
            if isinstance(positions, list)
            for position in positions
            if isinstance(position, int)
        ]
        positioned.sort()
        abstract = " ".join(word for _, word in positioned)
    return {
        "title": title,
        "abstract": abstract,
        "doi": doi,
        "arxiv_id": arxiv_id,
        "year": row.get("publication_year"),
        "citation_count": row.get("cited_by_count"),
        "url": landing or (f"https://doi.org/{doi}" if doi else ""),
        "authors": [a for a in authors if a][:12],
        "publication_types": [row.get("type")] if row.get("type") else [],
        "openalex_id": row.get("id"),
        "sources": ["openalex"],
    }


# ---------- R3/R4: wide recall + pending frontier updates ----------

def topic_fingerprint(anchors: list[dict], limit: int = TOP_TOPIC_COUNT) -> list[dict]:
    """The project's strongest OpenAlex topics, weighted across resolved library anchors."""
    scores: dict[str, dict] = {}
    for anchor in anchors:
        for topic in (anchor.get("topics") or [])[:3]:
            if not isinstance(topic, dict):
                continue
            raw_id = str(topic.get("id") or "")
            topic_id = raw_id.rsplit("/", 1)[-1]
            if not re.fullmatch(r"T\d+", topic_id):
                continue
            try:
                weight = float(topic.get("score") or 1.0)
            except (TypeError, ValueError):
                weight = 1.0
            row = scores.setdefault(topic_id, {
                "id": topic_id, "name": str(topic.get("display_name") or ""), "score": 0.0,
            })
            row["score"] += max(0.0, weight)
    return sorted(scores.values(), key=lambda row: (-row["score"], row["id"]))[:limit]


def _frontier_start(frontier: dict, key: str, today: date) -> date | None:
    row = frontier.get(key)
    swept = row.get("swept_to") if isinstance(row, dict) else None
    if isinstance(swept, str):
        try:
            start = date.fromisoformat(swept) + timedelta(days=1)
            return None if start > today else start
        except ValueError:
            pass
    return date(today.year - TOPIC_HORIZON_YEARS + 1, 1, 1)


def sweep_topics(anchors: list[dict], *, client: httpx.Client, frontier: dict,
                 today: date | None = None, should_cancel: Callable[[], bool] | None = None
                 ) -> tuple[list[dict], dict, list[dict]]:
    """R3: sweep the project's topic space, returning updates that are not yet durable.

    The caller commits ``updates`` only with the completed result/ledger. Advancing the frontier
    here would be a data-loss bug: a crash after this function would skip pages whose candidates
    existed only in the dead process.
    """
    today = today or datetime.now(UTC).date()
    topics = topic_fingerprint(anchors)
    candidates: list[dict] = []
    updates: list[dict] = []
    audit = {"topics": len(topics), "pages": 0, "rows": 0, "degraded": []}
    cancelled = should_cancel or (lambda: False)
    if not topics or cancelled():
        if cancelled():
            audit["cancelled"] = True
        return candidates, audit, updates

    ids = [topic["id"] for topic in topics]
    names = {topic["id"]: topic["name"] for topic in topics}
    key = "topics.id:" + "|".join(ids)
    start = _frontier_start(frontier, key, today)
    if start is None:
        return candidates, audit, updates
    cursor: str | None = "*"
    seen_cursors: set[str] = set()
    pages = 0
    complete = False
    while cursor and pages < MAX_TOPIC_PAGES:
        if cancelled():
            audit["cancelled"] = True
            break
        if cursor in seen_cursors:
            audit["degraded"].append(
                "topic sweep received a repeated cursor; frontier not advanced")
            break
        seen_cursors.add(cursor)
        try:
            response = client.get(
                f"{OPENALEX_BASE}/works",
                params={
                    "filter": (f"topics.id:{'|'.join(ids)},"
                               f"from_publication_date:{start.isoformat()},"
                               f"to_publication_date:{today.isoformat()}"),
                    "cursor": cursor,
                    "per-page": TOPIC_PER_PAGE,
                    "sort": "cited_by_count:desc",
                    "select": "id,doi,title,abstract_inverted_index,publication_year,"
                              "cited_by_count,type,primary_location,authorships,topics",
                }, timeout=TIMEOUT_S)
            if response.status_code != 200:
                raise httpx.HTTPStatusError(
                    f"OpenAlex returned {response.status_code}", request=response.request,
                    response=response)
            payload = response.json()
            rows = payload.get("results") or []
            if not isinstance(rows, list):
                raise ValueError("results is not a list")
        except (httpx.HTTPError, ValueError, TypeError) as exc:
            audit["degraded"].append(
                f"topic sweep stopped after {pages} pages ({type(exc).__name__})")
            break
        pages += 1
        audit["pages"] += 1
        for row in rows:
            if not isinstance(row, dict) or not (candidate := _from_openalex(row)):
                continue
            matched = [str(topic.get("id") or "").rsplit("/", 1)[-1]
                       for topic in (row.get("topics") or []) if isinstance(topic, dict)]
            matched = [topic_id for topic_id in matched if topic_id in names] or ids[:1]
            candidate["channels"] = ["topic"]
            candidate["provenance"] = [{
                "channel": "topic", "topic_id": topic_id, "topic": names.get(topic_id, ""),
            } for topic_id in matched[:3]]
            candidates.append(candidate)
        next_cursor = ((payload.get("meta") or {}).get("next_cursor")
                       if isinstance(payload.get("meta"), dict) else None)
        cursor = str(next_cursor) if next_cursor else None
        if not cursor or not rows:
            complete = True
            break
    if complete:
        updates.append({"key": key, "swept_to": today.isoformat(),
                        "from_date": start.isoformat(), "pages": pages,
                        "topics": ids})
    elif cursor and pages >= MAX_TOPIC_PAGES:
        audit["degraded"].append(
            f"topic sweep reached the {MAX_TOPIC_PAGES}-page safety cap; frontier not advanced")
    audit["rows"] = len(candidates)
    return candidates, audit, updates


def bulk_goal_search(queries: list[dict], *, frontier: dict,
                     search_fn=None, today: date | None = None,
                     should_cancel: Callable[[], bool] | None = None
                     ) -> tuple[list[dict], dict, list[dict]]:
    """R4: broad Semantic Scholar bulk-search lanes, independent of the project graph."""
    today = today or datetime.now(UTC).date()
    search = search_fn or semantic_scholar.bulk_search_papers
    terms = []
    for query in queries:
        value = str(query.get("bulk_query") or query.get("search_terms")
                    or query.get("query") or "").strip()
        if value and value not in terms:
            terms.append(value)
        if len(terms) >= BULK_QUERY_COUNT:
            break
    candidates: list[dict] = []
    updates: list[dict] = []
    audit = {"queries": len(terms), "pages": 0, "rows": 0, "degraded": []}
    cancelled = should_cancel or (lambda: False)
    for query in terms:
        if cancelled():
            audit["cancelled"] = True
            break
        key = "bulk:" + hashlib.sha1(query.encode("utf-8")).hexdigest()[:12]
        start = _frontier_start(frontier, key, today)
        if start is None:
            continue
        try:
            result = search(query, BULK_ROWS_PER_QUERY, from_date=start.isoformat(),
                            should_cancel=cancelled)
            rows, page_audit = result if isinstance(result, tuple) else (result, {"complete": True})
        except Exception as exc:  # noqa: BLE001 — one recall lane is best-effort
            audit["degraded"].append(f"bulk query failed ({type(exc).__name__})")
            continue
        audit["pages"] += int(page_audit.get("pages") or 0)
        for raw in rows:
            if not isinstance(raw, dict) or not raw.get("title"):
                continue
            candidate = dict(raw)
            candidate["channels"] = ["bulk"]
            candidate["sources"] = list(dict.fromkeys(
                [*candidate.get("sources", []), "semantic_scholar"]))
            candidate["provenance"] = [{"channel": "bulk", "query": query}]
            candidates.append(candidate)
        if page_audit.get("complete"):
            updates.append({"key": key, "swept_to": today.isoformat(),
                            "from_date": start.isoformat(), "query": query,
                            "pages": int(page_audit.get("pages") or 0)})
        else:
            audit["degraded"].append(
                f"bulk query reached the {BULK_ROWS_PER_QUERY}-row cap; frontier not advanced")
    audit["rows"] = len(candidates)
    return candidates, audit, updates


def wide_recall(anchors: list[dict], queries: list[dict], *, frontier: dict,
                client: httpx.Client | None = None, bulk_search_fn=None,
                today: date | None = None, should_cancel: Callable[[], bool] | None = None
                ) -> tuple[list[dict], dict, list[dict]]:
    """R3+R4 together; failures stay lane-local and every frontier update remains pending."""
    own = client is None
    client = client or openalex.make_client(timeout=TIMEOUT_S)
    try:
        # Parallelise ACROSS providers only. OpenAlex owns its own concurrent page/anchor budget;
        # Semantic Scholar remains serialized through its account-wide pacer. Running the two
        # independent lanes together cuts wall-clock without turning S2 pagination into a 429 fan-
        # out or letting one lane's outage discard the other.
        results = jobs.run_parallel(
            ["topic", "bulk"],
            lambda lane: (
                sweep_topics(anchors, client=client, frontier=frontier, today=today,
                             should_cancel=should_cancel)
                if lane == "topic"
                else bulk_goal_search(
                    queries, frontier=frontier, search_fn=bulk_search_fn, today=today,
                    should_cancel=should_cancel)
            ),
            max_workers=2,
            thread_name_prefix="discover-wide",
        )
        topic_result, bulk_result = results
        if isinstance(topic_result, Exception):
            topic_result = ([], {"topics": 0, "pages": 0, "rows": 0,
                                 "degraded": [f"topic sweep failed ({type(topic_result).__name__})"]}, [])
        if isinstance(bulk_result, Exception):
            bulk_result = ([], {"queries": 0, "pages": 0, "rows": 0,
                                "degraded": [f"bulk recall failed ({type(bulk_result).__name__})"]}, [])
        topic_rows, topic_audit, topic_updates = topic_result
        bulk_rows, bulk_audit, bulk_updates = bulk_result
        return [*topic_rows, *bulk_rows], {
            "topic": topic_audit, "bulk": bulk_audit,
            "degraded": [*topic_audit["degraded"], *bulk_audit["degraded"]],
        }, [*topic_updates, *bulk_updates]
    finally:
        if own:
            client.close()


# ---------- R5: the reference graph's own recommendations ----------

def graph_recommendations(graph_data: dict, limit: int = 200) -> list[dict]:
    """External papers the project's reference graph already ranked, with its reasons.

    `graph.score_recommendations` weighs significant citations, how many of the project's papers
    cite a work, bridge structure and betweenness — evidence no search API can produce, computed
    on every graph build and, until now, never read by Discovery. This is the cheapest quality in
    the whole design: the numbers already exist on disk.
    """
    recs = (graph_data or {}).get("recommendations")
    if not isinstance(recs, list):
        return []
    out: list[dict] = []
    for rec in recs[:limit]:
        if not isinstance(rec, dict):
            continue
        title = str(rec.get("title") or "").strip()
        if not title:
            continue
        out.append({
            "title": title,
            "doi": str(rec.get("doi") or "").strip().lower(),
            "arxiv_id": str(rec.get("arxiv_id") or "").strip(),
            "year": rec.get("year"),
            "citation_count": rec.get("citation_count"),
            "authors": list(rec.get("authors") or [])[:12],
            "url": rec.get("url") or "",
            "sources": ["graph"],
            "channels": ["graph"],
            "provenance": [{"channel": "graph",
                            "reasons": list(rec.get("reasons") or [])[:4],
                            "score": rec.get("score")}],
        })
    return out


# ---------- merge ----------

def _identity_with_openalex(candidate: dict, identity_keys) -> list[str]:
    """The pipeline's identity keys plus OpenAlex's own id.

    Forward-citation results often carry no arXiv id and sometimes no DOI, so without this they
    would fall back to matching on title alone — the weakest and most collision-prone alias.
    """
    keys = list(identity_keys(candidate))
    work = str(candidate.get("openalex_id") or "").rsplit("/", 1)[-1]
    if work:
        keys.insert(0, f"openalex:{work.lower()}")
    return list(dict.fromkeys(keys))


def _strong_ids_conflict(a: dict, b: dict) -> bool:
    """Whether two rows carry the SAME kind of strong identifier with different values."""
    for field in ("doi", "arxiv_id", "openalex_id"):
        left = str(a.get(field) or "").strip().lower().rsplit("/", 1)[-1]
        right = str(b.get(field) or "").strip().lower().rsplit("/", 1)[-1]
        if left and right and left != right:
            return True
    return False


def merge_candidates(groups: list[list[dict]], *, identity_keys, merge_fn) -> list[dict]:
    """Coalesce candidates from several channels, unioning channels and provenance.

    Reuses the pipeline's existing identity and merge helpers rather than inventing another
    notion of sameness — they already handle providers disagreeing about which identifier a paper
    has, which is the failure this would otherwise reintroduce.
    """
    merged: dict[str, dict] = {}
    order: list[str] = []
    for group in groups:
        for candidate in group:
            keys = _identity_with_openalex(candidate, identity_keys)
            hit = next((merged[k] for k in keys if k in merged), None)
            # A title alias is enough to FIND a possible match but not to trust one: distinct
            # papers share exact titles, and merging them would blend two works into a hybrid
            # whose screening verdict, citations and provenance describe neither. When both rows
            # carry a strong identifier and they disagree, treat them as different papers.
            if hit is not None and _strong_ids_conflict(hit, candidate):
                hit = None
            if hit is None:
                stored = dict(candidate)
                merged_keys = keys or [f"title:{candidate.get('title', '')}"]
                for key in merged_keys:
                    merged[key] = stored
                order.append(merged_keys[0])
                continue
            merge_fn(hit, candidate)
            hit["channels"] = list(dict.fromkeys(
                [*hit.get("channels", []), *candidate.get("channels", [])]))
            hit["provenance"] = [*hit.get("provenance", []), *candidate.get("provenance", [])][:8]
            hit["sources"] = list(dict.fromkeys(
                [*hit.get("sources", []), *candidate.get("sources", [])]))
            for key in keys:                     # newly-learned identifiers point at the same row
                merged.setdefault(key, hit)
    return [merged[key] for key in order]
