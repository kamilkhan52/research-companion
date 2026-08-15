"""The corpus-neighbourhood substrate (DR-052, PR 1 of the Map/Discover merge).

Map and Discover answer the same underlying question — what surrounds this corpus? — in
three steps that differ only at the edges: resolve each project paper's identity, fetch its
neighbourhood (references and citers) from providers, then rank for the view's own purpose.
The first two steps are the SUBSTRATE: goal-agnostic, provider-bound, cached in the graph
store, and shared. The rankings deliberately do NOT merge (structural significance and
what-to-read-next are different judgments — see docs/map-discover-merge-design.md).

This module owns the substrate operations. PR 1 keeps it behavior-identical: the provider
metadata phase moved here verbatim from graph.build_graph (which still drives it), and
Discovery's anchor resolution routes through here so its writes are dirty-tracked (see
graph_store's module docstring for the write-race this closes). The standalone neighbourhood
job — one registry keyed on bare pid, breadth escalation queued rather than silently joined —
arrives in PR 2, when Discovery starts consuming the substrate instead of refetching it.

Substrate physics, which the split below encodes (Corpus Neighbourhood spec §1):
- The BACKWARD half (what our papers cite) is frozen — a published bibliography never
  changes. It needs refreshing only when the project's composition changes (papers added),
  plus second-order provider-coverage drift.
- The FORWARD half (what cites our papers) only accumulates, forever. `record_forward_sweep`
  persists each anchor's known-citer id set so a later sweep can be a cheap graph DELTA —
  fetch newest, diff against known — instead of a re-query, which is what makes weekly
  monitoring (DR-051) affordable and exact.
"""
from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from datetime import UTC, datetime

import httpx

from . import discovery_recall, graph_store, logging_config, semantic_scholar
from .models import Paper

log = logging_config.get("neighbourhood")


def _now() -> str:
    # Second precision, matching graph._now() — the timestamps written here land in the same
    # stored records that module wrote before this phase moved (a direct import would cycle).
    return datetime.now(UTC).isoformat(timespec="seconds")


def provider_metadata_events(
    papers: list[Paper],
    data: dict,
    *,
    force: bool,
    fetch: Callable[[Paper], dict],
    source_key: Callable[[Paper], str],
) -> Iterator[dict]:
    """Refresh the per-paper provider metadata cache, yielding the graph build's own progress
    events. Moved verbatim from graph.build_graph (DR-052 PR 1); `fetch` and `source_key` are
    injected by the caller both for tests and to keep this module free of a graph.py import.

    Provider metadata is a separate, resumable cache: only a changed source identity (or
    force, or a previous error) refetches a paper, and every record is persisted as it lands
    so an interrupted build resumes instead of re-fetching.
    """
    for paper in papers:
        key = source_key(paper)
        cached_provider = graph_store.get_provider_paper(data, "semantic_scholar", paper.slug)
        needs_provider = (
            force
            or not cached_provider
            or cached_provider.get("source_key") != key
            or cached_provider.get("status") == "error"
        )
        if needs_provider:
            yield {"type": "metadata", "slug": paper.slug, "title": paper.title}
            try:
                provider_record = fetch(paper)
                if not isinstance(provider_record, dict):
                    raise TypeError("metadata provider returned a non-object result")
                if provider_record.get("status") not in {"done", "not_found"}:
                    raise ValueError("metadata provider returned an invalid status")
                if (
                    provider_record.get("status") == "done"
                    and not isinstance(provider_record.get("references"), list)
                ):
                    raise TypeError("metadata provider references were not a list")
                provider_record = {
                    **provider_record,
                    "source_key": key,
                    "fetched_at": provider_record.get("fetched_at") or _now(),
                    "error": str(provider_record.get("error") or "")[:400],
                }
            except Exception as exc:
                provider_record = {
                    "status": "error", "source_key": key, "fetched_at": _now(),
                    "paper": None, "references": [], "error": str(exc)[:400],
                }
            graph_store.set_provider_paper(
                data, "semantic_scholar", paper.slug, provider_record
            )
            graph_store.save(data)
        else:
            provider_record = cached_provider
        yield {
            "type": "metadata_progress", "slug": paper.slug,
            "status": provider_record.get("status"), "cached": not needs_provider,
            "error": provider_record.get("error") or None,
        }


