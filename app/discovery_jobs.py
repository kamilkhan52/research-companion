"""Background discovery runs (goals -> suggested readings), on the shared JobRegistry.

A run makes two LLM calls plus paced arXiv, Semantic Scholar, and OpenAlex work, so it routinely
takes minutes — the same territory where a request-tied design
gets killed by the tunnel (see app/jobs.py and CLAUDE.md invariant 1). One job per composite
user+project scope runs in a background thread decoupled from any connection; clients POLL a
cheap snapshot endpoint. The finished result is
persisted to the project's .state/discovery.json
inside the worker, before the job is marked done (the registry's persist-before-done ordering),
so a client that sees "done" and reads the file always finds it.
"""
from __future__ import annotations

from collections.abc import Callable, Iterator
from dataclasses import dataclass, field

from . import config, discovery
from .jobs import Job, JobRegistry, new_id, now_iso

RunFn = Callable[..., "Iterator[dict]"]


@dataclass
class DiscoveryJob(Job):
    # queries | searching | library | gated | triage | citations | scoring | evidence | done
    phase: str = "queries"
    goals: str = ""
    focus: str = ""
    queries: list = field(default_factory=list)
    searched: int = 0         # arXiv queries completed / planned
    total_queries: int = 0
    found: int = 0            # unique candidates so far
    library: int = 0          # papers on the reading list the grounded channels start from
    gathered: int = 0         # unique candidates after every recall channel is merged
    screened: int = 0         # survivors of the current funnel stage
    # A few good finds, refreshed as the funnel narrows. The first batch is chosen on provenance
    # alone (no model involved) so the screen has something real to show seconds in rather than
    # spinning for minutes — see discovery._preview.
    finds: list = field(default_factory=list)
    finds_stage: str = ""     # "grounded" (provisional) | "ranked"
    result: dict | None = None

    def to_dict(self) -> dict:
        d = super().to_dict()
        d.pop("id", None)     # unique attempt id is server-internal; polling is scope-keyed
        return d


# Every attempt has a unique id, so an immediate retry cannot overwrite the liveness record of a
# cancelled worker that is still unwinding. Dedup is separately keyed by the composite user+project
# scope below. Three terminal attempts per project are ample for polling/retry diagnosis; the
# completed recommendation payload itself is persisted on disk.
_registry: JobRegistry[DiscoveryJob] = JobRegistry("discover", max_finished=3)
_jobs = _registry.jobs


def _job_key(pid: str) -> str:
    """Pseudonymous composite dedup key: two users may both have a project named ``default``.

    ``user_scope_key`` is already a stable hash rather than PII, and ``single`` preserves the
    legacy unauthenticated/single-tenant scope. The raw project id is safe and useful in logs.
    """
    return f"{config.user_scope_key() or 'single'}:{pid}"


def get_job(pid: str) -> DiscoveryJob | None:
    key = _job_key(pid)
    return (
        _registry.active_for(key, project_id=pid)
        or _registry.latest_for(key, project_id=pid)
    )


def snapshot(pid: str) -> dict | None:
    job = get_job(pid)
    return _registry.snapshot(job.id, project_id=pid) if job else None


def cancel_discovery(pid: str) -> DiscoveryJob | None:
    """Request cooperative cancellation of this project's current run.

    The active attempt is selected through the composite user+project key, and
    ``JobRegistry.cancel`` still receives the explicit project scope: cancellation must be subject
    to the same ownership boundary as polling. The worker checks the terminal status between
    generator events, which are the pipeline's paid/provider boundaries. A call already in flight
    cannot be killed, but no later stage is started.
    """
    job = get_job(pid)
    return _registry.cancel(job.id, project_id=pid) if job else None


def start_discovery(pid: str, goals: str, run_fn: RunFn = discovery.run_discovery,
                    **run_kwargs) -> DiscoveryJob:
    """Start a run for `pid` in a background thread, or join the one already running for it.
    run_fn/run_kwargs are injectable so tests drive a real thread end-to-end with zero network."""
    def work(job: DiscoveryJob) -> None:
        # The generator also checks this callback immediately after every yielded progress event.
        # Checking only in this driver is too late: ``next(events)`` executes the next provider
        # stage before returning an event for the driver to inspect.
        events = iter(run_fn(
            job.goals,
            **run_kwargs,
            should_cancel=lambda: _registry.is_cancelled(job),
        ))
        try:
            for event in events:
                # Cancellation and event application serialize on the registry lock. In
                # particular, the final save is inside this critical section: either Stop wins
                # first and the old complete result remains untouched, or completion persists and
                # applies before Stop can observe the job. There is no cancelled-but-overwritten
                # middle state.
                with _registry.lock:
                    if job.status != "running":
                        break
                    if event["type"] == "done":
                        # Persist before the registry flips status to done, so a client that sees
                        # "done" and reads load_result() always finds the file.
                        discovery.save_result(event["result"])
                    _apply_event(job, event)
                    if event["type"] == "done":
                        # Completion and cancellation share this lock. Marking done here closes
                        # the otherwise tiny window in which Stop could arrive after persistence
                        # but before JobRegistry._run settled the worker, producing a cancelled
                        # snapshot even though a complete result had already replaced the old one.
                        job.status = "done"
                        job.finished_at = now_iso()
        finally:
            # A generator can own provider clients or a bounded parallel frontier. Closing it on
            # cancellation releases those resources immediately after the current event boundary
            # instead of waiting for garbage collection.
            close = getattr(events, "close", None)
            if close is not None:
                close()

    # Pass project_id explicitly (not the ambient default): the worker must bind THIS pid's
    # project even if a caller's ambient context is absent or different (scheduler/test/batch).
    return _registry.start_or_join(
        _job_key(pid), lambda: DiscoveryJob(id=new_id(), goals=goals), work, project_id=pid)


def _apply_event(job: DiscoveryJob, event: dict) -> None:
    etype = event["type"]
    if etype == "queries":
        job.phase = "searching"
        job.focus = event.get("focus", "")
        job.queries = event.get("queries", [])
        job.total_queries = len(job.queries)
    elif etype == "search":
        job.searched = event["index"]
        job.total_queries = event["total"]
        job.found = event["found"]
    elif etype == "library":
        job.phase = "library"
        job.library = event.get("papers", 0)
    elif etype == "gathered":
        job.phase = "gathered"
        job.gathered = event.get("count", 0)
        job.found = job.gathered
    elif etype == "gated":
        job.phase = "gated"
        job.screened = event.get("kept", 0)
    elif etype == "finds":
        # Not a phase: finds arrive DURING a phase and must not advance the timeline.
        job.finds = event.get("items") or []
        job.finds_stage = event.get("stage", "")
    elif etype == "triage":
        job.phase = "triage"
        job.screened = event.get("count", job.screened)
    elif etype == "citations":
        job.phase = "citations"
        job.found = event.get("count", job.found)
    elif etype == "evidence":
        job.phase = "evidence"
    elif etype == "scoring":
        job.phase = "scoring"
    elif etype == "done":
        # status/finished_at are set by the registry once work() returns.
        job.phase = "done"
        job.result = event["result"]
