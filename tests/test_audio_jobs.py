"""audio_jobs: the background-thread narrate->synthesize job that decouples audio preparation
from any single HTTP connection. A blocking /api/speak died at the tunnel's ~100s proxy timeout
(Cloudflare 524) while the server finished and cached the mp3 anyway; this drives a REAL
background thread end-to-end (narrate_fn/synth_fn injected, zero network) and confirms jobs
finish, report per-segment progress, join in-flight duplicates, and answer instantly from the
caches once done."""
from __future__ import annotations

import threading
import time

import pytest
from app import audio_jobs, config, sessions, tts


@pytest.fixture(autouse=True)
def _isolated_state(tmp_path, monkeypatch):
    """Point the app-global state (narration cache + mp3 cache) at a tmp dir and clear the
    module-level job registry, so tests never touch real caches or leak jobs into each other."""
    monkeypatch.setattr(config, "APP_STATE_DIR", tmp_path)
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()
    monkeypatch.setattr(audio_jobs, "AUDIO_DIR", audio_dir)
    audio_jobs._jobs.clear()
    yield
    audio_jobs._jobs.clear()


def fake_narrate(text: str) -> str:
    return f"narrated: {text}"


def fake_synth(part: str) -> bytes:
    return b"mp3:" + part[:8].encode()


def _wait_until_settled(job_id: str, timeout: float = 5.0) -> audio_jobs.AudioJob:
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = audio_jobs.get_job(job_id)
        if job and job.status != "running":
            return job
        time.sleep(0.02)
    raise TimeoutError(f"audio job {job_id} did not settle within {timeout}s")


def test_job_runs_to_completion_in_a_background_thread():
    job = audio_jobs.start_job("Hello world.", narrate_fn=fake_narrate, synth_fn=fake_synth)

    finished = _wait_until_settled(job.id)
    assert finished.status == "done"
    assert finished.narration == "narrated: Hello world."
    assert finished.url and finished.url.startswith("/api/audio/")
    assert (audio_jobs.AUDIO_DIR / finished.url.split("/")[-1]).read_bytes().startswith(b"mp3:")
    # Narration landed in the shared cache, so transcripts/re-runs never re-narrate.
    assert sessions.get_cached_narration("Hello world.") == "narrated: Hello world."


def test_long_narration_reports_per_segment_progress():
    # ~3 segments' worth of sentences (limit is MAX_TTS_CHARS per segment).
    long_text = ("This is a sentence that fills space. " * 60 + "\n") * 6
    calls: list[str] = []

    def counting_synth(part: str) -> bytes:
        calls.append(part)
        return b"x"

    job = audio_jobs.start_job(long_text, narrate_fn=lambda t: t, synth_fn=counting_synth)
    finished = _wait_until_settled(job.id)

    assert finished.status == "done"
    assert finished.segments_total == len(tts.split_for_tts(long_text)) >= 2
    assert finished.segments_done == finished.segments_total
    assert 1 <= len(calls) <= finished.segments_total  # identical segment text reuses its cache
    assert len(finished.segments) == finished.segments_total
    assert all((audio_jobs.AUDIO_DIR / item["url"].rsplit("/", 1)[-1]).exists()
               for item in finished.segments)


def test_first_segment_is_published_before_later_synthesis_finishes():
    long_text = ("First sentence fills enough space. " * 130)
    release_later = threading.Event()
    calls = 0

    def staged_synth(part: str) -> bytes:
        nonlocal calls
        calls += 1
        if calls > 1:
            release_later.wait(5)
        return f"segment-{calls}".encode()

    job = audio_jobs.start_job(long_text, narrate_fn=lambda text: text, synth_fn=staged_synth)
    deadline = time.time() + 5
    while time.time() < deadline:
        snapshot = audio_jobs.get_job(job.id)
        if snapshot and snapshot.segments:
            break
        time.sleep(0.02)
    else:
        raise TimeoutError("first segment was not published")

    assert snapshot.status == "running"
    assert snapshot.segments_done == 1
    assert snapshot.segments[0]["index"] == 0
    assert snapshot.timings["first_segment"]
    release_later.set()
    assert _wait_until_settled(job.id).status == "done"


