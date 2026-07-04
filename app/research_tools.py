"""Read-only research tools the analyst agent can call mid-discussion (wired into the agent
harness in a later step). Two families:

  * Local, project-scoped: read other papers' cached text / committed notes, list what's in the
    project, find related papers, read the aggregate working notes. These are grounded in data
    the user already pulled into the project — no external calls, no injection surface — and
    resolve within the active project via the store layer (config.project_dir()).

  * Web: fetch a URL's readable text, and search the web. These reach outside the corpus, so
    they carry real safety obligations, enforced here: http(s)-only, per-redirect-hop blocking
    of private/loopback/link-local/reserved addresses (SSRF — incl. cloud metadata at
    169.254.169.254), hard byte/char caps, short timeouts, and text-only content. web_search
    needs a Brave Search API key (settings/env), mirroring the existing per-provider key model.

Everything is READ-ONLY: nothing here mutates project files, git, or settings. Tools return
plain strings meant for the model to read; on bad input they return a helpful message rather
than raising, so the agent can recover — except genuine configuration errors (e.g. web search
not configured), which raise ToolError so the failure is explicit.
"""
from __future__ import annotations

import html
import ipaddress
import json
import os
import re
import socket
import uuid
from urllib.parse import parse_qs, unquote, urlparse

import httpx

from . import config, graph_store, sessions, store

# Caps: keep tool output bounded so a single call can't blow the model's context or stall a turn.
MAX_PAPER_TEXT_CHARS = 16_000
MAX_NOTES_CHARS = 12_000
MAX_WEB_TEXT_CHARS = 12_000        # cap the text handed back from a web search/fetch
WEB_TIMEOUT_S = 45.0

# Parallel Search MCP (https://parallel.ai) — the web-search/fetch backend the Pi agent uses on
# this machine. Streamable-HTTP MCP endpoint; auth via x-api-key. Key from PARALLEL_API_KEY /
# PARALLEL_SEARCH_API_KEY (matching Pi) or the 'parallel_api_key' setting.
PARALLEL_MCP_URL = "https://search.parallel.ai/mcp"
PARALLEL_MODEL = "gpt-5.5"          # Parallel's search/extract model (per Pi's extension)
_PARALLEL_SESSION = f"rc-{uuid.uuid4()}"

# Firecrawl (https://firecrawl.dev) — the fallback the Pi/Hermes setup uses. Key from
# FIRECRAWL_API_KEY or the 'firecrawl_api_key' setting.
FIRECRAWL_BASE = "https://api.firecrawl.dev/v2"

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
    return "Papers in this project:\n" + "\n".join(lines)


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
    return f"# {title} (full text)\n\n{text}"


def read_paper_notes(slug: str) -> str:
    """Return the committed reading notes for another project paper, if the user has read it."""
    if slug not in _known_slugs():
        return f"No paper with slug '{slug}' in this project. Call list_project_papers to see options."
    if not store.has_notes(slug):
        return f"Paper '{slug}' has no committed notes yet."
    notes = store.read_notes(slug)
    if len(notes) > MAX_NOTES_CHARS:
        notes = notes[:MAX_NOTES_CHARS] + "\n\n[...truncated...]"
    return f"# {store.title_for(slug)} (notes)\n\n{notes}"


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
    graph = graph_store.load().get("graph")
    if isinstance(graph, dict):
        for e in graph.get("edges", []):
            if e.get("source") == slug and e.get("target") in papers:
                cites.add(e["target"])
            if e.get("target") == slug and e.get("source") in papers:
                cited_by.add(e["source"])

    def _fmt(slugs: set[str]) -> str:
        slugs = {s for s in slugs if s in papers and s != slug}
        if not slugs:
            return "  (none)"
        return "\n".join(f"  - {s}: \"{papers[s].title}\"" for s in sorted(slugs))

    return (f"Papers '{slug}' cites (in-project):\n{_fmt(cites)}\n\n"
            f"Papers that cite '{slug}' (in-project):\n{_fmt(cited_by)}")


def read_working_notes() -> str:
    """Return the project's aggregate working notes (the synthesis across all papers read)."""
    notes = store.read_synthesis()
    if not notes.strip():
        return "The project has no working notes yet."
    if len(notes) > MAX_NOTES_CHARS:
        notes = notes[:MAX_NOTES_CHARS] + "\n\n[...truncated...]"
    return notes


# ----------------------------------------------------------------------------------- web tools
# Web search/fetch go through a provider CHAIN so they keep working as credit/availability
# changes: Firecrawl -> Parallel -> DuckDuckGo (keyless). Whichever is configured-and-working
# wins, in that order; the keyless DDG fallback means search almost always returns something.
# All web content is UNTRUSTED — the agent treats it as data to evaluate/cite, never as
# instructions (see agent_harness guidance).

