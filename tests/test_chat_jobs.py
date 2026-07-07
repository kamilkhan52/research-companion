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
from types import SimpleNamespace

import pytest
from app import chat_jobs, preview_jobs, sessions
from app.routers import session as session_routes

PROTO = "### CANONICAL ###\nThe answer.\n### STATE ###\nin_discussion\n### END ###"


@pytest.fixture(autouse=True)
def _clear_jobs():
    chat_jobs._jobs.clear()
    preview_jobs._jobs.clear()
    preview_jobs._coordinator_jobs.clear()
    yield
    chat_jobs._jobs.clear()
    preview_jobs._jobs.clear()
    preview_jobs._coordinator_jobs.clear()


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


def test_failed_parent_suppresses_blocked_preview_before_publishing_error(
    temp_project, monkeypatch,
):
    slug = _session_with_reply()
    preview_started = threading.Event()
    release_preview = threading.Event()
    synth_calls = []
    monkeypatch.setattr(
        chat_jobs.config,
        "load_settings",
        lambda: {
            "speech_provider": "openai",
            "preview_model": "preview/model",
            "narration_model": "narration/model",
            "tts_model": "tts-model",
            "tts_voice": "voice",
        },
    )
    monkeypatch.setattr(chat_jobs, "PREVIEW_CADENCE_SECONDS", 0)

    def blocked_preview(messages, model):
        preview_started.set()
        release_preview.wait(5)
        return '{"cue":"Grounded cue.","source_sentence_ids":["s0001"]}'

    monkeypatch.setattr(preview_jobs, "_default_generate", blocked_preview)
    monkeypatch.setattr(
        preview_jobs.tts,
        "openai_speech",
        lambda cue: synth_calls.append(cue) or b"mp3",
    )

    def failing_after_preview(slug_, history):
        yield {"type": "text", "text": "### CANONICAL ###\nGrounded cue. "}
        yield {"type": "text", "text": "More analysis is coming"}
        assert preview_started.wait(5)
        raise chat_jobs.AgentError("analysis failed after preview")

    job = chat_jobs.start_turn(
        slug,
        runner=lambda s, h: failing_after_preview(s, h),
        delivery_mode="listening",
    )
    finished = _wait_until_settled(job.id)
    assert finished.status == "error"
    assert finished.preview_job_ids

    release_preview.set()
    deadline = time.time() + 5
    cue_job = None
    while time.time() < deadline:
        cue_job = preview_jobs.get_job(finished.preview_job_ids[0])
        if cue_job and cue_job.status != "running":
            break
        time.sleep(0.02)
    assert cue_job and cue_job.status == "done"
    assert cue_job.suppressed is True
    assert cue_job.url is None
    assert synth_calls == []
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


def test_listening_turn_starts_audio_after_recording(temp_project, monkeypatch):
    slug = _session_with_reply()
    captured = {}
    monkeypatch.setattr(
        chat_jobs.config,
        "load_settings",
        lambda: {"speech_provider": "openai"},
    )

    def fake_audio(text, billing_project=None):
        assert sessions.read_records(slug)[-1]["role"] == "assistant"
        captured.update(text=text, billing_project=billing_project)
        return SimpleNamespace(id="audio-job")

    monkeypatch.setattr(chat_jobs.audio_jobs, "start_job", fake_audio)
    job = chat_jobs.start_turn(
        slug,
        runner=_sync_runner([{"type": "final", "text": PROTO}]),
        delivery_mode="listening",
    )
    finished = _wait_until_settled(job.id)

    assert finished.audio_job_id == "audio-job"
    assert finished.audio_error is None
    assert finished.assistant_index == 0
    assert captured == {"text": "The answer.", "billing_project": temp_project}
    transcript = sessions.transcript(slug)
    assert transcript[-1]["assistant_index"] == 0
    assert transcript[-1]["delivery_mode"] == "listening"
    assert transcript[-1]["chat_job_id"] == finished.id
    assert transcript[-1]["audio_job_id"] == "audio-job"


def test_reading_turn_does_not_start_audio(temp_project, monkeypatch):
    slug = _session_with_reply()
    monkeypatch.setattr(
        chat_jobs.audio_jobs,
        "start_job",
        lambda *args, **kwargs: pytest.fail("reading turn started audio"),
    )
    job = chat_jobs.start_turn(slug, runner=_sync_runner([{"type": "final", "text": PROTO}]))
    assert _wait_until_settled(job.id).audio_job_id is None


