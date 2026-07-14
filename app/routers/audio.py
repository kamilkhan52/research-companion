"""App-global audio routes: blocking one-shot TTS (/speak), the background narrate→synthesize
job flow (/audio/jobs), the cached-mp3 file server, and stage-2 narration. Audio is app-global
(the TTS cache is shared across projects), but each request may name an initiating project so
its LLM spend is billed there rather than to the unattributed ledger."""
from __future__ import annotations

import re

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .. import agent, audio_jobs, config, fileio, projects, sessions, tts, usage
from ..agent import AgentError
from ..tts import TTSError

router = APIRouter()

AUDIO_DIR = audio_jobs.AUDIO_DIR  # app-global (TTS cache shared across projects)


class NarrateReq(BaseModel):
    text: str
    project: str | None = None   # initiating project, for usage attribution (audio is app-global)


def _billing_scope(project: str | None) -> str:
    """Resolve the usage-billing scope for an app-global narration request: the validated
    initiating project, or the explicit unattributed ledger when none was sent. A provided-but-
    unknown/invalid project is a client error (400), not a silent misattribution — and
    projects.exists() rejects any traversal/absolute id centrally (see projects._safe_pid)."""
    if project is None:
        return usage.UNATTRIBUTED
    if not projects.exists(project):
        raise HTTPException(status_code=400, detail=f"Unknown billing project: {project}")
    return project


@router.post("/api/speak")
def speak(req: NarrateReq):
    """Synthesize one passage to mp3 (OpenAI), cached on disk; returns its URL. Blocking —
    long passages can outlive proxy timeouts; prefer the /api/audio/jobs flow for those."""
    s = config.load_settings()
    if s.get("speech_provider") != "openai":
        raise HTTPException(status_code=400, detail="Speech provider is not OpenAI.")
    path = audio_jobs.audio_cache_path(req.text)
    if not path.exists():
        try:
            fileio.atomic_write_bytes(path, tts.synthesize_long(req.text))
        except TTSError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
    return {"url": f"/api/audio/{path.name}"}


@router.post("/api/audio/jobs")
def start_audio_job(req: NarrateReq):
    """Start (or join) a background narrate→synthesize job for one canonical message and
    return its snapshot immediately; instant 'done' when the result is already cached. The
    client polls /api/audio/jobs/{id} — nothing here depends on a long-lived connection, so
    tunnels/proxy timeouts and app backgrounding can't kill a preparation in flight."""
    s = config.load_settings()
    if s.get("speech_provider") != "openai":
        raise HTTPException(status_code=400, detail="Speech provider is not OpenAI.")
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Nothing to narrate.")
    return {"job": audio_jobs.start_job(req.text, billing_project=_billing_scope(req.project)).to_dict()}


@router.get("/api/audio/jobs/{job_id}")
def get_audio_job(job_id: str):
    """Cheap poll for a preparation job's live progress (stage + segments done/total)."""
    job = audio_jobs.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Unknown audio job")
    return {"job": job.to_dict()}


@router.post("/api/audio/jobs/{job_id}/cancel")
def cancel_audio_job(job_id: str):
    """Cancel an in-flight preparation: the job flips to `cancelled` immediately and the worker
    stops spending on narration/TTS at its next checkpoint. Cancelling an already-finished job
    is a no-op that returns its final snapshot."""
    job = audio_jobs.cancel_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Unknown audio job")
    return {"job": job.to_dict()}


@router.get("/api/audio/{name}")
def audio(name: str):
    if not re.fullmatch(r"[0-9a-f]{40}\.mp3", name):
        raise HTTPException(status_code=404, detail="Not found")
    path = AUDIO_DIR / name
    if not path.exists():
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(path, media_type="audio/mpeg",
                        headers={"Cache-Control": "public, max-age=86400"})


@router.post("/api/narrate")
def narrate(req: NarrateReq):
    """Stage 2: adapt one canonical response into a TTS transcript (cached by text hash). Uncached
    narration bills the initiating project (validated) or the unattributed ledger."""
    cached = sessions.get_cached_narration(req.text)
    if cached is not None:
        return {"narration": cached, "cached": True}
    token = config.set_active_project(_billing_scope(req.project))  # validates project (400)
    try:
        narration = agent.narrate(req.text)
    except AgentError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    finally:
        config.reset_active_project(token)
    sessions.cache_narration(req.text, narration)
    return {"narration": narration, "cached": False}
