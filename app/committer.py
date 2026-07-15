"""Notes committer + versioning (Sections 4, 8). The single component that writes approved
changes into the store, as one reviewable change set: flip status to *read*, append the
Notes block to corpus/<slug>.md, rewrite synthesis.md, and git-commit. Nothing reaches the
record without the human's approval (the 'agent proposes, human commits' principle).
"""
from __future__ import annotations

import subprocess
import threading

from . import config, logging_config, sessions, store

log = logging_config.get("committer")


class CommitError(Exception):
    pass


def _git(*args: str) -> str:
    # config.git_identity_args() pins the author so a commit never fails for a missing global
    # git identity (fresh server/container) — see config.git_author_name().
    proc = subprocess.run(
        ["git", *config.git_identity_args(), *args], cwd=str(config.project_dir()),
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
        # Echo back with an explicit-payload approval; a branch switch or regeneration in the
        # meantime changes it and the stale approval is refused.
        "proposal_revision": sessions.proposal_revision(slug),
    }


# Approvals in flight, keyed by (project, slug). Branch switching/forking must not rewrite
# the transcript while the previously read proposal is being staged and committed — that could
# commit branch A's notes over branch B's transcript. In-process is sufficient: single worker
# (CLAUDE.md invariant 6).
_approving: set[tuple[str | None, str]] = set()
_approving_lock = threading.Lock()


def approval_in_flight(slug: str) -> bool:
    with _approving_lock:
        return (config.active_project_id(), slug) in _approving


def commit(slug: str, notes_block: str, synthesis: str, summary: str = "") -> dict:
    """Apply and version the approved change set. notes_block / synthesis may be the agent's
    proposal or the human's edited version."""
    key = (config.active_project_id(), slug)
    with _approving_lock:
        _approving.add(key)
    try:
        return _commit(slug, notes_block, synthesis, summary)
    finally:
        with _approving_lock:
            _approving.discard(key)


def _commit(slug: str, notes_block: str, synthesis: str, summary: str = "") -> dict:
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

    sessions.finalize_proposal_for_commit(slug)
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
    rev = _git("rev-parse", "--short", "HEAD")
    log.info("commit slug=%s rev=%s: %s", slug, rev, msg)
    return {"committed": True, "rev": rev, "message": msg}
