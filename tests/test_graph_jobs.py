"""graph_jobs: the background-thread build job that decouples a build's execution from any
single HTTP connection. Drives a REAL background thread end-to-end (extract_fn injected, so
zero network calls) and confirms the job reaches completion and reports progress correctly --
this is the fix for the bug where a build died the moment its driving connection went away."""
from __future__ import annotations

import time

import pytest
from app import graph_jobs, graph_store

from tests.conftest import add_paper


@pytest.fixture(autouse=True)
def _clean_jobs_registry():
    """graph_jobs._jobs is module-level global state keyed by pid. temp_project always hands
    out the same pid ("test-project"), so without this, one test's finished job would leak
    into the next test and make start_build() think a build is already running (or already
    done) before that test ever calls it."""
    graph_jobs._jobs.clear()
    yield
    graph_jobs._jobs.clear()


def fake_extractor(delay: float = 0.0):
    def _extract(slug: str, title: str, full_text: str, model: str) -> dict:
        if delay:
            time.sleep(delay)
        return {
            "slug": slug, "content_hash": graph_store.content_hash(full_text),
            "extracted_at": "t", "model": model, "status": "done",
            "references": [{"index": 1, "title": "An External Work", "significant": True,
                            "significance_reason": "baseline"}],
            "error": "",
        }
    return _extract


def _wait_until_done(pid: str, timeout: float = 5.0) -> graph_jobs.BuildJob:
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = graph_jobs.get_job(pid)
        if job and job.status != "running":
            return job
        time.sleep(0.02)
    raise TimeoutError(f"job for {pid} did not finish within {timeout}s")


def test_start_build_runs_to_completion_in_a_background_thread(temp_project):
    add_paper(temp_project, "a", "Paper A", full_text="Text A.")
    add_paper(temp_project, "b", "Paper B", full_text="Text B.")

    job = graph_jobs.start_build(temp_project, extract_fn=fake_extractor())
    assert job.status == "running"  # returns immediately, doesn't block for the build

    finished = _wait_until_done(temp_project)
    assert finished.status == "done"
    assert finished.total == 2
    assert finished.done == 2
    assert finished.graph is not None
    assert finished.recommendations is not None
    assert finished.current_slug is None  # cleared once done


def test_status_is_queryable_while_the_job_is_still_running(temp_project):
    add_paper(temp_project, "a", "Paper A", full_text="Text A.")
    add_paper(temp_project, "b", "Paper B", full_text="Text B.")

    graph_jobs.start_build(temp_project, extract_fn=fake_extractor(delay=0.15))
    # Poll almost immediately: the job should already be visible and "running", proving a
    # caller doesn't need to wait for completion to see live progress (this is the polling
    # contract the mobile client relies on).
    time.sleep(0.02)
    job = graph_jobs.get_job(temp_project)
    assert job is not None
    assert job.status == "running"

    _wait_until_done(temp_project)


def test_second_start_call_joins_the_running_job_instead_of_duplicating(temp_project):
    add_paper(temp_project, "a", "Paper A", full_text="Text A.")
    calls: list[str] = []

    def counting_extractor(slug, title, full_text, model):
        calls.append(slug)
        time.sleep(0.1)
        return fake_extractor()(slug, title, full_text, model)

    job1 = graph_jobs.start_build(temp_project, extract_fn=counting_extractor)
    job2 = graph_jobs.start_build(temp_project, extract_fn=counting_extractor)
    assert job1 is job2  # same in-flight job object, not a second thread racing the first

    _wait_until_done(temp_project)
    assert calls == ["a"]  # extracted exactly once, not twice


def test_a_new_build_can_start_after_the_previous_one_finished(temp_project):
    add_paper(temp_project, "a", "Paper A", full_text="Text A.")
    graph_jobs.start_build(temp_project, extract_fn=fake_extractor())
    _wait_until_done(temp_project)

    job2 = graph_jobs.start_build(temp_project, extract_fn=fake_extractor())
    assert job2.status == "running"
    _wait_until_done(temp_project)


def test_job_resolves_the_correct_project_context_from_its_own_thread(temp_project):
    # The whole point of setting config.active_project fresh inside _run: a background thread
    # does NOT inherit the spawning request's contextvars. If this were wrong, the job would
    # silently read/write some other project's (or no project's) data.
    add_paper(temp_project, "a", "Paper A", full_text="Distinctive text for project isolation.")
    job = graph_jobs.start_build(temp_project, extract_fn=fake_extractor())
    finished = _wait_until_done(job.pid)

    data = graph_store.load()  # graph_store resolves via config.project_dir() too
    assert "a" in data["papers"]
    assert finished.graph["nodes"]


def test_no_job_yet_returns_none(temp_project):
    assert graph_jobs.get_job(temp_project) is None
    assert graph_jobs.is_running(temp_project) is False


def test_job_error_path_sets_status_error_not_stuck_running(temp_project):
    add_paper(temp_project, "a", "Paper A", full_text="Text A.")

    def failing(slug, title, full_text, model):
        raise RuntimeError("simulated extraction crash")

    graph_jobs.start_build(temp_project, extract_fn=failing)
    job = _wait_until_done(temp_project)
    # build_graph() itself never raises (per-paper failures are caught inside
    # extract_references_for_paper); a raw exception from extract_fn here is exactly the kind
    # of unexpected failure the outer try/except in _run exists to catch.
    assert job.status == "error"


def test_to_dict_excludes_internal_pid_field(temp_project):
    add_paper(temp_project, "a", "Paper A", full_text="Text A.")
    graph_jobs.start_build(temp_project, extract_fn=fake_extractor())
    _wait_until_done(temp_project)
    d = graph_jobs.get_job(temp_project).to_dict()
    assert "pid" not in d
    assert d["status"] == "done"
