"""DR-140 — reading assistants for cited-but-unread project papers.

The candidate list is deterministic (a response's own `rc-paper:` links, minus what has been read
or already briefed); the pass briefs each chosen paper with an injected reader (no network),
records the hidden briefing turn, chains the analyst's follow-up on an injected runner, and the
transcript attaches the briefs to THAT response. Budget refusals stop the pass without losing
what was already briefed; a pass that briefs nothing chains nothing."""
from __future__ import annotations

import contextlib
import threading
import time

import pytest
from app import chat_jobs, config, preview_jobs, quotas, reader_jobs, sessions, spend_limits, store
from fastapi.testclient import TestClient

from tests.conftest import add_paper

PROTO = ("### CANONICAL ###\nRevised: [H3](rc-paper:h3) is not what I said.\n"
         "### STATE ###\nin_discussion\n### END ###")


@pytest.fixture(autouse=True)
def _clear_jobs():
    for registry in (reader_jobs._jobs, chat_jobs._jobs, preview_jobs._jobs,
                     preview_jobs._coordinator_jobs):
        registry.clear()
    yield
    for registry in (reader_jobs._jobs, chat_jobs._jobs, preview_jobs._jobs,
                     preview_jobs._coordinator_jobs):
        registry.clear()


SUMMARY = ("FLINT builds on [H3](rc-paper:h3) and refines [H3](rc-paper:h3) again; "
           "[MemExplorer](rc-paper:memexplorer) is concurrent; it also cites "
           "[Orca](rc-paper:orca), which we have read, [itself](rc-paper:flint), and a "
           "paper that left the list, [Ghost](rc-paper:ghost).")


def _project(temp_project, *, memexplorer_text: str | None = "MemExplorer full text"):
    add_paper(temp_project, "flint", "FLINT", full_text="FLINT full text")
    add_paper(temp_project, "h3", "H3", full_text="H3 full text about staging buffers")
    add_paper(temp_project, "orca", "Orca", full_text="Orca text")
    store.append_notes_block("orca", "Orca", "## Notes\n\nRead already.")
    if memexplorer_text is None:
        # On the list, never retrieved: no corpus file at all.
        rl = store._reading_list()
        rl.write_text(rl.read_text(encoding="utf-8")
                      + "\n**MemExplorer** — *unread*\n<!-- slug: memexplorer -->\n",
                      encoding="utf-8")
    else:
        add_paper(temp_project, "memexplorer", "MemExplorer", full_text=memexplorer_text)
    sessions.start_session("flint", "FLINT")
    sessions.record_assistant("flint", _turn(SUMMARY))
    return "flint"


def _turn(canonical: str):
    from app.models import Turn
    return Turn(role="assistant", canonical=canonical, state_signal="in_discussion")


def _settled(job_id: str, timeout: float = 5.0) -> reader_jobs.ReaderJob:
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = reader_jobs.get_job(job_id)
        if job and job.status != "running":
            return job
        time.sleep(0.02)
    raise TimeoutError(job_id)


def _chat_settled(job_id: str, timeout: float = 5.0) -> chat_jobs.ChatJob:
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = chat_jobs.get_job(job_id)
        if job and job.status != "running":
            return job
        time.sleep(0.02)
    raise TimeoutError(job_id)


def _runner(events):
    return lambda slug, history: iter(events)


FOLLOW_UP = [{"type": "text", "text": PROTO}, {"type": "final", "text": PROTO}]


# ---------------------------------------------------------------- candidates

def test_candidates_are_the_unread_project_papers_the_response_linked(temp_project):
    slug = _project(temp_project, memexplorer_text=None)
    result = reader_jobs.candidates(slug)
    assert result["assistant_index"] == 0
    # De-duplicated, in first-mention order; Orca has notes, flint is the paper itself, and
    # Ghost is not on the list.
    assert [c["slug"] for c in result["candidates"]] == ["h3", "memexplorer"]
    by_slug = {c["slug"]: c for c in result["candidates"]}
    assert by_slug["h3"]["has_text"] is True and by_slug["h3"]["title"] == "H3"
    assert by_slug["memexplorer"]["has_text"] is False


