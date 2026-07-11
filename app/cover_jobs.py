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

from dataclasses import dataclass
from pathlib import Path

import fitz  # PyMuPDF

from . import config, logging_config, retriever, store
from .fileio import atomic_write_bytes
from .jobs import Job, JobRegistry, new_id

log = logging_config.get("cover")

# Rasterization width in pixels. The only current consumer is the ~84pt-wide Continue-reading
# thumbnail (≈250px at 3x density), but rendering wider keeps the same cache crisp if a larger
# "big icon" reuses it later. A first page at this width is a ~150–250KB PNG.
COVER_WIDTH_PX = 900

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


def _render_first_page(pdf: bytes) -> bytes:
    """PNG bytes of page 1 rasterized to COVER_WIDTH_PX wide. Raises CoverError on a PDF with no
    pages; PyMuPDF raises on malformed input (caught by the job runner and marked terminal)."""
    doc = fitz.open(stream=pdf, filetype="pdf")
    try:
        if doc.page_count < 1:
            raise CoverError("PDF has no pages")
        page = doc.load_page(0)
        zoom = COVER_WIDTH_PX / page.rect.width
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
        return pix.tobytes("png")
    finally:
        doc.close()


def _work(job: CoverJob) -> None:
    url = _pdf_url_for(job.slug)
    if not url:
        raise CoverError(f"No PDF source for paper '{job.slug}'")
    data = retriever._fetch(url)
    if not data.startswith(b"%PDF"):
        raise CoverError(f"Source for '{job.slug}' is not a PDF")
    png = _render_first_page(data)
    dst = cover_path(job.slug)
    dst.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_bytes(dst, png)
    log.info("cover rendered slug=%s bytes=%d", job.slug, len(png))


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
