"""Per-user preferences layered over instance settings.

Slice 2a made `/api/settings` operator-only, which was right for the API keys and wrong for
everything else: a reader could no longer change their own voice or model. This splits the
document — keys stay the operator's, preferences become the user's.

Written before the implementation. The security half is a trust boundary (a user must not be able
to write an API key, or read/write another user's preferences), and the fallback half is what keeps
`./run.sh` and this suite working with no database at all.
"""
from __future__ import annotations

import os
import time

import pytest
from app import config, db, tenancy

ALICE = "f4a33e1b-b3c4-4eb2-a0ea-d110b36a072e"
BOB = "c3fa116b-f010-4d95-8aae-6dc13e1292a4"

TEST_DB = os.environ.get("RC_TEST_DATABASE_URL", "").strip()
needs_pg = pytest.mark.skipif(not TEST_DB, reason="set RC_TEST_DATABASE_URL to run these")


@pytest.fixture
def database(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "SETTINGS_FILE", tmp_path / "settings.json")
    monkeypatch.setenv("RC_DATABASE_URL", TEST_DB)
    db.close()
    with db.pool().connection() as conn:
        conn.execute(
            "drop table if exists rc_account_deletions, rc_project_trash, rc_user_settings, "
            "rc_projects, rc_users, "
            "rc_schema_migrations cascade")
    db.migrate()
    tenancy.ensure_user(ALICE, "alice@example.com")
    tenancy.ensure_user(BOB, "bob@example.com")
    yield
    config.set_active_user(None)
    db.close()


# --- the split itself --------------------------------------------------------------------------

def test_every_setting_is_owned_by_exactly_one_side():
    """A key that is in neither set silently keeps working as an instance setting, which is the
    wrong default for something a user might reasonably expect to be theirs — and a key in BOTH
    would have two sources of truth. So the split is asserted to be a partition."""
    assert config.USER_SETTING_KEYS & config.OPERATOR_SETTING_KEYS == set()
    assert config.USER_SETTING_KEYS | config.OPERATOR_SETTING_KEYS == set(config._SETTING_KEYS)


def test_the_api_keys_are_not_user_settings():
    """The instance pays for these. A user who could write one could point the whole instance at
    an account they control, or simply take it offline for everyone."""
    for key in ("openrouter_api_key", "openai_api_key",
                "firecrawl_api_key", "semantic_scholar_api_key"):
        assert key in config.OPERATOR_SETTING_KEYS
        assert key not in config.USER_SETTING_KEYS


def test_the_preferences_a_reader_would_expect_to_own_are_theirs():
    for key in ("model", "narration_model", "preview_model", "speech_provider",
                "tts_model", "tts_voice", "prior_notes_scope"):
        assert key in config.USER_SETTING_KEYS


# --- layering ----------------------------------------------------------------------------------

def test_with_no_database_settings_are_exactly_as_before(tmp_path, monkeypatch):
    """The single-tenant fallback. `./run.sh` has no database, and 24 call sites read settings —
    if this stopped working the app would stop working."""
    monkeypatch.delenv("RC_DATABASE_URL", raising=False)
    monkeypatch.setattr(config, "SETTINGS_FILE", tmp_path / "settings.json")
    config.save_settings({"tts_voice": "nova", "openrouter_api_key": "sk-instance"})

    assert config.load_settings()["tts_voice"] == "nova"
    assert config.load_settings()["openrouter_api_key"] == "sk-instance"


@needs_pg
def test_a_users_preference_overrides_the_instance_default(database):
    config.save_settings({"tts_voice": "alloy"})
    assert config.load_settings()["tts_voice"] == "alloy"

    config.set_active_user(ALICE)
    config.save_user_settings({"tts_voice": "nova"})
    assert config.load_settings()["tts_voice"] == "nova"

    # Bob is unaffected and still sees the instance default.
    config.set_active_user(BOB)
    assert config.load_settings()["tts_voice"] == "alloy"


@needs_pg
def test_an_unset_preference_falls_back_to_the_instance(database):
    """Fallback, not a copy: an operator changing the instance default must move every user who has
    not expressed a preference, rather than only new ones."""
    config.save_settings({"model": "instance/model"})
    config.set_active_user(ALICE)
    config.save_user_settings({"tts_voice": "nova"})

    assert config.load_settings()["model"] == "instance/model"
    config.save_settings({"model": "instance/changed"})
    assert config.load_settings()["model"] == "instance/changed"


@needs_pg
def test_a_user_cannot_store_an_operator_setting(database):
    """The trust boundary. Even if a client sends one, it must not land in the user's document —
    otherwise the next `load_settings()` for that user would return their key, and the instance
    would be making paid calls with it."""
    config.set_active_user(ALICE)
    config.save_user_settings({"tts_voice": "nova", "openrouter_api_key": "sk-alice"})

    assert config.load_settings()["tts_voice"] == "nova"
    assert config.load_settings().get("openrouter_api_key") != "sk-alice"


@needs_pg
def test_one_users_preferences_are_invisible_to_another(database):
    config.set_active_user(ALICE)
    config.save_user_settings({"tts_voice": "nova", "model": "alice/model"})

    config.set_active_user(BOB)
    loaded = config.load_settings()
    assert loaded.get("tts_voice") != "nova"
    assert loaded.get("model") != "alice/model"


@needs_pg
def test_clearing_a_preference_returns_you_to_the_instance_default(database):
    """`""` clears an override, matching how the instance document already behaves — otherwise
    there is no way back to "whatever the operator chose"."""
    config.save_settings({"tts_voice": "alloy"})
    config.set_active_user(ALICE)
    config.save_user_settings({"tts_voice": "nova"})
    assert config.load_settings()["tts_voice"] == "nova"

    config.save_user_settings({"tts_voice": ""})
    assert config.load_settings()["tts_voice"] == "alloy"


