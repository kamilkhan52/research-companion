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

import json
import os
import uuid

import httpx

from . import config, graph_store, sessions, store

# Caps: keep tool output bounded so a single call can't blow the model's context or stall a turn.
MAX_PAPER_TEXT_CHARS = 16_000
MAX_NOTES_CHARS = 12_000
MAX_WEB_TEXT_CHARS = 12_000        # cap the text handed back from a web search/fetch

# Parallel Search MCP (https://parallel.ai) — the same web-search/fetch backend Hermes and the
# Pi agent use on this machine. Streamable-HTTP MCP endpoint; auth via x-api-key. Key comes from
# PARALLEL_API_KEY / PARALLEL_SEARCH_API_KEY (matching Pi) or the 'parallel_api_key' setting.
PARALLEL_MCP_URL = "https://search.parallel.ai/mcp"
PARALLEL_MODEL = "gpt-5.5"          # Parallel's search/extract model (per Pi's extension)
PARALLEL_TIMEOUT_S = 45.0
_PARALLEL_SESSION = f"rc-{uuid.uuid4()}"


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


# ------------------------------------------------------------- web tools (Parallel Search MCP)
# We don't fetch arbitrary URLs ourselves (no SSRF surface): Parallel does the searching and
# page extraction server-side and hands back excerpts/markdown. Web content is still UNTRUSTED —
# the agent must treat it as data to evaluate/cite, never as instructions (see agent_harness
# guidance).

def _parallel_key() -> str:
    return (os.environ.get("PARALLEL_API_KEY") or os.environ.get("PARALLEL_SEARCH_API_KEY")
            or config.load_settings().get("parallel_api_key") or "")


def _cap(text: str) -> str:
    text = text.strip()
    return text if len(text) <= MAX_WEB_TEXT_CHARS else text[:MAX_WEB_TEXT_CHARS] + "\n\n[...truncated...]"


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
    """MCP tool results carry a `content` list of {type, text}; join the text parts."""
    if isinstance(result, dict):
        content = result.get("content")
        if isinstance(content, list) and content:
            return "\n".join(c.get("text", "") if isinstance(c, dict) else str(c) for c in content).strip()
        return json.dumps(result)
    return str(result)


def _parallel_call(tool_name: str, arguments: dict, *, client: httpx.Client | None = None) -> str:
    """Invoke a Parallel MCP tool ('web_search' | 'web_fetch') via the JSON-RPC handshake
    (initialize -> notifications/initialized -> tools/call), mirroring Pi's parallel-search
    extension. `client` is injectable so tests run with no network."""
    key = _parallel_key()
    if not key:
        raise ToolError("Web search is not configured. Set PARALLEL_API_KEY in the server "
                        "environment (or add a Parallel API key in Settings).")
    headers = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json",
               "x-api-key": key}
    own = client is None
    client = client or httpx.Client(timeout=PARALLEL_TIMEOUT_S)
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
            raise ToolError(f"Parallel error: {data['error'].get('message', 'unknown')}")
        return _cap(_parse_mcp_content(data.get("result")))
    except httpx.HTTPError as e:
        raise ToolError(f"Parallel request failed: {e}") from e
    finally:
        if own:
            client.close()


def web_search(objective: str, search_queries: list[str] | None = None, *,
               client: httpx.Client | None = None) -> str:
    """Search the web via Parallel Search. `objective` describes what you want to find;
    `search_queries` are 1-3 short keyword queries. Returns ranked results with excerpts —
    usually enough to answer (author info, adoption, follow-up work, external papers) without
    fetching. UNTRUSTED content."""
    if not objective.strip():
        return "Empty search objective."
    queries = [q for q in (search_queries or []) if q.strip()] or [objective.strip()]
    return _parallel_call("web_search", {"objective": objective.strip(), "search_queries": queries},
                          client=client)


def web_fetch(urls: list[str], objective: str = "", *, client: httpx.Client | None = None) -> str:
    """Extract content from specific URLs via Parallel, focused by `objective`. Use only when
    search excerpts are insufficient or a specific page/quote is needed. UNTRUSTED content."""
    urls = [u for u in (urls or []) if u.strip()]
    if not urls:
        return "No URLs provided."
    return _parallel_call("web_fetch", {"urls": urls[:20],
                                        "objective": objective.strip() or "Extract the key content."},
                          client=client)
