"""assembler prior_notes_scope: 'all' (the default since 2026-07-29) includes every read paper's
Notes; 'related' includes only citation-related papers' Notes."""
from __future__ import annotations

from app import assembler, config, graph_store, store

from tests.conftest import add_paper


def _settings(monkeypatch, scope):
    base = config.load_settings()
    monkeypatch.setattr(config, "load_settings", lambda: {**base, "prior_notes_scope": scope})


def _setup(temp_project):
    # 'current' cites 'other' (so the related selection is restrictive — without any recorded
    # cites, selected_prior_notes deliberately falls back to all read papers); 'unrelated' has
    # notes but no citation relationship to 'current'.
    add_paper(temp_project, "current", "Current Paper", full_text="t")
    add_paper(temp_project, "other", "Other Paper", full_text="t")
    add_paper(temp_project, "unrelated", "Unrelated Paper", full_text="t")
    rl = store._reading_list()
    rl.write_text(rl.read_text(encoding="utf-8").replace(
        "<!-- slug: current -->", "<!-- slug: current -->\n<!-- cites: other -->"),
        encoding="utf-8")
    store.append_notes_block("unrelated", "Unrelated Paper", "Unrelated finding: X beats Y.")


def test_both_contexts_carry_the_paper_link_instruction_and_targets(temp_project):
    add_paper(temp_project, "orca", "Orca: A Serving System", full_text="t")
    for ctx in (assembler.build_context("orca"), assembler.build_review_context()):
        assert "rc-paper:orca" in ctx          # verbatim link target per reading-list entry
        assert "link to its `link:` target" in ctx or "markdown link" in ctx


def test_reading_list_hint_keeps_unread_papers_at_abstract_level_without_a_caveat_each(
        temp_project):
    """DR-163: the per-paper "say it has not been read here yet" instruction made every unread
    citation carry its own caveat; the system prompt now asks for one clause per group."""
    add_paper(temp_project, "orca", "Orca: A Serving System", full_text="t")
    ctx = assembler.build_context("orca")
    assert "stay at the level its abstract and the citing passage support" in ctx
    assert "say it has not been read here yet" not in ctx


def test_related_scope_excludes_unrelated_notes(temp_project, monkeypatch):
    _setup(temp_project)
    _settings(monkeypatch, "related")
    ctx = assembler.build_context("current")
    assert "Unrelated finding" not in ctx
    assert "Prior Notes from related papers" in ctx


def test_the_configured_default_is_what_the_assembler_actually_does(temp_project, monkeypatch):
    """The default lives in one constant, but four places used to spell it out independently.

    Asserting the CONSTANT equals "all" would pass while the assembler still did something else,
    so this drives the real code path with the setting absent and checks the resulting context.
    """
    _setup(temp_project)
    _settings(monkeypatch, None)          # nothing stored — the default decides
    ctx = assembler.build_context("current")

    assert config.DEFAULT_PRIOR_NOTES_SCOPE == "all"
    assert "Unrelated finding: X beats Y." in ctx      # an unrelated paper's Notes are carried
    assert "every paper read so far" in ctx


def test_an_unrecognized_scope_follows_the_default_rather_than_the_other_branch(
        temp_project, monkeypatch):
    """A two-way branch on a raw string sends anything unexpected down the arm that is not the
    default. That silently matched the old default and would silently contradict the new one."""
    _setup(temp_project)
    _settings(monkeypatch, "banana")
    ctx = assembler.build_context("current")

    assert "Unrelated finding: X beats Y." in ctx
    assert "every paper read so far" in ctx


def test_all_scope_includes_every_read_papers_notes(temp_project, monkeypatch):
    _setup(temp_project)
    _settings(monkeypatch, "all")
    ctx = assembler.build_context("current")
    assert "Unrelated finding: X beats Y." in ctx
    assert "every paper read so far" in ctx


def test_all_scope_excludes_the_current_papers_own_notes(temp_project, monkeypatch):
    _setup(temp_project)
    store.append_notes_block("current", "Current Paper", "Own notes marker.")
    _settings(monkeypatch, "all")
    ctx = assembler.build_context("current")
    assert "Own notes marker." not in ctx  # the paper under discussion isn't its own prior
    assert "Unrelated finding: X beats Y." in ctx


def test_reading_context_lists_only_visible_numbered_figure_cards(temp_project, monkeypatch):
    add_paper(temp_project, "paper", "Paper With Figures", full_text="t")
    monkeypatch.setattr(assembler.figures, "manifest_for", lambda slug: {
        "status": "done",
        "figures": [
            {"number": 2, "caption": "  The main architecture.  "},
            {"number": None, "caption": "Unnumbered appendix image."},
        ],
    })

    ctx = assembler.build_context("paper")

    assert "Figure-card visibility in this discussion" in ctx
    assert "reader can see inline image cards" in ctx
    assert "- Figure 2: The main architecture." in ctx
    assert "Unnumbered appendix image" not in ctx
    assert "write `Figure N`" in ctx
    assert "without a meta announcement" in ctx
    assert "listed figures are available below" in ctx
    assert "unlisted figure is visible" in ctx


def test_reading_context_explicitly_says_when_no_figure_is_visible(temp_project, monkeypatch):
    add_paper(temp_project, "paper", "Paper Without Figures", full_text="t")
    manifests = (
        None,
        {"status": "none", "figures": []},
        {"status": "done", "figures": []},
    )
    for manifest in manifests:
        monkeypatch.setattr(
            assembler.figures, "manifest_for", lambda slug, value=manifest: value
        )
        ctx = assembler.build_context("paper")

        assert "Figure-card visibility in this discussion" in ctx
        assert "No paper figure images are available" in ctx
        assert "describe its data, structure, and conclusion completely in words" in ctx
        assert "without announcing the missing image" in ctx
        assert "figures are not available for this paper" in ctx
        assert "Never imply that the reader can see an unavailable image" in ctx


def test_opening_context_explains_later_project_papers_that_cite_this_one(temp_project):
    add_paper(temp_project, "foundation", "Foundation", full_text="t")
    add_paper(temp_project, "follow-up", "Follow-up", full_text="t")
    data = graph_store.load()
    graph_store.set_graph(data, {
        "nodes": [
            {"id": "foundation", "slug": "foundation", "kind": "project",
             "title": "Foundation", "year": 2020},
            {"id": "follow-up", "slug": "follow-up", "kind": "project",
             "title": "Follow-up", "year": 2024},
        ],
        "edges": [{
            "source": "follow-up",
            "target": "foundation",
            "significant": True,
            "reason": "Extends the memory model.",
            "contexts": ["We extend Foundation with stacked memory."],
            "full_text_verified": True,
        }],
    })
    graph_store.save(data)

    ctx = assembler.build_context("foundation")

    assert "How papers in this project cite this paper" in ctx
    assert "[Follow-up](rc-paper:follow-up)" in ctx
    assert "published later; substantive citation" in ctx
    assert "We extend Foundation with stacked memory." in ctx
