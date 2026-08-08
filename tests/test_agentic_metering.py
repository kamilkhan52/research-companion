"""Paid work that reached neither the ledger nor the ceiling.

Three paths recorded token counts with no cost, or nothing at all, while holding budget — so they
settled at exactly zero however much they really spent. The failure is silent by construction: a
job that charges nothing looks identical to a job that was cheap.
"""
from __future__ import annotations

from types import SimpleNamespace


class _Usage(SimpleNamespace):
    """Stands in for Pydantic AI's RunUsage."""


def test_pydantic_ai_exposes_usage_as_a_property_not_a_method():
    """The single fact three call sites got wrong, pinned so an upgrade cannot re-break it quietly.

    `result.usage()` raised TypeError. In `lab_research` that landed inside the run's own `try`,
    so every author in every labs pass failed AFTER the run had been paid for — which is why the
    Labs view had nothing lab-specific to show. In `preview_jobs` it raised before returning, so
    every preview research run was paid for and discarded. The suite missed it because the one
    test driving those functions mocked `usage()` as a staticmethod: it mocked the broken API into
    looking correct.
    """
    from pydantic_ai.agent import AgentRunResult

    assert isinstance(AgentRunResult.usage, property), (
        "usage is a property; calling it raises TypeError and, in lab_research, fails the run"
    )


def test_a_real_agent_run_records_usage_through_the_harness_recorder(monkeypatch):
    """Drive an actual Agent rather than a fake shaped to agree with us."""
    import asyncio

    from app import agent_harness
    from pydantic_ai import Agent
    from pydantic_ai.messages import ModelResponse, TextPart
    from pydantic_ai.models.function import FunctionModel

    recorded: list[tuple] = []
    monkeypatch.setattr(agent_harness, "_record_run_usage",
                        lambda usage_, model, op, msgs=None: recorded.append((op, usage_)))

    agent = Agent(FunctionModel(lambda m, i: ModelResponse(parts=[TextPart("done")])))
    result = asyncio.run(agent.run("go"))
    agent_harness._record_run_usage(result.usage, agent.model, "lab_research",
                                    result.all_messages())

    assert recorded and recorded[0][0] == "lab_research"
    assert recorded[0][1].output_tokens >= 0, "a real RunUsage, not a stand-in"


def test_the_three_paths_read_the_usage_property_not_a_call():
    """Pin the call sites. The previous version of this test grepped for a function NAME, so it
    passed while all three paths were recording nothing — a string in unreachable code."""
    import ast
    import inspect

    from app import lab_research, preview_jobs, retrieval_agent

    for module in (lab_research, preview_jobs, retrieval_agent):
        src = inspect.getsource(module)
        tree = ast.parse(src)
        # Parsed, not grepped: a string search matches the comment explaining the bug as readily
        # as the bug, and would keep failing after the fix.
        called_usage = [
            n for n in ast.walk(tree)
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
            and n.func.attr == "usage"
        ]
        assert not called_usage, (
            f"{module.__name__} calls usage() as a method; it is a property and this raises"
        )
        assert "_record_run_usage" in src, (
            f"{module.__name__} must record through the harness recorder rather than a second, "
            "weaker accounting path"
        )


def test_the_hunt_does_not_gate_recording_on_a_result_that_is_none_on_success():
    """`stream_hunt` breaks out of the loop the moment the paper is found, so the graph never
    emits an End node and `run.result` is None precisely on the success path. Gating on it skipped
    the only case worth recording."""
    import inspect

    from app import retrieval_agent

    src = inspect.getsource(retrieval_agent)
    assert "run.result is not None" not in src, "that guard skips the successful hunt"
    assert "run.usage" in src, "usage is on the run, and survives an early break"
