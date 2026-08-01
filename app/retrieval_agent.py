"""Agentic PDF hunt — the escalation tier of paper retrieval. The deterministic path
(explicit URL -> arXiv id -> title search, app/retriever.py) is fast and free, so it always
runs first; this agent takes over only when that fails: papers not on arXiv (OSDI/SOSP/ACM,
OpenReview), mangled titles, throttled APIs. It drives web_search + a fetch_pdf tool in a
Pydantic AI loop until a candidate URL yields real extracted text, and its tool calls are
streamed to the client so the user sees what's happening ("searching the web… trying a PDF…")
instead of a spinner.

The extracted text travels via a per-run holder (the tool writes it, the caller reads it) —
the model itself only ever sees a short SUCCESS/FAILED status string per attempt, never the
paper body, keeping the loop cheap.
"""
from __future__ import annotations

from collections.abc import AsyncIterator

import httpx
from pydantic_ai import Agent
from pydantic_ai.messages import FunctionToolCallEvent
from pydantic_ai.models import Model

from . import agent_harness, model_provenance, prompts, research_tools, retriever, safe_fetch

HUNT_MAX_PDF_BYTES = 40_000_000


def build_hunt_agent(title: str, holder: dict, model: Model | None = None) -> Agent:
    """`holder` receives {"full_text", "source"} when a fetch succeeds. `model` is injectable
    for tests (FunctionModel), mirroring the analyst harness."""

    def fetch_pdf(url: str) -> str:
        """Download a candidate URL and try to extract paper text from it as a PDF. Returns
        'SUCCESS ...' when the paper text was extracted (then stop), else a failure reason."""
        # The url here comes from an LLM acting on untrusted web-search results, so it is exactly
        # the "URL the app did not choose" case safe_fetch exists for. Every failure is returned as
        # a string rather than raised: the model reads it and tries the next candidate.
        try:
            data = safe_fetch.fetch(
                url, max_bytes=HUNT_MAX_PDF_BYTES, timeout=60,
                headers={"User-Agent": "Mozilla/5.0"}).content
        except safe_fetch.UnsafeURLError as e:
            return f"Refused: {e}"
        except safe_fetch.FetchTooLargeError as e:
            return f"Download failed: {e}"
        except safe_fetch.SafeFetchError as e:
            return f"Download refused: {e}"
        except httpx.HTTPStatusError as e:
            return f"Download failed: HTTP {e.response.status_code}"
        except httpx.HTTPError as e:
            return f"Download failed: {str(e)[:120]}"
        if not data.startswith(b"%PDF"):
            return "Not a PDF (wrong content — find a direct PDF link)"
        try:
            text = retriever.extract_pdf_bytes(data)
        except retriever.RetrievalError as e:
            return f"PDF unusable: {e}"
        holder["full_text"] = text
        holder["source"] = url
        return f"SUCCESS: extracted {len(text)} characters from {url}"

    def web_search(objective: str, search_queries: list[str]) -> str:
        """Search the web for the paper. objective = what you want; search_queries = 1-3 short
        keyword queries. Returns results with URLs to try."""
        return research_tools.web_search(objective, search_queries)

    framed_title = model_provenance.frame("paper_title", title)
    return Agent(model or agent_harness._openrouter_model(),
                 system_prompt=(prompts.render("retrieval_hunt", title=framed_title)
                                + "\n\n" + model_provenance.SYSTEM_POLICY),
                 tools=[web_search, fetch_pdf], output_type=str, retries=2)


async def stream_hunt(title: str, model: Model | None = None) -> AsyncIterator[dict]:
    """Run the hunt, yielding {'type':'tool', name, detail} per tool call and finally
    {'type':'result', ok, full_text?, source?, summary}."""
    holder: dict = {}
    ag = build_hunt_agent(title, holder, model=model)
    try:
        async with ag.iter(
            "Find the working PDF for this paper title:\n\n"
            + model_provenance.frame("paper_title", title)
        ) as run:
            async for node in run:
                if Agent.is_call_tools_node(node):
                    async with node.stream(run.ctx) as tool_stream:
                        async for event in tool_stream:
                            if isinstance(event, FunctionToolCallEvent):
                                yield {"type": "tool", "name": event.part.tool_name,
                                       "detail": agent_harness._tool_detail(event.part.args)}
                if holder.get("full_text"):
                    break  # got the paper — no need to let the model keep narrating
        summary = (run.result.output if run.result else "") or ""
    except Exception:
        yield {
            "type": "result",
            "ok": False,
            "summary": "The model provider could not complete the PDF hunt.",
        }
        return
    yield {"type": "result", "ok": bool(holder.get("full_text")),
           "full_text": holder.get("full_text"), "source": holder.get("source"),
           "summary": summary[:300]}
