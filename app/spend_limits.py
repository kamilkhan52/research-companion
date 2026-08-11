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
    # Since DR-058 this hold also covers the finish turn's synthesis-editor continuation
    # (metered as `synthesis_edit`, notes-sized inputs, single call): a second admission would
    # let one Finish consume two concurrency slots and refuse mid-flight. Headroom holds — the
    # measured turn plus a notes-sized editing call stays well under $0.15.
    "analysis": 150_000_000,
    "narration": 40_000_000,        # $0.04
    # $0.60 — the FALLBACK bound only, covering the largest measured narration (36,987 chars,
    # $0.555 at tts-1 — §2c). A caller that knows its text passes `speech_hold_nanousd(chars)`
    # instead: character pricing makes the cost computable at admission, and the flat maximum
    # exceeded the whole Free ceiling ($0.20), refusing every narration on Free regardless of
    # length — a de-facto quality tier, which DR-042 removes. audio_jobs sizes its hold from the
    # canonical text it was handed.
    "speech_synthesis": 600_000_000,
    # Kept for any caller that asks for a `retrieval` hold, but the retrieval JOB no longer takes
    # one: its own thread dispatches nothing to a provider (arXiv fetch, local PDF extraction), and
    # everything under it that does spend — the hunt, affiliations, references — reserves for
    # itself. A ticket that authorizes no dispatch should not occupy the spend ledger.
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
    # ONE author's web pass. Not an admission ticket as well — the labs registry is
    # `reserves=False`, so this is reserved only inside `spend_ceiling.per_unit`, once per author.
    # It briefly did double duty, which meant a reader with $0.06 was admitted on a $0.04 ticket
    # and then could not afford the $0.04 author, and a crash mid-author charged both.
    "lab_research": 40_000_000,     # $0.04
}

#: ASSUMED stage-2 expansion of canonical text into narration. Not a measured distribution —
#: the pricing doc's token means imply a mean ratio near 1.1, and the local transcripts hold too
#: few pairs to call it more than that — so this sits modestly above the implied mean rather
#: than claiming to bound the spread. The ceiling may legitimately settle ABOVE the hold when a
#: narration expands past it: `quotas.settle` charges actual, so the overage is billed, not
#: lost (see `speech_hold_nanousd`).
_SPEECH_TEXT_MARGIN = 1.25

def speech_hold_nanousd(chars: int, rate_nanousd_per_char: int | None) -> int:
    """The admission hold for narrating a text of `chars` characters (DR-042).

    Sized from the text at THE CONFIGURED MODEL'S rate (the caller resolves it via
    `tts.nanousd_per_char`), with margin, plus the stage-2 narration LLM lease — never the flat
    worst-case, which alone exceeded the Free ceiling and refused every narration on the
    smallest plan. Round 2 of the review is why the rate is a parameter: sizing every hold at
    tts-1's 15,000 nano/char under-reserved 2.7x for `gpt-4o-mini-tts`, letting one job admit on
    Free and settle 40% past the whole monthly ceiling. An unknown model's rate (None) falls
    back to the flat bound, as does an unknown length — never to a free pass.

    The hold is an ESTIMATE the settlement may exceed: a narration that expands past the margin
    is charged at actual. That direction is safe for the ledger (the money is billed) and bounded
    by the per-request caps; the clamp below only stops a pathological length from reserving more
    than the old flat bound did.
    """
    if chars <= 0 or rate_nanousd_per_char is None or rate_nanousd_per_char <= 0:
        return _MAX_NANOUSD["speech_synthesis"]
    estimated = int(chars * rate_nanousd_per_char * _SPEECH_TEXT_MARGIN)
    return min(_MAX_NANOUSD["speech_synthesis"],
               estimated + _MAX_NANOUSD["narration"])


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