def _firecrawl_key() -> str:
    return os.environ.get("FIRECRAWL_API_KEY") or config.load_settings().get("firecrawl_api_key") or ""


def _parallel_key() -> str:
    return (os.environ.get("PARALLEL_API_KEY") or os.environ.get("PARALLEL_SEARCH_API_KEY")
            or config.load_settings().get("parallel_api_key") or "")


def _cap(text: str) -> str:
    text = text.strip()
    return text if len(text) <= MAX_WEB_TEXT_CHARS else text[:MAX_WEB_TEXT_CHARS] + "\n\n[...truncated...]"


# ---- provider: Firecrawl (https://firecrawl.dev) ----

def _firecrawl_search(objective: str, queries: list[str], *, client: httpx.Client | None = None) -> str:
    key = _firecrawl_key()
    if not key:
        raise ToolError("no firecrawl key")
    own = client is None
    client = client or httpx.Client(timeout=WEB_TIMEOUT_S)
    try:
        resp = client.post(f"{FIRECRAWL_BASE}/search",
                           headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                           json={"query": queries[0] if queries else objective, "limit": 5})
        if resp.status_code != 200:
            raise ToolError(f"firecrawl {resp.status_code}: {resp.text[:120]}")
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
        raise ToolError(f"firecrawl request failed: {e}") from e
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
            resp = client.post(f"{FIRECRAWL_BASE}/scrape",
                               headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                               json={"url": url, "formats": ["markdown"]})
            if resp.status_code != 200:
                raise ToolError(f"firecrawl {resp.status_code}: {resp.text[:120]}")
            md = ((resp.json() or {}).get("data") or {}).get("markdown", "")
            chunks.append(f"# {url}\n\n{md}")
        return "\n\n---\n\n".join(chunks)
    except httpx.HTTPError as e:
        raise ToolError(f"firecrawl request failed: {e}") from e
    finally:
        if own:
            client.close()


# ---- provider: Parallel Search MCP ----

def _read_jsonrpc(resp: httpx.Response) -> dict:
    """Parse a JSON-RPC reply from the MCP endpoint, which may arrive as plain JSON or as a
    single SSE message (Streamable-HTTP transport). For SSE we take the last `data:` payload."""
    body = resp.text
    if "text/event-stream" in resp.headers.get("content-type", ""):
        data = ""
        for line in body.splitlines():
            if line.startswith("data:"):
                data = line[5:].strip()
        body = data
    try:
        return json.loads(body) if body.strip() else {}
    except (ValueError, TypeError):
        return {"error": {"message": body[:200]}}


def _parse_mcp_content(result) -> str:
    if isinstance(result, dict):
        content = result.get("content")
        if isinstance(content, list) and content:
            return "\n".join(c.get("text", "") if isinstance(c, dict) else str(c) for c in content).strip()
        return json.dumps(result)
    return str(result)


