"""Per-call ceilings on completion size and attempt duration.

The monthly spend ceiling bounds an ACCOUNT. This bounds one CALL, which is a different failure:
a runaway or prompt-influenced request for an enormous completion is spent in a single shot, long
before a monthly ledger notices. The two must not be confused for each other.
"""
from __future__ import annotations

import json

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


def _real_budgets() -> list[tuple[str, int]]:
    """What each operation ACTUALLY asks for, read from the constants the callers use.

    Hand-copied integers are what let `discovery` ship with a ceiling three times below
    `SCORING_MAX_TOKENS`: the list simply did not mention it. Importing the real constants means a
    caller that raises its budget without raising its ceiling fails here instead of truncating a
    paid call in production.
    """
    from app import discovery, graph, preview_jobs

    return [
        ("analysis", 16_000),                                   # agent.stream_messages
        ("notes", 16_000),                                      # notes_jobs
        ("graph_extraction", graph.EXTRACTION_MAX_TOKENS),
        ("discovery", discovery.SCORING_MAX_TOKENS),
        ("discovery_screen", discovery.TITLE_TRIAGE_MAX_TOKENS),
        ("discovery_screen", discovery.ABSTRACT_SCORING_MAX_TOKENS),
        ("listening_preview", preview_jobs.CUE_MAX_TOKENS),
        ("affiliations", 800),
        ("author_profile", 600),
    ]


@pytest.mark.parametrize("operation,needs", _real_budgets())
def test_every_ceiling_clears_what_that_operation_actually_asks_for(operation, needs):
    """A ceiling below real use would truncate paid work — worse than not having one, because the
    call is billed either way and the result is unusable."""
    assert operation_limits.clamp_tokens(operation, needs) == needs, (
        f"{operation}'s ceiling is below the {needs} tokens its caller requests"
    )


def test_the_agentic_paths_are_bounded_from_the_same_table():
    """Pydantic AI never reaches `llm.complete`, so the clamp cannot cover it.

    The default turn path is the most expensive metered operation in the app; capping request
    COUNT bounds how many rounds a loop takes and says nothing about how large each is.
    """
    from app import agent_harness

    limits = agent_harness._USAGE_LIMITS
    assert limits.request_limit == agent_harness.AGENT_REQUEST_LIMIT
    assert limits.output_tokens_limit is not None, (
        "the agentic loop must bound output size, not only round count"
    )
    assert limits.output_tokens_limit == (
        operation_limits.tokens_for("analysis") * agent_harness.AGENT_REQUEST_LIMIT
    ), "it must read the same table the raw client clamps against, not a second set of numbers"


def test_complete_clamps_rather_than_trusting_the_caller(monkeypatch):
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


def test_stream_clamps_too(monkeypatch):
    """The half that carries the long turns, and the half that was untested.

    The previous test was named for both entry points but monkeypatched `_post_with_retry`, which
    only `complete` uses — so removing the clamp from `stream` left the suite green. `stream` is
    the more important of the two to bound: it bills as it emits, so an oversized budget is spent
    before anything can decide it was a mistake.
    """
    import httpx

    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["max_tokens"] = json.loads(request.content)["max_tokens"]
        body = (
            'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'
            "data: [DONE]\n\n"
        )
        return httpx.Response(200, text=body,
                              headers={"content-type": "text/event-stream"})

    transport = httpx.MockTransport(handler)
    real_stream = httpx.stream

    def fake_stream(method, url, **kwargs):
        kwargs.pop("timeout", None)
        client = httpx.Client(transport=transport)
        return client.stream(method, url, **kwargs)

    monkeypatch.setattr(httpx, "stream", fake_stream)
    monkeypatch.setattr(llm, "_key_and_default_model", lambda: ("k", "m"))
    list(llm.stream([{"role": "user", "content": "hi"}],
                    max_tokens=10_000_000, operation="listening_preview"))
    assert real_stream is not httpx.stream  # the patch really took
    assert seen["max_tokens"] == 1_000, "stream must clamp like complete does"
