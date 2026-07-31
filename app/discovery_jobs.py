"""Background discovery runs (goals -> suggested readings), on the shared JobRegistry.

A run makes two LLM calls plus paced arXiv, Semantic Scholar, and OpenAlex work, so it routinely
takes minutes — the same territory where a request-tied design
gets killed by the tunnel (see app/jobs.py and CLAUDE.md invariant 1). One job per project at a
time (keyed by pid), run in a background thread decoupled from any connection; clients POLL a
cheap snapshot endpoint. The finished result is persisted to the project's .state/discovery.json
inside the worker, before the job is marked done (the registry's persist-before-done ordering),
so a client that sees "done" and reads the file always finds it.
"""
from __future__ import annotations

from collections.abc import Callable, Iterator
from dataclasses import dataclass, field

from . import discovery
from .jobs import Job, JobRegistry

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
        d.pop("id", None)     # id == pid, server-internal for this pid-keyed job
        return d


# Keyed by pid, at most one job per project — no pruning (max_finished=None). `_jobs` aliases the
# registry's dict so tests can clear() it to reset.
_registry: JobRegistry[DiscoveryJob] = JobRegistry("discover", max_finished=None)
_jobs = _registry.jobs


def get_job(pid: str) -> DiscoveryJob | None:
    return _registry.get(pid, project_id=pid)


def snapshot(pid: str) -> dict | None:
    return _registry.snapshot(pid, project_id=pid)


def start_discovery(pid: str, goals: str, run_fn: RunFn = discovery.run_discovery,
                    **run_kwargs) -> DiscoveryJob:
    """Start a run for `pid` in a background thread, or join the one already running for it.
    run_fn/run_kwargs are injectable so tests drive a real thread end-to-end with zero network."""
    def work(job: DiscoveryJob) -> None:
        for event in run_fn(job.goals, **run_kwargs):
            if event["type"] == "done":
                # Persist before the registry flips status to done, so a client that sees "done"
                # and reads load_result() always finds the file.
                discovery.save_result(event["result"])
            with _registry.lock:
                _apply_event(job, event)

    # Pass project_id explicitly (not the ambient default): the worker must bind THIS pid's
    # project even if a caller's ambient context is absent or different (scheduler/test/batch).
    return _registry.start_or_join(pid, lambda: DiscoveryJob(id=pid, goals=goals), work,
                                   project_id=pid)


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
