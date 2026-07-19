"""discovery_jobs: the background-thread run that decouples a discovery from any HTTP
connection (same contract as graph_jobs — see test_graph_jobs for the pattern's rationale).
Drives a REAL thread end-to-end with an injected run_fn, zero network."""
from __future__ import annotations

import time

import pytest
from app import config, discovery, discovery_jobs
from app.discovery import DiscoveryError


@pytest.fixture(autouse=True)
def _clean_jobs_registry():
    discovery_jobs._jobs.clear()
    yield
    discovery_jobs._jobs.clear()


def fake_run(delay: float = 0.0, fail: bool = False):
    def _run(goals: str, **kwargs):
        yield {"type": "queries", "focus": "f",
               "queries": [{"query": "q1", "phase": "broad", "rationale": ""}]}
        if delay:
            time.sleep(delay)
        if fail:
            raise DiscoveryError("simulated failure")
        yield {"type": "search", "query": "q1", "index": 1, "total": 1, "found": 2}
        yield {"type": "citations", "count": 2}
        yield {"type": "evidence", "count": 2}
        yield {"type": "scoring", "count": 2}
        yield {"type": "done", "result": {"goals": goals, "suggestions": [{"title": "S"}],
                                          "candidate_count": 2, "top_n": 5}}
    return _run


def _wait_until_done(pid: str, timeout: float = 5.0) -> discovery_jobs.DiscoveryJob:
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = discovery_jobs.get_job(pid)
        if job and job.status != "running":
            return job
        time.sleep(0.02)
    raise TimeoutError(f"discovery job for {pid} did not finish within {timeout}s")


def test_run_completes_in_background_and_persists_the_result(temp_project):
    job = discovery_jobs.start_discovery(temp_project, "learn 3D DRAM",
                                         run_fn=fake_run(delay=0.1))
    assert job.status == "running"  # returns immediately, doesn't block for the run

    finished = _wait_until_done(temp_project)
    assert finished.status == "done"
    assert finished.phase == "done"
    assert finished.found == 2
    assert finished.result["suggestions"] == [{"title": "S"}]
    # Persisted into THIS project's .state from the job's own thread (contextvar re-bind).
    assert (config.project_dir() / ".state" / "discovery.json").exists()
    assert discovery.load_result()["goals"] == "learn 3D DRAM"


def test_second_start_joins_the_running_job(temp_project):
    job1 = discovery_jobs.start_discovery(temp_project, "goals", run_fn=fake_run(delay=0.15))
    job2 = discovery_jobs.start_discovery(temp_project, "other goals", run_fn=fake_run())
    assert job1 is job2
    _wait_until_done(temp_project)


def test_a_new_run_can_start_after_the_previous_finished(temp_project):
    discovery_jobs.start_discovery(temp_project, "goals", run_fn=fake_run())
    _wait_until_done(temp_project)
    job2 = discovery_jobs.start_discovery(temp_project, "goals 2", run_fn=fake_run(delay=0.1))
    assert job2.status == "running"  # a fresh job, not the finished one handed back
    assert _wait_until_done(temp_project).goals == "goals 2"


def test_failure_sets_status_error_with_progress_kept(temp_project):
    discovery_jobs.start_discovery(temp_project, "goals", run_fn=fake_run(fail=True))
    job = _wait_until_done(temp_project)
    assert job.status == "error"
    assert "simulated failure" in job.error
    assert job.phase == "searching"  # progress up to the failure stays visible
    assert discovery.load_result() is None  # nothing persisted on failure


def test_snapshot_excludes_pid_and_is_none_without_a_job(temp_project):
    assert discovery_jobs.snapshot(temp_project) is None
    discovery_jobs.start_discovery(temp_project, "goals", run_fn=fake_run())
    _wait_until_done(temp_project)
    snap = discovery_jobs.snapshot(temp_project)
    assert "pid" not in snap
    assert snap["status"] == "done"
