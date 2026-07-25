"""App-global settings + workflow-prompt editor routes."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from .. import auth, config, projects, prompts, tts
from ..prompts import PromptError, PromptManagedError

router = APIRouter()


class SettingsReq(BaseModel):
    openrouter_api_key: str | None = None
    model: str | None = None
    narration_model: str | None = None
    preview_model: str | None = None
    openai_api_key: str | None = None
    speech_provider: str | None = None
    tts_model: str | None = None
    tts_voice: str | None = None
    parallel_api_key: str | None = None    # web search provider (agent tools)
    firecrawl_api_key: str | None = None   # web search/fetch provider (agent tools)
    semantic_scholar_api_key: str | None = None  # citation/reference metadata provider
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
    s2key = s.get("semantic_scholar_api_key") or ""
    return {
        "has_key": bool(key), "key_hint": (key[:6] + "…") if key else "",
        "model": s.get("model"), "narration_model": s.get("narration_model"),
        # Raw override, not the effective narration fallback. The editor must preserve unset.
        "preview_model": s.get("preview_model") or "",
        "has_openai_key": bool(okey), "openai_key_hint": (okey[:6] + "…") if okey else "",
        "speech_provider": s.get("speech_provider"), "tts_model": s.get("tts_model"),
        "tts_voice": s.get("tts_voice"), "voices": tts.OPENAI_VOICES,
        "has_parallel_key": bool(pkey), "parallel_key_hint": (pkey[:6] + "…") if pkey else "",
        "has_firecrawl_key": bool(fkey), "firecrawl_key_hint": (fkey[:6] + "…") if fkey else "",
        "has_semantic_scholar_key": bool(s2key),
        "semantic_scholar_key_hint": (s2key[:6] + "…") if s2key else "",
        "prior_notes_scope": s.get("prior_notes_scope") or "related",
    }


@router.post("/api/settings")
def write_settings(req: SettingsReq, request: Request):
    # Same gate as the prompt routes, and for a sharper reason: these are the INSTANCE's provider
    # keys and model choice, not the caller's. Any authenticated user could previously swap the
    # model every turn runs on, or overwrite the OpenRouter key and take the app offline for
    # everyone (P0-2). There is one key and one model selection on this deployment — per-user
    # settings arrive with ownership in M2, and this gate is what holds the line until then.
    _require_operator(request)
    merged = config.save_settings(req.model_dump())
    return {
        "has_key": bool(merged.get("openrouter_api_key")), "model": merged.get("model"),
        "narration_model": merged.get("narration_model"),
        "preview_model": merged.get("preview_model") or "",
        "has_openai_key": bool(merged.get("openai_api_key")),
        "speech_provider": merged.get("speech_provider"),
        "tts_model": merged.get("tts_model"), "tts_voice": merged.get("tts_voice"),
        "has_parallel_key": bool(merged.get("parallel_api_key")),
        "has_firecrawl_key": bool(merged.get("firecrawl_api_key")),
        "has_semantic_scholar_key": bool(merged.get("semantic_scholar_api_key")),
        "prior_notes_scope": merged.get("prior_notes_scope") or "related",
    }


def _require_operator(request: Request) -> None:
    """Gate a route that changes configuration for EVERY user of the instance.

    Two routes need this, for the same reason: the system prompts drive every analysis turn, and
    the settings hold the instance's shared provider keys and model choice. A user who can write
    either one changes the app for everybody else — steering other people's reading (P0-3), or
    swapping the model every turn bills against (P0-2). Product decision 2026-07-25: both belong to
    the operator.

    Two things are deliberately NOT gated. Reading settings is fine: keys come back as 6-char
    hints, never in full. And the per-session *starting prompt* a reader edits before a discussion
    travels on the turn (`ChatStartReq.prompt`) and never touches the registry, so it stays an
    ordinary user feature.
    """
    if not auth.is_operator(getattr(request.state, "user", None)):
        raise HTTPException(
            status_code=403,
            detail="Editing prompts is restricted to the instance operator.")


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
def save_prompt(req: PromptReq, request: Request):
    _require_operator(request)
    try:
        prompts.set_prompt(req.key, req.value or "")
    except PromptManagedError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except PromptError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"key": req.key, "value": prompts.get(req.key), "is_overridden": prompts.is_overridden(req.key)}


@router.post("/api/prompts/reset")
def reset_prompt(req: PromptReq, request: Request):
    _require_operator(request)
    try:
        prompts.reset(req.key)
    except PromptManagedError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except PromptError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"key": req.key, "value": prompts.get(req.key), "is_overridden": prompts.is_overridden(req.key)}
