"""retrieval_agent: the agentic PDF hunt. Driven end-to-end by a FunctionModel (zero LLM/network
for the loop itself) with the PDF download monkeypatched, verifying: tool events stream out, a
successful fetch_pdf fills the holder and ends the run, and failures report ok=False."""
from __future__ import annotations

import asyncio

import httpx
import pytest
from app import retrieval_agent, retriever, safe_fetch
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
from pydantic_ai.models.function import FunctionModel


def _collect(title, model):
    async def _run():
        out = []
        async for ev in retrieval_agent.stream_hunt(title, model=model):
            out.append(ev)
        return out
    return asyncio.run(_run())


def test_hunt_success_streams_tools_and_returns_text(monkeypatch):
    # fetch_pdf's network + extraction stubbed: any URL yields a valid "PDF". The download now goes
    # through safe_fetch (destination checks, redirect re-validation, byte ceiling), which is
    # covered on its own in tests/test_safe_fetch.py — here it is faked wholesale so this test
    # stays about the agent loop.
    monkeypatch.setattr(retrieval_agent.safe_fetch, "fetch",
                        lambda url, **kw: retrieval_agent.safe_fetch.FetchResult(
                            url=url, status_code=200, headers=httpx.Headers({}),
                            content=b"%PDF-1.4 fake"))
    monkeypatch.setattr(retriever, "extract_pdf_bytes", lambda data: "The paper text. " * 50)

    calls = {"n": 0}

    def model_fn(messages, info):
        calls["n"] += 1
        if calls["n"] == 1:
            return ModelResponse(parts=[ToolCallPart(
                tool_name="fetch_pdf", args={"url": "https://usenix.org/system/files/paper.pdf"})])
        return ModelResponse(parts=[TextPart(content="https://usenix.org/system/files/paper.pdf")])

    events = _collect("Some OSDI Paper", FunctionModel(model_fn))
    kinds = [e["type"] for e in events]
    assert "tool" in kinds
    tool = next(e for e in events if e["type"] == "tool")
    assert tool["name"] == "fetch_pdf" and "usenix.org" in tool["detail"]
    result = events[-1]
    assert result["type"] == "result" and result["ok"]
    assert result["full_text"].startswith("The paper text.")
    assert result["source"] == "https://usenix.org/system/files/paper.pdf"


def test_hunt_failure_reports_not_ok():
    def model_fn(messages, info):
        return ModelResponse(parts=[TextPart(content="FAILED: nothing found")])

    events = _collect("Unfindable Paper", FunctionModel(model_fn))
    result = events[-1]
    assert result["type"] == "result" and result["ok"] is False
    assert "FAILED" in result["summary"]


@pytest.mark.parametrize("exc,expected", [
    (safe_fetch.UnsafeURLError("non-public address"), "Refused"),
    (safe_fetch.FetchTooLargeError("over the limit"), "Download failed"),
    (safe_fetch.FetchTimeoutError("deadline"), "Download refused"),
    (safe_fetch.UnsupportedResponseError("content-encoding"), "Download refused"),
    (httpx.ConnectError("boom"), "Download failed"),
])
def test_fetch_pdf_returns_failures_as_text_not_exceptions(monkeypatch, exc, expected):
    """fetch_pdf must hand the model a string for every failure, never raise.

    The tool runs inside a Pydantic AI loop: a returned string lets the model try the next
    candidate, while an exception aborts the whole hunt. The generic `except SafeFetchError` clause
    covers the two refusal types added after this call site was written, so without a per-type
    assertion the suite would stay green if it were dropped.
    """
    holder: dict = {}
    # An injected model, so no OpenRouter model is constructed. Without it build_hunt_agent calls
    # agent_harness._openrouter_model(), which needs a real API key — the test then passes on a
    # machine that has one configured and fails in CI, which is exactly what happened.
    stub_model = FunctionModel(lambda messages, info: ModelResponse(parts=[TextPart(content="x")]))
    agent = retrieval_agent.build_hunt_agent("Some Paper", holder, model=stub_model)
    fetch_pdf = next(t for t in agent._function_toolset.tools.values()
                     if t.name == "fetch_pdf").function

    def boom(*a, **k):
        raise exc

    monkeypatch.setattr(retrieval_agent.safe_fetch, "fetch", boom)
    result = fetch_pdf("https://example.com/paper.pdf")
    assert expected in result
    assert not holder
