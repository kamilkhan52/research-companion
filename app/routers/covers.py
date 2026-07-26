"""Paper cover-image routes: a paper's first PDF page rasterized to a PNG, used as its "large
icon". `GET .../cover` returns the render status (and kicks off a background render if needed —
invariant 1); `GET .../cover.png` serves the cached image once ready. Drives `app.cover_jobs`."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from .. import auth, cover_jobs
from . import make_project_router

router = APIRouter()
project_router = make_project_router()


@router.post("/api/covers/backfill")
def backfill_covers(request: Request):
    """Start (or join) a one-shot pass that renders covers for every retrieved-but-coverless paper
    across all projects, so pre-existing papers have their cover ready before they're first shown.
    Returns immediately; the client fires this once on load (idempotent + deduped server-side)."""
    # Instance-wide maintenance: it walks EVERY project, reads their reading lists, and fetches
    # PDFs from their stored source URLs. That is one user causing reads across everyone else's
    # library and spending the instance's bandwidth doing it, so it belongs to the operator rather
    # than to any signed-in reader. Not scoped-per-caller instead, because the point of a backfill
    # is to warm the whole cache once — a per-user version would be a different feature.
    if not auth.is_operator(getattr(request.state, "user", None)):
        raise HTTPException(
            status_code=403,
            detail="Backfilling covers across every project is restricted to the instance operator.")
    job = cover_jobs.start_backfill()
    return {"status": job.status}


@project_router.get("/papers/{slug}/cover")
def get_cover_status(pid: str, slug: str):
    """Render status for a paper's cover image: `ready` (fetch `/cover.png`), `pending` (a render
    job is running — poll again), or `unavailable` (no fetchable PDF source, or render failed —
    fall back to the icon). Cheap and idempotent; a cached cover never spawns a job."""
    return {"status": cover_jobs.ensure(slug)}


@project_router.get("/papers/{slug}/cover.png")
def get_cover_image(pid: str, slug: str):
    """The cached first-page PNG. 404 until the render job has finished (client polls
    `/cover` for status). Immutable once produced — a paper's first page never changes."""
    path = cover_jobs.cover_path(slug)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Cover not ready")
    return FileResponse(
        path,
        media_type="image/png",
        # `private`, not `public`: these are per-project assets behind auth, and explicitly
        # authorizing a SHARED cache to store an Authorization-bearing response invites it to serve
        # a guessable project/paper URL to a different user without the request ever reaching
        # `use_project`. The browser cache lifetime is unchanged — that one is per-user already.
        headers={"Cache-Control": "private, max-age=604800, immutable"},
    )
