#!/usr/bin/env python3
"""One-time backfill: turn plain mentions of a project's papers in the existing notes into
tappable `rc-paper:<slug>` links, so the app-wide "paper awareness" feature is visible in notes
written before the prompts learned to emit those links.

Only the human-authored record is touched — each paper's trailing `## Notes` block and the
project's `working-notes.md` synthesis — never the extracted paper full text above the Notes
marker, and never a discussion transcript. Matching is deterministic and conservative: a paper's
full title, its name before the first colon (the "system name" — Orca, DistServe, Sarathi-Serve),
and its slug (hyphen and spaced forms), matched whole-word and case-insensitively, skipping
anything already inside a link, code span, or fenced block. The first mention of each paper per
document is linked (repeats are left alone), and a paper is never linked to itself. A curated
alias map can add names that aren't in the title/slug (e.g. "vLLM" -> vllm-pagedattention).

Deterministic and idempotent, but review before committing — it edits the working tree only and
leaves the git commit to you (invariant 4: no agent writes the record).

    scripts/relink_notes.py --dry-run                 # every project, show diffs, write nothing
    scripts/relink_notes.py llm-inference-serving     # dry-run for one project
    scripts/relink_notes.py llm-inference-serving --apply   # write the working tree
"""
from __future__ import annotations

import argparse
import re
import sys
from difflib import unified_diff
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, projects, store  # noqa: E402

# A paper "system name" or slug shorter than this is too generic to match safely.
MIN_ALIAS_LEN = 4

# A line-leading code fence: ``` or ~~~ (length >= 3), variable length.
_FENCE_LINE = re.compile(r"[ \t]*(`{3,}|~{3,})")

# Inline constructs to leave untouched inside a prose (non-fenced) region:
#   `code` / ``code with ` inside`` (N backticks … N backticks),
#   an inline/reference/shortcut/image link — the WHOLE construct incl. destination, so we never
#   linkify link text or a URL, nor split `[Orca][ref]` into invalid nesting, and an html tag.
_INLINE_PROTECT = re.compile(
    r"(`+)(?:.|\n)*?\1"
    r"|!?\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])?"
    r"|<[^>]+>",
    re.DOTALL,
)


def _iter_fenced(text: str):
    """Yield (chunk, is_code): line-leading ``` / ~~~ fenced blocks are code (an unclosed fence
    runs to EOF); everything else is prose. Closing fence must match the opening char and be at
    least as long."""
    lines = text.splitlines(keepends=True)
    buf: list[str] = []
    i, n = 0, len(lines)
    while i < n:
        m = _FENCE_LINE.match(lines[i])
        if not m:
            buf.append(lines[i])
            i += 1
            continue
        if buf:
            yield "".join(buf), False
            buf = []
        fchar, flen = m.group(1)[0], len(m.group(1))
        code = [lines[i]]
        i += 1
        while i < n:
            code.append(lines[i])
            close = _FENCE_LINE.match(lines[i])
            i += 1
            if close and close.group(1)[0] == fchar and len(close.group(1)) >= flen:
                break
        yield "".join(code), True
    if buf:
        yield "".join(buf), False


def build_alias_map(papers, curated: dict[str, str] | None = None) -> dict[str, str]:
    """Lowercased alias -> slug. Aliases: full title, title head before the first colon, the slug,
    and the slug with hyphens spaced. `curated` overrides/extends (its entries win)."""
    alias_map: dict[str, str] = {}

    def add(alias: str, slug: str) -> None:
        a = alias.strip()
        if len(a) >= MIN_ALIAS_LEN:
            alias_map.setdefault(a.lower(), slug)

    for p in papers:
        add(p.title, p.slug)
        head = p.title.split(":", 1)[0].strip()
        if head.lower() != p.title.strip().lower():
            add(head, p.slug)
        add(p.slug, p.slug)
        add(p.slug.replace("-", " "), p.slug)
    for alias, slug in (curated or {}).items():
        alias_map[alias.strip().lower()] = slug  # curated always wins
    return alias_map


