"""Notes committer + versioning (Sections 4, 8). The single component that writes approved
changes into the store, as one reviewable change set: flip status to *read*, append the
Notes block to corpus/<slug>.md, rewrite synthesis.md, and git-commit. Nothing reaches the
record without the human's approval (the 'agent proposes, human commits' principle).
"""
from __future__ import annotations

import subprocess

from . import sessions, store


class CommitError(Exception):
    pass


def _git(*args: str) -> str:
    proc = subprocess.run(
        ["git", *args], cwd=str(store.config.project_dir()),
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise CommitError(f"git {' '.join(args)} failed: {proc.stderr.strip()}")
    return proc.stdout.strip()


def review(slug: str) -> dict:
    """Assemble the review payload for the approval screen: the proposed Notes block and the
    proposed synthesis, alongside the current synthesis for comparison."""
    proposed = sessions.latest_proposed_commit(slug) or {}
    return {
        "slug": slug,
        "title": store.title_for(slug),
        "summary": proposed.get("summary", ""),
        "notes_block": proposed.get("notes_block", ""),
        "synthesis_current": store.read_synthesis(),
        "synthesis_proposed": proposed.get("synthesis", ""),
    }


def commit(slug: str, notes_block: str, synthesis: str, summary: str = "") -> dict:
    """Apply and version the approved change set. notes_block / synthesis may be the agent's
    proposal or the human's edited version."""
    title = store.title_for(slug)
    notes_block, synthesis = (notes_block or ""), (synthesis or "")
    if not notes_block.strip() and not synthesis.strip():
        raise CommitError("Nothing to commit (no notes and no working-notes update).")

    # A paper commit has a Notes block (append + flip to read); the working-notes review
    # commit has only the rewritten working notes.
    if notes_block.strip():
        store.append_notes_block(slug, title, notes_block)
        store.set_status_read(slug)
    if synthesis.strip():
        store.write_synthesis(synthesis)

    _git("add", "-A")
    if summary.strip():
        msg = summary.strip()
    elif notes_block.strip():
        msg = f"Read {title}: notes + working-notes update"
    else:
        msg = "Update working notes"
    try:
        _git("commit", "-q", "-m", msg)
    except CommitError as e:
        if "nothing to commit" not in str(e):
            raise
    sessions.mark_committed(slug)
    return {"committed": True, "rev": _git("rev-parse", "--short", "HEAD"), "message": msg}
