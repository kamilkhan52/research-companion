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


def test_agentic_is_off_by_default():
    # Safety: the new path must not activate unless explicitly enabled.
    assert agent_harness.AGENTIC_ENABLED is False


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
