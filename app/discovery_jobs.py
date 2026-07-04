"""In-process background jobs for discovery runs (goals -> suggested readings).

A run makes two LLM calls and 4-6 paced arXiv searches (~3s apart each, plus a Semantic
Scholar batch), so it routinely takes minutes — the same territory where a request-tied
design gets killed by the tunnel (see app/graph_jobs.py for the full war story). Identical
pattern: one job per project at a time, run in a background thread decoupled from any
connection, clients POLL a cheap snapshot endpoint. The finished result is persisted to the
project's .state/discovery.json the moment it exists, whether or not anyone is polling.
"""
from __future__ import annotations

import threading
from collections.abc import Callable, Iterator
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime

from . import config, discovery


@dataclass
class DiscoveryJob:
    pid: str
    status: str = "running"   # running | done | error
    phase: str = "queries"    # queries | searching | citations | scoring | done
    goals: str = ""
    focus: str = ""
    queries: list = field(default_factory=list)
    searched: int = 0         # arXiv queries completed / planned
    total_queries: int = 0
    found: int = 0            # unique candidates so far
    result: dict | None = None
    error: str | None = None
    started_at: str = ""
    finished_at: str | None = None

    def to_dict(self) -> dict:
        d = asdict(self)
        d.pop("pid", None)
        return d


RunFn = Callable[..., "Iterator[dict]"]

_jobs: dict[str, DiscoveryJob] = {}
_lock = threading.Lock()


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def get_job(pid: str) -> DiscoveryJob | None:
    with _lock:
        return _jobs.get(pid)


def snapshot(pid: str) -> dict | None:
    """Poll-safe copy, serialized under the lock so the runner thread can't be mutating
    fields while the API layer reads them."""
    with _lock:
        job = _jobs.get(pid)
        return job.to_dict() if job else None


def start_discovery(pid: str, goals: str, run_fn: RunFn = discovery.run_discovery,
                    **run_kwargs) -> DiscoveryJob:
    """Start a run for `pid` in a background thread, or join the one already running for it
    (same contract as graph_jobs.start_build). run_fn/run_kwargs are injectable so tests
    drive a real thread end-to-end with zero network calls."""
    with _lock:
        existing = _jobs.get(pid)
        if existing and existing.status == "running":
            return existing
        job = DiscoveryJob(pid=pid, goals=goals, started_at=_now())
        _jobs[pid] = job

    thread = threading.Thread(target=_run, args=(job, run_fn), kwargs=run_kwargs,
                              daemon=True, name=f"discover-{pid}")
    thread.start()
    return job


def _run(job: DiscoveryJob, run_fn: RunFn, **run_kwargs) -> None:
    # Fresh contextvar bind: threads don't inherit the request's active project, and both
    # discovery.save_result and any store access resolve paths through it.
    token = config.set_active_project(job.pid)
    try:
        for event in run_fn(job.goals, **run_kwargs):
            with _lock:
                _apply_event(job, event)
        if job.result is not None:
            discovery.save_result(job.result)
    except Exception as e:  # DiscoveryError and anything unexpected end the run the same way
        with _lock:
            job.status = "error"
            job.error = str(e)[:400]
            job.finished_at = _now()
    finally:
        config.reset_active_project(token)


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
    elif etype == "citations":
        job.phase = "citations"
        job.found = event.get("count", job.found)
    elif etype == "scoring":
        job.phase = "scoring"
    elif etype == "done":
        job.status = "done"
        job.phase = "done"
        job.result = event["result"]
        job.finished_at = _now()
