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
import time
from dataclasses import dataclass
from pathlib import Path

import fitz  # PyMuPDF
import httpx

from . import config, logging_config, projects, safe_fetch, store
from .fileio import atomic_write_bytes
from .jobs import Job, JobRegistry, new_id

log = logging_config.get("cover")

# Pace between downloads in the cross-project backfill — polite to arXiv and keeps the one-shot
# pass from saturating the single worker's network.
BACKFILL_PACE_S = 1.5

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
    """Stream a PDF through the guarded fetcher. The byte ceiling was always here (this runs in the
    single shared process, so an oversized source must not exhaust memory); what safe_fetch adds is
    the destination check — the cover url can derive from a stored `source_url`, which originally
    came from a client, and redirects were previously followed without any validation at all.
    Raises CoverError on a refused destination, an over-limit body, or any transport error."""
    headers = {"User-Agent": "research-companion/1.0 (paper cover render)"}
    try:
        return safe_fetch.fetch(
            url, max_bytes=COVER_MAX_PDF_BYTES, timeout=60, headers=headers).content
    except safe_fetch.UnsafeURLError as e:
        raise CoverError(f"Refusing to download {url}: {e}") from e
    except safe_fetch.FetchTooLargeError as e:
        raise CoverError(f"PDF too large: {e}") from e
    except httpx.HTTPError as e:
        raise CoverError(f"Download failed for {url}: {e}") from e


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


def _write_cover(slug: str, png: bytes) -> None:
    dst = cover_path(slug)
    dst.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_bytes(dst, png)


def _render_and_cache(slug: str) -> None:
    """Download the paper's PDF and cache its first-page cover. Raises CoverError when there's no
    fetchable source, the source isn't a PDF, or rendering fails. Shared by the on-demand job and
    the backfill."""
    url = _pdf_url_for(slug)
    if not url:
        raise CoverError(f"No PDF source for paper '{slug}'")
    data = _download_pdf(url)
    if not data.startswith(b"%PDF"):
        raise CoverError(f"Source for '{slug}' is not a PDF")
    _write_cover(slug, _render_first_page(data))
    log.info("cover rendered slug=%s", slug)


def _work(job: CoverJob) -> None:
    _render_and_cache(job.slug)


def render_from_pdf(slug: str, pdf: bytes | None) -> bool:
    """Best-effort: rasterize + cache a cover from PDF bytes already in hand — e.g. the bytes
    retrieval just downloaded to extract text — so a freshly-retrieved paper never hits the
    separate on-demand download in ensure(). Idempotent (skips an already-cached cover) and never
    raises: a cover is cosmetic and must not affect the retrieval it rides along with. Returns
    True only when it wrote a new cover."""
    if not pdf or cover_path(slug).exists():
        return False
    try:
        _write_cover(slug, _render_first_page(pdf))
        log.info("cover rendered from retrieval slug=%s bytes=%d", slug, len(pdf))
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


# ---- eager backfill ----------------------------------------------------------------------------
# Papers retrieved before covers existed have text cached but no cover, so they would render
# on-demand (a brief spinner) the first time they're shown. This one-shot pass renders those up
# front across every project, so a resume/Continue-reading panel never waits. It's the only place
# that walks all projects, so it lives here rather than in a request handler.


@dataclass
class BackfillJob(Job):
    scanned: int = 0     # retrieved papers examined
    rendered: int = 0    # covers newly written
    skipped: int = 0     # coverless papers with no fetchable source / a render failure


_backfill_registry: JobRegistry[BackfillJob] = JobRegistry("cover-backfill", max_finished=1)

# (pid, slug) pairs whose render failed this process — a coverless-but-unfetchable paper (404,
# non-PDF, corrupt). Remembered so a later pass doesn't re-download it every app session (it has
# no cover file, so the exists() check alone wouldn't skip it). Resets on process restart, which
# gives a genuinely-transient failure one fresh attempt.
_backfill_failed: set[tuple[str, str]] = set()


def _backfill_project(job: BackfillJob, pid: str) -> None:
    """Backfill one project's covers (the active project is already bound to `pid`). Per-paper
    errors are contained so one bad paper doesn't stop the project; the caller contains a bad
    project so it doesn't stop the pass."""
    for paper in store.list_papers():
        if not store.corpus_path(paper.slug).exists():
            continue  # not retrieved -> no PDF was ever downloaded
        with _backfill_registry.lock:
            job.scanned += 1
        if cover_path(paper.slug).exists() or (pid, paper.slug) in _backfill_failed:
            continue  # already have it, or already failed this process
        try:
            _render_and_cache(paper.slug)
            with _backfill_registry.lock:
                job.rendered += 1
        except Exception as e:  # noqa: BLE001 — best-effort; a missing cover is fine
            log.info("cover backfill skip %s/%s: %s", pid, paper.slug, str(e)[:120])
            _backfill_failed.add((pid, paper.slug))
            with _backfill_registry.lock:
                job.skipped += 1
        time.sleep(BACKFILL_PACE_S)  # pace only after an actual download attempt


def _backfill_work(job: BackfillJob) -> None:
    try:
        projs = projects.list_projects()
    except Exception as e:  # noqa: BLE001 — nothing to backfill if we can't enumerate
        log.warning("cover backfill: could not enumerate projects: %s", str(e)[:120])
        return
    for proj in projs:
        pid = proj["id"]
        # The list was captured up front; a project deleted mid-backfill must be skipped, or
        # this app-global worker (invisible to the per-project running-job sweep) would
        # recreate its directory with cover writes.
        if config.project_is_deleting(pid) or not projects.exists(pid):
            continue
        token = config.set_active_project(pid)
        try:
            _backfill_project(job, pid)
        except Exception as e:  # noqa: BLE001 — one unreadable project must not abort the rest
            log.info("cover backfill: project %s skipped: %s", pid, str(e)[:120])
        finally:
            config.reset_active_project(token)
    log.info("cover backfill done scanned=%d rendered=%d skipped=%d",
             job.scanned, job.rendered, job.skipped)


def start_backfill() -> BackfillJob:
    """Start (or join) a one-shot background pass that renders covers for every retrieved-but-
    coverless paper across all projects. Deduped (at most one running), paced, and best-effort —
    a paper whose PDF can't be re-fetched is simply left to its icon fallback. Cheap to re-invoke:
    once everything is covered it's just a stat scan. App-global scope (walks every project itself,
    rebinding the active-project contextvar per project — invariant 2)."""
    return _backfill_registry.start_or_join(
        "all", lambda: BackfillJob(id=new_id()), _backfill_work, project_id=None)
