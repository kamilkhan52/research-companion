"""Which plan one account is on — the storage behind `plans.for_user`.

Separate from `plans` so that module stays a description of what each plan ALLOWS, with no opinion
about who is on one, and separate from `user_settings` because a plan is granted rather than
chosen.

**Reading this is on the hot path.** `plans.for_user` is called inline from `spend_ceiling.hold`
on every admission, so an uncached read is a Postgres round trip — a network hop on Fly — on the
request thread, under a single worker (invariant 6). Hence the same per-context memo
`user_settings` uses, and for the same second reason: a cache scoped to one request or one job
cannot serve one account's plan to another, whatever goes wrong with invalidation.

**On failing to read.** `plans`' own docstring asked for the least generous plan on an unresolved
lookup, reasoning that absence should be the dangerous configuration. That is the right instinct
in general and the wrong answer here, because it collides with the roadmap's stated risk position:
blocking a paying reader is worse than a mild overspend. What resolves it is that this is not the
thing standing between an account and its money — `quotas` fails closed on every store failure, so
an admission during a database outage is refused no matter what plan this returns. A read failure
here therefore cannot become an overspend path, and answering with the operator's configured
default keeps a transient blip from demoting somebody who has paid.
"""
from __future__ import annotations

import contextvars

from . import db, logging_config

log = logging_config.get("account_plans")

SOURCES = ("operator", "revenuecat")

#: Per-context memo of one account's plan name. See the module docstring.
_cache: contextvars.ContextVar[tuple[str, str | None] | None] = contextvars.ContextVar(
    "account_plan_cache", default=None)


def available(user_id: str | None) -> bool:
    """Whether a per-account plan can be stored at all.

    False with no database and for an unauthenticated caller, in which case every account is on the
    deployment default — today's behaviour, and what keeps `./run.sh` and the tests unchanged.
    """
    return bool(user_id) and db.enabled()


def load(user_id: str | None) -> str | None:
    """This account's plan NAME, or None if it has none (or cannot be read).

    None means "no per-account grant" and the caller applies the deployment default. It
    deliberately does not distinguish that from a failed read: both mean this module has no answer,
    and a caller that branched on the difference would be deciding an allowance from the health of
    a connection.
    """
    if not available(user_id):
        return None
    cached = _cache.get()
    if cached is not None and cached[0] == user_id:
        return cached[1]
    try:
        with db.pool().connection() as conn:
            row = conn.execute(
                "select plan from rc_account_plans where user_id = %s", (user_id,)).fetchone()
    except Exception as e:  # noqa: BLE001 — see the module docstring on failing to read
        log.warning("account_plans: could not read the plan for this account: %s", str(e)[:200])
        return None
    plan = row[0] if row else None
    _cache.set((user_id, plan))
    return plan


def set_plan(user_id: str, plan: str, *, source: str, external_id: str | None = None) -> None:
    """Grant `user_id` a plan. Raises rather than swallowing: unlike a read, a write that silently
    did nothing would leave someone who paid on the wrong allowance with nothing to notice it."""
    if source not in SOURCES:
        raise ValueError(f"Unknown plan source: {source!r}")
    from . import plans  # local: plans imports this module's caller, not this module

    if plan not in plans.PLANS:
        raise ValueError(f"Unknown plan: {plan!r}")
    with db.pool().connection() as conn:
        conn.execute(
            "insert into rc_account_plans (user_id, plan, source, external_id, updated_at) "
            "values (%s, %s, %s, %s, now()) "
            "on conflict (user_id) do update set plan = excluded.plan, source = excluded.source, "
            "external_id = excluded.external_id, updated_at = now()",
            (user_id, plan, source, external_id),
        )
    forget_cache()
    log.info("account_plans: %s is now on %s (source=%s)", user_id[:8], plan, source)


def clear_plan(user_id: str) -> None:
    """Remove the per-account grant, returning the account to the deployment default."""
    with db.pool().connection() as conn:
        conn.execute("delete from rc_account_plans where user_id = %s", (user_id,))
    forget_cache()


def forget_cache() -> None:
    """Drop this context's memo. Called after a write, and by tests."""
    _cache.set(None)
