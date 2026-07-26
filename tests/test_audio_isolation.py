"""One user must not poll, cancel, or fetch another user's narration.

Audio was the one registry deliberately left app-global by slice 2a: jobs registered under
`project_id=None` so identical narration requested from anywhere shared a single job and a single
mp3. That is a sensible cache and an unacceptable multi-user boundary — a job id or a content hash
is then a bearer token for someone else's reading, and cancelling "your" preparation cancels
theirs.

Kamil's decision (2026-07-26) was to scope per user rather than put ACL rows over shared blobs:
each user gets their own job and their own copy of the file. That trades duplicate synthesis for a
boundary with no lookup in it — B cannot reach A's mp3 because it is not in the directory B's
requests resolve against, which is a property of the path, not of a check that could be forgotten.

Written before the implementation, like slice 2a's isolation tests. With no signed-in user
everything collapses to the single flat directory it uses today.
"""
from __future__ import annotations

import pytest
from app import audio_jobs, config, sessions

ALICE = "f4a33e1b-b3c4-4eb2-a0ea-d110b36a072e"
BOB = "c3fa116b-f010-4d95-8aae-6dc13e1292a4"

TEXT = "The paper argues that attention is all you need."


@pytest.fixture
def clean_audio(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "APP_STATE_DIR", tmp_path)
    monkeypatch.setattr(audio_jobs, "AUDIO_DIR", tmp_path / "audio")
    audio_jobs._jobs.clear()
    yield
    audio_jobs._jobs.clear()
    config.set_active_user(None)


def _prepare(user_id: str | None, text: str = TEXT):
    """Run one audio preparation to completion as `user_id`, with fake narration and TTS."""
    config.set_active_user(user_id)
    job = audio_jobs.start_job(
        text, narrate_fn=lambda t: f"narrated: {t}", synth_fn=lambda t: b"mp3:" + t.encode())
    for _ in range(500):
        current = audio_jobs.get_job(job.id)
        if current is None or current.status != "running":
            break
        import time
        time.sleep(0.01)
    return audio_jobs.get_job(job.id)


# --- the boundary ------------------------------------------------------------------------------

def test_bob_cannot_poll_alices_audio_job(clean_audio):
    alice_job = _prepare(ALICE)
    assert alice_job is not None and alice_job.status == "done"

    config.set_active_user(BOB)
    assert audio_jobs.get_job(alice_job.id) is None


def test_bob_cannot_cancel_alices_audio_job(clean_audio):
    """The sharper half. Under app-global dedup, cancelling was documented as also cancelling for
    anyone joined to the same text — fine for one household, an unauthenticated denial of service
    for many."""
    config.set_active_user(ALICE)
    job = audio_jobs.start_job(
        TEXT, narrate_fn=lambda t: f"narrated: {t}", synth_fn=lambda t: b"mp3:" + t.encode())

    config.set_active_user(BOB)
    assert audio_jobs.cancel_job(job.id) is None

    config.set_active_user(ALICE)
    assert audio_jobs.get_job(job.id) is not None


def test_two_users_get_separate_jobs_for_identical_text(clean_audio):
    """Dedup must not reach across users even though the content hash is identical — that hash is
    exactly what made the old job shared."""
    alice_job = _prepare(ALICE)
    bob_job = _prepare(BOB)
    assert alice_job.id != bob_job.id


def test_two_users_get_separate_copies_of_the_mp3(clean_audio):
    alice_job = _prepare(ALICE)
    bob_job = _prepare(BOB)

    config.set_active_user(ALICE)
    alice_path = audio_jobs.audio_cache_path(alice_job.narration)
    config.set_active_user(BOB)
    bob_path = audio_jobs.audio_cache_path(bob_job.narration)

    assert alice_path != bob_path
    assert alice_path.exists() and bob_path.exists()


def test_a_users_audio_lives_under_one_removable_directory(clean_audio):
    """M7 account deletion has to be able to remove a person's audio without knowing which files
    were theirs. That is only true if every path they wrote sits under one directory."""
    _prepare(ALICE)
    config.set_active_user(ALICE)
    scope = config.user_scope_dir()
    assert scope is not None
    written = list(scope.rglob("*"))
    assert any(p.suffix == ".mp3" for p in written)

    _prepare(BOB)
    config.set_active_user(BOB)
    assert config.user_scope_dir() != scope


def test_the_narration_text_cache_is_per_user_too(clean_audio):
    """Otherwise the second user's preparation silently reuses the first user's narration — no
    leak (you must already hold the text to ask), but their LLM call is never billed to them, and
    deleting the first user's account would take away the second's cached audio."""
    config.set_active_user(ALICE)
    sessions.cache_narration(TEXT, "alice narration")
    assert sessions.get_cached_narration(TEXT) == "alice narration"

    config.set_active_user(BOB)
    assert sessions.get_cached_narration(TEXT) is None


def test_bob_cannot_fetch_alices_mp3_over_http(clean_audio, monkeypatch):
    """The real attack, over the real route. The URL is `/api/audio/<hash>.mp3` and the hash is
    derived from text and voice, so Bob can COMPUTE Alice's URL without ever seeing it — he does
    not need to leak anything. What stops him is that the name resolves inside his own directory."""
    from app import auth
    from app.main import app
    from starlette.testclient import TestClient

    monkeypatch.setattr(auth, "enabled", lambda: True)
    monkeypatch.setattr(auth, "mode", lambda: "supabase")

    alice_job = _prepare(ALICE)
    assert alice_job.url is not None
    config.set_active_user(None)

    monkeypatch.setattr(auth, "check", lambda _t: {"user_id": BOB, "email": "bob@example.com"})
    bob = TestClient(app, headers={"Authorization": "Bearer test"})
    assert bob.get(alice_job.url).status_code == 404

    monkeypatch.setattr(auth, "check", lambda _t: {"user_id": ALICE, "email": "a@example.com"})
    alice = TestClient(app, headers={"Authorization": "Bearer test"})
    response = alice.get(alice_job.url)
    assert response.status_code == 200
    # And a shared cache must not be allowed to hand it to the next caller.
    assert "private" in response.headers.get("cache-control", "")


# --- the single-tenant fallback ------------------------------------------------------------------

def test_with_no_signed_in_user_audio_behaves_exactly_as_before(clean_audio):
    """`./run.sh` in open auth mode. One flat directory, one shared job — today's behaviour, and
    the reason this change does not invalidate Kamil's existing audio cache."""
    job = _prepare(None)
    assert job is not None and job.status == "done"
    assert config.user_scope_dir() is None
    assert audio_jobs.audio_cache_path(job.narration).parent == audio_jobs.AUDIO_DIR
    # A second request with no user joins the same cached result rather than re-synthesizing.
    again = _prepare(None)
    assert again.status == "done"


def test_a_user_scope_can_never_collide_with_a_project_id(clean_audio):
    """Audio jobs are registered under a per-user scope in the same field the registry uses for
    project ids, and `start_or_join` consults the deletion/busy tombstones with whatever it is
    given. That is only safe if a user scope is not a possible project id — so it is asserted here
    rather than left to the shape of a hash."""
    from app import projects

    config.set_active_user(ALICE)
    scope = audio_jobs._audio_scope()
    assert scope is not None
    with pytest.raises(projects.ProjectError):
        projects._safe_pid(scope)
