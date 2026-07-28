from __future__ import annotations

import os
import threading
import time

import pytest
from app import account_deletion, auth, config, db, jobs, supabase_admin, tenancy
from app.jobs import Job, JobRegistry
from fastapi.responses import StreamingResponse
from starlette.testclient import TestClient

USER_ID = "715ed5db-f090-4b8c-a067-640ecee36aa0"


@pytest.fixture(autouse=True)
def _reset_admission_state():
    config.unmark_user_deleting(USER_ID)
    while config.active_request_count(USER_ID):
        config.release_user_request(USER_ID)
    yield
    config.unmark_user_deleting(USER_ID)
    while config.active_request_count(USER_ID):
        config.release_user_request(USER_ID)


def test_user_gate_drains_requests_that_won_before_deletion():
    assert config.admit_user_request(USER_ID) is True
    config.mark_user_deleting(USER_ID)

    assert config.active_request_count(USER_ID) == 1
    assert config.admit_user_request(USER_ID) is False

    config.release_user_request(USER_ID)
    assert config.active_request_count(USER_ID) == 0


def test_user_gate_refuses_background_job_admission():
    registry: JobRegistry[Job] = JobRegistry("deleting-user")
    token = config.set_active_user(USER_ID)
    config.mark_user_deleting(USER_ID)
    try:
        with pytest.raises(RuntimeError, match="Account is being deleted"):
            registry.start_or_join("new", lambda: Job(id="new"), lambda _job: None)
        with pytest.raises(RuntimeError, match="Account is being deleted"):
            registry.put("cached", Job(id="cached", status="done"))
    finally:
        config.reset_active_user(token)
        jobs._ALL_REGISTRIES.remove(registry)


def test_request_refuses_before_persisting_when_admin_secret_is_missing(monkeypatch):
    monkeypatch.setattr(account_deletion.db, "enabled", lambda: True)
    monkeypatch.setattr(supabase_admin, "configured", lambda: False)

    with pytest.raises(account_deletion.AccountDeletionUnavailable):
        account_deletion.request(USER_ID)
    assert config.user_is_deleting(USER_ID) is False


def test_transition_owner_adds_one_unindexed_trash_incarnation(monkeypatch):
    name = "legacy-project-20260728-010203"
    monkeypatch.setattr(tenancy, "projects_owned_by", lambda _uid: {"live"})
    monkeypatch.setattr(tenancy, "trash_entries_owned_by", lambda _uid: {"indexed"})
    monkeypatch.setattr(tenancy, "transition_projects_owned_by", lambda _uid: {"legacy-project"})
    monkeypatch.setattr(account_deletion.projects, "trashed_project_entries", lambda: [name])
    monkeypatch.setattr(tenancy, "trash_owner_of", lambda _name: None)

    live, trash = account_deletion._owned_data(USER_ID)

    assert live == {"live"}
    assert trash == {"indexed", name}


def test_transition_owner_refuses_ambiguous_unindexed_incarnations(monkeypatch):
    names = [
        "legacy-project-20260728-010203",
        "legacy-project-20260729-010203",
    ]
    monkeypatch.setattr(tenancy, "projects_owned_by", lambda _uid: set())
    monkeypatch.setattr(tenancy, "trash_entries_owned_by", lambda _uid: set())
    monkeypatch.setattr(tenancy, "transition_projects_owned_by", lambda _uid: {"legacy-project"})
    monkeypatch.setattr(account_deletion.projects, "trashed_project_entries", lambda: names)
    monkeypatch.setattr(tenancy, "trash_owner_of", lambda _name: None)

    with pytest.raises(RuntimeError, match="ambiguous-transition-trash"):
        account_deletion._owned_data(USER_ID)


