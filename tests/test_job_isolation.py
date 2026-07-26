"""One user must not poll, cancel, or read another user's background jobs.

These tests pin a property that slice 2a delivered WITHOUT any job-specific code, which is worth
recording explicitly rather than assuming: `JobRegistry.get`/`snapshot`/`cancel` already refuse a
job whose owning project is not the ambient one, and every project-scoped job route hangs off
`make_project_router()` — so the ownership check on `use_project` covers them.

An assumption like that is exactly what was wrong twice in slice 2a ("one choke point covers all 73
routes"), so it is asserted here instead of argued.

The audio registry is deliberately app-global (`project_id=None`) so identical narration requested
from anywhere shares one job, and it is therefore NOT covered by any of this. That is the audio
ownership redesign, which is a product decision rather than a bug fix — see P1-2 and slice 5.
"""
from __future__ import annotations

import os
import time

import pytest
from app import config, db, projects, tenancy

ALICE = "f4a33e1b-b3c4-4eb2-a0ea-d110b36a072e"
BOB = "c3fa116b-f010-4d95-8aae-6dc13e1292a4"

TEST_DB = os.environ.get("RC_TEST_DATABASE_URL", "").strip()
needs_pg = pytest.mark.skipif(not TEST_DB, reason="set RC_TEST_DATABASE_URL to run these")


@pytest.fixture
def two_users(tmp_path, monkeypatch):
    root = tmp_path / "projects"
    root.mkdir()
    monkeypatch.setattr(config, "PROJECTS_ROOT", root)
    monkeypatch.setenv("RC_DATABASE_URL", TEST_DB)
    db.close()
    with db.pool().connection() as conn:
        conn.execute("drop table if exists rc_projects, rc_users, rc_schema_migrations cascade")
    db.migrate()

    tenancy.ensure_user(ALICE, "alice@example.com")
    tenancy.ensure_user(BOB, "bob@example.com")
    alice_pid = projects.create_project("Alice Reading")["id"]
    bob_pid = projects.create_project("Bob Reading")["id"]
    tenancy.record_project(alice_pid, ALICE)
    tenancy.record_project(bob_pid, BOB)
    yield {"alice": alice_pid, "bob": bob_pid}
    db.close()


@pytest.fixture
def client_as(monkeypatch):
    from app import auth
    from app.main import app
    from starlette.testclient import TestClient

    def _make(user_id: str):
        monkeypatch.setattr(auth, "enabled", lambda: True)
        monkeypatch.setattr(auth, "mode", lambda: "supabase")
        monkeypatch.setattr(
            auth, "check", lambda _t: {"user_id": user_id, "email": f"{user_id}@example.com"})
        return TestClient(app, headers={"Authorization": "Bearer test"})

    return _make


def test_a_job_is_invisible_outside_the_project_that_owns_it():
    """The registry-level guarantee that everything below rests on. No database and no HTTP: this
    must hold for the single-tenant instance too, because it is what stops a leaked job id being
    useful."""
    from app.jobs import Job, JobRegistry

    registry: JobRegistry[Job] = JobRegistry("test-isolation", max_finished=10)
    job = registry.start_or_join(
        "key", lambda: Job(id="job-1"), lambda _job: None, project_id="alice-reading")

    assert registry.get(job.id, project_id="alice-reading") is not None
    assert registry.get(job.id, project_id="bob-reading") is None
    assert registry.snapshot(job.id, project_id="bob-reading") is None
    # `cancel` returns the job, or None when the id is unknown OR not owned by this project —
    # None is the refusal, not False.
    assert registry.cancel(job.id, project_id="bob-reading") is None
    assert registry.cancel(job.id, project_id="alice-reading") is not None


@needs_pg
@pytest.mark.parametrize("path", [
    "/api/projects/{pid}/notes/jobs/{job}",
    "/api/projects/{pid}/graph/authors/profile/jobs/{job}",
    "/api/projects/{pid}/chat/jobs/{job}",
])
def test_bob_cannot_poll_a_job_through_alices_project(two_users, client_as, path):
    """Bob naming Alice's project is refused by `use_project` before the job id is even read, so a
    leaked job id buys nothing."""
    url = path.format(pid=two_users["alice"], job="any-job-id")
    assert client_as(BOB).get(url).status_code == 404


