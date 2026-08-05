"""Per-project LLM usage + cost accounting (improvements §3.3).

Every OpenRouter call's usage — prompt/completion tokens and, when OpenRouter returns it, the
authoritative dollar cost — is recorded here from the two seams that see every call: ``llm.py``
for raw requests and ``agent_harness.py`` for Pydantic AI tool-loop requests.
It aggregates per project into `.state/usage.json`: a lifetime running total plus breakdowns by
model and by operation (analysis, narration, graph_extraction, discovery, notes).

Design notes:
- **Cost comes straight from OpenRouter** (we request `usage.include`, and read `usage.cost`)
  rather than a local per-model pricing table, so it stays correct as prices change. If a
  provider omits cost, that generation stays pending rather than becoming a false exact $0.
- **Cost is stored as an integer count of nano-USD** (1e-9 dollars), not a float. This is a
  credits-ledger foundation: summing integers is exact, so a million sub-micro-dollar calls add
  up correctly, whereas rounding each float addition to a few decimals silently discards them.
  The USD figure (`cost_usd`) is derived only for presentation.
- **Nothing is silently dropped.** Two honesty mechanisms:
  * A billed stream that ends without its final usage chunk (a mid-stream disconnect, or a clean
    EOF that a proxy/provider truncated) is recorded as a **pending** record — `{operation,
    model, generation_id, at}` — not as a zero-cost completed call. `summary()` flags the
    aggregate `estimated` while any pending exist. Keeping the generation id means these can be
    reconciled later against OpenRouter's generation-stats endpoint (see `reconcile`).
  * Narration on the app-global audio path with no initiating project is billed to an explicit
    **unattributed** ledger (a sentinel scope stored in app-global state), so no spend vanishes.
- **Foundation for the credits model.** The project aggregate remains the presentation cache;
  `usage_events.py` also appends the active `(user, project)` to Postgres for daily accounting.
  Like every other background write, a worker must rebind BOTH contextvars (invariant 2);
  graph/affiliation workers and `JobRegistry` do so, while audio jobs bind the initiating (or
  unattributed) project around narration and synthesis.

Reads/writes are serialized on a lock and persisted with an atomic write (concurrent graph
extraction records several papers at once into the same file).
"""
from __future__ import annotations

import json
import math
import threading
from datetime import UTC, datetime

from . import config, logging_config, usage_events
from .fileio import atomic_write_text

log = logging_config.get("usage")

_lock = threading.Lock()

_NANO_USD = 1_000_000_000  # cost is stored as integer nano-USD so accumulation is exact
_PENDING_CAP = 500         # bounded: drop the oldest pending records past this many

# A sentinel "project" whose ledger lives in app-global state — where narration (and any other
# call) with no real project to attribute to is recorded, rather than being dropped.
UNATTRIBUTED = "__unattributed__"

# Every aggregate bucket carries these integer counters (cost as nano-USD; see module docstring).
_FIELDS = ("calls", "prompt_tokens", "completion_tokens", "total_tokens", "cost_nanousd")


def _usage_file():
    if config.active_project_id() == UNATTRIBUTED:
        return config.APP_STATE_DIR / "usage-unattributed.json"
    return config.state_dir() / "usage.json"


def _empty_bucket() -> dict:
    return dict.fromkeys(_FIELDS, 0)


def _blank() -> dict:
    return {"total": _empty_bucket(), "by_model": {}, "by_operation": {},
            "pending": [], "dropped_pending": 0, "first_at": None, "updated_at": None}


def load() -> dict:
    """The raw stored aggregate for the active scope (integer nano-USD cost, pending records), or
    a blank shape. Internal/round-trip form — use `summary()` for presentation."""
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
    return {**bucket, "cost_usd": bucket.get("cost_nanousd", 0) / _NANO_USD}