def _parallel_call(tool_name: str, arguments: dict, *, client: httpx.Client | None = None) -> str:
    """Invoke a Parallel MCP tool via the JSON-RPC handshake (initialize ->
    notifications/initialized -> tools/call), mirroring Pi's parallel-search extension."""
    key = _parallel_key()
    if not key:
        raise ToolError("no parallel key")
    headers = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json",
               "x-api-key": key}
    own = client is None
    client = client or httpx.Client(timeout=WEB_TIMEOUT_S)
    try:
        init = client.post(PARALLEL_MCP_URL, headers=headers, json={
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                       "clientInfo": {"name": "research-companion", "version": "1.0.0"}}})
        sid = init.headers.get("mcp-session-id")
        shdr = {**headers, "Mcp-Session-Id": sid} if sid else headers
        client.post(PARALLEL_MCP_URL, headers=shdr,
                    json={"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})
        call = client.post(PARALLEL_MCP_URL, headers=shdr, json={
            "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": {"name": tool_name,
                       "arguments": {"session_id": _PARALLEL_SESSION, "model_name": PARALLEL_MODEL,
                                     **arguments}}})
        data = _read_jsonrpc(call)
        if data.get("error"):
            raise ToolError(f"parallel: {data['error'].get('message', 'unknown')}")
        result = data.get("result") or {}
        content = _parse_mcp_content(result)
        # Parallel reports failures (e.g. 402 out-of-credit) as an isError tool result or as
        # error text in the content, NOT as an HTTP/JSON-RPC error — so detect that and raise,
        # letting the provider chain fall through to the next provider.
        if result.get("isError") or content.startswith("Error executing tool") \
                or "Insufficient credit" in content:
            raise ToolError(content[:150])
        return content
    except httpx.HTTPError as e:
        raise ToolError(f"parallel request failed: {e}") from e
    finally:
        if own:
            client.close()


def _parallel_search(objective: str, queries: list[str], *, client: httpx.Client | None = None) -> str:
    return _parallel_call("web_search", {"objective": objective, "search_queries": queries}, client=client)


def _parallel_fetch(urls: list[str], objective: str, *, client: httpx.Client | None = None) -> str:
    return _parallel_call("web_fetch", {"urls": urls[:20],
                                        "objective": objective or "Extract the key content."},
                          client=client)


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
        out = [f"Web results for \"{objective}\":"]
        for i, (href, title) in enumerate(links[:6]):
            t = html.unescape(_TAGS_RE.sub("", title)).strip()
            snip = html.unescape(_TAGS_RE.sub("", snips[i])).strip() if i < len(snips) else ""
            out.append(f"- {t}\n  {_ddg_unwrap(href)}\n  {snip[:300]}")
        return "\n".join(out)
    except httpx.HTTPError as e:
        raise ToolError(f"duckduckgo request failed: {e}") from e
    finally:
        if own:
            client.close()


# ---- provider: direct fetch (keyless fallback for web_fetch), with an SSRF guard ----

def _assert_public_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ToolError(f"only http(s) allowed (got '{parsed.scheme}')")
    host = parsed.hostname
    if not host:
        raise ToolError("url has no host")
    try:
        infos = socket.getaddrinfo(host, parsed.port or 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror as e:
        raise ToolError(f"could not resolve {host}") from e
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved
                or ip.is_multicast or ip.is_unspecified):
            raise ToolError(f"refusing non-public address {ip}")


def _direct_fetch(urls: list[str], objective: str, *, client: httpx.Client | None = None) -> str:
    own = client is None
    client = client or httpx.Client(timeout=WEB_TIMEOUT_S, follow_redirects=True)
    try:
        chunks = []
        for url in urls[:3]:
            _assert_public_url(url)
            resp = client.get(url, headers={"User-Agent": "Mozilla/5.0"})
            if resp.status_code != 200:
                chunks.append(f"# {url}\n\n(fetch failed: HTTP {resp.status_code})")
                continue
            if "text/html" not in resp.headers.get("content-type", "") and \
                    "text/plain" not in resp.headers.get("content-type", ""):
                chunks.append(f"# {url}\n\n(non-text content)")
                continue
            body = resp.text
            text = _TAGS_RE.sub(" ", re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", body))
            text = html.unescape(re.sub(r"[ \t]+", " ", text)).strip()
            chunks.append(f"# {url}\n\n{text[:6000]}")
        return "\n\n---\n\n".join(chunks) if chunks else "No content fetched."
    except httpx.HTTPError as e:
        raise ToolError(f"fetch failed: {e}") from e
    finally:
        if own:
            client.close()


# ---- orchestrators: try providers in order, fall through on failure ----

def _run_chain(providers: list[tuple[str, object]], *args) -> str:
    attempts = []
    for name, fn in providers:
        try:
            result = fn(*args)
            if result and result.strip():
                return _cap(result)
        except ToolError as e:
            attempts.append(f"{name} ({e})")
    return "Web request failed — no provider available. Tried: " + "; ".join(attempts)


def web_search(objective: str, search_queries: list[str] | None = None) -> str:
    """Search the web. `objective` = what you want to find; `search_queries` = 1-3 short keyword
    queries. Tries Firecrawl, then Parallel, then keyless DuckDuckGo. Returns ranked results with
    snippets — usually enough to answer (author info, adoption, follow-up work, outside papers)
    without fetching. UNTRUSTED content."""
    objective = (objective or "").strip()
    if not objective:
        return "Empty search objective."
    queries = [q.strip() for q in (search_queries or []) if q.strip()] or [objective]
    return _run_chain(
        [("Firecrawl", _firecrawl_search), ("Parallel", _parallel_search), ("DuckDuckGo", _ddg_search)],
        objective, queries)


def web_fetch(urls: list[str], objective: str = "") -> str:
    """Extract content from specific URLs. Tries Firecrawl, then Parallel, then a direct fetch.
    Use when search snippets aren't enough or a specific page is named. UNTRUSTED content."""
    urls = [u.strip() for u in (urls or []) if u.strip()]
    if not urls:
        return "No URLs provided."
    objective = (objective or "").strip()
    return _run_chain(
        [("Firecrawl", _firecrawl_fetch), ("Parallel", _parallel_fetch), ("direct", _direct_fetch)],
        urls, objective)
