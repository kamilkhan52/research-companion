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
from pydantic_ai.exceptions import UsageLimitExceeded
from pydantic_ai.messages import FunctionToolCallEvent
from pydantic_ai.models import Model
from pydantic_ai.usage import UsageLimits

from . import (
    agent_harness,
    logging_config,
    model_provenance,
    operation_limits,
    prompts,
    research_tools,
    retriever,
    safe_fetch,
)

log = logging_config.get("retrieval_agent")

HUNT_MAX_PDF_BYTES = 40_000_000

#: How many model requests one hunt may make, and how many tool calls within them.
#:
#: The hunt was the only agentic path in the app running unbounded — it inherited pydantic-ai's
#: default `request_limit=50` and NO tool-call limit, each request able to emit an analysis-sized
#: completion. That is the loosest budget in the app attached to the cheapest hold, which is
#: precisely backwards.
#:
#: Sized ABOVE what the prompt asks for, not at it. `prompts._RETRIEVAL_HUNT` budgets a search
#: (sometimes two — "add pdf or the venue when helpful") plus "try at most 5 URLs" plus a final
#: answer: seven to eight requests before the agent's own `retries=2` is counted. A limit of
#: exactly eight would be tripped by a hunt doing precisely what it was told, and the caller
#: reports a tripped limit as "the model provider could not complete the PDF hunt" — our own
#: ceiling, misattributed to the provider.
MAX_HUNT_REQUESTS = 12
MAX_HUNT_TOOL_CALLS = 10
_HUNT_LIMITS = UsageLimits(
    request_limit=MAX_HUNT_REQUESTS,
    tool_calls_limit=MAX_HUNT_TOOL_CALLS,
    output_tokens_limit=operation_limits.run_output_ceiling(
        "retrieval_hunt", MAX_HUNT_REQUESTS,
    ),
)


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
        if not retriever.looks_like_pdf(data):
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
    return Agent(model or agent_harness._openrouter_model(operation="retrieval_hunt"),
                 system_prompt=(prompts.render("retrieval_hunt", title=framed_title)
                                + "\n\n" + model_provenance.SYSTEM_POLICY),
                 tools=[web_search, fetch_pdf], output_type=str, retries=2)


async def stream_hunt(title: str, model: Model | None = None) -> AsyncIterator[dict]:
    """Run the hunt, yielding {'type':'tool', name, detail} per tool call and finally
    {'type':'result', ok, full_text?, source?, summary}."""
    holder: dict = {}
    ag = build_hunt_agent(title, holder, model=model)
    run = None
    try:
        async with ag.iter(
            "Find the working PDF for this paper title:\n\n"
            + model_provenance.frame("paper_title", title),
            usage_limits=_HUNT_LIMITS,
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
    except UsageLimitExceeded:
        # Our ceiling, not the provider's. Reported separately because the generic message names
        # the provider for something we did, and because a hunt that ran out of tries has usually
        # searched — a different thing from one that could not start.
        log.info("hunt hit its own request budget for %r", title[:80])
        yield {
            "type": "result",
            "ok": False,
            "summary": "Searched without finding a downloadable PDF.",
        }
        return
    except Exception:
        yield {
            "type": "result",
            "ok": False,
            "summary": "The model provider could not complete the PDF hunt.",
        }
        return
    finally:
        # The hunt is a full agentic tool loop and recorded NOTHING: it builds its own Pydantic AI
        # agent, so it never passes through `llm.complete`'s accounting and never reached
        # `usage.record`. Its cost sat entirely outside both the ledger and the spend ceiling,
        # against a retrieval hold sized for a cheap extraction.
        #
        # In `finally`, not at the end of the happy path: the hunt tries candidate after candidate,
        # so tripping a request limit or a provider 5xx partway through is an ordinary outcome —
        # that is what the `except` above exists for — and several generations have already been
        # paid for by then. Recording only on success meters the cheap case and forgives the
        # expensive one. `stream_agent_events` settled this the same way.
        #
        # `run.all_messages()`, not None: only the per-response branch of the recorder reads
        # OpenRouter's authoritative `cost`, so passing no messages records tokens with no dollars
        # and settles the reservation at exactly zero — the very hole this is here to close. The
        # messages survive the early `break`; `run.result` does not.
        if run is not None:
            try:
                agent_harness.record_agent_run(
                    run.usage, ag.model, "retrieval_hunt", run.all_messages(),
                )
            except Exception as exc:  # noqa: BLE001 — accounting never fails the work it measures
                log.warning("hunt usage not recorded (error=%s)", type(exc).__name__)
    yield {"type": "result", "ok": bool(holder.get("full_text")),
           "full_text": holder.get("full_text"), "source": holder.get("source"),
           "summary": summary[:300]}
