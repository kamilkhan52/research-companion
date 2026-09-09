"""discovery_jobs: the background-thread run that decouples a discovery from any HTTP
connection (same contract as graph_jobs — see test_graph_jobs for the pattern's rationale).
Drives a REAL thread end-to-end with an injected run_fn, zero network."""
from __future__ import annotations

import threading
import time

import pytest
from app import config, discovery, discovery_jobs, jobs
from app.discovery import DiscoveryError
from app.routers import discovery as discovery_routes
from fastapi import HTTPException


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


def test_cancel_stops_at_the_next_event_and_preserves_old_result_and_live_finds(temp_project):
    """A cancelled attempt must not replace the last complete recommendations, even when the
    provider call already in flight returns a final result after Stop. Finds already published are
    retained as explicitly partial UI evidence."""
    previous = {"goals": "old", "suggestions": [{"title": "Trusted old result"}],
                "candidate_count": 1, "top_n": 5}
    discovery.save_result(previous)
    provider_in_flight = threading.Event()
    release_provider = threading.Event()
    generator_closed = threading.Event()

    def run(goals: str, **kwargs):
        try:
            yield {"type": "queries", "focus": "memory", "queries": []}
            yield {"type": "finds", "stage": "grounded", "items": [
                {"title": "Partial candidate", "reason": "Cites your library",
                 "provisional": True},
            ]}
            provider_in_flight.set()
            assert release_provider.wait(5)
            # This event was computed by the in-flight call, but cancellation must prevent it and
            # every later event from being applied.
            yield {"type": "citations", "count": 99}
            yield {"type": "done", "result": {
                "goals": goals, "suggestions": [{"title": "Must not persist"}],
                "candidate_count": 1, "top_n": 5,
            }}
        finally:
            generator_closed.set()

    started = discovery_jobs.start_discovery(temp_project, "new goals", run_fn=run)
    assert provider_in_flight.wait(5)
    cancelled = discovery_jobs.cancel_discovery(temp_project)
    assert cancelled is started
    assert cancelled.status == "cancelled"
    assert discovery_jobs.snapshot(temp_project)["finds"][0]["title"] == "Partial candidate"

    release_provider.set()
    assert generator_closed.wait(5)
    deadline = time.time() + 5
    while jobs.any_running_for_project(temp_project) and time.time() < deadline:
        time.sleep(0.01)
    assert jobs.any_running_for_project(temp_project) is None
    assert discovery_jobs.get_job(temp_project).status == "cancelled"
    assert discovery_jobs.get_job(temp_project).phase == "searching"
    persisted = discovery.load_result()
    assert persisted["goals"] == "old"
    assert [item["title"] for item in persisted["suggestions"]] == ["Trusted old result"]


def test_cancelled_attempt_keeps_its_liveness_record_during_an_immediate_retry(temp_project):
    """Unique attempt ids are required: retrying while the old worker unwinds must not overwrite
    the record project deletion uses to see that work is still touching this scope."""
    old_in_flight = threading.Event()
    release_old = threading.Event()

    def old_run(goals: str, **kwargs):
        yield {"type": "queries", "focus": "old", "queries": []}
        old_in_flight.set()
        assert release_old.wait(5)
        yield {"type": "done", "result": {"goals": goals, "suggestions": [],
                                             "candidate_count": 0, "top_n": 5}}

    first = discovery_jobs.start_discovery(temp_project, "first", run_fn=old_run)
    assert old_in_flight.wait(5)
    discovery_jobs.cancel_discovery(temp_project)
    second = discovery_jobs.start_discovery(temp_project, "second", run_fn=fake_run(delay=0.1))

    assert second.id != first.id
    assert first.id in discovery_jobs._jobs
    assert second.id in discovery_jobs._jobs
    assert jobs.any_running_for_project(temp_project) == "discover"

    release_old.set()
    assert _wait_until_done(temp_project).goals == "second"


