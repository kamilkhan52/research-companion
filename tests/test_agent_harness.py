"""agent_harness: the Pydantic AI tool-using turn. Driven by a FunctionModel so the FULL loop
(model asks for a tool -> tool executes against the real store -> its output is fed back ->
model writes the final answer) runs with zero network. Proves both that the tool actually ran
and that the result parses into a Turn via the existing text protocol."""
from __future__ import annotations

from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
from pydantic_ai.models.function import FunctionModel

from app import agent_harness
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
