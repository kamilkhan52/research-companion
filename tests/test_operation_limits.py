"""Per-call ceilings on completion size and attempt duration.

The monthly spend ceiling bounds an ACCOUNT. This bounds one CALL, which is a different failure:
a runaway or prompt-influenced request for an enormous completion is spent in a single shot, long
before a monthly ledger notices. The two must not be confused for each other.
"""
from __future__ import annotations

import json

import pytest
from app import llm, operation_limits


def _agentic_request_limits() -> dict[str, int]:
    """Every agentic path's request budget, read from the production constants.

    Hardcoding 12/10/12/7 here matched today and would keep matching after someone halved a
    production constant — leaving both ceiling tests asserting a bound nothing uses.
    """
    from app import agent_harness, lab_research, preview_jobs, retrieval_agent

    return {
        "analysis": agent_harness.AGENT_REQUEST_LIMIT,
        "lab_research": lab_research.MAX_AGENT_REQUESTS,
        "retrieval_hunt": retrieval_agent.MAX_HUNT_REQUESTS,
        "listening_preview_research": preview_jobs.MAX_RESEARCH_AGENT_REQUESTS,
    }


_AGENTIC_REQUEST_LIMITS = _agentic_request_limits()


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
    from app import affiliations, agent, author_profiles, discovery, graph, preview_jobs

    return [
        ("analysis", agent.ANALYSIS_MAX_TOKENS),
        ("notes", agent.NOTES_MAX_TOKENS),
        ("graph_extraction", graph.EXTRACTION_MAX_TOKENS),
        ("discovery", discovery.SCORING_MAX_TOKENS),
        ("discovery", discovery.QUERIES_MAX_TOKENS),
        ("discovery_screen", discovery.TITLE_TRIAGE_MAX_TOKENS),
        ("discovery_screen", discovery.ABSTRACT_SCORING_MAX_TOKENS),
        ("listening_preview", preview_jobs.CUE_MAX_TOKENS),
        ("affiliations", affiliations.AFFILIATION_MAX_TOKENS),
        ("author_profile", author_profiles.PROFILE_MAX_TOKENS),
    ]


@pytest.mark.parametrize("operation,needs", _real_budgets())
def test_every_ceiling_clears_what_that_operation_actually_asks_for(operation, needs):
    """A ceiling below real use would truncate paid work — worse than not having one, because the
    call is billed either way and the result is unusable."""
    assert operation_limits.clamp_tokens(operation, needs) == needs, (
        f"{operation}'s ceiling is below the {needs} tokens its caller requests"
    )


def test_the_lab_research_agent_bounds_its_output_too():
    """The other Pydantic AI path. Built purely inline it was untestable, and reverting the bound
    left the whole suite green — the same gap this round closed for `agent_harness`."""
    from app import lab_research

    assert lab_research._OUTPUT_TOKENS_LIMIT == operation_limits.run_output_ceiling(
        "lab_research", lab_research.MAX_AGENT_REQUESTS,
    ), "it must read the shared table, not carry a second set of numbers"


def test_the_agentic_turn_has_a_per_request_cap_not_only_a_run_level_abort():
    """`output_tokens_limit` aborts a run that has already generated; `max_tokens` stops
    generation at the ceiling. The raw client has always had the latter; the agentic path had
    neither until this slice, and only the run-level abort until this fix."""
    import ast
    import inspect

    from app import agent_harness

    tree = ast.parse(inspect.getsource(agent_harness))
    settings = [
        node for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and getattr(node.func, "id", getattr(node.func, "attr", None)) == "OpenRouterModelSettings"
    ]
    assert settings, "expected the agentic model settings to be constructed here"
    assert any(kw.arg == "max_tokens" for call in settings for kw in call.keywords), (
        "the agentic path must cap each request, not only abort the run after the fact"
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
    assert limits.output_tokens_limit == operation_limits.run_output_ceiling(
        "analysis", agent_harness.AGENT_REQUEST_LIMIT
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


def test_the_run_level_output_ceiling_can_actually_fire():
    """It used to be exactly `tokens_for(op) * request_limit` — the precise total that
    `request_limit` maximal responses produce. pydantic-ai raises on `>`, not `>=`, so the sum
    could equal the limit but never exceed it: `request_limit` always tripped first and the
    backstop was unreachable by construction. The tests asserted that same product, so they
    asserted the tautology."""
    from app import operation_limits

    for operation, request_limit in _AGENTIC_REQUEST_LIMITS.items():
        per_request = operation_limits.tokens_for(operation)
        ceiling = operation_limits.run_output_ceiling(operation, request_limit)
        assert ceiling < per_request * request_limit, (
            f"{operation}'s run ceiling equals its own maximum and can never be exceeded"
        )
        # And it must bind late enough to be a backstop rather than a second request limit.
        fires_at = ceiling // per_request + 1
        assert 2 < fires_at <= request_limit, (
            f"{operation} aborts at request {fires_at} of {request_limit}"
        )


def test_the_run_ceiling_clears_real_observed_output_by_a_wide_margin():
    """A bound sized below what the feature actually produces is a new defect, not a fix.

    The numbers on the right are measured from Kamil's own usage ledgers (2026-08-08): the mean
    analysis call emits 3,732 completion tokens, labs writes one line, and the preview research
    pass is capped at 6,000 characters. Asserting a MARGIN rather than the exact fraction means
    re-tuning `_RUN_OUTPUT_FRACTION` is safe but shrinking it past what the app really emits is not.
    """
    from app import operation_limits

    observed_per_request = {
        "analysis": 3_732,
        "lab_research": 600,
        "listening_preview_research": 1_500,
        "retrieval_hunt": 600,
    }
    for operation, per_request in observed_per_request.items():
        limit = _AGENTIC_REQUEST_LIMITS[operation]
        ceiling = operation_limits.run_output_ceiling(operation, limit)
        expected_run = per_request * limit
        assert ceiling > expected_run * 2, (
            f"{operation}'s ceiling ({ceiling}) leaves no margin over a typical run "
            f"({expected_run}); a normal run would abort"
        )


def test_the_preview_research_run_ceiling_reaches_its_usage_limits():
    """Built inline it was deletable with the whole suite green, which is why it is at module
    scope — the same hoist `lab_research._OUTPUT_TOKENS_LIMIT` already had."""
    from app import operation_limits, preview_jobs

    assert preview_jobs._RESEARCH_OUTPUT_TOKENS_LIMIT == operation_limits.run_output_ceiling(
        "listening_preview_research", preview_jobs.MAX_RESEARCH_AGENT_REQUESTS,
    )
    import ast
    import inspect

    src = inspect.getsource(preview_jobs._research_with_agent)
    passed = [
        kw.value.id for node in ast.walk(ast.parse(src.lstrip()))
        if isinstance(node, ast.Call)
        for kw in node.keywords
        if kw.arg == "output_tokens_limit" and isinstance(kw.value, ast.Name)
    ]
    assert "_RESEARCH_OUTPUT_TOKENS_LIMIT" in passed, (
        "the research run must pass its output ceiling to UsageLimits"
    )
