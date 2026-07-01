"""Deterministic paper retrieval: resolve on arXiv (or take an explicit id / PDF url),
download the PDF, extract and clean the text. No LLM involved.
"""
from __future__ import annotations

import io
import re
from difflib import SequenceMatcher

import feedparser
import httpx
from pypdf import PdfReader

ARXIV_API = "https://export.arxiv.org/api/query"
_UA = {"User-Agent": "ResearchReadingCompanion/0.1 (+local)"}
_ARXIV_ID_RE = re.compile(r"(\d{4}\.\d{4,5})(v\d+)?")


class RetrievalError(Exception):
    pass


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
    try:
        r = httpx.get(ARXIV_API, params=params, headers=_UA, timeout=30, follow_redirects=True)
        r.raise_for_status()
    except httpx.HTTPError as e:
        raise RetrievalError(f"arXiv query failed: {e}") from e
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
    try:
        r = httpx.get(url, headers=_UA, timeout=60, follow_redirects=True)
        r.raise_for_status()
        return r.content
    except httpx.HTTPError as e:
        raise RetrievalError(f"Download failed for {url}: {e}") from e


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

    candidates = search_arxiv(title)
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