def test_candidates_default_to_the_latest_response_and_bound_the_index(temp_project):
    slug = _project(temp_project)
    sessions.record_user(slug, "and?", kind="reply")
    sessions.record_assistant(slug, _turn("Only [MemExplorer](rc-paper:memexplorer) here."))
    assert [c["slug"] for c in reader_jobs.candidates(slug)["candidates"]] == ["memexplorer"]
    assert [c["slug"] for c in reader_jobs.candidates(slug, assistant_index=0)["candidates"]] \
        == ["h3", "memexplorer"]
    with pytest.raises(reader_jobs.ReaderError):
        reader_jobs.candidates(slug, assistant_index=7)


def test_a_session_with_no_response_yet_has_no_candidates(temp_project):
    add_paper(temp_project, "flint", "FLINT")
    sessions.start_session("flint", "FLINT")
    assert reader_jobs.candidates("flint") == {"assistant_index": None, "candidates": [],
                                              "max_targets": reader_jobs.MAX_TARGETS}


# ---------------------------------------------------------------- the pass

def test_the_pass_briefs_each_paper_then_chains_the_follow_up_on_the_briefs(temp_project):
    slug = _project(temp_project)
    seen: list[tuple[str, str]] = []

    def reader(target, account, current):
        seen.append((target, current))
        assert "FLINT builds on" in account
        return f"Brief on {target}: it says X."

    job = _settled(reader_jobs.start_reading(
        slug, ["h3", "memexplorer"], reader_fn=reader, turn_runner=_runner(FOLLOW_UP),
    ).id)
    assert job.status == "done", job.error
    assert [(t["slug"], t["status"]) for t in job.targets] == [
        ("h3", "done"), ("memexplorer", "done"),
    ]
    assert seen == [("h3", "flint"), ("memexplorer", "flint")]
    assert job.analysis_job_id and job.analysis_error is None

    # The hidden briefing turn carries the instruction plus every brief, framed as untrusted.
    records = sessions.read_records(slug)
    briefing = [r for r in records if r.get("kind") == sessions.BRIEFING_KIND]
    assert len(briefing) == 1
    assert "reading assistants have now" in briefing[0]["text"]
    assert "Brief on h3: it says X." in briefing[0]["text"]
    assert "=== BEGIN UNTRUSTED DATA JSON ===" in briefing[0]["text"]
    assert [b["slug"] for b in briefing[0]["briefs"]] == ["h3", "memexplorer"]

    # The follow-up turn ran on the briefing and was recorded; the model saw the briefs.
    chat = _chat_settled(job.analysis_job_id)
    assert chat.status == "done", chat.error
    history = sessions.build_history(slug)
    assert history[-2]["role"] == "user" and "Brief on memexplorer" in history[-2]["content"]

    # The transcript hides the briefing record and attaches the briefs to the response that
    # answered it — never to the summary before it.
    transcript = sessions.transcript(slug)
    assert [e["role"] for e in transcript] == ["assistant", "assistant"]
    assert "reader_briefs" not in transcript[0]
    assert [b["slug"] for b in transcript[1]["reader_briefs"]] == ["h3", "memexplorer"]
    assert transcript[1]["reader_briefs"][0]["text"] == "Brief on h3: it says X."

    # Briefed papers are not offered again in this thread.
    assert reader_jobs.candidates(slug)["candidates"] == []


