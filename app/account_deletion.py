"""Durable, retry-safe account deletion.

Deletion is a background operation with polling, just like every other long-running flow in this
service. Its durable Postgres row is also an admission tombstone: Supabase access tokens issued
before Auth identity deletion remain usable until expiry, so removing the Auth row alone is not a
request gate.
"""
from __future__ import annotations

import os
import shutil
import threading
import time
from datetime import datetime
from pathlib import Path

from . import config, db, deploy_guard, jobs, logging_config, projects, supabase_admin, tenancy

log = logging_config.get("account-deletion")

DRAIN_POLL_S = 0.1
DRAIN_TIMEOUT_S = 600.0
# A Fly deploy can overlap the retiring and replacement processes even though the steady-state
# deployment has exactly one Machine. Request/job registries are intentionally process-local.
# deploy_guard's shared/exclusive advisory lock confirms feature-aware peers disconnected; this
# additional wait covers the first rollout (whose old process has no guard) and guard-connection
# loss, after the replacement is already serving or has acquired database exclusivity.
#
# Default closed outside dev so a production-like deployment cannot silently omit the setting.
# fly.toml and fly.staging.toml state the same value beside kill_timeout, where drift is visible.
DEPLOY_OVERLAP_S = float(os.environ.get(
    "RC_ACCOUNT_DELETION_OVERLAP_S",
    "0" if config.is_dev_env() else "310",
))

_workers: set[str] = set()
_workers_lock = threading.Lock()
_monitor_started = False
_monitor_lock = threading.Lock()
RESUME_SCAN_S = 5.0


class AccountDeletionUnavailable(RuntimeError):
    """The durable deletion workflow is not configured."""


def subject_key(user_id: str) -> str:
    if not db.is_uuid(user_id):
        raise ValueError("user_id must be a UUID")
    return config.user_scope_key_for(user_id)


def _public_row(row) -> dict | None:
    if row is None:
        return None

    def rendered(value):
        return value.isoformat() if isinstance(value, datetime) else value

    return {
        "status": row[0],
        "error_code": row[1],
        "attempts": row[2],
        "requested_at": rendered(row[3]),
        "updated_at": rendered(row[4]),
        "completed_at": rendered(row[5]),
    }


def status_for(user_id: str) -> dict | None:
    """The caller-safe durable status for one verified subject."""
    if not db.enabled():
        return None
    key = subject_key(user_id)
    with db.pool().connection() as conn:
        row = conn.execute(
            "select status, error_code, attempts, requested_at, updated_at, completed_at "
            "from rc_account_deletions where subject_key = %s",
            (key,),
        ).fetchone()
    return _public_row(row)


def is_blocked(user_id: str) -> bool:
    """Whether this verified subject has ever started permanent deletion."""
    if not db.enabled():
        return False
    key = subject_key(user_id)
    with db.pool().connection() as conn:
        return conn.execute(
            "select 1 from rc_account_deletions where subject_key = %s",
            (key,),
        ).fetchone() is not None


def request(user_id: str) -> dict:
    """Persist an idempotent request, close admission, and start/resume its worker."""
    if not db.enabled():
        raise AccountDeletionUnavailable("Account deletion requires RC_DATABASE_URL.")
    if not supabase_admin.configured():
        # Refuse before writing the tombstone or removing application data. A deployment may land
        # before H23 supplies the privileged key; that must not turn a UI tap into a half-deletion.
        raise AccountDeletionUnavailable(
            "Account deletion is not configured on this server yet.")

    key = subject_key(user_id)
    config.mark_user_deleting(user_id)
    try:
        with db.pool().connection() as conn:
            conn.execute(
                "insert into rc_account_deletions (subject_key, user_id) values (%s, %s) "
                "on conflict (subject_key) do nothing",
                (key, user_id),
            )
            row = conn.execute(
                "select user_id::text, status, error_code, attempts, requested_at, updated_at, "
                "completed_at from rc_account_deletions where subject_key = %s",
                (key,),
            ).fetchone()
        if row is None:
            raise RuntimeError("Deletion request was not persisted.")
        # A completed tombstone deliberately has no raw UUID. Any non-null value must still match
        # the verified subject; a (vanishingly unlikely) hash collision must fail closed.
        if row[0] is not None and row[0] != user_id:
            raise RuntimeError("Deletion subject collision.")
    except Exception:
        config.unmark_user_deleting(user_id)
        raise

    if row[1] != "completed":
        start_worker(user_id)
    return _public_row(row[1:])