def test_listening_turn_starts_grounded_preview_without_blocking_analysis(
    temp_project, monkeypatch,
):
    slug = _session_with_reply()
    captured = {}
    coordinator = {}
    monkeypatch.setattr(
        chat_jobs.config,
        "load_settings",
        lambda: {"speech_provider": "openai", "tts_model": "m", "tts_voice": "v"},
    )
    monkeypatch.setattr(chat_jobs, "PREVIEW_CADENCE_SECONDS", 0)

    monkeypatch.setattr(
        chat_jobs.preview_jobs,
        "research_sources",
        lambda slug: [{"id": "project0001", "text": "Prior work.",
                       "kind": "prior_project_context"}],
    )

    def fake_preview(chat_job_id, ordinal, sentences, previous_cue, progress):
        captured.update(
            chat_job_id=chat_job_id,
            ordinal=ordinal,
            sentences=sentences,
            previous_cue=previous_cue,
            progress=progress,
        )
        return SimpleNamespace(id="preview-job")

    monkeypatch.setattr(chat_jobs.preview_jobs, "start_job", fake_preview)
    monkeypatch.setattr(
        chat_jobs.preview_jobs, "get_job",
        lambda job_id: SimpleNamespace(status="running", cue=None),
    )
    def fake_coordinator(chat_id, audio_id, sources, existing_ids, publish, **kwargs):
        coordinator.update(
            chat_id=chat_id,
            audio_id=audio_id,
            sources=sources,
            existing_ids=existing_ids,
            kwargs=kwargs,
        )
        return SimpleNamespace(id="coordinator-job")

    monkeypatch.setattr(chat_jobs.preview_jobs, "start_coordinator", fake_coordinator)
    monkeypatch.setattr(
        chat_jobs.audio_jobs,
        "start_job",
        lambda *args, **kwargs: SimpleNamespace(id="audio-job"),
    )
    full = ("### CANONICAL ###\nThe first finding is grounded. The second finding is ready. "
            "\n### STATE ###\nin_discussion\n### END ###")
    events = [
        {"type": "text", "text": "### CANONICAL ###\nThe first finding is grounded. "},
        {"type": "text", "text": "The second finding is ready. "},
        {"type": "final", "text": full},
    ]

    job = chat_jobs.start_turn(slug, runner=_sync_runner(events), delivery_mode="listening")
    finished = _wait_until_settled(job.id)

    assert finished.status == "done"
    assert finished.preview_job_ids == ["preview-job"]
    assert captured == {
        "chat_job_id": job.id,
        "ordinal": 1,
        "sentences": [
            {"id": "s0001", "text": "The first finding is grounded.",
             "kind": "live_response"},
            {"id": "project0001", "text": "Prior work.",
             "kind": "prior_project_context"},
        ],
        "previous_cue": "",
        "progress": {
            "phase": "analysis",
            "completed_response_sentences": 1,
            "remaining_known": False,
        },
    }
    assert coordinator["audio_id"] == "audio-job"
    assert coordinator["existing_ids"] == ["preview-job"]
    assert [source["kind"] for source in coordinator["sources"]] == [
        "live_response", "live_response", "prior_project_context",
    ]
    assert finished.preview_complete is False
    assert finished.preview_coordinator_id == "coordinator-job"


def test_preview_cadence_uses_new_sentences_context_and_previous_cue(monkeypatch):
    job = chat_jobs.ChatJob(id="chat-1", delivery_mode="listening")
    job._preview_enabled = True
    job._preview_last_started = 0.0
    job._preview_next_sentence = 0
    job._preview_context = [
        {"id": "project0001", "text": "Prior work.", "kind": "prior_project_context"}
    ]
    calls = []
    monkeypatch.setattr(chat_jobs, "PREVIEW_CADENCE_SECONDS", 3)
    monkeypatch.setattr(chat_jobs.time, "monotonic", lambda: 20.0 + len(calls) * 3)

    def fake_start(chat_job_id, ordinal, sentences, previous_cue, progress):
        calls.append((chat_job_id, ordinal, sentences, previous_cue, progress))
        return SimpleNamespace(id=f"preview-{ordinal}")

    monkeypatch.setattr(chat_jobs.preview_jobs, "start_job", fake_start)
    monkeypatch.setattr(
        chat_jobs.preview_jobs,
        "get_job",
        lambda job_id: SimpleNamespace(status="done", cue=f"spoken {job_id}"),
    )

    chat_jobs._maybe_start_preview(job, "One. fragment")
    chat_jobs._maybe_start_preview(job, "One. Two. fragment")
    chat_jobs._maybe_start_preview(job, "One. Two. Three. fragment")
    chat_jobs._maybe_start_preview(job, "One. Two. Three. Four. fragment")

    assert job.preview_job_ids == ["preview-1", "preview-2", "preview-3", "preview-4"]
    assert calls[0][2] == [
        {"id": "s0001", "text": "One.", "kind": "live_response"},
        {"id": "project0001", "text": "Prior work.", "kind": "prior_project_context"},
    ]
    assert calls[1][2][0] == {"id": "s0002", "text": "Two.", "kind": "live_response"}
    assert calls[1][3] == "spoken preview-1"
    assert calls[1][4]["completed_response_sentences"] == 2
    assert all(call[0] == "chat-1" for call in calls)


def test_audio_start_failure_does_not_fail_recorded_listening_turn(temp_project, monkeypatch):
    slug = _session_with_reply()
    monkeypatch.setattr(
        chat_jobs.config,
        "load_settings",
        lambda: {"speech_provider": "openai"},
    )
    def fail_audio(*args, **kwargs):
        raise RuntimeError("TTS unavailable")

    monkeypatch.setattr(chat_jobs.audio_jobs, "start_job", fail_audio)
    job = chat_jobs.start_turn(
        slug,
        runner=_sync_runner([{"type": "final", "text": PROTO}]),
        delivery_mode="listening",
    )
    finished = _wait_until_settled(job.id)

    assert finished.status == "done"
    assert finished.audio_job_id is None
    assert "TTS unavailable" in (finished.audio_error or "")
    assert sessions.read_records(slug)[-1]["canonical"] == "The answer."
    transcript = sessions.transcript(slug)
    assert transcript[-1]["audio_job_id"] is None
    assert "TTS unavailable" in transcript[-1]["audio_error"]


def test_job_route_passes_listening_delivery_mode(temp_project, monkeypatch):
    slug = _session_with_reply()
    captured = {}

    def fake_start(target, delivery_mode="reading"):
        captured.update(slug=target, delivery_mode=delivery_mode)
        return SimpleNamespace(id="chat-job")

    monkeypatch.setattr(chat_jobs, "start_turn", fake_start)
    monkeypatch.setattr(chat_jobs, "snapshot", lambda job_id: {"id": job_id})
    response = session_routes.continue_job(
        session_routes.FinishReq(slug=slug, delivery_mode="listening")
    )

    assert response == {"job": {"id": "chat-job"}}
    assert captured == {"slug": slug, "delivery_mode": "listening"}
