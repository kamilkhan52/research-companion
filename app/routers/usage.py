"""LLM token/cost usage read routes: a project's own ledger and the app-global unattributed
ledger (spend with no project to bill, e.g. narration requested without an initiating project).
Named `usage_routes`-style module; drives the `app.usage` service."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from .. import auth, plans, quotas, spend_limits, usage
from . import make_project_router

router = APIRouter()
project_router = make_project_router()


@router.get("/api/plan")
def get_plan(request: Request):
    """The signed-in account's plan and where it stands against it this period.

    One call rather than two, because everything a client needs to render the surface is here and
    a client that has to combine two responses will eventually render a mismatched pair.

    `spent` and `held` are deliberately separate. Spend does not come back until the period rolls
    over; a hold clears in seconds when its job settles. Adding them together would tell someone
    with several jobs running that they are nearly out of allowance when they have barely spent
    anything — the same confusion the transient/exhausted split in `QuotaExceeded` exists to
    remove.

    That is a rule about DISPLAY, and `warn` is not a display value: it is computed from spend PLUS
    holds precisely so it can precede a refusal, which admission also decides on the sum (see the
    comment on the field). The two are not in tension, but they are easy to conflate — an earlier
    revision of this docstring claimed `warn` came from spend alone, contradicting the line that
    computes it. The client honours both by keeping them on different surfaces: the plan screen's
    bar and its approaching-limit card track `spent_fraction` only, while `warn`/`at_capacity`
    belong next to the refusal they anticipate. See `docs/plan-usage-surface-spec.md`.

    With no database (local dev, the test suite) this reports the plan with zero usage rather than
    failing: the ceiling is inert there too, so zero is the honest answer, not a placeholder.
    """
    user_id = getattr(request.state, "user", None)
    user_id = (user_id or {}).get("user_id") if isinstance(user_id, dict) else None
    plan = plans.for_user(user_id)
    # The ENFORCED limit, not the plan's headline number. `monthly_limit_nanousd` is the single
    # function admission itself calls, and it applies the `RC_MONTHLY_CREDITS` override. Reading
    # the plan directly meant that on any deployment with that override set — production has one —
    # the screen would show a bar at 15% and "$4.25 remaining" beside a refusal saying the limit
    # was reached. A usage display that disagrees with the refusal beside it is worse than none.
    limit = spend_limits.monthly_limit_nanousd()
    usage_period = quotas.period_usage(user_id) if user_id else (0, 0)
    spent, held = usage_period if usage_period is not None else (0, 0)
    _, period_end = quotas.calendar_month()
    return {
        "plan": {
            "name": plan.name,
            "summary": plan.summary,
            "premium_audio": plan.premium_audio,
            "monthly_credits": plan.monthly_credits,
        },
        "limit_nanousd": limit,
        "spent_nanousd": spent,
        "held_nanousd": held,
        "remaining_nanousd": max(0, limit - spent - held),
        # Percentages are what a bar renders; sending them avoids each client deriving them
        # differently and disagreeing about when the warning appears.
        # The bar tracks SPEND, because that is the irreversible part.
        "spent_fraction": round(spent / limit, 4) if limit else 0.0,
        # The warning tracks spend PLUS holds, because it exists to arrive before a refusal and
        # admission refuses on the sum. Computed from spend alone it could not fire at all in the
        # case that matters: a reader at 76% with one listening flow in flight ($0.81 held) is
        # refused, while a spend-only warning stays quiet and the same payload reports nothing
        # remaining. A warning that cannot precede the refusal is decoration.
        "warn": bool(limit) and (spent + held) >= limit * spend_limits.SOFT_WARNING_AT,
        "warn_at_fraction": spend_limits.SOFT_WARNING_AT,
        # Distinct from `warn`: nothing more can start right now. Lets a client say "your other
        # tasks are using the rest" instead of implying the month is gone.
        "at_capacity": bool(limit) and (spent + held) >= limit,
        "period_ends": period_end.isoformat(),
        # False when there is no database or nobody signed in — the client should then say nothing
        # about allowances rather than showing a confident zero.
        "enforced": bool(user_id) and spend_limits.enabled(),
        # Separate from `enforced`: the ceiling can be live while this particular read failed. A
        # database hiccup used to report `enforced: true` with a full remaining balance at the very
        # moment every job was failing closed — the most misleading pair the endpoint could send.
        "usage_available": usage_period is not None,
    }


@project_router.get("/usage")
def get_usage(pid: str):
    """This project's accumulated LLM token/cost usage (lifetime aggregate + per-model /
    per-operation breakdowns, cost in USD + exact nano-USD). `estimated` is true when some
    billed streams dropped before their final usage chunk. Cheap read of .state/usage.json."""
    return usage.summary()


@router.get("/api/usage/unattributed")
def get_unattributed_usage(request: Request):
    """App-global ledger of LLM spend with no project to attribute to (e.g. narration requested
    without an initiating project). Kept explicit so nothing is silently dropped.

    Operator-only: it is instance-wide by definition, so it reports what EVERY user's unattributed
    activity cost — models, operations and spend. That is the operator's billing view, not a
    reader's.
    """
    if not auth.is_operator(getattr(request.state, "user", None)):
        raise HTTPException(
            status_code=403,
            detail="The instance-wide usage ledger is restricted to the operator.")
    return usage.unattributed_summary()