@needs_pg
def test_bob_cannot_poll_alices_job_through_his_own_project(two_users, client_as):
    """The other half, and the one ownership alone does NOT cover: Bob is legitimately allowed into
    his own project, so the refusal has to come from the job being bound to a different one."""
    from app import chat_jobs

    token = config.set_active_project(two_users["alice"])
    try:
        from app.jobs import Job
        alice_job = chat_jobs._registry.start_or_join(
            "k", lambda: Job(id="alice-job"), lambda _job: None,
            project_id=two_users["alice"])
    finally:
        config.reset_active_project(token)

    # Bob's own project — allowed — but Alice's job id.
    response = client_as(BOB).get(
        f"/api/projects/{two_users['bob']}/chat/jobs/{alice_job.id}")
    assert response.status_code == 404


def test_pruning_cannot_discard_another_scope_s_finished_job():
    """`max_finished` used to apply across every project and user at once, so retention of YOUR
    result depended on how busy everybody else was. For `notes` that is data loss with a price on
    it: an agent proposal lives only in the registry until a human approves it (invariant 4), so
    other people's finished jobs could evict a completed, paid, unapproved proposal and
    `/notes/jobs/latest` would then report nothing to approve."""
    from app.jobs import Job, JobRegistry

    registry: JobRegistry[Job] = JobRegistry("test-prune", max_finished=2)

    def _finished(scope: str, key: str) -> Job:
        job = registry.start_or_join(key, lambda: Job(id=f"{scope}-{key}"),
                                     lambda _job: None, project_id=scope)
        for _ in range(200):
            if job.status != "running":
                break
            time.sleep(0.01)
        return job

    alices = _finished("alice-project", "proposal")
    for n in range(6):                       # well past the cap, all from another scope
        _finished("bob-project", f"noise-{n}")

    assert registry.get(alices.id, project_id="alice-project") is not None
    # Bob's own scope is still bounded — this is a per-scope cap, not the removal of one.
    # `max_finished + 1` at rest, not `max_finished`: pruning runs at admission, when the newest
    # job is still `running` and therefore not yet counted. That was true of the global cap too.
    bob_finished = [j for j in registry.jobs.values()
                    if getattr(j, "_rc_project_id", None) == "bob-project"]
    assert len(bob_finished) <= 3, bob_finished


def test_retention_stays_bounded_when_scopes_are_unbounded():
    """The per-scope cap alone would have removed the process-wide bound: for notes/chat/preview the
    scope is a PROJECT, and nothing limits how many projects a user creates, so one finished job in
    each of ten thousand projects exceeds no local cap and is never pruned. The second bound is on
    how many scopes keep history, and it evicts the least recently active one — "a project you have
    not touched aged out" is a defensible rule in a way that "somebody else was busy" is not.
    """
    from app import jobs as jobs_module
    from app.jobs import Job, JobRegistry

    registry: JobRegistry[Job] = JobRegistry("test-scope-bound", max_finished=2)

    def _finished(scope: str, key: str) -> Job:
        job = registry.start_or_join(key, lambda: Job(id=f"{scope}-{key}"),
                                     lambda _job: None, project_id=scope)
        for _ in range(200):
            if job.status != "running":
                break
            time.sleep(0.01)
        return job

    first = _finished("project-0000", "only")
    for n in range(1, jobs_module._MAX_SCOPES_RETAINED + 12):
        _finished(f"project-{n:04d}", "only")

    scopes = {getattr(j, "_rc_project_id", None) for j in registry.jobs.values()}
    assert len(scopes) <= jobs_module._MAX_SCOPES_RETAINED + 1, len(scopes)
    # The oldest scope is the one that went, not an arbitrary one.
    assert registry.get(first.id, project_id="project-0000") is None
    # And the most recent scope is still there.
    newest = f"project-{jobs_module._MAX_SCOPES_RETAINED + 11:04d}"
    assert newest in scopes


