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

R3 (topic sweep) and R4 (Semantic Scholar bulk search) are deliberately not here; they belong with
the incremental frontier in the next slice.

Every candidate carries `channels` and `provenance`, because "cited by *Attention Is All You Need*,
which is paper 3 on your list" is both the reason the result is good and the thing the deterministic
gate uses to know it must not apply a generic popularity floor to it.
"""
from __future__ import annotations

import re
from collections.abc import Callable

import httpx

from . import logging_config, semantic_scholar, store
from .openalex import BASE as OPENALEX_BASE

log = logging_config.get("discovery.recall")

#: How many of the reader's papers to chase citations from. The most-connected papers dominate the
#: useful results, and each anchor costs a request, so this is a cost/recall dial rather than a
#: correctness one.
MAX_ANCHORS = 25

#: OpenAlex returns at most 200 rows per page; one page per anchor is plenty for slice 1.
CITES_PER_PAGE = 200
MAX_CITES_PAGES = 1

#: OpenAlex accepts a DOI list in one filter call. 50 keeps the URL comfortably short.
DOI_BATCH = 50

TIMEOUT_S = 30.0


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

    for paper in papers:
        slug = getattr(paper, "slug", "") or ""
        arxiv_id = getattr(paper, "arxiv_id", "") or ""
        if not slug:
            continue
        cached = cache.get(slug)
        if cached:
            anchors.append({"slug": slug, "openalex_id": cached,
                            "title": getattr(paper, "title", "") or ""})
            continue
        if not arxiv_id or budget <= 0:
            continue
        budget -= 1
        work = _get_work(client, f"doi:{_arxiv_doi(arxiv_id)}")
        if work:
            cache[slug] = work["id"]
            anchors.append({"slug": slug, "openalex_id": work["id"],
                            "title": getattr(paper, "title", "") or "",
                            "topics": work.get("topics") or []})
        else:
            unresolved.append((slug, arxiv_id))

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
                cache[slug] = row["id"]
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
    out: list[dict] = []
    for anchor in anchors[:MAX_ANCHORS]:
        key = _work_key(anchor.get("openalex_id"))
        if not key:
            continue
        filters = [f"cites:{key}"]
        if from_year:
            filters.append(f"publication_year:{from_year}-")
        try:
            resp = client.get(
                f"{OPENALEX_BASE}/works",
                params={"filter": ",".join(filters), "sort": "cited_by_count:desc",
                        "per-page": CITES_PER_PAGE,
                        "select": "id,doi,title,publication_year,cited_by_count,type,"
                                  "primary_location,authorships"},
                timeout=TIMEOUT_S)
        except httpx.HTTPError:
            log.info("citation chase unreachable for %s; skipping", key)
            continue
        if resp.status_code != 200:
            continue
        try:
            rows = (resp.json() or {}).get("results") or []
        except ValueError:
            continue
        for row in rows:
            candidate = _from_openalex(row)
            if not candidate:
                continue
            candidate["channels"] = ["cites"]
            candidate["provenance"] = [{
                "channel": "cites", "anchor_slug": anchor.get("slug"),
                "anchor_title": anchor.get("title"),
            }]
            out.append(candidate)
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
    return {
        "title": title,
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
