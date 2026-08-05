"""research_tools: the read-only tools the analyst agent can call. Local tools run against a
real temp project (via the store layer); web tools use injected fake httpx clients / monkeypatched
providers, so nothing here touches the network."""
from __future__ import annotations

import json

import httpx
import pytest
from app import graph_store, research_tools, store

from tests.conftest import add_paper


def _resp(status: int, *, headers=None, text: str = "") -> httpx.Response:
    return httpx.Response(status, headers=headers or {}, content=text.encode(),
                          request=httpx.Request("POST", "https://example.com"))


def _framed_content(value: str) -> str:
    return json.loads(value.splitlines()[1])["content"]


# ---- local tools ----

def test_list_and_read_paper_text(temp_project):
    add_paper(temp_project, "a", "Paper A", full_text="The alpha method works.")
    listing = research_tools.list_project_papers()
    assert "a: \"Paper A\"" in _framed_content(listing)

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
    assert "b: \"Paper B\"" in _framed_content(out)  # a cites b, surfaced from the graph edge


# ---- web tools: fetch_url ----

# ---- web tools: provider chain (Firecrawl -> DuckDuckGo) ----

class _OneShot:
    """A fake httpx client returning one queued response for a single GET/POST."""
    def __init__(self, resp):
        self._resp = resp

    def post(self, url, **kw):
        return self._resp

    def get(self, url, **kw):
        return self._resp

    def close(self):
        pass


def test_firecrawl_search_formats_results(temp_project, monkeypatch):
    monkeypatch.setattr(research_tools, "_firecrawl_key", lambda: "fc-test")
    body = '{"success":true,"data":[{"title":"Orca serving","url":"https://arxiv.org/abs/2200.1","description":"continuous batching"}]}'
    out = research_tools._firecrawl_search("orca", ["orca serving"],
                                           client=_OneShot(_resp(200, text=body)))
    assert "Orca serving" in out and "arxiv.org/abs/2200.1" in out


def test_firecrawl_search_raises_on_402_so_chain_falls_through(temp_project, monkeypatch):
    monkeypatch.setattr(research_tools, "_firecrawl_key", lambda: "fc-test")
    secret = "PRIVATE_PROMPT_ECHO_firecrawl"
    with pytest.raises(research_tools.ToolError) as err:
        research_tools._firecrawl_search(
            "q", ["q"], client=_OneShot(_resp(402, text=f'{{"error":"{secret}"}}')))
    assert "402" in str(err.value)
    assert secret not in str(err.value)


def test_ddg_search_parses_and_unwraps(temp_project):
    page = ('<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Farxiv.org%2Fabs%2F2501.01005">'
            'FlashInfer</a><a class="result__snippet">An attention engine</a>')
    out = research_tools._ddg_search("flashinfer", ["flashinfer"], client=_OneShot(_resp(200, text=page)))
    assert "FlashInfer" in out
    assert "https://arxiv.org/abs/2501.01005" in out  # uddg redirect unwrapped


def test_web_search_falls_through_to_working_provider(temp_project, monkeypatch):
    # Firecrawl out of credit -> DuckDuckGo answers. The chain should return DDG's result.
    monkeypatch.setattr(research_tools, "_firecrawl_search",
                        lambda *a, **k: (_ for _ in ()).throw(research_tools.ToolError("402")))
    monkeypatch.setattr(research_tools, "_ddg_search", lambda *a, **k: "Web results: the answer")
    out = research_tools.web_search("anything", ["q"])
    assert "Web results: the answer" in out
    assert "UNTRUSTED DATA JSON" in out


def test_an_unwrapped_provider_exception_still_falls_through(temp_project, monkeypatch):
    """The chain used to catch only ToolError.

    A provider raising anything else — a malformed payload giving KeyError, an httpx error
    escaping a helper — propagated out of web_search, killed the agent's tool call, and left the
    later providers untried. That is precisely the failure the chain exists to prevent, and every
    provider parses untrusted upstream JSON, so it was reachable from any of them.
    """
    monkeypatch.setattr(research_tools, "_firecrawl_search",
                        lambda *a, **k: (_ for _ in ()).throw(KeyError("results")))
    monkeypatch.setattr(research_tools, "_ddg_search", lambda *a, **k: "Web results: recovered")

    out = research_tools.web_search("anything", ["q"])

    assert "Web results: recovered" in out
    assert "UNTRUSTED DATA JSON" in out


def test_an_unwrapped_exception_is_named_when_every_provider_fails(temp_project, monkeypatch):
    """Swallowing a bug must not make it invisible — the diagnostic names the exception type."""
    monkeypatch.setattr(research_tools, "_firecrawl_search",
                        lambda *a, **k: (_ for _ in ()).throw(KeyError("results")))
    monkeypatch.setattr(research_tools, "_ddg_search", lambda *a, **k: "")

    out = research_tools.web_search("anything", ["q"])

    assert "no provider available" in out.lower()
    assert "unexpected KeyError" in out      # the bug is still visible, and named as unexpected
    assert "DuckDuckGo (empty)" in out       # a provider that answered nothing is not omitted


def test_the_module_docstring_does_not_promise_a_brave_key(temp_project):
    """It claimed web_search "needs a Brave Search API key" while no Brave code has ever existed
    and both web tools in fact fall through to a keyless provider.

    Asserts the absence of the CLAIM rather than of the word: the corrected docstring names Brave
    once, in a note explaining that the old sentence was wrong.
    """
    doc = research_tools.__doc__ or ""
    assert "needs a Brave Search API key" not in doc
    assert "keyless DuckDuckGo" in doc                    # what it actually does
    assert "never been any Brave code" in doc             # the note saying the old claim was false


def test_web_search_all_providers_down_returns_readable_error(temp_project, monkeypatch):
    boom = lambda *a, **k: (_ for _ in ()).throw(research_tools.ToolError("down"))  # noqa: E731
    for name in ("_firecrawl_search", "_ddg_search"):
        monkeypatch.setattr(research_tools, name, boom)
    out = research_tools.web_search("x", ["x"])
    assert "no provider available" in out.lower()