@needs_pg
def test_every_user_setting_key_can_actually_be_stored(database):
    """Guards the drift the CHECK constraint in `0003_user_settings.sql` creates: adding a key to
    `USER_SETTING_KEYS` without extending the migration would leave saving that preference raising
    a database error for every user, with nothing else catching it."""
    config.set_active_user(ALICE)
    for key in sorted(config.USER_SETTING_KEYS):
        config.save_user_settings({key: f"value-for-{key}"})
        assert config.load_settings()[key] == f"value-for-{key}"


@needs_pg
def test_the_bound_user_reaches_load_settings_over_http(database, monkeypatch):
    """The middleware binds the user before `call_next`, and the endpoint runs in a context copied
    from that one. That is a claim about Starlette's task handling, so it is asserted end-to-end
    rather than argued: without it every route would silently serve instance defaults."""
    from app import auth
    from app.main import app
    from starlette.testclient import TestClient

    monkeypatch.setattr(auth, "enabled", lambda: True)
    monkeypatch.setattr(auth, "mode", lambda: "supabase")
    monkeypatch.setattr(auth, "check", lambda _t: {"user_id": ALICE, "email": "alice@example.com"})

    config.save_settings({"tts_voice": "alloy"})
    config.set_active_user(ALICE)
    config.save_user_settings({"tts_voice": "nova"})
    config.set_active_user(None)

    client = TestClient(app, headers={"Authorization": "Bearer test"})
    assert client.get("/api/settings").json()["tts_voice"] == "nova"

    monkeypatch.setattr(auth, "check", lambda _t: {"user_id": BOB, "email": "bob@example.com"})
    assert client.get("/api/settings").json()["tts_voice"] == "alloy"


@needs_pg
def test_a_job_worker_reads_the_preferences_of_whoever_started_it(database):
    """Invariant 2 for the user contextvar. A thread inherits none, so without the rebind in
    `JobRegistry` a narration job would use the instance voice rather than the caller's — quietly,
    and only in the background path."""
    from app.jobs import Job, JobRegistry

    config.save_settings({"tts_voice": "alloy"})
    config.set_active_user(ALICE)
    config.save_user_settings({"tts_voice": "nova"})

    seen: dict = {}
    registry: JobRegistry[Job] = JobRegistry("test-user-settings", max_finished=10)
    job = registry.start_or_join(
        "key", lambda: Job(id="job-1"),
        lambda _job: seen.update(voice=config.load_settings()["tts_voice"]),
        project_id=None)
    for _ in range(200):
        if registry.get(job.id, project_id=None).status != "running":
            break
        time.sleep(0.01)
    assert seen.get("voice") == "nova"


@needs_pg
def test_no_active_user_means_the_instance_document(database):
    """Background work with no user bound, and open-auth instances. Must not raise, and must not
    leak whichever user happened to be active last."""
    config.save_settings({"tts_voice": "alloy"})
    config.set_active_user(ALICE)
    config.save_user_settings({"tts_voice": "nova"})

    config.set_active_user(None)
    assert config.load_settings()["tts_voice"] == "alloy"


# --- worker threads outside the job registry ----------------------------------------------------

@needs_pg
def test_a_raw_worker_thread_rebinds_the_user_as_well_as_the_project(database):
    """`affiliations` and `figures` spawn raw `threading.Thread` workers rather than going through
    `JobRegistry`, and both rebound only the project. A missing project writes another project's
    files; a missing user quietly runs the work on the instance's model instead of the caller's.
    `config.bound_scope` is the one call that does both — this asserts both sites use it."""
    from app import affiliations, figures

    config.save_settings({"model": "instance/model"})
    config.set_active_user(ALICE)
    config.save_user_settings({"model": "alice/model"})
    token = config.set_active_project("alice-project")
    try:
        seen: dict = {}

        def _record(slug, **_kwargs):
            seen[slug] = (config.active_project_id(), config.load_settings()["model"])
            return []

        monkey = pytest.MonkeyPatch()
        try:
            monkey.setattr(affiliations, "extract", _record)
            affiliations._extract_with_deadline("paper-a", complete=lambda *a, **k: "")
            figures._derive_with_deadline("paper-f", False, _record)
        finally:
            monkey.undo()
    finally:
        config.reset_active_project(token)

    assert seen["paper-a"] == ("alice-project", "alice/model")
    assert seen["paper-f"] == ("alice-project", "alice/model")


def test_a_failed_boot_migration_is_retried_rather_than_left_alone(monkeypatch):
    """The process is long-lived and `_apply_migrations` runs once. A database blip during a Fly
    deploy would otherwise leave the replacement machine serving against an old schema until
    somebody restarted it — and the newest migration is the one that takes the tables off
    Supabase's Data API, so "until somebody notices" is the wrong duration for it."""
    import threading

    from app import db as db_module
    from app import main

    monkeypatch.setenv("RC_DATABASE_URL", "postgresql://u:p@127.0.0.1:1/nothing-here")
    monkeypatch.setattr(main, "MIGRATION_RETRY_START_S", 0.01)
    monkeypatch.setattr(main, "MIGRATION_RETRY_MAX_S", 0.01)

    applied = threading.Event()
    attempts = []

    def _flaky():
        attempts.append(1)
        if len(attempts) < 3:
            raise RuntimeError("database is not up yet")
        applied.set()
        return ["0004_lock_out_the_data_api.sql"]

    monkeypatch.setattr(db_module, "migrate", _flaky)
    main._apply_migrations()

    assert applied.wait(timeout=5.0), f"retry never succeeded after {len(attempts)} attempts"
    assert len(attempts) >= 3
