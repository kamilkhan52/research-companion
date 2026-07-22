"""agent_harness: the Pydantic AI tool-using turn. Driven by a FunctionModel so the FULL loop
(model asks for a tool -> tool executes against the real store -> its output is fed back ->
model writes the final answer) runs with zero network. Proves both that the tool actually ran
and that the result parses into a Turn via the existing text protocol."""
from __future__ import annotations

import asyncio

from app import agent, agent_harness
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
from pydantic_ai.models.function import DeltaToolCall, FunctionModel

from tests.conftest import add_paper

_CANON = ("### CANONICAL ###\n"
          "The alpha method improves throughput, per Paper A.\n"
          "### STATE ###\nin_discussion\n### END ###")


def test_agentic_turn_runs_the_tool_loop(temp_project):
    add_paper(temp_project, "a", "Paper A", full_text="The alpha method improves throughput.")
    calls = {"n": 0}
    seen = {"tool_output": None}

    def model_fn(messages, info):
        calls["n"] += 1
        if calls["n"] == 1:
            # First turn: ask to read paper 'a'.
            return ModelResponse(parts=[ToolCallPart(tool_name="read_paper_text", args={"slug": "a"})])
        # Second turn: the tool result is now in the message history — capture it, then answer.
        for m in messages:
            for p in getattr(m, "parts", []):
                if type(p).__name__ == "ToolReturnPart":
                    seen["tool_output"] = str(getattr(p, "content", ""))
        return ModelResponse(parts=[TextPart(content=_CANON)])

    history = [{"role": "user", "content": "What does paper a say about throughput?"}]
    turn = agent_harness.run_turn_agentic("p", history, model=FunctionModel(model_fn))

    assert calls["n"] == 2  # model was re-invoked after the tool ran (i.e. a real loop)
    assert "alpha method" in (seen["tool_output"] or "")  # the tool executed and fed the model
    assert "alpha method improves throughput" in turn.canonical
    assert turn.state_signal == "in_discussion"


def test_agentic_turn_without_tools_still_parses(temp_project):
    # A model that never calls a tool must still produce a valid Turn (tools are optional).
    def model_fn(messages, info):
        return ModelResponse(parts=[TextPart(content=_CANON)])

    history = [{"role": "user", "content": "Just answer."}]
    turn = agent_harness.run_turn_agentic("p", history, model=FunctionModel(model_fn))
    assert "alpha method improves throughput" in turn.canonical


def test_agentic_is_on_by_default_with_an_explicit_off_switch():
    # R12.8: the tool loop is the product's turn path — without it no turn can search or
    # re-read the paper (the live web-search incident). RC_AGENTIC=0 restores single-shot.
    assert agent_harness.AGENTIC_ENABLED is True
    assert agent_harness._flag_enabled(None) is True
    assert agent_harness._flag_enabled("1") is True
    assert agent_harness._flag_enabled("0") is False
    assert agent_harness._flag_enabled("false") is False
    assert agent_harness._flag_enabled("no") is False


def test_streaming_emits_tool_then_text_then_final(temp_project):
    add_paper(temp_project, "a", "Paper A", full_text="The alpha method improves throughput.")
    state = {"n": 0}

    async def stream_fn(messages, info):
        state["n"] += 1
        if state["n"] == 1:
            yield {0: DeltaToolCall(name="read_paper_text", json_args='{"slug": "a"}', tool_call_id="1")}
        else:
            for chunk in ["### CANONICAL ###\n", "The alpha ", "method wins.\n",
                          "### STATE ###\nin_discussion\n### END ###"]:
                yield chunk

    fm = FunctionModel(function=lambda m, i: None, stream_function=stream_fn)

    async def _collect():
        out = []
        async for ev in agent_harness.stream_agentic_events(
            "a", [{"role": "user", "content": "tell me about a"}], model=fm):
            out.append(ev)
        return out

    events = asyncio.run(_collect())

    kinds = [e["type"] for e in events]
    assert kinds[0] == "tool" and kinds[-1] == "final"
    tool = next(e for e in events if e["type"] == "tool")
    assert tool["name"] == "read_paper_text" and tool["detail"] == "a"
    # The SSE layer extracts the canonical prefix from accumulated text deltas.
    text = "".join(e["text"] for e in events if e["type"] == "text")
    assert agent.canonical_prefix(text) == "The alpha method wins."


