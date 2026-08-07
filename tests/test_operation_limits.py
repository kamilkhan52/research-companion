"""Per-call ceilings on completion size and attempt duration.

The monthly spend ceiling bounds an ACCOUNT. This bounds one CALL, which is a different failure:
a runaway or prompt-influenced request for an enormous completion is spent in a single shot, long
before a monthly ledger notices. The two must not be confused for each other.
"""
from __future__ import annotations

import pytest
from app import llm, operation_limits


def test_a_request_under_the_ceiling_is_left_alone():
    """These are ceilings, not defaults — a caller that needs less must keep what it asked for."""
    assert operation_limits.clamp_tokens("analysis", 4_000) == 4_000
    assert operation_limits.clamp_timeout("analysis", 30.0) == 30.0


def test_an_absurd_request_is_clamped_to_the_operations_ceiling():
    assert operation_limits.clamp_tokens("analysis", 10_000_000) == 24_000
    assert operation_limits.clamp_timeout("listening_preview", 86_400) == 120.0


def test_an_unlisted_operation_is_bounded_rather_than_unlimited():
    """A new ancillary call must be bounded without having to be declared; a genuinely long new
    operation is then forced to declare itself rather than inheriting a large budget silently."""
    ceiling = operation_limits.clamp_tokens("some-new-operation", 10_000_000)
    assert ceiling == operation_limits._DEFAULT_LIMIT[0]
    assert 0 < ceiling < 24_000, "the default must bound, and must not equal the longest operation"


@pytest.mark.parametrize("operation,needs", [
    ("analysis", 16_000),            # agent.stream_messages
    ("notes", 16_000),               # notes_jobs
    ("graph_extraction", 48_000),    # graph.EXTRACTION_MAX_TOKENS
    ("listening_preview", 180),      # preview_jobs cue
    ("affiliations", 800),
    ("author_profile", 600),
])
def test_every_ceiling_clears_what_that_operation_actually_asks_for(operation, needs):
    """A ceiling below real use would truncate paid work — which is worse than not having one,
    because the call is billed either way and the result is unusable."""
    assert operation_limits.clamp_tokens(operation, needs) == needs


def test_the_llm_entry_points_clamp_rather_than_trusting_the_caller(monkeypatch):
    """The bound has to live inside `llm`, or a new call site inherits a budget nobody chose."""
    seen: dict = {}

    def fake_post(body, key, timeout, tries):
        seen["max_tokens"] = body.get("max_tokens")
        seen["timeout"] = timeout
        return {"choices": [{"message": {"content": "ok"}}], "usage": {}}

    monkeypatch.setattr(llm, "_post_with_retry", fake_post)
    monkeypatch.setattr(llm, "_key_and_default_model", lambda: ("k", "m"))
    llm.complete([{"role": "user", "content": "hi"}],
                 max_tokens=10_000_000, timeout=99_999, operation="listening_preview")
    assert seen["max_tokens"] == 1_000
    assert seen["timeout"] == 120.0
