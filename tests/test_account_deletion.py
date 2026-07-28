from __future__ import annotations

import asyncio
import os
import threading
import time

import pytest
from app import account_deletion, auth, config, db, deploy_guard, jobs, supabase_admin, tenancy
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
    monkeypatch.setattr(
        account_deletion.projects,
        "provisionally_owned_projects",
        lambda _uid: {"provisional"},
    )
    monkeypatch.setattr(account_deletion.projects, "trashed_project_entries", lambda: [name])
    monkeypatch.setattr(tenancy, "trash_owner_of", lambda _name: None)

    live, trash = account_deletion._owned_data(USER_ID)

    assert live == {"live", "provisional"}
    assert trash == {"indexed", name}


def test_transition_owner_refuses_ambiguous_unindexed_incarnations(monkeypatch):
    names = [
        "legacy-project-20260728-010203",
        "legacy-project-20260729-010203",
    ]
    monkeypatch.setattr(tenancy, "projects_owned_by", lambda _uid: set())
    monkeypatch.setattr(tenancy, "trash_entries_owned_by", lambda _uid: set())
    monkeypatch.setattr(tenancy, "transition_projects_owned_by", lambda _uid: {"legacy-project"})
    monkeypatch.setattr(
        account_deletion.projects,
        "provisionally_owned_projects",
        lambda _uid: set(),
    )
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


def test_tombstone_lookup_does_not_run_on_the_event_loop(monkeypatch):
    """`is_blocked` is synchronous psycopg and the auth middleware is a coroutine.

    A `@app.middleware("http")` coroutine runs ON the event loop, unlike the sync dependencies every
    other database caller here reaches Postgres from. Left on the loop, one round trip per
    authenticated request serializes ALL request handling behind it — and on a slow database
    `pool().connection()` blocks up to its 10s timeout, turning degradation into a total stall
    instead of the intended per-request 503. Single worker, so nothing absorbs it.

    Asserted by the absence of a running loop rather than by a thread name: a threadpool worker has
    no running loop, the event loop thread does, and that distinction is the property itself.
    """
    from app.main import app

    _authenticated(monkeypatch)
    on_loop: list[bool] = []

    def probe(_uid):
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            on_loop.append(False)
        else:
            on_loop.append(True)
        return False

    monkeypatch.setattr(account_deletion, "is_blocked", probe)

    TestClient(app).get("/api/settings", headers={"Authorization": "Bearer valid"})

    assert on_loop == [False]


def test_boot_survives_a_deploy_guard_it_cannot_acquire(monkeypatch):
    """An unreachable database must not make `import app.main` raise.

    It did: the boot-time `deploy_guard.start()` was an unguarded module-scope call, strictly more
    fatal than the migrations below it — whose docstring already gives the rule, that on Fly an
    unbootable image is a crash loop needing a human. The timeout matters too: the default budget
    is ten minutes, and a peer holding the exclusive lock (a deletion on the retiring process
    during a rolling deploy) is exactly the case this feature exists for, so the replacement
    machine would hang its whole import waiting for it.
    """
    from app import main as app_main

    monkeypatch.setattr(app_main.db, "enabled", lambda: True)
    monkeypatch.setattr(app_main, "GUARD_RETRY_START_S", 0.01)
    timeouts: list[float | None] = []

    def flaky_start(*, timeout_s=None):
        timeouts.append(timeout_s)
        if len(timeouts) < 3:
            raise OSError("connection refused")
        return True

    monkeypatch.setattr(app_main.deploy_guard, "start", flaky_start)

    app_main._start_deploy_guard()          # must not raise

    deadline = time.monotonic() + 5
    while len(timeouts) < 3 and time.monotonic() < deadline:
        time.sleep(0.01)
    assert len(timeouts) == 3, "the background retry never ran"
    # Bounded on every attempt, never the ten-minute default.
    assert timeouts == [app_main.GUARD_BOOT_TIMEOUT_S] * 3