def summary() -> dict:
    """Presentation form of the aggregate: every bucket gains a derived `cost_usd`, `pending` is
    reduced to a `pending_count`, and `estimated` is true while any billed-but-unreconciled
    stream remains — including `dropped_pending` generations evicted past the cap, which keep the
    total flagged as an estimate until an explicit administrative resolution, so forgotten spend
    can never round up to 'exact'."""
    data = load()
    pending = data.pop("pending", [])
    dropped = data.get("dropped_pending", 0)
    data["total"] = _present_bucket(data["total"])
    data["by_model"] = {k: _present_bucket(v) for k, v in data["by_model"].items()}
    data["by_operation"] = {k: _present_bucket(v) for k, v in data["by_operation"].items()}
    data["pending_count"] = len(pending)
    data["estimated"] = len(pending) > 0 or dropped > 0
    return data


def _add(bucket: dict, prompt: int, completion: int, total: int, cost_nanousd: int) -> None:
    bucket["calls"] += 1
    bucket["prompt_tokens"] += prompt
    bucket["completion_tokens"] += completion
    bucket["total_tokens"] += total
    bucket["cost_nanousd"] += cost_nanousd  # integer sum — exact, never rounded away


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _apply(data: dict, operation: str, model: str | None, usage: dict) -> None:
    prompt = int(usage.get("prompt_tokens") or 0)
    completion = int(usage.get("completion_tokens") or 0)
    total = int(usage.get("total_tokens") or (prompt + completion))
    # Preserve full source precision: convert dollars to integer nano-USD once, then only ever
    # sum integers. round() here quantizes to 1e-9, far finer than any real per-call cost.
    cost_nanousd = round(float(usage.get("cost") or 0.0) * _NANO_USD)
    model = model or "unknown"
    operation = operation or "llm"
    _add(data["total"], prompt, completion, total, cost_nanousd)
    _add(data["by_model"].setdefault(model, _empty_bucket()), prompt, completion, total, cost_nanousd)
    _add(data["by_operation"].setdefault(operation, _empty_bucket()),
         prompt, completion, total, cost_nanousd)
    data["first_at"] = data["first_at"] or _now()
    data["updated_at"] = _now()


def record(
    operation: str,
    model: str | None,
    usage: dict | None,
    *,
    generation_id: str | None = None,
    estimated: bool = False,
) -> None:
    """Accumulate one call's usage into the active scope's aggregate. No-ops when there is no
    active project (or unattributed scope) to attribute to, so app-global calls and unit tests
    don't write anything. Never raises — accounting must not break the call it is measuring."""
    project_id = config.active_project_id()
    user_id = config.active_user_id()
    if not project_id:
        return
    try:
        with _lock:
            data = load()
            _apply(data, operation, model, usage or {})
            atomic_write_text(_usage_file(), json.dumps(data, indent=2))
    except Exception as e:  # accounting is best-effort; a bad usage dict must not fail the turn
        log.warning("usage.record failed (op=%s model=%s): %s", operation, model, e)
    # Independent of the presentation-cache write: corruption or a full project volume must not
    # also erase the queryable per-user observation. The event seam is itself best-effort.
    try:
        usage_events.append_usage(
            user_id=user_id,
            project_id=project_id,
            operation=operation,
            model=model,
            provider_usage=usage,
            generation_id=generation_id,
            estimated=estimated,
        )
    except Exception as e:  # noqa: BLE001 — preserve the analytics-never-fails contract
        log.warning("usage event forwarding failed (error=%s)", type(e).__name__)


