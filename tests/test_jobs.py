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


def test_put_registers_a_terminal_job_without_a_thread():
    reg: JobRegistry[SampleJob] = JobRegistry("t")
    job = SampleJob(id="cached", status="done", value=7)
    reg.put("k", job)
    assert reg.get("cached").value == 7
    assert reg.active_for("k") is None        # a done job isn't "running"


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
