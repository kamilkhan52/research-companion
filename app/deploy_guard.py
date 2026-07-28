"""Cross-process exclusion for filesystem-destructive maintenance.

Every database-backed app process holds a shared Postgres advisory lock for its lifetime.
Account deletion drops its own shared lock and takes the exclusive form before removing files.
That makes a rolling replacement wait for the retiring process to actually disconnect instead of
guessing when Fly started its kill timer.
"""
from __future__ import annotations

import os
import signal
import threading
import time
from dataclasses import dataclass, field
from hashlib import blake2s
from typing import Any

from . import config, db, logging_config

log = logging_config.get("deploy-guard")

# Advisory locks are cluster-wide, and staging may share the Postgres cluster while using a
# different Fly volume. The explicit deployment id prevents one app's deletion from blocking the
# other. The class id is fixed; the object id is a stable signed int32 hash for Postgres's 2-key API.
_LOCK_CLASS = 1_009_207
_CHECK_S = 5.0
_IO_TIMEOUT_S = 10.0
_EXCLUSIVE_ACQUIRE_TIMEOUT_S = float(os.environ.get(
    "RC_DEPLOY_GUARD_ACQUIRE_TIMEOUT_S",
    "600",
))
_LOCK_POLL_S = 0.25

_state_lock = threading.Lock()
_destructive_lock = threading.Lock()
_shared_conn = None
_cached_lock_parts: tuple[int, int] | None = None


class DeployGuardLost(RuntimeError):
    """The dedicated database session no longer proves process exclusion."""


@dataclass
class ExclusiveLease:
    """A live exclusive advisory-lock session with bounded health checks."""

    conn: Any
    lost: threading.Event = field(default_factory=threading.Event)
    fatal_reported: threading.Event = field(default_factory=threading.Event)
    stop: threading.Event = field(default_factory=threading.Event)
    io_lock: threading.Lock = field(default_factory=threading.Lock)


def _lock_parts() -> tuple[int, int]:
    global _cached_lock_parts
    if _cached_lock_parts is not None:
        return _cached_lock_parts
    deployment_id = os.environ.get("RC_DEPLOY_GUARD_ID", "").strip()
    if not deployment_id:
        if not config.is_dev_env():
            raise RuntimeError("RC_DEPLOY_GUARD_ID is required outside development.")
        deployment_id = f"dev:{config.PROJECTS_ROOT}"
    object_id = int.from_bytes(
        blake2s(deployment_id.encode("utf-8"), digest_size=4).digest(),
        "big",
        signed=True,
    )
    _cached_lock_parts = (_LOCK_CLASS, object_id)
    return _cached_lock_parts


def _connect():
    # A dedicated session is required: session advisory locks disappear exactly when this process
    # disconnects. Keeping it outside the request pool also prevents a checked-in connection from
    # carrying a process-lifetime lock into unrelated work.
    import psycopg

    db.assert_usable_url()
    return psycopg.connect(db.url(), autocommit=True, connect_timeout=10)


def _execute_bounded(conn, query: str, params=None, *, timeout_s: float = _IO_TIMEOUT_S):
    """Run one guard query without letting a blackholed socket stall the watchdog forever.

    Psycopg's ``connect_timeout`` only covers connection establishment. A daemon helper lets the
    owner enforce a deadline on an already-established connection; a timeout makes the lease
    unusable and the process fail closed, so the abandoned helper is never reused.
    """
    finished = threading.Event()
    outcome: dict[str, Any] = {}

    def execute() -> None:
        try:
            outcome["result"] = conn.execute(query, params)
        except BaseException as exc:  # noqa: BLE001 — re-raised on the owning thread
            outcome["error"] = exc
        finally:
            finished.set()

    threading.Thread(target=execute, daemon=True, name="deploy-guard-io").start()
    if not finished.wait(timeout_s):
        raise TimeoutError("deploy-guard-io")
    if error := outcome.get("error"):
        raise error
    return outcome.get("result")


def _terminate_for_guard_loss(kind: str, exc: BaseException) -> None:
    config.begin_global_job_drain()
    log.critical(
        "%s deploy guard lost error=%s; terminating",
        kind,
        type(exc).__name__,
    )
    os.kill(os.getpid(), signal.SIGTERM)


def _wait_for_advisory_lock(
    conn,
    *,
    shared: bool,
    timeout_s: float,
) -> None:
    function = "pg_try_advisory_lock_shared" if shared else "pg_try_advisory_lock"
    deadline = time.monotonic() + timeout_s
    while True:
        cursor = _execute_bounded(
            conn,
            f"select {function}(%s, %s)",
            _lock_parts(),
        )
        if cursor.fetchone()[0]:
            return
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(
                "deploy-guard-shared" if shared else "deploy-guard-exclusive",
            )
        time.sleep(min(_LOCK_POLL_S, remaining))


def start(*, timeout_s: float | None = None) -> bool:
    """Acquire the shared lifetime guard, with a bounded wait behind deletion."""
    global _shared_conn
    if not db.enabled():
        return False
    with _state_lock:
        if _shared_conn is not None:
            return False
        conn = _connect()
        try:
            _wait_for_advisory_lock(
                conn,
                shared=True,
                timeout_s=(
                    _EXCLUSIVE_ACQUIRE_TIMEOUT_S if timeout_s is None else timeout_s
                ),
            )
        except Exception:
            conn.close()
            raise
        _shared_conn = conn

    def watchdog(held_conn) -> None:
        global _shared_conn
        while True:
            time.sleep(_CHECK_S)
            with _state_lock:
                if _shared_conn is not held_conn:
                    return
                try:
                    _execute_bounded(held_conn, "select 1")
                except Exception as exc:  # noqa: BLE001 — losing the guard is process-fatal
                    # The lock may already be gone server-side. Stop accepting new background work
                    # immediately, then terminate; an exclusive deleter still observes the legacy
                    # overlap delay before touching files, giving Fly's shutdown window time.
                    _shared_conn = None
                    try:
                        held_conn.close()
                    finally:
                        _terminate_for_guard_loss("shared", exc)
                    return

    threading.Thread(
        target=watchdog,
        args=(conn,),
        daemon=True,
        name="deploy-guard-watchdog",
    ).start()
    return True


