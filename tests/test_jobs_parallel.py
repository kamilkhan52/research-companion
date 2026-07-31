"""`jobs.run_parallel`: the fan-out helper the discovery funnel runs on.

Two properties are load-bearing and neither is visible in normal use, which is why they are pinned
here rather than left to the callers.
"""
from __future__ import annotations

import threading

from app import config, jobs


def test_a_worker_sees_the_callers_active_project(temp_project):
    """Invariant 2, inside a pool. A thread inherits no contextvars, so without the rebind every
    parallelised stage would attribute its token spend to NO project — the usage ledger would
    quietly under-report and the cost claim for the whole feature would be unfalsifiable."""
    seen = jobs.run_parallel([1, 2, 3, 4], lambda _i: config.active_project_id(), max_workers=4)
    assert set(seen) == {temp_project}


def test_a_worker_sees_the_callers_active_user():
    """Same reasoning for the user: without it a parallel stage silently falls back to the
    instance defaults instead of the preferences of the person who asked for the work."""
    token = config.set_active_user("user-123")
    try:
        seen = jobs.run_parallel([1, 2, 3], lambda _i: config.active_user_id(), max_workers=3)
    finally:
        config.reset_active_user(token)
    assert set(seen) == {"user-123"}


def test_work_actually_runs_concurrently():
    """Guards the point of the helper. The discovery funnel spent 707s on six sequential batches;
    if this silently degraded to serial the symptom would be 'it's slow', not a failure."""
    started = threading.Barrier(4, timeout=5)

    def work(_i):
        started.wait()        # only completes if four workers are running at once
        return True

    assert jobs.run_parallel([1, 2, 3, 4], work, max_workers=4) == [True] * 4


def test_results_come_back_in_the_order_submitted():
    import time

    def work(i):
        time.sleep(0.02 if i % 2 else 0.0)     # finish out of order on purpose
        return i

    assert jobs.run_parallel([0, 1, 2, 3, 4], work, max_workers=5) == [0, 1, 2, 3, 4]


def test_one_failure_is_returned_rather_than_losing_the_other_results():
    def work(i):
        if i == 2:
            raise ValueError("boom")
        return i

    out = jobs.run_parallel([1, 2, 3], work, max_workers=3)
    assert out[0] == 1 and out[2] == 3
    assert isinstance(out[1], ValueError)


def test_a_single_worker_still_runs_everything():
    assert jobs.run_parallel([1, 2, 3], lambda i: i * 2, max_workers=1) == [2, 4, 6]


def test_an_empty_list_is_not_an_error():
    assert jobs.run_parallel([], lambda i: i, max_workers=4) == []


def test_a_failure_is_captured_on_the_serial_path_too():
    """`max_workers=1` takes a different code path, and it is the one an operator gets when they
    set the concurrency env var to 1 to debug something. It must behave identically: a raising
    item is returned as its exception, not propagated out of the whole fan-out."""
    def work(i):
        if i == 2:
            raise ValueError("boom")
        return i

    out = jobs.run_parallel([1, 2, 3], work, max_workers=1)
    assert out[0] == 1 and out[2] == 3
    assert isinstance(out[1], ValueError)
