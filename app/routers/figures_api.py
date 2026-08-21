"""Paper figure routes (R.10): the figure manifest derived from the paper's arXiv HTML
rendering, plus the cached image assets it references. Read-only — derivation happens in the
retrieval warm / graph-build enrichment (app/figures.py); these routes only serve what's
already cached, so they are cheap and never touch the network (invariant 1 doesn't apply)."""
from __future__ import annotations

from fastapi import HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .. import figures
from . import make_project_router

project_router = make_project_router()

_MEDIA_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    # DR-091: only SVGs that passed figures._svg_is_safe are ever stored, so serving the
    # type does not serve active content.
    ".svg": "image/svg+xml",
}


class PaperFigure(BaseModel):
    id: str
    number: int | None = None
    caption: str = ""
    alt: str = ""
    src: str
    asset: str
    width: int | None = None
    height: int | None = None


class FigureManifestResponse(BaseModel):
    """`status`: `done` (figures usable), `none` (no HTML rendering, or not derived yet —
    the client renders exactly as before figures existed). `fetched_ts` doubles as the
    cache-busting version for asset URLs (a re-derivation changes it)."""
    status: str
    figures: list[PaperFigure]
    source: str | None = None
    fetched_ts: float | None = None


@project_router.get("/papers/{slug}/figures", response_model=FigureManifestResponse)
def get_figure_manifest(pid: str, slug: str):
    manifest = figures.manifest_for(slug)
    if not manifest or manifest.get("status") != "done":
        return FigureManifestResponse(status="none", figures=[])
    return FigureManifestResponse(
        status="done",
        figures=[PaperFigure(**fig) for fig in manifest.get("figures", [])],
        source=manifest.get("source"),
        fetched_ts=manifest.get("fetched_ts"),
    )


@project_router.get("/papers/{slug}/figures/{asset}")
def get_figure_asset(pid: str, slug: str, asset: str):
    """Cached figure image bytes. Two trust checks: figures.asset_path bounds the path
    (store-shaped slug, sanitizer-shaped filename only), and the asset must be listed in the
    slug's CURRENT `done` manifest — so after an identity correction the withheld stale
    manifest's assets can't be served under the corrected slug (even from a leaked URL)
    before the next derivation deletes them. Cacheable but not immutable — a re-derivation
    can rewrite an asset under the same name, so clients append the manifest's fetched_ts as
    a `?v=` version param; the cache is kept short-lived and revalidated rather than
    immutable so a stale URL doesn't stick in a client cache across a correction."""
    path = figures.asset_path(slug, asset)
    if path is None or not path.exists():
        raise HTTPException(status_code=404, detail="Figure asset not found")
    manifest = figures.manifest_for(slug)
    if not manifest or manifest.get("status") != "done":
        raise HTTPException(status_code=404, detail="Figure asset not found")
    if not any(fig.get("asset") == asset for fig in manifest.get("figures", [])):
        raise HTTPException(status_code=404, detail="Figure asset not found")
    media = _MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream")
    return FileResponse(path, media_type=media,
                        # `private`: a per-project asset behind auth must not be stored by a shared
                        # cache, which could then serve it to another user without the request
                        # reaching `use_project`.
                        headers={"Cache-Control": "private, max-age=86400, must-revalidate"})
