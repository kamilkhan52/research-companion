"""App-global settings + workflow-prompt editor routes."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import config, projects, prompts, tts
from ..prompts import PromptError, PromptManagedError

router = APIRouter()


class SettingsReq(BaseModel):
    openrouter_api_key: str | None = None
    model: str | None = None
    narration_model: str | None = None
    openai_api_key: str | None = None
    speech_provider: str | None = None
    tts_model: str | None = None
    tts_voice: str | None = None
    parallel_api_key: str | None = None    # web search provider (agent tools)
    firecrawl_api_key: str | None = None   # web search/fetch provider (agent tools)
    prior_notes_scope: str | None = None   # "related" | "all" — prior Notes in paper context


class PromptReq(BaseModel):
    key: str
    value: str | None = None


@router.get("/api/settings")
def read_settings():
    s = config.load_settings()
    key = s.get("openrouter_api_key") or ""
    okey = s.get("openai_api_key") or ""
    pkey = s.get("parallel_api_key") or ""
    fkey = s.get("firecrawl_api_key") or ""
    return {
        "has_key": bool(key), "key_hint": (key[:6] + "…") if key else "",
        "model": s.get("model"), "narration_model": s.get("narration_model"),
        "has_openai_key": bool(okey), "openai_key_hint": (okey[:6] + "…") if okey else "",
        "speech_provider": s.get("speech_provider"), "tts_model": s.get("tts_model"),
        "tts_voice": s.get("tts_voice"), "voices": tts.OPENAI_VOICES,
        "has_parallel_key": bool(pkey), "parallel_key_hint": (pkey[:6] + "…") if pkey else "",
        "has_firecrawl_key": bool(fkey), "firecrawl_key_hint": (fkey[:6] + "…") if fkey else "",
        "prior_notes_scope": s.get("prior_notes_scope") or "related",
    }


@router.post("/api/settings")
def write_settings(req: SettingsReq):
    merged = config.save_settings(req.model_dump())
    return {
        "has_key": bool(merged.get("openrouter_api_key")), "model": merged.get("model"),
        "narration_model": merged.get("narration_model"),
        "has_openai_key": bool(merged.get("openai_api_key")),
        "speech_provider": merged.get("speech_provider"),
        "tts_model": merged.get("tts_model"), "tts_voice": merged.get("tts_voice"),
        "has_parallel_key": bool(merged.get("parallel_api_key")),
        "has_firecrawl_key": bool(merged.get("firecrawl_api_key")),
        "prior_notes_scope": merged.get("prior_notes_scope") or "related",
    }


@router.get("/api/prompts")
def get_prompts(project: str | None = None):
    """All workflow prompts and live status, optionally scoped to one project's method file."""
    if project and not projects.exists(project):
        raise HTTPException(status_code=404, detail="Unknown project")
    token = config.set_active_project(project) if project else None
    try:
        return {"prompts": prompts.listing()}
    finally:
        if token is not None:
            config.reset_active_project(token)


@router.post("/api/prompts")
def save_prompt(req: PromptReq):
    try:
        prompts.set_prompt(req.key, req.value or "")
    except PromptManagedError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except PromptError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"key": req.key, "value": prompts.get(req.key), "is_overridden": prompts.is_overridden(req.key)}


@router.post("/api/prompts/reset")
def reset_prompt(req: PromptReq):
    try:
        prompts.reset(req.key)
    except PromptManagedError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except PromptError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"key": req.key, "value": prompts.get(req.key), "is_overridden": prompts.is_overridden(req.key)}
