#!/usr/bin/env python3
"""Backfill the `Abstract:` paragraph on reading-list entries that predate it.

Abstracts are what an *unread* paper contributes to a discussion's context (store.
reading_list_overview): without one, an unread entry reaches the agent as a bare title. New
entries get an abstract at add time when the caller has one (Discover searched arXiv, so it
does); entries added before that, or added from a graph recommendation, do not.

Resolution per entry: the pinned `<!-- arxiv: ... -->` id first (exact, trusted), then a title
search on arXiv. **A title match is only trusted when it is near-identical.** A wrong abstract
is worse than no abstract — it silently poisons every discussion that mentions the paper — and
arXiv happily returns a near-miss: searching Sutton et al.'s "Policy Gradient Methods for
Reinforcement Learning with Function Approximation" (NIPS 1999, never on arXiv) returns a 2017
paper whose title *contains* it and whose abstract *cites* it, at 0.83 similarity. So anything
below ACCEPT_SCORE is never written; matches in the plausible band are printed as suggestions
for a human to confirm by pinning `<!-- arxiv: ... -->` and re-running. Entries that resolve to
nothing (an OSDI/SOSP-only paper, a title too vague) are listed for you to fill in by hand.

Already-abstracted entries are skipped, so it is idempotent and safe to re-run after adding
papers.

    scripts/backfill_abstracts.py --dry-run              # every project, change nothing
    scripts/backfill_abstracts.py 3d-integrated-dram     # write one project
    scripts/backfill_abstracts.py --accept-score 0.99    # trust only exact title matches
    scripts/backfill_abstracts.py --force                # re-fetch abstracts already present

arXiv calls are paced by retriever's throttle (~1 req / 3s), so a 30-paper project takes a
couple of minutes. It edits the working tree only — review and commit the reading-list.md
change in the project's own git repo yourself (invariant 4: no agent writes the record).
"""
from __future__ import annotations

import argparse
import re
import sys
from difflib import SequenceMatcher
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, projects, retriever, store  # noqa: E402

# Write a title match at or above ACCEPT (near-identical: at most an abbreviation expanded, a
# subtitle punctuated differently). Merely *report* one at or above SUGGEST. Between them sits
# the dangerous case — a real paper whose title strictly contains ours. See the module docstring.
ACCEPT_SCORE = 0.95
SUGGEST_SCORE = 0.80


def _similar(a: str, b: str) -> float:
    return SequenceMatcher(None, a.lower(), b.lower()).ratio()


def _candidates(title: str, accept_score: float) -> list[dict]:
    """arXiv candidates for a title, best first. The exact-phrase `ti:"<title>"` search that
    retriever uses returns nothing when the arXiv title differs by so much as an expanded
    abbreviation ("LLM" vs "Large Language Model" loses DistServe, PagedAttention, ...), so
    fall back to searching the title's head — the system name before the first colon."""
    found = {c["arxiv_id"]: c for c in retriever.search_arxiv(title)}
    if not any(c["score"] >= accept_score for c in found.values()):
        head = re.sub(r'["\\]', " ", title.split(":")[0]).strip()
        if head and head.lower() != title.lower():
            for c in retriever.search_arxiv_raw(f'ti:"{head}"', max_results=10):
                found.setdefault(c["arxiv_id"], {**c, "score": _similar(title, c["title"])})
    return sorted(found.values(), key=lambda c: c["score"], reverse=True)


def _resolve(title: str, arxiv_id: str, accept_score: float) -> tuple[str, str]:
    """(abstract, how) for one entry — ("", reason) when it can't be resolved safely."""
    if arxiv_id:
        try:
            meta = retriever.fetch_arxiv_metadata(arxiv_id)
        except retriever.RetrievalError as e:
            return "", f"arxiv id {arxiv_id}: {e}"
        if meta:
            return meta["abstract"], f"arxiv {arxiv_id}"
        # A pinned id can be wrong (graph-extracted ids often are) — fall through to the title.

    try:
        candidates = _candidates(title, accept_score)
    except retriever.RetrievalError as e:
        return "", str(e)
    if not candidates:
        return "", "no arXiv match for the title"
    best = candidates[0]
    if best["score"] < SUGGEST_SCORE:
        return "", "no arXiv match for the title"
    if best["score"] < accept_score:
        return "", (f"unconfirmed {best['score']:.2f} match — pin `<!-- arxiv: "
                    f"{best['arxiv_id']} -->` if this is it: \"{best['title'][:70]}\"")
    if not best["abstract"]:
        return "", f"arXiv entry {best['arxiv_id']} has no abstract"
    return best["abstract"], f"title match {best['score']:.2f} → {best['arxiv_id']}"


def backfill(pid: str, dry_run: bool, accept_score: float,
             force: bool = False) -> tuple[int, list[tuple[str, str]]]:
    config.set_active_project(pid)
    papers = store.list_papers()
    todo = papers if force else [p for p in papers if not store.abstract_for(p.slug)]
    what = "to refresh" if force else "without an abstract"
    print(f"\n=== {pid}: {len(papers)} papers, {len(todo)} {what} ===")

    resolved, unresolved = 0, []
    for p in todo:
        abstract, how = _resolve(p.title, store.arxiv_id_for(p.slug), accept_score)
        if not abstract:
            print(f"  ✗ {p.slug[:40]:<42} {how}")
            unresolved.append((p.slug, how))
            continue
        print(f"  ✓ {p.slug[:40]:<42} {len(abstract):>5,} chars   ({how})")
        if not dry_run:
            store.set_abstract(p.slug, abstract)
        resolved += 1
    return resolved, unresolved


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project", nargs="*", help="project ids (default: all)")
    ap.add_argument("--dry-run", action="store_true", help="report only; write nothing")
    ap.add_argument("--accept-score", type=float, default=ACCEPT_SCORE,
                    help=f"trust a title match at or above this (default {ACCEPT_SCORE})")
    ap.add_argument("--force", action="store_true",
                    help="re-fetch and rewrite abstracts that are already present")
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
        resolved, unresolved = backfill(pid, args.dry_run, args.accept_score, args.force)
        total += resolved
        stuck += [(pid, slug, why) for slug, why in unresolved]

    verb = "would write" if args.dry_run else "wrote"
    print(f"\n{verb} {total} abstract(s); {len(stuck)} need manual review.")
    for pid, slug, why in stuck:
        print(f"  {pid}/{slug}: {why}")
    if stuck:
        print("\nFor these, pin the right id with `<!-- arxiv: ... -->` and re-run, or add an "
              "`Abstract: ...` paragraph under the entry by hand. Papers that were never on "
              "arXiv (OSDI/SOSP/NeurIPS-only) will always need the latter.")
    if not args.dry_run and total:
        print("\nReview and commit reading-list.md in each project's git repo.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
