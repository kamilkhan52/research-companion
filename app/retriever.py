"""Deterministic paper retrieval: resolve on arXiv (or take an explicit id / PDF url),
download the PDF, extract and clean the text. No LLM involved.
"""
from __future__ import annotations

import io
import re
import threading
import time
from difflib import SequenceMatcher
from urllib.parse import urlsplit

import feedparser
import httpx
from pypdf import PdfReader

from . import safe_fetch

ARXIV_API = "https://export.arxiv.org/api/query"
# A paper PDF ceiling shared with the cover renderer and the agentic hunt. Comfortably above any
# real paper (the largest arXiv PDFs are single-digit MB) while keeping one hostile URL from
# exhausting memory in the single worker.
MAX_PDF_BYTES = 40_000_000
_UA = {"User-Agent": "ResearchReadingCompanion/0.1 (+local)"}
_ARXIV_ID_RE = re.compile(r"(\d{4}\.\d{4,5})(v\d+)?")

# arXiv asks clients to stay around 1 request / 3 seconds and 429s bursts (which starting a few
# papers in a row — each possibly making an id fetch AND a title search — easily triggers).
# Serialize + pace our arXiv calls, and retry 429/5xx with backoff instead of failing instantly.
_ARXIV_MIN_INTERVAL_S = 3.0
_RETRIES = 3
_arxiv_lock = threading.Lock()
_last_arxiv_call = 0.0


class RetrievalError(Exception):
    pass


def _arxiv_pace() -> None:
    """Block until this process may make its next arXiv request (~1 per 3s, serialized)."""
    global _last_arxiv_call
    with _arxiv_lock:
        wait = _ARXIV_MIN_INTERVAL_S - (time.time() - _last_arxiv_call)
        if wait > 0:
            time.sleep(wait)
        _last_arxiv_call = time.time()


def _throttle_delay(response: httpx.Response, attempt: int) -> float:
    retry_after = response.headers.get("retry-after")
    try:
        return min(float(retry_after), 30.0) if retry_after else 3.0 * (attempt + 1)
    except ValueError:
        return 3.0 * (attempt + 1)


def _throttled_error(last_status) -> RetrievalError:
    return RetrievalError(
        f"arXiv is rate-limiting requests right now (HTTP {last_status}). "
        "Wait a minute and try again, or paste the paper's PDF link in 'Provide a source'.")


def _arxiv_get_bytes(url: str, *, max_bytes: int, timeout: float = 60) -> bytes:
    """Download from arXiv with the same pacing/retry as `_arxiv_get`, but STREAMED under a byte
    ceiling.

    `_arxiv_get` buffers the whole response, which is fine for API queries (small XML) and wrong
    for a PDF: the URL reaching this function can be a caller-supplied `pdf_url` that merely
    happens to be on an arxiv.org host, so "we trust arXiv not to send us 4 GB" is a promise about
    the wrong party. Same limit as every other download path.

    The transfer itself is `safe_fetch.fetch`, not a hand-rolled stream. An earlier version of this
    function streamed with `follow_redirects=True`, which reopened two holes at once: httpx reads a
    redirect response body in full before following it (even in streaming mode), and the redirect
    TARGET never saw `assert_public_url`. `arxiv.org/pdf/<id>` does redirect, so that was the live
    path, not a hypothetical. What belongs here is the arXiv-specific part — pacing and 429/5xx
    retry — and nothing else.
    """
    last_status = None
    for attempt in range(_RETRIES):
        _arxiv_pace()
        try:
            return safe_fetch.fetch(url, max_bytes=max_bytes, timeout=timeout,
                                    headers=_UA).content
        except httpx.HTTPStatusError as e:
            # Retryable throttling/outage, or a real failure. Ordered before HTTPError below,
            # which it subclasses.
            if e.response.status_code == 429 or e.response.status_code >= 500:
                last_status = e.response.status_code
                time.sleep(_throttle_delay(e.response, attempt))
                continue
            raise RetrievalError(f"arXiv request failed: {e}") from e
        except httpx.TimeoutException:
            # arXiv often stalls a throttled connection rather than answering 429.
            last_status = "timeout"
            time.sleep(3.0 * (attempt + 1))
            continue
        except safe_fetch.UnsafeURLError as e:
            raise RetrievalError(f"Refusing to download {url}: {e}") from e
        except safe_fetch.FetchTooLargeError as e:
            raise RetrievalError(f"arXiv download too large: {e}") from e
        except safe_fetch.SafeFetchError as e:
            raise RetrievalError(f"arXiv download refused: {e}") from e
        except httpx.HTTPError as e:
            raise RetrievalError(f"arXiv request failed: {e}") from e
    raise _throttled_error(last_status)


