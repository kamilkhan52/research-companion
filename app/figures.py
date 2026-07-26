"""arXiv-HTML figure extraction + asset cache (R.10 phase 1, per docs/chat-figures-design.md).

When a paper has an arXiv HTML rendering (arxiv.org/html, falling back to ar5iv), this module
derives a per-paper FIGURE MANIFEST — each figure's number, caption, and a locally cached
image asset — under the project's `.state/figures/`. The discussion later cards a figure
inline when an assistant turn references it ("Figure 3 shows…"); resolution happens at render
time against the current manifest, so the manifest is a pure cache: absent ⇒ no cards.

Contract (same enrichment posture as citations/openalex/affiliations):
- Best-effort throughout — a missing/failed HTML fetch is a silent no-op, never a failed
  retrieval or build. Derivation runs on job threads only (retrieval warm + graph build's
  enrichment phase), never on a request thread, and never in store.py.
- The manifest is keyed to the paper's identity (versionless arXiv id). An identity
  correction (same slug, different confirmed paper) drops the old manifest and assets rather
  than serving another paper's figures; a slug with no arXiv id keeps no manifest at all.
- Paper HTML is UNTRUSTED (SSRF boundary): image URLs must be https on an arXiv-family host,
  every redirect is revalidated against the same allowlist, hosts resolving to
  private/loopback/link-local addresses are rejected, downloads are streamed under a hard
  size cap and must be a raster `image/*` type, and fetches carry no cookies or credentials.
- Deterministic parse — no LLM anywhere. Tests inject `fetch_html`/`fetch_image` fakes; the
  suite stays network-free.
"""
from __future__ import annotations

import ipaddress
import json
import re
import shutil
import socket
import threading
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse

import httpx

from . import config, logging_config, store
from .fileio import atomic_write_bytes, atomic_write_text
from .jobs import Job, JobRegistry, new_id, now_iso

log = logging_config.get("figures")


class StallError(Exception):
    """A host accepted the connection but timed out mid-fetch. Distinguished from a
    definitive miss (404: cached with a cool-down) and from a fast transport error (nothing
    cached): a stall must ABORT the enrichment pass — an unavailable host would otherwise
    cost its timeout once per paper — and must never be cached as \"no HTML\"."""

MAX_FIGURES = 20
MAX_IMAGE_BYTES = 2 * 1024 * 1024
FETCH_TIMEOUT = 20.0
MAX_REDIRECTS = 5
# A "no HTML rendering" result is cached and only re-checked after this cool-down, so a
# corpus of PDF-only papers doesn't re-poll arXiv on every graph build.
NONE_RETRY_S = 7 * 24 * 3600.0
# Wall-clock deadline per paper in the graph build's enrichment pass — same reasoning as
# affiliations.HARD_DEADLINE_S: a stalled host must not keep the build job from settling,
# and the first timeout aborts the whole pass (not once per paper).
HARD_DEADLINE_S = 90.0

_ALLOWED_HOST_SUFFIXES = ("arxiv.org", "ar5iv.org")
_REDIRECT_CODES = {301, 302, 303, 307, 308}
# Raster types only — RN's Image can't render SVG, and SVG can embed further fetches.
_IMAGE_EXTS = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
}

_NUM_FROM_CAPTION = re.compile(r"^\s*Fig(?:ure)?\.?\s*(\d+)", re.I)
_NUM_FROM_ID = re.compile(r"F(\d+)$")
_SAFE_ASSET_CHARS = re.compile(r"[^A-Za-z0-9._-]")
# Store-derived slugs only (lowercase alnum + hyphens). The serving routes pass a raw URL
# path segment as `slug`, so the readers below are a trust boundary like asset_path.
_SAFE_SLUG = re.compile(r"^[a-z0-9][a-z0-9-]*$")


# --- paths -----------------------------------------------------------------------------------

def figures_dir() -> Path:
    return config.state_dir() / "figures"


def manifest_path(slug: str) -> Path:
    return figures_dir() / f"{slug}.json"


def asset_dir(slug: str) -> Path:
    return figures_dir() / slug


