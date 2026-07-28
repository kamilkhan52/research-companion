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
from hashlib import blake2s

from . import config, db, logging_config

log = logging_config.get("deploy-guard")

# Advisory locks are cluster-wide, and staging may share the Postgres cluster while using a
# different Fly volume. The explicit deployment id prevents one app's deletion from blocking the
# other. The class id is fixed; the object id is a stable signed int32 hash for Postgres's 2-key API.
_LOCK_CLASS = 1_009_207
_CHECK_S = 5.0

_state_lock = threading.Lock()
_destructive_lock = threading.Lock()
_shared_conn = None
_cached_lock_parts: tuple[int, int] | None = None


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


def start() -> bool:
    """Acquire this process's shared lifetime guard. Idempotent; blocks behind deletion."""
    global _shared_conn
    if not db.enabled():
        return False
    with _state_lock:
        if _shared_conn is not None:
            return False
        conn = _connect()
        try:
            conn.execute("select pg_advisory_lock_shared(%s, %s)", _lock_parts())
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
                    held_conn.execute("select 1")
                except Exception as exc:  # noqa: BLE001 — losing the guard is process-fatal
                    # The lock may already be gone server-side. Stop accepting new background work
                    # immediately, then terminate; an exclusive deleter still observes the legacy
                    # overlap delay before touching files, giving Fly's shutdown window time.
                    config.begin_global_job_drain()
                    log.critical("deploy guard lost error=%s; terminating", type(exc).__name__)
                    _shared_conn = None
                    try:
                        held_conn.close()
                    finally:
                        os.kill(os.getpid(), signal.SIGTERM)
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
            conn.execute("select pg_advisory_unlock_shared(%s, %s)", _lock_parts())
        finally:
            conn.close()


def stop() -> None:
    """Release the process guard explicitly (primarily orderly shutdown and test teardown)."""
    _release_shared()


def acquire_exclusive():
    """Return a held exclusive-lock session after every guarded peer has disconnected.

    Local serialization matters too: two account deletions in one process must not have one
    attempt reacquire the shared lifetime lock while the other is waiting for exclusivity.
    """
    if not db.enabled():
        return None
    _destructive_lock.acquire()
    conn = None
    try:
        start()
        _release_shared()
        conn = _connect()
        conn.execute("select pg_advisory_lock(%s, %s)", _lock_parts())
        return conn
    except Exception:
        if conn is not None:
            conn.close()
        try:
            start()
        finally:
            _destructive_lock.release()
        raise


def release_exclusive(conn) -> None:
    """Release a token from :func:`acquire_exclusive` and restore the lifetime guard."""
    if conn is None:
        return
    try:
        try:
            conn.execute("select pg_advisory_unlock(%s, %s)", _lock_parts())
        finally:
            conn.close()
        try:
            start()
        except Exception as exc:
            config.begin_global_job_drain()
            log.critical(
                "deploy guard could not be restored error=%s; terminating",
                type(exc).__name__,
            )
            os.kill(os.getpid(), signal.SIGTERM)
            raise
    finally:
        _destructive_lock.release()
