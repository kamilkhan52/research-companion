"""Paid work that reached neither the ledger nor the ceiling.

Three paths recorded token counts with no cost, or nothing at all, while holding budget — so they
settled at exactly zero however much they really spent. The failure is silent by construction: a
job that charges nothing looks identical to a job that was cheap.

The tests here assert the PROPERTY (money reaches the hold) by driving the real code over a
`FunctionModel`, rather than asserting the source text says the right thing. An earlier version of
this file did the latter and passed while all three paths recorded nothing.
"""
from __future__ import annotations

import asyncio

from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.usage import RequestUsage


def _openrouter_response(cost: float, *, gen_id: str = "gen-abc123") -> ModelResponse:
    """A response shaped the way the real OpenRouter model returns one.

    `record_agent_run` only reads an authoritative dollar cost from responses whose
    `provider_name` is `openrouter`; the cost lives in `provider_details`, not in `RunUsage`.
    """
    return ModelResponse(
        parts=[TextPart("could not find it")],
        usage=RequestUsage(input_tokens=100, output_tokens=20),
        model_name="deepseek/deepseek-v4-flash-0731",
        provider_name="openrouter",
        provider_details={"cost": cost},
        provider_response_id=gen_id,
    )


def test_pydantic_ai_exposes_usage_as_a_property_not_a_method():
    """The single fact three call sites got wrong, pinned so an upgrade cannot re-break it quietly.

    `result.usage()` raised TypeError. In `lab_research` that landed inside the run's own `try`,
    so every author in every labs pass failed AFTER the run had been paid for — which is why the
    Labs view had nothing lab-specific to show. In `preview_jobs` it raised before returning, so
    every preview research run was paid for and discarded. The suite missed it because the one test
    driving those functions mocked `usage()` as a staticmethod: it mocked the broken API into
    looking correct.
    """
    from pydantic_ai.agent import AgentRun, AgentRunResult

    assert isinstance(AgentRunResult.usage, property), (
        "usage is a property; calling it raises TypeError and, in lab_research, fails the run"
    )
    assert isinstance(AgentRun.usage, property)


def test_the_hunt_charges_its_reservation_what_the_provider_actually_billed(monkeypatch):
    """The property this whole change exists for: money the hunt spends reaches the HOLD.

    Fails against every earlier shape of this code — `result.usage()` raised, `run.result is not
    None` skipped the success path, and `messages=None` recorded tokens with no cost so the
    reservation settled at exactly zero.
    """
    from app import retrieval_agent, spend_ceiling

    noted: list[int] = []
    monkeypatch.setattr(spend_ceiling, "note_spend", noted.append)

    async def drain():
        model = FunctionModel(lambda m, i: _openrouter_response(0.0042))
        return [event async for event in retrieval_agent.stream_hunt("A Paper", model=model)]

    asyncio.run(drain())

    # $0.0042 -> nano-USD. A tokens-only record leaves this [0], which is exactly what settling at
    # zero looked like from the ledger's side.
    assert noted == [4_200_000], f"the hunt charged {noted} rather than what it was billed"


