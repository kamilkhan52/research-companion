"""In-process background jobs for reference-graph builds.

A build can run for a long time across many papers (minutes per paper, tens of papers per
project). The original design tied the *entire* build's execution to one open HTTP SSE
connection: the generator in app/graph.py only advanced when something called next() on it,
which only happened while a client was actively consuming the StreamingResponse. The moment
that connection died — a mobile app backgrounded (OS suspends the fetch), a network blip, the
tab closing — the generator was silently orphaned mid-loop: whatever paper was in flight might
finish and save (server-side extraction itself doesn't depend on the HTTP layer), but nothing
ever called next() again, so the loop never reached its final step (computing/saving the graph
and recommendations) and the whole build looked like it "vanished" with no visible progress or
result. Confirmed live: a real build reached 6/18 papers then stopped completely, ~2.5 hours
after the driving connection went away, with graph_store still reporting no graph at all.

This module fixes that by running the build in a real background thread, decoupled from any
particular request. Clients POLL for status instead of holding a connection open — polling is
trivially robust to being backgrounded/reconnected/killed-and-relaunched, since each poll is an
independent, short-lived request against server-side state that survives regardless of what
any client is doing.
"""
from __future__ import annotations

import threading
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime

from . import config, graph, sessions, store


@dataclass
class BuildJob:
    pid: str
    status: str = "running"  # running | done | error
    total: int = 0
    done: int = 0
    current_slug: str | None = None
    current_title: str | None = None
    per_paper: dict = field(default_factory=dict)  # slug -> {status, cached, error}
    graph: dict | None = None
    recommendations: list | None = None
    error: str | None = None
    started_at: str = ""
    finished_at: str | None = None

    def to_dict(self) -> dict:
        d = asdict(self)
        d.pop("pid", None)
        return d


_jobs: dict[str, BuildJob] = {}
_lock = threading.Lock()


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def get_job(pid: str) -> BuildJob | None:
    with _lock:
        return _jobs.get(pid)


def is_running(pid: str) -> bool:
    job = get_job(pid)
    return job is not None and job.status == "running"


def start_build(pid: str, force: bool = False,
                extract_fn: graph.ExtractFn = graph.extract_references_for_paper) -> BuildJob:
    """Start a build for `pid` in a background thread unless one is already running for it;
    either way, returns the (new or already-in-flight) job so callers can just read its status
    without needing to branch on whether they started it or joined an existing one.

    extract_fn is injectable (mirroring graph.build_graph's own parameter) so tests can drive
    a real background thread end-to-end without any network calls."""
    with _lock:
        existing = _jobs.get(pid)
        if existing and existing.status == "running":
            return existing
        job = BuildJob(pid=pid, started_at=_now())
        _jobs[pid] = job

    thread = threading.Thread(target=_run, args=(job, force, extract_fn), daemon=True,
                              name=f"graph-build-{pid}")
    thread.start()
    return job


def _run(job: BuildJob, force: bool, extract_fn: graph.ExtractFn) -> None:
    # threading.Thread does NOT inherit the spawning request's contextvars, so the
    # active-project context has to be set fresh in this thread before touching store/graph,
    # both of which resolve file paths via config.project_dir() -> the active-project
    # contextvar. Getting this wrong would silently read/write the wrong project's data.
    token = config.set_active_project(job.pid)
    try:
        papers = store.list_papers(sessions.session_states())
        for event in graph.build_graph(papers, force=force, extract_fn=extract_fn):
            with _lock:
                _apply_event(job, event)
    except Exception as e:  # defensive outer boundary; per-paper failures are already caught
        with _lock:
            job.status = "error"
            job.error = str(e)[:400]
            job.finished_at = _now()
    finally:
        config.reset_active_project(token)


def _apply_event(job: BuildJob, event: dict) -> None:
    etype = event["type"]
    if etype == "start":
        job.total = event["total"]
    elif etype == "extracting":
        job.current_slug = event["slug"]
        job.current_title = event["title"]
        job.per_paper[event["slug"]] = {"status": "extracting", "error": None}
    elif etype == "progress":
        job.done = event["done"]
        job.per_paper[event["slug"]] = {
            "status": "cached" if event["cached"] else event["status"],
            "error": event.get("error"),
        }
    elif etype == "done":
        job.status = "done"
        job.graph = event["graph"]
        job.recommendations = event["recommendations"]
        job.finished_at = _now()
        job.current_slug = None
        job.current_title = None
    elif etype == "error":
        job.status = "error"
        job.error = event["detail"]
        job.finished_at = _now()
