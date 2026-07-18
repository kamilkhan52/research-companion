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


def test_remove_commit_excludes_unrelated_dirty_files(temp_project):
    """The confirm approved THIS removal — a dirty transcript/corpus from an in-flight job
    must not ride along in the removal commit (invariant 4)."""
    add_paper(temp_project, "a", "Paper A")
    add_paper(temp_project, "b", "Paper B")
    store.append_notes_block("a", "Paper A", "## Notes\n\nKept.")
    # Track everything, then dirty an unrelated file the way a finishing job would.
    subprocess.run(["git", "add", "-A"], cwd=str(config.project_dir()), capture_output=True)
    subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "baseline"],
                   cwd=str(config.project_dir()), capture_output=True)
    unrelated = store.corpus_path("b")
    unrelated.write_text(unrelated.read_text(encoding="utf-8") + "\nmid-flight write\n",
                         encoding="utf-8")

    remove_paper(temp_project, "a")

    committed = subprocess.run(["git", "show", "--name-only", "--format=", "HEAD"],
                               cwd=str(config.project_dir()), capture_output=True, text=True).stdout
    assert "reading-list.md" in committed
    assert "corpus/a.md" in committed          # the retained-notes marker
    assert "corpus/b.md" not in committed      # the unrelated dirty file stayed out
    status = subprocess.run(["git", "status", "--porcelain"], cwd=str(config.project_dir()),
                            capture_output=True, text=True).stdout
    assert "corpus/b.md" in status             # still dirty, awaiting its own approval


def test_graph_status_reports_removed_paper_as_stale(temp_project):
    from app import graph, graph_store, sessions
    add_paper(temp_project, "a", "Paper A")
    add_paper(temp_project, "b", "Paper B")
    data = graph_store.load()
    graph_store.set_graph(data, {
        "built_at": "2026-07-09T00:00:00+00:00", "model": "m",
        "nodes": [
            {"id": "p:a", "kind": "project", "slug": "a"},
            {"id": "p:b", "kind": "project", "slug": "b"},
        ],
        "edges": [],
    })
    graph_store.save(data)

    store.remove_entry("a")
    st = graph.status(store.list_papers(sessions.session_states()))
    assert "a" in st["stale_papers"]
    assert st["removed_papers"] == ["a"]
    assert "b" not in st["removed_papers"]


def test_recent_sessions_drops_removed_papers(temp_project):
    from app import projects, sessions
    add_paper(temp_project, "a", "Paper A")
    add_paper(temp_project, "b", "Paper B")
    sessions.start_session("a", "Paper A")
    sessions.start_session("b", "Paper B")

    remove_paper(temp_project, "a")
    slugs = {s["slug"] for s in projects.recent_sessions()}
    assert "a" not in slugs
    assert "b" in slugs
    # The transcript index entry itself is retained (warm re-add) — only the listing filters.
    assert "a" in sessions.session_index()


def test_remove_batch_removes_all_in_one_commit(temp_project):
    """The multi-select Delete removes every selected paper atomically — one commit, and
    unknown slugs are skipped so a retry of a partial earlier attempt is idempotent."""
    from app.routers.projects_api import RemoveBatchReq, remove_papers

    add_paper(temp_project, "a", "Paper A")
    add_paper(temp_project, "b", "Paper B")
    add_paper(temp_project, "c", "Paper C")
    before = _git_log(config.project_dir()).count("\n")

    res = remove_papers(temp_project, RemoveBatchReq(slugs=["a", "c", "ghost"]))
    assert set(res["removed"]) == {"a", "c"}  # ghost skipped
    assert {p.slug for p in store.list_papers()} == {"b"}
    # Exactly ONE commit added for the whole batch (atomic).
    assert _git_log(config.project_dir()).count("\n") == before + 1


def test_remove_batch_refuses_while_relocating(temp_project):
    from app.routers.projects_api import RemoveBatchReq, remove_papers

    add_paper(temp_project, "a", "Paper A")
    config.mark_project_busy(temp_project)
    try:
        with pytest.raises(HTTPException) as exc:
            remove_papers(temp_project, RemoveBatchReq(slugs=["a"]))
        assert exc.value.status_code == 409
    finally:
        config.unmark_project_busy(temp_project)
    assert {p.slug for p in store.list_papers()} == {"a"}  # nothing removed
