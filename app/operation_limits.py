"""Per-operation ceilings on how large and how long one provider call may be.

The spend ceiling in `quotas.py`/`spend_ceiling.py` bounds an ACCOUNT over a month. This bounds a
single CALL, which is a different failure and needs a different mechanism: a runaway or
prompt-influenced request that asks for an enormous completion costs real money in one shot, and
by the time the monthly ledger notices, it has already been spent.

**These are ceilings, not defaults.** A caller asking for less keeps what it asked for; only a
request above the ceiling is clamped. That distinction matters because the values here are sized
from what each operation actually needs today, and a caller that genuinely needs less should not
be silently handed more.

**Why in one table rather than at each call site.** `max_tokens` is currently a per-call argument
with a permissive default (`llm.complete` allows 8,000, `stream` more), so a new call site
inherits a budget nobody chose and an existing one can be edited upward without review. Clamping
inside `llm` means a bound applies to every call by construction — the same reasoning that moved
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
    "discovery": (8_000, 300.0),
    "listening_preview": (1_000, 120.0),
    "affiliations": (2_000, 120.0),
    "author_profile": (4_000, 180.0),
    "lab_research": (8_000, 300.0),
}

#: For an operation with no entry. Above every short call in the app and well below the long ones,
#: so a new ancillary call is bounded without having to be listed, while a genuinely long new
#: operation is forced to declare itself here rather than inheriting a large budget by accident.
_DEFAULT_LIMIT = (8_000, 300.0)


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