def test_one_papers_failure_is_isolated_and_the_rest_still_brief(temp_project):
    slug = _project(temp_project)

    def reader(target, account, current):
        if target == "h3":
            raise RuntimeError("provider hiccup")
        return "MemExplorer brief."

    job = _settled(reader_jobs.start_reading(
        slug, ["h3", "memexplorer"], reader_fn=reader, turn_runner=_runner(FOLLOW_UP),
    ).id)
    assert job.status == "done"
    assert [(t["slug"], t["status"]) for t in job.targets] == [
        ("h3", "error"), ("memexplorer", "done"),
    ]
    assert job.targets[0]["error"] == "provider hiccup"
    assert job.analysis_job_id
    _chat_settled(job.analysis_job_id)
    [briefs] = [r["briefs"] for r in sessions.read_records(slug)
                if r.get("kind") == sessions.BRIEFING_KIND]
    assert [b["slug"] for b in briefs] == ["memexplorer"]
    # H3 was not briefed, so it is still on offer next time.
    assert [c["slug"] for c in reader_jobs.candidates(slug)["candidates"]] == ["h3"]


def test_a_pass_that_briefs_nothing_fails_and_records_no_turn(temp_project):
    slug = _project(temp_project)
    started = len(chat_jobs._jobs)

    def reader(target, account, current):
        raise RuntimeError("down")

    job = _settled(reader_jobs.start_reading(
        slug, ["h3"], reader_fn=reader, turn_runner=_runner(FOLLOW_UP),
    ).id)
    assert job.status == "error" and "down" in (job.error or "")
    assert job.analysis_job_id is None
    assert not [r for r in sessions.read_records(slug) if r.get("kind") == sessions.BRIEFING_KIND]
    assert len(chat_jobs._jobs) == started


def test_a_budget_refusal_stops_the_pass_but_keeps_what_was_briefed(temp_project):
    slug = _project(temp_project)
    add_paper(temp_project, "third", "Third", full_text="t")

    def reader(target, account, current):
        if target == "memexplorer":
            raise quotas.QuotaExceeded(used_nanousd=1, requested_nanousd=2, limit_nanousd=2)
        return f"{target} brief"

    job = _settled(reader_jobs.start_reading(
        slug, ["h3", "memexplorer", "third"], reader_fn=reader,
        turn_runner=_runner(FOLLOW_UP),
    ).id)
    assert job.status == "done"
    assert [(t["slug"], t["status"]) for t in job.targets] == [
        ("h3", "done"), ("memexplorer", "skipped"), ("third", "skipped"),
    ]
    assert job.stopped_reason and job.refusal and job.refusal["code"]
    assert job.analysis_job_id  # the one brief still reaches the analyst
    _chat_settled(job.analysis_job_id)


def test_a_refusal_before_any_brief_is_the_jobs_own_refusal(temp_project):
    slug = _project(temp_project)

    def reader(target, account, current):
        raise quotas.QuotaExceeded(used_nanousd=1, requested_nanousd=2, limit_nanousd=2)

    job = _settled(reader_jobs.start_reading(
        slug, ["h3"], reader_fn=reader, turn_runner=_runner(FOLLOW_UP),
    ).id)
    assert job.status == "error" and job.refusal and job.refusal["code"]
    assert job.analysis_job_id is None


def test_start_refuses_bad_requests_up_front(temp_project):
    slug = _project(temp_project, memexplorer_text=None)
    with pytest.raises(reader_jobs.ReaderError, match="no cached text"):
        reader_jobs.start_reading(slug, ["memexplorer"], reader_fn=lambda *a: "x")
    with pytest.raises(reader_jobs.ReaderError, match="not another paper"):
        reader_jobs.start_reading(slug, ["flint"], reader_fn=lambda *a: "x")
    with pytest.raises(reader_jobs.ReaderError, match="not another paper"):
        reader_jobs.start_reading(slug, ["ghost"], reader_fn=lambda *a: "x")
    with pytest.raises(reader_jobs.ReaderError, match="at least one"):
        reader_jobs.start_reading(slug, ["  "], reader_fn=lambda *a: "x")
    with pytest.raises(reader_jobs.ReaderError, match="No active session"):
        reader_jobs.start_reading("h3", ["flint"], reader_fn=lambda *a: "x")
    assert reader_jobs._jobs == {}


