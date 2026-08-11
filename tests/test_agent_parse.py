"""The analysis-response section parser must survive marker drift: models on long
draft-notes turns emit markdown headings ("## CANONICAL", "# NOTES_BLOCK") instead of the
protocol's "###NAME###", sometimes with a preamble and sections out of order. Losing the
parse silently strands the paper in in_discussion (the exact bug seen with Orca /
DeepSpeed-Inference finish turns)."""
from app import agent

PROTOCOL = """###CANONICAL###
The scholarly answer.
###STATE###
ready_to_draft_notes
###COMMIT_SUMMARY###
Read the paper.
###NOTES_BLOCK###
## Notes
Key findings.
###SYNTHESIS###
The whole synthesis.
###END###"""


def test_protocol_markers_parse():
    t = agent.parse(PROTOCOL)
    assert t.canonical == "The scholarly answer."
    assert t.state_signal == "ready_to_draft_notes"
    assert t.proposed_commit["summary"] == "Read the paper."
    assert t.proposed_commit["notes_block"] == "## Notes\nKey findings."
    assert t.proposed_commit["synthesis"] == "The whole synthesis."


def test_unsolicited_notes_sections_can_be_ignored_by_the_production_boundary():
    t = agent.parse(PROTOCOL, allow_proposed_commit=False)

    assert t.canonical == "The scholarly answer."
    assert t.proposed_commit is None


def test_h2_heading_markers_parse():
    # Orca's finish turn: "## NAME" headings, separated by rules.
    content = """## CANONICAL

**What's in the Notes:** a preview.

---

## NOTES_BLOCK

## Notes
Details here.

## SYNTHESIS

Everything we know.

## COMMIT_SUMMARY

Read Orca."""
    t = agent.parse(content)
    assert t.canonical.startswith("**What's in the Notes:**")
    assert "NOTES_BLOCK" not in t.canonical
    assert t.proposed_commit is not None
    assert t.proposed_commit["summary"] == "Read Orca."
    assert "Details here." in t.proposed_commit["notes_block"]
    assert t.proposed_commit["synthesis"] == "Everything we know."


def test_h1_headings_with_preamble_and_canonical_last():
    # DeepSpeed's finish turn: leaked preamble, "# NAME" headings, CANONICAL last.
    content = """Now I have what I need. Let me draft all three sections.

---

# COMMIT_SUMMARY

Read DeepSpeed Inference.

# NOTES_BLOCK

## Notes
Kernel fusion details.

# SYNTHESIS

Updated working notes.

# CANONICAL

A short preview for review."""
    t = agent.parse(content)
    assert t.canonical == "A short preview for review."
    assert "Now I have what I need" not in t.canonical
    assert t.proposed_commit["summary"] == "Read DeepSpeed Inference."
    assert t.proposed_commit["synthesis"] == "Updated working notes."


def test_headings_inside_section_bodies_are_kept():
    # Ordinary markdown headings in the content must not be mistaken for markers.
    content = """###CANONICAL###
Intro.

## Methodology

Details.
###STATE###
in_discussion
###COMMIT_SUMMARY###
NONE
###NOTES_BLOCK###
NONE
###SYNTHESIS###
NONE
###END###"""
    t = agent.parse(content)
    assert "## Methodology" in t.canonical
    assert t.proposed_commit is None
    assert t.state_signal == "in_discussion"


def test_no_markers_falls_back_to_whole_content():
    t = agent.parse("Just a plain answer with no protocol at all.")
    assert t.canonical == "Just a plain answer with no protocol at all."
    assert t.proposed_commit is None


def test_canonical_prefix_handles_heading_markers():
    raw = "## CANONICAL\n\nStreaming answer so far"
    assert agent.canonical_prefix(raw) == "Streaming answer so far"
    # Once the next heading-style marker arrives, the canonical view stops before it.
    raw += "\n\n## NOTES_BLOCK\n\nnotes text"
    assert agent.canonical_prefix(raw) == "Streaming answer so far"


def test_canonical_prefix_hides_other_sections_before_canonical():
    # CANONICAL hasn't started yet but another section has: show nothing, not scaffolding.
    raw = "# COMMIT_SUMMARY\n\nRead the paper.\n\n# NOTES_BLOCK\n\nnotes"
    assert agent.canonical_prefix(raw) == ""


def test_canonical_prefix_holds_back_forming_heading_marker():
    raw = "###CANONICAL###\nAnswer text.\n\n## NOTES_BL"
    assert agent.canonical_prefix(raw) == "Answer text."

# ---- DR-058: the synthesis editor's output contract ----

def _editor(monkeypatch, raw):
    from app import agent
    monkeypatch.setattr(agent, "_complete", lambda *a, **k: raw)
    return agent.edit_synthesis(
        project_name="P", goals="g", current_synthesis="old doc",
        paper_title="T", notes_block="## N")


def test_editor_parses_plan_then_synthesis(monkeypatch):
    plan, synth = _editor(monkeypatch,
        "###PLAN###\nAdd the 40% result; skip the related-work rehash.\n"
        "###SYNTHESIS###\n## Working notes\nUpdated.\n###END###")
    assert plan == "Add the 40% result; skip the related-work rehash."
    assert synth == "## Working notes\nUpdated."


def test_editor_tolerates_heading_drift_and_missing_plan(monkeypatch):
    plan, synth = _editor(monkeypatch, "## SYNTHESIS\nJust the doc.")
    assert plan == ""
    assert synth == "Just the doc."


def test_editor_refuses_output_without_a_document(monkeypatch):
    import pytest
    from app import agent
    with pytest.raises(agent.AgentError):
        _editor(monkeypatch, "###PLAN###\nA plan but no document.")
    with pytest.raises(agent.AgentError):
        _editor(monkeypatch, "###PLAN###\np\n###SYNTHESIS###\n\n###END###")


def test_proposed_commit_carries_the_plan_field():
    from app.models import ProposedCommit
    d = ProposedCommit(summary="s", notes_block="n", synthesis="y", plan="p").to_dict()
    assert d["plan"] == "p"
    # Old dicts without the field still construct (default "") — proposals recorded before
    # the editor existed must keep loading.
    assert ProposedCommit(summary="s", notes_block="n", synthesis="y").to_dict()["plan"] == ""

