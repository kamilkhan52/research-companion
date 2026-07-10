"""Project management (list/create/meta, app-global) plus the per-project reading-list state.

Named `projects_api` to avoid confusion with the `app.projects` service module it drives.
`/meta` stays app-global (not on the project router) so it can read/rename a project without
binding it active via `use_project`, exactly as before the split.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from .. import committer, config, projects, sessions, store
from ..committer import CommitError
from ..projects import ProjectError
from . import make_project_router

router = APIRouter()
project_router = make_project_router()


class ProjectReq(BaseModel):
    name: str
    method: str | None = None   # optional starting reading-method; defaults to the template


@router.get("/api/projects")
def list_projects():
    return {"projects": projects.list_projects()}


@router.get("/api/recent-sessions")
def recent_sessions(limit: int = Query(default=20, ge=1, le=100)):
    return {"sessions": projects.recent_sessions(limit)}


@router.post("/api/projects")
def create_project(req: ProjectReq):
    try:
        meta = projects.create_project(req.name, req.method)
    except ProjectError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"project": meta}


@router.get("/api/projects/{pid}/meta")
def project_meta(pid: str):
    if not projects.exists(pid):
        raise HTTPException(status_code=404, detail=f"Unknown project: {pid}")
    return {"project": projects._read_meta(pid)}


@router.patch("/api/projects/{pid}/meta")
def rename_project(pid: str, req: ProjectReq):
    try:
        meta = projects.rename_project(pid, req.name)
    except ProjectError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"project": meta}


@project_router.delete("/papers/{slug}")
def remove_paper(pid: str, slug: str):
    """Remove a paper from this project's reading list. Product decision: its notes are KEPT
    — a marker line is appended so the retained notes say the paper left the list — and the
    corpus text / session transcript stay on disk (warm start if it is ever re-added).

    This is the one write path besides /approve and notes-save that git-commits directly:
    the client only calls it after the user's explicit in-app confirmation, so the human
    approval that invariant 4 requires has already happened. Deterministic and fast (no LLM,
    no network) ⇒ a plain request, not a background job."""
    paper = store.get_paper(slug)
    if paper is None:
        raise HTTPException(status_code=404, detail=f"Unknown paper: {slug}")
    notes_kept = store.has_notes(slug)
    if notes_kept:
        store.append_removed_marker(slug)
    store.remove_entry(slug)
    try:
        committer._git("add", "-A")
        committer._git("commit", "-q", "-m", f"Remove {paper.title} from reading list")
    except CommitError as e:
        if "nothing to commit" not in str(e):
            raise HTTPException(status_code=500, detail=str(e)) from e
    return {"removed": slug, "notes_kept": notes_kept}


@project_router.get("/state")
def get_state(pid: str):
    settings = config.load_settings()
    states = sessions.session_states()
    papers = [p.to_dict() for p in store.list_papers(states)]
    return {
        "project": projects._read_meta(pid) or {"id": pid, "name": pid},
        "has_key": bool(settings.get("openrouter_api_key")),
        "model": settings.get("model"),
        "narration_model": settings.get("narration_model"),
        "preview_model": settings.get("preview_model") or settings.get("narration_model"),
        "speech_provider": settings.get("speech_provider"),
        "has_openai_key": bool(settings.get("openai_api_key")),
        "papers": papers,
    }
