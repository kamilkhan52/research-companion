"""Deterministic paper retrieval: resolve on arXiv (or take an explicit id / PDF url),
download the PDF, extract and clean the text. No LLM involved.

DR-139 adds the DOI lane. A DOI is an IDENTIFIER, not a download: resolving `doi.org/10.1145/…`
lands on the publisher's site, and a publisher that fronts its library with a bot challenge (ACM
does — every request from this server gets Cloudflare's interstitial, HTTP 403 with an HTML body)
cannot be downloaded from, no matter how open-access the article is. So a DOI is answered by
asking OpenAlex where the readable copies of that work are — an identifier lookup OpenAlex prices
at zero — and fetching the first one we can actually get. When no copy is fetchable the paper may
still be on arXiv as a preprint, so the DOI's authoritative title feeds the ordinary title search
under a RAISED threshold: a DOI names one specific work, and answering it with a
different-but-similar paper is worse than saying we could not find it.
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

from . import openalex, safe_fetch, spend_control

ARXIV_API = "https://export.arxiv.org/api/query"
# A paper PDF ceiling shared with the cover renderer and the agentic hunt. Comfortably above any
# real paper (the largest arXiv PDFs are single-digit MB) while keeping one hostile URL from
# exhausting memory in the single worker.
MAX_PDF_BYTES = 40_000_000
_UA = {"User-Agent": "ResearchReadingCompanion/0.1 (+local)"}
_ARXIV_ID_RE = re.compile(r"(\d{4}\.\d{4,5})(v\d+)?")
#: A DOI as it appears anywhere: registrant prefix, slash, suffix. Trailing sentence punctuation
#: is stripped by the callers below rather than excluded here, because `.` and `,` are legal
#: inside a DOI suffix and only ambiguous at the very end.
_DOI_RE = re.compile(r"10\.\d{4,9}/[^\s\"'<>]+")
#: How many of a work's listed open-access copies are worth trying. OpenAlex routinely lists a
#: dozen locations for one paper (every aggregator that ever mirrored it), and each attempt here
#: is a full PDF download with its own timeout inside a background retrieval job. The copies are
#: ordered best-first, so the readable one is at the front if it exists at all; trying the whole
#: tail turns one retrieval into minutes of the reader watching nothing happen.
_MAX_OA_COPIES = 4
#: How close an arXiv title match must be before it may stand in for a DOI the reader supplied.
#: Higher than the general `min_score`: a DOI is an exact claim about WHICH paper this is, so a
#: near-miss must reach the human as a confirmation rather than be retrieved silently.
_DOI_TITLE_MIN_SCORE = 0.85

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


def _replace_unpaired_surrogates(text: str) -> str:
    """Return valid Unicode scalar text even when a PDF extractor emits UTF-16 code units.

    pypdf can return lone surrogate code points for malformed embedded fonts. Keep the corpus
    writer strict: repair those extraction artifacts here, while still combining a legitimate
    high/low pair if an extractor returns one instead of the corresponding non-BMP character.
    """
    out: list[str] = []
    index = 0
    while index < len(text):
        code = ord(text[index])
        if 0xD800 <= code <= 0xDBFF:
            if index + 1 < len(text):
                low = ord(text[index + 1])
                if 0xDC00 <= low <= 0xDFFF:
                    scalar = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00)
                    out.append(chr(scalar))
                    index += 2
                    continue
            out.append("\ufffd")
        elif 0xDC00 <= code <= 0xDFFF:
            out.append("\ufffd")
        else:
            out.append(text[index])
        index += 1
    return "".join(out)


def _clean(text: str) -> str:
    text = _replace_unpaired_surrogates(text)
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



# ---------------------------------------------------------------------------- the DOI lane

def _clean_doi(raw: str) -> str | None:
    """A bare DOI from `raw`, or None. Trailing sentence punctuation is dropped: a DOI suffix may
    legally contain `.` or `,`, but one at the very end is almost always the prose around it."""
    match = _DOI_RE.match((raw or "").strip())
    if not match:
        return None
    return match.group(0).rstrip(".,;)") or None


def doi_identifier(value: str) -> str | None:
    """The DOI the reader gave us AS an identifier, or None.

    Deliberately narrow: a doi.org/dx.doi.org link, a `doi:` string, or a bare DOI. Any OTHER
    URL that merely contains a DOI in its path (`…/papers/10.1145/3637867.pdf`) is still a direct
    download and must keep being tried as one — `_doi_in_url` is the fallback for when that
    download fails.
    """
    value = (value or "").strip()
    if not value:
        return None
    link = re.match(r"^https?://(?:dx\.)?doi\.org/(.+)$", value, re.IGNORECASE)
    if link:
        return _clean_doi(link.group(1))
    if value.lower().startswith("doi:"):
        return _clean_doi(value[4:])
    if re.match(r"^[a-z][a-z0-9+.-]*://", value, re.IGNORECASE):
        return None
    return _clean_doi(value)


def _doi_in_url(url: str) -> str | None:
    """A DOI embedded in a URL we failed to download (a publisher's own `/doi/pdf/<doi>` link)."""
    match = _DOI_RE.search(url or "")
    return _clean_doi(match.group(0)) if match else None


def _open_access_record(doi: str) -> dict | None:
    """Where OpenAlex says this work's readable copies are. Best effort: a miss, an outage or the
    operator's spend stop all mean "no help from here", never a failed retrieval."""
    try:
        with openalex.make_client() as client:
            return openalex.open_access(doi=doi, client=client)
    except (httpx.HTTPError, ValueError, KeyError, spend_control.ProviderSpendDisabled):
        return None


def _download_open_access(pdf_urls: list[str]) -> tuple[bytes, str, str] | None:
    """The first listed copy we can actually READ, as (pdf bytes, url, extracted text).

    Every failure is skipped rather than raised: OpenAlex records where a copy is SUPPOSED to be,
    and a link that 403s, 404s or answers with a challenge page is the normal case on at least one
    of them. `looks_like_pdf` is what makes that safe — a Cloudflare interstitial is a 200-with-
    HTML on some hosts, and extracting it would file an error page as the paper's text.

    Extraction happens HERE rather than in the caller, because "we could not fetch it" and "we
    fetched something pypdf cannot read" are the same fact to a reader and must skip the same way.
    Doing it outside made the first copy decisive: a scanned repository copy — which is exactly
    what an older paper's OA copy often is — raises out of `_extract_pdf`, and the remaining
    copies, the arXiv fallthrough and the upload guidance were all never reached.
    """
    for url in pdf_urls[:_MAX_OA_COPIES]:
        arxiv_id = _arxiv_id_from_url(url)
        try:
            data = _fetch(f"https://arxiv.org/pdf/{arxiv_id}" if arxiv_id else url)
        except RetrievalError:
            continue
        if not looks_like_pdf(data):
            continue
        try:
            return data, url, _extract_pdf(data)
        except RetrievalError:
            continue    # unparseable or image-only: the next copy may still be readable
    return None


def _doi_lane(doi: str, title: str) -> tuple[dict | None, str, bool]:
    """Try to retrieve the work this DOI names from an open-access copy.

    Returns (result or None, the DOI's authoritative title if OpenAlex knew one, whether OpenAlex
    listed any copy at all). The last flag separates "we know of no copy" from "we know of copies
    and could not get any", which are different things to tell the reader.
    """
    record = _open_access_record(doi)
    if not record:
        return None, "", False
    resolved_title = record.get("title") or ""
    pdf_urls = record.get("pdf_urls") or []
    got = _download_open_access(pdf_urls)
    if not got:
        return None, resolved_title, bool(pdf_urls)
    data, url, full_text = got
    arxiv_id = _arxiv_id_from_url(url)
    return {
        "full_text": full_text,
        "arxiv_id": arxiv_id,
        "source": f"https://arxiv.org/abs/{arxiv_id}" if arxiv_id else url,
        "matched_title": resolved_title or title,
        "score": 1.0,
        "pdf_bytes": data,
    }, resolved_title, True


def _doi_failure(doi: str, had_copies: bool) -> RetrievalError:
    """What to tell a reader whose DOI we could not turn into a paper. The upload path is named
    because for a challenged publisher it is the only one that works, and the reader's own browser
    gets the article the server cannot (DR-139)."""
    if had_copies:
        detail = ("Every open-access copy of it refused an automated download — publishers such "
                  "as ACM answer this server with a bot challenge.")
    else:
        # Deliberately makes no claim about the arXiv search: this message is built BEFORE that
        # search runs and is also raised on the branches where it never runs at all (no title to
        # search on, or the query API throttled).
        detail = "No open-access copy of it is known."
    return RetrievalError(
        f"Could not retrieve DOI {doi}. {detail} "
        "Open it in a browser and upload the PDF, or paste a direct PDF link.")


def retrieve(title: str, arxiv_id: str | None = None, pdf_url: str | None = None,
             min_score: float = 0.62) -> dict:
    """Return {full_text, arxiv_id, source, matched_title, score, pdf_bytes, candidates?}.

    Resolution order: explicit pdf_url > explicit arxiv_id > title search on arXiv.
    On a weak title match, returns candidates so the UI can ask the user to confirm. `pdf_bytes`
    carries the raw downloaded PDF so a caller can reuse it (e.g. render a cover) without a second
    download; it's absent on the needs-confirmation branch.
    """
    id_from_url = False
    doi_failure: RetrievalError | None = None
    if pdf_url:
        # A pasted arXiv link of any flavor (abs/html/pdf) canonicalizes to the id path below:
        # the abs and html pages are not PDFs, and even a pdf link benefits from the id branch's
        # metadata resolution.
        aid = _arxiv_id_from_url(pdf_url)
        if aid:
            arxiv_id, pdf_url, id_from_url = aid, None, True

    # DR-139 — a DOI given as an identifier is resolved, never downloaded. Both fields can carry
    # one: the client sends a pasted https://doi.org/… link as `pdf_url`, and anything without a
    # scheme (a bare DOI typed into "add a paper") as `arxiv_id`.
    # `title` is in the chain because the Library's "Add" field sends a bare DOI as the paper's
    # TITLE (`parseKnownPaper` recognises only arXiv shapes and `http(s)://`), and its own
    # placeholder says "Title, DOI, or arXiv link". Without this the DOI is title-searched on
    # arXiv as the literal string `ti:"10.1145/…"` and comes back "No arXiv match".
    doi = (doi_identifier(pdf_url or "") or doi_identifier(arxiv_id or "")
           or doi_identifier(title or ""))
    if doi:
        found, resolved_title, had_copies = _doi_lane(doi, title)
        if found:
            return found
        # No copy we can fetch. The paper may still be on arXiv as a preprint, so fall through to
        # the title search — under the DOI's own title when OpenAlex knew it, and a threshold high
        # enough that a near-miss reaches the human as a confirmation instead of being retrieved
        # as though it were the work the DOI named.
        # When the DOI arrived AS the title there is nothing to search on unless OpenAlex knew
        # one — searching arXiv for the literal string `10.1145/…` finds nothing by construction.
        title = resolved_title or ("" if doi_identifier(title or "") else title)
        min_score = max(min_score, _DOI_TITLE_MIN_SCORE)
        doi_failure = _doi_failure(doi, had_copies)
        arxiv_id, pdf_url, id_from_url = None, None, False
        if not title:
            raise doi_failure

    if pdf_url:
        try:
            data = _fetch(pdf_url)
            # Extraction is INSIDE the try on purpose. The fallback has to fire on a CONTENT
            # failure as well as a transport one: a challenged host answers 200-with-HTML on some
            # configurations (this module's own `_download_open_access` says so), and that arrives
            # here not as a refused download but as "that link returned a web page, not a PDF".
            full_text = _extract_pdf(data)
        except RetrievalError:
            # A publisher's own `/doi/pdf/<doi>` link is a DOI we can still resolve elsewhere.
            # Only after the direct download has been tried: a URL carrying a DOI in its path is
            # usually just the copy the reader meant, and it stays the first thing attempted.
            embedded = _doi_in_url(pdf_url)
            found = _doi_lane(embedded, title)[0] if embedded else None
            if not found:
                raise
            return found
        return {"full_text": full_text, "arxiv_id": None,
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
        #
        # Not for a DOI, though. This branch takes whatever the web search surfaced and files it
        # WITHOUT comparing titles at all, which is an accepted trade for a free-text search and
        # the exact hazard the DOI lane exists to avoid: a DOI names one specific work, so a
        # plausible-looking arXiv paper retrieved in its place is worse than saying we failed.
        # Kamil's own paper is not on arXiv, so this is the case that would mis-file, not a
        # hypothetical one.
        if doi_failure:
            # `from None`: the throttle is not why the DOI failed — no copy of it was reachable —
            # and chaining would point the reader's error at an unrelated rate limit.
            raise doi_failure from None
        aid = _arxiv_id_via_web(title)
        if not aid:
            raise
        data = _fetch(f"https://arxiv.org/pdf/{aid}")
        return {"full_text": _extract_pdf(data),
                "arxiv_id": aid, "source": f"https://arxiv.org/abs/{aid}",
                "matched_title": title, "score": 0.9, "pdf_bytes": data}
    if not candidates:
        raise doi_failure or RetrievalError(
            "No arXiv match. This paper may not be on arXiv (e.g. an OSDI/SOSP-only paper). "
            "Provide a direct PDF URL or arXiv id.")
    best = candidates[0]
    if best["score"] < min_score:
        return {"needs_confirmation": True, "candidates": candidates[:5], "title": title}
    data = _fetch(best["pdf_url"])
    return {"full_text": _extract_pdf(data), "arxiv_id": best["arxiv_id"],
            "source": f"https://arxiv.org/abs/{best['arxiv_id']}",
            "matched_title": best["title"], "score": best["score"], "pdf_bytes": data}