def test_cancel_racing_final_persistence_observes_completed_result(temp_project, monkeypatch):
    """Once the final save starts under the registry lock, completion has won. Stop must wait and
    return ``done`` rather than claim a fully persisted result was cancelled."""
    saving = threading.Event()
    release_save = threading.Event()
    real_save = discovery.save_result

    def gated_save(result: dict):
        saving.set()
        assert release_save.wait(5)
        real_save(result)

    monkeypatch.setattr(discovery, "save_result", gated_save)
    discovery_jobs.start_discovery(temp_project, "goals", run_fn=fake_run())
    assert saving.wait(5)

    stopped: list[discovery_jobs.DiscoveryJob | None] = []
    cancel_thread = threading.Thread(
        target=lambda: stopped.append(discovery_jobs.cancel_discovery(temp_project)))
    cancel_thread.start()
    time.sleep(0.02)
    assert cancel_thread.is_alive()  # final persistence owns the lifecycle decision

    release_save.set()
    cancel_thread.join(5)
    assert not cancel_thread.is_alive()

    # What the lock actually guarantees is that Stop cannot CLAIM a completed run was
    # cancelled. It does not guarantee Stop sees `done`: the worker commits the outcome under
    # the lock but deliberately does not publish it until its spend reservation settles
    # (`set_outcome_locked`, and `cancel`'s `outcome_pending` branch), so a Stop that takes the
    # lock inside that window correctly reports the job as still running.
    #
    # Asserting `done` here read as the stronger claim but was really a race on which thread
    # reached the lock first, and it failed about one run in six — on `main`, with nothing to
    # distinguish it from a real regression. Assert the invariant, then wait for the publish.
    assert stopped[0] is not None and stopped[0].status != "cancelled"
    deadline = time.monotonic() + 5
    while discovery_jobs.get_job(temp_project).status == "running":
        assert time.monotonic() < deadline, "the completed run never published its outcome"
        time.sleep(0.01)
    assert discovery_jobs.get_job(temp_project).status == "done"
    assert discovery.load_result()["goals"] == "goals"


def test_same_project_id_is_deduped_and_cancelled_per_user(temp_project):
    """The scope key is (user, project), never pid alone. Give both users the SAME pid—the only
    setup that can prove one user's Stop does not cancel or join the other's run."""
    releases = {"alice": threading.Event(), "bob": threading.Event()}
    entered = {"alice": threading.Event(), "bob": threading.Event()}

    def blocked(label: str):
        def run(goals: str, **kwargs):
            yield {"type": "queries", "focus": label, "queries": []}
            entered[label].set()
            assert releases[label].wait(5)
            yield {"type": "done", "result": {"goals": goals, "suggestions": [],
                                                 "candidate_count": 0, "top_n": 5}}
        return run

    alice_token = config.set_active_user("alice")
    try:
        alice = discovery_jobs.start_discovery(temp_project, "alice goals",
                                                run_fn=blocked("alice"))
    finally:
        config.reset_active_user(alice_token)
    bob_token = config.set_active_user("bob")
    try:
        bob = discovery_jobs.start_discovery(temp_project, "bob goals", run_fn=blocked("bob"))
        assert bob is not alice
        assert entered["bob"].wait(5)
        assert discovery_jobs.cancel_discovery(temp_project) is bob
    finally:
        config.reset_active_user(bob_token)

    alice_token = config.set_active_user("alice")
    try:
        assert entered["alice"].wait(5)
        assert discovery_jobs.get_job(temp_project) is alice
        assert alice.status == "running"
    finally:
        config.reset_active_user(alice_token)

    releases["alice"].set()
    releases["bob"].set()
    deadline = time.time() + 5
    while jobs.any_running_for_project(temp_project) and time.time() < deadline:
        time.sleep(0.01)
    assert jobs.any_running_for_project(temp_project) is None


