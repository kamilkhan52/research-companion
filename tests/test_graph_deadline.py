"""_call_with_deadline: the wall-clock guard around extraction's HTTP call. No network --
exercised with plain slow/fast functions, since the bug this defends against (httpx's
per-phase timeout not covering total duration) has nothing to do with httpx specifically."""
from __future__ import annotations

import concurrent.futures
import time

import pytest

from app.graph import _call_with_deadline


def test_call_with_deadline_returns_result_when_fast_enough():
    assert _call_with_deadline(lambda: 42, deadline=1) == 42


def test_call_with_deadline_raises_timeout_past_the_deadline():
    def slow():
        time.sleep(2)
        return "too slow"

    with pytest.raises(concurrent.futures.TimeoutError):
        _call_with_deadline(slow, deadline=0.2)


def test_call_with_deadline_does_not_block_for_the_full_slow_duration():
    # The whole point: the caller gets control back at the deadline, not after the slow
    # function eventually finishes. This is what a naive `with ThreadPoolExecutor() as ex:`
    # (which blocks on __exit__ until every submitted job finishes) would get wrong.
    def slow():
        time.sleep(2)
        return "too slow"

    start = time.time()
    with pytest.raises(concurrent.futures.TimeoutError):
        _call_with_deadline(slow, deadline=0.2)
    elapsed = time.time() - start
    assert elapsed < 1.0  # well under the slow function's 2s, not blocked waiting for it


def test_call_with_deadline_propagates_exceptions_from_fn():
    def boom():
        raise ValueError("real failure")

    with pytest.raises(ValueError, match="real failure"):
        _call_with_deadline(boom, deadline=1)


def test_multiple_deadline_calls_do_not_serialize_behind_a_stuck_one():
    # If a prior call's thread is abandoned (timed out) but still running, a NEW call must
    # still be able to get a worker slot promptly -- this is why max_workers > 1 matters.
    def stuck():
        time.sleep(5)
        return "stuck"

    with pytest.raises(concurrent.futures.TimeoutError):
        _call_with_deadline(stuck, deadline=0.1)

    start = time.time()
    assert _call_with_deadline(lambda: "fine", deadline=1) == "fine"
    assert time.time() - start < 1.0
