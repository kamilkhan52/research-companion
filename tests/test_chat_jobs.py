"""chat_jobs: the background-thread chat turn that decouples response generation from any
single HTTP connection. A turn streamed over one live SSE request died with the connection
(confirmed live: the Cloudflare edge canceled a reply_stream ~3 minutes in) and the
un-persisted response vanished from the transcript. This drives a REAL background thread with
injected runners (zero network) and confirms turns finish and are RECORDED to the session no
matter what any client does, items interleave canonical-only text with tool calls, failures
surface as error jobs without touching the session, and concurrent starts join the in-flight
job."""
from __future__ import annotations

import threading
import time

import pytest
from app import chat_jobs, sessions

PROTO = "### CANONICAL ###\nThe answer.\n### STATE ###\nin_discussion\n### END ###"


@pytest.fixture(autouse=True)
def _clear_jobs():
    chat_jobs._jobs.clear()
    yield
    chat_jobs._jobs.clear()


def _session_with_reply(slug: str = "p") -> str:
    sessions.start_session(slug, "Paper P")
    sessions.record_user(slug, "a question", kind="reply")
    return slug


def _sync_runner(events):
    return lambda slug, history: iter(events)


def _async_runner(events):
    def make(slug, history):
        async def gen():
            for ev in events:
                yield ev
        return gen()
    return make


def _wait_until_settled(job_id: str, timeout: float = 5.0) -> chat_jobs.ChatJob:
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = chat_jobs.get_job(job_id)
        if job and job.status != "running":
            return job
        time.sleep(0.02)
    raise TimeoutError(f"chat job {job_id} did not settle within {timeout}s")


def test_turn_is_recorded_even_if_no_client_ever_polls(temp_project):
    slug = _session_with_reply()
    events = [{"type": "text", "text": piece} for piece in (PROTO[:40], PROTO[40:])]
    events.append({"type": "final", "text": PROTO})

    job = chat_jobs.start_turn(slug, runner=_sync_runner(events))
    finished = _wait_until_settled(job.id)

    assert finished.status == "done"
    assert finished.turn and finished.turn["canonical"] == "The answer."
    assert finished.state == "in_discussion"
    # The whole point: the turn is in the session file regardless of any client/connection.
    records = sessions.read_records(slug)
    assert records[-1]["role"] == "assistant"
    assert records[-1]["canonical"] == "The answer."


def test_items_interleave_tool_calls_with_canonical_only_text(temp_project):
    slug = _session_with_reply()
    full = "### CANONICAL ###\nPart one. Part two.\n### STATE ###\nin_discussion\n### END ###"
    events = [
        {"type": "text", "text": "### CANONICAL ###\nPart one. "},
        {"type": "tool", "name": "web_search", "detail": "deepspeed inference adoption"},
        {"type": "text", "text": "Part two.\n### STATE ###\nin_discussion\n### END ###"},
        {"type": "final", "text": full},
    ]

    job = chat_jobs.start_turn(slug, runner=_async_runner(events))
    finished = _wait_until_settled(job.id)

    assert finished.status == "done"
    assert [it["kind"] for it in finished.items] == ["text", "tool", "text"]
    assert finished.items[1]["name"] == "web_search"
    # Only CANONICAL text ever reaches items — never the protocol scaffolding.
    joined = "".join(it["text"] for it in finished.items if it["kind"] == "text")
    assert joined.strip() == "Part one. Part two."
    assert "###" not in joined


def test_runner_failure_is_an_error_job_and_session_is_untouched(temp_project):
    slug = _session_with_reply()

    def exploding(slug_, history):
        yield {"type": "text", "text": "### CANONICAL ###\nHalf an ans"}
        raise chat_jobs.AgentError("Agentic stream failed: boom")

    job = chat_jobs.start_turn(slug, runner=lambda s, h: exploding(s, h))
    finished = _wait_until_settled(job.id)

    assert finished.status == "error"
    assert "boom" in (finished.error or "")
    # Partial live text is kept on the job for context, but nothing was recorded.
    assert sessions.read_records(slug)[-1]["role"] == "user"


def test_empty_canonical_is_an_error_not_a_recorded_blank_turn(temp_project):
    slug = _session_with_reply()
    job = chat_jobs.start_turn(slug, runner=_sync_runner([{"type": "final", "text": ""}]))
    finished = _wait_until_settled(job.id)

    assert finished.status == "error"
    assert "empty response" in (finished.error or "")
    assert sessions.read_records(slug)[-1]["role"] == "user"


def test_second_start_for_same_slug_joins_the_running_job(temp_project):
    slug = _session_with_reply()
    release = threading.Event()

    def slow(slug_, history):
        release.wait(5)
        yield {"type": "final", "text": PROTO}

    first = chat_jobs.start_turn(slug, runner=lambda s, h: slow(s, h))
    second = chat_jobs.start_turn(slug, runner=_sync_runner([]))
    assert second is first  # joined, not duplicated
    assert chat_jobs.active_for(slug) is first

    release.set()
    assert _wait_until_settled(first.id).status == "done"
    assert chat_jobs.active_for(slug) is None


def test_snapshot_is_a_plain_dict_safe_for_polling(temp_project):
    slug = _session_with_reply()
    job = chat_jobs.start_turn(slug, runner=_sync_runner([{"type": "final", "text": PROTO}]))
    _wait_until_settled(job.id)

    snap = chat_jobs.snapshot(job.id)
    assert snap and snap["status"] == "done" and snap["slug"] == slug
    assert chat_jobs.snapshot("nope") is None
