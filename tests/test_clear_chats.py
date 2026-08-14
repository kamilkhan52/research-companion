"""DR-079 — clear every discussion thread of one paper, on explicit confirmation.

The paper (corpus, notes, reading-list entry) survives; only chats go. Tracked transcript
deletions are committed immediately with a pathspec limited to those files, so the cleared
chats stay recoverable from git history and are never swept into an unrelated approval.
"""
from __future__ import annotations

import subprocess
import threading
import time

import pytest
from app import chat_jobs, projects, sessions, store
from app.routers import session as session_routes
from fastapi import HTTPException


@pytest.fixture(autouse=True)
def _clear_jobs():
    chat_jobs._jobs.clear()
    yield
    chat_jobs._jobs.clear()


def _seed(slug: str = "p") -> str:
    sessions.start_session(slug, "Paper P")
    sessions.record_user(slug, "a question", kind="reply")
    return slug


def _git(root, *args: str) -> str:
    proc = subprocess.run(["git", *args], cwd=str(root), capture_output=True, text=True)
    return proc.stdout


def test_clear_removes_every_thread_and_commits_tracked_deletions(temp_project):
    slug = _seed()
    thread = sessions.create_thread(slug, "Side thread")
    with sessions.thread_scope(thread["id"]):
        sessions.record_user(slug, "thread question", kind="reply")

    # Commit the transcripts the way an approval's `add -A` would have.
    root = projects.project_path(temp_project)
    _git(root, "add", "-A")
    _git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "seed")

    result = session_routes.clear_chats(slug)
    assert result["cleared"] is True

    # Everything conversational is gone; the paper's non-chat files are untouched.
    assert sessions.get_state(slug) is None
    assert sessions.read_records(slug) == []
    assert sessions.list_threads(slug) == []
    for jsonl, _branches in sessions.thread_storage_paths(slug):
        assert not jsonl.exists()

    # The deletion was committed on its own, message naming the action, tree clean of it.
    log = _git(root, "log", "--oneline", "-1")
    assert "Clear chats" in log
    assert "sessions/" not in _git(root, "status", "--porcelain")

    # Nothing left to clear: the second call is a 409, not a silent no-op.
    with pytest.raises(HTTPException) as exc:
        session_routes.clear_chats(slug)
    assert exc.value.status_code == 409


def test_clear_refuses_while_any_thread_generates(temp_project):
    slug = _seed()
    thread = sessions.create_thread(slug, "Side thread")
    gate = threading.Event()

    def stalled(slug_, history):
        gate.wait(5)
        yield {"type": "final",
               "text": "### CANONICAL ###\nA.\n### STATE ###\nin_discussion\n### END ###"}

    # The turn runs on the SECONDARY thread — active_for(slug) alone would miss it.
    with sessions.thread_scope(thread["id"]):
        sessions.record_user(slug, "q", kind="reply")
        job = chat_jobs.start_turn(slug, runner=lambda s, h: stalled(s, h))
    try:
        with pytest.raises(HTTPException) as exc:
            session_routes.clear_chats(slug)
        assert exc.value.status_code == 409
        assert "generating" in exc.value.detail
    finally:
        gate.set()
        deadline = time.time() + 5
        while time.time() < deadline and (chat_jobs.get_job(job.id) or job).status == "running":
            time.sleep(0.02)

    # Transcripts survived the refusal.
    assert sessions.get_state(slug) is not None


def test_clear_reports_whether_the_paper_contributed_notes(temp_project, monkeypatch):
    slug = _seed()
    paper = store.get_paper(slug)
    assert paper is None  # not on the reading list in this seed -> no contribution offer
    assert session_routes.clear_chats(slug)["contributed"] is False

    slug2 = "with-notes"
    store.add_entry("With Notes", group="Group")
    _seed("with-notes")
    monkeypatch.setattr(store, "get_paper",
                        lambda s, *a, **k: type("P", (), {"has_notes": True})()
                        if s == slug2 else None)
    assert session_routes.clear_chats(slug2)["contributed"] is True
