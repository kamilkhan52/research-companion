"""assembler prior_notes_scope: 'related' (default) includes only citation-related papers'
Notes; 'all' includes every read paper's Notes — the single-project mode Kamil asked for."""
from __future__ import annotations

from app import assembler, config, store

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


def test_default_related_scope_excludes_unrelated_notes(temp_project, monkeypatch):
    _setup(temp_project)
    _settings(monkeypatch, "related")
    ctx = assembler.build_context("current")
    assert "Unrelated finding" not in ctx
    assert "Prior Notes from related papers" in ctx


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


def test_reading_context_lists_only_prefetched_numbered_figure_cards(temp_project, monkeypatch):
    add_paper(temp_project, "paper", "Paper With Figures", full_text="t")
    monkeypatch.setattr(assembler.figures, "manifest_for", lambda slug: {
        "status": "done",
        "figures": [
            {"number": 2, "caption": "  The main architecture.  "},
            {"number": None, "caption": "Unnumbered appendix image."},
        ],
    })

    ctx = assembler.build_context("paper")

    assert "Prefetched figure cards available" in ctx
    assert "- Figure 2: The main architecture." in ctx
    assert "Unnumbered appendix image" not in ctx
    assert "write `Figure N`" in ctx
