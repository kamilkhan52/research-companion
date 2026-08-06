"""Holding a reservation across one job, and settling it to what was really spent.

The dangerous failure here is quiet in both directions: a ceiling that never holds looks exactly
like a well-behaved account, and a ceiling that holds but never RELEASES silently eats a reader's
monthly budget a job at a time. So these assert the release/settle paths as hard as the refusal.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass

import pytest
from app import config, jobs, quotas, spend_ceiling, spend_limits
from app.jobs import Job, JobRegistry, new_id

ALICE = "11111111-1111-4111-8111-111111111111"


@dataclass
class SampleJob(Job):
    value: int = 0


class _FakeReservation:
    def __init__(self, rid): self.id = rid


@pytest.fixture(autouse=True)
def _isolated(monkeypatch):
    monkeypatch.setattr(jobs, "_ALL_REGISTRIES", [])
    yield


@pytest.fixture
def ledger(monkeypatch):
    """A stand-in for the durable ledger, recording what the registry asked it to do."""
    calls = {"reserve": [], "settle": [], "release": []}

    def reserve(**kw):
        calls["reserve"].append(kw)
        return _FakeReservation(f"res-{len(calls['reserve'])}")

    monkeypatch.setattr(quotas, "reserve", reserve)
    monkeypatch.setattr(quotas, "settle", lambda rid, *, user_id, actual_nanousd, **kw:
                        calls["settle"].append((rid, actual_nanousd)))
    monkeypatch.setattr(quotas, "release", lambda rid, *, user_id:
                        calls["release"].append(rid))
    monkeypatch.setattr(spend_limits, "enabled", lambda: True)
    return calls


def _settled(reg, job_id, timeout=5.0):
    """Wait for the client-visible status to go terminal."""
    import time
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = reg.jobs.get(job_id)
        if job and job.status != "running":
            return job
        time.sleep(0.01)
    raise TimeoutError("job did not settle")


def _wait_for(predicate, timeout=5.0, what="condition"):
    """Wait for the RESERVATION to settle, which is later than the status flip.

    `status` goes terminal inside the worker while it is still unwinding; the reservation is
    settled in the same `finally` that clears the worker marker, strictly afterwards. Asserting
    immediately after `_settled` therefore reads an empty ledger — and passed in isolation only
    because a quiet machine won the race, then failed under a full-suite run.
    """
    import time
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError(f"timed out waiting for {what}")


def test_a_metered_job_reserves_its_operations_pessimistic_maximum(ledger):
    reg: JobRegistry[SampleJob] = JobRegistry("t", metered=True, operation="analysis")
    token = config.set_active_user(ALICE)
    try:
        job = reg.start_or_join("k", lambda: SampleJob(id=new_id()), lambda j: None)
        _settled(reg, job.id)
    finally:
        config.reset_active_user(token)
    assert len(ledger["reserve"]) == 1
    held = ledger["reserve"][0]
    assert held["operation"] == "analysis"
    assert held["maximum_cost_nanousd"] == spend_limits.max_cost_nanousd("analysis")
    assert held["limit_nanousd"] == spend_limits.monthly_limit_nanousd()
    assert held["user_id"] == ALICE


def test_an_unmetered_job_reserves_nothing(ledger):
    reg: JobRegistry[SampleJob] = JobRegistry("internal")
    token = config.set_active_user(ALICE)
    try:
        job = reg.start_or_join("k", lambda: SampleJob(id=new_id()), lambda j: None)
        _settled(reg, job.id)
    finally:
        config.reset_active_user(token)
    assert ledger["reserve"] == []


def test_the_job_settles_to_what_was_actually_spent_not_the_maximum_held(ledger):
    """The whole point of reserving a maximum: the unspent remainder must go back."""
    reg: JobRegistry[SampleJob] = JobRegistry("t", metered=True, operation="analysis")

    def work(_job):
        spend_ceiling.note_spend(1_234)   # as usage.record would, from inside the worker
        spend_ceiling.note_spend(766)

    token = config.set_active_user(ALICE)
    try:
        job = reg.start_or_join("k", lambda: SampleJob(id=new_id()), work)
        _settled(reg, job.id)
    finally:
        config.reset_active_user(token)
    _wait_for(lambda: ledger["settle"], what="the reservation to settle")
    assert ledger["settle"] == [("res-1", 2_000)]
    assert ledger["settle"][0][1] < spend_limits.max_cost_nanousd("analysis")


def test_a_job_that_spends_nothing_still_settles_at_zero(ledger):
    """Settled-at-zero records the admission as used; releasing would say it never happened."""
    reg: JobRegistry[SampleJob] = JobRegistry("t", metered=True, operation="analysis")
    token = config.set_active_user(ALICE)
    try:
        job = reg.start_or_join("k", lambda: SampleJob(id=new_id()), lambda j: None)
        _settled(reg, job.id)
    finally:
        config.reset_active_user(token)
    _wait_for(lambda: ledger["settle"], what="the reservation to settle")
    assert ledger["settle"] == [("res-1", 0)]


def test_a_failing_job_still_settles_so_the_hold_is_not_stranded(ledger):
    """An exception must not leave a reservation eating the account's budget until it expires."""
    reg: JobRegistry[SampleJob] = JobRegistry("t", metered=True, operation="analysis")

    def boom(_job):
        spend_ceiling.note_spend(500)     # money really was spent before it failed
        raise RuntimeError("provider exploded")

    token = config.set_active_user(ALICE)
    try:
        job = reg.start_or_join("k", lambda: SampleJob(id=new_id()), boom)
        settled = _settled(reg, job.id)
    finally:
        config.reset_active_user(token)
    assert settled.status == "error"
    _wait_for(lambda: ledger["settle"], what="the reservation to settle")
    assert ledger["settle"] == [("res-1", 500)], "a failed job must still be charged what it spent"