def test_streaming_marks_segment_boundaries_between_model_requests(temp_project):
    """R6.8 — a 'segment' event separates each model request: text before the boundary is
    pre-tool commentary (activity trail), text after it is the answer."""
    add_paper(temp_project, "a", "Paper A", full_text="The alpha method improves throughput.")
    state = {"n": 0}

    async def stream_fn(messages, info):
        state["n"] += 1
        if state["n"] == 1:
            yield "Let me read the paper first."
            yield {0: DeltaToolCall(name="read_paper_text", json_args='{"slug": "a"}', tool_call_id="1")}
        else:
            yield "### CANONICAL ###\nThe answer.\n### STATE ###\nin_discussion\n### END ###"

    fm = FunctionModel(function=lambda m, i: None, stream_function=stream_fn)

    async def _collect():
        out = []
        async for ev in agent_harness.stream_agentic_events(
            "a", [{"role": "user", "content": "tell me about a"}], model=fm):
            out.append(ev)
        return out

    events = asyncio.run(_collect())
    kinds = [e["type"] for e in events]

    assert kinds.count("segment") == 1
    boundary = kinds.index("segment")
    assert boundary > kinds.index("text")  # commentary streamed before the boundary
    pre = "".join(e["text"] for e in events[:boundary] if e["type"] == "text")
    post = "".join(e["text"] for e in events[boundary:] if e["type"] == "text")
    assert pre == "Let me read the paper first."
    assert agent.canonical_prefix(post) == "The answer."


# ---- R12.8 hardening: caps, usage metering, single-shot fallback -----------------------------

def test_turn_request_limit_is_capped():
    # A looping model can't run unbounded — the per-turn request cap is enforced.
    assert agent_harness._USAGE_LIMITS.request_limit == agent_harness.AGENT_REQUEST_LIMIT
    assert agent_harness.AGENT_REQUEST_LIMIT <= 20


def test_agentic_turn_falls_back_to_single_shot_on_tool_failure(temp_project, monkeypatch):
    # A model that can't tool-call (raises) must degrade to the single-shot analyst, not fail.
    add_paper(temp_project, "a", "Paper A", full_text="text")

    def exploding_model(messages, info):
        raise RuntimeError("provider rejected the tool schema")

    called = {}

    def fake_single_shot(slug, history, model=None):
        called["slug"] = slug
        return agent.Turn(role="assistant", canonical="single-shot answer",
                          state_signal="in_discussion")

    monkeypatch.setattr(agent, "run_turn", fake_single_shot)
    history = [{"role": "user", "content": "What does paper a say?"}]
    turn = agent_harness.run_turn_agentic("a", history, model=FunctionModel(exploding_model))

    assert called["slug"] == "a"
    assert turn.canonical == "single-shot answer"


def test_looping_model_hits_the_request_cap_then_falls_back(temp_project, monkeypatch):
    add_paper(temp_project, "a", "Paper A", full_text="The alpha method improves throughput.")

    # Never answers — always asks to read the paper again. The request cap must stop it.
    def looping_model(messages, info):
        return ModelResponse(parts=[ToolCallPart(tool_name="read_paper_text", args={"slug": "a"})])

    fell_back = {}
    monkeypatch.setattr(agent, "run_turn", lambda slug, history, model=None: fell_back.setdefault(
        "hit", agent.Turn(role="assistant", canonical="fallback", state_signal="in_discussion")))
    recorded = []
    monkeypatch.setattr(agent_harness.usage, "record",
                        lambda op, model, u: recorded.append(u))

    turn = agent_harness.run_turn_agentic("a", [{"role": "user", "content": "go"}],
                                          model=FunctionModel(looping_model))
    assert turn.canonical == "fallback"  # cap tripped → fallback, not an unbounded loop
    # The requests it DID make before the cap are metered even though the run failed.
    assert recorded and recorded[0]["total_tokens"] > 0


