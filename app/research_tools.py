"""Read-only research tools the analyst agent can call mid-discussion (wired into the agent
harness in a later step). Two families:

  * Local, project-scoped: read other papers' cached text / committed notes, list what's in the
    project, find related papers, read the aggregate Project Notes. These make no external calls
    and resolve within the active project via the store layer (config.project_dir()). Paper text
    remains untrusted model input and is returned in a typed provenance envelope.

  * Web: fetch a URL's readable text, and search the web. These reach outside the corpus, so
    they carry real safety obligations, enforced here: http(s)-only, per-redirect-hop blocking
    of private/loopback/link-local/reserved addresses (SSRF — incl. cloud metadata at
    169.254.169.254), hard byte/char caps, short timeouts, and text-only content. Both run a
    PROVIDER CHAIN and fall through on failure, so neither requires a key: `web_search` tries
    Brave, then Firecrawl, then keyless DuckDuckGo; `web_fetch` tries Firecrawl, then a direct
    guarded fetch. (Until 2026-07-29 this docstring required a Brave Search API key while there
    had never been any Brave code in the repo — the claim preceded the integration by a year.
    Real Brave support landed 2026-08-12, as the primary search provider: flat per-request
    pricing makes it the most honestly meterable of the three.)

    Every paid provider call is METERED at a pinned per-call price (`spend_limits` — Brave per
    request, Firecrawl per credit) via `usage.record`, which also feeds the surrounding turn's
    spend reservation. This closed M3's last unmetered seam: these APIs return no cost in the
    response, so like TTS the price is known before the call rather than read after it. The
    keyless fallbacks (DuckDuckGo, direct fetch) record zero-cost calls for visibility.

Everything is READ-ONLY: nothing here mutates project files, git, or settings. Tools return
plain strings meant for the model to read; on bad input they return a helpful message rather
than raising, so the agent can recover — except genuine configuration errors (e.g. web search
not configured), which raise ToolError so the failure is explicit.
"""
from __future__ import annotations

import html
import os
import re
from urllib.parse import parse_qs, unquote, urlparse

import httpx

from . import (
    config,
    graph_store,
    logging_config,
    model_provenance,
    safe_fetch,
    sessions,
    spend_control,
    spend_limits,
    store,
    usage,
)

log = logging_config.get("research_tools")

# Caps: keep tool output bounded so a single call can't blow the model's context or stall a turn.
MAX_PAPER_TEXT_CHARS = 16_000
MAX_NOTES_CHARS = 12_000
MAX_WEB_TEXT_CHARS = 12_000        # cap the text handed back from a web search/fetch
WEB_TIMEOUT_S = 45.0
MAX_SEARCH_OBJECTIVE_CHARS = 500
MAX_SEARCH_QUERY_CHARS = 240
MAX_FETCH_URL_CHARS = 2_048

FIRECRAWL_BASE = "https://api.firecrawl.dev/v2"
BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search"

# DuckDuckGo HTML — a keyless last resort so web search works even when the paid providers are
# out of credit. Lower quality (no rich excerpts) but always available.
DDG_HTML_URL = "https://html.duckduckgo.com/html/"


class ToolError(Exception):
    """A tool cannot proceed for a reason the user must fix (e.g. web search not configured)."""


# ---------------------------------------------------------------- local, project-scoped tools

def _known_slugs() -> set[str]:
    return {p.slug for p in store.list_papers(sessions.session_states())}


def list_project_papers() -> str:
    """List the papers in the current project, with slug, title, and whether notes exist —
    so the agent knows what it can read via read_paper_text / read_paper_notes."""
    papers = store.list_papers(sessions.session_states())
    if not papers:
        return "This project has no papers yet."
    lines = []
    for p in papers:
        flags = []
        if p.has_notes:
            flags.append("has notes")
        flags.append("read" if p.list_status == "read" else "unread")
        lines.append(f"- {p.slug}: \"{p.title}\" ({', '.join(flags)})")
    return model_provenance.frame(
        "project_paper_index", "Papers in this project:\n" + "\n".join(lines),
    )


