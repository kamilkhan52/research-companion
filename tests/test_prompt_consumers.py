"""Every model-facing behavioral instruction resolves through the live prompt registry."""
from __future__ import annotations

from app import agent, agent_harness, graph, retrieval_agent


def test_agent_harness_resolves_both_tool_guidance_prompts(monkeypatch):
    captured = []

    def fake_agent(model, **kwargs):
        captured.append(kwargs)
        return object()

    monkeypatch.setattr(agent_harness, "Agent", fake_agent)
    monkeypatch.setattr(
        agent_harness.agent_mod,
        "_system_for",
        lambda slug, latest_user_text="": "analysis system",
    )
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
    assert captured[1]["system_prompt"] == (
        "live notes editor\n\n" + agent.MATH_MARKDOWN_CONTRACT + "\n\nlive notes guidance"
    )


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


def test_analysis_and_narration_compose_self_contained_guidance(monkeypatch):
    values = {
        "analysis_system": "analysis instructions",
        "narration_system": "narration instructions",
        "self_contained_research": "describe every referenced item in place",
    }
    monkeypatch.setattr(agent.prompts, "get", values.__getitem__)
    monkeypatch.setattr(agent.assembler, "build_context", lambda slug: "paper context")

    system = agent._system_for("paper")
    assert system.startswith("analysis instructions\n\nMath formatting contract:")
    assert "TeX inline math as `\\( ... \\)`" in system
    assert "display math as `\\[ ... \\]`" in system
    assert "Do not use single-dollar delimiters" in system
    assert "describe every referenced item in place" in system

    captured = {}
    monkeypatch.setattr(agent.config, "load_settings", lambda: {"model": "model"})

    def fake_complete(messages, **kwargs):
        captured["messages"] = messages
        return "spoken response"

    monkeypatch.setattr(agent, "_complete", fake_complete)
    assert agent.narrate("written response") == "spoken response"
    assert captured["messages"][0]["content"] == (
        "narration instructions\n\ndescribe every referenced item in place"
    )


def test_explicit_figure_request_adds_availability_layer(monkeypatch):
    values = {
        "analysis_system": "analysis instructions",
        "self_contained_research": "self-contained",
    }
    monkeypatch.setattr(agent.prompts, "get", values.__getitem__)
    monkeypatch.setattr(agent.assembler, "build_context", lambda slug: "paper context")
    monkeypatch.setattr(agent.sessions, "get_reading_mode", lambda slug: "balanced")

    monkeypatch.setattr(agent.figures, "manifest_for", lambda slug: None)
    unavailable = agent._system_for("paper", "Please show me the important figures.")
    assert "EXPLICIT FIGURE-DISPLAY REQUEST" in unavailable
    assert "Figures are not available for this paper" in unavailable

    monkeypatch.setattr(agent.figures, "manifest_for", lambda slug: {
        "status": "done",
        "figures": [{"number": 2}, {"number": 4}, {"number": None}],
    })
    available = agent._system_for("paper", "Include the figures in your response.")
    assert "ONLY these labels: Figure 2, Figure 4" in available
    assert "available below" in available


def test_implicit_figure_discussion_has_no_availability_layer(monkeypatch):
    assert agent.explicit_figure_display_request("Let's discuss the important figures.") is False
    assert agent.explicit_figure_display_request("Explain the data in Figure 3.") is False
    # Discussion questions about a visual are not display requests (sol review, PR #201).
    assert agent.explicit_figure_display_request("What does Figure 3 show?") is False
    assert agent.explicit_figure_display_request(
        "Why did the authors include this chart?"
    ) is False
    # Negation must never read as a request.
    assert agent.explicit_figure_display_request("Do not show any figures.") is False
    assert agent.explicit_figure_display_request("Please show no figures.") is False
    assert agent.explicit_figure_display_request("Can you show no figures this time?") is False
    # An interrogative complement is a question about the figure, not a display request.
    assert agent.explicit_figure_display_request(
        "Can you show how Figure 3 supports the claim?"
    ) is False
    assert agent.explicit_figure_display_request(
        "Can I see why the plots disagree?"
    ) is False
    assert agent.explicit_figure_display_request("Show me Figure 3.") is True
    assert agent.explicit_figure_display_request("Can I see the figures?") is True
    assert agent.explicit_figure_display_request("Please include the figures.") is True
    assert agent.explicit_figure_display_request("Can you show the figures here?") is True
    assert agent.explicit_figure_display_request(
        "What figures are the most important and can you show me here?"
    ) is True
    assert agent.explicit_figure_display_request(
        "Let's review all the figures. Include them here."
    ) is True

    monkeypatch.setattr(agent.prompts, "get", lambda key: key)
    monkeypatch.setattr(agent.assembler, "build_context", lambda slug: "paper context")
    monkeypatch.setattr(agent.sessions, "get_reading_mode", lambda slug: "balanced")
    system = agent._system_for("paper", "Let's discuss the important figures.")
    assert "EXPLICIT FIGURE-DISPLAY REQUEST" not in system


def test_prompts_instruct_linking_web_found_papers():
    """U.7: external papers the agent finds on the web must arrive as tappable markdown links
    (the app turns them into an open-or-add sheet). Pin the instruction in both the analysis
    system prompt and the agentic tool guidance so a prompt edit can't silently drop it."""
    from app import prompts

    analysis = prompts.get("analysis_system")
    assert "arxiv.org/abs" in analysis
    assert "Never fabricate a URL" in analysis

    guidance = prompts.get("analyst_tool_guidance")
    assert "markdown link" in guidance
    assert "arxiv.org/abs" in guidance