def test_coordinator_removes_every_owned_tree_then_identity(tmp_path, monkeypatch):
    project_id = "owned-project"
    trash_name = "older-project-20260728-010203"
    project_dir = tmp_path / "projects" / project_id
    trash_dir = tmp_path / "projects" / ".trash" / trash_name
    user_dir = tmp_path / "state" / "users" / config.user_scope_key_for(USER_ID)
    for directory in (project_dir, trash_dir, user_dir):
        directory.mkdir(parents=True)
        (directory / "private.txt").write_text("private")

    monkeypatch.setattr(config, "PROJECTS_ROOT", tmp_path / "projects")
    monkeypatch.setattr(config, "APP_STATE_DIR", tmp_path / "state")
    monkeypatch.setattr(
        account_deletion, "_owned_data", lambda _uid: ({project_id}, {trash_name}))
    monkeypatch.setattr(config, "active_request_count", lambda _uid: 0)
    monkeypatch.setattr(jobs, "request_cancellation_for_scopes", lambda _scopes: 0)
    monkeypatch.setattr(jobs, "any_active_for_scopes", lambda _scopes: None)
    forgotten: list[set[str]] = []
    monkeypatch.setattr(
        jobs, "forget_inactive_for_scopes", lambda scopes: forgotten.append(scopes))
    retired: list[str] = []
    monkeypatch.setattr(
        account_deletion, "_retire_database_rows", lambda uid: retired.append(uid))
    deleted_identity: list[str] = []
    monkeypatch.setattr(supabase_admin, "delete_user", lambda uid: deleted_identity.append(uid))
    states: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        account_deletion,
        "_set_status",
        lambda _key, status, **kwargs: states.append((status, kwargs)),
    )

    account_deletion._run(USER_ID)

    assert not project_dir.exists()
    assert not trash_dir.exists()
    assert not user_dir.exists()
    assert retired == [USER_ID]
    assert deleted_identity == [USER_ID]
    assert [status for status, _kwargs in states] == [
        "draining", "deleting_data", "deleting_identity", "completed"]
    assert states[-1][1]["completed"] is True
    assert forgotten == [{project_id, f"user:{config.user_scope_key_for(USER_ID)}"}]
    assert config.project_is_deleting(project_id) is False


def test_identity_failure_is_sanitized_and_retryable_after_app_data_cleanup(
    tmp_path, monkeypatch,
):
    monkeypatch.setattr(config, "PROJECTS_ROOT", tmp_path / "projects")
    monkeypatch.setattr(config, "APP_STATE_DIR", tmp_path / "state")
    monkeypatch.setattr(account_deletion, "_owned_data", lambda _uid: (set(), set()))
    monkeypatch.setattr(config, "active_request_count", lambda _uid: 0)
    monkeypatch.setattr(jobs, "request_cancellation_for_scopes", lambda _scopes: 0)
    monkeypatch.setattr(jobs, "any_active_for_scopes", lambda _scopes: None)
    monkeypatch.setattr(jobs, "forget_inactive_for_scopes", lambda _scopes: None)
    monkeypatch.setattr(account_deletion, "_retire_database_rows", lambda _uid: None)
    secret_message = "private@example.com provider response"

    def fail(_uid):
        raise supabase_admin.SupabaseDeleteError("network:ConnectError")

    monkeypatch.setattr(supabase_admin, "delete_user", fail)
    states: list[tuple[str, str | None]] = []

    def record(_key, status, **kwargs):
        states.append((status, kwargs.get("error_code")))

    monkeypatch.setattr(account_deletion, "_set_status", record)
    account_deletion._run(USER_ID)

    assert states[-1] == ("error", "deleting_identity:network:ConnectError")
    assert secret_message not in str(states)
    assert config.user_is_deleting(USER_ID) is True


def _authenticated(monkeypatch):
    monkeypatch.setattr(auth, "enabled", lambda: True)
    monkeypatch.setattr(
        auth,
        "check",
        lambda _token: {
            "user_id": USER_ID,
            "email": "reader@example.com",
            "claims": {
                "iat": int(time.time()),
                "amr": [{"method": "oauth", "timestamp": int(time.time())}],
            },
        },
    )