def _set_status(
    key: str,
    status: str,
    *,
    error_code: str | None = None,
    increment_attempt: bool = False,
    completed: bool = False,
) -> None:
    with db.pool().connection() as conn:
        changed = conn.execute(
            "update rc_account_deletions set status = %s, error_code = %s, "
            "attempts = attempts + %s, updated_at = now(), "
            "completed_at = case when %s then now() else completed_at end, "
            "user_id = case when %s then null else user_id end "
            "where subject_key = %s",
            (status, error_code, int(increment_attempt), completed, completed, key),
        ).rowcount
    if changed != 1:
        # Never perform irreversible work without the durable row that makes a crash retryable.
        raise RuntimeError("Deletion request is missing.")


def _owned_data(user_id: str) -> tuple[set[str], set[str]]:
    live = tenancy.projects_owned_by(user_id) | projects.provisionally_owned_projects(user_id)
    trash = tenancy.trash_entries_owned_by(user_id)

    # During the 0004 rolling migration an old process could retire a project after the trigger
    # landed but before that process knew how to populate rc_project_trash. The trigger preserved
    # only the project-level former owner. Reconcile that link exactly as the adoption script does:
    # one concrete incarnation is attributable; multiple unindexed incarnations are not. Never
    # clear the transition owner and claim completion while an ambiguous repository remains.
    transition_pids = tenancy.transition_projects_owned_by(user_id)
    by_pid: dict[str, list[str]] = {}
    for name in projects.trashed_project_entries():
        pid = projects.project_id_from_trash_name(name)
        if pid in transition_pids:
            by_pid.setdefault(pid, []).append(name)

    for pid in transition_pids:
        names = by_pid.get(pid, [])
        owners = {name: tenancy.trash_owner_of(name) for name in names}
        unindexed = [name for name, owner in owners.items() if owner is None]
        if len(names) == 1:
            owner = owners[names[0]]
            if owner is None:
                trash.add(names[0])
            elif owner != user_id:
                raise RuntimeError("transition-trash-owner-conflict")
        elif unindexed:
            raise RuntimeError("ambiguous-transition-trash")
    return live, trash


def _trash_path(trash_name: str) -> Path:
    projects.project_id_from_trash_name(trash_name)  # validates the complete concrete name
    root = config.PROJECTS_ROOT / ".trash"
    path = root / trash_name
    if os.path.commonpath((os.path.abspath(path), os.path.abspath(root))) != os.path.abspath(root):
        raise projects.ProjectError("Invalid project trash entry.")
    return path


def _remove_tree(path: Path) -> None:
    """Idempotently remove one owned tree, surfacing failures rather than claiming success."""
    if path.is_symlink():
        # Never follow a top-level symlink out of the attributable store. Removing the link is the
        # only safe interpretation; project import rejects symlinked trees, but deletion should
        # remain safe if an operator put one there by hand.
        path.unlink()
    elif path.exists():
        shutil.rmtree(path)


def _retire_database_rows(user_id: str) -> None:
    """Remove attribution/settings while retaining content-free project-id tombstones."""
    with db.pool().connection() as conn:
        with conn.transaction():
            conn.execute("delete from rc_project_trash where owner_id = %s", (user_id,))
            # The transition trigger deliberately copies owner_id to deleted_owner_id. Clear that
            # link in a second statement after owner_id is null; then retain the row itself as the
            # anti-ABA reservation that prevents a stale authorized request reaching a reused id.
            conn.execute(
                "update rc_projects set owner_id = null, deleted_at = coalesce(deleted_at, now()) "
                "where owner_id = %s",
                (user_id,),
            )
            conn.execute(
                "update rc_projects set deleted_owner_id = null where deleted_owner_id = %s",
                (user_id,),
            )
            conn.execute("delete from rc_users where id = %s", (user_id,))


