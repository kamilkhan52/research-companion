"""The named plans an account can be on, and what each one allows.

Until now there was a single operator-configured ceiling and a comment saying tiers would arrive
with RevenueCat entitlements in M4/M5. That was the right call while nothing could *see* a plan —
but it left the quota UI with nothing to render and the eventual entitlement work with nothing to
map onto. A named plan now exists so both can be built and tested before any payment integration
does, and so M4's job is to *choose* a plan for an account rather than to invent the concept.

**`TESTER` is the default, and it is deliberately not one of the real tiers.** It mirrors their
shape — same credit unit, same ceiling mechanism, same surfaces — at an allowance sized for people
exercising the app rather than reading at a normal pace. A tester who hits a wall is a bug report
about the wall, not a signal about the product.

**The credit peg is `spend_limits.NANOUSD_PER_CREDIT`: 1 credit = $0.001 of metered variable
cost.** Everything here is expressed in credits so the numbers can be read against
`docs/production/20-pricing-analysis.md` §1 directly, and so a model price change is absorbed by
re-pricing operations rather than re-pricing plans.

**What exists today is one plan per DEPLOYMENT, not per account.** `for_user` takes a user id and
ignores it: there is no column, table or migration storing a per-account plan, so every account is
on `RC_DEFAULT_PLAN`. The signature is shaped for the per-account lookup it will become so callers
do not change when M4 fills it in — but nobody should read it as already being that. Two accounts
cannot currently be on different plans.

**What this is not.** It is not entitlement. Nothing here decides whether an account has *paid*.
Keeping that boundary sharp is why a plan is a plain name rather than a bundle of flags: a second
source of truth about what someone bought is exactly what M4 must not inherit.

**Two things to fix before the lookup is real.** It is called inline from `spend_ceiling.hold` on
every admission, so a database round trip there lands on the request thread under one worker
(invariant 6) — cache it first. And its fallback returns the MOST generous plan, which inverts the
"the dangerous configuration is absence" discipline the rest of this system follows; once a real
lookup can fail, an unresolved account should get the least generous plan or raise.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

from . import logging_config

log = logging_config.get("plans")


@dataclass(frozen=True)
class Plan:
    """One plan's allowance and how it should be described to the person on it."""

    name: str
    #: Monthly allowance in credits (1 credit = $0.001 of metered variable cost).
    monthly_credits: int
    #: What the reader is told they get. Deliberately in reading terms rather than credits —
    #: "20 papers" is a promise someone can check; "2,500 credits" is not.
    summary: str
    #: Whether premium (studio) narration is included, or only the device voice. The pricing
    #: analysis makes this the main lever between Free and Basic, because audio is the largest
    #: variable cost in the app.
    premium_audio: bool


#: The plans, keyed by the name stored against an account.
#:
#: Free and Basic are §1 of the pricing analysis, unchanged, so the numbers stay checkable against
#: the measured unit economics. Tester exists for this phase only.
PLANS: dict[str, Plan] = {
    "tester": Plan(
        name="tester",
        # Roughly twice Basic. Sized so someone exercising the app — repeating a flow, rebuilding a
        # graph, retrying a turn to see what changed — does not spend the session fighting a
        # ceiling. It is a testing affordance, not a product tier, and it is why the default here
        # is not simply "basic".
        monthly_credits=5_000,
        summary="Testing plan — generous allowance while the app is in review",
        premium_audio=True,
    ),
    "free": Plan(
        name="free",
        monthly_credits=200,
        summary="3–4 papers a month, your device's voice",
        premium_audio=False,
    ),
    "basic": Plan(
        name="basic",
        monthly_credits=2_500,
        summary="20 papers a month, 45 minutes of studio narration",
        premium_audio=True,
    ),
}

DEFAULT_PLAN = "tester"


def _configured_default() -> str:
    """The plan an account is on when nothing has assigned it one.

    Operator-configurable so a deployment can move everyone to `free` or `basic` without a code
    change, but an unknown name falls back rather than being honoured — the dangerous configuration
    is a typo silently granting an allowance nobody chose, in either direction.
    """
    raw = os.environ.get("RC_DEFAULT_PLAN", "").strip().lower()
    if not raw:
        return DEFAULT_PLAN
    if raw in PLANS:
        return raw
    log.warning("RC_DEFAULT_PLAN=%r is not a known plan; using %r", raw, DEFAULT_PLAN)
    return DEFAULT_PLAN


def for_user(user_id: str | None) -> Plan:
    """The plan governing `user_id`.

    Today every account is on the configured default; the per-account lookup this will become is
    M4's entitlement answer, and the signature is shaped for it so callers do not change then.
    """
    return PLANS[_configured_default()]


def monthly_credits(user_id: str | None = None) -> int:
    return for_user(user_id).monthly_credits