def read_paper_text(slug: str) -> str:
    """Return the cached full text of another project paper (truncated). Use to compare methods
    or claims against a paper the user has retrieved."""
    if slug not in _known_slugs():
        return f"No paper with slug '{slug}' in this project. Call list_project_papers to see options."
    text = store.read_full_text(slug)
    if not text.strip():
        return f"Paper '{slug}' has no cached full text (it may not have been retrieved yet)."
    title = store.title_for(slug)
    if len(text) > MAX_PAPER_TEXT_CHARS:
        text = text[:MAX_PAPER_TEXT_CHARS] + "\n\n[...truncated...]"
    return model_provenance.frame("project_paper_full_text", text, source=f"{slug}: {title}")


def read_paper_notes(slug: str) -> str:
    """Return the committed reading notes for another project paper, if the user has read it."""
    if slug not in _known_slugs():
        return f"No paper with slug '{slug}' in this project. Call list_project_papers to see options."
    if not store.has_notes(slug):
        return f"Paper '{slug}' has no committed notes yet."
    notes = store.read_notes(slug)
    if len(notes) > MAX_NOTES_CHARS:
        notes = notes[:MAX_NOTES_CHARS] + "\n\n[...truncated...]"
    return model_provenance.frame(
        "committed_paper_notes", notes, source=f"{slug}: {store.title_for(slug)}",
    )


def related_papers(slug: str) -> str:
    """List project papers related to `slug`: ones it cites and ones that cite it (from the
    reading list's citations, enriched by the reference graph when it's been built)."""
    if slug not in _known_slugs():
        return f"No paper with slug '{slug}' in this project. Call list_project_papers to see options."
    papers = {p.slug: p for p in store.list_papers(sessions.session_states())}
    cites = set(papers[slug].cites or [])
    cited_by = {s for s, p in papers.items() if slug in (p.cites or [])}

    # Enrich with in-project graph edges if a graph exists (source/target are node ids; for
    # project papers the node id is the slug).
    data = graph_store.load()
    graph = data.get("graph")
    if isinstance(graph, dict):
        for e in graph.get("edges", []):
            if e.get("source") == slug and e.get("target") in papers:
                cites.add(e["target"])
            if e.get("target") == slug and e.get("source") in papers:
                cited_by.add(e["source"])

    # An empty answer must say what it is NOT claiming. This tool sees only in-project
    # relationships, and without a built map it sees only the reading list's own `cites` links —
    # a model that read "(none)" as "this paper has no references" contradicted the bibliography
    # sitting in the same context (DR-054), on projects whose map was simply absent (DR-046).
    #
    # "Map built" means the graph EXISTS, matching `has_graph` (see graph.py's status guard): a
    # freshly built or interrupted build persists `edges: []`, and gating on edge presence told
    # the model "the map has not been built" about a map that had been — the same failure class,
    # pointed the other way. These notes are DECLARATIVE facts about what this lookup could see;
    # the standing instruction never to report a paper as having no references on this tool's
    # basis lives in the analyst tool guidance (the trusted channel), not inside a provenance
    # envelope the model is told to treat as evidence-only.
    if graph is not None:
        none_marker = "  (none among this project's papers)"
        extraction = graph_store.get_paper_extraction(data, slug)
        if extraction is not None and extraction.get("status") == "done":
            scope_note = ""
        else:
            scope_note = ("\n\nNote: this paper has not itself been analyzed into the reference "
                          "map (no completed extraction); only other papers' edges and "
                          "reading-list links were available to this lookup. Its own "
                          "bibliography is in its full text.")
    else:
        none_marker = "  (none found in the reading list's own citation links)"
        scope_note = ("\n\nNote: this project's reference map has not been built; only "
                      "reading-list citation links were available to this lookup. The paper's "
                      "own bibliography is in its full text.")

    def _fmt(slugs: set[str]) -> str:
        slugs = {s for s in slugs if s in papers and s != slug}
        if not slugs:
            return none_marker
        return "\n".join(f"  - {s}: \"{papers[s].title}\"" for s in sorted(slugs))

    return model_provenance.frame(
        "project_relationship_metadata",
        f"Papers '{slug}' cites (among papers IN this project):\n{_fmt(cites)}\n\n"
        f"Papers IN this project that cite '{slug}':\n{_fmt(cited_by)}"
        f"{scope_note}",
        source=slug,
    )


