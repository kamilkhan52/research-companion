"""Per-operation ceilings on how large and how long one provider call may be.

The spend ceiling in `quotas.py`/`spend_ceiling.py` bounds an ACCOUNT over a month. This bounds a
single CALL, which is a different failure and needs a different mechanism: a runaway or
prompt-influenced request that asks for an enormous completion costs real money in one shot, and
by the time the monthly ledger notices, it has already been spent.

**These are ceilings, not defaults.** A caller asking for less keeps what it asked for; only a
request above the ceiling is clamped. That distinction matters because the values here are sized
from what each operation actually needs today, and a caller that genuinely needs less should not
be silently handed more.

**The agentic paths are bounded at two seams, both fed from this table.** `agent_harness`,
`lab_research`, `preview_jobs` and `retrieval_agent` run through Pydantic AI and never touch
`llm.complete`. They read this table twice over: once as `max_tokens` in the model's `OpenRouterModelSettings`,
which physically stops generation, and once through `run_output_ceiling` to size the run-level
`output_tokens_limit` in `UsageLimits`, which aborts a runaway loop after the fact. The first is
what actually stops money being spent; the second is the backstop, and see `run_output_ceiling`
for why it is deliberately not the product of the two. Anything using the raw client is
clamped here instead.

**Why in one table rather than at each call site.** `max_tokens` is currently a per-call argument
with a permissive default (`llm.complete` allows 8,000, `stream` more), so a new call site
inherits a budget nobody chose and an existing one can be edited upward without review. Clamping
inside `llm` means a bound applies to every raw-client call by construction — the same reasoning that moved
metering into `JobRegistry` rather than leaving it to each feature module.

Sized generously against observed use: the point is to stop an absurd request, not to trim a
working one. Where a call already asks for a specific budget (graph extraction's 48,000, sized
around reasoning-token exhaustion on large papers), the ceiling matches it rather than fighting it.
"""
from __future__ import annotations

from . import logging_config

log = logging_config.get("operation_limits")

#: operation -> (max completion tokens, wall-clock seconds for one attempt).
#:
#: `analysis` and `notes` are the long scholarly turns and already ask for 16,000. `narration`
#: rewrites one turn for speech. `graph_extraction` needs its large budget because the model
#: spends hidden reasoning tokens before emitting, and a truncated extraction is a wasted paid
#: call (see `graph.EXTRACTION_MAX_TOKENS`). The rest are short structured replies.
_LIMITS: dict[str, tuple[int, float]] = {
    "analysis": (24_000, 600.0),
    "notes": (24_000, 600.0),
    "narration": (16_000, 300.0),
    "graph_extraction": (48_000, 300.0),
    # 24,000 because `discovery.SCORING_MAX_TOKENS` asks for exactly that. The table is asserted
    # against the real constants rather than hand-copied numbers — this entry was 8,000 and the
    # test that was supposed to catch it simply did not list `discovery`.
    "discovery": (24_000, 300.0),
    # The app's highest-volume LLM operation (75 titles or 25 abstracts a batch). Given headroom
    # rather than left on the default it exactly equalled, so a batch-size change cannot silently
    # start truncating. Truncation degrades safely here — an unjudged title is kept — but the cost
    # of that is pushing hundreds of unscreened candidates into the paid abstract stage.
    "discovery_screen": (16_000, 300.0),
    "listening_preview": (1_000, 120.0),
    # The RESEARCH pass, not the cue. Distinct from `listening_preview` above because the cue is a
    # 180-token line and this returns up to 6,000 characters of sourced findings — roughly 1,500
    # tokens before reasoning or the tool-call turns are counted. Capping it at the cue's budget
    # would truncate a working feature, which is a new defect rather than a fix.
    #
    # 6,000 rather than 4,000 so the run-level ceiling derived from it keeps a real margin: at
    # 4,000 the ceiling landed at 16,800 against a theoretical 10,500-token run, and a backstop
    # only 1.6x above what the feature can legitimately emit is one bad run away from aborting it.
    "listening_preview_research": (6_000, 180.0),
    "affiliations": (2_000, 120.0),
    "author_profile": (4_000, 180.0),
    "lab_research": (8_000, 300.0),
    # The hunt emits tool calls and a short summary, never a document. It ran unbounded on both
    # axes — pydantic-ai's default request limit and an analysis-sized per-request cap — which made
    # the loosest budget in the app sit behind the cheapest hold.
    #
    # 8,000 rather than the ~1,000 its visible output needs: this runs on the account's DEFAULT
    # model, and OpenRouter counts hidden reasoning tokens against `max_tokens` for most providers.
    # `graph_extraction` above carries the same warning and the same generosity for the same
    # reason — a response truncated before it emits its tool call is a paid call that bought
    # nothing, which is worse than the unbounded state this replaced.
    "retrieval_hunt": (8_000, 180.0),
}

