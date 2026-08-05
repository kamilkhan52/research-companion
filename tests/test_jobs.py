"""The shared JobRegistry: lifecycle, dedup/join, persist-before-done ordering, error capture,
the active-project contextvar rebind, and finished-job pruning."""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass

from app import config
from app.jobs import Job, JobRegistry, new_id


@dataclass
class SampleJob(Job):
    value: int = 0


def _settle(reg: JobRegistry, job_id: str, timeout: float = 5.0) -> Job:
    # Read the raw registry dict (not get(), which is project-scoped) so the helper can settle a
    # job regardless of which project it belongs to.
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = reg.jobs.get(job_id)
        if job and job.status != "running":
            return job
        time.sleep(0.01)
    raise TimeoutError(f"job {job_id} did not settle")


def test_runs_work_and_marks_done():
    reg: JobRegistry[SampleJob] = JobRegistry("t")
    job = reg.start_or_join("k", lambda: SampleJob(id=new_id()), lambda j: setattr(j, "value", 42))
    settled = _settle(reg, job.id)
    assert settled.status == "done"
    assert settled.value == 42
    assert settled.finished_at


def test_exception_becomes_an_error_job():
    reg: JobRegistry[SampleJob] = JobRegistry("t")

    def boom(_job):
        raise RuntimeError("kaboom")

    job = reg.start_or_join("k", lambda: SampleJob(id=new_id()), boom)
    settled = _settle(reg, job.id)
    assert settled.status == "error"
    assert "kaboom" in settled.error


def test_second_start_for_same_key_joins_the_running_job():
    reg: JobRegistry[SampleJob] = JobRegistry("t")
    release = threading.Event()

    def slow(_job):
        release.wait(2.0)

    first = reg.start_or_join("k", lambda: SampleJob(id=new_id()), slow)
    second = reg.start_or_join("k", lambda: SampleJob(id=new_id()), slow)
    assert second is first                       # joined, not a new job
    assert reg.active_for("k") is first
    release.set()
    _settle(reg, first.id)
    assert reg.active_for("k") is None           # no longer running


def test_durable_preparation_runs_once_and_concurrent_caller_joins():
    reg: JobRegistry[SampleJob] = JobRegistry("prepared")
    preparing = threading.Event()
    release_preparation = threading.Event()
    prepared: list[str] = []
    results: list[SampleJob] = []
    failures: list[BaseException] = []

    def prepare(job: SampleJob):
        # The callback may query registry state or wait on Postgres without deadlocking polling.
        assert reg.snapshot(job.id) is None
        prepared.append(job.id)
        preparing.set()
        assert release_preparation.wait(5)
        return None

    def start():
        try:
            results.append(reg.start_or_join(
                "same",
                lambda: SampleJob(id=new_id()),
                # Deliberately finishes immediately. The waiter must still share this published
                # attempt even if it wakes only after the worker has changed status to `done`.
                lambda _job: None,
                prepare_new=prepare,
            ))
        except BaseException as exc:  # pragma: no cover - asserted below
            failures.append(exc)

    first = threading.Thread(target=start)
    second = threading.Thread(target=start)
    first.start()
    assert preparing.wait(2)
    second.start()
    time.sleep(0.05)
    assert len(prepared) == 1
    assert second.is_alive()  # it is waiting for the first admission, not reserving again

    release_preparation.set()
    first.join(5)
    second.join(5)
    assert not failures
    assert len(results) == 2
    assert results[0] is results[1]
    assert len(prepared) == 1
    _settle(reg, results[0].id)