def read_working_notes() -> str:
    """Return the project's aggregate Project Notes (the synthesis across all papers read)."""
    notes = store.read_synthesis()
    if not notes.strip():
        return "The project has no Project Notes yet."
    if len(notes) > MAX_NOTES_CHARS:
        notes = notes[:MAX_NOTES_CHARS] + "\n\n[...truncated...]"
    return model_provenance.frame("working_notes", notes)


# ----------------------------------------------------------------------------------- web tools
# Web search/fetch go through a provider CHAIN so they keep working as credit/availability
# changes: Brave -> Firecrawl -> DuckDuckGo (keyless). Whichever is configured-and-working
# wins, in that order; the keyless DDG fallback means search almost always returns something.
# All web content is UNTRUSTED — the agent treats it as data to evaluate/cite, never as
# instructions (see agent_harness guidance).

def _firecrawl_key() -> str:
    return os.environ.get("FIRECRAWL_API_KEY") or config.load_settings().get("firecrawl_api_key") or ""


def _cap(text: str) -> str:
    text = text.strip()
    return text if len(text) <= MAX_WEB_TEXT_CHARS else text[:MAX_WEB_TEXT_CHARS] + "\n\n[...truncated...]"


def _has_url_credentials(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except ValueError:
        return False  # `safe_fetch.assert_public_url` below returns the typed refusal.
    return parsed.username is not None or parsed.password is not None


def _record_web_cost(operation: str, provider: str, cost_nanousd: int) -> None:
    """Meter one provider call at its pinned price (spend_limits), attributing it to the active
    scope AND the surrounding turn's reservation — `usage.record` does both. `estimated=True`
    because the price is pinned from a rate card, not read from a usage payload (there is none).
    A zero-cost call (the keyless fallbacks) is still recorded so the call count is visible."""
    usage.record(operation, provider, {"cost": cost_nanousd / 1e9}, estimated=True)


# ---- provider: Brave Search (https://brave.com/search/api/) ----

def _brave_key() -> str:
    return os.environ.get("BRAVE_SEARCH_API_KEY") or config.load_settings().get("brave_search_api_key") or ""


def _brave_search(objective: str, queries: list[str], *, client: httpx.Client | None = None) -> str:
    key = _brave_key()
    if not key:
        raise ToolError("no brave key")
    own = client is None
    client = client or httpx.Client(timeout=WEB_TIMEOUT_S)
    try:
        try:
            spend_control.require_enabled()
        except spend_control.ProviderSpendDisabled as e:
            raise ToolError(str(e)) from e
        resp = client.get(BRAVE_SEARCH_URL,
                          params={"q": queries[0] if queries else objective, "count": 5},
                          headers={"X-Subscription-Token": key, "Accept": "application/json"})
        # Billed per REQUEST, so the request that just returned is the metered event — including
        # a 200 with no results. Non-200s (401 bad key, 429 throttled) are not billed requests.
        if resp.status_code != 200:
            raise ToolError(f"brave HTTP {resp.status_code}")
        _record_web_cost("web_search", "brave", spend_limits.brave_query_cost_nanousd())
        results = ((resp.json() or {}).get("web") or {}).get("results") or []
        if not results:
            raise ToolError("brave returned no results")
        out = [f"Web results for \"{objective}\":"]
        for r in results[:5]:
            out.append(f"- {r.get('title', '(untitled)')}\n  {r.get('url', '')}\n  "
                       f"{(r.get('description') or '')[:300]}")
        return "\n".join(out)
    except httpx.HTTPError as e:
        raise ToolError(f"brave transport failed ({type(e).__name__})") from e
    finally:
        if own:
            client.close()


# ---- provider: Firecrawl (https://firecrawl.dev) ----

#: Firecrawl bills search at 2 credits per 10 results; our fixed `limit: 5` is half that.
_FIRECRAWL_SEARCH_CREDITS = 1
_FIRECRAWL_SCRAPE_CREDITS_PER_PAGE = 1


def _firecrawl_search(objective: str, queries: list[str], *, client: httpx.Client | None = None) -> str:
    key = _firecrawl_key()
    if not key:
        raise ToolError("no firecrawl key")
    own = client is None
    client = client or httpx.Client(timeout=WEB_TIMEOUT_S)
    try:
        try:
            spend_control.require_enabled()
        except spend_control.ProviderSpendDisabled as e:
            raise ToolError(str(e)) from e
        resp = client.post(f"{FIRECRAWL_BASE}/search",
                           headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                           json={"query": queries[0] if queries else objective, "limit": 5})
        if resp.status_code != 200:
            raise ToolError(f"firecrawl HTTP {resp.status_code}")
        _record_web_cost("web_search", "firecrawl",
                         _FIRECRAWL_SEARCH_CREDITS * spend_limits.firecrawl_credit_cost_nanousd())
        data = (resp.json() or {}).get("data") or []
        # v2 groups results by source ({"web": [...], "news": [...]}); v1 returned a flat list.
        results = data.get("web") or data.get("news") or [] if isinstance(data, dict) else data
        if not results:
            raise ToolError("firecrawl returned no results")
        out = [f"Web results for \"{objective}\":"]
        for r in results[:5]:
            out.append(f"- {r.get('title', '(untitled)')}\n  {r.get('url', '')}\n  "
                       f"{(r.get('description') or '')[:300]}")
        return "\n".join(out)
    except httpx.HTTPError as e:
        raise ToolError(f"firecrawl transport failed ({type(e).__name__})") from e
    finally:
        if own:
            client.close()


def _firecrawl_fetch(urls: list[str], objective: str, *, client: httpx.Client | None = None) -> str:
    key = _firecrawl_key()
    if not key:
        raise ToolError("no firecrawl key")
    own = client is None
    client = client or httpx.Client(timeout=WEB_TIMEOUT_S)
    try:
        chunks = []
        for url in urls[:4]:
            try:
                spend_control.require_enabled()
            except spend_control.ProviderSpendDisabled as e:
                raise ToolError(str(e)) from e
            resp = client.post(f"{FIRECRAWL_BASE}/scrape",
                               headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                               json={"url": url, "formats": ["markdown"]})
            if resp.status_code != 200:
                raise ToolError(f"firecrawl HTTP {resp.status_code}")
            # Metered per page as each succeeds, not once at the end: a later page's failure
            # aborts the loop and falls through to the direct fetcher, but the pages already
            # scraped were already billed — their cost must not vanish with the fallback.
            _record_web_cost("web_fetch", "firecrawl",
                             _FIRECRAWL_SCRAPE_CREDITS_PER_PAGE * spend_limits.firecrawl_credit_cost_nanousd())
            md = ((resp.json() or {}).get("data") or {}).get("markdown", "")
            chunks.append(f"# {url}\n\n{md}")
        return "\n\n---\n\n".join(chunks)
    except httpx.HTTPError as e:
        raise ToolError(f"firecrawl transport failed ({type(e).__name__})") from e
    finally:
        if own:
            client.close()


# ---- provider: DuckDuckGo HTML (keyless fallback) ----

_DDG_A_RE = re.compile(r'result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>', re.S)
_DDG_SNIP_RE = re.compile(r'result__snippet"[^>]*>(.*?)</a>', re.S)
_TAGS_RE = re.compile(r"<[^>]+>")


def _ddg_unwrap(href: str) -> str:
    if href.startswith("//"):
        href = "https:" + href
    if "duckduckgo.com/l/" in href:
        q = parse_qs(urlparse(href).query).get("uddg")
        if q:
            return unquote(q[0])
    return href


def _ddg_search(objective: str, queries: list[str], *, client: httpx.Client | None = None) -> str:
    own = client is None
    client = client or httpx.Client(timeout=WEB_TIMEOUT_S, follow_redirects=True)
    try:
        resp = client.post(DDG_HTML_URL, data={"q": queries[0] if queries else objective},
                           headers={"User-Agent": "Mozilla/5.0"})
        if resp.status_code != 200:
            raise ToolError(f"duckduckgo {resp.status_code}")
        links = _DDG_A_RE.findall(resp.text)
        snips = _DDG_SNIP_RE.findall(resp.text)
        if not links:
            raise ToolError("duckduckgo returned no results")
        _record_web_cost("web_search", "duckduckgo", 0)
        out = [f"Web results for \"{objective}\":"]
        for i, (href, title) in enumerate(links[:6]):
            t = html.unescape(_TAGS_RE.sub("", title)).strip()
            snip = html.unescape(_TAGS_RE.sub("", snips[i])).strip() if i < len(snips) else ""
            out.append(f"- {t}\n  {_ddg_unwrap(href)}\n  {snip[:300]}")
        return "\n".join(out)
    except httpx.HTTPError as e:
        raise ToolError(f"duckduckgo transport failed ({type(e).__name__})") from e
    finally:
        if own:
            client.close()


# ---- provider: direct fetch (keyless fallback for web_fetch) ----

# Only ~6000 characters of each page survive into the tool result, but the whole body had to be
# read to get them. Cap the download at a size that comfortably contains any article-sized page.
_DIRECT_FETCH_MAX_BYTES = 5_000_000


def _direct_fetch(urls: list[str], objective: str) -> str:
    """Fetch up to three URLs and reduce each to plain text for the model.

    The URL guard used to live here as `_assert_public_url`; it now lives in `safe_fetch`, which
    also re-validates redirects and bounds the body. That matters more here than anywhere else:
    these URLs come from an LLM acting on untrusted search results, so both the destination and
    the size are attacker-influenced.
    """
    chunks = []
    for url in urls[:3]:
        try:
            resp = safe_fetch.fetch(url, max_bytes=_DIRECT_FETCH_MAX_BYTES,
                                    timeout=WEB_TIMEOUT_S,
                                    headers={"User-Agent": "Mozilla/5.0"})
        except safe_fetch.UnsafeURLError as e:
            chunks.append(f"# {url}\n\n(refused: {e})")
            continue
        except safe_fetch.FetchTooLargeError as e:
            chunks.append(f"# {url}\n\n(too large: {e})")
            continue
        except safe_fetch.SafeFetchError as e:
            chunks.append(f"# {url}\n\n(refused: {e})")
            continue
        except httpx.HTTPStatusError as e:
            chunks.append(f"# {url}\n\n(fetch failed: HTTP {e.response.status_code})")
            continue
        except httpx.HTTPError as e:
            raise ToolError(f"fetch failed: {e}") from e
        if "text/html" not in resp.content_type and "text/plain" not in resp.content_type:
            chunks.append(f"# {url}\n\n(non-text content)")
            continue
        body = resp.text
        text = _TAGS_RE.sub(" ", re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", body))
        text = html.unescape(re.sub(r"[ \t]+", " ", text)).strip()
        chunks.append(f"# {url}\n\n{text[:6000]}")
        _record_web_cost("web_fetch", "direct", 0)
    return "\n\n---\n\n".join(chunks) if chunks else "No content fetched."


# ---- orchestrators: try providers in order, fall through on failure ----

def _run_chain(providers: list[tuple[str, object]], *args) -> str:
    """Try each provider in turn; the first non-empty result wins.

    The point of the chain is that one provider's bad day is invisible to the reader, so a
    provider that fails in ANY way has to fall through to the next one. Only `ToolError` used to
    be caught, which meant anything a provider failed to wrap — a malformed payload raising
    `KeyError`, an `httpx` error escaping a helper — propagated out of `web_search` entirely,
    killed the agent's tool call, and left the remaining providers untried. That is the exact
    failure the chain exists to prevent, and it was reachable from any provider's response.

    An unexpected exception is still a bug, so it is logged and its type named in the
    diagnostic rather than silently becoming a fallback.
    """
    attempts = []
    for name, fn in providers:
        try:
            result = fn(*args)
        except ToolError as e:
            attempts.append(f"{name} ({e})")
            continue
        except Exception as e:  # noqa: BLE001 — deliberate: see the docstring
            log.warning("web provider %s raised an unwrapped %s", name, type(e).__name__)
            attempts.append(f"{name} (unexpected {type(e).__name__})")
            continue
        if result and result.strip():
            return _cap(result)
        # Recorded rather than skipped silently: a provider that answers with nothing was
        # previously missing from "Tried: …", so the diagnostic understated what had been
        # attempted and made an empty answer look like a provider that never ran.
        attempts.append(f"{name} (empty)")
    return "Web request failed — no provider available. Tried: " + "; ".join(attempts)


def web_search(objective: str, search_queries: list[str] | None = None) -> str:
    """Search the web. `objective` = what you want to find; `search_queries` = 1-3 short keyword
    queries. Tries Brave, then Firecrawl, then keyless DuckDuckGo. Returns ranked results with
    snippets — usually enough to answer (author info, adoption, follow-up work, outside papers)
    without fetching. UNTRUSTED content."""
    objective = " ".join((objective or "").split())
    if not objective:
        return "Empty search objective."
    if len(objective) > MAX_SEARCH_OBJECTIVE_CHARS:
        return "Search refused: objective is too long."
    queries = [" ".join(q.split()) for q in (search_queries or []) if q.strip()][:3] or [objective]
    if any(len(query) > MAX_SEARCH_QUERY_CHARS for query in queries):
        return "Search refused: query is too long."
    result = _run_chain(
        [("Brave", _brave_search), ("Firecrawl", _firecrawl_search), ("DuckDuckGo", _ddg_search)],
        objective, queries)
    return model_provenance.frame("web_search_results", result, source="provider chain")


def web_fetch(urls: list[str], objective: str = "") -> str:
    """Extract content from specific URLs. Tries Firecrawl, then a direct fetch.
    Use when search snippets aren't enough or a specific page is named. UNTRUSTED content."""
    urls = [u.strip() for u in (urls or []) if u.strip()][:3]
    if not urls:
        return "No URLs provided."
    if any(len(url) > MAX_FETCH_URL_CHARS for url in urls):
        return "Fetch refused: URL is too long."
    if any(_has_url_credentials(url) for url in urls):
        return "Fetch refused: URL credentials are not allowed."
    for url in urls:
        try:
            safe_fetch.assert_public_url(url)
        except safe_fetch.UnsafeURLError:
            return "Fetch refused: every URL must resolve to a public HTTP(S) destination."
    objective = " ".join((objective or "").split())[:MAX_SEARCH_OBJECTIVE_CHARS]
    result = _run_chain(
        [("Firecrawl", _firecrawl_fetch), ("direct", _direct_fetch)],
        urls, objective)
    return model_provenance.frame("web_fetch_results", result, source="provider chain")