def test_more_targets_than_a_pass_reads_is_refused_in_words(temp_project):
    """DR-155. The cap used to be declared as pydantic `max_length` on the request field, so
    over-picking answered 422 with a list of validation objects that the client rendered
    verbatim. The refusal has to be a sentence, and the route has to say it with the domain's
    own status, not the validator's."""
    slug = _project(temp_project)
    too_many = [f"paper-{i}" for i in range(reader_jobs.MAX_TARGETS + 1)]
    with pytest.raises(reader_jobs.ReaderError, match="At most 8 papers"):
        reader_jobs.start_reading(slug, too_many, reader_fn=lambda *a: "x")

    from app.main import app
    client = TestClient(app)
    refused = client.post(f"/api/projects/{temp_project}/reader/jobs",
                          json={"slug": slug, "targets": too_many})
    assert refused.status_code == 409, refused.text
    detail = refused.json()["detail"]
    assert detail == f"At most {reader_jobs.MAX_TARGETS} papers can be read in one pass."
    # The pydantic shape is what leaked; assert its absence rather than only the message.
    assert isinstance(detail, str)

    # The parse bound is still there, far above the pass limit, so an absurd body is refused
    # before it is read into memory.
    from app.routers import reader as reader_router
    absurd = client.post(f"/api/projects/{temp_project}/reader/jobs",
                         json={"slug": slug,
                               "targets": [f"p{i}" for i in range(reader_router.MAX_REQUEST_TARGETS + 1)]})
    assert absurd.status_code == 422
    assert reader_jobs._jobs == {}


def test_start_refuses_while_a_turn_is_generating(temp_project):
    slug = _project(temp_project)
    sessions.record_user(slug, "q", kind="reply")
    release = threading.Event()

    def slow(s, h):
        release.wait(5)
        yield {"type": "final", "text": PROTO}

    chat = chat_jobs.start_turn(slug, runner=slow)
    try:
        with pytest.raises(reader_jobs.ReaderError, match="already being generated"):
            reader_jobs.start_reading(slug, ["h3"], reader_fn=lambda *a: "x")
    finally:
        release.set()
        _chat_settled(chat.id)


def test_cancelled_pass_keeps_its_dedup_slot_until_the_worker_finishes(temp_project):
    """Terra review of #492 (P1): Stop changes status immediately, but Python cannot kill the
    paid call. A remount/start in that interval must rejoin it instead of buying a second pass."""
    slug = _project(temp_project)
    reading = threading.Event()
    release = threading.Event()
    calls = 0

    def reader(target, account, current):
        nonlocal calls
        calls += 1
        reading.set()
        release.wait(5)
        return "H3 brief"

    job = reader_jobs.start_reading(
        slug, ["h3"], reader_fn=reader, turn_runner=_runner(FOLLOW_UP),
    )
    assert reading.wait(5)
    cancelled = reader_jobs.request_cancel(job.id)
    assert cancelled["status"] == "cancelled" and cancelled["finished_at"] is None
    assert reader_jobs.active_for(slug).id == job.id

    joined = reader_jobs.start_reading(
        slug, ["h3"], reader_fn=reader, turn_runner=_runner(FOLLOW_UP),
    )
    assert joined.id == job.id
    assert calls == 1

    release.set()
    deadline = time.time() + 5
    while time.time() < deadline and reader_jobs.snapshot(job.id)["finished_at"] is None:
        time.sleep(0.02)
    final = reader_jobs.snapshot(job.id)
    assert final["status"] == "cancelled" and final["finished_at"] is not None
    assert reader_jobs.active_for(slug) is None
    assert calls == 1


