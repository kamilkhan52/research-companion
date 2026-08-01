"""Best-effort append-only Postgres usage events for M3 analytics.

The git-side ``usage.json`` aggregate remains the fast project presentation cache. These rows are
the queryable user/day/feature history that quotas and anomaly detection need. They deliberately
contain no request/response content and never make a provider result fail: an unavailable analytics
store loses an observation and logs the exception class, while the later *reservation* store is a
separate fail-closed system.
"""
from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta

from . import db, logging_config, tenancy

log = logging_config.get("usage-events")

NANO_USD = 1_000_000_000
_PG_BIGINT_MAX = 9_223_372_036_854_775_807
UNATTRIBUTED_PROJECT = "__unattributed__"


def append_usage(
    *,
    user_id: str | None,
    project_id: str | None,
    operation: str | None,
    model: str | None,
    provider_usage: dict | None,
    generation_id: str | None = None,
    estimated: bool = False,
) -> bool:
    """Append one completed/observed provider call. Returns whether a new row landed.

    A generation id is an idempotency key: repeating the analytics write returns ``False`` rather
    than adding spend twice. Calls without a provider id (notably character-priced TTS) remain one
    row per dispatch, which is exactly their billable unit.
    """
    data = provider_usage if isinstance(provider_usage, dict) else {}
    prompt = _nonnegative_int(data.get("prompt_tokens"))
    completion = _nonnegative_int(data.get("completion_tokens"))
    total = _nonnegative_int(data.get("total_tokens")) or prompt + completion
    cost = _cost_nanousd(data.get("cost"))
    exact_cost = _authoritative_cost(data.get("cost"))
    return _append(
        user_id=user_id,
        project_id=project_id,
        event_type="usage",
        operation=operation,
        model=model,
        prompt_tokens=prompt,
        completion_tokens=completion,
        total_tokens=total,
        cost_nanousd=cost,
        generation_id=generation_id,
        estimated=estimated or not exact_cost,
    )


def append_pending(
    *,
    user_id: str | None,
    project_id: str | None,
    operation: str | None,
    model: str | None,
    generation_id: str | None,
) -> bool:
    """Append one billed-but-unresolved provider marker."""
    return _append(
        user_id=user_id,
        project_id=project_id,
        event_type="pending",
        operation=operation,
        model=model,
        prompt_tokens=0,
        completion_tokens=0,
        total_tokens=0,
        cost_nanousd=0,
        generation_id=generation_id,
        estimated=True,
    )


def _append(
    *,
    user_id: str | None,
    project_id: str | None,
    event_type: str,
    operation: str | None,
    model: str | None,
    prompt_tokens: int,
    completion_tokens: int,
    total_tokens: int,
    cost_nanousd: int,
    generation_id: str | None,
    estimated: bool,
) -> bool:
    if not db.enabled() or not user_id:
        return False
    pid = None if project_id == UNATTRIBUTED_PROJECT else project_id
    try:
        # A project ownership row already guarantees the user FK exists. App-global audio can be
        # the first database-backed action after sign-in, so only that null-project case needs to
        # create the verified JWT subject before inserting its event.
        if pid is None:
            tenancy.ensure_user(user_id)
        with db.pool().connection() as conn:
            row = conn.execute(
                "insert into rc_usage_events "
                "(user_id, project_id, event_type, operation, model, prompt_tokens, "
                " completion_tokens, total_tokens, cost_nanousd, generation_id, estimated) "
                "select %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s "
                "where %s::text is null or exists ("
                "  select 1 from rc_projects "
                "  where id = %s and owner_id = %s and deleted_at is null"
                ") "
                "on conflict (user_id, generation_id, event_type) "
                "where generation_id is not null do nothing "
                "returning id",
                (
                    user_id, pid, event_type, operation or "llm", model or "unknown",
                    prompt_tokens, completion_tokens, total_tokens, cost_nanousd,
                    generation_id, estimated,
                    pid, pid, user_id,
                ),
            ).fetchone()
        return row is not None
    except Exception as exc:  # noqa: BLE001 — analytics cannot fail paid work
        # Never include the database message: it can echo bound values. Operation/model are fixed
        # app/provider metadata, but the identity/project and any provider content stay out.
        log.warning(
            "usage event append failed (type=%s op=%s model=%s error=%s)",
            event_type, operation or "llm", model or "unknown", type(exc).__name__,
        )
        return False


def daily_summary(user_id: str, *, days: int = 30) -> list[dict]:
    """Queryable cost-by-day/feature for one account; internal analytics seam, not an API route."""
    if not db.enabled() or days < 1:
        return []
    since = datetime.now(UTC) - timedelta(days=days)
    with db.pool().connection() as conn:
        rows = conn.execute(
            "select created_at::date, operation, sum(prompt_tokens), "
            "sum(completion_tokens), sum(total_tokens), sum(cost_nanousd), "
            "bool_or(estimated), count(*) "
            "from rc_usage_events "
            "where user_id = %s and event_type = 'usage' and created_at >= %s "
            "group by created_at::date, operation order by created_at::date, operation",
            (user_id, since),
        ).fetchall()
    return [
        {
            "day": row[0].isoformat(),
            "operation": row[1],
            "prompt_tokens": row[2],
            "completion_tokens": row[3],
            "total_tokens": row[4],
            "cost_nanousd": row[5],
            "estimated": row[6],
            "calls": row[7],
        }
        for row in rows
    ]


def _nonnegative_int(value, *, default: int = 0) -> int:
    try:
        parsed = int(value) if value is not None else default
    except (TypeError, ValueError, OverflowError):
        return default
    return max(0, parsed)


def _authoritative_cost(value) -> bool:
    valid = (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and value >= 0
    )
    return bool(valid and value * NANO_USD <= _PG_BIGINT_MAX)


def _cost_nanousd(value) -> int:
    return round(float(value) * NANO_USD) if _authoritative_cost(value) else 0
