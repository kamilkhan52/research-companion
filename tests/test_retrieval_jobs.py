"""Paper retrieval runs independently of the request and retains terminal results for re-entry."""
from __future__ import annotations

import time

import pytest
from app import config, retrieval_jobs, store
from app.retriever import RetrievalError

from tests.conftest import add_paper


@pytest.fixture(autouse=True)
def _clear_jobs():
    retrieval_jobs._jobs.clear()
    yield
    retrieval_jobs._jobs.clear()


def _unretrieved_paper(pid: str) -> None:
    add_paper(pid, "p1", "Paper One")
    store.corpus_path("p1").unlink()


def _settled(job_id: str, timeout: float = 5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        snap = retrieval_jobs.snapshot(job_id)
        if snap and snap["status"] != "running":
            return snap
        time.sleep(0.02)
    raise TimeoutError(job_id)


def test_retrieval_persists_text_without_a_polling_client(temp_project):
    _unretrieved_paper(temp_project)

    job = retrieval_jobs.start_retrieval(
        "p1",
        retrieve_fn=lambda title, aid, url: {
            "full_text": "retrieved paper text",
            "arxiv_id": "2401.00001",
            "source": "https://arxiv.org/abs/2401.00001",
        },
    )
    snap = _settled(job.id)

    assert snap["status"] == "done" and snap["retrieved"] is True
    assert store.read_full_text("p1") == "retrieved paper text"
    assert retrieval_jobs.latest_for("p1").id == job.id


def test_confirmation_candidates_survive_as_terminal_job_result(temp_project):
    _unretrieved_paper(temp_project)
    candidates = [{"arxiv_id": "2401.1", "title": "Candidate", "score": 0.7}]

    job = retrieval_jobs.start_retrieval(
        "p1",
        retrieve_fn=lambda title, aid, url: {
            "needs_confirmation": True,
            "candidates": candidates,
        },
    )
    snap = _settled(job.id)

    assert snap["status"] == "done"
    assert snap["phase"] == "confirmation"
    assert snap["candidates"] == candidates
    assert retrieval_jobs.snapshot(retrieval_jobs.latest_for("p1").id) == snap


def test_failed_deterministic_retrieval_escalates_inside_background_job(temp_project, monkeypatch):
    _unretrieved_paper(temp_project)
    monkeypatch.setattr(config, "has_api_key", lambda: True)

    def fail(title, aid, url):
        raise RetrievalError("arXiv unavailable")

    async def hunt(title):
        yield {"type": "tool", "name": "web_search", "detail": title}
        yield {
            "type": "result", "ok": True, "full_text": "agent-found text",
            "source": "https://example.org/paper.pdf",
        }

    job = retrieval_jobs.start_retrieval("p1", retrieve_fn=fail, hunt_fn=hunt)
    snap = _settled(job.id)

    assert snap["status"] == "done" and snap["retrieved"] is True
    assert snap["items"] == [{"kind": "tool", "name": "web_search", "detail": "Paper One"}]
    assert store.read_full_text("p1") == "agent-found text"


def test_failure_is_retained_for_reentry(temp_project, monkeypatch):
    _unretrieved_paper(temp_project)
    monkeypatch.setattr(config, "has_api_key", lambda: False)

    def fail(title, aid, url):
        raise RetrievalError("nothing found")

    job = retrieval_jobs.start_retrieval("p1", retrieve_fn=fail)
    snap = _settled(job.id)

    assert snap["status"] == "error"
    assert "nothing found" in (snap["error"] or "")
    assert retrieval_jobs.latest_for("p1").id == job.id


def test_latest_result_prefers_an_immediate_retry_in_the_same_second(temp_project):
    _unretrieved_paper(temp_project)
    first = retrieval_jobs.start_retrieval(
        "p1", retrieve_fn=lambda title, aid, url: {
            "needs_confirmation": True,
            "candidates": [{"arxiv_id": "old", "title": "Old", "score": 0.6}],
        },
    )
    _settled(first.id)
    second = retrieval_jobs.start_retrieval(
        "p1", arxiv_id="new", retrieve_fn=lambda title, aid, url: {
            "needs_confirmation": True,
            "candidates": [{"arxiv_id": "new", "title": "New", "score": 1.0}],
        },
    )
    _settled(second.id)

    assert retrieval_jobs.latest_for("p1").id == second.id