def test_recover_shared_tolerates_a_transient_failure(monkeypatch):
    """One failed round trip is not proof the guard was lost, and treating it as proof used to
    SIGTERM a healthy process over a two-second database blip."""
    monkeypatch.setattr(deploy_guard, "_GUARD_RECOVERY_POLL_S", 0.01)
    session = object()
    attempts = {"n": 0}

    def flaky(_timeout_s):
        attempts["n"] += 1
        if attempts["n"] < 3:
            raise OSError("blip")
        return session

    monkeypatch.setattr(deploy_guard, "_take_shared", flaky)

    assert deploy_guard._recover_shared(5.0) is session
    assert attempts["n"] == 3, "it succeeded first try, so nothing about retrying was tested"


def test_recover_shared_gives_up_when_the_lock_is_genuinely_held(monkeypatch):
    """The recovery attempt IS the test for a lost guard: a peer's exclusive lock is incompatible
    with `pg_try_advisory_lock_shared`, so it keeps failing and this must still resolve to None so
    the caller terminates. Tolerating a blip must not become tolerating an actual loss."""
    monkeypatch.setattr(deploy_guard, "_GUARD_RECOVERY_POLL_S", 0.01)
    attempts = {"n": 0}

    def never(_timeout_s):
        attempts["n"] += 1
        raise TimeoutError("deploy-guard-shared")

    monkeypatch.setattr(deploy_guard, "_take_shared", never)

    assert deploy_guard._recover_shared(0.05) is None
    assert attempts["n"] > 0


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


def test_failed_attempt_retry_delay_is_bounded():
    assert account_deletion._retry_delay_s(1) == 5
    assert account_deletion._retry_delay_s(2) == 10
    assert account_deletion._retry_delay_s(99) == 300


def test_deploy_guard_io_timeout_bounds_blackholed_connection():
    release = threading.Event()

    class HangingConnection:
        def execute(self, _query, _params=None):
            release.wait()

    try:
        with pytest.raises(TimeoutError, match="deploy-guard-io"):
            deploy_guard._execute_bounded(
                HangingConnection(),
                "select 1",
                timeout_s=0.01,
            )
    finally:
        release.set()


def test_deploy_guard_lock_wait_has_deadline(monkeypatch):
    class Cursor:
        def fetchone(self):
            return (False,)

    class BusyConnection:
        def execute(self, _query, _params=None):
            return Cursor()

    # A frozen clock, not a two-element iterator. The iterator made the test depend on the exact
    # NUMBER of `time.monotonic()` calls in the function under test: adding one anywhere — a log
    # line, a metric — exhausted it, and the test then failed with `StopIteration` instead of
    # saying anything about deadlines. Freezing time expresses the actual precondition, which is
    # that no time passes, so the deadline can only be reached by the budget being zero.
    monkeypatch.setattr(deploy_guard.time, "monotonic", lambda: 10.0)

    with pytest.raises(TimeoutError, match="deploy-guard-exclusive"):
        deploy_guard._wait_for_advisory_lock(
            BusyConnection(),
            shared=False,
            timeout_s=0,
        )


def test_deploy_guard_local_lock_wait_has_deadline(monkeypatch):
    monkeypatch.setattr(deploy_guard.db, "enabled", lambda: True)
    deploy_guard._destructive_lock.acquire()
    started = time.monotonic()
    try:
        with pytest.raises(TimeoutError, match="deploy-guard-local-exclusive"):
            deploy_guard.acquire_exclusive(timeout_s=0.01)
    finally:
        deploy_guard._destructive_lock.release()

    assert time.monotonic() - started < 0.5