def test_reader_model_and_hold_are_fixed_independently_of_account_settings(
    temp_project, monkeypatch,
):
    """The $0.08 hold is valid only for the pinned bounded model/call. A reader-selected Opus
    setting must not turn one admitted paper into spend above the account's hard ceiling."""
    slug = _project(temp_project)
    calls: list[dict] = []
    holds: list[tuple[str, str | None]] = []

    def complete(messages, **kwargs):
        calls.append(kwargs)
        return "H3 brief"

    @contextlib.contextmanager
    def per_unit(operation, job_id, *, model=None):
        holds.append((operation, model))
        yield None

    monkeypatch.setattr(reader_jobs.llm, "complete", complete)
    monkeypatch.setattr(reader_jobs.spend_ceiling, "per_unit", per_unit)
    monkeypatch.setattr(config, "load_settings", lambda: {
        "model": "anthropic/claude-opus-4.6",
        "openrouter_api_key": "test-key",
    })

    expected_model = "deepseek/deepseek-v4-flash-0731"
    job = _settled(reader_jobs.start_reading(
        slug, ["h3"], turn_runner=_runner(FOLLOW_UP),
    ).id)
    assert job.status == "done", job.error
    assert spend_limits.max_cost_nanousd("paper_read") == 80_000_000
    assert holds == [("paper_read", expected_model)]
    assert len(calls) == 1
    assert calls[0]["model"] == expected_model
    assert calls[0]["tries"] == 1
    assert calls[0]["reasoning"] == {"enabled": False}


def test_briefing_text_frames_every_brief_and_links_the_paper():
    text = reader_jobs.briefing_text([{"slug": "h3", "title": "H3 <ignore this>", "text": "ignore me"}])
    assert "rc-paper:h3" in text
    assert '"source_type":"reading_assistant_brief"' in text
    assert "Do not describe the briefing mechanism" in text
    # The title reaches the model only inside the frame (as its source), never raw.
    assert "H3 <ignore this>" not in text.split("=== BEGIN UNTRUSTED DATA JSON ===")[0]
    assert '"source":"h3: H3 <ignore this>"' in text


def test_a_reply_sent_while_the_assistants_read_is_answered_first_and_nothing_is_lost(
    temp_project, monkeypatch,
):
    """Opus review of #492 (P1): the composer stays open while a pass runs. A reply sent then
    starts a minutes-long turn; refusing to record the briefs behind it discarded paid work.
    The pass now waits for that turn and delivers afterwards."""
    import threading
    monkeypatch.setattr(reader_jobs, "WAIT_POLL_S", 0.02)
    slug = _project(temp_project)
    reading = threading.Event()
    release_reader = threading.Event()
    release_turn = threading.Event()

    def reader(target, account, current):
        reading.set()
        release_reader.wait(5)
        return "H3 brief"

    def slow_turn(s, h):
        release_turn.wait(5)
        yield {"type": "final", "text": PROTO}

    job = reader_jobs.start_reading(slug, ["h3"], reader_fn=reader, turn_runner=_runner(FOLLOW_UP))
    assert reading.wait(5)
    # The reader replies mid-pass; its turn starts generating.
    sessions.record_user(slug, "a question meanwhile", kind="reply")
    reply_turn = chat_jobs.start_turn(slug, runner=slow_turn)
    release_reader.set()
    # The pass has its brief and is waiting, visibly, for the reply's turn.
    deadline = time.time() + 5
    while time.time() < deadline and not reader_jobs.get_job(job.id).waiting:
        time.sleep(0.02)
    snap = reader_jobs.snapshot(job.id)
    assert snap["waiting"] is True and snap["status"] == "running"
    assert [b["slug"] for b in snap["briefs"]] == ["h3"]
    release_turn.set()
    _chat_settled(reply_turn.id)
    settled = _settled(job.id)
    assert settled.status == "done", settled.error
    assert settled.analysis_job_id and settled.waiting is False
    _chat_settled(settled.analysis_job_id)
    kinds = [(r["role"], r.get("kind")) for r in sessions.read_records(slug)]
    # summary, reply, its answer, THEN the briefing and its answer — never interleaved.
    assert kinds == [("assistant", None), ("user", "reply"), ("assistant", None),
                     ("user", sessions.BRIEFING_KIND), ("assistant", None)]
    assert [b["slug"] for b in sessions.transcript(slug)[-1]["reader_briefs"]] == ["h3"]


