"""DR-167 — reset a paper's fetched text so it can be fetched or uploaded again.

Three papers in two days were filed with ANOTHER paper's full text, and once a paper is
retrieved the setup surface (Fetch, link, upload) is gone. The reset takes the corpus file, its
derived caches, the retained retrieval snapshot and the discussion threads; it keeps the
reading-list entry and committed notes, and commits the tracked deletions on their own.
"""
from __future__ import annotations

import subprocess
import threading
import time

import pytest
from app import (
    chat_jobs,
    cover_jobs,
    figures,
    graph_store,
    projects,
    retrieval_jobs,
    sessions,
    store,
)
from app.routers import session as session_routes
from fastapi import HTTPException

from tests.conftest import add_paper


@pytest.fixture(autouse=True)
def _clear_jobs():
    chat_jobs._jobs.clear()
    retrieval_jobs._registry.jobs.clear()
    yield
    chat_jobs._jobs.clear()
    retrieval_jobs._registry.jobs.clear()


def _git(root, *args: str) -> str:
    proc = subprocess.run(["git", *args], cwd=str(root), capture_output=True, text=True)
    return proc.stdout


def _retained_retrieval(slug: str) -> retrieval_jobs.RetrievalJob:
    """A finished retrieval snapshot for the paper, the way re-entry finds one."""
    job = retrieval_jobs.RetrievalJob(
        id=retrieval_jobs.new_id(), slug=slug, status="done", phase="done", retrieved=True,
        started_at=retrieval_jobs.now_iso(), finished_at=retrieval_jobs.now_iso())
    return retrieval_jobs._registry.put(slug, job)


def test_reset_forgets_the_text_its_caches_the_snapshot_and_the_chats(temp_project):
    add_paper(temp_project, "p", "Paper P", full_text="Wrong paper's text. " * 20)
    sessions.start_session("p", "Paper P")
    sessions.record_user("p", "a question", kind="reply")
    _retained_retrieval("p")
    cover_jobs.cover_path("p").parent.mkdir(parents=True, exist_ok=True)
    cover_jobs.cover_path("p").write_bytes(b"png")
    figures.manifest_path("p").parent.mkdir(parents=True, exist_ok=True)
    figures.manifest_path("p").write_text("{}")
    graph_store.write_retrieved_text("p", "graph text")

    root = projects.project_path(temp_project)
    _git(root, "add", "-A")
    _git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "seed")
    assert store.get_paper("p").retrieved is True

    result = session_routes.reset_source("p")

    assert result == {"reset": "p", "chats_cleared": True, "contributed": False}
    paper = store.get_paper("p")
    assert paper is not None and paper.title == "Paper P", "the entry stays on the list"
    assert paper.retrieved is False
    assert not store.corpus_path("p").exists()
    assert not cover_jobs.cover_path("p").exists()
    assert not figures.manifest_path("p").exists()
    assert graph_store.read_retrieved_text("p") == ""
    assert retrieval_jobs.latest_for("p") is None, "re-entry must not find retrieved=True"
    assert sessions.get_state("p") is None
    assert sessions.read_records("p") == []

    log = _git(root, "log", "--oneline", "-1")
    assert "Reset source: p" in log
    status = _git(root, "status", "--porcelain")
    assert "corpus/p.md" not in status and "sessions/" not in status

    # Nothing left to reset: a 409, not a silent no-op.
    with pytest.raises(HTTPException) as exc:
        session_routes.reset_source("p")
    assert exc.value.status_code == 409


def test_reset_keeps_committed_notes_and_reports_the_contribution(temp_project):
    add_paper(temp_project, "p", "Paper P")
    store.append_notes_block("p", "Paper P", "## Notes\n\nKept.")
    # Notes live in the corpus file (the block below the full text), so a reset must keep the
    # notes block and drop only the text — the paper's record survives, its source does not.
    assert store.get_paper("p").retrieved is True
    result = session_routes.reset_source("p")
    assert result["contributed"] is True
    assert "Kept." in store.read_notes("p")
    assert store.get_paper("p").retrieved is False
    assert store.read_full_text("p").strip() == store.FULL_TEXT_PLACEHOLDER
    # Fetching again replaces the placeholder and keeps the notes block.
    store.write_full_text("p", "Paper P", "The real text. " * 10, {"slug": "p"})
    assert store.get_paper("p").retrieved is True
    assert "Kept." in store.read_notes("p")


def test_a_notes_only_corpus_file_is_not_a_retrieved_paper(temp_project):
    rl = store._reading_list()
    rl.write_text(rl.read_text(encoding="utf-8") + "\n**Notes Only** — *unread*\n<!-- slug: no -->\n",
                  encoding="utf-8")
    store.append_notes_block("no", "Notes Only", "## Notes\n\nJust notes.")
    assert store.corpus_path("no").exists()
    assert store.get_paper("no").retrieved is False
    assert store.get_paper("no").has_notes is True


def test_reset_refuses_while_a_fetch_or_a_turn_is_in_flight(temp_project):
    add_paper(temp_project, "p", "Paper P")
    running = retrieval_jobs.RetrievalJob(
        id=retrieval_jobs.new_id(), slug="p", status="running", phase="resolving",
        started_at=retrieval_jobs.now_iso())
    retrieval_jobs._registry.put("p", running)
    with pytest.raises(HTTPException) as exc:
        session_routes.reset_source("p")
    assert exc.value.status_code == 409
    assert store.get_paper("p").retrieved is True
    retrieval_jobs._registry.jobs.clear()

    sessions.start_session("p", "Paper P")
    sessions.record_user("p", "q", kind="reply")
    gate = threading.Event()

    def stalled(slug_, history):
        gate.wait(5)
        yield {"type": "final",
               "text": "### CANONICAL ###\nA.\n### STATE ###\nin_discussion\n### END ###"}

    job = chat_jobs.start_turn("p", runner=lambda s, h: stalled(s, h))
    try:
        with pytest.raises(HTTPException) as exc:
            session_routes.reset_source("p")
        assert exc.value.status_code == 409
        assert "generating" in exc.value.detail
    finally:
        gate.set()
        deadline = time.time() + 5
        while time.time() < deadline and (chat_jobs.get_job(job.id) or job).status == "running":
            time.sleep(0.02)
    assert store.get_paper("p").retrieved is True
    assert sessions.get_state("p") is not None


def test_reset_unknown_and_unfetched_papers(temp_project):
    with pytest.raises(HTTPException) as exc:
        session_routes.reset_source("nope")
    assert exc.value.status_code == 404
    rl = store._reading_list()
    rl.write_text(rl.read_text(encoding="utf-8") + "\n**Never Fetched** — *unread*\n<!-- slug: nf -->\n",
                  encoding="utf-8")
    assert store.get_paper("nf").retrieved is False
    with pytest.raises(HTTPException) as exc:
        session_routes.reset_source("nf")
    assert exc.value.status_code == 409


def test_forget_for_only_drops_settled_jobs_of_this_project(temp_project):
    _retained_retrieval("p")
    running = retrieval_jobs.RetrievalJob(
        id=retrieval_jobs.new_id(), slug="p", status="running", phase="resolving",
        started_at=retrieval_jobs.now_iso())
    retrieval_jobs._registry.put("p", running)
    _retained_retrieval("q")
    assert retrieval_jobs.forget_for("p") == 1
    assert retrieval_jobs.latest_for("p") is running
    assert retrieval_jobs.latest_for("q") is not None
