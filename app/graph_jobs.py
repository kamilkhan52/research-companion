"""Background reference-graph builds, on the shared JobRegistry.

A build can run for a long time across many papers (minutes per paper, tens of papers per
project). The original design tied the *entire* build's execution to one open HTTP SSE
connection: the generator in app/graph.py only advanced while a client was actively consuming
the StreamingResponse, so the moment that connection died (mobile app backgrounded, network
blip, tab closing) the generator was silently orphaned mid-loop and the build "vanished" with
no result. Confirmed live: a real build reached 6/18 papers then stopped completely ~2.5 hours
after the driving connection went away, with graph_store still reporting no graph.

Running the build as a background job keyed by pid (see app/jobs.py, CLAUDE.md invariant 1)
fixes that: clients POLL for status instead of holding a connection open, which is trivially
robust to being backgrounded/reconnected/killed-and-relaunched.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from . import graph, sessions, store
from .jobs import Job, JobRegistry, now_iso


@dataclass
class BuildJob(Job):
    total: int = 0
    ready: int = 0
    done: int = 0
    current_slug: str | None = None
    current_title: str | None = None
    per_paper: dict = field(default_factory=dict)  # slug -> {status, cached, error}
    retrieval_candidates: dict = field(default_factory=dict)  # slug -> confirmation candidates
    graph: dict | None = None
    recommendations: list | None = None

    def to_dict(self) -> dict:
        d = super().to_dict()
        d.pop("id", None)     # id == pid, server-internal for this pid-keyed job
        return d


# Keyed by pid, at most one build per project — no pruning. `_jobs` aliases the registry's dict
# so tests can clear() it to reset.
_registry: JobRegistry[BuildJob] = JobRegistry("graph-build", max_finished=None)
_jobs = _registry.jobs


def get_job(pid: str) -> BuildJob | None:
    return _registry.get(pid, project_id=pid)


def is_running(pid: str) -> bool:
    job = get_job(pid)
    return job is not None and job.status == "running"


def start_build(pid: str, force: bool = False,
                extract_fn: graph.ExtractFn = graph.extract_references_for_paper,
                metadata_fn: graph.MetadataFn | None = None,
                retrieval_fn: graph.RetrievalFn | None = None,
                retrieval_sources: dict[str, str] | None = None) -> BuildJob:
    """Start a build for `pid` in a background thread unless one is already running for it;
    either way returns the (new or in-flight) job. extract_fn is injectable (mirroring
    graph.build_graph) so tests drive a real background thread with no network calls."""
    def work(job: BuildJob) -> None:
        papers = store.list_papers(sessions.session_states())
        for event in graph.build_graph(
            papers, force=force, extract_fn=extract_fn, metadata_fn=metadata_fn,
            retrieval_fn=retrieval_fn, retrieval_sources=retrieval_sources,
        ):
            with _registry.lock:
                _apply_event(job, event)

    # Pass project_id explicitly (not the ambient default): the worker must bind THIS pid's
    # project even if a caller's ambient context is absent or different (scheduler/test/batch).
    return _registry.start_or_join(pid, lambda: BuildJob(id=pid), work, project_id=pid)


def _apply_event(job: BuildJob, event: dict) -> None:
    etype = event["type"]
    if etype == "start":
        job.total = event["total"]
        job.ready = event.get("ready", 0)
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
    elif etype == "metadata":
        job.current_slug = event["slug"]
        job.current_title = event["title"]
        job.per_paper[event["slug"]] = {"status": "metadata", "error": None}
    elif etype == "metadata_progress":
        job.per_paper[event["slug"]] = {
            "status": "metadata_cached" if event["cached"] else event["status"],
            "error": event.get("error"),
        }
    elif etype == "retrieving":
        job.current_slug = event["slug"]
        job.current_title = event["title"]
        job.per_paper[event["slug"]] = {"status": "retrieving", "error": None}
    elif etype == "retrieval_progress":
        job.ready = event["ready"]
        job.per_paper[event["slug"]] = {
            "status": "retrieval_cached" if event["cached"] else event["status"],
            "error": event.get("error"),
        }
        if event.get("candidates"):
            job.retrieval_candidates[event["slug"]] = event["candidates"]
    elif etype == "done":
        # status/finished_at are set by the registry once work() returns; the graph itself is
        # already persisted by graph.build_graph before this event.
        job.graph = event["graph"]
        job.recommendations = event["recommendations"]
        job.current_slug = None
        job.current_title = None
    elif etype == "error":
        # A job-level error event ends the build in error; the registry's finalize only sets
        # "done" when the job is still "running", so this terminal status is preserved.
        job.status = "error"
        job.error = event["detail"]
        job.finished_at = now_iso()