def _arxiv_get(url: str, params: dict | None = None, timeout: float = 30) -> httpx.Response:
    """GET against arXiv with pacing + 429/5xx retry. Raises RetrievalError when still throttled
    after retries, with guidance the UI can show verbatim.

    Buffers the whole response, so it is for the API's small XML replies only — PDFs go through
    `_arxiv_get_bytes`, which streams under a ceiling."""
    last_status = None
    for attempt in range(_RETRIES):
        _arxiv_pace()
        try:
            r = httpx.get(url, params=params, headers=_UA, timeout=timeout, follow_redirects=True)
        except httpx.TimeoutException:
            # When arXiv throttles an IP it often just stalls the connection rather than
            # returning 429 — treat a timeout as retryable, same as an explicit 429.
            last_status = "timeout"
            time.sleep(3.0 * (attempt + 1))
            continue
        except httpx.HTTPError as e:
            raise RetrievalError(f"arXiv request failed: {e}") from e
        if r.status_code == 429 or r.status_code >= 500:
            last_status = r.status_code
            time.sleep(_throttle_delay(r, attempt))
            continue
        try:
            r.raise_for_status()
        except httpx.HTTPStatusError as e:
            raise RetrievalError(f"arXiv request failed: {e}") from e
        return r
    raise _throttled_error(last_status)


def _similar(a: str, b: str) -> float:
    return SequenceMatcher(None, a.lower(), b.lower()).ratio()