def test_the_hunt_still_charges_for_a_run_that_failed_partway(monkeypatch):
    """A hunt that dies on a later candidate has still paid for the generations before it.

    Recording only on the happy path meters the cheap case and forgives the expensive one — and
    the hunt's `except` exists precisely because failing partway is an ordinary outcome.

    The first response must be a TOOL CALL, not text: a text response ends the run then and there,
    so a model that "raises on its second call" is never called twice and the failure never
    happens. An earlier version of this test did exactly that and passed on a run that succeeded,
    because `ok` is also False when no PDF was found.
    """
    from app import research_tools, retrieval_agent, spend_ceiling

    noted: list[int] = []
    monkeypatch.setattr(spend_ceiling, "note_spend", noted.append)
    monkeypatch.setattr(research_tools, "web_search",
                        lambda *a, **k: "1. A Paper — https://example.com/a.pdf")
    calls = {"n": 0}

    def respond(messages, info):
        calls["n"] += 1
        if calls["n"] > 1:
            raise RuntimeError("provider 503")
        return ModelResponse(
            parts=[ToolCallPart("web_search",
                                {"objective": "find it", "search_queries": ["a paper"]})],
            usage=RequestUsage(input_tokens=50, output_tokens=10),
            model_name="m",
            provider_name="openrouter",
            provider_details={"cost": 0.001},
            provider_response_id="gen-1",
        )

    async def drain():
        return [event async for event in
                retrieval_agent.stream_hunt("A Paper", model=FunctionModel(respond))]

    events = asyncio.run(drain())

    assert calls["n"] == 2, "the run must actually fail on a later request, not end early"
    assert events[-1]["ok"] is False, "the failure must still surface to the caller"
    assert noted == [1_000_000], (
        f"a hunt that failed partway charged {noted}; the generation it paid for went unbilled"
    )


def test_the_hunt_is_bounded_on_requests_and_tool_calls(monkeypatch):
    """It was the one agentic path with no `UsageLimits` at all, inheriting pydantic-ai's default
    `request_limit=50` and NO tool-call limit — the loosest budget in the app sitting behind the
    cheapest hold.

    Asserts the limits reach `ag.iter`. An earlier version asserted the shape of the `_HUNT_LIMITS`
    constant, and stayed green with `usage_limits=` deleted from the real call — the table-not-the
    -wiring failure this file complains about two tests down.
    """
    from app import retrieval_agent, spend_ceiling

    monkeypatch.setattr(spend_ceiling, "note_spend", lambda n: None)
    seen: list = []
    real_iter = retrieval_agent.Agent.iter

    def spy(self, *args, **kwargs):
        seen.append(kwargs.get("usage_limits"))
        return real_iter(self, *args, **kwargs)

    monkeypatch.setattr(retrieval_agent.Agent, "iter", spy)

    async def drain():
        model = FunctionModel(lambda m, i: _openrouter_response(0.0001))
        return [e async for e in retrieval_agent.stream_hunt("A Paper", model=model)]

    asyncio.run(drain())

    assert seen and seen[0] is not None, "the hunt ran with no usage limits at all"
    limits = seen[0]
    assert limits.request_limit, "no request limit: pydantic-ai's default of 50 applies"
    assert limits.tool_calls_limit, "no tool-call limit"
    assert limits.output_tokens_limit
    # Above what the prompt asks for (a search or two, up to 5 URLs, a final answer), or a hunt
    # doing exactly what it was told trips our ceiling and gets told the provider failed.
    assert limits.request_limit >= 10, "tighter than the hunt's own prompt budget"


def test_our_own_request_ceiling_is_not_reported_as_a_provider_failure(monkeypatch):
    """A tripped limit is our decision, not the provider's. Saying otherwise sends the reader
    chasing an outage that never happened."""
    from app import retrieval_agent, spend_ceiling
    from pydantic_ai.exceptions import UsageLimitExceeded

    monkeypatch.setattr(spend_ceiling, "note_spend", lambda n: None)

    def blow_up(self, *args, **kwargs):
        raise UsageLimitExceeded("exceeded the request_limit")

    monkeypatch.setattr(retrieval_agent.Agent, "iter", blow_up)

    async def drain():
        model = FunctionModel(lambda m, i: _openrouter_response(0.0001))
        return [e async for e in retrieval_agent.stream_hunt("A Paper", model=model)]

    events = asyncio.run(drain())

    assert events[-1]["ok"] is False
    assert "provider" not in events[-1]["summary"].lower(), events[-1]["summary"]


