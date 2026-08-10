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
  * **Persist-and-settle-before-done/error ordering.** The worker sets its result fields and
    returns; the registry settles any owned spend reservation before publishing "done" or
    "error". A client that observes either state therefore sees both persisted side effects and
    the account ledger complete. Cooperative cancellation remains immediately visible by design,
    but `finished_at` stays null until the worker has unwound and its reservation was settled.
"""
from __future__ import annotations

import concurrent.futures
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Generic, TypeVar

from . import config, logging_config, rate_limits, spend_ceiling

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


@dataclass
class _Admission:
    """One outside-lock preparation and the job concurrent callers must share.

    `published` is retained on this object after it leaves the registry map because waiters already
    hold the object. They can therefore return the same attempt even if a zero-duration worker
    settles before they are scheduled after the event wakeup.
    """

    event: threading.Event = field(default_factory=threading.Event)
    published: Job | None = None

# The dedup key and owning project are stashed on the job instance under these attributes (not
# dataclass fields, so they never leak into to_dict()). Keeping them on the job means the
# registry's single _jobs dict is the whole of its state — clearing it (as tests do) is a
# complete reset.
_KEY_ATTR = "_rc_dedup_key"
_PID_ATTR = "_rc_project_id"
# The account the job was admitted for. Stamped like the project so a running worker can be
# attributed to a user without consulting the ambient contextvar of whichever thread is asking —
# the rate limiter counts one account's live work from an unrelated caller's thread.
_USER_ATTR = "_rc_user_id"
#: Monotonic clock reading from when the worker was published. Used only to stop a WEDGED worker
#: from consuming an account's concurrency slot forever (see `_STUCK_AFTER_SECONDS`); deliberately
#: monotonic rather than `started_at`, which is a second-resolution ISO string.
_STARTED_MONO_ATTR = "_rc_started_mono"
_CANCELLED_ATTR = "_rc_cancelled"
_WORKER_ACTIVE_ATTR = "_rc_worker_active"
_ON_SETTLE_ATTR = "_rc_on_settle"
# A worker can commit an outcome while its spend reservation is still settling. Keeping that
# outcome private prevents polling from observing done/error before `/api/plan` can observe the
# same job's spend. It also closes the completion-vs-Stop window for workers such as Discovery,
# which persist their result under the registry lock before returning.
_PENDING_OUTCOME_ATTR = "_rc_pending_outcome"
# Set in the same critical section that snapshots settle callbacks. Once true, a newly attached
# callback must run inline instead of joining a list the worker has already consumed.
_FINALIZED_ATTR = "_rc_finalized"
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


def _worker_is_active(job: Job) -> bool:
    """Whether work can still touch the job's scope.

    Registry-managed threads carry the explicit marker so cancellation can be terminal to clients
    while the worker remains active. A few deadline-orphan adapters publish a manually managed
    ``running`` job instead; preserving status as their fallback keeps those external threads in
    lifecycle accounting without pretending JobRegistry owns them.
    """
    marker = getattr(job, _WORKER_ACTIVE_ATTR, None)
    return job.status == "running" if marker is None else bool(marker)


# Every registry the process has created, so cross-cutting checks (project deletion refusing
# to pull a directory out from under a running worker) can sweep all job kinds at once.
_ALL_REGISTRIES: list[JobRegistry] = []


def any_active_for_scopes(scopes: set[str | None]) -> str | None:
    """The first registry with a live worker OR durable admission in ``scopes``, else None.

    Admission can be waiting on Postgres before its worker is published. Treating that interval as
    idle would let project/account deletion remove the scope and clear its tombstone; the callback
    could then return and publish a worker into a directory that no longer exists.
    """
    for reg in _ALL_REGISTRIES:
        with reg.lock:
            if any(scope in scopes for _user_id, scope, _key in reg._admitting):
                return reg.name
            for job in reg.jobs.values():
                if (
                    _worker_is_active(job)
                    and getattr(job, _PID_ATTR, None) in scopes
                ):
                    return reg.name
    return None


#: After this long, a still-active worker stops counting toward an account's CONCURRENCY ceiling.
#: Not a timeout and not a cancellation — the worker keeps running and its spend is still metered.
#: This exists because cancellation is cooperative (`cancel` only sets a flag the worker must
#: check), so a job wedged inside a call with no checkpoint would otherwise consume one of a small
#: number of account-wide slots until the process restarts — locking that account out of chat,
#: notes, retrieval, audio, discovery, graph, labs and profiles at once. The roadmap is explicit
#: that blocking a legitimate paying user is worse than a mild overspend, so this fails open.
#:
#: It is NOT a "no legitimate job runs this long" bound, and an earlier comment here wrongly said
#: so on the basis of Discovery's ~7-minute cold run. Graph builds are also metered and can far
#: exceed this: `graph.EXTRACTION_HARD_DEADLINE` is 480s PER PAPER at a concurrency of 1–8, and
#: `graph_jobs`'s own docstring records a real build still going after 2.5 hours. A large build
#: will therefore stop holding its slot while still legitimately running, and its owner can start
#: work beyond the concurrency cap for the remainder. That is the accepted trade: the per-minute
#: window still applies, the spend is still metered, and the alternative — one wedged worker
#: locking an account out of all eight paid features until the process restarts — is the failure
#: the risk section explicitly ranks worse. No single constant serves both a 20-second narration
#: and a two-hour graph build; scaling the bound per job kind is the real fix if this matters.
_STUCK_AFTER_SECONDS = 30 * 60


def active_count_for_user(
    user_id: str | None,
    *,
    exclude: tuple[str | None, str | None, str] | None = None,
) -> int:
    """How much paid work this account currently has in flight, across every registry.

    Counts live workers AND in-flight admissions, for the same reason `any_active_for_scopes`
    does: an admission waiting on Postgres has committed to doing the work but has not published a
    worker yet, and treating that interval as idle would let a burst of concurrent requests all
    pass a concurrency check that each of them is about to violate.

    `exclude` drops one admission identity — the caller's own. `start_or_join` registers its
    admission marker before it can check anything (the marker is what makes identical callers wait
    instead of racing), so without this every start would count itself and a ceiling of N would
    admit only N-1. Deliberately an explicit identity rather than a blanket "minus one": a caller
    that legitimately holds another admission must still be counted for it.

    Only metered registries count. Internal follow-on work (cover art, affiliations, figure
    warming) is spawned by an already-admitted request, so counting it would let one legitimate
    turn exhaust the caller's own concurrency ceiling.
    """
    if not user_id:
        return 0
    total = 0
    cutoff = time.monotonic() - _STUCK_AFTER_SECONDS
    for reg in _ALL_REGISTRIES:
        if not reg.metered:
            continue
        with reg.lock:
            total += sum(
                1 for identity in reg._admitting
                if identity[0] == user_id and identity != exclude
            )
            total += sum(
                1 for job in reg.jobs.values()
                if _worker_is_active(job)
                and getattr(job, _USER_ATTR, None) == user_id
                and not _is_stuck(job, cutoff)
            )
    return total


def _is_stuck(job: Job, cutoff: float) -> bool:
    """Whether a live worker has run so long it should stop holding a concurrency slot.

    A job with no monotonic stamp (registered through `put`, or built by a test) is never treated
    as stuck — absence of evidence must not silently free a slot.
    """
    started = getattr(job, _STARTED_MONO_ATTR, None)
    return started is not None and started < cutoff


def request_cancellation_for_scopes(scopes: set[str | None]) -> int:
    """Cooperatively cancel every registry-managed worker in ``scopes``.

    Returns how many client-visible running jobs changed to ``cancelled``. Deadline-orphan
    adapters manage their own raw threads and publish a status-only liveness record; they cannot
    be cancelled here and remain visible to :func:`any_active_for_scopes` until they really exit.
    """
    cancelled: list[tuple[str, Job, str | None]] = []
    for reg in _ALL_REGISTRIES:
        with reg.lock:
            for job in reg.jobs.values():
                scope = getattr(job, _PID_ATTR, None)
                # Only JobRegistry-owned threads carry the marker. A status-only orphan has no
                # cooperative checkpoint to signal, and changing its status would hide its actual
                # liveness from deletion.
                if scope not in scopes or getattr(job, _WORKER_ACTIVE_ATTR, None) is not True:
                    continue
                # Once work has returned/committed its outcome, cancellation has lost the race.
                # The status deliberately remains running while the owned reservation settles.
                if getattr(job, _PENDING_OUTCOME_ATTR, None) is not None:
                    continue
                setattr(job, _CANCELLED_ATTR, True)
                if job.status == "running":
                    job.status = "cancelled"
                    cancelled.append((reg.name, job, scope))
    for name, job, scope in cancelled:
        log.info("cancel %s job=%s", name, job.id[:8], extra=_log_tag(scope))
    return len(cancelled)


def forget_inactive_for_scopes(scopes: set[str | None]) -> None:
    """Drop retained payloads in ``scopes`` without erasing any live-worker record."""
    for reg in _ALL_REGISTRIES:
        with reg.lock:
            stale = [
                job_id for job_id, job in reg.jobs.items()
                if (
                    getattr(job, _PID_ATTR, None) in scopes
                    and not _worker_is_active(job)
                )
            ]
            for job_id in stale:
                reg.jobs.pop(job_id, None)


def any_running_for_project(pid: str) -> str | None:
    """The name of the first registry with a live worker for ``pid``, else None.

    Used by projects.delete_project: a live worker resolves paths from the project id, so
    moving the directory mid-job would make the worker's next write silently recreate
    `projects/<pid>` and split its output from the trashed copy.

    This deliberately follows worker liveness rather than the client-visible status. Cooperative
    cancellation changes the status to ``cancelled`` immediately, but Python cannot kill the
    thread: it can still be unwinding an upstream call or running a settle callback. Deletion must
    wait for that actual work to leave the scope."""
    return any_active_for_scopes({pid})


def forget_finished_for_project(pid: str) -> None:
    """Drop terminal in-process jobs when a project is soft-deleted.

    Project ids can be reused after their directory moves to ``.trash``. Retaining an old
    proposal under that pid would expose it through the newly created project's latest-job
    endpoint, so deletion clears every terminal registry entry while its tombstone still blocks
    new admission. Callers must already have refused live workers.
    """
    forget_inactive_for_scopes({pid})


class JobRegistry(Generic[J]):
    """Owns a set of jobs of one kind. Thread-safe; one process (CLAUDE.md single-worker note)."""

    def __init__(self, name: str, *, max_finished: int | None = 20, metered: bool = False,
                 operation: str | None = None, reserves: bool | None = None):
        self.name = name
        # Whether starting a job here is a USER-INITIATED paid entry point, and therefore subject
        # to the per-account rate ceilings. Follow-on work a turn spawns internally (covers,
        # affiliations, figure warming, per-segment preview synthesis) is deliberately NOT metered:
        # it was authorized when its parent was admitted, and charging it again would let one
        # legitimate turn throttle the account that asked for it.
        self.metered = metered
        # The `usage.py` operation name this registry's work bills as, used to size the pessimistic
        # reservation held while a job runs. Defaults to the registry name, which already matches
        # for most; the ones that differ pass it explicitly.
        self.operation = operation or name
        # Whether work here must HOLD BUDGET, as opposed to counting against the per-account
        # concurrency ceiling. Usually the same answer, hence the default — but not always. A
        # registry whose jobs outlive the request that started them (listening cues, the canonical
        # warm chain) must reserve their own budget even though they are not an entry point a
        # reader queues directly: inheriting the caller's reservation is only safe while the
        # caller is still running, and these deliberately are not.
        self.reserves = metered if reserves is None else reserves
        self._jobs: dict[str, J] = {}   # job id -> job (also each job carries its dedup key)
        self._lock = threading.Lock()
        self._max_finished = max_finished
        self._settle_seq = 0
        # A durable admission callback may wait on Postgres. Never hold the registry lock across
        # that I/O: doing so would freeze polling/progress/cancellation for every user of this job
        # kind. The per-(scope,key) marker lets one caller prepare while identical callers wait and
        # later join its published job; unrelated keys continue normally.
        self._admitting: dict[
            tuple[str | None, str | None, str], _Admission
        ] = {}
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

        Threads can't be killed, so this marks the job cancelled immediately — the client's next
        poll sees `cancelled` — and sets a flag the worker checks via is_cancelled() at its own
        checkpoints (typically between paid upstream calls) to stop doing further work. The job's
        `finished_at` deliberately remains null until that worker exits and its spend reservation
        settles; terminal finalizers must use that field rather than treating the immediate Stop
        acknowledgement as accounting completion. Because `_running_for` only matches running
        jobs, the dedup key frees up right away; a stale worker that hasn't noticed yet only ever
        finishes writing shared idempotent caches.
        Returns the job (whatever its status — cancelling an already-finished job is a no-op),
        or None when the id is unknown/not owned by this project."""
        pid = _resolve_pid(project_id)
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None or getattr(job, _PID_ATTR, None) != pid:
                return None
            # Work that already returned has committed to its outcome and is only waiting for
            # reservation settlement. A Stop arriving in that gap must not turn persisted success
            # into cancellation, and must not publish a terminal status ahead of the ledger.
            outcome_pending = getattr(job, _PENDING_OUTCOME_ATTR, None) is not None
            if not outcome_pending:
                setattr(job, _CANCELLED_ATTR, True)
            was_running = job.status == "running" and not outcome_pending
            if was_running:
                job.status = "cancelled"
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
            if config.user_is_deleting(config.active_user_id()):
                raise RuntimeError("Account is being deleted; not accepting new jobs.")
            if pid is None and config.global_job_drain_active():
                raise RuntimeError(
                    "Account deletion is draining instance-wide work; not accepting global jobs.")
            if pid is not None and (
                config.project_is_deleting(pid) or config.project_is_busy(pid)
            ):
                raise RuntimeError(f"Project {pid} is being modified; not accepting new jobs.")
            setattr(job, _KEY_ATTR, key)
            setattr(job, _PID_ATTR, pid)
            # Ambient here, unlike start_or_join's captured value: `put` runs entirely on the
            # caller's request thread. It is stamped for attribution only — an already-terminal
            # cache hit spawned no worker, so it never counts toward the concurrency ceiling.
            setattr(job, _USER_ATTR, config.active_user_id())
            self._jobs[job.id] = job
            setattr(job, _FINALIZED_ATTR, True)
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
        prepare_new: Callable[[J], Callable[[], None] | None] | None = None,
        allow_busy: bool = False,
        metered: bool | None = None,
        reserves: bool | None = None,
        hold_max_nanousd: int | None = None,
    ) -> J:
        """Return the running job for (`project_id`, `key`), or create one via `factory()` and run
        `work(job)` in a daemon thread bound to that project. `project_id` defaults to the ambient
        active project (correct for request-scoped callers like chat/notes); a pid-keyed caller
        (graph/discovery) passes it explicitly so the worker binds the right project even if the
        ambient context is absent or different. When supplied, `admit` runs under the registry
        lock with the newest retained job for the same key and project; it may raise to reject
        registration atomically (proposal jobs use this to avoid hiding unapplied results).
        `prepare_new`, by contrast, runs exactly once only for a genuinely NEW job, outside the
        registry lock. It may durably reserve external resources and return a no-argument rollback
        callback for the narrow case where publication/thread start subsequently fails. Identical
        callers wait for that preparation and then join the published job; unrelated keys are not
        blocked by its database I/O.
        `allow_busy` is reserved for a caller that already owns the project's busy reservation
        and is admitting the follow-on job before releasing it; deletion tombstones still reject.
        `metered` overrides the registry's own flag for ONE call. It exists because metering is a
        property of the CALL SITE, not of the job kind: the chat and audio registries are each both
        a direct client entry point and the target of internal continuation work (a listening turn
        starts its own narration; auto-analyze starts a turn from inside the retrieval worker).
        Deciding per registry would charge a user's own turn against their concurrency ceiling —
        and because those calls happen inside a worker rather than a route, the refusal would be
        swallowed into an error string instead of surfacing as a 429. Continuations pass False.
        `work` populates the job's fields and returns; the registry then marks it done (or error,
        if `work` raised)."""
        pid = _resolve_pid(project_id)
        user_id = config.active_user_id()
        # The lifecycle lines carry the job's AUTHORITATIVE project (the resolved pid), passed
        # explicitly so they aren't mistagged by the emitting thread's ambient context — the
        # start/join lines run on the caller thread (which may have a different project bound, or
        # none for an app-global job), while done/error run on the worker thread.
        tag = _log_tag(pid)
        # User is part of the preparation identity even though live project ids are globally
        # unique today. That keeps the tenancy boundary structural for app-global work and for a
        # future storage layout where two accounts may both own a project called `default`.
        identity = (user_id, pid, key)

        # Only one caller prepares a given logical job. A waiter wakes after success OR failure,
        # then re-runs every gate and the feature-specific `admit` rule against current state.
        while True:
            with self._lock:
                self._check_registration_gates(
                    pid, user_id=user_id, allow_busy=allow_busy,
                )
                matching = [
                    job for job in self._jobs.values()
                    if getattr(job, _KEY_ATTR, None) == key
                    and getattr(job, _PID_ATTR, None) == pid
                ]
                if admit is not None:
                    admit(matching[-1] if matching else None)
                existing = self._running_for(key, pid)
                if existing:
                    log.debug(
                        "join %s job=%s key=%s", self.name, existing.id[:8], key, extra=tag,
                    )
                    return existing
                admission = self._admitting.get(identity)
                if admission is None:
                    admission = _Admission()
                    self._admitting[identity] = admission
                    break
            admission.event.wait()
            if admission.published is not None:
                published = admission.published
                log.debug(
                    "join %s job=%s key=%s",
                    self.name,
                    published.id[:8],
                    key,
                    extra=tag,
                )
                return published  # type: ignore[return-value] -- registry creates only J

        cleanup: Callable[[], None] | None = None
        held: spend_ceiling._Held | None = None
        owns_hold = False
        try:
            # Reached only by the caller that will genuinely CREATE a job — every joiner returned
            # above. So the ceiling counts real new spend, and a client polling a running job can
            # never rate-limit itself out of its own result.
            is_metered = self.metered if metered is None else metered
            # Rate limiting and budget are separate questions, and a continuation answers them
            # differently. It must NOT count against the concurrency ceiling — it was authorized
            # when its parent was admitted, and counting it lets one legitimate turn throttle the
            # account that asked for it. But money does not care who initiated the work: a
            # listening turn's narration is real TTS spend, and audio is the largest variable cost
            # in the app. Tying both to one flag left that spend entirely outside the ceiling.
            reserves_budget = self.reserves if reserves is None else reserves
            if is_metered:
                rate_limits.check_and_record(
                    user_id,
                    active_jobs=active_count_for_user(user_id, exclude=identity),
                )
            job = factory()
            if reserves_budget:
                # Held HERE rather than by each feature module's `prepare_new`, for the same
                # reason metering itself moved into the registry: a ceiling that depends on every
                # call site remembering is a ceiling with holes. Raises when the account cannot
                # afford the work, or when the ledger is unreachable — both fail closed.
                held = spend_ceiling.hold(
                    self.operation, job.id, maximum_nanousd=hold_max_nanousd,
                )
                owns_hold = True
            else:
                # This registry takes no reservation of its own — but it may be doing an admitted
                # job's work on its behalf. A graph build's per-paper extraction is the case that
                # matters: the build binds its reservation on the fan-out thread, then hands the
                # paper to the `paper-references` registry, whose worker runs on a THIRD thread
                # that inherits nothing. The spend landed there and was dropped, so every build
                # settled at $0 and the per-paper gating that bounds a build never fired.
                #
                # Inheriting the caller's reservation puts that spend back where it belongs. The
                # ownership flag is what keeps it safe: only the job that TOOK a hold may settle
                # or release it, or a short child job would finalize its parent's hold mid-build.
                held = spend_ceiling.active()
            if prepare_new is not None:
                cleanup = prepare_new(job)
        except BaseException:
            if owns_hold:
                spend_ceiling.release(held)
            self._finish_admission(identity, admission)
            raise

        try:
            thread = threading.Thread(
                target=self._run,
                args=(job, work, pid, user_id, held, owns_hold),
                daemon=True,
                name=f"{self.name}-{job.id[:8]}",
            )
            with self._lock:
                # Deletion/project-split state may have changed while durable admission ran. This
                # second check is load-bearing: no worker was published for the deletion sweep to
                # observe during that interval.
                self._check_registration_gates(
                    pid, user_id=user_id, allow_busy=allow_busy,
                )
                # Nothing else can publish this exact identity while its admission marker exists.
                # A feature may still have used `put` directly, but that is terminal cache state,
                # not a running job to join and not a reason to discard newly authorized work.
                setattr(job, _KEY_ATTR, key)
                setattr(job, _PID_ATTR, pid)
                setattr(job, _USER_ATTR, user_id)
                # Set before publishing the job in the registry. A deletion sweep that wins after
                # this point must see the scope as active even if the new thread has not entered
                # _run yet.
                setattr(job, _WORKER_ACTIVE_ATTR, True)
                setattr(job, _STARTED_MONO_ATTR, time.monotonic())
                self._jobs[job.id] = job
                self._prune()
                try:
                    # Starting while holding the registry lock is deliberately brief and closes a
                    # subtle join race: the worker cannot settle before admission waiters are
                    # released, so every concurrent identical caller observes and joins this job.
                    thread.start()
                except BaseException:
                    # No waiter can have observed the job: its admission event is still unset and
                    # direct readers are blocked on this lock. Remove it instead of retaining a
                    # terminal object for work that never existed.
                    self._jobs.pop(job.id, None)
                    setattr(job, _WORKER_ACTIVE_ATTR, False)
                    raise
                # This caller owns the identity until it signals completion; no other path can
                # replace the marker while the event is unset.
                admission.published = job
                self._admitting.pop(identity, None)
                admission.event.set()
        except BaseException:
            self._rollback_preparation(cleanup)
            if owns_hold:
                spend_ceiling.release(held)
            self._finish_admission(identity, admission)
            raise
        log.info("start %s job=%s key=%s", self.name, job.id[:8], key, extra=tag)
        return job

    def _finish_admission(
        self,
        identity: tuple[str | None, str | None, str],
        admission: _Admission,
    ) -> None:
        """Publish completion of one outside-lock admission attempt to its waiters."""
        with self._lock:
            if self._admitting.get(identity) is admission:
                self._admitting.pop(identity, None)
                admission.event.set()

    def _rollback_preparation(self, cleanup: Callable[[], None] | None) -> None:
        """Best-effort rollback without hiding the publication/start failure that caused it.

        A quota rollback can itself encounter a database outage. Its durable lease remains safe
        for the reconciler to expire later; replacing the original exception with cleanup's error
        would make the actual admission failure impossible to diagnose.
        """
        if cleanup is None:
            return
        try:
            cleanup()
        except Exception as exc:  # noqa: BLE001 — cleanup is explicitly best effort
            log.warning(
                "job admission rollback failed kind=%s error=%s",
                self.name,
                type(exc).__name__,
            )

    @staticmethod
    def _check_registration_gates(
        pid: str | None,
        *,
        user_id: str | None,
        allow_busy: bool,
    ) -> None:
        """The deletion/split gates shared by both sides of outside-lock preparation."""
        # Atomic with the account-deletion sweep at each call site because callers hold the
        # registry lock. Either publication wins and the sweep sees it, or the deletion flag wins
        # and publication is refused.
        if config.user_is_deleting(user_id):
            raise RuntimeError("Account is being deleted; not accepting new jobs.")
        if pid is None and config.global_job_drain_active():
            raise RuntimeError(
                "Account deletion is draining instance-wide work; not accepting global jobs."
            )
        if pid is not None and (
            config.project_is_deleting(pid)
            or (config.project_is_busy(pid) and not allow_busy)
        ):
            raise RuntimeError(f"Project {pid} is being modified; not accepting new jobs.")

    def add_settle_callback(self, job: J, cb: Callable[[J], None]) -> bool:
        """Register cb(job) to run on the worker thread immediately after reservation settlement
        and terminal publication, while the project remains bound.

        Returns False if the worker has ALREADY finalized. Cancellation is client-visible before
        finalization, so status alone is not the gate: a callback attached to a cancelled but
        unwinding worker must still wait for its spend to settle. The callbacks are read in the
        same critical section that publishes ``finished_at``, leaving no attachment window.
        """
        with self._lock:
            if getattr(job, _FINALIZED_ATTR, False):
                return False
            cbs = getattr(job, _ON_SETTLE_ATTR, None)
            if cbs is None:
                cbs = []
                setattr(job, _ON_SETTLE_ATTR, cbs)
            cbs.append(cb)
            return True

    def set_outcome_locked(self, job: J, status: str, *, error: str | None = None) -> None:
        """Commit a worker outcome without publishing it before reservation settlement.

        The caller MUST hold :attr:`lock`. This is for workers whose result persistence must be
        atomic with winning a completion-vs-cancellation race (Discovery), or whose generator
        reports a job-level error as data (Graph). Ordinary workers simply return or raise.
        """
        if status not in {"done", "error"}:
            raise ValueError(f"invalid worker outcome: {status}")
        setattr(job, _PENDING_OUTCOME_ATTR, status)
        if error is not None:
            job.error = error

    def _fire_settle(self, job: J, cbs: list, tag: dict) -> None:
        for cb in cbs:
            try:
                cb(job)
            except Exception as e:  # noqa: BLE001 — a settle callback must not kill the thread
                log.warning("settle callback failed %s job=%s: %s", self.name, job.id[:8],
                            str(e)[:200], extra=tag)

    def _run(self, job: J, work: Callable[[J], None], pid: str | None,
             user_id: str | None = None, held=None, owns_hold: bool = False) -> None:
        token = config.set_active_project(pid)
        user_token = config.set_active_user(user_id)
        # Bound like the project and the user, and for the same reason: the spend happens deep
        # inside llm/tts/nested workers, and a thread inherits none of this.
        held_token = spend_ceiling.bind(held)
        tag = _log_tag(pid)
        t0 = time.monotonic()
        failure: Exception | None = None
        settlement_attempted = False
        try:
            try:
                work(job)
            except Exception as exc:  # noqa: BLE001 — every worker failure becomes job state
                failure = exc

            # Commit the worker's outcome under the same lock cancellation uses, but keep normal
            # completion/error private while the reservation settles. Once this marker exists a
            # Stop has lost the race: the work and its persisted side effects are complete.
            with self._lock:
                if job.status == "cancelled":
                    outcome = "cancelled"
                elif failure is not None:
                    outcome = "error"
                else:
                    outcome = getattr(job, _PENDING_OUTCOME_ATTR, None)
                    if outcome is None:
                        # Compatibility for a worker that assigned status directly. Shared workers
                        # should use set_outcome_locked so polling cannot observe this early.
                        outcome = job.status if job.status != "running" else "done"
                setattr(job, _PENDING_OUTCOME_ATTR, outcome)
                if job.status != "cancelled":
                    # Hide a directly assigned worker outcome during the settlement window.
                    job.status = "running"
                    job.finished_at = None

            # Settlement is part of finalization, not worker cleanup. Publishing done/error first
            # lets a client invalidate `/api/plan` against a ledger that still contains the hold or
            # lacks the just-incurred spend. Cancellation remains immediately visible, but its
            # `finished_at` stays null and settle callbacks remain queued until this attempt ends.
            if owns_hold:
                settlement_attempted = True
                try:
                    spend_ceiling.settle(held)
                except Exception as exc:  # noqa: BLE001 — settle itself is best-effort by contract
                    # `spend_ceiling.settle` currently swallows and logs ledger failures. Keep the
                    # registry fail-safe if an injected adapter violates that contract: the
                    # settlement was attempted, and hiding a persisted result forever is worse.
                    log.error(
                        "reservation settle escaped kind=%s job=%s error=%s",
                        self.name,
                        job.id[:8],
                        type(exc).__name__,
                        extra=tag,
                    )

            with self._lock:
                final = getattr(job, _PENDING_OUTCOME_ATTR)
                if job.status != "cancelled":
                    job.status = final
                if failure is not None and job.status != "cancelled":
                    job.error = str(failure)[:400]
                job.finished_at = now_iso()
                self._stamp_settled(job)
                setattr(job, _FINALIZED_ATTR, True)
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
        finally:
            # Preserve the old fail-safe for a BaseException or an internal finalization failure:
            # even if no client-visible outcome can be published, an owned reservation must not
            # remain stranded until lease expiry. Keep the worker active during this last attempt.
            if owns_hold and not settlement_attempted:
                try:
                    spend_ceiling.settle(held)
                except Exception as exc:  # noqa: BLE001 — same adapter boundary as above
                    log.error(
                        "reservation fallback settle escaped kind=%s job=%s error=%s",
                        self.name,
                        job.id[:8],
                        type(exc).__name__,
                        extra=tag,
                    )
            # Last action while this worker is still logically inside the registry. Settle
            # callbacks above can touch the project or admit follow-on work, so a deletion sweep
            # must continue to see the worker until they have returned too.
            with self._lock:
                setattr(job, _WORKER_ACTIVE_ATTR, False)
                self._prune()
            spend_ceiling.reset(held_token)
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
            # A cancelled job is terminal to the client but its worker may still be unwinding.
            # Never prune the only liveness record before deletion has a chance to observe it.
            if not _worker_is_active(job):
                by_scope.setdefault(getattr(job, _PID_ATTR, None), []).append(job)

        # By settle tick here too, for exactly the reason it is used for scopes below. Ordering a
        # scope's own history by `started_at` has the same victim: a notes proposal that ran for an
        # hour while twenty quick ones came and went started earliest, so it is dropped the moment it
        # settles — by its own completion, inside its own scope, where no other user is involved.
        # Leaving this on `started_at` was a deliberate call in the previous round and it was wrong.
        for finished in by_scope.values():
            excess = len(finished) - self._max_finished
            if excess <= 0:
                continue
            oldest = sorted(finished, key=lambda j: getattr(j, _SETTLE_SEQ_ATTR, 0))
            for stale in oldest[:excess]:
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