def asset_path(slug: str, asset: str) -> Path | None:
    """Resolve a manifest asset filename to its cached file — the trust boundary for the
    serving route. Only store-shaped slugs and plain filenames the sanitizer could have
    produced are accepted."""
    if not _SAFE_SLUG.match(slug or ""):
        return None
    if not asset or _SAFE_ASSET_CHARS.search(asset) or asset.startswith("."):
        return None
    return asset_dir(slug) / asset


# --- manifest I/O ----------------------------------------------------------------------------

def read_manifest(slug: str) -> dict | None:
    try:
        return json.loads(manifest_path(slug).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _project_alive() -> bool:
    """False once the active project is being deleted or its directory is gone. Workers here
    can outlive their job (the warm job settles, a deadline worker is orphaned), and a write
    after `delete_project`'s rename would RECREATE `projects/<pid>` as a partial store —
    so every write site checks this, and _write_manifest re-checks after writing (a race
    that slips past the first check is taken back out)."""
    pid = config.active_project_id()
    if pid and config.project_is_deleting(pid):
        return False
    try:
        return config.project_dir().exists()
    except Exception:  # noqa: BLE001 — no active project / resolution failure: don't write
        return False


def _write_manifest(slug: str, manifest: dict) -> bool:
    if not _project_alive():
        return False
    figures_dir().mkdir(parents=True, exist_ok=True)
    atomic_write_text(manifest_path(slug), json.dumps(manifest, indent=1))
    if not _project_alive():
        _drop(slug)
        return False
    return True


def _drop(slug: str) -> None:
    """Remove a slug's manifest + assets (identity changed or vanished)."""
    try:
        manifest_path(slug).unlink(missing_ok=True)
        shutil.rmtree(asset_dir(slug), ignore_errors=True)
    except OSError:
        pass


def _current_id(slug: str) -> str:
    """The paper's arXiv id, CORPUS-first: the corpus meta records the exact (versioned) id
    retrieval fetched — the text the discussion actually reads — while the reading-list
    entry deliberately never updates on a same-paper version advance. Falls back to the
    entry id for papers whose corpus predates id stamping."""
    return store.corpus_arxiv_id_for(slug) or store.arxiv_id_for(slug)


def manifest_for(slug: str) -> dict | None:
    """The slug's manifest, but only when it matches the paper's CURRENT identity — a
    just-corrected retrieval must never serve the previous paper's figures. (A version
    advance keeps the same base: the old figures serve until the rebuild lands.)"""
    if not _SAFE_SLUG.match(slug or ""):
        return None  # routes pass a raw path segment — never build paths from it unchecked
    manifest = read_manifest(slug)
    if not manifest:
        return None
    base = store.arxiv_base_id(_current_id(slug))
    if not base or manifest.get("arxiv_id") != base:
        return None
    return manifest


# --- SSRF guard ------------------------------------------------------------------------------

def _host_allowed(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        return False
    host = parsed.hostname.lower().rstrip(".")
    return any(host == suffix or host.endswith("." + suffix)
               for suffix in _ALLOWED_HOST_SUFFIXES)


def _resolves_public(url: str) -> bool | None:
    """True when the host resolves only to public addresses; False on private/loopback/
    link-local results (rejected for good — defense against DNS games behind an
    allowed-looking name); None when resolution itself failed (a TRANSIENT condition:
    callers must not cache a miss over a DNS blip)."""
    host = urlparse(url).hostname or ""
    try:
        infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
    except OSError:
        return None
    addresses = [info[4][0] for info in infos]
    if not addresses:
        return None
    for raw in addresses:
        try:
            ip = ipaddress.ip_address(raw)
        except ValueError:
            return False
        # `is_global` rather than an enumeration of private ranges: the enumerated form (which
        # this was) misses 100.64.0.0/10, the carrier-grade-NAT block that Tailscale uses, so a
        # tailnet peer would read as public. Not reachable here — _host_allowed already pins the
        # host to arxiv/ar5iv — but the same test lives in app/safe_fetch.py and the two must not
        # disagree, or the next person copies whichever they find first.
        if not ip.is_global:
            return False
    return True


# --- fetchers (the only network in this module) ----------------------------------------------

def _open_client() -> httpx.Client:
    # follow_redirects=False: every hop is revalidated against the allowlist by the loops
    # below. No cookies, no app credentials.
    return httpx.Client(timeout=FETCH_TIMEOUT, follow_redirects=False,
                        headers={"User-Agent": "research-companion-figures/1.0"})


def _fetch_html_impl(requested_id: str,
                     skip: frozenset[str] | set[str] = frozenset(),
                     ) -> tuple[str, str | None, str | None]:
    """("ok", final_url, html_text) for the paper's HTML rendering; ("none", None, None)
    when the hosts definitively have none (cacheable miss); ("error", None, None) on fast
    transport errors (nothing cached — retried next build). Raises StallError on a timeout.
    Tries arXiv's native HTML first (newer papers), then ar5iv (older corpus). The id is
    passed VERSION-BEARING when known: the versionless URL serves the latest revision,
    whose figures could disagree with the (pinned-version) corpus text being discussed.
    `skip` lists final page URLs the caller already tried and found unusable (every listed
    image failed to download), so derivation can move on to the next renderer."""
    candidates = (
        f"https://arxiv.org/html/{requested_id}",
        f"https://ar5iv.labs.arxiv.org/html/{requested_id}",
    )
    transient = False
    with _open_client() as client:
        for url in candidates:
            try:
                for _ in range(MAX_REDIRECTS):
                    if not _host_allowed(url):
                        break
                    public = _resolves_public(url)
                    if public is None:
                        transient = True  # DNS blip — never cache a miss over it
                        break
                    if not public:
                        break
                    resp = client.get(url)
                    if resp.status_code in _REDIRECT_CODES:
                        location = resp.headers.get("location")
                        if not location:
                            break
                        url = urljoin(url, location)
                        continue
                    if resp.status_code != 200:
                        # Only definitive absence (404/410) may become a cached miss —
                        # a 429/5xx is an outage/rate limit that must not suppress
                        # figures for the whole cool-down.
                        if resp.status_code not in (404, 410):
                            transient = True
                        break
                    ctype = resp.headers.get("content-type", "").split(";")[0].strip().lower()
                    if ctype != "text/html":
                        break
                    html_text = resp.text
                    # arXiv sometimes redirects an unavailable /html page to the paper's
                    # ordinary /abs landing page (200 text/html), and some native renderings
                    # carry no fetchable raster figures (none at all, or only SVG/off-host
                    # sources the derivation would drop) even though ar5iv has them. Neither
                    # is a usable figure source: accepting one would cache a "done" manifest
                    # with zero entries and shadow ar5iv for good, so continue to the
                    # fallback renderer instead.
                    if url in skip or not _usable_figure_sources(url, parse_figures(html_text)):
                        break
                    return "ok", url, html_text
            except httpx.TimeoutException as e:
                raise StallError(str(e)[:120]) from e
            except httpx.HTTPError as e:
                transient = True
                log.info("figure HTML fetch failed for %s: %s", requested_id, str(e)[:120])
    return ("error" if transient else "none"), None, None


def _fetch_html(requested_id: str,
                skip: frozenset[str] | set[str] = frozenset(),
                ) -> tuple[str, str | None, str | None]:
    return _fetch_html_impl(requested_id, skip)


def _fetch_image(url: str) -> tuple[bytes, str] | None:
    """(bytes, extension) for one figure image, streamed under the size cap. None drops just
    that figure; a timeout raises StallError (abort the paper — a dead host must not cost
    its timeout once per figure, and a partial figure set must not be cached as done)."""
    with _open_client() as client:
        try:
            for _ in range(MAX_REDIRECTS):
                if not _host_allowed(url):
                    return None
                public = _resolves_public(url)
                if public is None:
                    # DNS blip mid-paper: abort like a stall so a partial figure set is
                    # not cached as done.
                    raise StallError("dns resolution failed")
                if not public:
                    return None
                with client.stream("GET", url) as resp:
                    if resp.status_code in _REDIRECT_CODES:
                        location = resp.headers.get("location")
                        if not location:
                            return None
                        url = urljoin(url, location)
                        continue
                    if resp.status_code != 200:
                        return None
                    ctype = resp.headers.get("content-type", "").split(";")[0].strip().lower()
                    ext = _IMAGE_EXTS.get(ctype)
                    if ext is None:
                        return None
                    buf = bytearray()
                    for chunk in resp.iter_bytes():
                        buf.extend(chunk)
                        if len(buf) > MAX_IMAGE_BYTES:
                            return None
                    return bytes(buf), ext
        except httpx.TimeoutException as e:
            raise StallError(str(e)[:120]) from e
        except httpx.HTTPError as e:
            log.info("figure image fetch failed: %s", str(e)[:120])
    return None


# --- deterministic HTML → figure parse -------------------------------------------------------

class _FigureParser(HTMLParser):
    """Collects top-level <figure> elements: first contained <img>, the OUTER figcaption's
    text, and the element id. Nested <figure> panels (ar5iv subfigures) contribute their
    image to the parent but never their own captions or entries — v1 cards the parent
    figure. Tolerant by construction: HTMLParser never raises on malformed markup, and a
    figure without a resolvable image is simply dropped."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.figures: list[dict] = []
        self._depth = 0
        self._current: dict | None = None
        self._in_outer_caption = False
        self._caption_parts: list[str] = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "figure":
            self._depth += 1
            if self._depth == 1:
                self._current = {"id": a.get("id") or "", "src": None, "alt": "",
                                 "caption": "", "width": _int_attr(a, "width"),
                                 "height": _int_attr(a, "height")}
        elif self._depth and tag == "img" and self._current is not None:
            if self._current["src"] is None and a.get("src"):
                self._current["src"] = a["src"]
                self._current["alt"] = (a.get("alt") or "")[:500]
                self._current["width"] = _int_attr(a, "width")
                self._current["height"] = _int_attr(a, "height")
        elif tag == "figcaption" and self._depth == 1:
            self._in_outer_caption = True
            self._caption_parts = []

    def handle_endtag(self, tag):
        if tag == "figcaption" and self._in_outer_caption:
            self._in_outer_caption = False
            if self._current is not None and not self._current["caption"]:
                text = " ".join("".join(self._caption_parts).split())
                self._current["caption"] = text[:1000]
        elif tag == "figure" and self._depth:
            self._depth -= 1
            if self._depth == 0 and self._current is not None:
                if self._current.get("src"):
                    self.figures.append(self._current)
                self._current = None

    def handle_data(self, data):
        if self._in_outer_caption:
            self._caption_parts.append(data)


def _int_attr(attrs: dict, name: str) -> int | None:
    try:
        return int(attrs.get(name) or "")
    except ValueError:
        return None


def _figure_number(fig: dict) -> int | None:
    m = _NUM_FROM_CAPTION.match(fig.get("caption") or "")
    if m:
        return int(m.group(1))
    m = _NUM_FROM_ID.search(fig.get("id") or "")
    return int(m.group(1)) if m else None


def parse_figures(html_text: str) -> list[dict]:
    parser = _FigureParser()
    parser.feed(html_text)
    parser.close()
    return parser.figures


# --- derivation ------------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _page_base(url: str) -> str:
    """The URL image srcs resolve against. arXiv/ar5iv HTML pages are directory-style
    (`…/html/<id>` — note the id itself contains dots), so without a trailing slash urljoin
    would REPLACE the id segment; only an explicit `.html`-style page keeps urljoin's normal
    last-segment handling."""
    if url.endswith("/"):
        return url
    last = urlparse(url).path.rsplit("/", 1)[-1].lower()
    return url if last.endswith((".html", ".htm")) else url + "/"


def _image_urls(page_url: str, raw_src: str) -> list[str]:
    """Resolve figure image paths emitted by both arXiv HTML renderers.

    ar5iv commonly emits page-directory-relative paths such as ``assets/x1.png``. Native
    arXiv HTML now commonly emits document-relative paths prefixed with the paper id, such
    as ``2401.00001v1/x1.png``. Treating the latter as page-directory-relative duplicates
    the id (``.../2401.00001v1/2401.00001v1/x1.png``) and silently drops every figure.

    Prefer the document-relative interpretation when the raw path starts with the final
    page segment, then retain the other interpretation as a tolerant fallback. Absolute
    paths/URLs collapse to one candidate.
    """
    directory_relative = urljoin(_page_base(page_url), raw_src)
    document_relative = urljoin(page_url, raw_src)
    page_segment = urlparse(page_url).path.rstrip("/").rsplit("/", 1)[-1]
    raw_path = urlparse(raw_src).path.lstrip("/")
    candidates = (
        [document_relative, directory_relative]
        if page_segment and raw_path.startswith(page_segment + "/")
        else [directory_relative, document_relative]
    )
    return list(dict.fromkeys(candidates))


def _usable_figure_sources(page_url: str, parsed: list[dict]) -> bool:
    """Whether any figure the derivation would actually keep offers a fetchable image:
    within the derivation's figure cap, on an allowed host, and not SVG. Mirrors the
    per-figure drop rules in `_derive_locked` so "this page has figures" and "this page
    can yield assets" cannot disagree."""
    for fig in parsed[:MAX_FIGURES]:
        for candidate in _image_urls(page_url, str(fig.get("src") or "")):
            if not _host_allowed(candidate):
                continue
            if urlparse(candidate).path.lower().endswith(".svg"):
                continue
            return True
    return False


# One derivation per slug at a time: the retrieval warm and a graph build's enrichment can
# overlap for the same paper, and interleaved asset rebuilds would corrupt each other.
_slug_locks: dict[str, threading.Lock] = {}
_slug_locks_guard = threading.Lock()


def _slug_lock(slug: str) -> threading.Lock:
    with _slug_locks_guard:
        return _slug_locks.setdefault(slug, threading.Lock())


def derive_for_slug(slug: str, *, force: bool = False,
                    fetch_html=None, fetch_image=None) -> dict | None:
    """Derive (or return the cached) figure manifest for one paper. Never raises past its own
    boundary in the job-facing wrappers below; callers on job threads may call it directly
    and handle/ignore StallError. Returns None when the paper has no arXiv identity."""
    with _slug_lock(slug):
        return _derive_locked(slug, force=force, fetch_html=fetch_html,
                              fetch_image=fetch_image)


def _derive_locked(slug: str, *, force: bool, fetch_html, fetch_image) -> dict | None:
    aid = _current_id(slug)
    base = store.arxiv_base_id(aid)
    existing = read_manifest(slug)
    if not base:
        if existing is not None:
            _drop(slug)  # no identity — never keep (or serve) figures we can't attribute
        return None
    if existing is not None and existing.get("arxiv_id") != base:
        _drop(slug)  # identity correction: the old paper's figures must not survive
        existing = None
    # `requested_id` records the exact id (version included) the manifest was derived for.
    # A version advance (v1 → v2: revised figures) is a cache miss — but NOT a _drop: the
    # old assets stay live until the replacement lands atomically below.
    if existing is not None and not force and existing.get("requested_id") == aid:
        # A "done" manifest with zero figures is a LEGACY artifact: earlier code cached one
        # when native image paths were misresolved or every download failed. The current
        # pipeline records those outcomes as a cool-down "none" instead, so an empty "done"
        # can only be stale — fall through and re-derive rather than trusting it forever.
        if existing.get("status") == "done" and existing.get("figures"):
            return existing
        if (existing.get("status") != "done"
                and time.time() - float(existing.get("fetched_ts") or 0) < NONE_RETRY_S):
            return existing  # recent "no HTML" result — don't re-poll arXiv every build
    fetch_html = fetch_html or _fetch_html
    fetch_image = fetch_image or _fetch_image

    # A page can pass the parse-time usability check and still yield nothing at download
    # time (dead links, non-image types, oversized files). Caching that as a "done" manifest
    # with zero entries would shadow the other renderer for good, so an exhausted page joins
    # `tried` and the fetch moves to the next source. The candidate list is finite, so this
    # settles in at most a few rounds.
    tried: set[str] = set()
    while True:
        status, final_url, html_text = fetch_html(aid or base, tried)
        if status == "error":
            # Transient failure (transport error, 429/5xx) — nothing cached, retried later.
            return existing
        if status != "ok":
            manifest = {"version": 1, "arxiv_id": base, "requested_id": aid, "source": None,
                        "status": "none", "fetched_at": _now_iso(),
                        "fetched_ts": time.time(), "figures": []}
            return manifest if _write_manifest(slug, manifest) else existing

        parsed = parse_figures(html_text)
        # Build into a staging dir and swap only on success: a stall mid-download must leave
        # the previous assets (and the manifest pointing at them) fully intact.
        staging = figures_dir() / f".{slug}.staging"
        shutil.rmtree(staging, ignore_errors=True)
        entries: list[dict] = []
        try:
            for index, fig in enumerate(parsed[:MAX_FIGURES]):
                src = None
                image = None
                for candidate in _image_urls(final_url, fig["src"]):
                    if not _host_allowed(candidate):
                        continue  # data: URIs and off-allowlist hosts drop here
                    if urlparse(candidate).path.lower().endswith(".svg"):
                        continue
                    image = fetch_image(candidate)  # StallError propagates → staging discarded
                    if image is not None:
                        src = candidate
                        break
                if image is None:
                    continue
                payload, ext = image
                stem = _SAFE_ASSET_CHARS.sub("-", fig["id"]) or "fig"
                asset = f"{index + 1:02d}-{stem}{ext}"
                if not _project_alive():
                    return existing  # racing a deletion — stop, write nothing more
                staging.mkdir(parents=True, exist_ok=True)
                atomic_write_bytes(staging / asset, payload)
                entries.append({
                    "id": fig["id"] or f"fig-{index + 1}",
                    "number": _figure_number(fig),
                    "caption": fig["caption"],
                    "alt": fig["alt"],
                    "src": src,
                    "asset": asset,
                    "width": fig.get("width"),
                    "height": fig.get("height"),
                })
            if not _project_alive():
                return existing
            if not entries:
                tried.add(final_url)
                continue  # every listed image failed to download — try the next renderer
            shutil.rmtree(asset_dir(slug), ignore_errors=True)
            staging.rename(asset_dir(slug))
            manifest = {"version": 1, "arxiv_id": base, "requested_id": aid,
                        "source": final_url, "status": "done", "fetched_at": _now_iso(),
                        "fetched_ts": time.time(), "figures": entries}
            if not _write_manifest(slug, manifest):
                shutil.rmtree(asset_dir(slug), ignore_errors=True)
                return existing
            log.info("figure manifest for %s: %d figures from %s",
                     slug, len(entries), final_url)
            return manifest
        finally:
            shutil.rmtree(staging, ignore_errors=True)


@dataclass
class WarmJob(Job):
    slug: str = ""


# A real registry (not a bare thread) so the warm participates in project lifecycle
# accounting: jobs.any_running_for_project sees it (delete_project refuses while it runs),
# and start_or_join's admission check refuses to start one for a deleting/splitting project.
_warm_registry: JobRegistry[WarmJob] = JobRegistry("figure-warm", max_finished=5)


def warm_async(slug: str) -> WarmJob | None:
    """Background cache warm, called on the retrieval job thread right after the paper's
    text persists — so figures are usually ready before the first turn ever mentions one.
    Runs as its own registered job so it never delays the retrieval job's `done` (or the
    chained auto-analysis) while staying visible to deletion accounting. Best-effort: any
    failure is captured on the (unpolled) job; the graph build's enrichment backfills."""
    def work(job: WarmJob) -> None:
        try:
            derive_for_slug(job.slug)
        except StallError as e:
            log.info("figure warm stalled for %s: %s", job.slug, str(e)[:120])

    try:
        return _warm_registry.start_or_join(
            f"warm:{slug}", lambda: WarmJob(id=new_id(), slug=slug), work)
    except RuntimeError as e:
        # Project is being deleted/split — no warm for it.
        log.info("figure warm skipped for %s: %s", slug, str(e)[:120])
        return None


# --- graph-build enrichment pass -------------------------------------------------------------

# Same stall containment as affiliations: a worker past its deadline can't be killed, so it's
# orphaned (daemon — dies with the process) and the next pass is skipped while one is alive.
_orphans: list[threading.Thread] = []
_orphans_lock = threading.Lock()


def _orphan_alive() -> bool:
    with _orphans_lock:
        _orphans[:] = [t for t in _orphans if t.is_alive()]
        return bool(_orphans)


# A timed-out worker outlives its graph job, so it must stay visible to project lifecycle
# accounting (jobs.any_running_for_project) until its thread actually exits — otherwise a
# deletion could proceed while the orphan sits between its liveness check and a write, and
# the write would recreate the deleted project. The orphan is promoted into this registry
# the moment it times out (while the graph job still blocks deletion), and marks itself
# done from its own finally. The handoff is racy in both directions, so both sides settle
# it under the registry lock via the shared cell.
@dataclass
class OrphanJob(Job):
    slug: str = ""


_orphan_registry: JobRegistry[OrphanJob] = JobRegistry("figure-orphan", max_finished=5)


def _settle_orphan(cell: dict) -> None:  # caller holds _orphan_registry.lock
    job = cell.get("job")
    if job is not None and job.status == "running" and cell.get("done"):
        job.status = "done"
        job.finished_at = now_iso()


def _derive_with_deadline(slug: str, force: bool, derive) -> bool:
    """True when the worker timed out OR the host stalled mid-fetch (caller aborts the
    pass either way — an unavailable host must not cost its timeout once per paper).
    Other in-thread failures are a retryable miss, never an exception on the build thread."""
    pid = config.active_project_id()
    uid = config.active_user_id()
    result: dict = {}
    cell: dict = {}

    def _do() -> None:
        # Project AND user (invariant 2, see config.bound_scope): a raw thread inherits neither,
        # and a missing user silently runs this on the instance's model rather than the caller's.
        try:
            with config.bound_scope(pid, uid):
                derive(slug, force=force)
        except StallError as e:
            result["stalled"] = True
            log.info("figure fetch stalled for %s: %s", slug, str(e)[:120])
        except Exception as e:  # noqa: BLE001
            log.info("figure derivation errored for %s: %s", slug, str(e)[:120])
        finally:
            with _orphan_registry.lock:
                cell["done"] = True
                _settle_orphan(cell)

    worker = threading.Thread(target=_do, daemon=True, name="figures")
    worker.start()
    worker.join(HARD_DEADLINE_S)
    if worker.is_alive():
        with _orphans_lock:
            _orphans.append(worker)
        try:
            job = _orphan_registry.put(f"orphan:{slug}", OrphanJob(id=new_id(), slug=slug),
                                       project_id=pid)
        except RuntimeError:
            # A deletion tombstone (or an in-progress split) refuses the orphan job. Python cannot
            # stop a stuck thread, and this one can still write into the project through `derive`,
            # so if it is not visible to move/delete admission the parent must not settle while it
            # lives — otherwise deletion moves the directory out from under it and its next write
            # recreates `projects/<pid>` as a partial store. Join instead, exactly as
            # `affiliations._track_orphan`'s caller does; that path was hardened and this identical
            # one was missed.
            log.info("figure orphan admission refused for %s; joining the worker", slug)
            worker.join()
            return True
        with _orphan_registry.lock:
            cell["job"] = job
            _settle_orphan(cell)  # worker may have finished during registration
        log.info("figure derivation timed out for %s", slug)
        return True
    return bool(result.get("stalled"))


def derive_project_figures(papers, *, force: bool = False, derive=None) -> None:
    """Derive/refresh figure manifests for every project paper with an arXiv identity, in the
    graph build's enrichment phase. Best-effort: never raises, never fails a build; each
    paper's manifest+assets persist as they land (they are their own files), so a mid-build
    restart keeps completed papers. The first stalled paper aborts the pass."""
    try:
        if _orphan_alive():
            log.info("a previous figure fetch is still stalled — skipping this build")
            return
        derive = derive or derive_for_slug
        for paper in papers:
            slug = getattr(paper, "slug", None)
            if not slug:
                continue
            if not (getattr(paper, "arxiv_id", "") or store.corpus_arxiv_id_for(slug)):
                continue  # no arXiv identity ⇒ no HTML rendering to look for
            if _derive_with_deadline(slug, force, derive):
                log.info("host stalled — skipping figure enrichment for the rest of "
                         "this build")
                break
    except Exception:  # noqa: BLE001 — enrichment only
        log.warning("figure enrichment pass failed", exc_info=True)
