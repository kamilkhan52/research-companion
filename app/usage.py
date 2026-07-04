"""Per-project LLM usage + cost accounting (improvements §3.3).

Every OpenRouter call's usage — prompt/completion tokens and, when OpenRouter returns it, the
authoritative dollar cost — is recorded here from the one seam that sees every call: llm.py.
It aggregates per project into `.state/usage.json`: a lifetime running total plus breakdowns by
model and by operation (analysis, narration, graph_extraction, discovery, notes).

Design notes:
- **Cost comes straight from OpenRouter** (we request `usage.include`, and read `usage.cost`)
  rather than a local per-model pricing table, so it stays correct as prices change. If a
  provider omits cost, tokens are still recorded and cost stays 0.
- **Aggregates, not a per-call log** — enough for a spend view and monthly credit accounting,
  and it can't grow without bound. Individual-call history can be added later if needed.
- **Foundation for the credits model.** When projects become per-user, attribution is one more
  key on the aggregate (a `by_user` breakdown), not a redesign. Recording is keyed off the
  active project, so — like every other background write — a job worker must have rebound the
  project contextvar first (invariant 2); llm.py's graph path rebinds it into the extraction
  executor thread for exactly this reason.

Reads/writes are serialized on a lock and persisted with an atomic write (concurrent graph
extraction records several papers at once into the same file).
"""
from __future__ import annotations

import json
import threading
from datetime import UTC, datetime

from . import config, logging_config
from .fileio import atomic_write_text

log = logging_config.get("usage")

_lock = threading.Lock()

# The fields every aggregate bucket carries.
_FIELDS = ("calls", "prompt_tokens", "completion_tokens", "total_tokens", "cost")


def _usage_file():
    return config.state_dir() / "usage.json"


def _empty_bucket() -> dict:
    return dict.fromkeys(_FIELDS, 0)


def _blank() -> dict:
    return {"total": _empty_bucket(), "by_model": {}, "by_operation": {},
            "first_at": None, "updated_at": None}


def load() -> dict:
    """The current usage aggregate for the active project (a blank shape if none recorded yet)."""
    p = _usage_file()
    if not p.exists():
        return _blank()
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return _blank()
    # Tolerate an older/blank file by filling any missing top-level keys.
    base = _blank()
    base.update({k: data.get(k, base[k]) for k in base})
    return base


def _add(bucket: dict, prompt: int, completion: int, total: int, cost: float) -> None:
    bucket["calls"] += 1
    bucket["prompt_tokens"] += prompt
    bucket["completion_tokens"] += completion
    bucket["total_tokens"] += total
    bucket["cost"] = round(bucket["cost"] + cost, 6)


def record(operation: str, model: str | None, usage: dict | None) -> None:
    """Accumulate one call's usage into the active project's aggregate. No-ops when there is no
    active project to attribute to (so app-global calls and unit tests don't write anything).
    Never raises — accounting must not break the call it is measuring."""
    if not config.active_project_id():
        return
    usage = usage or {}
    try:
        prompt = int(usage.get("prompt_tokens") or 0)
        completion = int(usage.get("completion_tokens") or 0)
        total = int(usage.get("total_tokens") or (prompt + completion))
        cost = float(usage.get("cost") or 0.0)
        model = model or "unknown"
        operation = operation or "llm"
        now = datetime.now(UTC).isoformat(timespec="seconds")
        with _lock:
            data = load()
            _add(data["total"], prompt, completion, total, cost)
            _add(data["by_model"].setdefault(model, _empty_bucket()), prompt, completion, total, cost)
            _add(data["by_operation"].setdefault(operation, _empty_bucket()),
                 prompt, completion, total, cost)
            data["first_at"] = data["first_at"] or now
            data["updated_at"] = now
            atomic_write_text(_usage_file(), json.dumps(data, indent=2))
    except Exception as e:  # accounting is best-effort; a bad usage dict must not fail the turn
        log.warning("usage.record failed (op=%s model=%s): %s", operation, model, e)
