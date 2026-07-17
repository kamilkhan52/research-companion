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


def test_retrieval_renders_cover_from_downloaded_pdf(temp_project):
    # A cover rides along on the PDF retrieval already downloaded — no second fetch.
    import fitz
    from app import cover_jobs

    _unretrieved_paper(temp_project)
    doc = fitz.open()
    doc.new_page(width=612, height=792)
    pdf = doc.tobytes()
    doc.close()

    job = retrieval_jobs.start_retrieval(
        "p1",
        retrieve_fn=lambda title, aid, url: {
            "full_text": "retrieved paper text",
            "arxiv_id": "2401.00001",
            "source": "https://arxiv.org/abs/2401.00001",
            "pdf_bytes": pdf,
        },
    )
    _settled(job.id)
    assert cover_jobs.cover_path("p1").exists()


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


def test_explicit_id_retrieval_corrects_a_machine_resolved_entry_id(temp_project):
    """U.18 — the user re-retrieves with the RIGHT id after a wrong title-search match; the
    entry's machine-recorded id must follow the correction."""
    add_paper(temp_project, "p2", "Paper Two")
    store.annotate_entry("p2", arxiv_id="2401.99999")  # machine-resolved, wrong
    store.corpus_path("p2").unlink()

    job = retrieval_jobs.start_retrieval(
        "p2", arxiv_id="1706.03762",
        retrieve_fn=lambda title, aid, url: {
            "full_text": "the right paper", "arxiv_id": "1706.03762",
            "source": "https://arxiv.org/abs/1706.03762",
        },
    )
    _settled(job.id)
    assert store.arxiv_id_for("p2") == "1706.03762"


def test_title_search_fallback_never_masquerades_as_the_explicit_id(temp_project):
    """A failed explicit download falls back to title search; its machine-selected id must
    not authoritatively replace the entry's pinned id."""
    add_paper(temp_project, "p3", "Paper Three")
    store.annotate_entry("p3", arxiv_id="1706.03762")  # pinned, correct
    store.corpus_path("p3").unlink()

    job = retrieval_jobs.start_retrieval(
        "p3", arxiv_id="2401.55555",  # explicit id whose download "failed"
        retrieve_fn=lambda title, aid, url: {
            "full_text": "a plausible near-miss", "arxiv_id": "2402.11111",
            "source": "https://arxiv.org/abs/2402.11111",
        },
    )
    _settled(job.id)
    assert store.arxiv_id_for("p3") == "1706.03762"


def test_after_retrieved_hook_runs_on_success_and_records_analysis_job(temp_project):
    """R7.8: the auto-analysis continuation fires exactly on the success path and its chat-job
    id lands on the snapshot; a hook failure degrades to analysis_error, never a job error."""
    _unretrieved_paper(temp_project)
    kicked: list[str] = []

    def hook(job):
        kicked.append(job.slug)
        retrieval_jobs.set_analysis_job(job, "chat-123")

    job = retrieval_jobs.start_retrieval(
        "p1",
        retrieve_fn=lambda title, aid, url: {"full_text": "text", "arxiv_id": None,
                                             "source": "s"},
        after_retrieved=hook,
    )
    snap = _settled(job.id)
    assert kicked == ["p1"]
    assert snap["status"] == "done" and snap["analysis_job_id"] == "chat-123"
    assert snap["analysis_error"] is None


def test_after_retrieved_hook_failure_is_best_effort(temp_project):
    _unretrieved_paper(temp_project)

    def hook(job):
        raise RuntimeError("no API key")

    job = retrieval_jobs.start_retrieval(
        "p1",
        retrieve_fn=lambda title, aid, url: {"full_text": "text", "arxiv_id": None,
                                             "source": "s"},
        after_retrieved=hook,
    )
    snap = _settled(job.id)
    assert snap["status"] == "done" and snap["retrieved"] is True  # retrieval still succeeded
    assert "no API key" in snap["analysis_error"]


def test_after_retrieved_hook_skipped_on_confirmation(temp_project):
    _unretrieved_paper(temp_project)
    kicked: list[str] = []

    job = retrieval_jobs.start_retrieval(
        "p1",
        retrieve_fn=lambda title, aid, url: {"needs_confirmation": True,
                                             "candidates": [{"id": "x"}]},
        after_retrieved=lambda job: kicked.append(job.slug),
    )
    snap = _settled(job.id)
    assert snap["phase"] == "confirmation" and kicked == []