def ensure_anchors(papers: list, data: dict, *, client) -> list[dict]:
    """Resolve the project's papers to OpenAlex anchors (identity + topics), reading and
    feeding the substrate's anchor cache. Marks the cache dirty only when something actually
    changed, so a caller can make `graph_store.save` conditional on
    `graph_store.pending_changes` — anchor ids are free but slow; pay for them once ever."""
    cache = data.setdefault("openalex_anchors", {})

    def _fingerprint() -> dict[str, str]:
        return {
            slug: json.dumps(entry, sort_keys=True, ensure_ascii=False)
            for slug, entry in cache.items()
        }

    before = _fingerprint()
    try:
        anchors = discovery_recall.resolve_anchors(papers, client=client, cache=cache)
        discovery_recall.hydrate_anchor_topics(anchors, client=client, cache=cache)
    finally:
        # PER SLUG, and in a finally: marking the whole section would make a save overwrite
        # every anchor another concurrent writer resolved (two discovery runs can overlap on
        # one project — the discovery dedup key is per user scope, not bare pid — and PR 2's
        # neighbourhood job becomes a second writer by design). The finally keeps the old
        # behaviour of persisting whatever resolved before an interruption.
        after = _fingerprint()
        for slug, entry in after.items():
            if before.get(slug) != entry:
                graph_store.mark_dirty(data, "openalex_anchors", slug)
    return anchors


def _work_key(openalex_id: str) -> str:
    return str(openalex_id or "").rsplit("/", 1)[-1]


def record_forward_sweep(data: dict, candidates: list[dict]) -> None:
    """Fold a citation chase's results into the substrate's per-anchor known-citer sets.

    Each candidate from discovery_recall.chase_citations carries provenance naming which
    anchor it was found citing; the id sets accumulate across runs (a citer once seen is
    never forgotten) and `complete: False` records that these sets were seeded from
    top-cited first pages, not an exhaustive newest-first walk — PR 2's delta sweep is what
    upgrades them. Entries are written (and marked dirty) only when a new citer appears, so
    a no-news run costs no save."""
    by_anchor: dict[str, set[str]] = {}
    for candidate in candidates:
        work = _work_key(candidate.get("openalex_id"))
        if not work:
            continue
        for prov in candidate.get("provenance") or []:
            if prov.get("channel") == "cites" and prov.get("anchor_slug"):
                by_anchor.setdefault(str(prov["anchor_slug"]), set()).add(work)
    for slug, found in by_anchor.items():
        previous = graph_store.get_forward(data, slug) or {}
        known = set(previous.get("citers") or [])
        if found <= known:
            continue
        graph_store.set_forward_sweep(data, slug, {
            # Preserve the S2 side of the record: the two lanes write the same per-slug entry
            # and each owns its own namespace (see `citers` vs `s2_citers` in graph_store).
            **previous,
            "citers": sorted(known | found),
            "swept_at": _now(),
            "complete": False,
            "source": "openalex",
        })


# The delta lane's per-anchor page size. One page per anchor per run, newest-first: the stored
# citer set is the memory, so a sweep only has to reach back far enough to cover what appeared
# since the last one. 100 is generous for a week of citations on a single paper and still one
# request.
FORWARD_PAGE = 100
MAX_DELTA_ANCHORS = 25


def stalest_first(anchors: list[dict], data: dict, limit: int = MAX_DELTA_ANCHORS
                  ) -> tuple[list[dict], int]:
    """The anchors to sweep this run, least-recently-swept first, and how many are left over.

    The lane costs one paced provider call per anchor, so a run cannot sweep an unbounded
    library. Taking `anchors[:limit]` in list order would mean papers 26+ of a 34-paper project
    are NEVER monitored; ordering by how long ago each was last swept turns the same budget into
    a rotation, with no cursor to persist — the substrate's own timestamps are the cursor.
    """
    def last_attempt(anchor: dict) -> str:
        record = graph_store.get_forward(data, anchor.get("slug") or "") or {}
        # The last ATTEMPT, not the last success. An anchor the provider keeps failing on never
        # gets an `s2_swept_at`, so ordering by that alone would park it at the head of the queue
        # on every future run — and 25 such anchors would silently consume the whole per-run
        # budget forever, sweeping nothing at all. Reading an attempt timestamp too rotates a
        # persistently failing paper to the back instead of letting it starve the rest.
        return max(str(record.get("s2_swept_at") or ""),
                   str(record.get("s2_attempted_at") or ""))   # "" (never tried) sorts first

    ordered = sorted(anchors, key=last_attempt)
    return ordered[:limit], max(0, len(anchors) - limit)


