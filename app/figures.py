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
from datetime import UTC, datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse

import httpx

from . import config, logging_config, store
from .fileio import atomic_write_bytes, atomic_write_text

log = logging_config.get("figures")

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


# --- paths -----------------------------------------------------------------------------------

def figures_dir() -> Path:
    return config.state_dir() / "figures"


def manifest_path(slug: str) -> Path:
    return figures_dir() / f"{slug}.json"


def asset_dir(slug: str) -> Path:
    return figures_dir() / slug


def asset_path(slug: str, asset: str) -> Path | None:
    """Resolve a manifest asset filename to its cached file — the trust boundary for the
    serving route. Only plain filenames the sanitizer could have produced are accepted."""
    if not asset or _SAFE_ASSET_CHARS.search(asset) or asset.startswith("."):
        return None
    return asset_dir(slug) / asset


# --- manifest I/O ----------------------------------------------------------------------------

def read_manifest(slug: str) -> dict | None:
    try:
        return json.loads(manifest_path(slug).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _write_manifest(slug: str, manifest: dict) -> None:
    figures_dir().mkdir(parents=True, exist_ok=True)
    atomic_write_text(manifest_path(slug), json.dumps(manifest, indent=1))


def _drop(slug: str) -> None:
    """Remove a slug's manifest + assets (identity changed or vanished)."""
    try:
        manifest_path(slug).unlink(missing_ok=True)
        shutil.rmtree(asset_dir(slug), ignore_errors=True)
    except OSError:
        pass


def manifest_for(slug: str) -> dict | None:
    """The slug's manifest, but only when it matches the paper's CURRENT identity — a
    just-corrected retrieval must never serve the previous paper's figures."""
    manifest = read_manifest(slug)
    if not manifest:
        return None
    base = store.arxiv_base_id(store.arxiv_id_for(slug) or store.corpus_arxiv_id_for(slug))
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


def _resolves_public(url: str) -> bool:
    """Reject a host that resolves to any private/loopback/link-local address (defense against
    DNS games behind an allowed-looking name)."""
    host = urlparse(url).hostname or ""
    try:
        infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
    except OSError:
        return False
    addresses = [info[4][0] for info in infos]
    if not addresses:
        return False
    for raw in addresses:
        try:
            ip = ipaddress.ip_address(raw)
        except ValueError:
            return False
        if (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved
                or ip.is_multicast or ip.is_unspecified):
            return False
    return True


def _url_ok(url: str) -> bool:
    return _host_allowed(url) and _resolves_public(url)


# --- fetchers (the only network in this module) ----------------------------------------------

def _open_client() -> httpx.Client:
    # follow_redirects=False: every hop is revalidated against the allowlist by the loops
    # below. No cookies, no app credentials.
    return httpx.Client(timeout=FETCH_TIMEOUT, follow_redirects=False,
                        headers={"User-Agent": "research-companion-figures/1.0"})


def _fetch_html(base_id: str) -> tuple[str, str] | None:
    """(final_url, html_text) for the paper's HTML rendering, or None. Tries arXiv's native
    HTML first (newer papers), then ar5iv (older corpus)."""
    candidates = (
        f"https://arxiv.org/html/{base_id}",
        f"https://ar5iv.labs.arxiv.org/html/{base_id}",
    )
    with _open_client() as client:
        for url in candidates:
            try:
                for _ in range(MAX_REDIRECTS):
                    if not _url_ok(url):
                        break
                    resp = client.get(url)
                    if resp.status_code in _REDIRECT_CODES:
                        location = resp.headers.get("location")
                        if not location:
                            break
                        url = urljoin(url, location)
                        continue
                    if resp.status_code != 200:
                        break
                    ctype = resp.headers.get("content-type", "").split(";")[0].strip().lower()
                    if ctype != "text/html":
                        break
                    return url, resp.text
            except httpx.HTTPError as e:
                log.info("figure HTML fetch failed for %s: %s", base_id, str(e)[:120])
    return None


def _fetch_image(url: str) -> tuple[bytes, str] | None:
    """(bytes, extension) for one figure image, streamed under the size cap, or None."""
    with _open_client() as client:
        try:
            for _ in range(MAX_REDIRECTS):
                if not _url_ok(url):
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


def derive_for_slug(slug: str, *, force: bool = False,
                    fetch_html=None, fetch_image=None) -> dict | None:
    """Derive (or return the cached) figure manifest for one paper. Never raises past its own
    boundary in the job-facing wrappers below; callers on job threads may call it directly
    and handle/ignore errors. Returns None when the paper has no arXiv identity."""
    aid = store.arxiv_id_for(slug) or store.corpus_arxiv_id_for(slug)
    base = store.arxiv_base_id(aid)
    existing = read_manifest(slug)
    if not base:
        if existing is not None:
            _drop(slug)  # no identity — never keep (or serve) figures we can't attribute
        return None
    if existing is not None and existing.get("arxiv_id") != base:
        _drop(slug)  # identity correction: the old paper's figures must not survive
        existing = None
    if existing is not None and not force:
        if existing.get("status") == "done":
            return existing
        if time.time() - float(existing.get("fetched_ts") or 0) < NONE_RETRY_S:
            return existing  # recent "no HTML" result — don't re-poll arXiv every build
    fetch_html = fetch_html or _fetch_html
    fetch_image = fetch_image or _fetch_image

    fetched = fetch_html(base)
    if fetched is None:
        manifest = {"version": 1, "arxiv_id": base, "source": None, "status": "none",
                    "fetched_at": _now_iso(), "fetched_ts": time.time(), "figures": []}
        _write_manifest(slug, manifest)
        return manifest

    final_url, html_text = fetched
    parsed = parse_figures(html_text)
    # Rebuild the asset dir from scratch so a re-derivation never leaves stale images behind.
    shutil.rmtree(asset_dir(slug), ignore_errors=True)
    entries: list[dict] = []
    base_url = _page_base(final_url)
    for index, fig in enumerate(parsed[:MAX_FIGURES]):
        src = urljoin(base_url, fig["src"])
        if not _host_allowed(src):  # data: URIs and off-allowlist hosts drop here
            continue
        if urlparse(src).path.lower().endswith(".svg"):
            continue
        image = fetch_image(src)
        if image is None:
            continue
        payload, ext = image
        stem = _SAFE_ASSET_CHARS.sub("-", fig["id"]) or "fig"
        asset = f"{index + 1:02d}-{stem}{ext}"
        target = asset_dir(slug) / asset
        target.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_bytes(target, payload)
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
    manifest = {"version": 1, "arxiv_id": base, "source": final_url, "status": "done",
                "fetched_at": _now_iso(), "fetched_ts": time.time(), "figures": entries}
    _write_manifest(slug, manifest)
    log.info("figure manifest for %s: %d figures from %s", slug, len(entries), final_url)
    return manifest


def warm_async(slug: str) -> None:
    """Fire-and-forget cache warm, called on the retrieval job thread right after the paper's
    text persists — so figures are usually ready before the first turn ever mentions one.
    Runs on its own daemon thread so it never delays the retrieval job's `done` (or the
    chained auto-analysis); the graph build's enrichment pass backfills anything this misses.
    The thread rebinds the project contextvar (invariant 2)."""
    pid = config.active_project_id()

    def _do() -> None:
        token = config.set_active_project(pid)
        try:
            derive_for_slug(slug)
        except Exception as e:  # noqa: BLE001 — cache warm only, never surfaces
            log.info("figure warm failed for %s: %s", slug, str(e)[:120])
        finally:
            config.reset_active_project(token)

    threading.Thread(target=_do, daemon=True, name="figures-warm").start()


# --- graph-build enrichment pass -------------------------------------------------------------

# Same stall containment as affiliations: a worker past its deadline can't be killed, so it's
# orphaned (daemon — dies with the process) and the next pass is skipped while one is alive.
_orphans: list[threading.Thread] = []
_orphans_lock = threading.Lock()


def _orphan_alive() -> bool:
    with _orphans_lock:
        _orphans[:] = [t for t in _orphans if t.is_alive()]
        return bool(_orphans)


def _derive_with_deadline(slug: str, force: bool, derive) -> bool:
    """True when the worker timed out (caller aborts the pass). In-thread failures are a
    retryable miss, never an exception on the build thread."""
    pid = config.active_project_id()

    def _do() -> None:
        token = config.set_active_project(pid)
        try:
            derive(slug, force=force)
        except Exception as e:  # noqa: BLE001
            log.info("figure derivation errored for %s: %s", slug, str(e)[:120])
        finally:
            config.reset_active_project(token)

    worker = threading.Thread(target=_do, daemon=True, name="figures")
    worker.start()
    worker.join(HARD_DEADLINE_S)
    if worker.is_alive():
        with _orphans_lock:
            _orphans.append(worker)
        log.info("figure derivation timed out for %s", slug)
        return True
    return False


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
