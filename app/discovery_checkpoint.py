"""Restart-safe stage snapshots for the multi-minute Discovery funnel.

The job registry is intentionally in-process, so a deploy loses the worker. Discovery's wide
recall can nevertheless avoid buying the same provider pages and screening batches again: each
completed stage writes the inputs needed by the next one to this derived per-project file. A new
job with the same goals and library fingerprint resumes from the latest complete stage.

The checkpoint is not the result and never reaches git. It expires quickly, is replaced when the
reader changes the goals/library, and is cleared only after both the final result and discovery
ledger are durable. That ordering is what makes frontier advancement safe: a frontier is never
committed while the candidates it found exist only in a dead process.
"""
from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from . import config
from .fileio import atomic_write_text

VERSION = 1
MAX_AGE = timedelta(hours=24)
STAGES = ("recall", "gated", "triaged", "scored")
_REQUIRED_TYPES = {
    "recall": {
        "focus": str, "queries": list, "candidates": list, "ledger": dict,
        "recall_audit": dict,
    },
    "gated": {"survivors": list, "gate_counts": dict},
    "triaged": {"triaged": list, "triage_audit": dict},
    "scored": {"scored": list, "abstract_audit": dict},
}


def checkpoint_path() -> Path:
    return config.state_dir() / "discovery-checkpoint.json"


def fingerprint(goals: str, papers: list, *, pipeline: str) -> str:
    """Stable identity of work that may safely resume.

    Include every reading-list identity, not merely the count: replacing one paper with another
    must invalidate grounded recall even when the project length is unchanged. ``pipeline`` is a
    caller-owned schema/model version so a deploy that changes stage semantics cannot consume an
    old snapshot accidentally.
    """
    rows = []
    for paper in papers:
        rows.append({
            "slug": getattr(paper, "slug", "") or "",
            "title": getattr(paper, "title", "") or "",
            "arxiv_id": getattr(paper, "arxiv_id", "") or "",
            "doi": getattr(paper, "doi", "") or "",
        })
    payload = json.dumps({"goals": (goals or "").strip(), "papers": rows,
                          "pipeline": pipeline}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def load(expected_key: str, *, now: datetime | None = None) -> dict | None:
    """Return a trusted, fresh snapshot for ``expected_key``; malformed state is a cache miss."""
    try:
        raw = json.loads(checkpoint_path().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None
    if not isinstance(raw, dict) or raw.get("version") != VERSION:
        return None
    if raw.get("key") != expected_key or raw.get("stage") not in STAGES:
        return None
    state = raw.get("state")
    stage = str(raw["stage"])
    if not isinstance(state, dict) or any(
        not all(isinstance(state.get(field), expected) for field, expected in fields.items())
        for name, fields in _REQUIRED_TYPES.items()
        if STAGES.index(name) <= STAGES.index(stage)
    ):
        return None
    if "frontier_updates" in state and not isinstance(state["frontier_updates"], list):
        return None
    try:
        updated = datetime.fromisoformat(str(raw.get("updated_at") or ""))
        if updated.tzinfo is None:
            updated = updated.replace(tzinfo=UTC)
    except ValueError:
        return None
    if (now or datetime.now(UTC)) - updated > MAX_AGE:
        return None
    return raw


def save(key: str, stage: str, state: dict, *, now: datetime | None = None) -> None:
    if stage not in STAGES:
        raise ValueError(f"Unknown discovery checkpoint stage: {stage}")
    stamp = (now or datetime.now(UTC)).isoformat(timespec="seconds")
    atomic_write_text(checkpoint_path(), json.dumps({
        "version": VERSION,
        "key": key,
        "stage": stage,
        "updated_at": stamp,
        "state": state,
    }, ensure_ascii=False, separators=(",", ":")))


def clear() -> None:
    try:
        checkpoint_path().unlink()
    except FileNotFoundError:
        pass