def test_durable_tombstone_blocks_ordinary_routes_but_allows_status(monkeypatch):
    from app.main import app

    _authenticated(monkeypatch)
    monkeypatch.setattr(account_deletion, "is_blocked", lambda _uid: True)
    monkeypatch.setattr(
        account_deletion,
        "status_for",
        lambda _uid: {"status": "deleting_identity", "error_code": None},
    )
    client = TestClient(app)
    headers = {"Authorization": "Bearer valid"}

    blocked = client.get("/api/settings", headers=headers)
    assert blocked.status_code == 423
    assert blocked.json()["code"] == "account_deletion_in_progress"

    status = client.get("/api/account/deletion", headers=headers)
    assert status.status_code == 200
    assert status.json()["deletion"]["status"] == "deleting_identity"


def test_start_requires_exact_confirmation_and_recent_user_authentication(monkeypatch):
    from app.main import app

    _authenticated(monkeypatch)
    monkeypatch.setattr(account_deletion, "is_blocked", lambda _uid: False)
    monkeypatch.setattr(
        account_deletion,
        "request",
        lambda _uid: {"status": "pending", "error_code": None},
    )
    client = TestClient(app)
    headers = {"Authorization": "Bearer valid"}

    assert client.post(
        "/api/account/deletion", headers=headers, json={"confirmation": "delete"},
    ).status_code == 422
    accepted = client.post(
        "/api/account/deletion", headers=headers, json={"confirmation": "DELETE"},
    )
    assert accepted.status_code == 202
    assert accepted.json()["deletion"]["status"] == "pending"

    monkeypatch.setattr(
        auth,
        "check",
        lambda _token: {
            "user_id": USER_ID,
            # A token refresh is recent, but it is not a user-presence event and cannot authorize
            # irreversible deletion. The original OAuth method is outside the five-minute window.
            "claims": {
                "iat": int(time.time()),
                "amr": [
                    {"method": "oauth", "timestamp": int(time.time()) - 301},
                    {"method": "token_refresh", "timestamp": int(time.time())},
                ],
            },
        },
    )
    stale = client.post(
        "/api/account/deletion", headers=headers, json={"confirmation": "DELETE"},
    )
    assert stale.status_code == 401

    # Once the recent session has authorized and persisted deletion, retry is not a second
    # destructive decision. It must still work if Supabase identity deletion already succeeded
    # and a refresh token can no longer mint a new JWT.
    monkeypatch.setattr(
        account_deletion,
        "status_for",
        lambda _uid: {"status": "error", "error_code": "deleting_identity:network:Timeout"},
    )
    retry = client.post(
        "/api/account/deletion", headers=headers, json={"confirmation": "DELETE"},
    )
    assert retry.status_code == 202


def test_deploy_overlap_wait_is_measured_from_each_worker_attempt(monkeypatch):
    monotonic = iter((10.0, 10.11, 10.21))
    sleeps: list[float] = []
    monkeypatch.setattr(account_deletion, "DEPLOY_OVERLAP_S", 0.2)
    monkeypatch.setattr(account_deletion.time, "monotonic", lambda: next(monotonic))
    monkeypatch.setattr(account_deletion.time, "sleep", sleeps.append)

    account_deletion._wait_for_prior_deploy_processes()

    assert sleeps == [pytest.approx(0.09)]


