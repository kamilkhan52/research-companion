#!/usr/bin/env python3
"""Backfill publication years on reading-list entries that can't derive one (U.18).

An entry's year comes from its `<!-- year: NNNN -->` comment or its `<!-- arxiv -->` id
(store.year_from_arxiv_id). Entries that predate U.17 — or whose arXiv id was resolved by a
title search at retrieval time and recorded only in the corpus header — have neither. This
script fills the gap **offline** (no network) from data the project already holds:

  1. The corpus meta header's `- arxiv_id:` (recorded at retrieval): pinned back onto the
     entry as `<!-- arxiv -->`, which dates it for free.
  2. The stored reference graph's node for the paper (provider/extraction metadata often
     carries a year even for non-arXiv papers): recorded as `<!-- year -->`.

Anything still undated is listed — those are papers never retrieved and never graphed; pin a
`<!-- year: NNNN -->` (or an arXiv id) by hand, or run scripts/backfill_abstracts.py first
(it resolves arXiv ids via title search) and re-run this.

    scripts/backfill_years.py --dry-run          # every project, change nothing
    scripts/backfill_years.py my-project         # write one project

Existing comments are never overwritten (store.annotate_entry's rule). Like the abstract
backfill, this edits the working tree only — review and commit the reading-list.md change in
the project's own repo yourself (invariant 4: no agent writes the record).
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, graph_store, projects, store  # noqa: E402


def _graph_year(slug: str) -> int | None:
    """The stored graph node's year for a project paper, if a graph was ever built."""
    graph = (graph_store.load().get("graph") or {})
    for node in graph.get("nodes") or []:
        if node.get("kind") == "project" and node.get("slug") == slug:
            y = node.get("year")
            return y if isinstance(y, int) else None
    return None


def backfill(pid: str, dry_run: bool) -> tuple[int, list[str]]:
    config.set_active_project(pid)
    papers = store.list_papers()
    todo = [p for p in papers if p.year is None]
    print(f"\n=== {pid}: {len(papers)} papers, {len(todo)} undated ===")

    dated, stuck = 0, []
    for p in todo:
        corpus_id = store.corpus_arxiv_id_for(p.slug)
        year = store.year_from_arxiv_id(corpus_id)
        if year:
            how = f"corpus arxiv id {corpus_id} → {year}"
            if not dry_run:
                store.annotate_entry(p.slug, arxiv_id=corpus_id)
        else:
            year = _graph_year(p.slug)
            how = f"graph metadata → {year}" if year else ""
            if year and not dry_run:
                store.annotate_entry(p.slug, year=year)
        if year:
            print(f"  ✓ {p.slug[:40]:<42} {how}")
            dated += 1
        else:
            print(f"  ✗ {p.slug[:40]:<42} no offline source")
            stuck.append(p.slug)
    return dated, stuck


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project", nargs="*", help="project ids (default: all)")
    ap.add_argument("--dry-run", action="store_true", help="report only; write nothing")
    args = ap.parse_args()

    known = [p["id"] for p in projects.list_projects()]
    pids = args.project or known
    unknown = [p for p in pids if p not in known]
    if unknown:
        print(f"Unknown project(s): {', '.join(unknown)}. Known: {', '.join(known)}",
              file=sys.stderr)
        return 2

    total, stuck = 0, []
    for pid in pids:
        dated, remaining = backfill(pid, args.dry_run)
        total += dated
        stuck += [f"{pid}/{slug}" for slug in remaining]

    print(f"\nDated {total} entr{'y' if total == 1 else 'ies'}"
          f"{' (dry run — nothing written)' if args.dry_run else ''}.")
    if stuck:
        print("Still undated (pin <!-- year: NNNN --> or an arXiv id by hand):")
        for item in stuck:
            print(f"  - {item}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