def test_second_request_joins_the_running_job():
    release = threading.Event()

    def slow_narrate(text: str) -> str:
        release.wait(5)
        return f"narrated: {text}"

    first = audio_jobs.start_job("Same text.", narrate_fn=slow_narrate, synth_fn=fake_synth)
    second = audio_jobs.start_job("Same text.", narrate_fn=fake_narrate, synth_fn=fake_synth)
    assert second is first  # joined, not duplicated

    release.set()
    assert _wait_until_settled(first.id).status == "done"


def test_fully_cached_result_is_done_instantly_without_a_thread():
    first = audio_jobs.start_job("Cached text.", narrate_fn=fake_narrate, synth_fn=fake_synth)
    _wait_until_settled(first.id)
    audio_jobs._jobs.clear()  # simulate a later request (or server keeping only recent jobs)

    def must_not_run(_):
        raise AssertionError("cached result should not re-narrate/re-synthesize")

    job = audio_jobs.start_job("Cached text.", narrate_fn=must_not_run, synth_fn=must_not_run)
    assert job.status == "done"
    assert job.narration == "narrated: Cached text."
    assert job.url == first.url


def test_synthesis_failure_surfaces_as_an_error_job():
    def failing_synth(_: str) -> bytes:
        raise tts.TTSError("OpenAI TTS error 500: boom")

    job = audio_jobs.start_job("Will fail.", narrate_fn=fake_narrate, synth_fn=failing_synth)
    finished = _wait_until_settled(job.id)

    assert finished.status == "error"
    assert "boom" in (finished.error or "")
    assert finished.url is None
    # A retry after the failure starts a fresh job rather than returning the dead one.
    retry = audio_jobs.start_job("Will fail.", narrate_fn=fake_narrate, synth_fn=fake_synth)
    assert _wait_until_settled(retry.id).status == "done"


# ---- narration cost attribution (audio is app-global, but spend bills the initiating project) ----

def _billing_narrate(text: str) -> str:
    """Stand-in for agent.narrate: records usage against the ACTIVE project, exactly as
    llm.complete does, so the test sees whether the worker bound the right project."""
    from app import usage
    usage.record("narration", "narr-model", {"prompt_tokens": 5, "cost": 0.02})
    return f"narrated: {text}"


def test_narration_bills_the_initiating_project_not_another(temp_project):
    from app import config, usage
    # temp_project is the ambient "other" project; the audio was initiated from proj-A.
    job = audio_jobs.start_job("Bill A.", billing_project="proj-A",
                               narrate_fn=_billing_narrate, synth_fn=fake_synth)
    assert _wait_until_settled(job.id).status == "done"

    tok = config.set_active_project("proj-A")
    try:
        billed = usage.load()
    finally:
        config.reset_active_project(tok)
    assert billed["by_operation"]["narration"]["calls"] == 1
    assert billed["by_operation"]["narration"]["cost_nanousd"] == 20_000_000  # 0.02 USD

    # The ambient project (temp_project) is NOT charged for A's narration.
    assert usage.load()["total"]["calls"] == 0


def test_cached_narration_costs_nothing(temp_project):
    from app import config, usage
    # First run under proj-A narrates and bills.
    first = audio_jobs.start_job("Reused text.", billing_project="proj-A",
                                 narrate_fn=_billing_narrate, synth_fn=fake_synth)
    _wait_until_settled(first.id)
    audio_jobs._jobs.clear()

    # A later request from proj-B hits the narration+mp3 cache: no LLM call, so no one is billed.
    job = audio_jobs.start_job("Reused text.", billing_project="proj-B",
                               narrate_fn=_billing_narrate, synth_fn=fake_synth)
    assert job.status == "done"
    tok = config.set_active_project("proj-B")
    try:
        assert usage.load()["total"]["calls"] == 0  # cache hit -> unbilled
    finally:
        config.reset_active_project(tok)


