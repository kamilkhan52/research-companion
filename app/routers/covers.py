"""Paper cover-image routes: a paper's first PDF page rasterized to a PNG, used as its "large
icon". `GET .../cover` returns the render status (and kicks off a background render if needed —
invariant 1); `GET .../cover.png` serves the cached image once ready. Drives `app.cover_jobs`."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from .. import cover_jobs
from . import make_project_router

router = APIRouter()
project_router = make_project_router()


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
        headers={"Cache-Control": "public, max-age=604800, immutable"},
    )
