"""Agentic analyst turn, built on Pydantic AI (the tool-use loop, validation, and retries we'd
otherwise hand-roll — see docs/ handoff for why we didn't build our own or bolt on the TS Pi
harness). This is ADDITIVE and feature-flagged (RC_AGENTIC): the existing single-shot turn in
app/agent.py is untouched and remains the default until this path is validated live.

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
from collections.abc import AsyncIterator

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

from . import agent as agent_mod
from . import config, prompts, research_tools
from .models import Turn

# Off by default; set RC_AGENTIC=1 to route turns through the tool-using agent.
AGENTIC_ENABLED = os.environ.get("RC_AGENTIC", "").strip().lower() not in ("", "0", "false", "no")

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


def build_agent(slug: str, model: Model | None = None) -> Agent:
    """Construct the tool-using analyst agent for a session. `model` is injectable so tests can
    pass a FunctionModel/TestModel and exercise the whole tool loop with no network."""
    system = agent_mod._system_for(slug) + "\n\n" + prompts.get("analyst_tool_guidance")
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
    The latest user message is the prompt; everything before it is prior context."""
    ag = build_agent(slug, model=model)
    if history and history[-1]["role"] == "user":
        prompt, prior = history[-1]["content"], history[:-1]
    else:
        prompt, prior = "", history
    try:
        result = ag.run_sync(prompt, message_history=_to_message_history(prior))
    except Exception as e:  # normalize framework/provider errors into the app's error type
        raise agent_mod.AgentError(f"Agentic turn failed: {str(e)[:300]}") from e
    return agent_mod._parse(result.output)


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
    ag = build_agent(slug, model=model)
    if history and history[-1]["role"] == "user":
        prompt, prior = history[-1]["content"], history[:-1]
    else:
        prompt, prior = "", history
    async for ev in stream_agent_events(ag, prompt, prior):
        yield ev


async def stream_agent_events(ag: Agent, prompt: str,
                              prior: list[dict] | None = None) -> AsyncIterator[dict]:
    """Generic event stream for ANY of this module's agents (analyst turn, notes editor):
    the same {'text'|'tool'|'final'} events, decoupled from session history assembly."""
    try:
        async with ag.iter(prompt, message_history=_to_message_history(prior or [])) as run:
            async for node in run:
                if Agent.is_model_request_node(node):
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