def test_slow_preparation_does_not_block_an_unrelated_job():
    reg: JobRegistry[SampleJob] = JobRegistry("prepared-independent")
    preparing = threading.Event()
    release = threading.Event()
    failures: list[BaseException] = []

    def prepare(_job: SampleJob):
        preparing.set()
        assert release.wait(5)
        return None

    def start_slow():
        try:
            reg.start_or_join(
                "slow", lambda: SampleJob(id="slow"), lambda _job: None,
                prepare_new=prepare,
            )
        except BaseException as exc:  # pragma: no cover - asserted below
            failures.append(exc)

    caller = threading.Thread(target=start_slow)
    caller.start()
    assert preparing.wait(2)

    fast = reg.start_or_join(
        "fast", lambda: SampleJob(id="fast"), lambda job: setattr(job, "value", 7),
    )
    assert _settle(reg, fast.id).value == 7
    assert caller.is_alive()

    release.set()
    caller.join(5)
    assert not failures


def test_failed_preparation_publishes_nothing_and_never_runs_work():
    reg: JobRegistry[SampleJob] = JobRegistry("prepared-failure")
    ran = threading.Event()

    def fail(_job: SampleJob):
        raise RuntimeError("reservation refused")

    import pytest

    with pytest.raises(RuntimeError, match="reservation refused"):
        reg.start_or_join(
            "k", lambda: SampleJob(id="never"), lambda _job: ran.set(), prepare_new=fail,
        )

    assert not ran.is_set()
    assert reg.jobs == {}
    assert reg._admitting == {}


def test_preparation_counts_as_active_work_and_rolls_back_if_deletion_wins():
    from app import jobs

    reg: JobRegistry[SampleJob] = JobRegistry("prepared-delete")
    preparing = threading.Event()
    release = threading.Event()
    rolled_back: list[str] = []
    failures: list[BaseException] = []

    def prepare(job: SampleJob):
        preparing.set()
        assert release.wait(5)
        return lambda: rolled_back.append(job.id)

    def start():
        try:
            reg.start_or_join(
                "k", lambda: SampleJob(id="prepared"), lambda _job: None,
                project_id="doomed", prepare_new=prepare,
            )
        except BaseException as exc:
            failures.append(exc)

    caller = threading.Thread(target=start)
    caller.start()
    assert preparing.wait(2)
    assert jobs.any_running_for_project("doomed") == "prepared-delete"
    assert config.mark_project_deleting("doomed") is True
    try:
        release.set()
        caller.join(5)
        assert len(failures) == 1
        assert "being modified" in str(failures[0])
        assert rolled_back == ["prepared"]
        assert reg.jobs == {}
        assert reg._admitting == {}
    finally:
        config.unmark_project_deleting("doomed")


def test_thread_start_failure_rolls_back_without_publishing(monkeypatch):
    reg: JobRegistry[SampleJob] = JobRegistry("prepared-start-failure")
    rolled_back: list[str] = []

    def fail_start(_thread):
        raise RuntimeError("thread unavailable")

    monkeypatch.setattr(threading.Thread, "start", fail_start)

    import pytest

    with pytest.raises(RuntimeError, match="thread unavailable"):
        reg.start_or_join(
            "k",
            lambda: SampleJob(id="never-started"),
            lambda _job: None,
            prepare_new=lambda job: lambda: rolled_back.append(job.id),
        )

    assert rolled_back == ["never-started"]
    assert reg.jobs == {}
    assert reg._admitting == {}


def test_thread_construction_failure_also_rolls_back(monkeypatch):
    reg: JobRegistry[SampleJob] = JobRegistry("prepared-thread-construction-failure")
    rolled_back: list[str] = []

    def fail_construction(*_args, **_kwargs):
        raise RuntimeError("thread construction unavailable")

    monkeypatch.setattr(threading, "Thread", fail_construction)

    import pytest

    with pytest.raises(RuntimeError, match="thread construction unavailable"):
        reg.start_or_join(
            "k",
            lambda: SampleJob(id="never-constructed"),
            lambda _job: None,
            prepare_new=lambda job: lambda: rolled_back.append(job.id),
        )

    assert rolled_back == ["never-constructed"]
    assert reg.jobs == {}
    assert reg._admitting == {}