def test_each_agentic_path_is_capped_at_its_own_budget_not_the_analysis_one(monkeypatch):
    """`_openrouter_model` set `max_tokens` from `tokens_for("analysis")` for every caller, so the
    hunt, lab research and preview research each declared a budget an order of magnitude smaller
    and were silently handed the analysis ceiling instead — the table read as if it bound them
    while binding nothing.

    Asserts the WIRING, not the table. Checking only that the table holds smaller numbers passes
    even when nothing reads them, which is the state this fixes.
    """
    from app import agent_harness, config, operation_limits, spend_control

    monkeypatch.setattr(spend_control, "require_enabled", lambda: None)
    monkeypatch.setattr(config, "load_settings",
                        lambda: {"openrouter_api_key": "sk-test", "model": "test/model"})

    analysis = operation_limits.tokens_for("analysis")
    for operation in ("retrieval_hunt", "lab_research", "listening_preview_research"):
        model = agent_harness._openrouter_model(operation=operation)
        cap = model.settings.get("max_tokens")
        assert cap == operation_limits.tokens_for(operation), (
            f"{operation} was built with max_tokens={cap}, not its own declared ceiling"
        )
        assert cap < analysis, f"{operation} should be capped below an analysis turn"

    default_model = agent_harness._openrouter_model()
    assert default_model.settings.get("max_tokens") == analysis, (
        "the analysis path must keep its own ceiling"
    )


def test_the_three_paths_read_the_usage_property_and_record_through_the_harness():
    """A backstop for the two paths without a behavioural test of their own.

    Parsed rather than grepped: a string search for `.usage()` matches the comment explaining the
    bug as readily as the bug itself, and would keep failing after the fix.
    """
    import ast
    import inspect

    from app import lab_research, preview_jobs, retrieval_agent

    for module in (lab_research, preview_jobs, retrieval_agent):
        src = inspect.getsource(module)
        called_usage = [
            n for n in ast.walk(ast.parse(src))
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
            and n.func.attr == "usage"
        ]
        assert not called_usage, (
            f"{module.__name__} calls usage() as a method; it is a property and this raises"
        )
        # Called, not merely mentioned — the earlier version accepted a substring, which a comment
        # satisfies.
        records = [
            n for n in ast.walk(ast.parse(src))
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
            and n.func.attr == "record_agent_run"
        ]
        assert records, f"{module.__name__} must record through the harness recorder"
        # And with messages: the no-messages branch cannot see a dollar cost, so a call passing
        # None records tokens that settle at zero.
        for call in records:
            assert len(call.args) >= 4 and not isinstance(call.args[3], ast.Constant), (
                f"{module.__name__} must pass the run's messages; without them the recorder "
                "cannot read the provider's authoritative cost and the reservation settles at zero"
            )


def test_the_preview_research_pass_is_not_capped_at_the_cue_budget(monkeypatch):
    """A cue is one 180-token line; the research pass behind it returns up to 6,000 characters of
    sourced findings. They are different operations and were briefly given the same ceiling, which
    would have truncated the research output — a new defect dressed as a bound.

    Asserts what `_research_with_agent` ACTUALLY builds its model with. Checking only that the
    table holds a bigger number passes while the call site still asks for the cue's budget.
    """
    from app import agent_harness, operation_limits, preview_jobs

    asked: list[str] = []

    def capture(model_id=None, operation="analysis"):
        asked.append(operation)
        return FunctionModel(lambda m, i: _openrouter_response(0.0001))

    monkeypatch.setattr(agent_harness, "_openrouter_model", capture)
    monkeypatch.setattr(preview_jobs, "resolve_model", lambda settings=None: "test/model")

    preview_jobs._research_with_agent("A Paper", "metadata")

    assert asked == ["listening_preview_research"], (
        f"the research pass built its model as {asked}, so it inherits the cue's ceiling"
    )
    research_cap = operation_limits.tokens_for("listening_preview_research")
    assert research_cap >= preview_jobs.MAX_GROUNDED_SOURCE_CHARS / 4, (
        "the research cap must fit the characters the function promises to return"
    )
    assert research_cap > operation_limits.tokens_for("listening_preview")