def _clean(text: str) -> str:
    text = text.replace("\x0c", "\n")
    # de-hyphenate words split across line breaks: "atten-\ntion" -> "attention"
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)
    # join intra-paragraph single newlines into spaces, keep blank-line paragraph breaks
    text = re.sub(r"(?<!\n)\n(?!\n)", " ", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def looks_like_pdf(data: bytes) -> bool:
    """Whether `data` starts a plausible PDF. The %PDF- marker may legitimately sit after up
    to 1024 bytes of junk (the spec's own allowance), so the window is 1024 + len marker.
    The ONE sniffing policy — the agentic hunt shares it, so a preamble'd PDF is not accepted
    by one path and refused by the other."""
    return b"%PDF-" in data[:1029]


def _extract_pdf(data: bytes, *, upload: bool = False) -> str:
    # A client-supplied link often points at a web page rather than a PDF (DR-087: an
    # arxiv.org/html/ URL). pypdf's own failure for HTML bytes is the cryptic "Stream has
    # ended unexpectedly", which surfaced verbatim on the device — so refuse non-PDF bytes
    # here with a message that tells the reader what to do instead. `upload` swaps the advice:
    # this also serves extract_pdf_bytes (the upload flow), where "paste a link" is nonsense.
    if not looks_like_pdf(data):
        looks_like_html = b"<html" in data[:1024].lower() or data[:256].lstrip()[:1].startswith(b"<")
        what = "a web page" if looks_like_html else "something that is not a PDF"
        advice = ("Upload the paper's PDF file itself." if upload else
                  "Paste a direct PDF link, or the paper's arXiv page (abs/pdf/html all work).")
        source = "That file is" if upload else f"That link returned {what},"
        raise RetrievalError(f"{source} not a PDF. {advice}")
    try:
        reader = PdfReader(io.BytesIO(data))
    except Exception as e:
        # Truncated or malformed PDFs otherwise surface pypdf internals as the job error.
        raise RetrievalError(f"Could not parse the downloaded PDF ({e}).") from e
    pages = []
    for page in reader.pages:
        try:
            pages.append(page.extract_text() or "")
        except Exception:
            pages.append("")
    raw = "\n\n".join(pages)
    if len(raw.strip()) < 200:
        raise RetrievalError("PDF produced almost no extractable text (scanned/figure-only?).")
    return _clean(raw)


def extract_pdf_bytes(data: bytes) -> str:
    """Public wrapper: extract cleaned text from raw PDF bytes (for user-uploaded PDFs)."""
    return _extract_pdf(data, upload=True)


def search_arxiv(title: str, max_results: int = 6) -> list[dict]:
    params = {"search_query": f'ti:"{title}"', "start": 0, "max_results": max_results}
    r = _arxiv_get(ARXIV_API, params=params)
    feed = feedparser.parse(r.text)
    results = []
    for entry in feed.entries:
        arxiv_id = entry.id.split("/abs/")[-1]
        results.append({
            "arxiv_id": arxiv_id,
            "title": re.sub(r"\s+", " ", entry.title).strip(),
            "abstract": re.sub(r"\s+", " ", getattr(entry, "summary", "")).strip(),
            "pdf_url": f"https://arxiv.org/pdf/{arxiv_id}",
            "score": _similar(title, entry.title),
        })
    results.sort(key=lambda x: x["score"], reverse=True)
    return results


def fetch_arxiv_metadata(arxiv_id: str) -> dict | None:
    """Title + abstract for a known arXiv id (no PDF download), or None if the id resolves to
    nothing. arXiv answers a bad id with an empty feed or a stub entry titled "Error"."""
    m = _ARXIV_ID_RE.search(arxiv_id)
    aid = m.group(1) if m else arxiv_id
    r = _arxiv_get(ARXIV_API, params={"id_list": aid, "max_results": 1})
    feed = feedparser.parse(r.text)
    if not feed.entries:
        return None
    entry = feed.entries[0]
    title = re.sub(r"\s+", " ", entry.title).strip()
    abstract = re.sub(r"\s+", " ", getattr(entry, "summary", "")).strip()
    if not abstract or title.lower() == "error":
        return None
    return {"arxiv_id": aid, "title": title, "abstract": abstract}


def search_arxiv_raw(query: str, max_results: int = 25, sort_by: str = "relevance") -> list[dict]:
    """Broad arXiv search for discovery: takes a raw search_query expression (all:/abs:/ti:/
    cat: terms, AND/OR, quoted phrases) rather than an exact title, and returns richer entries
    (authors, year, category) than search_arxiv. Same paced/retrying transport."""
    params = {"search_query": query, "start": 0, "max_results": max_results,
              "sortBy": sort_by, "sortOrder": "descending"}
    r = _arxiv_get(ARXIV_API, params=params)
    feed = feedparser.parse(r.text)
    results = []
    for entry in feed.entries:
        raw_id = entry.id.split("/abs/")[-1]
        m = _ARXIV_ID_RE.search(raw_id)
        arxiv_id = m.group(1) if m else raw_id  # versionless, so dedupe across queries works
        year = None
        published = getattr(entry, "published", "")
        if len(published) >= 4 and published[:4].isdigit():
            year = int(published[:4])
        primary = getattr(entry, "arxiv_primary_category", None) or {}
        results.append({
            "arxiv_id": arxiv_id,
            "title": re.sub(r"\s+", " ", entry.title).strip(),
            "abstract": re.sub(r"\s+", " ", getattr(entry, "summary", "")).strip(),
            "authors": [a.get("name", "") for a in getattr(entry, "authors", []) if a.get("name")],
            "year": year,
            "category": primary.get("term") or "",
            "url": f"https://arxiv.org/abs/{arxiv_id}",
            "pdf_url": f"https://arxiv.org/pdf/{arxiv_id}",
        })
    return results


def _is_arxiv_host(url: str) -> bool:
    """Whether `url`'s HOST is arxiv.org (or a subdomain).

    Matched against the parsed hostname, never as a substring of the whole URL: `url` can be a
    client-supplied `pdf_url`, and `"arxiv.org" in url` is true of
    `http://169.254.169.254/latest/meta-data/#arxiv.org` and of any URL with `?ref=arxiv.org`.
    That substring test used to select the unguarded arXiv branch below, which re-opened the whole
    of P0-14 for anyone who appended a fragment.

    Uses `safe_fetch.normalized_host` rather than `urlparse` so this decision is made about the
    same name the guard validates and httpx connects to. An unparseable host yields "" and falls
    through to the guarded path — the safe direction, costing only arXiv's request pacing.
    """
    # The trailing dot is stripped for THIS comparison only. normalized_host keeps it because the
    # resolver must be asked the same question httpx asks; `arxiv.org.` and `arxiv.org` are the
    # same host for the purpose of "should this be paced as an arXiv request".
    host = safe_fetch.normalized_host(url).rstrip(".")
    return host == "arxiv.org" or host.endswith(".arxiv.org")


def _arxiv_id_from_url(url: str) -> str | None:
    """The arXiv id in `url`'s PATH, if `url` is a real arXiv paper URL in any flavor —
    abs, pdf, or html, with or without a version suffix. None otherwise.

    Host-validated first (`_is_arxiv_host`, the same predicate `_fetch` routes on) and parsed
    from the urlsplit path, so `?ref=arxiv.org`, `#arxiv.org` and path-segment lookalikes on
    other hosts never match. Exists because a pasted `arxiv.org/html/<id>` link used to fall
    through as a raw pdf_url: the HTML page bytes went to pypdf, whose truncated-stream error
    surfaced verbatim on the device (DR-087)."""
    if not _is_arxiv_host(url):
        return None
    try:
        path = urlsplit(url).path
    except ValueError:
        return None
    # New-style ids (2007+) and old-style archive ids (e.g. cond-mat/0703185) — an /abs/ link
    # for a pre-2007 paper otherwise falls through to the raw-URL branch and fails with a
    # message claiming abs links work.
    m = re.match(
        r"^/(?:abs|pdf|html)/(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Za-z]{2})?/\d{7}(?:v\d+)?)",
        path)
    return m.group(1) if m else None


def _fetch(url: str) -> bytes:
    # arXiv PDF downloads share the same throttling as the query API, so route them through the
    # paced/retrying getter rather than safe_fetch. Still validated first, and still byte-capped:
    # routing on the hostname stops an attacker steering an arbitrary address into this branch, but
    # the URL here can be a caller-supplied pdf_url that merely lives on an arxiv.org host, so this
    # path gets the same ceiling as every other download.
    if _is_arxiv_host(url):
        try:
            safe_fetch.assert_public_url(url)
        except safe_fetch.UnsafeURLError as e:
            raise RetrievalError(f"Refusing to download {url}: {e}") from e
        return _arxiv_get_bytes(url, max_bytes=MAX_PDF_BYTES, timeout=60)
    # Everything else may be a client-supplied `pdf_url` (session/start), so it goes through the
    # guarded fetcher: public destinations only, every redirect hop re-checked, hard byte ceiling.
    try:
        return safe_fetch.fetch(url, max_bytes=MAX_PDF_BYTES, timeout=60, headers=_UA).content
    except safe_fetch.UnsafeURLError as e:
        raise RetrievalError(f"Refusing to download {url}: {e}") from e
    except safe_fetch.FetchTooLargeError as e:
        raise RetrievalError(f"Download too large: {e}") from e
    except safe_fetch.SafeFetchError as e:
        # Base class last: a new refusal type must never escape this layer untranslated.
        raise RetrievalError(f"Download refused for {url}: {e}") from e
    except httpx.HTTPError as e:
        raise RetrievalError(f"Download failed for {url}: {e}") from e


def _arxiv_id_via_web(title: str) -> str | None:
    """Rate-limit fallback: when the arXiv query API is throttled, find the paper's arXiv id
    with the web-search chain instead (research_tools; Firecrawl et al.). The PDF host
    (arxiv.org) is separate infrastructure from the query API (export.arxiv.org) and is
    typically still reachable, so an id is all we need to proceed."""
    try:
        from . import research_tools  # lazy: keeps retriever free of the tools layer otherwise
        out = research_tools.web_search(f"arXiv page for the paper: {title}", [f"{title} arxiv"])
    except Exception:
        return None
    m = re.search(r"arxiv\.org/(?:abs|pdf|html)/(\d{4}\.\d{4,5})", out)
    return m.group(1) if m else None


def retrieve(title: str, arxiv_id: str | None = None, pdf_url: str | None = None,
             min_score: float = 0.62) -> dict:
    """Return {full_text, arxiv_id, source, matched_title, score, pdf_bytes, candidates?}.

    Resolution order: explicit pdf_url > explicit arxiv_id > title search on arXiv.
    On a weak title match, returns candidates so the UI can ask the user to confirm. `pdf_bytes`
    carries the raw downloaded PDF so a caller can reuse it (e.g. render a cover) without a second
    download; it's absent on the needs-confirmation branch.
    """
    id_from_url = False
    if pdf_url:
        # A pasted arXiv link of any flavor (abs/html/pdf) canonicalizes to the id path below:
        # the abs and html pages are not PDFs, and even a pdf link benefits from the id branch's
        # metadata resolution.
        aid = _arxiv_id_from_url(pdf_url)
        if aid:
            arxiv_id, pdf_url, id_from_url = aid, None, True
    if pdf_url:
        data = _fetch(pdf_url)
        return {"full_text": _extract_pdf(data), "arxiv_id": None,
                "source": pdf_url, "matched_title": title, "score": 1.0, "pdf_bytes": data}

    if arxiv_id:
        m = _ARXIV_ID_RE.search(arxiv_id)
        aid = m.group(0) if m else arxiv_id
        url = f"https://arxiv.org/pdf/{aid}"
        try:
            data = _fetch(url)
            # An id pasted into the add flow often entered the reading list as "arXiv …".
            # Resolve its canonical title while this background retrieval already owns the
            # arXiv work. Failure is non-fatal: the PDF can still be read under the user's title.
            try:
                metadata = fetch_arxiv_metadata(aid)
            except RetrievalError:
                metadata = None
            return {"full_text": _extract_pdf(data), "arxiv_id": aid,
                    "source": f"https://arxiv.org/abs/{aid}",
                    "matched_title": (metadata or {}).get("title") or title,
                    "score": 1.0, "pdf_bytes": data}
        except RetrievalError:
            # A supplied arXiv id can be wrong — especially ids extracted from a bibliography by
            # the graph pipeline (often malformed or hallucinated). Rather than hard-fail, fall
            # back to a title search so the paper can still be found. Re-raise if we have no
            # title to search on — or if the id came from an explicitly pasted URL: the reader
            # pastes a link precisely to override the automatic match, so quietly retrieving a
            # DIFFERENT best-title-match paper would be worse than the error (the raw pdf_url
            # branch this replaced always surfaced its failure).
            if not title or id_from_url:
                raise

    try:
        candidates = search_arxiv(title)
    except RetrievalError:
        # Query API throttled/down — try to locate the id via web search and go straight to
        # the (separately-hosted) PDF. Re-raise the original, actionable error if that fails.
        aid = _arxiv_id_via_web(title)
        if not aid:
            raise
        data = _fetch(f"https://arxiv.org/pdf/{aid}")
        return {"full_text": _extract_pdf(data),
                "arxiv_id": aid, "source": f"https://arxiv.org/abs/{aid}",
                "matched_title": title, "score": 0.9, "pdf_bytes": data}
    if not candidates:
        raise RetrievalError(
            "No arXiv match. This paper may not be on arXiv (e.g. an OSDI/SOSP-only paper). "
            "Provide a direct PDF URL or arXiv id.")
    best = candidates[0]
    if best["score"] < min_score:
        return {"needs_confirmation": True, "candidates": candidates[:5], "title": title}
    data = _fetch(best["pdf_url"])
    return {"full_text": _extract_pdf(data), "arxiv_id": best["arxiv_id"],
            "source": f"https://arxiv.org/abs/{best['arxiv_id']}",
            "matched_title": best["title"], "score": best["score"], "pdf_bytes": data}