def test_different_keys_run_independently():
    reg: JobRegistry[SampleJob] = JobRegistry("t")
    a = reg.start_or_join("a", lambda: SampleJob(id=new_id()), lambda j: setattr(j, "value", 1))
    b = reg.start_or_join("b", lambda: SampleJob(id=new_id()), lambda j: setattr(j, "value", 2))
    assert a.id != b.id
    assert _settle(reg, a.id).value == 1
    assert _settle(reg, b.id).value == 2


def test_result_is_visible_before_status_is_done():
    """The registry must set the payload (in work) before flipping status to done, so a poller
    that sees 'done' always sees the finished result — the persist-before-done guarantee."""
    reg: JobRegistry[SampleJob] = JobRegistry("t")
    job = reg.start_or_join("k", lambda: SampleJob(id=new_id()), lambda j: setattr(j, "value", 99))
    settled = _settle(reg, job.id)
    assert settled.status == "done" and settled.value == 99


def test_worker_rebinds_active_project(monkeypatch):
    reg: JobRegistry[SampleJob] = JobRegistry("t")
    monkeypatch.setattr(config, "set_active_project", config.set_active_project)
    token = config.set_active_project("proj-x")
    try:
        seen: dict = {}
        job = reg.start_or_join("k", lambda: SampleJob(id=new_id()),
                                lambda j: seen.update(pid=config.active_project_id()))
        _settle(reg, job.id)
        assert seen["pid"] == "proj-x"     # the worker thread saw the caller's active project
    finally:
        config.reset_active_project(token)


def test_snapshot_excludes_internal_dedup_key():
    reg: JobRegistry[SampleJob] = JobRegistry("t")
    job = reg.start_or_join("secret-key", lambda: SampleJob(id="fixed"), lambda j: None)
    _settle(reg, job.id)
    snap = reg.snapshot("fixed")
    assert "secret-key" not in snap.values()
    assert "_rc_dedup_key" not in snap
    assert "_rc_project_id" not in snap        # the owning-project attr never leaks either
    assert snap["id"] == "fixed"


def test_snapshot_of_unknown_id_is_none():
    reg: JobRegistry[SampleJob] = JobRegistry("t")
    assert reg.snapshot("nope") is None


def test_pruning_drops_oldest_finished_jobs():
    # Pruning runs when a new job is registered (while it's still "running", so uncounted), so
    # the bound is max_finished finished jobs + the one being registered — matches the original
    # per-module behavior. What matters: it stays bounded and evicts oldest-first.
    reg: JobRegistry[SampleJob] = JobRegistry("t", max_finished=3)
    ids = []
    for i in range(6):
        job = reg.start_or_join(f"k{i}", lambda: SampleJob(id=new_id()), lambda j: None)
        _settle(reg, job.id)
        ids.append(job.id)
    with reg.lock:
        assert len(reg.jobs) <= 4                 # bounded, not growing with every job
    assert reg.get(ids[0]) is None                # oldest evicted
    assert reg.get(ids[-1]) is not None           # newest kept