def forward_delta(
    anchors: list[dict],
    papers: list,
    data: dict,
    *,
    fetch: Callable[[str], list[dict]] | None = None,
    should_cancel: Callable[[], bool] | None = None,
) -> tuple[list[dict], dict, dict]:
    """Papers that have STARTED citing the reader's papers — the monitoring lane (spec §5).

    A true graph delta, not a re-run of a similarity query: for each anchor we ask the provider
    for its newest citers and subtract the ids we already stored, so what comes back is exactly
    "new since we last looked", with the citation contexts that say HOW each one cites us.
    Litmaps and its neighbours cannot do this — their monitoring re-scores a saved query — and
    it is what makes a weekly check one cheap call per corpus paper.

    Returns `(candidates, audit, pending)`. **`pending` is deliberately not written here.** The
    stored id set is what stops a citer being reported twice, so writing it at fetch time would
    mean a run that is stopped or restarted before its results are durable has already marked
    those papers known — and they would never be reported again. Suppression is the one
    unrecoverable direction (a double report merges harmlessly into the ledger reservoir), so
    the caller commits `pending` where it commits the ledger, and the lane keeps at-least-once
    semantics.

    Never raises: a provider outage costs this lane, not the run, and each anchor's failure is
    isolated so one bad id cannot cost the others.
    """
    audit = {"anchors": 0, "new": 0, "known": 0, "skipped": 0, "unmonitored": 0, "degraded": []}
    # slug -> ids seen this run, or None for "attempted and failed" (see commit_forward_delta)
    pending: dict[str, set[str] | None] = {}
    if not fetch and not semantic_scholar.api_key():
        # Unauthenticated Semantic Scholar shares a global ~1 req/s pool and 429s under ordinary
        # load, and this lane is one call PER corpus paper. Without a key it would spend the
        # run's time budget collecting rate-limit errors, so it declines to start.
        log.info("new-citation lane skipped: no Semantic Scholar API key")
        return [], audit, pending

    cancelled = should_cancel or (lambda: False)
    by_slug = {getattr(p, "slug", ""): p for p in papers}
    candidates: list[dict] = []

    # Resolve identifiers BEFORE applying the per-run budget. An anchor with no resolvable id can
    # never be swept, so letting it into the budget would spend a slot on nothing — and since it
    # never earns a timestamp either, it would take that slot again on every subsequent run.
    sweepable = []
    for anchor in anchors:
        paper = by_slug.get(anchor.get("slug") or "")
        identifier = semantic_scholar.paper_identifier(
            arxiv_id=getattr(paper, "arxiv_id", "") or "") if paper else None
        if identifier:
            sweepable.append((anchor, identifier))
    chosen, audit["unmonitored"] = stalest_first(
        [a for a, _ in sweepable], data, limit=MAX_DELTA_ANCHORS)
    by_anchor_id = {id(anchor): identifier for anchor, identifier in sweepable}
    sweep = [(anchor, by_anchor_id[id(anchor)]) for anchor in chosen]

    # One client for the whole lane: these are serial calls to a single host through an
    # account-wide pacer, so a fresh connection per anchor would add a TLS handshake to each.
    client = None if fetch else httpx.Client(
        base_url=semantic_scholar.BASE_URL, timeout=semantic_scholar.TIMEOUT_S)
    try:
        for anchor, identifier in sweep:
            # Checked per anchor, not just per run: the lane is up to 25 serial paced requests,
            # so without this a reader's Stop would sit unanswered for a minute or more.
            if cancelled():
                break
            slug = anchor.get("slug") or ""
            try:
                edges = (fetch(identifier) if fetch else
                         semantic_scholar.citing_papers(
                             identifier, limit=FORWARD_PAGE, client=client))
            except Exception as e:  # noqa: BLE001 — one anchor's outage is not the lane's
                log.info("forward delta failed for %s (%s)", slug, type(e).__name__)
                audit["skipped"] += 1
                pending[slug] = None      # attempted, no result: rotates to the back
                continue
            audit["anchors"] += 1

            record = graph_store.get_forward(data, slug) or {}
            # The S2 namespace only. `citers` holds OpenAlex work keys from the breadth chase;
            # a 40-hex S2 paperId can never equal a `W…` key, so mixing them in one list would
            # make each lane's memory invisible to the other while pretending to be shared.
            known = set(record.get("s2_citers") or [])
            seen_ids = {e["paper_id"] for e in edges}
            fresh = [e for e in edges if e["paper_id"] not in known]
            audit["new"] += len(fresh)
            audit["known"] += len(seen_ids - {e["paper_id"] for e in fresh})

            for edge in fresh:
                candidates.append(_candidate_from_edge(edge, anchor))
            pending[slug] = seen_ids
    finally:
        if client is not None:
            client.close()
    if audit["unmonitored"]:
        # Deliberately NOT in `degraded`: a library larger than one run's budget is the normal
        # case, not a fault, and a healthy run must not report itself as degraded every time.
        log.info("new-citation lane checked %d anchors; %d rotate to a later run",
                 audit["anchors"], audit["unmonitored"])
    if audit["skipped"]:
        audit["degraded"].append(
            f"Could not check {audit['skipped']} paper(s) for new citations "
            f"(the provider was unavailable); they are retried on the next run")
    return candidates, audit, pending


