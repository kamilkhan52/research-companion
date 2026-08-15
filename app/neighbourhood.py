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

from . import discovery_recall, graph_store
from .models import Paper


def _now() -> str:
    return datetime.now(UTC).isoformat()


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
    before = json.dumps(cache, sort_keys=True, ensure_ascii=False)
    anchors = discovery_recall.resolve_anchors(papers, client=client, cache=cache)
    discovery_recall.hydrate_anchor_topics(anchors, client=client, cache=cache)
    if json.dumps(cache, sort_keys=True, ensure_ascii=False) != before:
        graph_store.mark_dirty(data, "openalex_anchors")
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
            "citers": sorted(known | found),
            "swept_at": _now(),
            "complete": False,
            "source": "openalex",
        })