def test_scope_eviction_never_drops_a_worker_that_is_still_unwinding():
    """`_prune`'s scope cap deletes a cold scope's retained jobs *wholesale*.

    A cancelled job is terminal to the client, but Python cannot kill its thread — it may still be
    inside the project, and that registry record is the only thing telling deletion to wait. If the
    cap can evict it, an `rmtree` proceeds under a live writer. Reaching this branch needs more
    than `_MAX_SCOPES_RETAINED` scopes, which no other test creates.
    """
    from app import jobs

    reg: JobRegistry[SampleJob] = JobRegistry("scope-cap", max_finished=1)
    try:
        unwinding = SampleJob(id="unwinding", status="cancelled")
        setattr(unwinding, jobs._PID_ATTR, "cold-scope")
        setattr(unwinding, jobs._WORKER_ACTIVE_ATTR, True)
        with reg.lock:
            reg.jobs[unwinding.id] = unwinding
            # Stamped first, so its scope is the COLDEST by settle tick and is therefore the one
            # the cap chooses to evict. A later tick would make this test pass for free.
            reg._stamp_settled(unwinding)

            for i in range(jobs._MAX_SCOPES_RETAINED + 1):
                done = SampleJob(id=f"done-{i}", status="done")
                setattr(done, jobs._PID_ATTR, f"warm-{i}")
                setattr(done, jobs._WORKER_ACTIVE_ATTR, False)
                reg.jobs[done.id] = done
                reg._stamp_settled(done)

            before = len(reg.jobs)
            reg._prune()
            # The cap really did fire; otherwise this asserts nothing.
            assert len(reg.jobs) < before

        assert unwinding.id in reg.jobs
        assert jobs.any_active_for_scopes({"cold-scope"}) == "scope-cap"
    finally:
        jobs._ALL_REGISTRIES.remove(reg)


def test_put_registers_a_terminal_job_without_a_thread():
    reg: JobRegistry[SampleJob] = JobRegistry("t")
    job = SampleJob(id="cached", status="done", value=7)
    reg.put("k", job)
    assert reg.get("cached").value == 7
    assert reg.active_for("k") is None        # a done job isn't "running"


def test_cancelled_worker_blocks_project_deletion_until_its_thread_exits():
    """Cancellation is immediate client state, not proof that the worker has stopped touching
    files. Project deletion must follow actual thread liveness or it can move the repository while
    a cancelled worker is still unwinding and let that worker recreate a partial live directory."""
    from app import jobs

    reg: JobRegistry[SampleJob] = JobRegistry("cancel-drain")
    entered = threading.Event()
    release = threading.Event()

    def work(_job):
        entered.set()
        release.wait(5)

    job = reg.start_or_join(
        "k", lambda: SampleJob(id=new_id()), work, project_id="drain-project")
    assert entered.wait(2)
    assert reg.cancel(job.id, project_id="drain-project").status == "cancelled"
    assert jobs.any_running_for_project("drain-project") == "cancel-drain"

    # A terminal cleanup sweep must not erase the only record that the live worker still exists.
    jobs.forget_finished_for_project("drain-project")
    assert job.id in reg.jobs

    release.set()
    deadline = time.time() + 5
    while jobs.any_running_for_project("drain-project") and time.time() < deadline:
        time.sleep(0.01)
    assert jobs.any_running_for_project("drain-project") is None

    jobs.forget_finished_for_project("drain-project")
    assert job.id not in reg.jobs


def test_scope_drain_cancels_managed_workers_but_keeps_raw_orphans_visible():
    """Account deletion drains many project and user-audio scopes at once. Managed workers get a
    cooperative cancellation request; raw deadline orphans cannot be killed, so their liveness
    record must remain until the owning adapter marks it done."""
    from app import jobs

    reg: JobRegistry[SampleJob] = JobRegistry("account-drain")
    entered = threading.Event()
    release = threading.Event()

    def work(_job):
        entered.set()
        release.wait(5)

    managed = reg.start_or_join(
        "managed", lambda: SampleJob(id="managed"), work, project_id="project-a")
    assert entered.wait(2)

    orphan = SampleJob(id="orphan")
    setattr(orphan, jobs._PID_ATTR, "project-a")
    reg.jobs[orphan.id] = orphan

    other = SampleJob(id="other")
    setattr(other, jobs._PID_ATTR, "project-b")
    reg.jobs[other.id] = other

    assert jobs.request_cancellation_for_scopes({"project-a", "user:abc"}) == 1
    assert managed.status == "cancelled"
    assert orphan.status == "running"  # hiding an unkillable thread would make deletion unsafe
    assert other.status == "running"   # an unrelated account is untouched
    # Assert the MANAGED worker's own liveness, not just that the scope looks active: the raw
    # orphan alone satisfies `any_active_for_scopes`, so without this the cancelled-but-unwinding
    # claim in the docstring would be carried entirely by another test.
    assert getattr(managed, jobs._WORKER_ACTIVE_ATTR) is True
    assert jobs.any_active_for_scopes({"project-a"}) == "account-drain"

    release.set()
    deadline = time.time() + 5
    while getattr(managed, jobs._WORKER_ACTIVE_ATTR, True) and time.time() < deadline:
        time.sleep(0.01)
    orphan.status = "done"  # its external adapter observed the raw thread exit
    assert jobs.any_active_for_scopes({"project-a"}) is None

    jobs.forget_inactive_for_scopes({"project-a"})
    assert managed.id not in reg.jobs and orphan.id not in reg.jobs
    assert other.id in reg.jobs


