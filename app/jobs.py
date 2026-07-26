"""Shared background-job machinery.

Every long or LLM-touching operation runs as an in-process background job the client polls,
not a blocking request (CLAUDE.md invariant 1). Feature modules (chat, audio, preview, notes,
graph, discovery) use the same scaffolding: a `dict` of jobs + a `Lock`, finished-
job pruning, a daemon thread, the active-project contextvar rebind (invariant 2), and
broad error capture. This centralizes all of that so a feature module only defines its payload
dataclass (a `Job` subclass) and a `work(job)` function.

Two things this makes structural rather than per-module discipline:
  * **The contextvar rebind.** Threads don't inherit the request's active project; the registry
    captures it and rebinds it inside the worker, so a feature module can't forget (getting it
    wrong silently reads/writes the wrong project's files).
  * **Persist-before-done ordering.** The worker sets its result fields and returns; the registry
    flips status to "done" only after `work` fully returns. A client that observes "done" has
    therefore always seen the side effects (recorded turn, saved file) complete — closing the
    poll race that each module otherwise had to avoid by hand.
"""
from __future__ import annotations

import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Generic, TypeVar

from . import config, logging_config

log = logging_config.get("jobs")


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def new_id() -> str:
    return uuid.uuid4().hex


@dataclass
class Job:
    """Base for every job payload. Subclasses add their own progress/result fields. `status` is
    the only lifecycle signal clients need: running -> done | error | cancelled."""
    id: str
    status: str = "running"          # running | done | error | cancelled
    error: str | None = None
    started_at: str = field(default_factory=now_iso)
    finished_at: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


J = TypeVar("J", bound=Job)

# The dedup key and owning project are stashed on the job instance under these attributes (not
# dataclass fields, so they never leak into to_dict()). Keeping them on the job means the
# registry's single _jobs dict is the whole of its state — clearing it (as tests do) is a
# complete reset.
_KEY_ATTR = "_rc_dedup_key"
_PID_ATTR = "_rc_project_id"
_CANCELLED_ATTR = "_rc_cancelled"
_ON_SETTLE_ATTR = "_rc_on_settle"
# Monotonic tick stamped on a job when it stops running, used to rank scopes by recency in
# `_prune`. Deliberately not a timestamp: `started_at`/`finished_at` are ISO strings at SECOND
# resolution, so everything a busy instance settles inside one second compares equal and the
# ordering silently degrades to "whichever scope was inserted first" — which is the oldest, i.e.
# exactly the one the ranking exists to protect.
_SETTLE_SEQ_ATTR = "_rc_settle_seq"

# How many scopes (projects, or per-user audio scopes) keep finished-job history at once. The
# second half of `_prune`'s bound: `max_finished` alone is per scope, and scopes are unbounded
# because nothing limits how many projects a user creates. Generous enough that ordinary use never
# reaches it — a reader works in a handful of projects — and small enough that the process-wide
# ceiling stays a constant.
_MAX_SCOPES_RETAINED = 25

# Sentinel default for the project_id argument: "capture the ambient active project at call
# time". Distinct from an explicit None (which means the app-global scope, e.g. audio).
_AMBIENT: str | None = object()  # type: ignore[assignment]


def _resolve_pid(project_id):
    return config.active_project_id() if project_id is _AMBIENT else project_id


def _log_tag(pid: str | None) -> dict:
    """`extra=` payload pinning a log line to an explicit project (app-global -> '-'), so the
    line isn't mistagged by the emitting thread's ambient context. See logging_config."""
    return {"project": pid or "-"}


# Every registry the process has created, so cross-cutting checks (project deletion refusing
# to pull a directory out from under a running worker) can sweep all job kinds at once.
_ALL_REGISTRIES: list[JobRegistry] = []


def any_running_for_project(pid: str) -> str | None:
    """The name of the first registry holding a RUNNING job for `pid`, else None.

    Used by projects.delete_project: a live worker resolves paths from the project id, so
    moving the directory mid-job would make the worker's next write silently recreate
    `projects/<pid>` and split its output from the trashed copy."""
    for reg in _ALL_REGISTRIES:
        with reg.lock:
            for job in reg.jobs.values():
                if job.status == "running" and getattr(job, _PID_ATTR, None) == pid:
                    return reg.name
    return None


