from __future__ import annotations

import json
import logging
import threading
import time

import pytest
from app import audio_jobs, chat_jobs, config, preview_jobs, usage
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
    assert payload["played_cues"] == []
    assert payload["generated_cues"] == []


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


def test_each_cue_has_a_finite_source_budget_and_keeps_progress_last():
    items = [
        {"id": f"live{i:04d}", "text": f"live {i} " + "x" * 600, "kind": "live_response"}
        for i in range(10)
    ] + [
        {"id": f"context{i:04d}", "text": f"context {i} " + "y" * 690,
         "kind": "paper_background"}
        for i in range(30)
    ] + [{
        "id": "progress0001", "text": "2 of 4 parts synthesized.",
        "kind": "preparation_progress",
    }]

    selected = preview_jobs._bounded_sources(items, ordinal=1)

    assert sum(len(item["text"]) for item in selected) <= preview_jobs.MAX_GROUNDED_SOURCE_CHARS
    assert sum(len(item["text"]) for item in selected if item["kind"] == "live_response") \
        <= preview_jobs.MAX_LIVE_SOURCE_CHARS
    assert selected[-1]["id"] == "progress0001"
    assert len({item["id"] for item in selected}) == len(selected)


def test_later_cues_rotate_the_bounded_project_context():
    items = [
        {"id": f"context{i:04d}", "text": "z" * 700, "kind": "prior_project_context"}
        for i in range(20)
    ]

    first = preview_jobs._bounded_sources(items, ordinal=1)
    second = preview_jobs._bounded_sources(items, ordinal=2)

    assert [item["id"] for item in first] != [item["id"] for item in second]
    assert first[0]["id"] == "context0000"
    assert second[0]["id"] == "context0005"


def test_generation_receives_only_the_bounded_source_window():
    captured = {}
    items = [
        {"id": f"live{i:04d}", "text": "live evidence " + "x" * 600,
         "kind": "live_response"}
        for i in range(10)
    ] + [
        {"id": f"context{i:04d}", "text": "project evidence " + "y" * 690,
         "kind": "prior_project_context"}
        for i in range(30)
    ]

    def generate(messages, model):
        payload = json.loads(messages[1]["content"])
        captured.update(payload)
        return json.dumps({
            "cue": "A compact grounded observation.",
            "source_sentence_ids": [payload["grounded_sources"][0]["id"]],
        })

    job = preview_jobs.start_job(
        "bounded-generation",
        3,
        items,
        previous_cue="p" * 2_000,
        played_cues=[f"played {index} " + "p" * 600 for index in range(12)],
        generated_cues=[f"generated {index} " + "g" * 600 for index in range(12)],
        generate_fn=generate,
        synth_fn=lambda cue: b"mp3",
    )
    assert _wait(job.id).status == "done"

    assert sum(len(item["text"]) for item in captured["grounded_sources"]) \
        <= preview_jobs.MAX_GROUNDED_SOURCE_CHARS
    assert captured["completed_sentences"] == [
        item for item in captured["grounded_sources"] if item["kind"] == "live_response"
    ]
    assert len(captured["played_cues"]) == preview_jobs.CUE_HISTORY_WINDOW
    assert len(captured["generated_cues"]) == preview_jobs.CUE_HISTORY_WINDOW
    assert all(len(cue) <= preview_jobs.MAX_CUE_CHARS for cue in captured["played_cues"])
    assert all(len(cue) <= preview_jobs.MAX_CUE_CHARS for cue in captured["generated_cues"])
    assert len(captured["previous_cue"]) == preview_jobs.MAX_CUE_CHARS


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
    assert "read" not in progress_source["text"].lower()
    assert "screen" not in progress_source["text"].lower()


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


def test_external_sources_use_bounded_agent_findings_cache_and_fail_soft(
    temp_project, monkeypatch,
):
    from app import store

    store.add_entry("Attention Is All You Need")
    slug = store.list_papers()[0].slug
    calls = []

    def fake_research(title, metadata):
        calls.append((title, metadata))
        return (
            "The authors were at Google Brain. Source: https://example.org/authors\n\n"
            "A later version appeared at NeurIPS. Source: https://example.org/venue"
        )

    preview_jobs._external_cache.clear()

    sources = preview_jobs.external_sources(slug, fake_research)
    assert sources and all(item["kind"] == "external_web_context" for item in sources)
    assert any("Google Brain" in item["text"] for item in sources)
    assert preview_jobs.external_sources(
        slug,
        lambda *_: (_ for _ in ()).throw(AssertionError("cache missed")),
    ) == sources
    assert len(calls) == 1

    # Unknown paper and a failing agent both degrade to no sources, never an exception.
    assert preview_jobs.external_sources("ghost", fake_research) == []
    preview_jobs._external_cache.clear()
    assert preview_jobs.external_sources(
        slug,
        lambda *_: (_ for _ in ()).throw(RuntimeError("offline")),
    ) == []


