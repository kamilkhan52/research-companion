"""Paper retrieval runs independently of the request and retains terminal results for re-entry."""
from __future__ import annotations

import time

import pytest
from app import config, retrieval_jobs, retriever, store
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
            "matched_title": "The Canonical Paper One",
        },
    )
    snap = _settled(job.id)

    assert snap["status"] == "done" and snap["retrieved"] is True
    assert snap["matched_title"] == "The Canonical Paper One"
    assert snap["arxiv_id"] == "2401.00001"
    assert snap["source"] == "https://arxiv.org/abs/2401.00001"
    assert store.read_full_text("p1") == "retrieved paper text"
    # Resolution only proposes the canonical title; it never rewrites the record silently.
    assert store.get_paper("p1").title == "Paper One"
    assert retrieval_jobs.latest_for("p1").id == job.id


def test_uploaded_pdf_extracts_and_persists_in_a_background_job(temp_project, monkeypatch):
    _unretrieved_paper(temp_project)
    monkeypatch.setattr(
        retrieval_jobs.retriever,
        "extract_pdf_bytes",
        lambda data: "uploaded full text",
    )

    job = retrieval_jobs.start_upload("p1", b"pdf bytes", "my-paper.pdf")
    snap = _settled(job.id)

    assert snap["status"] == "done"
    assert snap["retrieved"] is True
    assert snap["source"] == "upload:my-paper.pdf"
    assert store.read_full_text("p1") == "uploaded full text"


@pytest.mark.parametrize("entry_path", ["arxiv", "upload"])
def test_pdf_surrogates_are_repaired_before_both_retrieval_paths_persist(
    temp_project,
    monkeypatch,
    entry_path,
):
    """The two DR-160 entry paths must both cross the real PDF cleanup boundary."""
    _unretrieved_paper(temp_project)

    class Page:
        def extract_text(self):
            return ("Readable PDF text. " * 15) + "SelectTop-\ud8352\ud8352 MLP"

    class Reader:
        def __init__(self, stream):
            self.pages = [Page()]

    monkeypatch.setattr(retriever, "PdfReader", Reader)
    pdf = b"%PDF-1.4 fake regression fixture"

    if entry_path == "upload":
        job = retrieval_jobs.start_upload("p1", pdf, "stratum.pdf")
    else:
        job = retrieval_jobs.start_retrieval(
            "p1",
            retrieve_fn=lambda title, aid, url: {
                "full_text": retriever._extract_pdf(pdf),
                "arxiv_id": "2510.05245",
                "source": "https://arxiv.org/abs/2510.05245",
            },
        )

    snap = _settled(job.id)
    persisted = store.read_full_text("p1")

    assert snap["status"] == "done"
    assert "SelectTop-\ufffd2\ufffd2 MLP" in persisted
    assert not any(0xD800 <= ord(char) <= 0xDFFF for char in persisted)
    assert persisted.encode("utf-8")


def test_background_retrieval_does_not_recreate_a_paper_removed_mid_fetch(temp_project):
    _unretrieved_paper(temp_project)

    def retrieve_then_remove(title, aid, url):
        store.remove_entry("p1")
        return {"full_text": "orphan", "source": "test"}

    job = retrieval_jobs.start_retrieval("p1", retrieve_fn=retrieve_then_remove)
    snap = _settled(job.id)

    assert snap["status"] == "error"
    assert "no longer in the project" in (snap["error"] or "")
    assert store.corpus_path("p1").exists() is False


def test_new_retrieval_job_is_refused_while_project_is_reserved(temp_project):
    _unretrieved_paper(temp_project)
    config.mark_project_busy(temp_project)
    try:
        with pytest.raises(RetrievalError, match="moved or split"):
            retrieval_jobs.start_retrieval("p1")
    finally:
        config.unmark_project_busy(temp_project)
    assert retrieval_jobs.latest_for("p1") is None