def test_agentic_turn_records_token_usage(temp_project, monkeypatch):
    add_paper(temp_project, "a", "Paper A", full_text="text")
    recorded = []
    monkeypatch.setattr(agent_harness.usage, "record",
                        lambda op, model, u: recorded.append((op, u)))

    def model_fn(messages, info):
        return ModelResponse(parts=[TextPart(content=_CANON)])

    agent_harness.run_turn_agentic("a", [{"role": "user", "content": "q"}],
                                   model=FunctionModel(model_fn))
    assert recorded and recorded[0][0] == "analysis"
    assert recorded[0][1]["total_tokens"] > 0


def test_stream_fallback_resets_and_delegates_to_single_shot():
    async def failing_agentic():
        yield {"type": "text", "text": "Let me search…"}  # partial pre-answer text
        raise agent_harness.agent_mod.AgentError("tool schema rejected")

    def single_shot():
        yield {"type": "text", "text": "the real answer"}
        yield {"type": "final", "text": "the real answer"}

    async def _collect():
        return [ev async for ev in agent_harness.stream_with_single_shot_fallback(
            failing_agentic, single_shot)]

    events = asyncio.run(_collect())
    kinds = [e["type"] for e in events]
    assert "segment" in kinds  # consumer told to demote the partial agentic text
    assert kinds.index("segment") < kinds.index("final")
    final = next(e for e in events if e["type"] == "final")
    assert final["text"] == "the real answer"


def test_stream_fallback_does_not_fire_after_a_final():
    # A failure AFTER the answer landed has nothing to recover — it must propagate.
    async def agentic_then_error():
        yield {"type": "text", "text": "answer"}
        yield {"type": "final", "text": "answer"}
        raise agent_harness.agent_mod.AgentError("late error")

    def single_shot():  # must never run
        raise AssertionError("single-shot must not run once a final was produced")
        yield  # pragma: no cover

    async def _collect():
        out = []
        try:
            async for ev in agent_harness.stream_with_single_shot_fallback(
                    agentic_then_error, single_shot):
                out.append(ev)
        except agent_harness.agent_mod.AgentError:
            out.append({"type": "raised"})
        return out

    events = asyncio.run(_collect())
    assert events[-1]["type"] == "raised"
    assert any(e["type"] == "final" for e in events)


def _usage_obj(input_tokens=0, output_tokens=0, requests=0):
    return type("U", (), {"input_tokens": input_tokens,
                          "output_tokens": output_tokens, "requests": requests})()


def _capture_usage(monkeypatch):
    recorded, pending = [], []
    monkeypatch.setattr(agent_harness.usage, "record",
                        lambda op, model, u: recorded.append(u))
    monkeypatch.setattr(agent_harness.usage, "record_pending",
                        lambda op, model, gid: pending.append((op, gid)))
    return recorded, pending


def test_billed_run_flags_estimated_because_cost_is_unavailable(temp_project, monkeypatch):
    # OpenRouter's dollar cost is not surfaced through Pydantic AI, so ANY billed agentic run
    # records its exact tokens AND a pending (cost-unknown) marker — so totals read estimated
    # rather than implying an exact $0 (sol review rounds 3-5).
    recorded, pending = _capture_usage(monkeypatch)
    agent_harness._record_run_usage(
        _usage_obj(input_tokens=100, output_tokens=40, requests=3), None, "analysis")
    assert recorded and recorded[0]["total_tokens"] == 140
    assert pending == [("analysis", None)]


def test_billed_run_without_token_counts_still_records_a_pending_marker(temp_project, monkeypatch):
    # A billed request whose token counts never arrived (interrupted mid-request) records no
    # token aggregate but still a pending marker, so it isn't invisible.
    recorded, pending = _capture_usage(monkeypatch)
    agent_harness._record_run_usage(_usage_obj(requests=1), None, "analysis")
    assert recorded == []
    assert pending == [("analysis", None)]


def test_zero_request_run_records_nothing(temp_project, monkeypatch):
    # A run that never issued a request (nothing billed) records neither an aggregate nor a
    # pending marker.
    recorded, pending = _capture_usage(monkeypatch)
    agent_harness._record_run_usage(_usage_obj(requests=0), None, "analysis")
    assert recorded == [] and pending == []
