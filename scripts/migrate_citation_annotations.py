#!/usr/bin/env python3
"""One-time migration: move the hardcoded CITATION_GRAPH / _SLUG_SPECIALS out of app/store.py
and into a project's reading-list.md as the `<!-- slug: ... -->` / `<!-- cites: ... -->`
comments the parser already honors.

Why: those constants are content for one specific project (llm-inference-serving) living in
application code — every other project silently inherits them if slugs collide, and curating
citations required editing Python. The reading-list format already supports per-entry slug and
cites overrides (see the header note in any project's reading-list.md and store._parse_entries);
this script writes the equivalent overrides so the constants can be deleted with no behavior
change.

Run it BEFORE deleting the constants (it reads them to know what to write), against each project
that relied on them:

    scripts/migrate_citation_annotations.py llm-inference-serving

It is idempotent (skips entries that already have the relevant comment) and verifies that every
entry's effective slug and cites are byte-for-byte unchanged afterward, refusing to write if not.
It edits the working tree only — review and commit the reading-list.md change in the project's
own git repo yourself.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, store  # noqa: E402
from app.fileio import atomic_write_text  # noqa: E402


def _plain_slug(title: str) -> str:
    """The slug derive_slug would produce with no hardcoded specials — the head before the
    first colon, slugified. If this already equals the effective slug, no slug pin is needed."""
    head = title.split(":")[0]
    return re.sub(r"[^a-z0-9]+", "-", head.lower()).strip("-")


def _effective(pid: str) -> dict[str, dict]:
    """slug -> {slug, cites} as the current store (constants present) resolves each entry."""
    token = config.set_active_project(pid)
    try:
        return {e["slug"]: {"slug": e["slug"], "cites": list(e["cites"])}
                for e in store._parse_entries()}
    finally:
        config.reset_active_project(token)


def migrate(pid: str) -> None:
    if not (config.PROJECTS_ROOT / pid).is_dir():
        raise SystemExit(f"Unknown project: {pid}")

    before = _effective(pid)

    token = config.set_active_project(pid)
    try:
        rl = store._reading_list()
        lines = rl.read_text(encoding="utf-8").splitlines()
        entries = store._parse_entries()  # each has title, line_index, block, slug, cites

        # Build the comment lines to insert after each entry's title line.
        inserts: dict[int, list[str]] = {}
        for e in entries:
            block = e["block"]
            add: list[str] = []
            # Pin the slug only when a hardcoded special was doing the work — i.e. the plain
            # title derivation wouldn't reproduce the effective slug.
            if not store._SLUG_COMMENT_RE.search(block) and _plain_slug(e["title"]) != e["slug"]:
                add.append(f"<!-- slug: {e['slug']} -->")
            if e["cites"] and not store._CITES_COMMENT_RE.search(block):
                add.append(f"<!-- cites: {', '.join(e['cites'])} -->")
            if add:
                inserts[e["line_index"]] = add

        if not inserts:
            print(f"{pid}: nothing to migrate (all entries already annotated).")
            return

        out: list[str] = []
        for i, line in enumerate(lines):
            out.append(line)
            if i in inserts:
                out.extend(inserts[i])
        atomic_write_text(rl, "\n".join(out).rstrip() + "\n")
    finally:
        config.reset_active_project(token)

    after = _effective(pid)
    if after != before:
        raise SystemExit(f"ABORT: migration changed effective slugs/cites for {pid}.\n"
                         f"before={before}\nafter={after}")
    added = sum(len(v) for v in inserts.values())
    print(f"{pid}: added {added} comment line(s) across {len(inserts)} entr(y/ies); "
          f"effective slugs/cites verified unchanged.")
    print("Review and commit reading-list.md in the project's own git repo.")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: migrate_citation_annotations.py <project-id>")
    migrate(sys.argv[1])