def test_the_ceiling_holds_at_rest_not_only_under_traffic():
    """Only running jobs are exempt from the caps, so pruning at admission alone leaves a hole:
    start many jobs in many scopes concurrently, let them all finish, and nothing counts them until
    the next admission — which may never come. The bound has to hold when the process goes quiet,
    which is exactly when it would otherwise be holding the most."""
    import threading

    from app import jobs as jobs_module
    from app.jobs import Job, JobRegistry

    registry: JobRegistry[Job] = JobRegistry("test-settle-prune", max_finished=2)
    release = threading.Event()
    started = []

    total = jobs_module._MAX_SCOPES_RETAINED + 15
    for _n in range(total):
        started.append(registry.start_or_join(
            "only", lambda: Job(id=f"job-{len(started):04d}"),
            lambda _job: release.wait(10), project_id=f"project-{len(started):04d}"))

    # Every scope is admitted while its job is still running, so no cap has bitten yet.
    release.set()
    deadline = time.time() + 10
    while time.time() < deadline:
        if all(j.status != "running" for j in started):
            break
        time.sleep(0.01)
    assert all(j.status != "running" for j in started), "workers never finished"

    # No further admission happens. The ceiling must hold anyway.
    scopes = {getattr(j, "_rc_project_id", None) for j in registry.jobs.values()}
    assert len(scopes) <= jobs_module._MAX_SCOPES_RETAINED, len(scopes)


def test_a_long_running_job_is_not_evicted_by_its_own_completion():
    """Scope recency has to be when a scope last SETTLED something, not when it last STARTED
    something. Ranking by `started_at` meant a notes job that ran for an hour and finished last
    carried its scope's rank from that old start time — so it was chosen as the coldest scope and
    deleted during its own completion, destroying the unapproved proposal that exists nowhere else.
    The longer the job, the likelier it was to be thrown away.
    """
    import threading

    from app import jobs as jobs_module
    from app.jobs import Job, JobRegistry

    registry: JobRegistry[Job] = JobRegistry("test-recency", max_finished=2)
    release = threading.Event()

    slow = registry.start_or_join("only", lambda: Job(id="slow"),
                                  lambda _job: release.wait(10), project_id="project-slow")

    # Everything else starts later AND finishes first, so `started_at` ranks the slow scope coldest.
    for n in range(jobs_module._MAX_SCOPES_RETAINED + 5):
        job = registry.start_or_join("only", lambda n=n: Job(id=f"fast-{n}"),
                                     lambda _job: None, project_id=f"project-fast-{n:04d}")
        for _ in range(200):
            if job.status != "running":
                break
            time.sleep(0.01)

    release.set()
    deadline = time.time() + 10
    while slow.status == "running" and time.time() < deadline:
        time.sleep(0.01)
    assert slow.status != "running", "the slow worker never finished"

    assert registry.get(slow.id, project_id="project-slow") is not None, (
        "the just-finished job was evicted by its own completion")


def test_a_long_running_job_is_not_evicted_by_its_own_completion_within_one_scope():
    """The same defect one level down, and the one I left in place last round by reasoning that
    within a scope the job's own age was the right notion. It is not: a notes proposal that ran for
    an hour while twenty quick ones came and went started earliest, so ordering by `started_at`
    drops it the moment it settles — no other user involved, same lost proposal."""
    import threading

    from app.jobs import Job, JobRegistry

    registry: JobRegistry[Job] = JobRegistry("test-recency-in-scope", max_finished=3)
    release = threading.Event()

    slow = registry.start_or_join("slow", lambda: Job(id="slow"),
                                  lambda _job: release.wait(10), project_id="one-project")
    for n in range(8):
        job = registry.start_or_join(f"fast-{n}", lambda n=n: Job(id=f"fast-{n}"),
                                     lambda _job: None, project_id="one-project")
        for _ in range(200):
            if job.status != "running":
                break
            time.sleep(0.01)

    release.set()
    deadline = time.time() + 10
    while slow.status == "running" and time.time() < deadline:
        time.sleep(0.01)
    assert slow.status != "running", "the slow worker never finished"

    assert registry.get(slow.id, project_id="one-project") is not None, (
        "the just-finished job was evicted by its own completion, inside its own scope")


def test_the_audio_job_scope_is_a_pseudonym_not_the_users_id():
    """The registry tags every start/done/error line with the job's scope, so a raw Supabase id
    here would write a durable account identifier — and when that account listens to things — into
    whatever Fly ships logs to."""
    from app import audio_jobs, config

    config.set_active_user(ALICE)
    try:
        scope = audio_jobs._audio_scope()
    finally:
        config.set_active_user(None)

    assert scope is not None
    assert ALICE not in scope
    assert scope.endswith(config.APP_STATE_DIR.name) is False  # sanity: not a path
