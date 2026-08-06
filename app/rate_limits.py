"""Per-user ceilings on how *fast* paid work can be started.

This is the rate-limit leg of M3's "ownership + rate-limit + reservation" guard. It answers a
different question from the other two: ownership asks *whose* project this is, reservations ask
whether the account can *afford* the work, and this asks whether one account is starting work
faster than any human reading workflow plausibly needs. That is the denial-of-wallet shape a
budget alone does not catch quickly enough — a looping client can burn a month's ceiling in
minutes, and the ceiling only notices after the money is gone.

**Two independent ceilings, because they fail differently.** A requests-per-minute window bounds
bursts; a concurrent-jobs cap bounds how much paid work can be in flight at once. Neither implies
the other: one client can start three minute-long graph builds without ever exceeding a per-minute
window, and another can start sixty cached-instant jobs a minute while never holding two at once.

**In-process, per invariant 6.** Job state is already in-process and single-worker, so a counter
here is consistent with the thing it is counting. It resets on restart, which is correct for a
burst limit and wrong for a budget — budgets are the durable reservations in `quotas.py`, and the
two must not be conflated (architectural rule 5: analytics is best-effort, ceilings fail closed).

**No signed-in user means no limit.** With `RC_DATABASE_URL` unset and auth open, `./run.sh` and
the test suite have no user to attribute work to, and every request would share one bucket. That
collapses to today's single-household behaviour rather than throttling a local developer.
"""
from __future__ import annotations

import os
import threading
import time
from collections import defaultdict, deque

from . import logging_config

log = logging_config.get("rate_limits")

#: Deliberately generous against a *reading* workflow and still far below what a runaway client
#: emits. Both are operator-tunable; see `_bound` for why a bad value cannot disable the ceiling.
DEFAULT_STARTS_PER_MINUTE = 20
DEFAULT_CONCURRENT_JOBS = 4

WINDOW_SECONDS = 60.0


class RateLimited(RuntimeError):
    """A user-displayable refusal raised before any paid work is admitted.

    Carries `retry_after_seconds` so the route can answer with an honest `Retry-After` instead of
    asking the client to guess.
    """

    def __init__(self, message: str, *, retry_after_seconds: int) -> None:
        super().__init__(message)
        self.retry_after_seconds = max(1, int(retry_after_seconds))


def _bound(name: str, default: int) -> int:
    """Read a positive integer ceiling from the environment.

    An unparseable or non-positive value falls back to the default and logs, rather than being
    treated as "unlimited". Same discipline as the audio cache bound: a typo in an operator's
    environment must never silently remove a ceiling — the dangerous configuration is absence.
    """
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        log.warning("%s=%r is not an integer; using %d", name, raw, default)
        return default
    if value <= 0:
        log.warning("%s=%d is not positive; using %d", name, value, default)
        return default
    return value


def starts_per_minute() -> int:
    return _bound("RC_RATE_LIMIT_STARTS_PER_MINUTE", DEFAULT_STARTS_PER_MINUTE)


def concurrent_jobs() -> int:
    return _bound("RC_RATE_LIMIT_CONCURRENT_JOBS", DEFAULT_CONCURRENT_JOBS)


_lock = threading.Lock()
#: user id -> monotonic timestamps of admitted starts inside the window.
_starts: dict[str, deque[float]] = defaultdict(deque)


def _trim(bucket: deque[float], now: float) -> None:
    horizon = now - WINDOW_SECONDS
    while bucket and bucket[0] <= horizon:
        bucket.popleft()


def check_and_record(user_id: str | None, *, active_jobs: int) -> None:
    """Admit one NEW paid job for `user_id`, or raise `RateLimited`.

    `active_jobs` is supplied by the caller rather than read from the job registries here, so this
    module stays free of an import cycle with `jobs` and stays directly testable.

    Recording happens on admission, not on completion: the cost is committed the moment work
    starts, so that is the moment the window should account for. Only genuinely new jobs reach
    this function — joining an already-running job is not new spend and must not consume budget.
    """
    if not user_id:
        return

    limit = concurrent_jobs()
    if active_jobs >= limit:
        raise RateLimited(
            f"You already have {active_jobs} tasks running. "
            "Wait for one to finish, then try again.",
            retry_after_seconds=10,
        )

    per_minute = starts_per_minute()
    now = time.monotonic()
    with _lock:
        bucket = _starts[user_id]
        _trim(bucket, now)
        if len(bucket) >= per_minute:
            retry_after = int(WINDOW_SECONDS - (now - bucket[0])) + 1
            raise RateLimited(
                f"That's more than {per_minute} tasks in a minute. "
                "Give it a moment and try again.",
                retry_after_seconds=retry_after,
            )
        bucket.append(now)


def reset(user_id: str | None = None) -> None:
    """Drop recorded history — for tests, and for an operator clearing a stuck bucket."""
    with _lock:
        if user_id is None:
            _starts.clear()
        else:
            _starts.pop(user_id, None)
