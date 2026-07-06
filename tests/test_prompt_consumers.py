"""Every model-facing behavioral instruction resolves through the live prompt registry."""
from __future__ import annotations

from app import agent_harness, graph, retrieval_agent


def test_agent_harness_resolves_both_tool_guidance_prompts(monkeypatch):
    captured = []

    def fake_agent(model, **kwargs):
        captured.append(kwargs)
        return object()

    monkeypatch.setattr(agent_harness, "Agent", fake_agent)
    monkeypatch.setattr(agent_harness.agent_mod, "_system_for", lambda slug: "analysis system")
    monkeypatch.setattr(
        agent_harness.prompts,
        "get",
        lambda key: {
            "analyst_tool_guidance": "live analyst guidance",
            "notes_editor": "live notes editor",
            "notes_tool_guidance": "live notes guidance",
        }[key],
    )

    model = object()
    agent_harness.build_agent("paper", model=model)
    agent_harness.build_notes_editor(model=model)

    assert captured[0]["system_prompt"] == "analysis system\n\nlive analyst guidance"
    assert captured[1]["system_prompt"] == "live notes editor\n\nlive notes guidance"


def test_retrieval_hunt_resolves_and_renders_registry_prompt(monkeypatch):
    captured = {}

    def fake_agent(model, **kwargs):
        captured.update(kwargs)
        return object()

    monkeypatch.setattr(retrieval_agent, "Agent", fake_agent)
    monkeypatch.setattr(
        retrieval_agent.prompts,
        "render",
        lambda key, **subs: f"{key}: {subs['title']}",
    )

    retrieval_agent.build_hunt_agent("A Paper", {}, model=object())
    assert captured["system_prompt"] == "retrieval_hunt: A Paper"


def test_graph_extraction_resolves_registry_system_prompt(monkeypatch):
    captured = {}
    monkeypatch.setattr(graph.config, "load_settings", lambda: {"openrouter_api_key": "test"})
    monkeypatch.setattr(graph.prompts, "get", lambda key: f"live {key} prompt")
    monkeypatch.setattr(graph, "_call_with_deadline", lambda fn, deadline: fn())

    def fake_complete(messages, **kwargs):
        captured["messages"] = messages
        return '{"references": [{"title": "Cited Work"}]}'

    monkeypatch.setattr(graph.llm, "complete", fake_complete)
    result = graph.extract_references_for_paper("paper", "A Paper", "full text", "model")

    assert result["status"] == "done"
    assert captured["messages"][0] == {
        "role": "system",
        "content": "live graph_extraction prompt",
    }
