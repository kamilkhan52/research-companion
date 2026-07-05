"""Per-project discovery routes: turn a project's research goals into ranked arXiv reading
suggestions. The run is a background job (app/discovery_jobs.py) the client polls; see
CLAUDE.md invariant 1."""
from __future__ import annotations

from fastapi import HTTPException
from pydantic import BaseModel

from .. import config, discovery, discovery_jobs, projects
from . import make_project_router

project_router = make_project_router()


class DiscoverReq(BaseModel):
    goals: str


@project_router.post("/discover")
def start_discovery(pid: str, req: DiscoverReq):
    """Start (or join) a discovery run for this project's goals and return its snapshot
    immediately. Saves the goals into project.json so the field is prefilled on return."""
    goals = req.goals.strip()
    if not goals:
        raise HTTPException(status_code=400, detail="Describe the project's goals first.")
    if not config.has_api_key():
        raise HTTPException(status_code=400, detail="No OpenRouter API key set. Open Settings.")
    projects.update_meta(pid, goals=goals)
    discovery_jobs.start_discovery(pid, goals)
    return {"job": discovery_jobs.snapshot(pid)}


@project_router.get("/discover")
def get_discovery(pid: str):
    """Live job snapshot (poll every ~1.5s while running) plus the last persisted result, so
    the screen shows previous suggestions on re-entry."""
    return {"job": discovery_jobs.snapshot(pid), "result": discovery.load_result(),
            "goals": (projects._read_meta(pid) or {}).get("goals") or ""}
