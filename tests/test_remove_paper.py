"""Removing a paper: store.remove_entry / append_removed_marker (pure markdown editing) and
the DELETE /papers/{slug} route (which also git-commits the human-confirmed removal)."""
from __future__ import annotations

import subprocess

import pytest
from app import config, store
from app.routers.projects_api import remove_paper
from fastapi import HTTPException
from tests.conftest import add_paper


def _git_log(cwd) -> str:
    return subprocess.run(["git", "log", "--oneline"], cwd=str(cwd),
                          capture_output=True, text=True).stdout


def test_remove_entry_drops_only_the_target(temp_project):
    add_paper(temp_project, "a", "Paper A")
    add_paper(temp_project, "b", "Paper B")
    assert store.remove_entry("a") is True
    slugs = {p.slug for p in store.list_papers()}
    assert slugs == {"b"}
    # The survivor's block is intact and the file still parses.
    text = store._reading_list().read_text(encoding="utf-8")
    assert "Paper A" not in text
    assert "Paper B" in text


def test_remove_entry_unknown_slug_is_false(temp_project):
    add_paper(temp_project, "a", "Paper A")
    assert store.remove_entry("nope") is False
    assert {p.slug for p in store.list_papers()} == {"a"}


def test_remove_entry_takes_the_whole_block(temp_project):
    slug = store.add_entry("Rich Entry", group="G", arxiv_id="2401.00001",
                           abstract="An abstract that wraps across the entry block.")
    assert store.remove_entry(slug) is True
    text = store._reading_list().read_text(encoding="utf-8")
    assert "Rich Entry" not in text
    assert "2401.00001" not in text
    assert "An abstract" not in text


def test_remove_entry_keeps_corpus_and_notes_on_disk(temp_project):
    add_paper(temp_project, "a", "Paper A")
    store.append_notes_block("a", "Paper A", "## Notes\n\nKey insight.")
    assert store.remove_entry("a") is True
    assert store.corpus_path("a").exists()
    assert "Key insight." in store.read_notes("a")


def test_removed_marker_appends_once_and_keeps_notes_readable(temp_project):
    add_paper(temp_project, "a", "Paper A")
    store.append_notes_block("a", "Paper A", "## Notes\n\nKey insight.")
    store.append_removed_marker("a")
    text = store.corpus_path("a").read_text(encoding="utf-8")
    assert "Removed from the reading list on" in text
    assert store.has_notes("a") is True
    assert "Key insight." in store.read_notes("a")


def test_removed_marker_is_noop_without_notes(temp_project):
    add_paper(temp_project, "a", "Paper A")
    before = store.corpus_path("a").read_text(encoding="utf-8")
    store.append_removed_marker("a")
    assert store.corpus_path("a").read_text(encoding="utf-8") == before


def test_remove_paper_route_commits_and_reports(temp_project):
    add_paper(temp_project, "a", "Paper A")
    store.append_notes_block("a", "Paper A", "## Notes\n\nKept.")
    res = remove_paper(temp_project, "a")
    assert res == {"removed": "a", "notes_kept": True}
    assert store.get_paper("a") is None
    # The removal reached the git record (the in-app confirmation was the approval).
    assert "Remove Paper A from reading list" in _git_log(config.project_dir())


def test_remove_paper_route_404s_unknown_slug(temp_project):
    with pytest.raises(HTTPException) as e:
        remove_paper(temp_project, "missing")
    assert e.value.status_code == 404
