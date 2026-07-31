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


def test_live_finds_reach_the_snapshot_without_advancing_the_timeline(temp_project):
    """The Discover screen shows good finds while a run is in flight. Two things must hold: the
    finds reach the polled snapshot, and a `finds` event does NOT move the phase — it arrives
    DURING a phase, and advancing the timeline on it would make the progress steps jump."""
    def run_with_finds(goals: str, **kwargs):
        yield {"type": "queries", "focus": "f", "queries": []}
        yield {"type": "gathered", "count": 800}
        yield {"type": "gated", "kept": 700, "counts": {}}
        yield {"type": "finds", "stage": "grounded",
               "items": [{"title": "Early Find", "reason": "Cites a paper on your list",
                          "provisional": True}]}
        yield {"type": "triage", "count": 700}
        yield {"type": "done", "result": {"goals": goals, "suggestions": [],
                                          "candidate_count": 0, "top_n": 5}}

    seen: list[tuple[str, int]] = []
    job = discovery_jobs.start_discovery(temp_project, "goals", run_fn=run_with_finds)
    deadline = time.time() + 5.0
    while time.time() < deadline and job.status == "running":
        snap = discovery_jobs.snapshot(temp_project)
        if snap:
            seen.append((snap["phase"], len(snap.get("finds") or [])))
        time.sleep(0.005)
    _wait_until_done(temp_project)

    final = discovery_jobs.snapshot(temp_project)
    assert final["finds"][0]["title"] == "Early Find"
    assert final["finds"][0]["provisional"] is True
    assert final["finds_stage"] == "grounded"
    # "finds" is never itself a phase — the client's step mapping has no entry for it.
    assert "finds" not in {phase for phase, _ in seen}


def test_the_snapshot_carries_the_counts_the_progress_steps_render(temp_project):
    def run(goals: str, **kwargs):
        yield {"type": "library", "papers": 53}
        yield {"type": "gathered", "count": 809}
        yield {"type": "gated", "kept": 408, "counts": {}}
        yield {"type": "done", "result": {"goals": goals, "suggestions": [],
                                          "candidate_count": 0, "top_n": 5}}

    discovery_jobs.start_discovery(temp_project, "goals", run_fn=run)
    _wait_until_done(temp_project)
    snap = discovery_jobs.snapshot(temp_project)
    assert (snap["library"], snap["gathered"], snap["screened"]) == (53, 809, 408)
