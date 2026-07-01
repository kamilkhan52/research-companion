"""research_tools: the read-only tools the analyst agent can call. Local tools run against a
real temp project (via the store layer); web tools use an injected fake httpx client and a
monkeypatched resolver, so nothing here touches the network — and the SSRF guard is exercised
directly (a private-resolving host must be refused before any request is made)."""
from __future__ import annotations

import httpx
import pytest

from app import config, graph_store, research_tools, store
from tests.conftest import add_paper


def _resp(status: int, url: str, *, headers=None, content=b"", json_body=None) -> httpx.Response:
    if json_body is not None:
        return httpx.Response(status, headers=headers or {}, json=json_body,
                              request=httpx.Request("GET", url))
    return httpx.Response(status, headers=headers or {}, content=content,
                          request=httpx.Request("GET", url))


class FakeClient:
    """Stands in for httpx.Client: returns queued responses and records calls."""
    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = []

    def get(self, url, **kw):
        self.calls.append(url)
        return self._responses.pop(0)

    def close(self):
        pass


def _public_dns(monkeypatch, ip="93.184.216.34"):
    monkeypatch.setattr(research_tools.socket, "getaddrinfo",
                        lambda *a, **k: [(2, 1, 6, "", (ip, 443))])


def _private_dns(monkeypatch, ip="127.0.0.1"):
    monkeypatch.setattr(research_tools.socket, "getaddrinfo",
                        lambda *a, **k: [(2, 1, 6, "", (ip, 443))])


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

def test_fetch_url_extracts_text(temp_project, monkeypatch):
    _public_dns(monkeypatch)
    html = b"<html><body><h1>Title</h1><script>evil()</script><p>Hello world</p></body></html>"
    client = FakeClient([_resp(200, "https://example.com", headers={"content-type": "text/html"}, content=html)])
    out = research_tools.fetch_url("https://example.com", client=client)
    assert "Hello world" in out
    assert "evil()" not in out  # script contents stripped


def test_fetch_url_blocks_private_address_before_request(temp_project, monkeypatch):
    _private_dns(monkeypatch, "169.254.169.254")  # cloud metadata endpoint
    client = FakeClient([])  # must never be used
    with pytest.raises(research_tools.ToolError):
        research_tools.fetch_url("http://metadata.internal/latest/", client=client)
    assert client.calls == []


def test_fetch_url_rejects_non_http_scheme(temp_project):
    with pytest.raises(research_tools.ToolError):
        research_tools.fetch_url("file:///etc/passwd")


def test_fetch_url_refuses_binary_content(temp_project, monkeypatch):
    _public_dns(monkeypatch)
    client = FakeClient([_resp(200, "https://example.com/x.pdf",
                               headers={"content-type": "application/pdf"}, content=b"%PDF")])
    out = research_tools.fetch_url("https://example.com/x.pdf", client=client)
    assert "non-text content" in out


# ---- web tools: web_search ----

def test_web_search_unconfigured_raises(temp_project, monkeypatch):
    monkeypatch.setattr(config, "load_settings", lambda: {"brave_api_key": ""})
    with pytest.raises(research_tools.ToolError):
        research_tools.web_search("anything")


def test_web_search_formats_results(temp_project, monkeypatch):
    monkeypatch.setattr(config, "load_settings", lambda: {"brave_api_key": "k"})
    body = {"web": {"results": [
        {"title": "Attention Is All You Need", "url": "https://arxiv.org/abs/1706.03762",
         "description": "The <b>transformer</b> paper."},
    ]}}
    client = FakeClient([_resp(200, "https://api.search.brave.com", json_body=body)])
    out = research_tools.web_search("transformer", client=client)
    assert "Attention Is All You Need" in out
    assert "https://arxiv.org/abs/1706.03762" in out
    assert "<b>" not in out  # html stripped from snippet