def _wait_for_requests(user_id: str) -> None:
    deadline = time.monotonic() + DRAIN_TIMEOUT_S
    while config.active_request_count(user_id):
        if time.monotonic() >= deadline:
            raise TimeoutError("request-drain")
        time.sleep(DRAIN_POLL_S)


def _wait_for_workers(scopes: set[str | None]) -> None:
    deadline = time.monotonic() + DRAIN_TIMEOUT_S
    jobs.request_cancellation_for_scopes(scopes)
    while jobs.any_active_for_scopes(scopes):
        if time.monotonic() >= deadline:
            raise TimeoutError("worker-drain")
        time.sleep(DRAIN_POLL_S)


def _wait_for_prior_deploy_processes() -> None:
    """Cover an unguarded first-rollout peer or a process whose guard connection was lost.

    Feature-aware peers have already disconnected before deploy_guard grants exclusivity. A legacy
    peer cannot create a deletion tombstone itself, so this attempt can only begin once the new
    guarded route is serving; a peer that loses its guard is terminated by the watchdog. Measuring
    a full wait from *each* exclusive attempt covers both without trusting the original request
    time, and a replacement interrupted here starts the safety window again.
    """
    deadline = time.monotonic() + DEPLOY_OVERLAP_S
    while (remaining := deadline - time.monotonic()) > 0:
        time.sleep(min(DRAIN_POLL_S, remaining))


def _run(user_id: str) -> None:
    key = subject_key(user_id)
    config.mark_user_deleting(user_id)
    claimed_projects: set[str] = set()
    global_drain = False
    deployment_guard = None
    phase = "pending"
    try:
        with config.bound_scope(None, user_id):
            phase = "draining"
            _set_status(key, phase, increment_attempt=True)
            # Snapshot only after every request that beat the admission gate has finished. A
            # create/delete/split request can change both ownership sets; capturing before this
            # drain would permanently miss the project or trash incarnation it publishes.
            _wait_for_requests(user_id)
            # `is_blocked()` closes admission durably on every process, but a request admitted by a
            # retiring Fly process just before the tombstone is visible only to that process's
            # counter. Let Fly's configured kill window retire it before enumerating or deleting
            # anything. This is intentionally before the ownership snapshot.
            config.begin_global_job_drain()
            global_drain = True
            # Every feature-aware process holds the shared form for its lifetime. The exclusive
            # lock therefore proves retiring peers actually disconnected; the delay below remains
            # as a first-rollout/guard-loss safety window for a legacy process with no shared lock.
            deployment_guard = deploy_guard.acquire_exclusive()
            _wait_for_prior_deploy_processes()
            deploy_guard.assert_exclusive(deployment_guard)
            # A replacement process can start this attempt while the retiring one is already in
            # its destructive phase. The retiring process is guaranteed gone by now; if it
            # completed before exiting, do not repeat the work or regress its completed tombstone.
            current = status_for(user_id)
            if current and current.get("status") == "completed":
                return
            deploy_guard.assert_exclusive(deployment_guard)
            project_ids, trash_names = _owned_data(user_id)

            # Close project-scoped admission too. This covers system-triggered work that has a
            # project but no originating request from the deleting account.
            for pid in sorted(project_ids):
                if not config.mark_project_deleting(pid):
                    raise RuntimeError("project-delete-in-progress")
                claimed_projects.add(pid)

            owned_scopes = set(project_ids)
            owned_scopes.add(f"user:{config.user_scope_key_for(user_id)}")
            # The app-global cover backfill can be mid-project while its registry scope is None.
            # Pause global job admission and drain that scope too; otherwise it can write a cover
            # after the owned directory has been removed.
            drain_scopes: set[str | None] = set(owned_scopes)
            drain_scopes.add(None)
            _wait_for_workers(drain_scopes)

            phase = "deleting_data"
            _set_status(key, phase)
            for pid in sorted(project_ids):
                deploy_guard.assert_exclusive(deployment_guard)
                _remove_tree(projects.project_path(pid))
            for trash_name in sorted(trash_names):
                deploy_guard.assert_exclusive(deployment_guard)
                _remove_tree(_trash_path(trash_name))
            deploy_guard.assert_exclusive(deployment_guard)
            _remove_tree(config.APP_STATE_DIR / "users" / config.user_scope_key_for(user_id))
            jobs.forget_inactive_for_scopes(owned_scopes)
            deploy_guard.assert_exclusive(deployment_guard)
            _retire_database_rows(user_id)

            phase = "deleting_identity"
            _set_status(key, phase)
            deploy_guard.assert_exclusive(deployment_guard)
            supabase_admin.delete_user(user_id)

            _set_status(key, "completed", completed=True)
            log.info("account deletion completed subject=%s", key)
    except Exception as exc:  # noqa: BLE001 — every step is durable and retryable
        if isinstance(exc, supabase_admin.SupabaseDeleteError):
            detail = exc.code
        else:
            detail = type(exc).__name__
        code = f"{phase}:{detail}"[:128]
        try:
            _set_status(key, "error", error_code=code)
        except Exception as state_exc:  # noqa: BLE001
            log.error(
                "account deletion status write failed subject=%s error=%s",
                key,
                type(state_exc).__name__,
            )
        log.warning("account deletion paused subject=%s error=%s", key, code)
    finally:
        try:
            for pid in claimed_projects:
                config.unmark_project_deleting(pid)
            if deployment_guard is not None:
                deploy_guard.release_exclusive(deployment_guard)
        finally:
            if global_drain:
                config.end_global_job_drain()
            with _workers_lock:
                _workers.discard(key)