# ---- project isolation ----

def test_dedup_is_scoped_by_project():
    # The same dedup key in two different projects must NOT join the same job (e.g. a paper slug
    # that happens to exist in two projects).
    reg: JobRegistry[SampleJob] = JobRegistry("t")
    release = threading.Event()
    a = reg.start_or_join("slug", lambda: SampleJob(id=new_id()), lambda j: release.wait(2.0),
                          project_id="proj-a")
    b = reg.start_or_join("slug", lambda: SampleJob(id=new_id()), lambda j: release.wait(2.0),
                          project_id="proj-b")
    assert a.id != b.id                                  # independent jobs, not joined
    assert reg.active_for("slug", project_id="proj-a") is a
    assert reg.active_for("slug", project_id="proj-b") is b
    release.set()
    _settle(reg, a.id)
    _settle(reg, b.id)


def test_get_and_snapshot_are_project_authorized():
    reg: JobRegistry[SampleJob] = JobRegistry("t")
    job = reg.start_or_join("k", lambda: SampleJob(id="j1"), lambda j: None, project_id="proj-a")
    _settle(reg, job.id)
    # The owning project sees it; another project cannot read it by its (opaque) id.
    assert reg.get("j1", project_id="proj-a") is not None
    assert reg.get("j1", project_id="proj-b") is None
    assert reg.snapshot("j1", project_id="proj-a") is not None
    assert reg.snapshot("j1", project_id="proj-b") is None


def test_explicit_project_id_overrides_ambient_for_the_worker(monkeypatch):
    # A job requested for project B while project A is ambient must run bound to B, not A —
    # the worker binds the explicit project_id, not whatever happened to be active at the call.
    reg: JobRegistry[SampleJob] = JobRegistry("t")
    token = config.set_active_project("proj-a")
    try:
        seen: dict = {}
        job = reg.start_or_join("k", lambda: SampleJob(id=new_id()),
                                lambda j: seen.update(pid=config.active_project_id()),
                                project_id="proj-b")
        _settle(reg, job.id)
        assert seen["pid"] == "proj-b"
    finally:
        config.reset_active_project(token)


def test_settle_callback_fires_after_terminal_status():
    """add_settle_callback: registered on a running job -> fires on the worker thread after
    the status flip; on a settled job -> returns False so the caller handles it inline."""
    from app import jobs

    reg = jobs.JobRegistry("settle-test")
    try:
        release = threading.Event()
        seen: list[str] = []

        def work(job):
            release.wait(timeout=5)

        job = reg.start_or_join("k", lambda: jobs.Job(id="s1"), work, project_id="p")
        assert reg.add_settle_callback(job, lambda j: seen.append(j.status)) is True
        release.set()
        deadline = time.time() + 5
        while time.time() < deadline and not seen:
            time.sleep(0.01)
        assert seen == ["done"]  # ran after the flip, with the terminal status visible

        # Already settled: registration refuses, so the caller can't lose the callback.
        assert reg.add_settle_callback(job, lambda j: seen.append("late")) is False
        assert seen == ["done"]
    finally:
        jobs._ALL_REGISTRIES.remove(reg)
