"""Per-user rate ceilings on starting paid work.

The failure mode this guards is silent in both directions: a ceiling that never triggers looks
exactly like a well-behaved client, and a ceiling that triggers on a JOIN would break the ordinary
polling flow while still looking like "the limiter works". So these assert the boundary in both
directions, and assert the properties (a join is free, a bad config still limits) rather than only
the happy refusal.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass

import pytest
from app import config, jobs, rate_limits
from app.jobs import Job, JobRegistry, new_id

ALICE = "11111111-1111-4111-8111-111111111111"
BOB = "22222222-2222-4222-8222-222222222222"


@dataclass
class SampleJob(Job):
    value: int = 0


@pytest.fixture(autouse=True)
def _clean_limiter(monkeypatch):
    rate_limits.reset()
    # Registries self-register in a process-global list; a stale one from another module's import
    # would otherwise contribute live jobs to this test's concurrency count.
    monkeypatch.setattr(jobs, "_ALL_REGISTRIES", [])
    yield
    rate_limits.reset()


def _as(user_id):
    return config.set_active_user(user_id)


def _settle(reg, job_id, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = reg.jobs.get(job_id)
        if job and job.status != "running":
            return job
        time.sleep(0.01)
    raise TimeoutError(f"job {job_id} did not settle")


# ---------- the pure limiter ----------

def test_the_window_refuses_the_start_after_the_limit_and_says_when_to_retry(monkeypatch):
    monkeypatch.setenv("RC_RATE_LIMIT_STARTS_PER_MINUTE", "3")
    for _ in range(3):
        rate_limits.check_and_record(ALICE, active_jobs=0)
    with pytest.raises(rate_limits.RateLimited) as err:
        rate_limits.check_and_record(ALICE, active_jobs=0)
    # An honest Retry-After: never zero (a client would hot-loop) and never longer than the window.
    assert 1 <= err.value.retry_after_seconds <= int(rate_limits.WINDOW_SECONDS) + 1


def test_the_window_slides_rather_than_resetting_on_a_fixed_boundary(monkeypatch):
    # A fixed bucket would let 2x the limit through across a boundary. Age the recorded starts
    # past the window instead of sleeping 60s.
    monkeypatch.setenv("RC_RATE_LIMIT_STARTS_PER_MINUTE", "2")
    rate_limits.check_and_record(ALICE, active_jobs=0)
    rate_limits.check_and_record(ALICE, active_jobs=0)
    with pytest.raises(rate_limits.RateLimited):
        rate_limits.check_and_record(ALICE, active_jobs=0)

    bucket = rate_limits._starts[ALICE]
    aged = [t - (rate_limits.WINDOW_SECONDS + 1) for t in bucket]
    bucket.clear()
    bucket.extend(aged)

    rate_limits.check_and_record(ALICE, active_jobs=0)  # must not raise


def test_one_account_cannot_exhaust_anothers_budget(monkeypatch):
    monkeypatch.setenv("RC_RATE_LIMIT_STARTS_PER_MINUTE", "1")
    rate_limits.check_and_record(ALICE, active_jobs=0)
    with pytest.raises(rate_limits.RateLimited):
        rate_limits.check_and_record(ALICE, active_jobs=0)
    rate_limits.check_and_record(BOB, active_jobs=0)  # Bob is unaffected


def test_the_concurrency_ceiling_is_independent_of_the_rate_window(monkeypatch):
    # Nothing has been recorded, so the per-minute window is empty; only in-flight work refuses.
    monkeypatch.setenv("RC_RATE_LIMIT_CONCURRENT_JOBS", "2")
    rate_limits.check_and_record(ALICE, active_jobs=1)
    with pytest.raises(rate_limits.RateLimited, match="already have"):
        rate_limits.check_and_record(ALICE, active_jobs=2)


def test_a_refused_start_does_not_consume_window_budget(monkeypatch):
    """A concurrency refusal must not also spend a slot in the per-minute window.

    Otherwise a client held at the concurrency ceiling silently burns its rate budget while doing
    no work, and is then refused for a second reason once its jobs drain.
    """
    monkeypatch.setenv("RC_RATE_LIMIT_STARTS_PER_MINUTE", "5")
    monkeypatch.setenv("RC_RATE_LIMIT_CONCURRENT_JOBS", "1")
    for _ in range(10):
        with pytest.raises(rate_limits.RateLimited):
            rate_limits.check_and_record(ALICE, active_jobs=1)
    assert len(rate_limits._starts[ALICE]) == 0
    for _ in range(5):
        rate_limits.check_and_record(ALICE, active_jobs=0)


def test_no_signed_in_user_is_never_limited(monkeypatch):
    monkeypatch.setenv("RC_RATE_LIMIT_STARTS_PER_MINUTE", "1")
    monkeypatch.setenv("RC_RATE_LIMIT_CONCURRENT_JOBS", "1")
    for _ in range(50):
        rate_limits.check_and_record(None, active_jobs=99)


@pytest.mark.parametrize("bad", ["treu", "", "-4", "0", "1e3", "  "])
def test_a_bad_limit_value_falls_back_to_the_default_instead_of_disabling_the_ceiling(
    monkeypatch, bad,
):
    """The dangerous configuration is absence. A typo must not read as 'unlimited'."""
    monkeypatch.setenv("RC_RATE_LIMIT_STARTS_PER_MINUTE", bad)
    assert rate_limits.starts_per_minute() == rate_limits.DEFAULT_STARTS_PER_MINUTE
    monkeypatch.setenv("RC_RATE_LIMIT_CONCURRENT_JOBS", bad)
    assert rate_limits.concurrent_jobs() == rate_limits.DEFAULT_CONCURRENT_JOBS


def test_concurrent_checks_cannot_collectively_exceed_the_window(monkeypatch):
    """The race the lock exists to close: simultaneous admissions, not sequential ones."""
    monkeypatch.setenv("RC_RATE_LIMIT_STARTS_PER_MINUTE", "5")
    admitted, refused = [], []
    start = threading.Barrier(20)

    def attempt():
        start.wait()
        try:
            rate_limits.check_and_record(ALICE, active_jobs=0)
            admitted.append(1)
        except rate_limits.RateLimited:
            refused.append(1)

    threads = [threading.Thread(target=attempt) for _ in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(admitted) == 5, f"admitted {len(admitted)}, expected exactly the ceiling"
    assert len(refused) == 15


# ---------- the registry seam ----------

def test_a_metered_registry_refuses_past_the_ceiling(monkeypatch):
    monkeypatch.setenv("RC_RATE_LIMIT_STARTS_PER_MINUTE", "2")
    reg: JobRegistry[SampleJob] = JobRegistry("t", metered=True)
    token = _as(ALICE)
    try:
        for i in range(2):
            job = reg.start_or_join(f"k{i}", lambda: SampleJob(id=new_id()), lambda j: None)
            _settle(reg, job.id)
        with pytest.raises(rate_limits.RateLimited):
            reg.start_or_join("k9", lambda: SampleJob(id=new_id()), lambda j: None)
    finally:
        config.reset_active_user(token)


def test_an_unmetered_registry_is_not_rate_limited(monkeypatch):
    """Internal follow-on work was authorized when its parent was admitted."""
    monkeypatch.setenv("RC_RATE_LIMIT_STARTS_PER_MINUTE", "1")
    reg: JobRegistry[SampleJob] = JobRegistry("internal")  # metered defaults to False
    token = _as(ALICE)
    try:
        for i in range(6):
            job = reg.start_or_join(f"k{i}", lambda: SampleJob(id=new_id()), lambda j: None)
            _settle(reg, job.id)
    finally:
        config.reset_active_user(token)


def test_joining_a_running_job_does_not_consume_budget(monkeypatch):
    """The property that would break ordinary polling if the check sat one level higher.

    Two identical callers must produce ONE admission. If the limiter ran before dedup, a client
    retrying its own in-flight request would rate-limit itself out of its own result.
    """
    monkeypatch.setenv("RC_RATE_LIMIT_STARTS_PER_MINUTE", "1")
    release = threading.Event()
    reg: JobRegistry[SampleJob] = JobRegistry("t", metered=True)
    token = _as(ALICE)
    try:
        first = reg.start_or_join(
            "same", lambda: SampleJob(id=new_id()), lambda j: release.wait(5),
        )
        # Same key while the first is still running -> a join, which must not raise even though
        # the per-minute budget of 1 is already spent.
        second = reg.start_or_join(
            "same", lambda: SampleJob(id=new_id()), lambda j: release.wait(5),
        )
        assert second.id == first.id
    finally:
        release.set()
        _settle(reg, first.id)
        config.reset_active_user(token)


def test_running_jobs_count_toward_the_concurrency_ceiling_across_registries(monkeypatch):
    monkeypatch.setenv("RC_RATE_LIMIT_CONCURRENT_JOBS", "2")
    monkeypatch.setenv("RC_RATE_LIMIT_STARTS_PER_MINUTE", "50")
    release = threading.Event()
    a: JobRegistry[SampleJob] = JobRegistry("a", metered=True)
    b: JobRegistry[SampleJob] = JobRegistry("b", metered=True)
    token = _as(ALICE)
    try:
        j1 = a.start_or_join("k1", lambda: SampleJob(id=new_id()), lambda j: release.wait(5))
        j2 = b.start_or_join("k2", lambda: SampleJob(id=new_id()), lambda j: release.wait(5))
        assert jobs.active_count_for_user(ALICE) == 2
        with pytest.raises(rate_limits.RateLimited, match="already have"):
            a.start_or_join("k3", lambda: SampleJob(id=new_id()), lambda j: None)
    finally:
        release.set()
        _settle(a, j1.id)
        _settle(b, j2.id)
        config.reset_active_user(token)


def test_another_users_running_work_does_not_count_against_you(monkeypatch):
    monkeypatch.setenv("RC_RATE_LIMIT_CONCURRENT_JOBS", "1")
    release = threading.Event()
    reg: JobRegistry[SampleJob] = JobRegistry("t", metered=True)
    alice_token = _as(ALICE)
    try:
        j1 = reg.start_or_join("k1", lambda: SampleJob(id=new_id()), lambda j: release.wait(5))
    finally:
        config.reset_active_user(alice_token)
    bob_token = _as(BOB)
    try:
        assert jobs.active_count_for_user(BOB) == 0
        j2 = reg.start_or_join("k2", lambda: SampleJob(id=new_id()), lambda j: None)
        _settle(reg, j2.id)
    finally:
        release.set()
        _settle(reg, j1.id)
        config.reset_active_user(bob_token)


def test_the_ceiling_releases_when_the_worker_exits_not_when_the_client_sees_done(monkeypatch):
    """The ceiling is held slightly longer than the client-visible status, on purpose.

    `status` flips to done/cancelled while the worker thread is still inside its `finally` —
    that is deliberate (cancellation is terminal to clients while the worker drains), and the
    settle callbacks that run in that window can themselves admit follow-on work. So the count
    tracks `_worker_is_active`, not `status`. Asserting `== 0` the instant `_settle` returns is
    therefore asserting something the registry never promised, and passed only because a quiet
    machine won the race — it failed under a full-suite run.
    """
    monkeypatch.setenv("RC_RATE_LIMIT_CONCURRENT_JOBS", "1")
    monkeypatch.setenv("RC_RATE_LIMIT_STARTS_PER_MINUTE", "50")
    reg: JobRegistry[SampleJob] = JobRegistry("t", metered=True)
    token = _as(ALICE)
    try:
        first = reg.start_or_join("k1", lambda: SampleJob(id=new_id()), lambda j: None)
        _settle(reg, first.id)

        deadline = time.time() + 5.0
        while jobs.active_count_for_user(ALICE) and time.time() < deadline:
            time.sleep(0.01)
        assert jobs.active_count_for_user(ALICE) == 0, "worker never released the ceiling"

        # And the freed slot is genuinely reusable at a ceiling of one.
        second = reg.start_or_join("k2", lambda: SampleJob(id=new_id()), lambda j: None)
        _settle(reg, second.id)
    finally:
        config.reset_active_user(token)
