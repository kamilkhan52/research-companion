"""Agentic analyst turn, built on Pydantic AI (the tool-use loop, validation, and retries we'd
otherwise hand-roll — see docs/ handoff for why we didn't build our own or bolt on the TS Pi
harness). This is the DEFAULT turn path (RC_AGENTIC=0 opts out): the single-shot turn in
app/agent.py is untouched and remains available as the explicit opt-out.

Design choice: we keep the proven text output protocol (### CANONICAL ### / ### STATE ### / …,
parsed by agent._parse) rather than switching to structured JSON output. Pydantic AI is used
only for the tool loop with plain-text output, so streaming and parsing stay exactly as they
were; tools are simply available for the model to call before it writes its answer.

The model can call the read-only research tools in app/research_tools.py: read other project
papers' text/notes, see what's related, read the working notes, fetch a web page, search the
web. Fetched web content is untrusted (prompt-injection boundary) — the system guidance tells
the model to treat it as data to evaluate, never as instructions.
"""
from __future__ import annotations

import json
import os
from collections.abc import AsyncIterator, Callable, Iterable

from pydantic_ai import Agent
from pydantic_ai.messages import (
    FunctionToolCallEvent,
    ModelRequest,
    ModelResponse,
    PartDeltaEvent,
    PartStartEvent,
    TextPart,
    TextPartDelta,
    UserPromptPart,
)
from pydantic_ai.models import Model
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.usage import RunUsage, UsageLimits

from . import agent as agent_mod
from . import config, logging_config, prompts, research_tools, sessions, usage
from .models import Turn

log = logging_config.get("agent_harness")

# ON by default (R12.8): the tool loop IS the product's turn path — without it no discussion
# turn can search the web or re-read the paper, and models either narrate a search they
# cannot run or truthfully report having no tools (the live incident behind this default:
# the deployment simply never set RC_AGENTIC). Set RC_AGENTIC=0 to restore the plain
# single-shot analyst.
def _flag_enabled(raw: str | None) -> bool:
    return (raw or "").strip().lower() not in ("0", "false", "no")


AGENTIC_ENABLED = _flag_enabled(os.environ.get("RC_AGENTIC"))

# Hard cap on model requests per turn (each tool round is one request), so a model that keeps
# calling tools without ever answering cannot loop up unbounded spend. Pydantic AI's own
# default is 50; a research turn that needs more than this many tool rounds is misbehaving.
# The final answer-writing request counts too, so this comfortably allows several tool rounds.
AGENT_REQUEST_LIMIT = 12
_USAGE_LIMITS = UsageLimits(request_limit=AGENT_REQUEST_LIMIT)


def _record_run_usage(run_usage, model: Model | None, operation: str) -> None:
    """Best-effort token accounting for an agentic run (R12.8 / sol review): the Pydantic AI
    path bypasses llm.py's ledger, so meter it here. OpenRouter's dollar cost is not surfaced
    through Pydantic AI, so only token counts are recorded (cost stays 0 for this operation) —
    strictly better than the previous silent gap, and the request cap bounds the exposure.
    Never raises: accounting must not fail a turn."""
    try:
        if not run_usage:
            return
        model_name = getattr(model, "model_name", None) or config.load_settings().get("model")
        prompt = int(getattr(run_usage, "input_tokens", 0) or 0)
        completion = int(getattr(run_usage, "output_tokens", 0) or 0)
        if not prompt and not completion:
            return
        usage.record(operation, model_name, {
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "total_tokens": prompt + completion,
        })
    except Exception as e:  # noqa: BLE001 — accounting is best-effort
        log.debug("agentic usage accounting skipped: %s", str(e)[:120])

# ---- web-tool wrappers: drop the injectable `client` kwarg so it isn't exposed in the schema.
#      Their names become the tool names the model (and the mobile activity trail) see. ----

def web_search(objective: str, search_queries: list[str]) -> str:
    """Search the web. objective = what you're trying to find; search_queries = 1-3 short keyword
    queries. Returns ranked results with snippets. Untrusted content."""
    return research_tools.web_search(objective, search_queries)


def web_fetch(urls: list[str], objective: str = "") -> str:
    """Extract content from specific URLs, focused by objective. Use when search snippets aren't
    enough or a specific page is named. Untrusted content."""
    return research_tools.web_fetch(urls, objective)


# read_paper_notes / read_working_notes are intentionally NOT exposed: the session already
# carries the working notes + related papers' notes (see assembler.build_context), so exposing
# them would just burn tool calls re-fetching context the model already has.
TOOLS = [
    web_search,
    web_fetch,
    research_tools.read_paper_text,
    research_tools.related_papers,
    research_tools.list_project_papers,
]


