"""Deterministic paper retrieval: resolve on arXiv (or take an explicit id / PDF url),
download the PDF, extract and clean the text. No LLM involved.
"""
from __future__ import annotations

import io
import re
import threading
import time
from difflib import SequenceMatcher

import feedparser
import httpx
from pypdf import PdfReader

ARXIV_API = "https://export.arxiv.org/api/query"
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


def _arxiv_get(url: str, params: dict | None = None, timeout: float = 30) -> httpx.Response:
    """GET against arXiv with pacing + 429/5xx retry. Raises RetrievalError when still throttled
    after retries, with guidance the UI can show verbatim."""
    global _last_arxiv_call
    last_status = None
    for attempt in range(_RETRIES):
        with _arxiv_lock:
            wait = _ARXIV_MIN_INTERVAL_S - (time.time() - _last_arxiv_call)
            if wait > 0:
                time.sleep(wait)
            _last_arxiv_call = time.time()
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
            retry_after = r.headers.get("retry-after")
            try:
                delay = min(float(retry_after), 30.0) if retry_after else 3.0 * (attempt + 1)
            except ValueError:
                delay = 3.0 * (attempt + 1)
            time.sleep(delay)
            continue
        try:
            r.raise_for_status()
        except httpx.HTTPStatusError as e:
            raise RetrievalError(f"arXiv request failed: {e}") from e
        return r
    raise RetrievalError(
        f"arXiv is rate-limiting requests right now (HTTP {last_status}). "
        "Wait a minute and try again, or paste the paper's PDF link in 'Provide a source'.")


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


def _extract_pdf(data: bytes) -> str:
    reader = PdfReader(io.BytesIO(data))
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
    return _extract_pdf(data)


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


def _fetch(url: str) -> bytes:
    # arXiv PDF downloads share the same throttling as the query API, so route them through the
    # paced/retrying getter; other hosts get a plain fetch.
    if "arxiv.org" in url:
        return _arxiv_get(url, timeout=60).content
    try:
        r = httpx.get(url, headers=_UA, timeout=60, follow_redirects=True)
        r.raise_for_status()
        return r.content
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
    m = re.search(r"arxiv\.org/(?:abs|pdf)/(\d{4}\.\d{4,5})", out)
    return m.group(1) if m else None


def retrieve(title: str, arxiv_id: str | None = None, pdf_url: str | None = None,
             min_score: float = 0.62) -> dict:
    """Return {full_text, arxiv_id, source, matched_title, score, candidates?}.

    Resolution order: explicit pdf_url > explicit arxiv_id > title search on arXiv.
    On a weak title match, returns candidates so the UI can ask the user to confirm.
    """
    if pdf_url:
        data = _fetch(pdf_url)
        return {"full_text": _extract_pdf(data), "arxiv_id": None,
                "source": pdf_url, "matched_title": title, "score": 1.0}

    if arxiv_id:
        m = _ARXIV_ID_RE.search(arxiv_id)
        aid = m.group(0) if m else arxiv_id
        url = f"https://arxiv.org/pdf/{aid}"
        try:
            return {"full_text": _extract_pdf(_fetch(url)), "arxiv_id": aid,
                    "source": f"https://arxiv.org/abs/{aid}", "matched_title": title, "score": 1.0}
        except RetrievalError:
            # A supplied arXiv id can be wrong — especially ids extracted from a bibliography by
            # the graph pipeline (often malformed or hallucinated). Rather than hard-fail, fall
            # back to a title search so the paper can still be found. Re-raise only if we have no
            # title to search on.
            if not title:
                raise

    try:
        candidates = search_arxiv(title)
    except RetrievalError:
        # Query API throttled/down — try to locate the id via web search and go straight to
        # the (separately-hosted) PDF. Re-raise the original, actionable error if that fails.
        aid = _arxiv_id_via_web(title)
        if not aid:
            raise
        return {"full_text": _extract_pdf(_fetch(f"https://arxiv.org/pdf/{aid}")),
                "arxiv_id": aid, "source": f"https://arxiv.org/abs/{aid}",
                "matched_title": title, "score": 0.9}
    if not candidates:
        raise RetrievalError(
            "No arXiv match. This paper may not be on arXiv (e.g. an OSDI/SOSP-only paper). "
            "Provide a direct PDF URL or arXiv id.")
    best = candidates[0]
    if best["score"] < min_score:
        return {"needs_confirmation": True, "candidates": candidates[:5], "title": title}
    return {"full_text": _extract_pdf(_fetch(best["pdf_url"])), "arxiv_id": best["arxiv_id"],
            "source": f"https://arxiv.org/abs/{best['arxiv_id']}",
            "matched_title": best["title"], "score": best["score"]}