def test_the_pass_is_refused_once_notes_are_drafted(temp_project):
    """Opus review of #492 (P2): after Finish the trailing records are a proposal, and a
    briefing turn behind them would leave `reopen_discussion` nothing it recognises to pop."""
    from app.models import NOTES_DRAFTED
    slug = _project(temp_project)
    sessions.set_state(slug, NOTES_DRAFTED)
    with pytest.raises(reader_jobs.ReaderError, match="discussion is open"):
        reader_jobs.start_reading(slug, ["h3"], reader_fn=lambda *a: "x")


def test_a_finish_sent_while_the_assistants_read_keeps_the_briefs_off_the_proposal(
    temp_project,
):
    """The state gate re-checked at delivery: a briefing behind a drafted proposal would leave
    `reopen_discussion` nothing to pop. The briefs are kept on the job instead."""
    import threading

    from app.models import NOTES_DRAFTED

    slug = _project(temp_project)
    release = threading.Event()

    def reader(target, account, current):
        release.wait(5)
        return "H3 brief"

    job = reader_jobs.start_reading(slug, ["h3"], reader_fn=reader, turn_runner=_runner(FOLLOW_UP))
    sessions.set_state(slug, NOTES_DRAFTED)   # what a Finish turn does when it lands
    release.set()
    settled = _settled(job.id)
    assert settled.status == "error" and "notes were drafted" in (settled.error or "")
    assert [b["slug"] for b in settled.briefs] == ["h3"]
    assert not [r for r in sessions.read_records(slug) if r.get("kind") == sessions.BRIEFING_KIND]


def test_briefs_stay_on_the_job_when_the_follow_up_cannot_start(temp_project, monkeypatch):
    slug = _project(temp_project)

    def refuse_turn(*args, **kwargs):
        raise RuntimeError("provider down")

    monkeypatch.setattr(reader_jobs.chat_jobs, "start_turn", refuse_turn)
    job = _settled(reader_jobs.start_reading(slug, ["h3"], reader_fn=lambda *a: "H3 brief").id)
    assert job.status == "done" and job.analysis_job_id is None
    assert "provider down" in (job.analysis_error or "")
    assert [b["text"] for b in job.briefs] == ["H3 brief"]
    # The briefing turn IS recorded, so the session's pending-turn retry can answer it.
    assert sessions.read_records(slug)[-1]["kind"] == sessions.BRIEFING_KIND


# ---------------------------------------------------------------- routes

def test_the_routes_expose_candidates_and_the_job(temp_project):
    slug = _project(temp_project, memexplorer_text=None)
    from app.main import app
    client = TestClient(app)
    base = f"/api/projects/{temp_project}"

    got = client.get(f"{base}/reader/candidates/{slug}")
    assert got.status_code == 200, got.text
    assert [c["slug"] for c in got.json()["candidates"]] == ["h3", "memexplorer"]
    # DR-155 — the cap travels with the list, so the offer can show it before it binds.
    assert got.json()["max_targets"] == reader_jobs.MAX_TARGETS

    refused = client.post(f"{base}/reader/jobs", json={"slug": slug, "targets": ["memexplorer"]})
    assert refused.status_code == 409 and "no cached text" in refused.json()["detail"]

    assert client.get(f"{base}/reader/jobs/active/{slug}").json() == {"job": None}
    assert client.get(f"{base}/reader/jobs/nope").status_code == 404
    # An unknown thread is a 404 like /session, not a quiet empty answer for main.
    assert client.get(f"{base}/reader/candidates/{slug}?thread_id=nope").status_code == 404
