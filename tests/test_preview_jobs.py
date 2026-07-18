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
    preview_jobs._coordinator_jobs.clear()
    yield
    preview_jobs._jobs.clear()
    preview_jobs._coordinator_jobs.clear()


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
        {
            "id": "s0001",
            "text": "Early results show a 12 percent gain.",
            "kind": "live_response",
        }
    ]
    assert payload["grounded_sources"] == payload["completed_sentences"]
    assert payload["preparation_progress"] == {}
    assert payload["previous_cue"] == ""


def test_research_sources_include_paper_opening_and_prior_project_context(monkeypatch):
    monkeypatch.setattr(
        preview_jobs.store,
        "read_full_text",
        lambda slug: "Abstract motivation.\n\nIntroduction background.",
    )
    monkeypatch.setattr(
        preview_jobs.assembler,
        "build_context",
        lambda slug: (
            "# Reading method\n\nIgnore for previews.\n\n---\n\n"
            "# Prior Notes from related papers already read\n\nPrior paper notes.\n\n---\n\n"
            "# Significant related works\n\nRelationship to the current paper."
        ),
    )

    sources = preview_jobs.research_sources("paper")

    assert {source["kind"] for source in sources} == {
        "paper_background", "prior_project_context",
    }
    texts = [source["text"] for source in sources]
    assert "Prior paper notes." in texts
    assert all("Ignore for previews" not in text for text in texts)


def test_audio_synthesis_progress_is_citable_and_never_announces_readiness(temp_project):
    """Playback is the complete stitched track (polish plan I.1/I.2): the synthesis-phase
    progress source carries the honest parts count and must NOT claim the response is ready
    or about to play — repeated ready-announcements were the on-device incoherence bug."""
    captured = {}

    def generate(messages, model):
        captured["payload"] = json.loads(messages[1]["content"])
        return json.dumps({
            "cue": "Synthesis continues, 2 of 4 parts done.",
            "source_sentence_ids": ["progress0001"],
        })

    job = preview_jobs.start_job(
        "chat-progress",
        1,
        [{"id": "s0001", "text": "A grounded finding.", "kind": "live_response"}],
        progress={
            "phase": "audio_synthesis",
            "segments_done": 2,
            "segments_total": 4,
            "segments_remaining": 2,
            "remaining_known": True,
        },
        generate_fn=generate,
        synth_fn=lambda cue: b"mp3",
    )
    finished = _wait(job.id)

    assert finished.status == "done"
    assert finished.source_sentence_ids == ["progress0001"]
    progress_source = captured["payload"]["grounded_sources"][-1]
    assert progress_source["id"] == "progress0001"
    assert "2 of 4" in progress_source["text"]
    assert "ready" not in progress_source["text"].lower()
    assert "immediately" not in progress_source["text"].lower()


def test_audio_progress_ready_only_when_the_job_settles(temp_project):
    """Segments landing no longer means playable (I.1): a running job with synthesized
    segments must keep the cue pipeline alive until the stitched file exists."""
    running = type("Audio", (), {
        "status": "running", "stage": "synthesizing",
        "segments_done": 3, "segments_total": 4,
        "segments": [{"index": 0}],  # would have flipped ready under progressive playback
    })()
    phase, progress, ready = preview_jobs._audio_progress(running)
    assert phase == "audio_synthesis"
    assert ready is False
    running.status = "done"
    _, _, ready_after = preview_jobs._audio_progress(running)
    assert ready_after is True


def test_audio_progress_treats_cancelled_as_settled(temp_project):
    """U.4: a cancelled preparation must stop the cue cadence like done/error — otherwise the
    coordinator keeps launching paid cue generations against a job that will never finish."""
    cancelled = type("Audio", (), {
        "status": "cancelled", "stage": "synthesizing",
        "segments_done": 1, "segments_total": 4,
        "segments": [{"index": 0}],
    })()
    _, _, ready = preview_jobs._audio_progress(cancelled)
    assert ready is True


def test_external_sources_are_cached_and_fail_soft(temp_project, monkeypatch):
    from app import research_tools, store

    store.add_entry("Attention Is All You Need")
    slug = store.list_papers()[0].slug
    calls = []

    def fake_search(objective, queries=None):
        calls.append(objective)
        return "The authors were at Google Brain.\n\nA v2 appeared at NeurIPS."

    monkeypatch.setattr(research_tools, "web_search", fake_search)
    preview_jobs._external_cache.clear()

    sources = preview_jobs.external_sources(slug)
    assert sources and all(item["kind"] == "external_web_context" for item in sources)
    assert any("Google Brain" in item["text"] for item in sources)
    assert preview_jobs.external_sources(slug) == sources  # cached
    assert len(calls) == 1

    # Unknown paper and a failing search both degrade to no sources, never an exception.
    assert preview_jobs.external_sources("ghost") == []
    preview_jobs._external_cache.clear()
    monkeypatch.setattr(research_tools, "web_search",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("offline")))
    assert preview_jobs.external_sources(slug) == []