def test_retrieval_starts_canonical_pass_for_new_and_already_fetched_papers(
    temp_project, monkeypatch,
):
    warmed: list[str] = []
    monkeypatch.setattr(retrieval_jobs.canonical_jobs, "warm_async", warmed.append)

    _unretrieved_paper(temp_project)
    first = retrieval_jobs.start_retrieval(
        "p1",
        retrieve_fn=lambda title, aid, url: {
            "full_text": "retrieved paper text",
            "arxiv_id": "2401.00001",
            "source": "https://arxiv.org/abs/2401.00001",
        },
    )
    _settled(first.id)

    # The next first-read start short-circuits retrieval but still retries the best-effort
    # canonical warm, covering papers that predate the cache or whose earlier warm missed.
    second = retrieval_jobs.start_retrieval("p1")
    assert second.status == "done"
    assert warmed == ["p1", "p1"]


def test_retrieval_snapshot_piggybacks_canonical_progress(temp_project, monkeypatch):
    _unretrieved_paper(temp_project)

    class Warm:
        id = "canonical-1"

    monkeypatch.setattr(retrieval_jobs.canonical_jobs, "warm_async", lambda slug: Warm())

    def canonical_snapshot(job_id):
        # Cross-registry enrichment must happen after the retrieval snapshot releases its lock.
        assert retrieval_jobs._registry.lock.acquire(blocking=False)
        retrieval_jobs._registry.lock.release()
        return {
            "id": job_id,
            "status": "running",
            "step": "Reading first page… · Mapping references… · Finding figures…",
        }

    monkeypatch.setattr(
        retrieval_jobs.canonical_jobs,
        "snapshot",
        canonical_snapshot,
    )
    job = retrieval_jobs.start_retrieval(
        "p1",
        retrieve_fn=lambda title, aid, url: {
            "full_text": "retrieved paper text",
            "arxiv_id": None,
            "source": "test",
        },
    )
    snap = _settled(job.id)

    assert snap["enrichment"] == {
        "status": "running",
        "step": "Reading first page… · Mapping references… · Finding figures…",
    }
    assert "canonical_job_id" not in snap


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

    def hook(job, *, admitted=True):
        kicked.append((job.slug, admitted))
        retrieval_jobs.set_analysis_job(job, "chat-123")

    job = retrieval_jobs.start_retrieval(
        "p1",
        retrieve_fn=lambda title, aid, url: {"full_text": "text", "arxiv_id": None,
                                             "source": "s"},
        after_retrieved=hook,
    )
    snap = _settled(job.id)
    # The worker path admitted the retrieval, so the turn it continues must NOT be re-metered.
    assert kicked == [("p1", True)]
    assert snap["status"] == "done" and snap["analysis_job_id"] == "chat-123"
    assert snap["analysis_error"] is None


def test_after_retrieved_hook_failure_is_best_effort(temp_project):
    _unretrieved_paper(temp_project)

    def hook(job, *, admitted=True):
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
    # An ordinary failure gains no structure — only a refusal does (DR-049).
    assert snap["analysis_refusal"] is None


def test_a_refused_analysis_chain_carries_the_structured_payload(temp_project):
    """The chat job that would carry the refusal was never created, so the retrieval job is the
    only carrier — the client classifies `analysis_refusal.code` instead of prose (DR-049)."""
    from app import quotas

    _unretrieved_paper(temp_project)

    def refused_hook(job, *, admitted=True):
        raise quotas.QuotaExceeded(
            used_nanousd=100, settled_nanousd=100, requested_nanousd=10, limit_nanousd=100)

    job = retrieval_jobs.start_retrieval(
        "p1",
        retrieve_fn=lambda title, aid, url: {"full_text": "text", "arxiv_id": None,
                                             "source": "s"},
        after_retrieved=refused_hook,
    )
    snap = _settled(job.id)
    assert snap["status"] == "done" and snap["retrieved"] is True
    assert snap["analysis_refusal"]["code"] == "quota_exceeded"
    assert snap["analysis_error"] == snap["analysis_refusal"]["detail"]


def test_after_retrieved_hook_skipped_on_confirmation(temp_project):
    _unretrieved_paper(temp_project)
    kicked: list[str] = []

    job = retrieval_jobs.start_retrieval(
        "p1",
        retrieve_fn=lambda title, aid, url: {"needs_confirmation": True,
                                             "candidates": [{"id": "x"}]},
        after_retrieved=lambda job, **_kw: kicked.append(job.slug),
    )
    snap = _settled(job.id)
    assert snap["phase"] == "confirmation" and kicked == []


