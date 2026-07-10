"""Stop button (polish plan round 2, F.1): a running chat turn can be cancelled best-effort.
The worker stops at its next event boundary, records whatever canonical text already streamed
marked as stopped, and never advances session state or starts audio/cue work. An empty partial
records nothing. Uses the same injected-runner seam as test_chat_jobs (zero network)."""
from __future__ import annotations

import threading
import time

import pytest
from app import chat_jobs, preview_jobs, sessions

PROTO_PREFIX = "### CANONICAL ###\nFirst part of the answer."


@pytest.fixture(autouse=True)
def _clear_jobs():
    chat_jobs._jobs.clear()
    preview_jobs._jobs.clear()
    yield
    chat_jobs._jobs.clear()
    preview_jobs._jobs.clear()


def _session_with_reply(slug: str = "p") -> str:
    sessions.start_session(slug, "Paper P")
    sessions.record_user(slug, "a question", kind="reply")
    return slug


def _wait_until_settled(job_id: str, timeout: float = 5.0) -> chat_jobs.ChatJob:
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = chat_jobs.get_job(job_id)
        if job and job.status != "running":
            return job
        time.sleep(0.02)
    raise TimeoutError(f"chat job {job_id} did not settle within {timeout}s")


def _gated_runner(first_events, gate: threading.Event, rest_events):
    """Yield `first_events`, then block on `gate`, then yield `rest_events` — so the test can
    cancel deterministically between the two batches."""
    def make(slug, history):
        def gen():
            yield from first_events
            gate.wait(timeout=5)
            yield from rest_events
        return gen()
    return make


def test_cancel_mid_stream_records_partial_marked_as_stopped(temp_project):
    slug = _session_with_reply()
    gate = threading.Event()
    runner = _gated_runner(
        [{"type": "text", "text": PROTO_PREFIX}],
        gate,
        [{"type": "text", "text": " The rest never arrives."},
         {"type": "final", "text": PROTO_PREFIX + " The rest never arrives."}],
    )

    job = chat_jobs.start_turn(slug, runner=runner)
    deadline = time.time() + 5
    while not chat_jobs.get_job(job.id).items and time.time() < deadline:
        time.sleep(0.02)

    assert chat_jobs.request_cancel(job.id)["cancelled"] is True
    gate.set()
    finished = _wait_until_settled(job.id)

    assert finished.status == "done"
    assert finished.cancelled is True
    assert chat_jobs.STOP_MARKER in finished.turn["canonical"]
    assert finished.turn["canonical"].startswith("First part of the answer.")
    # No audio or cue work for a stopped turn.
    assert finished.audio_job_id is None
    assert finished.preview_complete is True
    records = sessions.read_records(slug)
    assert records[-1]["role"] == "assistant"
    assert chat_jobs.STOP_MARKER in records[-1]["canonical"]


def test_cancel_before_any_text_records_nothing(temp_project):
    slug = _session_with_reply()
    gate = threading.Event()
    runner = _gated_runner([], gate, [{"type": "final", "text": "### CANONICAL ###\nNever."}])

    job = chat_jobs.start_turn(slug, runner=runner)
    assert chat_jobs.request_cancel(job.id)["cancelled"] is True
    gate.set()
    finished = _wait_until_settled(job.id)

    assert finished.status == "done"
    assert finished.turn is None
    records = sessions.read_records(slug)
    assert records[-1]["role"] == "user"  # the question stands, unanswered


def test_stopped_partial_never_advances_session_state(temp_project):
    slug = _session_with_reply()
    gate = threading.Event()
    # The partial happens to contain a complete-looking commit proposal; stop must not act on it.
    partial = ("### CANONICAL ###\nDraft so far.\n### STATE ###\nready_to_draft_notes\n"
               "### PROPOSED_COMMIT ###\n{\"summary\": \"x\"}\n### END ###")
    runner = _gated_runner([{"type": "text", "text": partial}], gate, [])

    job = chat_jobs.start_turn(slug, runner=runner)
    deadline = time.time() + 5
    while not chat_jobs.get_job(job.id).items and time.time() < deadline:
        time.sleep(0.02)
    chat_jobs.request_cancel(job.id)
    gate.set()
    finished = _wait_until_settled(job.id)

    assert finished.status == "done"
    assert finished.turn["proposed_commit"] is None
    assert sessions.get_state(slug) != "notes_drafted"


def test_cancel_unknown_job_and_settled_job(temp_project):
    assert chat_jobs.request_cancel("nope") is None
    slug = _session_with_reply()
    events = [{"type": "final", "text": "### CANONICAL ###\nDone.\n### END ###"}]
    job = chat_jobs.start_turn(slug, runner=lambda s, h: iter(events))
    finished = _wait_until_settled(job.id)
    assert finished.status == "done"
    # Cancelling after settle is a no-op: flag stays false, turn stays recorded untouched.
    snap = chat_jobs.request_cancel(job.id)
    assert snap["cancelled"] is False
    assert snap["turn"]["canonical"] == "Done."