def test_a_refusal_reaches_the_caller_and_holds_nothing(ledger, monkeypatch):
    """Out of budget fails CLOSED — the work must not start."""
    monkeypatch.setattr(quotas, "reserve", lambda **kw: (_ for _ in ()).throw(
        quotas.QuotaExceeded(used_nanousd=2_500_000_000, requested_nanousd=80_000,
                             limit_nanousd=2_500_000_000)))
    ran = threading.Event()
    reg: JobRegistry[SampleJob] = JobRegistry("t", metered=True, operation="analysis")
    token = config.set_active_user(ALICE)
    try:
        with pytest.raises(quotas.QuotaExceeded):
            reg.start_or_join("k", lambda: SampleJob(id=new_id()), lambda j: ran.set())
    finally:
        config.reset_active_user(token)
    assert not ran.is_set(), "refused work must never run"
    assert ledger["settle"] == [] and ledger["release"] == []


def test_an_unreachable_ledger_refuses_rather_than_admitting_free_work(ledger, monkeypatch):
    """A ceiling that opens when its store is down is not a ceiling (architectural rule 5)."""
    monkeypatch.setattr(quotas, "reserve", lambda **kw: (_ for _ in ()).throw(
        quotas.QuotaUnavailable("Usage limits are temporarily unavailable.")))
    reg: JobRegistry[SampleJob] = JobRegistry("t", metered=True, operation="analysis")
    token = config.set_active_user(ALICE)
    try:
        with pytest.raises(quotas.QuotaUnavailable):
            reg.start_or_join("k", lambda: SampleJob(id=new_id()), lambda j: None)
    finally:
        config.reset_active_user(token)


def test_spend_outside_a_job_is_ignored_rather_than_charged_to_someone_else():
    """No bound reservation means no accumulator — a stray call must not land on a random job."""
    spend_ceiling.note_spend(9_999)  # must not raise
    assert spend_ceiling.active() is None


def test_ceilings_are_inert_without_a_database_or_user(monkeypatch):
    monkeypatch.setattr(spend_limits, "enabled", lambda: False)
    called = []
    monkeypatch.setattr(quotas, "reserve", lambda **kw: called.append(kw))
    reg: JobRegistry[SampleJob] = JobRegistry("t", metered=True, operation="analysis")
    job = reg.start_or_join("k", lambda: SampleJob(id=new_id()), lambda j: None)
    _settled(reg, job.id)
    assert called == [], "local dev must behave exactly as before"


def test_real_usage_recording_feeds_the_reservation(ledger, temp_project):
    """Drive the ACTUAL accounting seam, not the accumulator directly.

    Every other test here calls `note_spend` by hand, which proves the accumulator works while
    proving nothing about whether anything calls it — deleting the line in `usage.record` left
    them all green. `usage.record` is the one seam every metered call already passes through, so
    this is the wiring that has to hold.
    """
    from app import usage

    reg: JobRegistry[SampleJob] = JobRegistry("t", metered=True, operation="analysis")

    def work(_job):
        # Exactly what llm.py does after a completed OpenRouter call.
        usage.record("analysis", "deepseek/deepseek-v4-pro", {"cost": 0.002})

    token = config.set_active_user(ALICE)
    try:
        job = reg.start_or_join("k", lambda: SampleJob(id=new_id()), work)
        _settled(reg, job.id)
        _wait_for(lambda: ledger["settle"], what="the reservation to settle")
    finally:
        config.reset_active_user(token)

    # $0.002 -> 2,000,000 nano-USD, charged against the reservation rather than only the ledger.
    assert ledger["settle"] == [("res-1", 2_000_000)]