def test_external_sources_log_excludes_provider_message(
        temp_project, monkeypatch, caplog):
    from app import store

    store.add_entry("Attention Is All You Need")
    slug = store.list_papers()[0].slug
    secret = "PRIVATE_PAPER_TEXT_preview"
    preview_jobs._external_cache.clear()
    logger = logging.getLogger("rc.preview")
    previous = logger.propagate
    logger.propagate = True
    caplog.set_level(logging.WARNING, logger="rc.preview")
    try:
        sources = preview_jobs.external_sources(
            slug, lambda *_: (_ for _ in ()).throw(RuntimeError(secret)))
    finally:
        logger.propagate = previous

    assert sources == []
    assert all(secret not in record.getMessage() for record in caplog.records)


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

    def fake_start(chat_id, ordinal, sources, previous, progress, **history):
        cue = type("Cue", (), {
            "id": f"cue-{ordinal}",
            "status": "done",
            "cue": f"spoken {ordinal}",
            "progress_signature": preview_jobs.progress_signature(progress),
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


def test_synthesis_progress_triggers_a_cue_before_the_keepalive(temp_project, monkeypatch):
    """A landed segment is still the preferred immediate trigger; flat progress does not fall
    back to a keepalive until the bounded silence interval has actually elapsed."""
    audio = type("Audio", (), {
        "status": "running", "stage": "synthesizing",
        "segments_done": 1, "segments_total": 4,
    })()
    starts = []

    def fake_start(chat_id, ordinal, sources, previous, progress, **history):
        cue = type("Cue", (), {
            "id": f"cue-{ordinal}", "status": "done", "cue": f"spoken {ordinal}",
            "progress_signature": preview_jobs.progress_signature(progress),
        })()
        starts.append(dict(progress))
        fake_start.cues[cue.id] = cue
        return cue
    fake_start.cues = {}

    monkeypatch.setattr(preview_jobs.audio_jobs, "get_job", lambda job_id: audio)
    monkeypatch.setattr(preview_jobs, "start_job", fake_start)
    monkeypatch.setattr(preview_jobs, "get_job", lambda job_id: fake_start.cues.get(job_id))
    monkeypatch.setattr(preview_jobs, "CONTINUATION_POLL_SECONDS", 0.01)
    monkeypatch.setattr(preview_jobs, "SYNTHESIS_KEEPALIVE_SECONDS", 5)

    preview_jobs.start_coordinator(
        "chat-gate", "audio-gate",
        [{"id": "paper0001", "text": "Background.", "kind": "paper_background"}],
        [],
        lambda ids, phase, progress, complete: None,
        cadence_seconds=0, last_started_at=0,
    )

    # First synthesis cue fires; flat progress does not rapidly repeat it.
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


def test_synthesis_keepalive_continues_cues_during_a_slow_segment(temp_project, monkeypatch):
    """R10.20: stitched audio can spend a long time inside one segment. Preview cues must
    continue until the complete track is playable, even while segments_done is flat."""
    audio = type("Audio", (), {
        "status": "running", "stage": "synthesizing",
        "segments_done": 1, "segments_total": 4,
    })()
    starts = []
    cues = {}

    def fake_start(chat_id, ordinal, sources, previous, progress, **history):
        cue = type("Cue", (), {
            "id": f"cue-{ordinal}",
            "status": "done",
            "cue": f"distinct grounded cue {ordinal}",
            "progress_signature": preview_jobs.progress_signature(progress),
        })()
        starts.append((previous, dict(progress)))
        cues[cue.id] = cue
        return cue

    monkeypatch.setattr(preview_jobs.audio_jobs, "get_job", lambda job_id: audio)
    monkeypatch.setattr(preview_jobs, "start_job", fake_start)
    monkeypatch.setattr(preview_jobs, "get_job", lambda job_id: cues.get(job_id))
    monkeypatch.setattr(preview_jobs, "CONTINUATION_POLL_SECONDS", 0.005)
    monkeypatch.setattr(preview_jobs, "SYNTHESIS_KEEPALIVE_SECONDS", 0.05)

    coordinator = preview_jobs.start_coordinator(
        "chat-keepalive", "audio-keepalive",
        [{"id": "paper0001", "text": "Background.", "kind": "paper_background"}],
        [],
        lambda ids, phase, progress, complete: None,
        cadence_seconds=0, last_started_at=0,
    )

    deadline = time.time() + 2
    while len(starts) < 2 and time.time() < deadline:
        time.sleep(0.01)
    audio.status = "done"
    while coordinator.status == "running" and time.time() < deadline:
        time.sleep(0.01)

    assert len(starts) >= 2
    assert starts[0][1]["segments_done"] == starts[1][1]["segments_done"] == 1
    assert "distinct grounded cue 1" in starts[1][0]
    assert coordinator.status == "done"


def test_an_errored_cue_does_not_claim_its_progress_as_already_reported(temp_project, monkeypatch):
    """`start_job` returns as soon as the worker thread is admitted, so a cue that fails afterwards
    must not make the count look stale — the listener never heard it announced."""
    audio = type("Audio", (), {
        "status": "running", "stage": "synthesizing",
        "segments_done": 1, "segments_total": 4,
    })()
    calls = []

    def fake_start(chat_id, ordinal, sources, previous, progress, **history):
        # The first cue is admitted and then fails, exactly as a real LLM/TTS error would.
        status = "error" if ordinal == 1 else "done"
        cue = type("Cue", (), {
            "id": f"cue-{ordinal}", "status": status, "cue": f"spoken {ordinal}",
            "progress_signature": preview_jobs.progress_signature(progress),
        })()
        calls.append(history.get("progress_is_new"))
        fake_start.cues[cue.id] = cue
        return cue
    fake_start.cues = {}

    monkeypatch.setattr(preview_jobs.audio_jobs, "get_job", lambda job_id: audio)
    monkeypatch.setattr(preview_jobs, "start_job", fake_start)
    monkeypatch.setattr(preview_jobs, "get_job", lambda job_id: fake_start.cues.get(job_id))
    monkeypatch.setattr(preview_jobs, "CONTINUATION_POLL_SECONDS", 0.005)
    monkeypatch.setattr(preview_jobs, "SYNTHESIS_KEEPALIVE_SECONDS", 0.02)

    preview_jobs.start_coordinator(
        "chat-errored", "audio-errored",
        [{"id": "paper0001", "text": "Background.", "kind": "paper_background"}],
        [],
        lambda ids, phase, progress, complete: None,
        cadence_seconds=0, last_started_at=0,
    )

    deadline = time.time() + 3
    while len(calls) < 2 and time.time() < deadline:
        time.sleep(0.01)
    audio.status = "done"

    assert calls[:2] == [True, True], (
        "the cue after a FAILED one may still describe where preparation stands"
    )


def test_analysis_phase_cues_also_stop_at_the_shared_cap(temp_project, monkeypatch):
    """The cap covers the whole wait. This producer runs BEFORE the coordinator, so a cap enforced
    only in the coordinator is not a cap at all — a long analysis spends the budget first."""
    monkeypatch.setattr(preview_jobs, "MAX_CUES_PER_WAIT", 2)
    started = []

    def fake_start(chat_id, ordinal, sentences, previous, progress, **kwargs):
        cue = type("Cue", (), {"id": f"cue-{ordinal}", "status": "done", "cue": f"c{ordinal}"})()
        started.append(ordinal)
        return cue

    monkeypatch.setattr(chat_jobs.preview_jobs, "start_job", fake_start)
    monkeypatch.setattr(chat_jobs.preview_jobs, "get_job", lambda job_id: None)
    monkeypatch.setattr(chat_jobs.preview_jobs, "cue_history", lambda ids: ([], []))
    monkeypatch.setattr(chat_jobs, "PREVIEW_CADENCE_SECONDS", 0)

    job = chat_jobs.ChatJob(id="chat-analysis-cap", slug="paper")
    job._preview_enabled = True
    job._preview_next_sentence = 0
    job._preview_context = []
    job._tool_activity = []

    # Five rounds of fresh completed sentences: only the cap can stop the cues.
    for index in range(5):
        job._preview_last_started = 0
        chat_jobs._maybe_start_preview(job, " ".join(f"Sentence {n}." for n in range(index + 2)))

    assert started == [1, 2], f"analysis cues must stop at the shared cap, got {started}"


def test_no_cap_means_cues_continue_until_the_audio_is_ready(temp_project, monkeypatch):
    """The default is UNCAPPED (Kamil, 2026-07-30: "silence is the worst here at any cost"), so
    cues must keep coming for as long as the wait lasts. The cap remains implemented for when a
    quota needs it, and this pins both halves: None keeps going, a number stops."""
    audio_uncapped = type("Audio", (), {
        "status": "running", "stage": "synthesizing",
        "segments_done": 0, "segments_total": 99,
    })()
    seen = []

    def uncapped_start(chat_id, ordinal, sources, previous, progress, **history):
        cue = type("Cue", (), {"id": f"u-{ordinal}", "status": "done", "cue": f"c{ordinal}",
                               "progress_signature": preview_jobs.progress_signature(progress)})()
        seen.append(ordinal)
        uncapped_start.cues[cue.id] = cue
        return cue
    uncapped_start.cues = {}

    monkeypatch.setattr(preview_jobs.audio_jobs, "get_job", lambda job_id: audio_uncapped)
    monkeypatch.setattr(preview_jobs, "start_job", uncapped_start)
    monkeypatch.setattr(preview_jobs, "get_job", lambda job_id: uncapped_start.cues.get(job_id))
    monkeypatch.setattr(preview_jobs, "CONTINUATION_POLL_SECONDS", 0.005)
    monkeypatch.setattr(preview_jobs, "MAX_CUES_PER_WAIT", None)

    preview_jobs.start_coordinator(
        "chat-uncapped", "audio-uncapped",
        [{"id": "paper0001", "text": "Background.", "kind": "paper_background"}],
        [], lambda ids, phase, progress, complete: None,
        cadence_seconds=0, last_started_at=0,
    )
    deadline = time.time() + 3
    while len(seen) < 9 and time.time() < deadline:
        audio_uncapped.segments_done += 1
        time.sleep(0.01)
    audio_uncapped.status = "done"

    assert len(seen) >= 9, f"uncapped cues must keep coming, got {len(seen)}"


def test_cues_stop_at_the_cap_and_the_coordinator_still_settles(temp_project, monkeypatch):
    """The cap still works when one is set — kept because a quota may need it later, and because
    a cap that stranded the listener would be worse than the cost it saves."""
    audio = type("Audio", (), {
        "status": "running", "stage": "synthesizing",
        "segments_done": 0, "segments_total": 99,
    })()
    starts = []

    def fake_start(chat_id, ordinal, sources, previous, progress, **history):
        cue = type("Cue", (), {
            "id": f"cue-{ordinal}", "status": "done", "cue": f"spoken {ordinal}",
            "progress_signature": preview_jobs.progress_signature(progress),
        })()
        starts.append(ordinal)
        fake_start.cues[cue.id] = cue
        return cue
    fake_start.cues = {}

    monkeypatch.setattr(preview_jobs.audio_jobs, "get_job", lambda job_id: audio)
    monkeypatch.setattr(preview_jobs, "start_job", fake_start)
    monkeypatch.setattr(preview_jobs, "get_job", lambda job_id: fake_start.cues.get(job_id))
    monkeypatch.setattr(preview_jobs, "CONTINUATION_POLL_SECONDS", 0.005)
    monkeypatch.setattr(preview_jobs, "MAX_CUES_PER_WAIT", 3)

    coordinator = preview_jobs.start_coordinator(
        "chat-cap", "audio-cap",
        [{"id": "paper0001", "text": "Background.", "kind": "paper_background"}],
        [],
        lambda ids, phase, progress, complete: None,
        cadence_seconds=0, last_started_at=0,
    )

    # Every tick is "real news" (a landed segment), so only the cap can stop the cues.
    deadline = time.time() + 3
    while len(starts) < 3 and time.time() < deadline:
        audio.segments_done += 1
        time.sleep(0.01)
    for _ in range(20):           # keep the news coming well past the cap
        audio.segments_done += 1
        time.sleep(0.01)

    assert starts == [1, 2, 3], f"cues must stop at the cap, got {starts}"

    audio.status = "done"
    deadline = time.time() + 2
    while coordinator.status == "running" and time.time() < deadline:
        time.sleep(0.01)
    assert coordinator.status == "done", "the cap must not stop the coordinator from settling"


def test_a_cue_is_told_progress_is_stale_when_the_count_has_not_moved(temp_project, monkeypatch):
    """The reported repetition: successive cues restating "still synthesizing, N parts" with the
    same N. A cue whose progress matches the previous cue's must not be given progress to cite."""
    audio = type("Audio", (), {
        "status": "running", "stage": "synthesizing",
        "segments_done": 1, "segments_total": 4,
    })()
    calls = []

    def fake_start(chat_id, ordinal, sources, previous, progress, **history):
        cue = type("Cue", (), {
            "id": f"cue-{ordinal}", "status": "done", "cue": f"spoken {ordinal}",
            "progress_signature": preview_jobs.progress_signature(progress),
        })()
        calls.append(history.get("progress_is_new"))
        fake_start.cues[cue.id] = cue
        return cue
    fake_start.cues = {}

    monkeypatch.setattr(preview_jobs.audio_jobs, "get_job", lambda job_id: audio)
    monkeypatch.setattr(preview_jobs, "start_job", fake_start)
    monkeypatch.setattr(preview_jobs, "get_job", lambda job_id: fake_start.cues.get(job_id))
    monkeypatch.setattr(preview_jobs, "CONTINUATION_POLL_SECONDS", 0.005)
    monkeypatch.setattr(preview_jobs, "SYNTHESIS_KEEPALIVE_SECONDS", 0.02)

    preview_jobs.start_coordinator(
        "chat-stale", "audio-stale",
        [{"id": "paper0001", "text": "Background.", "kind": "paper_background"}],
        [],
        lambda ids, phase, progress, complete: None,
        cadence_seconds=0, last_started_at=0,
    )

    # The first cue reports real progress; the keepalive then fires with the count still flat.
    deadline = time.time() + 3
    while len(calls) < 2 and time.time() < deadline:
        time.sleep(0.01)
    audio.status = "done"

    assert calls[0] is True, "the first cue may describe where preparation stands"
    assert calls[1] is False, "a keepalive cue at an unchanged count must not restate progress"


def test_stale_progress_is_withheld_from_the_model_entirely(temp_project):
    """Not merely forbidden in the instructions: a model handed a concrete count tends to use it.
    The progress source must be absent from the citable set and the payload."""
    seen = {}

    def fake_generate(messages, model):
        seen["system"] = messages[0]["content"]
        seen["user"] = json.loads(messages[1]["content"])
        return json.dumps({"cue": "The method reuses cached attention.",
                           "source_sentence_ids": ["s0001"]})

    progress = {"phase": "audio_synthesis", "segments_done": 2, "segments_total": 9,
                "remaining_known": True}
    job = preview_jobs.start_job(
        "chat-withhold", 2,
        [{"id": "s0001", "text": "The method reuses cached attention.", "kind": "live_response"}],
        "an earlier cue",
        progress,
        progress_is_new=False,
        generate_fn=fake_generate,
        synth_fn=lambda text: b"mp3",
    )
    settled = _wait(job.id)

    assert settled.status == "done", settled.error
    assert seen["user"]["preparation_progress"] == {}
    assert not any(item["kind"] == "preparation_progress" for item in seen["user"]["grounded_sources"])
    assert "not advanced since the last cue" in seen["system"]
    # And the honest case still gets it, or cues could never mention progress at all.
    job2 = preview_jobs.start_job(
        "chat-withhold", 3,
        [{"id": "s0001", "text": "The method reuses cached attention.", "kind": "live_response"}],
        "an earlier cue",
        progress,
        progress_is_new=True,
        generate_fn=fake_generate,
        synth_fn=lambda text: b"mp3",
    )
    assert _wait(job2.id).status == "done"
    assert any(item["kind"] == "preparation_progress" for item in seen["user"]["grounded_sources"])


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


def test_generation_compacts_an_overlong_cue_instead_of_failing(temp_project):
    overlong = (
        "This grounded context explains the method's central motivation clearly. "
        + "The same grounded context adds another useful orientation sentence " * 5
    )
    job = preview_jobs.start_job(
        "chat-long",
        1,
        [{"id": "s0001", "text": "Grounded context about the method."}],
        generate_fn=lambda messages, model: json.dumps({
            "cue": overlong,
            "source_sentence_ids": ["s0001"],
        }),
        synth_fn=lambda cue: b"mp3",
    )

    finished = _wait(job.id)
    assert finished.status == "done"
    assert finished.cue
    assert len(finished.cue) <= preview_jobs.MAX_CUE_CHARS
    assert finished.url


def test_complete_played_and_generated_histories_are_sent_to_the_next_cue(temp_project):
    captured = {}
    job = preview_jobs.start_job(
        "chat-history",
        1,
        [{"id": "s0001", "text": "A distinct grounded angle."}],
        "First cue.\nSecond cue.",
        played_cues=["First cue."],
        generated_cues=["First cue.", "Second cue."],
        generate_fn=lambda messages, model: (
            captured.update(payload=json.loads(messages[1]["content"]))
            or json.dumps({
                "cue": "A distinct grounded angle.",
                "source_sentence_ids": ["s0001"],
            })
        ),
        synth_fn=lambda cue: b"mp3",
    )
    assert _wait(job.id).status == "done"
    assert captured["payload"]["played_cues"] == ["First cue."]
    assert captured["payload"]["generated_cues"] == ["First cue.", "Second cue."]
    assert "First cue.\nSecond cue." == captured["payload"]["previous_cue"]


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
    played = session_routes.preview_job_played(job.id)["job"]
    assert played["played"] is True
    assert played["played_at"]

    token = config.set_active_project("another-project")
    try:
        with pytest.raises(HTTPException) as exc_info:
            session_routes.preview_job_status(job.id)
        with pytest.raises(HTTPException) as played_exc:
            session_routes.preview_job_played(job.id)
    finally:
        config.reset_active_project(token)
    assert exc_info.value.status_code == 404
    assert played_exc.value.status_code == 404


def test_cue_generation_asks_for_no_hidden_reasoning(temp_project, monkeypatch):
    """Cues run on `resolve_model`, which falls back to the NARRATION model when no preview model
    is set — the default state, and that default is a reasoning model. Against `max_tokens=180` it
    spends the whole ceiling thinking and returns nothing, so the cue fails and the listener gets
    exactly the silence cues exist to prevent (observed 2026-07-30: two cues, then nothing)."""
    seen = {}

    def fake_complete(messages, **kwargs):
        seen.update(kwargs)
        return json.dumps({"cue": "A grounded cue.", "source_sentence_ids": ["s0001"]})

    monkeypatch.setattr(preview_jobs.llm, "complete", fake_complete)
    preview_jobs._default_generate([{"role": "user", "content": "x"}], "some/model")

    assert seen["reasoning"] == {"enabled": False}
    assert seen["max_tokens"] == 180


def test_cue_history_is_bounded_so_an_uncapped_wait_cannot_outgrow_it(temp_project, monkeypatch):
    """With no cap on cue count, sending every prior cue would grow each request with the wait —
    and worse, the registry evicts finished jobs, so "every cue so far" is a promise the code
    cannot keep. A bounded window is one it can."""
    cues = {}
    for i in range(1, 31):
        job_id = f"cue-{i}"
        cues[job_id] = type("Cue", (), {
            "id": job_id, "status": "done", "cue": f"cue text {i}", "played": True,
            "progress_signature": "",
        })()
    monkeypatch.setattr(preview_jobs, "get_job", lambda job_id: cues.get(job_id))

    played, generated = preview_jobs.cue_history(list(cues))

    assert len(played) == preview_jobs.CUE_HISTORY_WINDOW
    assert len(generated) == preview_jobs.CUE_HISTORY_WINDOW
    # The window keeps the most RECENT cues — repeating the one just spoken is what a listener
    # actually notices, so those are the ones the next cue must be able to see.
    assert played[-1] == "cue text 30"
    assert played[0] == f"cue text {30 - preview_jobs.CUE_HISTORY_WINDOW + 1}"


def test_retention_outlasts_a_long_uncapped_wait(temp_project):
    """Cue ids accumulate for the whole wait and `cue_history` reads them back out of the
    registry. 60 was sized when waits were capped at 6; uncapped, a long synthesis would evict its
    own history mid-wait and silently reintroduce the repetition the history prevents."""
    assert preview_jobs._registry._max_finished >= 400