def test_exclusive_guard_loss_is_fatal_once(monkeypatch):
    class LostConnection:
        def execute(self, _query, _params=None):
            raise OSError("connection lost")

    drains: list[bool] = []
    signals: list[tuple[int, int]] = []
    monkeypatch.setattr(config, "begin_global_job_drain", lambda: drains.append(True))
    monkeypatch.setattr(
        deploy_guard.os,
        "kill",
        lambda pid, sig: signals.append((pid, sig)),
    )
    lease = deploy_guard.ExclusiveLease(LostConnection())

    with pytest.raises(deploy_guard.DeployGuardLost):
        deploy_guard.assert_exclusive(lease)
    with pytest.raises(deploy_guard.DeployGuardLost):
        deploy_guard.assert_exclusive(lease)

    assert drains == [True]
    assert signals == [(os.getpid(), deploy_guard.signal.SIGTERM)]


def test_watchdog_waking_into_a_normal_release_does_not_terminate(monkeypatch):
    """A successful deletion must not SIGTERM the process on its way out.

    `release_exclusive` sets `stop`, then takes the lease's io lock and closes the connection
    while holding it. A watchdog that woke just before `stop` was set is already past the loop
    condition and blocks on that lock; when it gets it, the session is closed. Reading that as a
    lost guard kills a process whose deletion actually succeeded.
    """
    class Cursor:
        def fetchone(self):
            return (True,)

    class Conn:
        def __init__(self):
            self.closed = False

        def execute(self, _query, _params=None):
            if self.closed:
                raise OSError("connection is closed")
            return Cursor()

        def close(self):
            self.closed = True

    class CountingLock:
        """A real lock that reports how many acquisitions have been *attempted*."""

        def __init__(self):
            self._lock = threading.Lock()
            self.attempts = 0
            self._attempts_lock = threading.Lock()

        def acquire(self, *args, **kwargs):
            with self._attempts_lock:
                self.attempts += 1
            return self._lock.acquire(*args, **kwargs)

        def release(self):
            self._lock.release()

        def __enter__(self):
            self.acquire()
            return self

        def __exit__(self, *_exc):
            self.release()

    signals: list[tuple[int, int]] = []
    monkeypatch.setattr(deploy_guard.os, "kill", lambda pid, sig: signals.append((pid, sig)))
    monkeypatch.setattr(deploy_guard, "_CHECK_S", 0.01)

    conn = Conn()
    lease = deploy_guard.ExclusiveLease(conn)
    io_lock = CountingLock()
    lease.io_lock = io_lock

    # Stand in for `release_exclusive` holding the lock across its unlock-and-close.
    io_lock.acquire()
    watchdog = threading.Thread(target=deploy_guard._watch_exclusive, args=(lease,), daemon=True)
    watchdog.start()

    # Wait for the watchdog to be genuinely blocked on the lock rather than sleeping through it.
    deadline = time.monotonic() + 5
    while io_lock.attempts < 2:
        assert time.monotonic() < deadline, "watchdog never reached the io lock"
        time.sleep(0.01)

    # Now finish the release exactly as `release_exclusive` does.
    lease.stop.set()
    conn.close()
    io_lock.release()

    watchdog.join(timeout=5)
    assert not watchdog.is_alive()
    assert signals == []
    assert lease.lost.is_set() is False