def _openrouter_model(model_id: str | None = None) -> OpenAIChatModel:
    settings = config.load_settings()
    key = settings.get("openrouter_api_key")
    if not key:
        raise agent_mod.AgentError("No OpenRouter API key set. Add it in Settings.")
    provider = OpenAIProvider(base_url=config.OPENROUTER_BASE, api_key=key)
    return OpenAIChatModel(model_id or settings.get("model"), provider=provider)


def model_override(model_id: str | None) -> Model | None:
    """A one-shot Model instance for `model_id`, or None to let build_agent's own
    `model or _openrouter_model()` fallback pick the account default. Never persists
    `model_id` anywhere — the caller decides per turn, every other turn is unaffected."""
    return _openrouter_model(model_id) if model_id else None


def build_agent(slug: str, model: Model | None = None,
                latest_user_text: str = "") -> Agent:
    """Construct the tool-using analyst agent for a session. `model` is injectable so tests can
    pass a FunctionModel/TestModel and exercise the whole tool loop with no network."""
    system = (agent_mod._system_for(slug, latest_user_text)
              + "\n\n" + prompts.get("analyst_tool_guidance"))
    return Agent(model or _openrouter_model(), system_prompt=system, tools=TOOLS,
                 output_type=str, retries=2)


def build_notes_editor(model: Model | None = None) -> Agent:
    """The notes-editing agent: same research tools as the analyst (plus the project's own
    notes, which a notes edit legitimately needs), governed by the notes_editor prompt. Output
    is the full revised markdown document — no section protocol."""
    system = (prompts.get("notes_editor") + "\n\n" + agent_mod.MATH_MARKDOWN_CONTRACT
              + "\n\n" + prompts.get("notes_tool_guidance"))
    tools = TOOLS + [research_tools.read_paper_notes, research_tools.read_working_notes]
    return Agent(model or _openrouter_model(), system_prompt=system, tools=tools,
                 output_type=str, retries=2)


def _to_message_history(history: list[dict]) -> list:
    """Convert the app's [{role, content}] history into Pydantic AI messages. The system prompt
    lives on the Agent, so only user/assistant turns are mapped here."""
    msgs: list = []
    for h in history:
        if h["role"] == "user":
            msgs.append(ModelRequest(parts=[UserPromptPart(content=h["content"])]))
        else:
            msgs.append(ModelResponse(parts=[TextPart(content=h.get("content", ""))]))
    return msgs


def run_turn_agentic(slug: str, history: list[dict], model: Model | None = None) -> Turn:
    """Run one agentic turn and parse the result into a Turn (same protocol as agent.run_turn).
    The latest user message is the prompt; everything before it is prior context. A model that
    cannot use tools (schema rejection, malformed tool calls) FALLS BACK to the proven
    single-shot analyst rather than failing the turn — the default flip (R12.8) must never
    regress a working single-shot model just because it can't tool-call (sol review)."""
    if history and history[-1]["role"] == "user":
        prompt, prior = history[-1]["content"], history[:-1]
    else:
        prompt, prior = "", history
    ag = build_agent(slug, model=model, latest_user_text=prompt)
    # A shared accumulator recorded in `finally`, so a turn that trips the request cap or fails
    # mid-loop still meters the requests it DID make (sol review — otherwise a 12-request
    # runaway records zero agentic usage). The single-shot fallback meters itself via llm.py.
    run_usage = RunUsage()
    try:
        result = ag.run_sync(prompt, message_history=_to_message_history(prior),
                             usage_limits=_USAGE_LIMITS, usage=run_usage)
    except Exception as e:  # tool-incompatible / provider error → single-shot fallback
        log.warning("agentic turn failed for %s (%s); falling back to single-shot",
                    slug, str(e)[:200])
        # `model` here is a pydantic-ai Model; the single-shot path takes a model-id string.
        return agent_mod.run_turn(slug, history, model=_model_id(model))
    finally:
        _record_run_usage(run_usage, ag.model, "analysis")
    return agent_mod._parse(
        result.output,
        allow_proposed_commit=sessions.proposal_expected(slug),
    )


def _model_id(model: Model | None) -> str | None:
    """The model-id string for the single-shot fallback path — None lets it use the account
    default (the same behaviour as an un-overridden agentic turn)."""
    return getattr(model, "model_name", None)


def _tool_detail(args) -> str:
    """A short human label for a tool call, drawn from its most salient argument."""
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except (ValueError, TypeError):
            return args[:80]
    if isinstance(args, dict):
        for k in ("query", "slug", "url"):
            if args.get(k):
                return str(args[k])[:80]
    return ""