def commit_forward_delta(data: dict, pending: dict[str, set[str] | None]) -> None:
    """Mark this run's swept citers known, once its results are durable (see `forward_delta`).

    `s2_swept_at` advances even when a sweep found nothing new — "we looked and there was
    nothing" is exactly what a freshness display has to distinguish from "we never looked",
    and it is also what makes the rotation in `stalest_first` move.

    A `None` entry is an anchor the provider failed on. It records the ATTEMPT and nothing else:
    no citers are marked known (that would suppress papers we never saw), but the timestamp
    stops a permanently failing paper from holding the front of the rotation forever."""
    for slug, seen_ids in pending.items():
        previous = graph_store.get_forward(data, slug) or {}
        if seen_ids is None:
            graph_store.set_forward_sweep(data, slug, {
                **previous, "s2_attempted_at": _now(),
            })
            continue
        known = set(previous.get("s2_citers") or [])
        graph_store.set_forward_sweep(data, slug, {
            **previous,                       # keeps the OpenAlex side of the record intact
            # Union, never replacement: a citer once seen stays known even when it falls off
            # the newest page, so it can never be re-reported as new.
            "s2_citers": sorted(known | seen_ids),
            "s2_swept_at": _now(),
            "s2_attempted_at": _now(),
        })


def _candidate_from_edge(edge: dict, anchor: dict) -> dict:
    """Shape one inbound edge like every other recall candidate, plus the lane-1 evidence."""
    return {
        "title": edge["title"],
        "abstract": edge.get("abstract") or "",
        "doi": edge.get("doi") or "",
        "arxiv_id": edge.get("arxiv_id") or "",
        "paper_id": edge.get("paper_id") or "",   # the substrate's own key for this citer
        "year": edge.get("year"),
        "venue": edge.get("venue") or "",         # real credibility evidence for the screen
        "publication_date": edge.get("publication_date") or "",
        "citation_count": edge.get("citation_count"),
        "url": edge.get("url") or "",
        "authors": edge.get("authors") or [],
        "publication_types": edge.get("publication_types") or [],
        "sources": ["semantic_scholar"],
        "channels": ["new_citation"],
        "provenance": [{
            "channel": "new_citation",
            "anchor_slug": anchor.get("slug"),
            "anchor_title": anchor.get("title"),
            # The evidence, carried with the candidate so a suggestion can say HOW it cites you
            # instead of only that it does. PR 3 classifies these; nothing reads them yet.
            "contexts": edge.get("contexts") or [],
            "is_influential": bool(edge.get("is_influential")),
            "reference_count": edge.get("reference_count"),
        }],
    }
