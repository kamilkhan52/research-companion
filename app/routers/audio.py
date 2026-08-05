"""App-global background audio jobs and the caller-isolated cached-mp3 file server.

The former blocking speech and standalone narration routes are intentionally absent: every paid
audio operation must enter through the connection-independent job seam that M3 admission controls
will gate.
"""
from __future__ import annotations

import re

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .. import audio_jobs, config, projects, tenancy, usage

router = APIRouter()

# Deliberately no module-level AUDIO_DIR alias any more: the directory to read from depends on
# who is asking (`audio_jobs.user_audio_dir()`), and a module-level constant is exactly how a
# later route would quietly go back to reading the shared one.


class NarrateReq(BaseModel):
    text: str
    project: str | None = None   # initiating project, for usage attribution (audio is app-global)


def _billing_scope(project: str | None, request: Request) -> str:
    """Resolve the usage-billing scope for an app-global narration request: the validated
    initiating project, or the explicit unattributed ledger when none was sent.

    The project arrives in the BODY, so this route never acquires `use_project` — and this value
    decides whose ledger the spend lands on. Without an ownership check anyone could name someone
    else's project and bill their narration to it, corrupting the attribution that M3's per-user
    quotas will be enforced from. Ownership is checked BEFORE existence so a foreign project and an
    invented one answer identically.

    A provided-but-unknown project is a client error (400), not a silent misattribution.
    `projects.exists()` still rejects traversal centrally (see `projects._safe_pid`).
    """
    if project is None:
        return usage.UNATTRIBUTED
    if not tenancy.may_access(project, getattr(request.state, "user", None)):
        raise HTTPException(status_code=400, detail=f"Unknown billing project: {project}")
    if not projects.exists(project):
        raise HTTPException(status_code=400, detail=f"Unknown billing project: {project}")
    return project


@router.post("/api/audio/jobs")
def start_audio_job(req: NarrateReq, request: Request):
    """Start (or join) a background narrate→synthesize job for one canonical message and
    return its snapshot immediately; instant 'done' when the result is already cached. The
    client polls /api/audio/jobs/{id} — nothing here depends on a long-lived connection, so
    tunnels/proxy timeouts and app backgrounding can't kill a preparation in flight."""
    s = config.load_settings()
    if s.get("speech_provider") != "openai":
        raise HTTPException(status_code=400, detail="Speech provider is not OpenAI.")
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Nothing to narrate.")
    return {"job": audio_jobs.start_job(req.text, billing_project=_billing_scope(req.project, request)).to_dict()}


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
    """Serve one cached mp3 — from the CALLER's audio directory, never a shared one.

    This is the entire fetch-side boundary, and it is a path rather than a check: the same passage
    in the same voice yields the same file name for everybody, so `name` is not a secret and never
    needed to be. Joining it to `audio_jobs.user_audio_dir()` means a name learned from — or simply
    computed the same way as — someone else's client resolves to a file that does not exist for you.

    `private` caching, not `public`: the response now varies by caller, and a shared cache keyed on
    the URL alone would hand one user's narration to the next (the same correction covers/figures
    took in slice 2a).
    """
    if not re.fullmatch(r"[0-9a-f]{40}\.mp3", name):
        raise HTTPException(status_code=404, detail="Not found")
    path = audio_jobs.user_audio_dir() / name
    if not path.exists():
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(path, media_type="audio/mpeg",
                        headers={"Cache-Control": "private, max-age=86400"})
