"""What one account may spend in a month, and the pessimistic price of admitting one job.

`quotas.py` is the durable reservation ledger: it can atomically hold a maximum against a ceiling,
settle it, and reconcile orphans. It does not decide what the ceiling IS, or what a given operation
might cost at worst. Those are product decisions, and they live here so the ledger stays a
mechanism.

**The credit peg comes from `docs/production/20-pricing-analysis.md`: 1 credit = $0.001 of metered
variable cost.** That is what makes an allowance a real cost ceiling regardless of which operation
the reader spends it on, and what lets a model price change be absorbed by re-pricing the credit
table rather than re-pricing the tier.

**One ceiling, not a tier table, deliberately.** M4/M5 introduce RevenueCat entitlements, and a
tier system invented here would be replaced by them within the milestone — while creating a second
source of truth about who is entitled to what in the meantime. Until entitlements exist, every
signed-in account gets the same operator-configured monthly ceiling, defaulting to the pricing
doc's Basic allowance.

**These numbers are provisional and the roadmap says so.** They are grounded in measured spend
(§2 of the pricing analysis) but the analysis's own §8 lists preconditions, and one of them is not
met: web search through `research_tools` is still unmetered, so real spend is *understated* by
whatever an agentic turn does on the open web. A ceiling can only bound what the ledger can see.
"""
from __future__ import annotations

import os

from . import config, logging_config

log = logging_config.get("spend_limits")

#: Nano-USD in one credit. The peg the whole tier design rests on.
NANOUSD_PER_CREDIT = 1_000_000  # $0.001

#: Pricing analysis §1: Basic is 2,500 credits/month ($2.50 of variable cost) against $8.40 of net
#: revenue. Free is 200. Defaulting to Basic keeps the single household and the current allowlisted
#: testers working without per-account configuration; it is a ceiling, not an allowance to spend.
DEFAULT_MONTHLY_CREDITS = 2_500

#: Fraction of the ceiling at which the client should warn, not refuse.
SOFT_WARNING_AT = 0.8


def monthly_limit_nanousd() -> int:
    """The hard monthly ceiling for one account, in nano-USD.

    Operator-configurable in credits so the unit matches the pricing analysis. An invalid or
    non-positive value falls back to the default rather than being read as "unlimited": the
    dangerous configuration is absence, same discipline as the rate limits and the cache bounds.
    """
    raw = os.environ.get("RC_MONTHLY_CREDITS", "").strip()
    credits = DEFAULT_MONTHLY_CREDITS
    if raw:
        try:
            parsed = int(raw)
        except ValueError:
            log.warning("RC_MONTHLY_CREDITS=%r is not an integer; using %d", raw, credits)
        else:
            if parsed > 0:
                credits = parsed
            else:
                log.warning("RC_MONTHLY_CREDITS=%d is not positive; using %d", parsed, credits)
    return credits * NANOUSD_PER_CREDIT


#: Pessimistic ceiling per operation, in nano-USD, from the measured per-operation costs in
#: pricing analysis §2b/§2c. Each is deliberately ABOVE the measured mean: a reservation holds a
#: maximum and settles down to actual, so an estimate that is too low silently lets an account
#: exceed its ceiling, while one that is too high only makes the ceiling bind slightly early.
#:
#: `analysis` is the expensive one at ~$0.0262 all-in per turn on the recommended stack; the rest
#: are ancillary Flash-tier calls. `speech_synthesis` is exactly computable before dispatch
#: (character-priced `tts-1`), but this is the admission-time bound for a whole narration job,
#: whose text length is not known until the turn that produces it has run.
_MAX_NANOUSD: dict[str, int] = {
    # $0.15 — the ledger actual for a turn is $0.06023 (§2b), not the recommended stack's $0.0262,
    # and §8 lists provider pinning as an unmet precondition. 2.5x that, not 3x the aspiration.
    "analysis": 150_000_000,
    "narration": 40_000_000,        # $0.04
    # $0.60. The MEAN cached narration is 10,702 characters ($0.1605 at tts-1) and the largest
    # measured is 36,987 ($0.555) — §2c. Narration length is unknown at admission and §8 records
    # it as still uncapped, so the hold has to cover the observed maximum, not the mean.
    "speech_synthesis": 600_000_000,
    "retrieval": 20_000_000,        # $0.02 — the fetch is free; extraction is cheap
    "discovery": 150_000_000,       # $0.15 — a measured cold run was $0.013; slice 2 widened recall
    # $0.084 per paper (§2b) x a large project. Deliberately generous: this is one admission for
    # work that fans out across an entire corpus, and `_MAX_NANOUSD` cannot see the corpus size.
    "graph_build": 10_000_000_000,  # $10.00
    "notes": 40_000_000,            # $0.04
    "author_profile": 20_000_000,   # $0.02
    "lab_research": 40_000_000,     # $0.04
}

#: Used when an operation has no entry. Generous rather than tight: refusing a legitimate reader is
#: the failure the roadmap ranks worse than a mild overspend, and an unknown operation is far more
#: likely to be a new cheap ancillary call than a new expensive one.
_DEFAULT_MAX_NANOUSD = 50_000_000


def max_cost_nanousd(operation: str) -> int:
    """The pessimistic maximum to hold for one admission of `operation`."""
    return _MAX_NANOUSD.get(operation, _DEFAULT_MAX_NANOUSD)


def enabled() -> bool:
    """Whether spend ceilings can be enforced at all.

    Requires both a database (the ledger is durable, per architectural rule 5) and a signed-in
    user to attribute the spend to. With either absent this collapses to today's single-household
    behaviour, which is what keeps `./run.sh` and the test suite working with no server.
    """
    from . import db  # local: db imports config, and config imports nothing from here

    return db.enabled() and bool(config.active_user_id())