def test_streaming_request_stays_admitted_until_its_body_stops(monkeypatch):
    """Middleware dispatch returns before an SSE body is consumed. The request drain must follow
    the body iterator or account deletion can remove a project under a still-writing stream."""
    from app.main import app

    _authenticated(monkeypatch)
    monkeypatch.setattr(account_deletion, "is_blocked", lambda _uid: False)
    started = threading.Event()
    release = threading.Event()
    path = "/api/test/account-deletion-stream-lifetime"

    if not any(getattr(route, "path", None) == path for route in app.routes):
        @app.get(path)
        def _test_stream():
            def body():
                started.set()
                yield b"started"
                release.wait(5)
                yield b"done"

            return StreamingResponse(body())
    # The production static mount is intentionally last at app assembly time; this test-only route
    # is registered later, so move it ahead of that catch-all mount.
    test_route = next(route for route in app.routes if getattr(route, "path", None) == path)
    app.routes.remove(test_route)
    app.routes.insert(0, test_route)

    def consume():
        with TestClient(app).stream(
            "GET", path, headers={"Authorization": "Bearer valid"},
        ) as response:
            assert response.status_code == 200
            b"".join(response.iter_bytes())

    thread = threading.Thread(target=consume)
    thread.start()
    assert started.wait(2)
    assert config.active_request_count(USER_ID) == 1
    config.mark_user_deleting(USER_ID)
    assert config.active_request_count(USER_ID) == 1

    release.set()
    thread.join(5)
    assert not thread.is_alive()
    assert config.active_request_count(USER_ID) == 0


TEST_DB = os.environ.get("RC_TEST_DATABASE_URL", "").strip()
needs_pg = pytest.mark.skipif(not TEST_DB, reason="set RC_TEST_DATABASE_URL to run this")


@pytest.fixture
def database(monkeypatch):
    monkeypatch.setenv("RC_DATABASE_URL", TEST_DB)
    db.close()
    with db.pool().connection() as conn:
        conn.execute(
            "drop table if exists rc_account_deletions, rc_project_trash, rc_user_settings, "
            "rc_projects, rc_users, rc_schema_migrations cascade",
        )
    db.migrate()
    yield
    db.close()


@needs_pg
def test_database_cleanup_retains_only_content_free_project_id_tombstones(database):
    live = "live-project"
    trashed = "trashed-project"
    trash_name = f"{trashed}-20260728-010203"
    tenancy.ensure_user(USER_ID, "reader@example.com")
    tenancy.record_project(live, USER_ID)
    tenancy.record_project(trashed, USER_ID)
    tenancy.release(trashed, trash_name)

    account_deletion._retire_database_rows(USER_ID)

    with db.pool().connection() as conn:
        assert conn.execute(
            "select 1 from rc_users where id = %s", (USER_ID,),
        ).fetchone() is None
        assert conn.execute(
            "select 1 from rc_project_trash where owner_id = %s", (USER_ID,),
        ).fetchone() is None
        rows = conn.execute(
            "select id, owner_id, deleted_owner_id, deleted_at is not null "
            "from rc_projects where id = any(%s) order by id",
            ([live, trashed],),
        ).fetchall()
    assert rows == [
        (live, None, None, True),
        (trashed, None, None, True),
    ]


@needs_pg
def test_completed_deletion_clears_raw_uuid_but_keeps_subject_gate(database):
    key = account_deletion.subject_key(USER_ID)
    with db.pool().connection() as conn:
        conn.execute(
            "insert into rc_account_deletions (subject_key, user_id) values (%s, %s)",
            (key, USER_ID),
        )

    account_deletion._set_status(key, "completed", completed=True)

    with db.pool().connection() as conn:
        row = conn.execute(
            "select user_id, status, completed_at is not null "
            "from rc_account_deletions where subject_key = %s",
            (key,),
        ).fetchone()
    assert row == (None, "completed", True)
    assert account_deletion.is_blocked(USER_ID) is True


@needs_pg
def test_active_rescan_finds_request_created_after_startup(database, monkeypatch):
    key = account_deletion.subject_key(USER_ID)
    with db.pool().connection() as conn:
        conn.execute(
            "insert into rc_account_deletions (subject_key, user_id, status) "
            "values (%s, %s, 'draining')",
            (key, USER_ID),
        )
    monkeypatch.setattr(supabase_admin, "configured", lambda: True)
    started: list[str] = []
    monkeypatch.setattr(account_deletion, "start_worker", lambda uid: started.append(uid) or True)

    assert account_deletion.resume_active() == 1
    assert started == [USER_ID]
