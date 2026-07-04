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
