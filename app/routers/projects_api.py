"""Project management (list/create/meta, app-global) plus the per-project reading-list state.

Named `projects_api` to avoid confusion with the `app.projects` service module it drives.
`/meta` stays app-global (not on the project router) so it can read/rename a project without
binding it active via `use_project`, exactly as before the split.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import config, projects, sessions, store
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