def forget_finished_for_project(pid: str) -> None:
    """Drop terminal in-process jobs when a project is soft-deleted.

    Project ids can be reused after their directory moves to ``.trash``. Retaining an old
    proposal under that pid would expose it through the newly created project's latest-job
    endpoint, so deletion clears every terminal registry entry while its tombstone still blocks
    new admission. Callers must already have refused running jobs.
    """
    for reg in _ALL_REGISTRIES:
        with reg.lock:
            stale = [
                job_id for job_id, job in reg.jobs.items()
                if getattr(job, _PID_ATTR, None) == pid and job.status != "running"
            ]
            for job_id in stale:
                reg.jobs.pop(job_id, None)


class JobRegistry(Generic[J]):
    """Owns a set of jobs of one kind. Thread-safe; one process (CLAUDE.md single-worker note)."""

    def __init__(self, name: str, *, max_finished: int | None = 20):
        self.name = name
        self._jobs: dict[str, J] = {}   # job id -> job (also each job carries its dedup key)
        self._lock = threading.Lock()
        self._max_finished = max_finished
        self._settle_seq = 0
        _ALL_REGISTRIES.append(self)

    @property
    def jobs(self) -> dict[str, J]:
        """The live id->job map. Exposed so feature modules can alias it as their `_jobs` (the
        clear()-to-reset handle their tests already use)."""
        return self._jobs

    @property
    def lock(self) -> threading.Lock:
        """The registry lock. A worker that mutates its job's payload incrementally (streaming
        items, segment counts) must do so under this lock, so a concurrent snapshot() never
        serializes a half-written field."""
        return self._lock

    def get(self, job_id: str, *, project_id=_AMBIENT) -> J | None:
        """The job with this id, but only if it belongs to `project_id` (the ambient project by
        default) — so one project can't read another's job by guessing/leaking its opaque id."""
        pid = _resolve_pid(project_id)
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None or getattr(job, _PID_ATTR, None) != pid:
                return None
            return job

    def snapshot(self, job_id: str, *, project_id=_AMBIENT) -> dict | None:
        """A poll-safe serialized copy (project-scoped like get()), taken under the lock so the
        worker can't be mid-mutation."""
        pid = _resolve_pid(project_id)
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None or getattr(job, _PID_ATTR, None) != pid:
                return None
            return job.to_dict()

    def active_for(self, key: str, *, project_id=_AMBIENT) -> J | None:
        """The running job for a dedup key within a project — how a client that navigated away
        reattaches. Scoped by project so identical keys (e.g. a slug shared across projects) don't
        join each other's jobs."""
        pid = _resolve_pid(project_id)
        with self._lock:
            return self._running_for(key, pid)

    def latest_for(self, key: str, *, project_id=_AMBIENT) -> J | None:
        """Newest retained job for a dedup key, whether running or terminal.

        Unlike ``active_for``, this is intended for proposal/result jobs whose finished value is
        not persisted anywhere else. A client that navigates away after starting one must still
        be able to recover the completed result when it returns.
        """
        pid = _resolve_pid(project_id)
        with self._lock:
            matching = [
                job for job in self._jobs.values()
                if getattr(job, _KEY_ATTR, None) == key
                and getattr(job, _PID_ATTR, None) == pid
            ]
            # Dict insertion order is creation order. Timestamps intentionally use second
            # precision for readable snapshots, so ordering by `started_at` would choose the
            # wrong job when a user immediately retries within the same second.
            return matching[-1] if matching else None

    def _running_for(self, key: str, pid: str | None) -> J | None:  # caller holds the lock
        for job in self._jobs.values():
            if (getattr(job, _KEY_ATTR, None) == key
                    and getattr(job, _PID_ATTR, None) == pid
                    and job.status == "running"):
                return job
        return None

    def cancel(self, job_id: str, *, project_id=_AMBIENT) -> J | None:
        """Request cooperative cancellation of a running job (project-scoped like get()).

        Threads can't be killed, so this marks the job terminal immediately — the client's next
        poll sees `cancelled` — and sets a flag the worker checks via is_cancelled() at its own
        checkpoints (typically between paid upstream calls) to stop doing further work. Because
        `_running_for` only matches running jobs, the dedup key frees up right away; a stale
        worker that hasn't noticed yet only ever finishes writing shared idempotent caches.
        Returns the job (whatever its status — cancelling an already-finished job is a no-op),
        or None when the id is unknown/not owned by this project."""
        pid = _resolve_pid(project_id)
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None or getattr(job, _PID_ATTR, None) != pid:
                return None
            setattr(job, _CANCELLED_ATTR, True)
            was_running = job.status == "running"
            if was_running:
                job.status = "cancelled"
                job.finished_at = now_iso()
                self._stamp_settled(job)
                self._prune()   # this job just became prunable; see _prune's note on settling
        if was_running:
            log.info("cancel %s job=%s", self.name, job.id[:8], extra=_log_tag(pid))
        return job

    def is_cancelled(self, job: J) -> bool:
        """Whether cancel() was requested for this job. Workers poll this at checkpoints."""
        with self._lock:
            return bool(getattr(job, _CANCELLED_ATTR, False))

    def put(self, key: str, job: J, *, project_id=_AMBIENT) -> J:
        """Register an already-terminal job (e.g. a result served straight from cache) with no
        worker thread. Project mutation/deletion admission is gated exactly like
        ``start_or_join`` so a cache hit cannot register after deletion's terminal-job purge
        and leak into a later project that reuses the same id. Returns the job."""
        pid = _resolve_pid(project_id)
        with self._lock:
            # Keep this check under the registry lock: deletion marks the tombstone before
            # sweeping registries, so either this registration wins first and the sweep removes
            # it, or the tombstone wins and registration is refused.
            if pid is not None and (
                config.project_is_deleting(pid) or config.project_is_busy(pid)
            ):
                raise RuntimeError(f"Project {pid} is being modified; not accepting new jobs.")
            setattr(job, _KEY_ATTR, key)
            setattr(job, _PID_ATTR, pid)
            self._jobs[job.id] = job
            self._stamp_settled(job)   # `put` registers an ALREADY-terminal job
            self._prune()
        return job

    def start_or_join(
        self,
        key: str,
        factory: Callable[[], J],
        work: Callable[[J], None],
        *,
        project_id=_AMBIENT,
        admit: Callable[[J | None], None] | None = None,
        allow_busy: bool = False,
    ) -> J:
        """Return the running job for (`project_id`, `key`), or create one via `factory()` and run
        `work(job)` in a daemon thread bound to that project. `project_id` defaults to the ambient
        active project (correct for request-scoped callers like chat/notes); a pid-keyed caller
        (graph/discovery) passes it explicitly so the worker binds the right project even if the
        ambient context is absent or different. When supplied, `admit` runs under the registry
        lock with the newest retained job for the same key and project; it may raise to reject
        registration atomically (proposal jobs use this to avoid hiding unapplied results).
        `allow_busy` is reserved for a caller that already owns the project's busy reservation
        and is admitting the follow-on job before releasing it; deletion tombstones still reject.
        `work` populates the job's fields and returns; the registry then marks it done (or error,
        if `work` raised)."""
        pid = _resolve_pid(project_id)
        # The lifecycle lines carry the job's AUTHORITATIVE project (the resolved pid), passed
        # explicitly so they aren't mistagged by the emitting thread's ambient context — the
        # start/join lines run on the caller thread (which may have a different project bound, or
        # none for an app-global job), while done/error run on the worker thread.
        tag = _log_tag(pid)
        with self._lock:
            # Admission gate for project deletion / an in-progress split of the source: once
            # the pid is tombstoned (delete) or marked busy (split), no new worker may register
            # — its writes would recreate a moved directory or land in files being relocated.
            # Checked INSIDE the registry lock (not before it): the mutating side marks the pid
            # busy BEFORE sweeping the registries, so with the check under the same lock the
            # sweep serializes against registration — either the sweep sees this job, or this
            # job sees the busy flag. Raised, not swallowed — the caller deserves the error.
            if pid is not None and (
                config.project_is_deleting(pid)
                or (config.project_is_busy(pid) and not allow_busy)
            ):
                raise RuntimeError(f"Project {pid} is being modified; not accepting new jobs.")
            matching = [
                job for job in self._jobs.values()
                if getattr(job, _KEY_ATTR, None) == key
                and getattr(job, _PID_ATTR, None) == pid
            ]
            if admit is not None:
                admit(matching[-1] if matching else None)
            existing = self._running_for(key, pid)
            if existing:
                log.debug("join %s job=%s key=%s", self.name, existing.id[:8], key, extra=tag)
                return existing
            job = factory()
            setattr(job, _KEY_ATTR, key)
            setattr(job, _PID_ATTR, pid)
            self._jobs[job.id] = job
            self._prune()
        log.info("start %s job=%s key=%s", self.name, job.id[:8], key, extra=tag)
        # Captured on the CALLER's thread, where the middleware bound it, and rebound on the worker
        # below — invariant 2, for the same reason as the project: a thread inherits no contextvars,
        # so without this every job would silently fall back to the instance's model and voice
        # instead of the preferences of the person who asked for the work.
        thread = threading.Thread(target=self._run, args=(job, work, pid, config.active_user_id()),
                                  daemon=True, name=f"{self.name}-{job.id[:8]}")
        thread.start()
        return job

    def add_settle_callback(self, job: J, cb: Callable[[J], None]) -> bool:
        """Register cb(job) to run on the worker thread immediately after the job settles
        (status flipped, project still bound). Returns False if the job has ALREADY settled —
        the callbacks are read in the same critical section that flips the status, so a False
        return is the caller's cue to handle the settled job inline; there is no window where
        an attachment can be lost."""
        with self._lock:
            if job.status != "running":
                return False
            cbs = getattr(job, _ON_SETTLE_ATTR, None)
            if cbs is None:
                cbs = []
                setattr(job, _ON_SETTLE_ATTR, cbs)
            cbs.append(cb)
            return True

    def _fire_settle(self, job: J, cbs: list, tag: dict) -> None:
        for cb in cbs:
            try:
                cb(job)
            except Exception as e:  # noqa: BLE001 — a settle callback must not kill the thread
                log.warning("settle callback failed %s job=%s: %s", self.name, job.id[:8],
                            str(e)[:200], extra=tag)

    def _run(self, job: J, work: Callable[[J], None], pid: str | None,
             user_id: str | None = None) -> None:
        token = config.set_active_project(pid)
        user_token = config.set_active_user(user_id)
        tag = _log_tag(pid)
        t0 = time.monotonic()
        try:
            work(job)
            with self._lock:
                if job.status == "running":   # worker didn't set a terminal status itself
                    job.status = "done"
                    job.finished_at = now_iso()
                self._stamp_settled(job)
                final = job.status
                settle_cbs = list(getattr(job, _ON_SETTLE_ATTR, ()))
                self._prune()
            dur = time.monotonic() - t0
            if final == "error":  # the worker recorded its own error (e.g. graph per-paper)
                log.warning("error %s job=%s in %.1fs: %s", self.name, job.id[:8], dur,
                            (job.error or "")[:200], extra=tag)
            else:
                # final == "cancelled" means the worker wound down after a cancel() request.
                log.info("%s %s job=%s in %.1fs", final, self.name, job.id[:8], dur, extra=tag)
            self._fire_settle(job, settle_cbs, tag)
        except Exception as e:
            with self._lock:
                # A cancelled job stays cancelled: the worker unwinding (often *because* it was
                # cancelled mid-call) must not resurface to clients as an error.
                if job.status != "cancelled":
                    job.status = "error"
                    job.error = str(e)[:400]
                    job.finished_at = now_iso()
                self._stamp_settled(job)
                settle_cbs = list(getattr(job, _ON_SETTLE_ATTR, ()))
                self._prune()
            log.warning("error %s job=%s in %.1fs: %s", self.name, job.id[:8],
                        time.monotonic() - t0, str(e)[:200], extra=tag)
            self._fire_settle(job, settle_cbs, tag)
        finally:
            config.reset_active_project(token)
            config.reset_active_user(user_token)

    def _stamp_settled(self, job: J) -> None:  # caller holds the lock
        """Record WHEN, in registry order, this job stopped running. See `_SETTLE_SEQ_ATTR`."""
        self._settle_seq += 1
        setattr(job, _SETTLE_SEQ_ATTR, self._settle_seq)

    def _prune(self) -> None:  # caller holds the lock
        """Drop the oldest finished jobs past the cap, so a long-lived process doesn't accumulate
        them forever. max_finished=None keeps everything (used by the pid-keyed registries, which
        hold at most one job per project).

        **Per scope, not process-wide.** The cap used to apply across every project and user at
        once, which made retention of your own result depend on how busy everybody else was. For
        `notes` that is data loss with a price on it: an agent notes proposal lives ONLY here until
        a human approves it (invariant 4), so twenty finished notes jobs belonging to other people
        would evict a completed, paid, unapproved proposal and `/notes/jobs/latest` would then
        report nothing to approve. Bounding per scope means one person's activity can only ever
        evict their own.

        A per-scope cap ALONE would remove the process-wide bound, which is not an acceptable trade:
        for notes/chat/preview/retrieval the scope is a project, and nothing limits how many
        projects a user creates. One finished job in each of ten thousand projects exceeds no local
        cap and is never pruned. So the second bound is on the number of SCOPES that keep history,
        evicting the least recently active one wholesale.

        Evicting by scope recency rather than across scopes is the point. "Your proposal is gone
        because a project you have not touched in weeks aged out" is a defensible rule; "because
        somebody else was busy this afternoon" is not, and that was the old behaviour. Total
        retention is `max_finished x _MAX_SCOPES_RETAINED`, which is a constant.

        **Called when a job SETTLES as well as when one is admitted.** Only running jobs are exempt
        from the caps, so admission-time pruning alone leaves a hole: start forty jobs in forty
        scopes concurrently, let them all finish, and nothing counts them until the next admission —
        which may never come. Pruning at both ends makes the ceiling hold at rest rather than only
        under continued traffic. A job that has just settled is the newest in its scope and its
        scope is now the most recently active *by settlement time* — which is why recency is
        measured that way below and not by `started_at` — so neither cap can evict the result its
        own completion triggered.
        """
        if self._max_finished is None:
            return
        by_scope: dict[str | None, list[J]] = {}
        for job in self._jobs.values():
            if job.status != "running":
                by_scope.setdefault(getattr(job, _PID_ATTR, None), []).append(job)

        for finished in by_scope.values():
            excess = len(finished) - self._max_finished
            if excess <= 0:
                continue
            for stale in sorted(finished, key=lambda j: j.started_at)[:excess]:
                self._jobs.pop(stale.id, None)
                finished.remove(stale)

        if len(by_scope) <= _MAX_SCOPES_RETAINED:
            return
        # Recency is when a scope last SETTLED something, not when it last started something. Using
        # `started_at` was wrong in a way that defeated the purpose: a notes job that ran for an hour
        # and finished last would rank its scope by that old start time, be chosen as the coldest,
        # and be deleted during its own completion — destroying the unapproved proposal that exists
        # nowhere else. The longer a job takes, the more likely it was to be discarded.
        #
        # And a settle *timestamp* is not enough either: they are ISO strings at second resolution,
        # so a busy instance ties, and a tie resolves to insertion order — the oldest scope, which
        # is the one this ranking exists to protect. Hence the monotonic tick.
        def _last_settled(scope: str | None) -> int:
            return max(getattr(j, _SETTLE_SEQ_ATTR, 0) for j in by_scope[scope])

        coldest = sorted(by_scope, key=_last_settled)
        for scope in coldest[:len(by_scope) - _MAX_SCOPES_RETAINED]:
            for stale in by_scope[scope]:
                self._jobs.pop(stale.id, None)
