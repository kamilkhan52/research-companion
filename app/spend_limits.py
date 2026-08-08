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

#: Fraction of the ceiling at which the client should warn, not refuse.
SOFT_WARNING_AT = 0.8


def monthly_limit_nanousd() -> int:
    """The hard monthly ceiling for the active account, in nano-USD.

    Comes from the account's PLAN (`plans.py`) unless an operator override is set. The plan is the
    normal answer and the override is the escape hatch, not the other way round: a named plan is
    what the client can render and what M4's entitlements will map onto, whereas an env var is
    invisible to everyone but whoever set it.

    An invalid or non-positive override falls back rather than being honoured — the dangerous
    configuration is absence, same discipline as the rate limits and the cache bounds.
    """
    from . import plans

    raw = os.environ.get("RC_MONTHLY_CREDITS", "").strip()
    credits = plans.monthly_credits(config.active_user_id())
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
    # The escalation tier, and a different animal from the line above: a multi-turn tool loop with
    # web search and page fetches, on the account's analysis-tier model, taken as its own hold only
    # when the deterministic path has already failed. Generous rather than tight — refusing a
    # legitimate reader is the failure the roadmap ranks worse than a mild overspend, and a reader
    # who reaches the hunt has already had one retrieval fail.
    "retrieval_hunt": 100_000_000,  # $0.10
    "discovery": 150_000_000,       # $0.15 — a measured cold run was $0.013; slice 2 widened recall
    # Nominal, and deliberately so: a build spends nothing on its own thread. Every paper it
    # extracts takes its own `graph_extraction` hold through `paper-references`, so the build is
    # gated paper by paper and this is only the admission ticket. Sizing it to the corpus instead
    # held a large fraction of the month in budget that never became spend — measured at roughly
    # ten papers a month lost to holds alone.
    "graph_build": 20_000_000,      # $0.02
    "notes": 40_000_000,            # $0.04
    # Cues run for as long as a narration takes to synthesize, at a cadence of one every few
    # seconds with NO cap on how many (Kamil's 2026-07-30 call: silence during the wait is worse
    # at any cost). §2b prices a cue at $0.00108 pinned, so this covers a long wait generously.
    "listening_preview": 60_000_000,   # $0.06
    "affiliations": 10_000_000,        # $0.01 — one small extraction per paper
    # §2b prices extraction at $0.00721/paper on pinned V4 Flash, which is what
    # `graph.resolve_model` selects since 2026-08-07. 4x headroom over that, and still well under
    # the $0.10 this held while extraction ran on Pro — the hold is what decides how much of a
    # month a build can consume, so pricing it off the wrong model was costing mapped papers.
    "graph_extraction": 30_000_000,    # $0.03
    "author_profile": 20_000_000,   # $0.02
    # Doing double duty, and it can: the labs JOB's admission ticket, and the per-AUTHOR hold each
    # web pass takes inside it (`spend_ceiling.per_unit`). One agentic pass is what $0.04 buys, so
    # the same number is right for both — the job is admitted for roughly one author's worth and
    # then gated author by author, exactly as a graph build is gated paper by paper. Before that
    # split, one $0.04 ticket covered up to ten passes and under-reserved by an order of magnitude.
    "lab_research": 40_000_000,     # $0.04
}

#: Used when an operation has no entry. Generous rather than tight: refusing a legitimate reader is
#: the failure the roadmap ranks worse than a mild overspend, and an unknown operation is far more
#: likely to be a new cheap ancillary call than a new expensive one.
_DEFAULT_MAX_NANOUSD = 50_000_000


def max_cost_nanousd(operation: str) -> int:
    """The pessimistic maximum to hold for one admission of `operation`."""
    return _MAX_NANOUSD.get(operation, _DEFAULT_MAX_NANOUSD)


#: How long a reservation's lease should outlive its job, per operation. The reconciler treats a
#: dispatched reservation past its lease as an orphan and settles it CONSERVATIVELY — at the full
#: maximum — so a lease shorter than the work charges the account the maximum while the job is
#: still running, and the worker's own settle then finds it already finalized. A graph build is
#: documented as running up to 2.5 hours (`graph_jobs`), and `graph.EXTRACTION_HARD_DEADLINE` is
#: 480s per paper, so an hour is far too short for it.
_LEASE_SECONDS = {
    "graph_build": 6 * 60 * 60,     # comfortably past the longest observed build
    "graph_extraction": 60 * 60,    # one paper, bounded by EXTRACTION_HARD_DEADLINE
    "discovery": 2 * 60 * 60,       # slice 2 widened recall; a cold run was ~7 minutes
    "speech_synthesis": 60 * 60,    # long narrations are many segments
    "analysis": 60 * 60,
}
_DEFAULT_LEASE_SECONDS = 60 * 60


def lease_seconds(operation: str) -> int:
    """How long to hold the lease for one admission of `operation`."""
    return _LEASE_SECONDS.get(operation, _DEFAULT_LEASE_SECONDS)


def enabled() -> bool:
    """Whether spend ceilings can be enforced at all.

    Requires both a database (the ledger is durable, per architectural rule 5) and a signed-in
    user to attribute the spend to. With either absent this collapses to today's single-household
    behaviour, which is what keeps `./run.sh` and the test suite working with no server.
    """
    from . import db  # local: db imports config, and config imports nothing from here

    return db.enabled() and bool(config.active_user_id())
