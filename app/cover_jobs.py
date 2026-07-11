"""Paper cover-image jobs: rasterize page 1 of a paper's PDF into a PNG used as the paper's
"large icon" (e.g. the Library "Continue reading" card).

The backend keeps only the extracted *text* of a paper (markdown-in-git), not the PDF, so a
first-page image has to be produced by re-fetching the PDF and rasterizing it. That download can
exceed the tunnel's ~100s cut-off, so — like every other minutes-capable flow — it runs as a
background job (CLAUDE.md invariant 1) and the resulting PNG is cached on disk **forever** (a
paper's first page never changes). Once cached, requests serve the file directly and never spawn
a job. A render that fails (no fetchable source, not a PDF, corrupt) is remembered as terminal so
polling clients don't hammer the source; the paper simply falls back to its icon.

Covers live under the project's `.state/covers/<slug>.png` (per-project transient state, like the
session index and usage ledger) and are git-ignored.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import fitz  # PyMuPDF
import httpx

from . import config, logging_config, store
from .fileio import atomic_write_bytes
from .jobs import Job, JobRegistry, new_id

log = logging_config.get("cover")

# Rasterization width in pixels. The only current consumer is the ~84pt-wide Continue-reading
# thumbnail (≈250px at 3x density), but rendering wider keeps the same cache crisp if a larger
# "big icon" reuses it later. A first page at this width is a ~150–250KB PNG.
COVER_WIDTH_PX = 900

# Hard resource ceilings. This job runs in the single uvicorn process (invariant 6) against a
# remotely-supplied PDF, so an oversized download or a pathological page must not be able to OOM
# and take the whole service down. The download is byte-capped; the raster is capped on both a
# single dimension and total pixels, so an extreme aspect ratio (a tiny width would otherwise make
# the width-target zoom enormous) can't blow up the pixmap allocation.
COVER_MAX_PDF_BYTES = 40_000_000   # matches retrieval_agent's PDF ceiling
COVER_MAX_DIM = 5_000              # cap on either output dimension (px)
COVER_MAX_PIXELS = 4_000_000       # cap on total output pixels

_registry: JobRegistry[CoverJob] = JobRegistry("cover", max_finished=None)


class CoverError(Exception):
    pass


@dataclass
class CoverJob(Job):
    slug: str = ""


def cover_path(slug: str) -> Path:
    """On-disk cache location for a slug's cover. `slug` is already the trusted filesystem key the
    corpus file uses (see store.corpus_path), so it is safe as a filename component."""
    return config.state_dir() / "covers" / f"{slug}.png"


def _pdf_url_for(slug: str) -> str | None:
    """A fetchable PDF URL for the paper, or None when there's no usable source. arXiv id wins
    (the common case); otherwise the recorded source URL (an arXiv abstract link is rewritten to
    its PDF, a direct PDF is used as-is)."""
    aid = store.arxiv_id_for(slug)
    if aid:
        return f"https://arxiv.org/pdf/{aid}"
    src = store.source_url_for(slug)
    if not src:
        return None
    if "arxiv.org/abs/" in src:
        return src.replace("/abs/", "/pdf/")
    return src


def _download_pdf(url: str) -> bytes:
    """Stream a PDF with a hard byte ceiling. A cover is fetched once and cached, but this runs in
    the single shared process, so an oversized/malicious source must not be able to exhaust memory:
    reject an over-limit Content-Length up front and stop the stream the moment it crosses the cap.
    Raises CoverError on any transport error or when the limit is exceeded."""
    headers = {"User-Agent": "research-companion/1.0 (paper cover render)"}
    try:
        with httpx.stream("GET", url, headers=headers, timeout=60, follow_redirects=True) as r:
            r.raise_for_status()
            declared = r.headers.get("content-length")
            if declared and declared.isdigit() and int(declared) > COVER_MAX_PDF_BYTES:
                raise CoverError(f"PDF too large ({declared} bytes)")
            chunks: list[bytes] = []
            total = 0
            for chunk in r.iter_bytes():
                total += len(chunk)
                if total > COVER_MAX_PDF_BYTES:
                    raise CoverError(f"PDF exceeds {COVER_MAX_PDF_BYTES}-byte cover limit")
                chunks.append(chunk)
    except httpx.HTTPError as e:
        raise CoverError(f"Download failed for {url}: {e}") from e
    return b"".join(chunks)


def _render_first_page(pdf: bytes) -> bytes:
    """PNG bytes of page 1, rasterized toward COVER_WIDTH_PX wide but clamped so no single
    dimension exceeds COVER_MAX_DIM and total pixels stay under COVER_MAX_PIXELS. Raises CoverError
    on a PDF with no pages or a degenerate page; PyMuPDF raises on malformed input (caught by the
    job runner and marked terminal)."""
    doc = fitz.open(stream=pdf, filetype="pdf")
    try:
        if doc.page_count < 1:
            raise CoverError("PDF has no pages")
        page = doc.load_page(0)
        w, h = page.rect.width, page.rect.height
        if not (math.isfinite(w) and math.isfinite(h) and w > 0 and h > 0):
            raise CoverError("PDF page has invalid dimensions")
        zoom = COVER_WIDTH_PX / w
        # Clamp an extreme aspect ratio: bound the tall dimension, then total pixels.
        if h * zoom > COVER_MAX_DIM:
            zoom = COVER_MAX_DIM / h
        if (w * zoom) * (h * zoom) > COVER_MAX_PIXELS:
            zoom *= math.sqrt(COVER_MAX_PIXELS / ((w * zoom) * (h * zoom)))
        if w * zoom < 1 or h * zoom < 1:
            raise CoverError("PDF page too degenerate to render")
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
        return pix.tobytes("png")
    finally:
        doc.close()


def _work(job: CoverJob) -> None:
    url = _pdf_url_for(job.slug)
    if not url:
        raise CoverError(f"No PDF source for paper '{job.slug}'")
    data = _download_pdf(url)
    if not data.startswith(b"%PDF"):
        raise CoverError(f"Source for '{job.slug}' is not a PDF")
    png = _render_first_page(data)
    dst = cover_path(job.slug)
    dst.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_bytes(dst, png)
    log.info("cover rendered slug=%s bytes=%d", job.slug, len(png))


def render_from_pdf(slug: str, pdf: bytes | None) -> bool:
    """Best-effort: rasterize + cache a cover from PDF bytes already in hand — e.g. the bytes
    retrieval just downloaded to extract text — so a freshly-retrieved paper never hits the
    separate on-demand download in ensure(). Idempotent (skips an already-cached cover) and never
    raises: a cover is cosmetic and must not affect the retrieval it rides along with. Returns
    True only when it wrote a new cover."""
    if not pdf or cover_path(slug).exists():
        return False
    try:
        png = _render_first_page(pdf)
        dst = cover_path(slug)
        dst.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_bytes(dst, png)
        log.info("cover rendered from retrieval slug=%s bytes=%d", slug, len(png))
        return True
    except Exception as e:  # noqa: BLE001 — cosmetic; log and move on
        log.info("cover render-from-pdf skipped slug=%s: %s", slug, str(e)[:120])
        return False


def ensure(slug: str) -> str:
    """Return the cover's status for the active project, starting a render job if needed:
      * "ready"       — the PNG is cached at cover_path(slug); serve it.
      * "pending"     — a render job is running (or was just started); poll again.
      * "unavailable" — no fetchable PDF source, or a prior render failed terminally.
    Idempotent and cheap: a cached cover never spawns a job, and a failed render is not retried
    (its terminal job is kept — invariant against re-hammering an unreachable source)."""
    if cover_path(slug).exists():
        return "ready"
    if not _pdf_url_for(slug):
        return "unavailable"
    latest = _registry.latest_for(slug)
    if latest is not None and latest.status == "error":
        return "unavailable"
    _registry.start_or_join(slug, lambda: CoverJob(id=new_id(), slug=slug), _work)
    return "pending"
