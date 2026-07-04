"""Shared background-job machinery.

Every long or LLM-touching operation runs as an in-process background job the client polls,
not a blocking request (CLAUDE.md invariant 1). Five feature modules (chat, audio, notes,
graph, discovery) each hand-rolled the same scaffolding: a `dict` of jobs + a `Lock`, finished-
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
import uuid
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Generic, TypeVar

from . import config


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def new_id() -> str:
    return uuid.uuid4().hex


@dataclass
class Job:
    """Base for every job payload. Subclasses add their own progress/result fields. `status` is
    the only lifecycle signal clients need: running -> done | error."""
    id: str
    status: str = "running"          # running | done | error
    error: str | None = None
    started_at: str = field(default_factory=now_iso)
    finished_at: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


J = TypeVar("J", bound=Job)

# The dedup key is stashed on the job instance under this attribute (not a dataclass field, so it
# never leaks into to_dict()). Keeping it on the job means the registry's single _jobs dict is the
# whole of its state — clearing it (as tests do) is a complete reset.
_KEY_ATTR = "_rc_dedup_key"


class JobRegistry(Generic[J]):
    """Owns a set of jobs of one kind. Thread-safe; one process (CLAUDE.md single-worker note)."""

    def __init__(self, name: str, *, max_finished: int | None = 20):
        self.name = name
        self._jobs: dict[str, J] = {}   # job id -> job (also each job carries its dedup key)
        self._lock = threading.Lock()
        self._max_finished = max_finished

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

    def get(self, job_id: str) -> J | None:
        with self._lock:
            return self._jobs.get(job_id)

    def snapshot(self, job_id: str) -> dict | None:
        """A poll-safe serialized copy, taken under the lock so the worker can't be mid-mutation."""
        with self._lock:
            job = self._jobs.get(job_id)
            return job.to_dict() if job else None

    def active_for(self, key: str) -> J | None:
        """The running job for a dedup key, if any — how a client that navigated away reattaches."""
        with self._lock:
            return self._running_for(key)

    def _running_for(self, key: str) -> J | None:  # caller holds the lock
        for job in self._jobs.values():
            if getattr(job, _KEY_ATTR, None) == key and job.status == "running":
                return job
        return None

    def put(self, key: str, job: J) -> J:
        """Register an already-terminal job (e.g. a result served straight from cache) with no
        worker thread. Returns it."""
        with self._lock:
            setattr(job, _KEY_ATTR, key)
            self._jobs[job.id] = job
            self._prune()
        return job

    def start_or_join(self, key: str, factory: Callable[[], J], work: Callable[[J], None]) -> J:
        """Return the running job for `key`, or create one via `factory()` and run `work(job)` in
        a daemon thread. The thread rebinds whatever project is active *now* (captured here, since
        threads don't inherit it). `work` populates the job's fields and returns; the registry
        then marks it done (or error, if `work` raised)."""
        pid = config.active_project_id()
        with self._lock:
            existing = self._running_for(key)
            if existing:
                return existing
            job = factory()
            setattr(job, _KEY_ATTR, key)
            self._jobs[job.id] = job
            self._prune()
        thread = threading.Thread(target=self._run, args=(job, work, pid),
                                  daemon=True, name=f"{self.name}-{job.id[:8]}")
        thread.start()
        return job

    def _run(self, job: J, work: Callable[[J], None], pid: str | None) -> None:
        token = config.set_active_project(pid)
        try:
            work(job)
            with self._lock:
                if job.status == "running":   # worker didn't set a terminal status itself
                    job.status = "done"
                    job.finished_at = now_iso()
        except Exception as e:
            with self._lock:
                job.status = "error"
                job.error = str(e)[:400]
                job.finished_at = now_iso()
        finally:
            config.reset_active_project(token)

    def _prune(self) -> None:  # caller holds the lock
        """Drop the oldest finished jobs past the cap, so a long-lived process doesn't accumulate
        them forever. max_finished=None keeps everything (used by the pid-keyed registries, which
        hold at most one job per project)."""
        if self._max_finished is None:
            return
        finished = [j for j in self._jobs.values() if j.status != "running"]
        if len(finished) > self._max_finished:
            for stale in sorted(finished, key=lambda j: j.started_at)[:len(finished) - self._max_finished]:
                self._jobs.pop(stale.id, None)