#: For an operation with no entry. Above every short call in the app and well below the long ones,
#: so a new ancillary call is bounded without having to be listed, while a genuinely long new
#: operation is forced to declare itself here rather than inheriting a large budget by accident.
_DEFAULT_LIMIT = (8_000, 300.0)


def tokens_for(operation: str) -> int:
    """The completion ceiling for `operation`, for callers that must apply it themselves.

    The Pydantic AI paths cannot be clamped inside `llm` because they never go through it, so they
    read the ceiling here and pass it to `UsageLimits`. One table, two enforcement points.
    """
    return _LIMITS.get(operation, _DEFAULT_LIMIT)[0]


def clamp_tokens(operation: str, requested: int) -> int:
    """The completion budget to actually use for `operation`.

    Logs when it clamps: a request above the ceiling is either a bug or a call site that outgrew
    its entry, and both are worth seeing rather than silently trimming.
    """
    ceiling = _LIMITS.get(operation, _DEFAULT_LIMIT)[0]
    if requested > ceiling:
        log.warning(
            "max_tokens for %s clamped from %d to %d", operation, requested, ceiling,
        )
        return ceiling
    return requested


def clamp_timeout(operation: str, requested: float) -> float:
    """The per-attempt timeout to actually use for `operation`.

    Note this is httpx's PER-PHASE budget, not wall clock — `graph.py` wraps its extraction in a
    real deadline for exactly that reason. Clamping it bounds how long one phase may hang, which
    is what stops a slow-drip response holding a paid job open indefinitely.
    """
    ceiling = _LIMITS.get(operation, _DEFAULT_LIMIT)[1]
    return min(float(requested), ceiling)


#: How much of a run's theoretical maximum output the run-level abort should allow before firing.
#:
#: Below 1.0 on purpose. `output_tokens_limit` was previously set to exactly
#: `tokens_for(op) * request_limit` — the precise total that `request_limit` maximal responses
#: produce — and pydantic-ai raises on `>`, not `>=`. So the sum could equal the limit but never
#: exceed it, `request_limit` always tripped first, and the "backstop" was unreachable by
#: construction. A backstop that cannot fire is not one.
#:
#: 0.6 measured, not guessed — against 101 real analysis calls in Kamil's own ledgers
#: (`projects/*/.state/usage.json`, 2026-08-08), whose MEAN completion is 3,732 tokens. A
#: twelve-request analysis run therefore emits on the order of 45,000 output tokens against a
#: ceiling of 172,800, so this fires only on a genuine runaway. The same check on the other three:
#: labs writes one line per author (`author_profile` mean 600) against 48,000, and the preview
#: research pass is capped at 6,000 characters of findings — about 1,500 tokens a request, ~10,500
#: over its budget — against 16,800. Tightening this without re-measuring would abort working
#: features, which is the failure mode a bound is supposed to prevent, not cause.
_RUN_OUTPUT_FRACTION = 0.6


def run_output_ceiling(operation: str, request_limit: int) -> int:
    """The run-level `output_tokens_limit` for a tool loop of at most `request_limit` requests.

    The per-request `max_tokens` is what physically stops generation; this aborts a loop that is
    burning its whole budget on output rather than converging. Sized so a run of consistently
    maximal responses trips it BEFORE exhausting its request budget — which is the only case where
    it has anything to say that `request_limit` does not.
    """
    return max(1, int(tokens_for(operation) * request_limit * _RUN_OUTPUT_FRACTION))
