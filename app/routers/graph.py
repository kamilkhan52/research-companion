"""Per-project reference-graph routes. The build is a server-side background job
(app/graph_jobs.py) the client polls for progress — it must survive a backgrounded app, a
dropped connection, or the app being closed and reopened, none of which can kill a job that
isn't waiting on the request (an earlier SSE-stream-IS-the-build design didn't survive any of
those). See CLAUDE.md invariant 1 and the docstrings in graph_jobs.py."""
from __future__ import annotations

from pydantic import BaseModel

from .. import graph, graph_jobs, graph_store, sessions, store
from . import make_project_router

project_router = make_project_router()


class GraphBuildReq(BaseModel):
    # Refresh provider metadata and re-extract every retrievable paper, ignoring both caches.
    force: bool = False


@project_router.get("/graph")
def get_graph(pid: str):
    papers = store.list_papers(sessions.session_states())
    data = graph_store.load()
    job = graph_jobs.get_job(pid)
    return {
        "graph": data.get("graph"),
        "recommendations": data.get("recommendations") or [],
        "status": graph.status(papers),
        "build": job.to_dict() if job else None,
    }


@project_router.get("/graph/recommendations")
def get_graph_recommendations(pid: str):
    data = graph_store.load()
    return {"recommendations": data.get("recommendations") or []}


@project_router.get("/graph/build/status")
def get_graph_build_status(pid: str):
    """Lightweight, cheap-to-poll endpoint for live build progress — the client polls this
    every second or two while a build is running instead of holding a connection open."""
    job = graph_jobs.get_job(pid)
    return {"build": job.to_dict() if job else None}


@project_router.post("/graph/build")
def build_graph_start(pid: str, req: GraphBuildReq):
    """Starts a build in the background and returns its current snapshot immediately (does
    NOT block until it finishes). If a build is already running for this project, joins it
    (returns its current progress) rather than starting a duplicate."""
    job = graph_jobs.start_build(pid, force=req.force)
    return {"build": job.to_dict()}