def start_worker(user_id: str) -> bool:
    """Start one durable deletion attempt. False means an attempt is already running."""
    key = subject_key(user_id)
    config.mark_user_deleting(user_id)
    with _workers_lock:
        if key in _workers:
            return False
        _workers.add(key)
    thread = threading.Thread(
        target=_run,
        args=(user_id,),
        daemon=True,
        name=f"account-delete-{key[:8]}",
    )
    thread.start()
    return True


def resume_pending() -> int:
    """Resume active and due failed requests after a process restart."""
    return resume_active()


def _retry_delay_s(attempts: int) -> float:
    """Bounded exponential delay for durable error rows; first retry is prompt."""
    return min(300.0, RESUME_SCAN_S * (2 ** min(max(attempts - 1, 0), 6)))


def resume_active() -> int:
    """Resume active and due failed requests, including post-identity response loss."""
    if not db.enabled() or not supabase_admin.configured():
        return 0
    with db.pool().connection() as conn:
        rows = conn.execute(
            "select user_id::text, status, attempts, "
            "extract(epoch from (now() - updated_at)) "
            "from rc_account_deletions "
            "where user_id is not null "
            "and status <> 'completed'",
        ).fetchall()
    due = [
        row[0] for row in rows
        if row[1] != "error" or float(row[3]) >= _retry_delay_s(row[2])
    ]
    for user_id in due:
        start_worker(user_id)
    return len(due)


def start_resume_monitor() -> bool:
    """Start one daemon that closes the rolling-deploy gap after the one-time startup scan."""
    global _monitor_started
    if not db.enabled() or not supabase_admin.configured():
        return False
    with _monitor_lock:
        if _monitor_started:
            return False
        _monitor_started = True

    def monitor() -> None:
        while True:
            time.sleep(RESUME_SCAN_S)
            try:
                resume_active()
            except Exception as exc:  # noqa: BLE001 — the next bounded scan retries
                log.warning("account deletion resume scan failed error=%s", type(exc).__name__)

    threading.Thread(
        target=monitor,
        daemon=True,
        name="account-delete-resume",
    ).start()
    return True