def _release_shared() -> None:
    global _shared_conn
    with _state_lock:
        conn = _shared_conn
        if conn is None:
            return
        _shared_conn = None
        try:
            _execute_bounded(
                conn,
                "select pg_advisory_unlock_shared(%s, %s)",
                _lock_parts(),
            )
        finally:
            conn.close()


def stop() -> None:
    """Release the process guard explicitly (primarily orderly shutdown and test teardown)."""
    _release_shared()


def _probe_locked(lease: ExclusiveLease) -> None:
    """Health-check the lease session. The caller must already hold ``lease.io_lock``."""
    if lease.lost.is_set():
        raise DeployGuardLost("exclusive deploy guard was lost")
    try:
        _execute_bounded(lease.conn, "select 1")
    except Exception as exc:
        lease.lost.set()
        raise DeployGuardLost("exclusive deploy guard was lost") from exc


def _assert_exclusive(lease: ExclusiveLease) -> None:
    if lease.lost.is_set():
        raise DeployGuardLost("exclusive deploy guard was lost")
    with lease.io_lock:
        _probe_locked(lease)


def assert_exclusive(lease: ExclusiveLease | None) -> None:
    """Synchronously prove the exclusive session is alive before destructive work."""
    if lease is None:
        return
    try:
        _assert_exclusive(lease)
    except Exception as exc:
        _fail_exclusive(lease, exc)
        raise


def _watch_exclusive(lease: ExclusiveLease) -> None:
    while not lease.stop.wait(_CHECK_S):
        try:
            with lease.io_lock:
                # Re-check UNDER the lock, not just at the top of the loop. `release_exclusive`
                # sets `stop` before it takes this lock and closes the connection while holding
                # it, so a watchdog that woke a moment earlier and blocked here would come back
                # to a closed session, read that as a lost guard, and SIGTERM a process whose
                # deletion had in fact just succeeded.
                if lease.stop.is_set():
                    return
                _probe_locked(lease)
        except Exception as exc:  # noqa: BLE001 — losing the guard is process-fatal
            lease.lost.set()
            try:
                lease.conn.close()
            finally:
                _fail_exclusive(lease, exc)
            return


def _fail_exclusive(lease: ExclusiveLease, exc: BaseException) -> None:
    if lease.fatal_reported.is_set():
        return
    lease.fatal_reported.set()
    _terminate_for_guard_loss("exclusive", exc)


def acquire_exclusive(*, timeout_s: float | None = None):
    """Return a held exclusive-lock session after every guarded peer has disconnected.

    Local serialization matters too: two account deletions in one process must not have one
    attempt reacquire the shared lifetime lock while the other is waiting for exclusivity.
    """
    if not db.enabled():
        return None
    budget = _EXCLUSIVE_ACQUIRE_TIMEOUT_S if timeout_s is None else timeout_s
    deadline = time.monotonic() + max(0.0, budget)
    if not _destructive_lock.acquire(timeout=max(0.0, budget)):
        raise TimeoutError("deploy-guard-local-exclusive")
    conn = None
    try:
        remaining = max(0.0, deadline - time.monotonic())
        start(timeout_s=remaining)
        _release_shared()
        conn = _connect()
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("deploy-guard-exclusive")
        _wait_for_advisory_lock(
            conn,
            shared=False,
            timeout_s=remaining,
        )
        lease = ExclusiveLease(conn)
        threading.Thread(
            target=_watch_exclusive,
            args=(lease,),
            daemon=True,
            name="deploy-guard-exclusive-watchdog",
        ).start()
        return lease
    except Exception:
        if conn is not None:
            conn.close()
        try:
            try:
                # The caller's acquisition deadline is already exhausted or failed. Restoring a
                # compatible shared lock should succeed on the first try; if another process took
                # exclusivity, fail-stop instead of turning cleanup into another unbounded wait.
                start(timeout_s=0)
            except Exception as restore_exc:
                _terminate_for_guard_loss("shared restore", restore_exc)
                raise
        finally:
            _destructive_lock.release()
        raise


def release_exclusive(lease: ExclusiveLease) -> None:
    """Release a token from :func:`acquire_exclusive` and restore the lifetime guard."""
    if lease is None:
        return
    lease.stop.set()
    release_error: BaseException | None = None
    try:
        with lease.io_lock:
            try:
                if not lease.lost.is_set():
                    _execute_bounded(
                        lease.conn,
                        "select pg_advisory_unlock(%s, %s)",
                        _lock_parts(),
                    )
            except Exception as exc:  # noqa: BLE001 — absence of a guard is process-fatal
                lease.lost.set()
                release_error = exc
            finally:
                lease.conn.close()
        if lease.lost.is_set():
            _fail_exclusive(
                lease,
                release_error or DeployGuardLost("exclusive deploy guard was lost"),
            )
        else:
            try:
                start()
            except Exception as exc:
                _terminate_for_guard_loss("shared restore", exc)
                raise
    finally:
        _destructive_lock.release()
