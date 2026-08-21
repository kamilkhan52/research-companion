"""Per-project reference-graph routes. The build is a server-side background job
(app/graph_jobs.py) the client polls for progress — it must survive a backgrounded app, a
dropped connection, or the app being closed and reopened, none of which can kill a job that
isn't waiting on the request (an earlier SSE-stream-IS-the-build design didn't survive any of
those). See CLAUDE.md invariant 1 and the docstrings in graph_jobs.py."""
from __future__ import annotations

from fastapi import HTTPException
from pydantic import BaseModel, Field

from .. import (
    author_profiles,
    discovery,
    graph,
    graph_jobs,
    graph_store,
    lab_research,
    neighbourhood,
    sessions,
    store,
)
from . import make_project_router

project_router = make_project_router()


class GraphBuildReq(BaseModel):
    # Refresh provider metadata and re-extract every retrievable paper, ignoring both caches.
    force: bool = False
    # Explicit user-confirmed arXiv source per reading-list slug. Values are used only by the
    # project-bound graph background job and never written into the git-backed reading list.
    retrieval_sources: dict[str, str] = Field(default_factory=dict)


@project_router.get("/graph")
def get_graph(pid: str):
    papers = store.list_papers(sessions.session_states())
    data = graph_store.load()
    job = graph_jobs.get_job(pid)
    return {
        # Membership is re-derived from the live reading list on every read, so papers
        # added/removed since the last build color correctly without a rebuild (U.19).
        "graph": graph.overlay_membership(data.get("graph"), papers),
        # Papers the reader hid from recommendations stay hidden here too (R12.3).
        "recommendations": discovery.filter_hidden(data.get("recommendations")),
        "status": graph.status(papers),
        "build": job.to_dict() if job else None,
    }


@project_router.get("/neighbourhood")
def get_neighbourhood(pid: str):
    """The shared corpus-neighbourhood freshness (DR-052 PR 4). Read-only and cheap — derived
    from the graph store's forward records — so both the Map and Discover tabs can show the
    same 'checked N ago · M of P monitored' line and the merge beneath them becomes visible."""
    papers = store.list_papers(sessions.session_states())
    return {"neighbourhood": neighbourhood.status(papers, graph_store.load())}


@project_router.get("/graph/recommendations")
def get_graph_recommendations(pid: str):
    data = graph_store.load()
    return {"recommendations": discovery.filter_hidden(data.get("recommendations"))}


@project_router.get("/graph/authors")
def get_graph_authors(pid: str):
    """The ranked in-project author board (U.9 v1), aggregated from the stored graph at read
    time. Membership is overlaid first so a paper added since the last build counts as
    in-project here too. Author/affiliation coverage grows with graph builds (OpenAlex cache);
    an empty board with a built graph means the next rebuild will populate authors."""
    papers = store.list_papers(sessions.session_states())
    data = graph_store.load()
    overlaid = graph.overlay_membership(data.get("graph"), papers)
    board = graph.author_board(overlaid, data.get("openalex"), data.get("llm_affiliations"))
    # Merge cached LLM profiles (R7.6) at read time — generation stays a background job.
    # Fingerprint-checked: a profile whose inputs changed is withheld, not shown stale.
    profiles = author_profiles.profiles_for_board(board)
    for entry in board:
        entry["profile"] = profiles.get(graph._author_key(entry["name"])) or None
    labs_job = lab_research.active()
    return {
        "authors": board,
        "explainers": graph.AUTHOR_EXPLAINERS,
        "built_at": (overlaid or {}).get("built_at"),
        # Lab-centric grouping (R7.7): researched lab cards + which authors they cover; the
        # client keeps the plain affiliation grouping for everyone else.
        "labs": lab_research.labs_board(board),
        "labs_job": labs_job.to_dict() if labs_job else None,
    }


class AuthorProfileReq(BaseModel):
    name: str


@project_router.post("/graph/authors/profile/job")
def start_author_profile(pid: str, req: AuthorProfileReq):
    """Start (or join) the one-paragraph profile generation for a board author (LLM ⇒
    background job + polling, invariant 1). Served straight from the cache when inputs
    haven't changed."""
    try:
        job = author_profiles.start_profile(req.name)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    return {"job": author_profiles.snapshot(job.id)}


@project_router.get("/graph/authors/profile/jobs/{job_id}")
def author_profile_status(pid: str, job_id: str):
    snap = author_profiles.snapshot(job_id)
    if not snap:
        raise HTTPException(status_code=404, detail="Unknown profile job")
    return {"job": snap}


@project_router.post("/graph/labs/research")
def start_labs_research(pid: str):
    """Start (or join) the agentic lab pass over the project's top authors (R7.7). Explicit,
    user-triggered — each uncached author costs a small web-agent run on the graph model."""
    try:
        job = lab_research.start_research()
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    return {"job": lab_research.snapshot(job.id)}


@project_router.get("/graph/labs/research/jobs/{job_id}")
def labs_research_status(pid: str, job_id: str):
    snap = lab_research.snapshot(job_id)
    if not snap:
        raise HTTPException(status_code=404, detail="Unknown labs research job")
    return {"job": snap}


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
    job = graph_jobs.start_build(
        pid, force=req.force, retrieval_sources=req.retrieval_sources
    )
    return {"build": job.to_dict()}
