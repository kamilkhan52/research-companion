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


def _without_hidden(result: dict | None) -> dict | None:
    """A copy of the persisted result with hidden suggestions AND already-in-library papers
    removed (R12.3; library exclusion added DR-002, 2026-08-11). The stored file keeps every
    suggestion either way, so unhiding never needs a re-run and neither would un-excluding."""
    if not result or not isinstance(result.get("suggestions"), list):
        return result
    suggestions = discovery.filter_hidden(result["suggestions"])
    suggestions = discovery.filter_in_library(suggestions)
    return {**result, "suggestions": suggestions}


@project_router.get("/discover")
def get_discovery(pid: str):
    """Live job snapshot (poll every ~1.5s while running) plus the last persisted result, so
    the screen shows previous suggestions on re-entry."""
    return {"job": discovery_jobs.snapshot(pid),
            "result": _without_hidden(discovery.load_result()),
            "hidden": discovery.load_hidden(),
            "goals": (projects._read_meta(pid) or {}).get("goals") or ""}


@project_router.post("/discover/cancel")
def cancel_discovery(pid: str):
    """Stop the current discovery run at its next stage boundary.

    The last completed result remains persisted. The cancelled job snapshot retains any live
    finds already gathered so the client can show them as partial, non-ranked evidence instead of
    pretending the run found nothing.
    """
    job = discovery_jobs.cancel_discovery(pid)
    if not job:
        raise HTTPException(status_code=404, detail="No discovery run to stop")
    return {"job": discovery_jobs.snapshot(pid)}


class HideReq(BaseModel):
    candidate: dict


class UnhideReq(BaseModel):
    keys: list[str]


@project_router.post("/discover/hide")
def hide_suggestion(pid: str, req: HideReq):
    """Hide one recommended paper from future recommendation surfaces (R12.3). The client
    sends the suggestion dict it rendered; identity is derived server-side."""
    try:
        entry = discovery.hide_candidate(req.candidate)
    except discovery.DiscoveryError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"hidden": entry}


@project_router.post("/discover/unhide")
def unhide_suggestion(pid: str, req: UnhideReq):
    """Undo a hide by any of its identity keys."""
    return {"removed": discovery.unhide(req.keys)}
