#!/usr/bin/env python3
"""Backfill publication years on reading-list entries that can't derive one (U.18).

An entry's year comes from its `<!-- year: NNNN -->` comment or its `<!-- arxiv -->` id
(store.year_from_arxiv_id). Entries that predate U.17 — or whose arXiv id was resolved by a
title search at retrieval time and recorded only in the corpus header — have neither. This
script fills the gap **offline** (no network) from data the project already holds:

  1. The corpus meta header's `- arxiv_id:` (recorded at retrieval) — VALIDATED against the
     live arXiv title first (>= 0.95 similarity, the backfill_abstracts bar), because legacy
     headers may hold an id accepted at retrieve()'s weak 0.62 floor and don't retain the
     score. A validated id is pinned back as `<!-- arxiv -->`, which dates the entry for
     free. This is the script's one networked step (paced ~3s/lookup).
  2. The graph cache's bibliography references that match the paper (other papers cite it
     with a year, e.g. "Attention Is All You Need, 2017"): the majority year is recorded as
     `<!-- year -->`. Fully offline.

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

from collections import Counter
from difflib import SequenceMatcher

from app import config, graph_store, projects, retriever, store  # noqa: E402
from app.graph import match_project_paper  # noqa: E402
from app.models import Paper  # noqa: E402

TITLE_ACCEPT = 0.95


def _validated_corpus_id(p: Paper) -> str | None:
    """The corpus header's arXiv id, but only when the live arXiv title near-identically
    matches the entry title. Legacy headers may record a weak (0.62-floor) title-search
    match without its score — a wrong id must not be promoted to the entry."""
    aid = store.corpus_arxiv_id_for(p.slug)
    if not aid:
        return None
    try:
        meta = retriever.fetch_arxiv_metadata(aid)
    except retriever.RetrievalError:
        return None
    if not meta:
        return None
    score = SequenceMatcher(None, meta["title"].lower(), p.title.lower()).ratio()
    return aid if score >= TITLE_ACCEPT else None


def _reference_year(paper: Paper) -> int | None:
    """The majority year among cached bibliography references (any paper's extraction) that
    match this project paper — non-circular: reference metadata is extracted from citing
    papers' bibliographies, not derived from the reading list."""
    years: list[int] = []
    for ext in (graph_store.load().get("papers") or {}).values():
        if not isinstance(ext, dict) or ext.get("status") != "done":
            continue
        for ref in ext.get("references") or []:
            if isinstance(ref, dict) and match_project_paper(ref, [paper]) == paper.slug:
                y = ref.get("year")
                if isinstance(y, int) and 1900 <= y <= 2100:
                    years.append(y)
    return Counter(years).most_common(1)[0][0] if years else None


def backfill(pid: str, dry_run: bool) -> tuple[int, list[str]]:
    config.set_active_project(pid)
    papers = store.list_papers()
    todo = [p for p in papers if p.year is None]
    print(f"\n=== {pid}: {len(papers)} papers, {len(todo)} undated ===")

    dated, stuck = 0, []
    for p in todo:
        corpus_id = _validated_corpus_id(p)
        year = store.year_from_arxiv_id(corpus_id or "")
        if year:
            how = f"corpus arxiv id {corpus_id} (title-validated) → {year}"
            if not dry_run:
                store.annotate_entry(p.slug, arxiv_id=corpus_id)
        else:
            year = _reference_year(p)
            how = f"cited with year {year} in graph bibliographies" if year else ""
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