def test_hook_runs_inline_for_an_already_retrieved_paper(temp_project):
    """The already-retrieved short-circuit returns a terminal job with no worker; the chain
    must still kick, on the caller's thread."""
    add_paper(temp_project, "p1", "Paper One")  # corpus present -> retrieved
    kicked: list[str] = []

    job = retrieval_jobs.start_retrieval(
        "p1",
        after_retrieved=lambda j, **kw: kicked.append((j.slug, kw.get("admitted"))),
    )
    assert job.status == "done" and job.retrieved is True
    # No worker and no admission ran, so the turn this kicks is the first paid work of the
    # request and must be metered. Reporting `admitted=True` here was an unmetered LLM turn
    # (plus unmetered narration in listening mode) for any already-retrieved paper.
    assert kicked == [("p1", False)]


def test_the_hunt_takes_its_own_hold_not_the_cheap_retrieval_ticket(temp_project, monkeypatch):
    """`retrieval` is priced for the deterministic path — a fetch that is free and an extraction
    that is cheap. The hunt is the escalation tier: a multi-turn tool loop with web search and page
    fetches on the analysis-tier model. Billing it against the cheap ticket admits a reader with
    two cents of headroom and then charges multiples of it.

    Review found the hold could be deleted outright with the whole suite still green.
    """
    from app import spend_ceiling

    _unretrieved_paper(temp_project)
    monkeypatch.setattr(config, "has_api_key", lambda: True)
    operations: list[str] = []
    monkeypatch.setattr(spend_ceiling, "hold",
                        lambda operation, job_id, **kw: operations.append(operation))
    monkeypatch.setattr(spend_ceiling, "settle", lambda held: None)

    def fail(title, aid, url):
        raise RetrievalError("arXiv unavailable")

    async def hunt(title):
        yield {"type": "result", "ok": True, "full_text": "found",
               "source": "https://example.org/p.pdf"}

    snap = _settled(retrieval_jobs.start_retrieval(
        "p1", retrieve_fn=fail, hunt_fn=hunt).id)

    assert snap["status"] == "done"
    # EXACTLY the hunt's hold, and no `retrieval` ticket beside it. The retrieval job's own thread
    # dispatches nothing to a provider — an arXiv fetch and a local PDF extraction — so a ticket
    # here only stacks $0.02 on top of the hunt's $0.10, refusing readers who could afford the work
    # and, on a crash, letting the reconciler conservatively charge both. Asserting `in` rather
    # than equality let that stacking through.
    assert operations == ["retrieval_hunt"], (
        f"expected only the hunt's own hold, got {operations}"
    )


def test_a_hunt_refused_for_budget_reports_the_refusal_not_a_retrieval_failure(
    temp_project, monkeypatch,
):
    """Out of allowance is not "we could not find your paper". Telling a reader to try a different
    title when the real answer is that they are out of credit sends them somewhere useless."""
    from app import quotas, spend_ceiling

    _unretrieved_paper(temp_project)
    monkeypatch.setattr(config, "has_api_key", lambda: True)

    def refuse(operation, job_id, **kw):
        if operation == "retrieval_hunt":
            raise quotas.QuotaExceeded(
                used_nanousd=10, requested_nanousd=10, limit_nanousd=10,
            )
        return None

    monkeypatch.setattr(spend_ceiling, "hold", refuse)
    monkeypatch.setattr(spend_ceiling, "settle", lambda held: None)

    def fail(title, aid, url):
        raise RetrievalError("arXiv unavailable")

    async def hunt(title):  # never reached
        yield {"type": "result", "ok": True, "full_text": "x", "source": "u"}

    snap = _settled(retrieval_jobs.start_retrieval("p1", retrieve_fn=fail, hunt_fn=hunt).id)

    assert snap["status"] == "error"
    assert "usage limit" in (snap["error"] or "").lower(), snap["error"]
    assert snap["retrieved"] is False