def test_exclusivity_lost_in_the_overlap_window_removes_nothing(monkeypatch):
    """`_run` consults the lease at least once between the overlap wait and the first `rmtree`.

    The lease is acquired BEFORE the 310-second overlap wait, so holding it at acquisition proves
    nothing about the moment of deletion: a lease that died during that wait means a peer could
    have taken exclusivity and be writing the very trees this attempt is about to remove. The
    primitive-level tests above prove `assert_exclusive` raises; this proves `_run` acts on it.

    Stated precisely, because an earlier version of this docstring claimed more than the test
    delivers. `_run` has two `assert_exclusive` calls in that span and only one is needed to fail
    the attempt, so removing either one alone leaves this green — the second still fires before
    `_owned_data`, and the only thing between them is a status read. That is not a gap worth
    closing with a sharper test; it is the accurate description of the property, which is a
    boundary ("nothing is removed without a live lease") rather than a specific call site.
    """
    class LostConnection:
        def execute(self, _query, _params=None):
            raise OSError("connection lost")

    lease = deploy_guard.ExclusiveLease(LostConnection())
    released: list[object] = []
    removed: list[object] = []
    statuses: list[tuple[str, str | None]] = []

    monkeypatch.setattr(deploy_guard, "acquire_exclusive", lambda **_kw: lease)
    monkeypatch.setattr(deploy_guard, "release_exclusive", lambda held: released.append(held))
    # Guard loss is process-fatal by design; keep the signal off the pytest process itself.
    monkeypatch.setattr(deploy_guard.os, "kill", lambda _pid, _sig: None)
    monkeypatch.setattr(account_deletion, "_wait_for_prior_deploy_processes", lambda: None)
    monkeypatch.setattr(account_deletion, "status_for", lambda _uid: None)
    monkeypatch.setattr(account_deletion, "_owned_data", lambda _uid: ({"alpha"}, {"alpha-trash"}))
    monkeypatch.setattr(account_deletion, "_remove_tree", lambda path: removed.append(path))
    monkeypatch.setattr(account_deletion, "_retire_database_rows", lambda _uid: None)
    monkeypatch.setattr(
        account_deletion,
        "_set_status",
        lambda _key, status, *, error_code=None, **_kw: statuses.append((status, error_code)),
    )

    # `_terminate_for_guard_loss` opens a drain the terminating process would never close.
    drains_before = config.global_job_drain_active()
    try:
        account_deletion._run(USER_ID)
    finally:
        while config.global_job_drain_active() != drains_before:
            config.end_global_job_drain()

    assert removed == []
    assert ("error", "draining:DeployGuardLost") in statuses
    assert released == [lease]


def test_streaming_request_stays_admitted_until_its_body_stops(monkeypatch):
    """Middleware dispatch returns before an SSE body is consumed. The request drain must follow
    the body iterator or account deletion can remove a project under a still-writing stream."""
    from app.main import app

    _authenticated(monkeypatch)
    monkeypatch.setattr(account_deletion, "is_blocked", lambda _uid: False)
    started = threading.Event()
    release = threading.Event()
    path = "/api/test/account-deletion-stream-lifetime"

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
    # `app` is a module-level singleton shared by every test in the suite, so a route left behind
    # here is visible to all of them — including anything that enumerates routes or reads the
    # OpenAPI schema. The previous shape guarded registration with an `if not already present`,
    # which made the test idempotent but left the route installed for the rest of the session.
    # Registering unconditionally and removing in `finally` keeps the app as it was found.
    try:
        _run_streaming_lifetime_assertions(path, started, release)
    finally:
        app.routes.remove(test_route)
        app.openapi_schema = None   # the cached schema was built with the test route in it


def _run_streaming_lifetime_assertions(path, started, release):
    from app.main import app

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
    deploy_guard.stop()
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


@needs_pg
def test_active_rescan_retries_due_error_after_identity_response_loss(database, monkeypatch):
    key = account_deletion.subject_key(USER_ID)
    with db.pool().connection() as conn:
        conn.execute(
            "insert into rc_account_deletions "
            "(subject_key, user_id, status, attempts, updated_at) "
            "values (%s, %s, 'error', 2, now() - interval '11 seconds')",
            (key, USER_ID),
        )
    monkeypatch.setattr(supabase_admin, "configured", lambda: True)
    started: list[str] = []
    monkeypatch.setattr(account_deletion, "start_worker", lambda uid: started.append(uid) or True)

    assert account_deletion.resume_active() == 1
    assert started == [USER_ID]


@needs_pg
def test_destructive_guard_takes_database_exclusivity_and_restores_process_guard(database):
    deploy_guard.start()

    token = deploy_guard.acquire_exclusive()
    assert token is not None
    deploy_guard.release_exclusive(token)

    # Idempotent means the release path already restored the shared lifetime lock.
    assert deploy_guard.start() is False
