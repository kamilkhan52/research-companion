"""Per-project LLM usage + cost accounting (improvements §3.3).

Every OpenRouter call's usage — prompt/completion tokens and, when OpenRouter returns it, the
authoritative dollar cost — is recorded here from the one seam that sees every call: llm.py.
It aggregates per project into `.state/usage.json`: a lifetime running total plus breakdowns by
model and by operation (analysis, narration, graph_extraction, discovery, notes).

Design notes:
- **Cost comes straight from OpenRouter** (we request `usage.include`, and read `usage.cost`)
  rather than a local per-model pricing table, so it stays correct as prices change. If a
  provider omits cost, tokens are still recorded and cost stays 0.
- **Cost is stored as an integer count of nano-USD** (1e-9 dollars), not a float. This is a
  credits-ledger foundation: summing integers is exact, so a million sub-micro-dollar calls add
  up correctly, whereas rounding each float addition to a few decimals silently discards them.
  The USD figure (`cost` / `cost_usd`) is derived only for presentation.
- **Aggregates, not a per-call log** — enough for a spend view and monthly credit accounting,
  and it can't grow without bound. Individual-call history can be added later if needed.
- **Totals are estimates while `incomplete_streams > 0`.** A streaming turn that drops after its
  first token (client/tunnel disconnect) is billed upstream but never delivers its final usage
  chunk, so its cost is unknown here. We count those separately rather than silently understating;
  reconciling them by OpenRouter generation id is a future step (see llm.stream).
- **Foundation for the credits model.** When projects become per-user, attribution is one more
  key on the aggregate (a `by_user` breakdown), not a redesign. Recording is keyed off the
  active project, so — like every other background write — a job worker must have rebound the
  project contextvar first (invariant 2); llm.py's graph path rebinds it into the extraction
  executor thread, and audio_jobs binds the initiating project around its narration call, for
  exactly this reason.

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

_NANO_USD = 1_000_000_000  # cost is stored as integer nano-USD so accumulation is exact

# Every aggregate bucket carries these integer counters (cost as nano-USD; see module docstring).
_FIELDS = ("calls", "prompt_tokens", "completion_tokens", "total_tokens", "cost_nanousd")


def _usage_file():
    return config.state_dir() / "usage.json"


def _empty_bucket() -> dict:
    return dict.fromkeys(_FIELDS, 0)


def _blank() -> dict:
    return {"total": _empty_bucket(), "by_model": {}, "by_operation": {},
            "incomplete_streams": 0, "first_at": None, "updated_at": None}


def load() -> dict:
    """The raw stored aggregate for the active project (integer nano-USD cost), or a blank shape.
    Internal/round-trip form — use `summary()` for presentation."""
    p = _usage_file()
    if not p.exists():
        return _blank()
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return _blank()
    base = _blank()  # tolerate an older/partial file by filling any missing top-level keys
    base.update({k: data.get(k, base[k]) for k in base})
    return base


def _present_bucket(bucket: dict) -> dict:
    """A copy of a stored bucket with cost surfaced in USD (derived; the exact integer nano-USD
    is kept alongside for a ledger)."""
    nano = bucket.get("cost_nanousd", 0)
    return {**bucket, "cost_usd": nano / _NANO_USD}


def summary() -> dict:
    """Presentation form of the aggregate: every bucket gains a derived `cost_usd`, and a
    top-level `estimated` flag flips true while some billed streams are unreconciled."""
    data = load()
    data["total"] = _present_bucket(data["total"])
    data["by_model"] = {k: _present_bucket(v) for k, v in data["by_model"].items()}
    data["by_operation"] = {k: _present_bucket(v) for k, v in data["by_operation"].items()}
    data["estimated"] = data.get("incomplete_streams", 0) > 0
    return data


def _add(bucket: dict, prompt: int, completion: int, total: int, cost_nanousd: int) -> None:
    bucket["calls"] += 1
    bucket["prompt_tokens"] += prompt
    bucket["completion_tokens"] += completion
    bucket["total_tokens"] += total
    bucket["cost_nanousd"] += cost_nanousd  # integer sum — exact, never rounded away


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


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
        # Preserve full source precision: convert dollars to integer nano-USD once, then only
        # ever sum integers. round() here quantizes to 1e-9, far finer than any real per-call cost.
        cost_nanousd = round(float(usage.get("cost") or 0.0) * _NANO_USD)
        model = model or "unknown"
        operation = operation or "llm"
        with _lock:
            data = load()
            _add(data["total"], prompt, completion, total, cost_nanousd)
            _add(data["by_model"].setdefault(model, _empty_bucket()),
                 prompt, completion, total, cost_nanousd)
            _add(data["by_operation"].setdefault(operation, _empty_bucket()),
                 prompt, completion, total, cost_nanousd)
            data["first_at"] = data["first_at"] or _now()
            data["updated_at"] = _now()
            atomic_write_text(_usage_file(), json.dumps(data, indent=2))
    except Exception as e:  # accounting is best-effort; a bad usage dict must not fail the turn
        log.warning("usage.record failed (op=%s model=%s): %s", operation, model, e)


def record_incomplete(operation: str, model: str | None) -> None:
    """Mark that a streaming call was billed upstream but its cost is unknown here (it dropped
    after the first token, before the final usage chunk). Bumps a counter so totals are honestly
    flagged as estimates rather than silently understated; the call itself is not costed."""
    if not config.active_project_id():
        return
    try:
        with _lock:
            data = load()
            data["incomplete_streams"] = data.get("incomplete_streams", 0) + 1
            data["updated_at"] = _now()
            atomic_write_text(_usage_file(), json.dumps(data, indent=2))
    except Exception as e:
        log.warning("usage.record_incomplete failed (op=%s model=%s): %s", operation, model, e)
