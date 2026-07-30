"""`research_tools._direct_fetch` — the keyless web-fetch fallback the agent reaches when Firecrawl
is unavailable.

It had no tests. That matters more than the usual coverage gap: it is the call site whose URLs come
from an LLM acting on untrusted search results, and it is the one that must never RAISE — a
returned string lets the agent evaluate the failure and move on, while an exception propagates out
of the tool call. The `except SafeFetchError` clause covers refusal types added after this code was
written, so nothing here would have caught its removal.
"""
from __future__ import annotations

import httpx
import pytest
from app import research_tools, safe_fetch


@pytest.mark.parametrize("exc,expected", [
    (safe_fetch.UnsafeURLError("non-public address 127.0.0.1"), "refused"),
    (safe_fetch.FetchTooLargeError("over the limit"), "too large"),
    (safe_fetch.FetchTimeoutError("deadline"), "refused"),
    (safe_fetch.UnsupportedResponseError("content-encoding"), "refused"),
])
def test_refusals_are_reported_per_url_not_raised(monkeypatch, exc, expected):
    def boom(*a, **k):
        raise exc

    monkeypatch.setattr(research_tools.safe_fetch, "fetch", boom)
    out = research_tools._direct_fetch(["https://a.example/x"], "find the paper")
    assert "https://a.example/x" in out
    assert expected in out, f"refusal reported as {out!r}, expected to mention {expected!r}"


def test_one_bad_url_does_not_lose_the_others(monkeypatch):
    """Per-URL isolation: a refusal on the first URL must not discard content already fetched from
    another. The refusals are appended per URL precisely so the agent still gets what worked."""
    def fetch(url, **kw):
        if "bad" in url:
            raise safe_fetch.UnsafeURLError("non-public")
        return safe_fetch.FetchResult(
            url=url, status_code=200,
            headers=httpx.Headers({"content-type": "text/html"}),
            content=b"<html><body>useful text</body></html>")

    monkeypatch.setattr(research_tools.safe_fetch, "fetch", fetch)
    out = research_tools._direct_fetch(["https://bad.example/x", "https://good.example/y"], "obj")
    assert "useful text" in out
    assert "https://bad.example/x" in out


def test_transport_errors_still_raise_tool_error(monkeypatch):
    """A transport failure is a different thing from a refusal: it means the provider chain should
    fall through to the next provider, which _run_chain drives off ToolError."""
    def boom(*a, **k):
        raise httpx.ConnectError("boom")

    monkeypatch.setattr(research_tools.safe_fetch, "fetch", boom)
    with pytest.raises(research_tools.ToolError):
        research_tools._direct_fetch(["https://a.example/x"], "obj")


def test_non_text_content_is_skipped(monkeypatch):
    monkeypatch.setattr(research_tools.safe_fetch, "fetch", lambda url, **kw: safe_fetch.FetchResult(
        url=url, status_code=200, headers=httpx.Headers({"content-type": "application/pdf"}),
        content=b"%PDF-1.4"))
    assert "non-text" in research_tools._direct_fetch(["https://a.example/x.pdf"], "obj")


def test_http_status_error_is_per_url_not_a_tool_error(monkeypatch):
    """A 404 on one URL must be reported against that URL and the others still fetched. Raising
    ToolError instead would abandon the whole call AND make _run_chain fall through to the next
    provider, which is wrong: the fetch worked, the page just was not there."""
    def fetch(url, **kw):
        if "missing" in url:
            raise httpx.HTTPStatusError(
                "404", request=httpx.Request("GET", url),
                response=httpx.Response(404, request=httpx.Request("GET", url)))
        return safe_fetch.FetchResult(
            url=url, status_code=200,
            headers=httpx.Headers({"content-type": "text/html"}),
            content=b"<html>good</html>")

    monkeypatch.setattr(research_tools.safe_fetch, "fetch", fetch)
    out = research_tools._direct_fetch(["https://a.example/missing", "https://b.example/ok"], "obj")
    assert "404" in out
    assert "good" in out
