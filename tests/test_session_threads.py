"""Independent paper discussions: isolated storage/jobs with one paper-level notes outcome."""
from __future__ import annotations

import threading
import time

import pytest
from app import chat_jobs, config, project_split, sessions
from app.models import Turn
from app.routers import session as session_routes
from fastapi import HTTPException

from tests.conftest import add_paper

PROTO = "### CANONICAL ###\nAnswer.\n### STATE ###\nin_discussion\n### END ###"


@pytest.fixture(autouse=True)
def _clear_chat_jobs():
    chat_jobs._jobs.clear()
    yield
    chat_jobs._jobs.clear()


def _paper_with_main(pid: str, slug: str = "paper") -> str:
    add_paper(pid, slug, "Threaded Paper", full_text="The complete paper body.")
    sessions.start_session(slug, "Threaded Paper")
    sessions.record_user(slug, "Main question", kind="reply")
    return slug


def _wait(job_id: str, timeout: float = 3.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = chat_jobs.get_job(job_id)
        if job and job.status != "running":
            return job
        time.sleep(0.01)
    raise TimeoutError(job_id)


def test_thread_ids_cannot_traverse_session_paths(temp_project):
    _paper_with_main(temp_project)
    for invalid in ("../escape", "a/b", "", "UPPER", "a" * 49):
        if invalid == "":
            # Omitted/empty is the explicit backwards-compatible alias for main.
            assert sessions.validate_thread_id(invalid) == sessions.MAIN_THREAD
        else:
            with pytest.raises(ValueError):
                sessions.validate_thread_id(invalid)


def test_threads_keep_transcripts_modes_and_full_text_context_isolated(temp_project):
    slug = _paper_with_main(temp_project)
    thread = sessions.create_thread(slug)

    with sessions.thread_scope(thread["id"]):
        sessions.record_user(slug, "Challenge the causal claim", kind="reply")
        sessions.set_reading_mode(slug, "technical")
        history = sessions.build_history(slug)
        assert "The complete paper body." in history[0]["content"]
        assert history[-1]["content"] == "Challenge the causal claim"
        assert sessions.get_reading_mode(slug) == "technical"
        assert sessions.transcript(slug) == [
            {"role": "user", "text": "Challenge the causal claim"},
        ]

    assert sessions.get_reading_mode(slug) == "balanced"
    assert sessions.transcript(slug) == [{"role": "user", "text": "Main question"}]
    rows = sessions.list_threads(slug)
    assert [row["id"] for row in rows] == ["main", thread["id"]]
    assert rows[1]["title"] == "Challenge the causal claim"


def test_session_route_returns_only_the_requested_thread(temp_project):
    slug = _paper_with_main(temp_project)
    created = session_routes.create_thread(slug, session_routes.CreateThreadReq())
    thread_id = created["thread"]["id"]
    with sessions.thread_scope(thread_id):
        sessions.record_user(slug, "Independent question", kind="reply")

    side = session_routes.get_session(slug, thread_id)
    main = session_routes.get_session(slug)
    assert side["thread_id"] == thread_id
    assert side["transcript"] == [{"role": "user", "text": "Independent question"}]
    assert main["thread_id"] == "main"
    assert main["transcript"] == [{"role": "user", "text": "Main question"}]
    with pytest.raises(HTTPException) as unknown:
        session_routes.get_session(slug, "missing-thread")
    assert unknown.value.status_code == 404


def test_busy_relocation_refuses_a_turn_before_recording_user_text(temp_project):
    slug = _paper_with_main(temp_project)
    before = sessions.read_records(slug)
    assert config.mark_project_busy(temp_project)
    try:
        with pytest.raises(HTTPException) as busy:
            session_routes.reply_job(
                session_routes.ReplyReq(slug=slug, text="Must not land"),
            )
        assert busy.value.status_code == 409
    finally:
        config.unmark_project_busy(temp_project)
    assert sessions.read_records(slug) == before


def test_jobs_deduplicate_per_thread_not_per_paper(temp_project):
    slug = _paper_with_main(temp_project)
    thread = sessions.create_thread(slug)
    with sessions.thread_scope(thread["id"]):
        sessions.record_user(slug, "Side question", kind="reply")

    release = threading.Event()

    def runner(_slug, _history):
        release.wait(2)
        return iter(({"type": "final", "text": PROTO},))

    main_job = chat_jobs.start_turn(slug, runner=runner)
    with sessions.thread_scope(thread["id"]):
        side_job = chat_jobs.start_turn(slug, runner=runner)
        joined = chat_jobs.start_turn(slug, runner=runner)

    assert main_job.id != side_job.id
    assert joined.id == side_job.id
    assert chat_jobs.active_for(slug).id == main_job.id
    assert chat_jobs.active_for(slug, thread["id"]).id == side_job.id

    release.set()
    assert _wait(main_job.id).status == "done"
    assert _wait(side_job.id).status == "done"
    assert sessions.read_records(slug)[-1]["canonical"] == "Answer."
    with sessions.thread_scope(thread["id"]):
        assert sessions.read_records(slug)[-1]["canonical"] == "Answer."


def test_finishing_context_includes_other_threads_without_internal_prompts(temp_project):
    slug = _paper_with_main(temp_project)
    sessions.record_assistant(
        slug,
        Turn(
            role="assistant",
            canonical="Main insight",
            narration="",
            state_signal="in_discussion",
        ),
    )
    thread = sessions.create_thread(slug, "Counterargument")
    with sessions.thread_scope(thread["id"]):
        sessions.record_user(slug, "What would falsify it?", kind="reply")
        appendix = sessions.other_threads_context(slug)

    assert "Main discussion" in appendix
    assert "Main question" in appendix
    assert "Main insight" in appendix
    assert "finish_instruction" not in appendix


def test_paper_level_approval_rests_every_thread(temp_project):
    slug = _paper_with_main(temp_project)
    thread = sessions.create_thread(slug)
    with sessions.thread_scope(thread["id"]):
        sessions.set_state(slug, "notes_drafted")

    sessions.mark_committed(slug)

    assert sessions.get_state(slug) == "committed"
    with sessions.thread_scope(thread["id"]):
        assert sessions.get_state(slug) == "committed"


def test_copy_carries_every_thread_and_keeps_histories_independent(temp_project):
    slug = _paper_with_main(temp_project)
    thread = sessions.create_thread(slug)
    with sessions.thread_scope(thread["id"]):
        sessions.record_user(slug, "A side path", kind="reply")

    result = project_split.split_project(
        temp_project,
        "Thread copy",
        [slug],
        remove_from_source=False,
    )
    from app import config

    token = config.set_active_project(result["new_pid"])
    try:
        rows = sessions.list_threads(slug)
        assert [row["id"] for row in rows] == ["main", thread["id"]]
        with sessions.thread_scope(thread["id"]):
            assert sessions.transcript(slug) == [{"role": "user", "text": "A side path"}]
            sessions.record_user(slug, "Destination only", kind="reply")
    finally:
        config.reset_active_project(token)

    with sessions.thread_scope(thread["id"]):
        assert [r["text"] for r in sessions.read_records(slug) if r["role"] == "user"] == [
            "A side path",
        ]