def test_coordinator_continues_cues_with_audio_progress_until_ready(
    temp_project, monkeypatch,
):
    audio = type("Audio", (), {
        "status": "running",
        "stage": "narrating",
        "segments_done": 0,
        "segments_total": 0,
    })()
    cues = {}
    starts = []
    publications = []

    monkeypatch.setattr(preview_jobs.audio_jobs, "get_job", lambda job_id: audio)

    def fake_start(chat_id, ordinal, sources, previous, progress):
        cue = type("Cue", (), {
            "id": f"cue-{ordinal}",
            "status": "done",
            "cue": f"spoken {ordinal}",
        })()
        cues[cue.id] = cue
        starts.append((config.active_project_id(), sources, previous, dict(progress)))
        return cue

    monkeypatch.setattr(preview_jobs, "start_job", fake_start)
    monkeypatch.setattr(preview_jobs, "get_job", lambda job_id: cues.get(job_id))
    monkeypatch.setattr(preview_jobs, "CONTINUATION_POLL_SECONDS", 0.01)

    coordinator = preview_jobs.start_coordinator(
        "chat-1",
        "audio-1",
        [{"id": "paper0001", "text": "Background.", "kind": "paper_background"}],
        [],
        lambda ids, phase, progress, complete: publications.append(
            (list(ids), phase, dict(progress), complete)
        ),
        cadence_seconds=0,
        last_started_at=0,
    )

    deadline = time.time() + 2
    while not starts and time.time() < deadline:
        time.sleep(0.01)
    assert starts and starts[0][0] == temp_project
    assert starts[0][3]["phase"] == "narration_adaptation"

    audio.stage = "synthesizing"
    audio.segments_total = 4
    audio.segments_done = 2
    deadline = time.time() + 2
    while (not any(p[2].get("segments_remaining") == 2 for p in publications)
           and time.time() < deadline):
        time.sleep(0.01)
    assert any(p[2].get("segments_remaining") == 2 for p in publications)

    audio.status = "done"
    deadline = time.time() + 2
    while coordinator.status == "running" and time.time() < deadline:
        time.sleep(0.01)
    assert coordinator.status == "done"
    assert publications[-1][3] is True


def test_synthesis_cues_only_fire_on_segment_progress(temp_project, monkeypatch):
    """R9.6: while audio synthesizes, a new cue is worth speaking only when a segment actually
    lands — otherwise the cue track just loops '…still synthesizing'. Flat progress ⇒ no new
    cue; an advanced segment count ⇒ exactly one more."""
    audio = type("Audio", (), {
        "status": "running", "stage": "synthesizing",
        "segments_done": 1, "segments_total": 4,
    })()
    starts = []

    def fake_start(chat_id, ordinal, sources, previous, progress):
        cue = type("Cue", (), {"id": f"cue-{ordinal}", "status": "done",
                               "cue": f"spoken {ordinal}"})()
        starts.append(dict(progress))
        fake_start.cues[cue.id] = cue
        return cue
    fake_start.cues = {}

    monkeypatch.setattr(preview_jobs.audio_jobs, "get_job", lambda job_id: audio)
    monkeypatch.setattr(preview_jobs, "start_job", fake_start)
    monkeypatch.setattr(preview_jobs, "get_job", lambda job_id: fake_start.cues.get(job_id))
    monkeypatch.setattr(preview_jobs, "CONTINUATION_POLL_SECONDS", 0.01)

    preview_jobs.start_coordinator(
        "chat-gate", "audio-gate",
        [{"id": "paper0001", "text": "Background.", "kind": "paper_background"}],
        [],
        lambda ids, phase, progress, complete: None,
        cadence_seconds=0, last_started_at=0,
    )

    # First synthesis cue fires (announces the text is readable); then progress stays flat.
    deadline = time.time() + 2
    while not starts and time.time() < deadline:
        time.sleep(0.01)
    time.sleep(0.2)  # several poll cycles with segments_done unchanged
    assert len(starts) == 1, "a flat segment count must not keep re-cueing"

    # A landed segment is real news — exactly one more cue.
    audio.segments_done = 2
    deadline = time.time() + 2
    while len(starts) < 2 and time.time() < deadline:
        time.sleep(0.01)
    time.sleep(0.2)
    assert len(starts) == 2

    audio.status = "done"


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