def record_pending(operation: str, model: str | None, generation_id: str | None) -> None:
    """Record that a streaming call was billed upstream but its cost is unknown here (it ended —
    by disconnect or truncation — without the final usage chunk). Stores a bounded pending
    record with the generation id so it can be reconciled later; `summary()` flags totals as
    estimates meanwhile. Best-effort, never raises."""
    project_id = config.active_project_id()
    user_id = config.active_user_id()
    if not project_id:
        return
    try:
        with _lock:
            data = load()
            data["pending"].append({"operation": operation or "llm", "model": model or "unknown",
                                     "generation_id": generation_id, "at": _now()})
            overflow = len(data["pending"]) - _PENDING_CAP
            if overflow > 0:
                # Evicting the oldest pending records past the cap would otherwise let totals go
                # `estimated=false` even though those billed generations were never resolved. Keep
                # a tombstone count so they still flag the aggregate as an estimate.
                data["dropped_pending"] = data.get("dropped_pending", 0) + overflow
                data["pending"] = data["pending"][-_PENDING_CAP:]
            data["updated_at"] = _now()
            atomic_write_text(_usage_file(), json.dumps(data, indent=2))
    except Exception as e:
        log.warning("usage.record_pending failed (op=%s model=%s): %s", operation, model, e)
    try:
        usage_events.append_pending(
            user_id=user_id,
            project_id=project_id,
            operation=operation,
            model=model,
            generation_id=generation_id,
        )
    except Exception as e:  # noqa: BLE001 — preserve the analytics-never-fails contract
        log.warning("pending usage event forwarding failed (error=%s)", type(e).__name__)


def _authoritative_cost(usage) -> bool:
    """True only for a genuine, ledger-usable cost value: a finite, non-negative real number.
    Explicit numeric 0 / 0.0 (a free model) qualifies; None, "", booleans, NaN/Infinity,
    negatives, and non-numeric strings do NOT — folding any of those in would clear a pending
    record as a zero-cost 'exact' call and under-count real spend."""
    if not isinstance(usage, dict) or "cost" not in usage:
        return False
    cost = usage["cost"]
    if isinstance(cost, bool) or not isinstance(cost, (int, float)):
        return False
    return math.isfinite(cost) and cost >= 0


def reconcile(generation_id: str, usage: dict | None) -> bool:
    """Resolve a previously-pending stream: if a pending record with this generation id exists in
    the active scope, drop it and fold its now-known usage into the aggregate. Returns True if a
    pending record was cleared. This is the hook a future OpenRouter generation-stats poller uses
    to turn estimates into exact spend.

    Requires AUTHORITATIVE cost — `usage["cost"]` must be a finite, non-negative number
    (see `_authoritative_cost`). Without it we don't touch the pending record: marking a
    generation 'exact' on unknown cost would clear the estimate flag while under-counting spend."""
    project_id = config.active_project_id()
    user_id = config.active_user_id()
    if not generation_id or not project_id:
        return False
    if not _authoritative_cost(usage):
        return False  # no authoritative cost -> leave it pending, keep totals flagged estimated
    try:
        with _lock:
            data = load()
            match = next((p for p in data["pending"] if p.get("generation_id") == generation_id), None)
            if match is None:
                return False
            data["pending"] = [p for p in data["pending"] if p is not match]
            _apply(data, match.get("operation"), match.get("model"), usage)
            atomic_write_text(_usage_file(), json.dumps(data, indent=2))
        try:
            usage_events.append_usage(
                user_id=user_id,
                project_id=project_id,
                operation=match.get("operation"),
                model=match.get("model"),
                provider_usage=usage,
                generation_id=generation_id,
            )
        except Exception as e:  # noqa: BLE001 — local reconciliation still succeeded
            log.warning("reconciled usage event forwarding failed (error=%s)", type(e).__name__)
        return True
    except Exception as e:
        log.warning("usage.reconcile failed (gen=%s): %s", generation_id, e)
        return False


def resolve_dropped(count: int | None = None) -> None:
    """Administratively acknowledge evicted (dropped) pending records as accounted-for out of
    band, so `estimated` can return to false. With no `count`, clears the whole tombstone; else
    decrements by that many (floored at 0). Best-effort, never raises."""
    if not config.active_project_id():
        return
    try:
        with _lock:
            data = load()
            current = data.get("dropped_pending", 0)
            data["dropped_pending"] = 0 if count is None else max(0, current - count)
            data["updated_at"] = _now()
            atomic_write_text(_usage_file(), json.dumps(data, indent=2))
    except Exception as e:
        log.warning("usage.resolve_dropped failed: %s", e)


def unattributed_summary() -> dict:
    """Presentation form of the app-global unattributed ledger (spend that had no project)."""
    token = config.set_active_project(UNATTRIBUTED)
    try:
        return summary()
    finally:
        config.reset_active_project(token)