def test_same_project_id_is_skipped_per_user(temp_project):
    """A Skip for Bob's ``default`` must not arm Alice's identically named project."""
    entered = {"alice": threading.Event(), "bob": threading.Event()}
    releases = {"alice": threading.Event(), "bob": threading.Event()}

    def blocked(label: str):
        def run(goals: str, **kwargs):
            yield {"type": "queries", "focus": label, "queries": []}
            entered[label].set()
            assert releases[label].wait(5)
            kwargs["should_skip"]()
            yield {"type": "done", "result": {
                "goals": goals, "suggestions": [], "candidate_count": 0, "top_n": 5,
            }}
        return run

    alice_token = config.set_active_user("alice")
    try:
        alice = discovery_jobs.start_discovery(
            temp_project, "alice goals", run_fn=blocked("alice"))
    finally:
        config.reset_active_user(alice_token)
    bob_token = config.set_active_user("bob")
    try:
        bob = discovery_jobs.start_discovery(
            temp_project, "bob goals", run_fn=blocked("bob"))
        assert entered["bob"].wait(5)
        assert discovery_jobs.skip_discovery(temp_project) is bob
    finally:
        config.reset_active_user(bob_token)

    assert entered["alice"].wait(5)
    assert bob.skip_requested is True
    assert alice.skip_requested is False
    releases["alice"].set()
    releases["bob"].set()

    deadline = time.monotonic() + 5
    while alice.finished_at is None or bob.finished_at is None:
        assert time.monotonic() < deadline
        time.sleep(0.01)
    assert alice.skips == 0
    assert bob.skips == 1


def test_cancel_route_returns_snapshot_and_404s_without_a_run(temp_project):
    job = discovery_jobs.start_discovery(temp_project, "goals", run_fn=fake_run(delay=0.1))
    response = discovery_routes.cancel_discovery(temp_project)
    assert response["job"]["status"] == "cancelled"
    assert "id" not in response["job"]
    assert response["job"]["goals"] == job.goals

    deadline = time.time() + 5
    while jobs.any_running_for_project(temp_project) and time.time() < deadline:
        time.sleep(0.01)
    assert jobs.any_running_for_project(temp_project) is None
    discovery_jobs._jobs.clear()
    with pytest.raises(HTTPException) as exc:
        discovery_routes.cancel_discovery(temp_project)
    assert exc.value.status_code == 404


def test_skip_route_is_one_shot_idempotent_and_404s_without_a_running_job(temp_project):
    at_search_boundary = threading.Event()
    release = threading.Event()
    observed: list[bool] = []

    def run(goals: str, **kwargs):
        yield {"type": "queries", "focus": "f", "queries": []}
        at_search_boundary.set()
        assert release.wait(5)
        observed.append(kwargs["should_skip"]())
        yield {"type": "citations", "count": 0}
        observed.append(kwargs["should_skip"]())
        yield {"type": "done", "result": {
            "goals": goals, "suggestions": [], "candidate_count": 0, "top_n": 5,
        }}

    discovery_jobs.start_discovery(temp_project, "goals", run_fn=run)
    assert at_search_boundary.wait(5)
    first = discovery_routes.skip_discovery(temp_project)["job"]
    second = discovery_routes.skip_discovery(temp_project)["job"]
    assert first["skip_requested"] is True
    assert second["skip_requested"] is True
    assert second["skips"] == 0

    release.set()
    finished = _wait_until_done(temp_project)
    assert observed == [True, False]
    assert finished.skips == 1
    assert finished.skip_requested is False

    with pytest.raises(HTTPException) as exc:
        discovery_routes.skip_discovery(temp_project)
    assert exc.value.status_code == 404


def test_cancel_wins_over_an_armed_skip(temp_project):
    at_boundary = threading.Event()
    release = threading.Event()
    observed: list[bool] = []

    def run(goals: str, **kwargs):
        yield {"type": "queries", "focus": "f", "queries": []}
        at_boundary.set()
        assert release.wait(5)
        observed.append(kwargs["should_skip"]())
        yield {"type": "done", "result": {
            "goals": goals, "suggestions": [], "candidate_count": 0, "top_n": 5,
        }}

    discovery_jobs.start_discovery(temp_project, "goals", run_fn=run)
    assert at_boundary.wait(5)
    assert discovery_jobs.skip_discovery(temp_project) is not None
    assert discovery_jobs.cancel_discovery(temp_project).status == "cancelled"
    release.set()

    deadline = time.monotonic() + 5
    while jobs.any_running_for_project(temp_project):
        assert time.monotonic() < deadline
        time.sleep(0.01)
    assert observed == [False]
    assert discovery_jobs.get_job(temp_project).skips == 0
