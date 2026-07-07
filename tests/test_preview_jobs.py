from __future__ import annotations

import json
import threading
import time

import pytest
from app import audio_jobs, config, preview_jobs, usage
from app.routers import session as session_routes
from fastapi import HTTPException


@pytest.fixture(autouse=True)
def _isolated_preview_state(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "APP_STATE_DIR", tmp_path)
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()
    monkeypatch.setattr(audio_jobs, "AUDIO_DIR", audio_dir)
    monkeypatch.setattr(
        config,
        "load_settings",
        lambda: {
            "preview_model": "preview/model",
            "narration_model": "narration/model",
            "tts_model": "tts-model",
            "tts_voice": "voice",
        },
    )
    preview_jobs._jobs.clear()
    yield
    preview_jobs._jobs.clear()


def _wait(job_id: str, timeout: float = 5.0) -> preview_jobs.PreviewJob:
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = preview_jobs.get_job(job_id)
        if job and job.status != "running":
            return job
        time.sleep(0.02)
    raise TimeoutError(job_id)


def test_preview_job_generates_validates_and_synthesizes_in_project(temp_project):
    captured = {}

    def generate(messages, model):
        captured.update(messages=messages, model=model, project=config.active_project_id())
        usage.record("listening_preview", model, {"prompt_tokens": 4, "cost": 0.001})
        return json.dumps({"cue": "Early results show a 12 percent gain.",
                           "source_sentence_ids": ["s0001"]})

    def synthesize(cue):
        captured["tts_project"] = config.active_project_id()
        return b"mp3:" + cue.encode()

    job = preview_jobs.start_job(
        "chat-1",
        1,
        [{"id": "s0001", "text": "Early results show a 12 percent gain."}],
        generate_fn=generate,
        synth_fn=synthesize,
    )
    finished = _wait(job.id)

    assert finished.status == "done"
    assert finished.cue == "Early results show a 12 percent gain."
    assert finished.source_sentence_ids == ["s0001"]
    assert finished.url and (audio_jobs.AUDIO_DIR / finished.url.rsplit("/", 1)[-1]).exists()
    assert captured["model"] == "preview/model"
    assert captured["project"] == temp_project
    assert captured["tts_project"] == temp_project
    assert usage.load()["by_operation"]["listening_preview"]["calls"] == 1
    payload = json.loads(captured["messages"][1]["content"])
    assert payload["completed_sentences"] == [
        {"id": "s0001", "text": "Early results show a 12 percent gain."}
    ]
    assert payload["previous_cue"] == ""


@pytest.mark.parametrize(
    ("raw", "message"),
    [
        ("not json", "malformed JSON"),
        (json.dumps({"cue": "Claim.", "source_sentence_ids": ["unknown"]}), "unknown"),
        (json.dumps({"cue": "It improves by 25%.", "source_sentence_ids": ["s0001"]}),
         "numeric claim"),
        (json.dumps({"cue": "x" * 241, "source_sentence_ids": ["s0001"]}), "exceeds"),
    ],
)
def test_preview_validation_rejects_ungrounded_or_invalid_output(raw, message):
    with pytest.raises(preview_jobs.PreviewError, match=message):
        preview_jobs.validate_result(raw, [{"id": "s0001", "text": "A grounded claim."}])


def test_completed_sentences_hold_back_the_streaming_fragment():
    assert preview_jobs.completed_sentences("First result. Second result is still") == [
        "First result."
    ]
    assert preview_jobs.completed_sentences("First result. Second result! More") == [
        "First result.",
        "Second result!",
    ]


def test_suppressed_preview_never_publishes_audio(temp_project):
    release = threading.Event()
    synth_calls = []

    def generate(messages, model):
        release.wait(5)
        return json.dumps({"cue": "Grounded update.", "source_sentence_ids": ["s0001"]})

    job = preview_jobs.start_job(
        "chat-1",
        1,
        [{"id": "s0001", "text": "Grounded update."}],
        generate_fn=generate,
        synth_fn=lambda cue: synth_calls.append(cue) or b"mp3",
    )
    preview_jobs.suppress([job.id])
    release.set()
    finished = _wait(job.id)

    assert finished.status == "done"
    assert finished.suppressed is True
    assert finished.url is None
    assert synth_calls == []


def test_preview_poll_route_is_project_scoped(temp_project):
    job = preview_jobs.start_job(
        "chat-1",
        1,
        [{"id": "s0001", "text": "Grounded update."}],
        generate_fn=lambda messages, model: json.dumps({
            "cue": "Grounded update.",
            "source_sentence_ids": ["s0001"],
        }),
        synth_fn=lambda cue: b"mp3",
    )
    _wait(job.id)
    assert session_routes.preview_job_status(job.id)["job"]["id"] == job.id

    token = config.set_active_project("another-project")
    try:
        with pytest.raises(HTTPException) as exc_info:
            session_routes.preview_job_status(job.id)
    finally:
        config.reset_active_project(token)
    assert exc_info.value.status_code == 404