async def stream_agentic_events(slug: str, history: list[dict],
                                model: Model | None = None) -> AsyncIterator[dict]:
    """Async event stream for an agentic turn. Yields dicts the SSE layer maps to client events:
      {'type': 'text',  'text': <delta>}          — a chunk of the model's output text
      {'type': 'tool',  'name': <tool>, 'detail'} — the model called a research tool
      {'type': 'final', 'text': <full output>}    — the authoritative final answer, for parsing

    The caller extracts the canonical prefix from the accumulated 'text' for display, and parses
    'final' into a Turn. Tool execution (sync httpx tools) runs in Pydantic AI's threadpool."""
    if history and history[-1]["role"] == "user":
        prompt, prior = history[-1]["content"], history[:-1]
    else:
        prompt, prior = "", history
    ag = build_agent(slug, model=model, latest_user_text=prompt)
    async for ev in stream_agent_events(ag, prompt, prior):
        yield ev


async def stream_agent_events(ag: Agent, prompt: str,
                              prior: list[dict] | None = None,
                              operation: str = "analysis") -> AsyncIterator[dict]:
    """Generic event stream for ANY of this module's agents (analyst turn, notes editor):
    the same {'text'|'tool'|'final'} events, decoupled from session history assembly, plus a
    {'type': 'segment'} boundary at the start of each model request after the first. Text
    before a boundary is the model's pre-tool commentary ("Let me search for…"), NOT the
    answer — consumers demote it to the activity trail and restart answer accumulation, so the
    displayed/recorded answer comes only from the run's final request (R6.8). The turn is
    capped at AGENT_REQUEST_LIMIT model requests and its token usage is metered (R12.8)."""
    first_request = True
    # Recorded in `finally` so a capped/cancelled/failed stream still meters what it consumed
    # (sol review). The accumulator is filled in-place as requests happen.
    run_usage = RunUsage()
    try:
        async with ag.iter(prompt, message_history=_to_message_history(prior or []),
                           usage_limits=_USAGE_LIMITS, usage=run_usage) as run:
            async for node in run:
                if Agent.is_model_request_node(node):
                    if not first_request:
                        yield {"type": "segment"}
                    first_request = False
                    async with node.stream(run.ctx) as request_stream:
                        async for event in request_stream:
                            if isinstance(event, PartStartEvent) and isinstance(event.part, TextPart):
                                if event.part.content:
                                    yield {"type": "text", "text": event.part.content}
                            elif isinstance(event, PartDeltaEvent) and isinstance(event.delta, TextPartDelta):
                                if event.delta.content_delta:
                                    yield {"type": "text", "text": event.delta.content_delta}
                elif Agent.is_call_tools_node(node):
                    async with node.stream(run.ctx) as tool_stream:
                        async for event in tool_stream:
                            if isinstance(event, FunctionToolCallEvent):
                                yield {"type": "tool", "name": event.part.tool_name,
                                       "detail": _tool_detail(event.part.args)}
        yield {"type": "final", "text": run.result.output if run.result else ""}
    except agent_mod.AgentError:
        raise
    except Exception as e:  # normalize framework/provider errors
        raise agent_mod.AgentError(f"Agentic stream failed: {str(e)[:300]}") from e
    finally:
        _record_run_usage(run_usage, ag.model, operation)


async def stream_with_single_shot_fallback(
    agentic: Callable[[], AsyncIterator[dict]],
    single_shot: Callable[[], Iterable[dict]],
) -> AsyncIterator[dict]:
    """Yield the agentic event stream; if it fails BEFORE delivering a final answer, reset the
    consumer and fall back to the single-shot generator (R12.8 / sol review). A model that
    can't tool-call — provider tool-schema rejection, malformed native tool calls — therefore
    degrades to the proven single-shot analyst instead of failing the turn. Both factories are
    zero-arg callables so the single-shot generation isn't constructed unless it's needed.

    The `segment` emitted before the fallback demotes any partial pre-answer text the agentic
    attempt streamed (the consumer's existing R6.8 boundary handling), so the recorded answer
    is the single-shot output alone — never a doubled/spliced response."""
    produced_final = False
    try:
        async for ev in agentic():
            if ev.get("type") == "final":
                produced_final = True
            yield ev
    except agent_mod.AgentError as e:
        if produced_final:
            raise  # the answer already landed; a later error has nothing to recover
        log.warning("agentic stream failed (%s); falling back to single-shot", str(e)[:200])
        yield {"type": "segment"}  # demote any partial commentary/text already shown
        for ev in single_shot():
            yield ev