def linkify(text: str, alias_map: dict[str, str], exclude_slug: str | None = None,
            loose_aliases: frozenset[str] = frozenset()) -> str:
    """Link the first mention of each paper in `text` as [name](rc-paper:slug). `exclude_slug`
    (the document's own paper) is never linked. A single-word alias (no space/hyphen) only matches
    when the occurrence is capitalized — paper names are proper nouns, so this rejects common-word
    collisions like the verb "park" vs the paper "Park". `loose_aliases` (lowercased) opt out of
    that rule, for curated names that are legitimately lowercase (e.g. "vLLM")."""
    usable = {a: s for a, s in alias_map.items() if s != exclude_slug}
    if not usable:
        return text
    # Longest alias first so a full title wins over its shorter system-name prefix at one spot.
    # Boundaries reject a match inside a word Unicode-aware: `[^\W_]` is a letter/digit (underscore
    # excluded so markdown emphasis `_Orca_` still links), so "αOrcaβ" and "Orca2" don't match.
    body = "|".join(re.escape(a) for a in sorted(usable, key=len, reverse=True))
    pattern = re.compile(rf"(?<![^\W_])({body})(?![^\W_])", re.IGNORECASE)
    # Seed with slugs already linked in the text, so a paper linked once elsewhere isn't linked
    # again and re-running the migration is a no-op (idempotent).
    linked: set[str] = set(re.findall(r"rc-paper:([a-z0-9-]+)", text))

    def link_segment(seg: str) -> str:
        def repl(m: re.Match) -> str:
            matched = m.group(1)
            key = matched.lower()
            slug = usable.get(key)
            if not slug or slug in linked:
                return m.group(0)
            single_word = " " not in matched and "-" not in matched
            if single_word and key not in loose_aliases and not matched[:1].isupper():
                return m.group(0)  # e.g. the verb "park", not the paper "Park"
            linked.add(slug)
            return f"[{matched}](rc-paper:{slug})"

        return pattern.sub(repl, seg)

    def link_prose(prose: str) -> str:
        out, pos = [], 0
        for prot in _INLINE_PROTECT.finditer(prose):
            out.append(link_segment(prose[pos:prot.start()]))
            out.append(prot.group(0))  # inline code / link / tag — unchanged
            pos = prot.end()
        out.append(link_segment(prose[pos:]))
        return "".join(out)

    return "".join(chunk if is_code else link_prose(chunk)
                   for chunk, is_code in _iter_fenced(text))


def _relink_file(path: Path, new_text: str, original: str, dry_run: bool) -> bool:
    """Report/apply a change; returns True when the file differs."""
    if new_text == original:
        return False
    rel = path.name
    print(f"\n--- {path.parent.name}/{rel} ---")
    diff = unified_diff(original.splitlines(), new_text.splitlines(),
                        fromfile=rel, tofile=rel, lineterm="", n=1)
    shown = [ln for ln in diff if ln.startswith(("+", "-")) and not ln.startswith(("+++", "---"))]
    for ln in shown[:40]:
        print(ln)
    if len(shown) > 40:
        print(f"  … {len(shown) - 40} more changed lines")
    if not dry_run:
        path.write_text(new_text, encoding="utf-8")
    return True


def relink_project(pid: str, dry_run: bool, curated: dict[str, str] | None) -> int:
    config.set_active_project(pid)
    papers = store.list_papers()
    alias_map = build_alias_map(papers, curated)
    loose = frozenset(a.strip().lower() for a in (curated or {}))
    print(f"\n=== {pid}: {len(papers)} papers ===")
    changed = 0

    # Each paper's trailing "## Notes" block (leave the extracted full text above it untouched).
    for p in papers:
        path = store.corpus_path(p.slug)
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        marker = "\n## Notes"
        if marker not in text:
            continue
        head, notes = text.split(marker, 1)
        new_notes = linkify(marker + notes, alias_map, exclude_slug=p.slug, loose_aliases=loose)
        if _relink_file(path, head + new_notes, text, dry_run):
            changed += 1

    # The project's cross-paper synthesis.
    synth = config.project_dir() / "working-notes.md"
    if synth.exists():
        text = synth.read_text(encoding="utf-8")
        if _relink_file(synth, linkify(text, alias_map, loose_aliases=loose), text, dry_run):
            changed += 1

    return changed


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project", nargs="*", help="project ids (default: all)")
    ap.add_argument("--dry-run", action="store_true", help="show diffs, write nothing (default)")
    ap.add_argument("--apply", action="store_true", help="write the working tree")
    args = ap.parse_args()
    dry_run = not args.apply

    known = [p["id"] for p in projects.list_projects()]
    pids = args.project or known
    unknown = [p for p in pids if p not in known]
    if unknown:
        print(f"Unknown project(s): {', '.join(unknown)}. Known: {', '.join(known)}", file=sys.stderr)
        return 2

    total = sum(relink_project(pid, dry_run, curated=None) for pid in pids)
    verb = "would change" if dry_run else "changed"
    print(f"\n{verb} {total} file(s).")
    if not dry_run and total:
        print("Review and commit the notes changes in each project's git repo (invariant 4).")
    elif dry_run and total:
        print("Re-run with --apply to write these changes.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
