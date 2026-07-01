"""research_tools: the read-only tools the analyst agent can call. Local tools run against a
real temp project (via the store layer); web tools (Parallel Search MCP) use an injected fake
httpx client that replays the JSON-RPC handshake, so nothing here touches the network."""
from __future__ import annotations

import httpx
import pytest

from app import graph_store, research_tools, store
from tests.conftest import add_paper


def _resp(status: int, *, headers=None, text: str = "") -> httpx.Response:
    return httpx.Response(status, headers=headers or {}, content=text.encode(),
                          request=httpx.Request("POST", research_tools.PARALLEL_MCP_URL))


class FakeMCPClient:
    """Replays the 3 Parallel MCP POSTs (initialize, notifications/initialized, tools/call) and
    records the request bodies + headers so tests can assert what was sent."""
    def __init__(self, tool_result_text: str):
        import json as _json
        self._queue = [
            _resp(200, headers={"content-type": "application/json", "mcp-session-id": "sess-1"},
                  text=_json.dumps({"jsonrpc": "2.0", "id": 1, "result": {"ok": True}})),
            _resp(202),  # notifications/initialized -> no body
            _resp(200, headers={"content-type": "application/json"},
                  text=_json.dumps({"jsonrpc": "2.0", "id": 2,
                                    "result": {"content": [{"type": "text", "text": tool_result_text}]}})),
        ]
        self.posts = []

    def post(self, url, **kw):
        self.posts.append(kw)
        return self._queue.pop(0)

    def close(self):
        pass


# ---- local tools ----

def test_list_and_read_paper_text(temp_project):
    add_paper(temp_project, "a", "Paper A", full_text="The alpha method works.")
    listing = research_tools.list_project_papers()
    assert "a: \"Paper A\"" in listing

    assert "alpha method" in research_tools.read_paper_text("a")
    assert "No paper with slug 'zzz'" in research_tools.read_paper_text("zzz")


def test_read_paper_text_truncates(temp_project):
    big = "x" * (research_tools.MAX_PAPER_TEXT_CHARS + 500)
    add_paper(temp_project, "a", "Paper A", full_text=big)
    out = research_tools.read_paper_text("a")
    assert "[...truncated...]" in out
    assert len(out) < len(big) + 200


def test_read_paper_notes(temp_project):
    add_paper(temp_project, "a", "Paper A", full_text="text")
    assert "no committed notes" in research_tools.read_paper_notes("a")
    store.append_notes_block("a", "Paper A", "Key finding: X improves Y.")
    assert "Key finding: X improves Y." in research_tools.read_paper_notes("a")


def test_related_papers_uses_graph_edges(temp_project):
    add_paper(temp_project, "a", "Paper A", full_text="t")
    add_paper(temp_project, "b", "Paper B", full_text="t")
    data = graph_store.load()
    data["graph"] = {"nodes": [], "edges": [{"source": "a", "target": "b"}]}
    graph_store.save(data)
    out = research_tools.related_papers("a")
    assert "b: \"Paper B\"" in out  # a cites b, surfaced from the graph edge


# ---- web tools: fetch_url ----

# ---- web tools: Parallel Search MCP ----

def _force_key(monkeypatch, key="pk-test"):
    monkeypatch.setattr(research_tools, "_parallel_key", lambda: key)


def test_web_search_unconfigured_raises(temp_project, monkeypatch):
    monkeypatch.setattr(research_tools, "_parallel_key", lambda: "")
    with pytest.raises(research_tools.ToolError):
        research_tools.web_search("who cites this paper", ["orca citations"])


def test_web_search_runs_mcp_handshake_and_returns_excerpts(temp_project, monkeypatch):
    _force_key(monkeypatch)
    client = FakeMCPClient("Result: Orca is widely adopted; see arxiv.org/abs/2200.00001")
    out = research_tools.web_search("adoption of orca", ["orca serving adoption"], client=client)

    assert "widely adopted" in out
    assert len(client.posts) == 3  # initialize, notifications/initialized, tools/call
    # auth header sent, and the tools/call targeted web_search with our queries
    assert client.posts[0]["headers"]["x-api-key"] == "pk-test"
    call = client.posts[2]["json"]
    assert call["params"]["name"] == "web_search"
    assert call["params"]["arguments"]["search_queries"] == ["orca serving adoption"]
    # second+ calls carry the session id returned by initialize
    assert client.posts[2]["headers"].get("Mcp-Session-Id") == "sess-1"


def test_web_fetch_targets_web_fetch_tool(temp_project, monkeypatch):
    _force_key(monkeypatch)
    client = FakeMCPClient("Extracted page content about the author.")
    out = research_tools.web_fetch(["https://example.com/author"], "author bio", client=client)
    assert "author" in out
    assert client.posts[2]["json"]["params"]["name"] == "web_fetch"
    assert client.posts[2]["json"]["params"]["arguments"]["urls"] == ["https://example.com/author"]


def test_read_jsonrpc_parses_sse_framing():
    # The MCP endpoint may reply as a single SSE message; the last data: line is the payload.
    sse = _resp(200, headers={"content-type": "text/event-stream"},
                text='event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"hi"}]}}\n\n')
    parsed = research_tools._read_jsonrpc(sse)
    assert parsed["result"]["content"][0]["text"] == "hi"