def run_parallel(items: list, fn: Callable, *, max_workers: int,
                 thread_name_prefix: str = "fan") -> list:
    """Run `fn(item)` over `items` concurrently and return results in the ORIGINAL order.

    Two properties this exists to guarantee, both of which are easy to lose when a caller reaches
    for `ThreadPoolExecutor` directly:

    **Contextvars are rebound on every worker (invariant 2).** A pool thread inherits nothing, so
    without this a parallelised stage would attribute its token spend to no project at all, and any
    per-user setting would silently fall back to the instance default. The project and user are
    captured on the CALLING thread, where they are correctly bound.

    **One failure does not lose the others.** An exception is returned in place of a result rather
    than propagated, so a caller that is already best-effort — every discovery stage is — can count
    the failures without a single bad item discarding the work that succeeded.

    The pool is not used as a context manager: `__exit__` is `shutdown(wait=True)`, which on an
    abandoned generator would block until every in-flight call finished (same reasoning as
    `graph.build`'s fan-out).
    """
    if not items:
        return []
    if max_workers <= 1 or len(items) == 1:
        return [_call_capturing(fn, item) for item in items]

    pid = config.active_project_id()
    user_id = config.active_user_id()
    # The parent's reservation travels with the fan-out too. A pool thread is not a separate
    # admission — it is the SAME job doing its work in parallel — so its spend belongs to the
    # reservation already held. Dropping it meant the whole of graph extraction and every parallel
    # discovery stage accumulated nothing, and those jobs settled at ~$0 no matter what they cost.
    held = spend_ceiling.active()

    def bound(item):
        token = config.set_active_project(pid)
        user_token = config.set_active_user(user_id)
        held_token = spend_ceiling.bind(held)
        try:
            return _call_capturing(fn, item)
        finally:
            spend_ceiling.reset(held_token)
            config.reset_active_project(token)
            config.reset_active_user(user_token)

    pool = concurrent.futures.ThreadPoolExecutor(
        max_workers=min(max_workers, len(items)), thread_name_prefix=thread_name_prefix)
    try:
        return list(pool.map(bound, items))
    finally:
        pool.shutdown(wait=False)


def _call_capturing(fn: Callable, item):
    try:
        return fn(item)
    except Exception as e:  # noqa: BLE001 — returned to the caller, which decides what it means
        return e