def test_narration_without_a_project_bills_the_unattributed_ledger(temp_project):
    from app import usage
    job = audio_jobs.start_job("No project direct.", billing_project=None,
                               narrate_fn=_billing_narrate, synth_fn=fake_synth)
    assert _wait_until_settled(job.id).status == "done"
    assert usage.unattributed_summary()["by_operation"]["narration"]["calls"] == 1
    assert usage.load()["total"]["calls"] == 0  # the ambient project isn't charged for it


# ---- route-level: /api/audio/jobs validates the billing project and attributes correctly ----

def _route_env(monkeypatch):
    from app import agent, config, tts
    monkeypatch.setattr(config, "load_settings",
                        lambda: {"speech_provider": "openai", "tts_model": "m", "tts_voice": "v"})
    monkeypatch.setattr(agent, "narrate", _billing_narrate)  # records usage under the active project
    monkeypatch.setattr(tts, "openai_speech", lambda part: b"mp3")


def test_route_valid_project_bills_it(temp_project, monkeypatch):
    from app import usage
    from app.routers import audio as audio_routes
    _route_env(monkeypatch)
    resp = audio_routes.start_audio_job(audio_routes.NarrateReq(text="Hello route.", project=temp_project))
    _wait_until_settled(resp["job"]["id"])
    assert usage.load()["by_operation"]["narration"]["calls"] == 1


def test_route_missing_project_bills_unattributed(temp_project, monkeypatch):
    from app import usage
    from app.routers import audio as audio_routes
    _route_env(monkeypatch)
    resp = audio_routes.start_audio_job(audio_routes.NarrateReq(text="No project route.", project=None))
    _wait_until_settled(resp["job"]["id"])
    assert usage.unattributed_summary()["by_operation"]["narration"]["calls"] == 1
    assert usage.load()["total"]["calls"] == 0


def test_route_invalid_project_is_rejected_400(temp_project, monkeypatch):
    from app.routers import audio as audio_routes
    from fastapi import HTTPException
    _route_env(monkeypatch)
    with pytest.raises(HTTPException) as ei:
        audio_routes.start_audio_job(audio_routes.NarrateReq(text="x", project="../etc"))
    assert ei.value.status_code == 400  # traversal/unknown id -> client error, not silent None


def test_route_cached_result_bills_no_one(temp_project, monkeypatch):
    from app import usage
    from app.routers import audio as audio_routes
    _route_env(monkeypatch)
    first = audio_routes.start_audio_job(audio_routes.NarrateReq(text="Cached route.", project=temp_project))
    _wait_until_settled(first["job"]["id"])
    audio_jobs._jobs.clear()
    before = usage.load()["by_operation"]["narration"]["calls"]
    resp = audio_routes.start_audio_job(audio_routes.NarrateReq(text="Cached route.", project=None))
    assert resp["job"]["status"] == "done"  # cache hit, no thread
    assert usage.load()["by_operation"]["narration"]["calls"] == before  # nothing re-billed


def test_normalize_for_speech_pronounces_arxiv_as_archive():
    """Polish plan I.4: spoken form only — written/canonical text keeps 'arXiv'."""
    from app import tts
    assert tts.normalize_for_speech("Published on arXiv in 2017.") == "Published on archive in 2017."
    assert tts.normalize_for_speech("ArXiv and arXiv's listings") == "archive and archive's listings"
    # Word-bounded: identifiers that merely contain the letters stay intact.
    assert tts.normalize_for_speech("the arxival record") == "the arxival record"
    assert tts.BrowserTTS().synthesize("see arXiv")["text"] == "see archive"
