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
import math
import os
from collections.abc import AsyncIterator, Callable, Iterable

from openai import OpenAIError
from pydantic_ai import Agent, capture_run_messages
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
from pydantic_ai.models.openrouter import (
    OpenRouterModel,
    OpenRouterModelSettings,
    OpenRouterStreamedResponse,
)
from pydantic_ai.providers.openrouter import OpenRouterProvider
from pydantic_ai.usage import RunUsage, UsageLimits

from . import agent as agent_mod
from . import (
    config,
    llm,
    logging_config,
    model_provenance,
    operation_limits,
    prompts,
    research_tools,
    sessions,
    spend_control,
    usage,
)
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
# The request cap bounds how many ROUNDS a misbehaving loop can take; it says nothing about how
# large each one may be. This path never goes through `llm.complete`, so `operation_limits`'
# clamp cannot reach it — and it is the most expensive metered operation in the app (§2a: ~44,668
# prompt tokens and $0.06 a turn across the loop). The token ceiling is read from the same table
# the raw client clamps against, so there is one set of numbers with two enforcement points.
#
# Summed across the whole run rather than per request: `output_tokens_limit` is what stops twelve
# maximal responses from costing twelve times a single one.
#
# Worth being clear that tripping it costs MORE money, not less: the exceeded run is abandoned and
# the fallback buys a full single-shot turn on top. That is the right trade for the reader — the
# roadmap ranks blocking a paying user above a mild overspend — but it means this limit is a
# safety valve against a runaway loop, not a saving.
_USAGE_LIMITS = UsageLimits(
    request_limit=AGENT_REQUEST_LIMIT,
    output_tokens_limit=operation_limits.run_output_ceiling("analysis", AGENT_REQUEST_LIMIT),
)


def _retain_authoritative_zero_cost(details: dict | None, provider_usage) -> dict | None:
    """Work around Pydantic AI 2.2 dropping OpenRouter's numeric zero cost.

    Its native adapter copies ``usage.cost`` only through a truthiness check, so an authoritative
    ``0`` disappears while every positive number survives. Preserve any non-``None`` value here;
    ledger validation still rejects booleans, negatives, NaN, and infinity.
    """
    cost = getattr(provider_usage, "cost", None) if provider_usage is not None else None
    if cost is None:
        return details
    retained = dict(details or {})
    retained["cost"] = cost
    return retained


class _LedgerOpenRouterStreamedResponse(OpenRouterStreamedResponse):
    def _map_provider_details(self, chunk):
        return _retain_authoritative_zero_cost(
            super()._map_provider_details(chunk), getattr(chunk, "usage", None)
        )


class _OpenRouterSpendDisabled(OpenAIError):
    """Stops OpenAI SDK retries while the model wrapper restores the public AgentError."""


async def _require_openrouter_spend(_request) -> None:
    """HTTPX request hook: the last awaitable boundary before the SDK sends OpenRouter bytes."""
    try:
        spend_control.require_enabled()
    except spend_control.ProviderSpendDisabled as exc:
        # The OpenAI SDK retries arbitrary hook exceptions as connection failures. Its own base
        # error is explicitly propagated with no retry; the model wrapper translates it back to
        # the app's safe domain error below.
        raise _OpenRouterSpendDisabled(str(exc)) from exc


class _SpendControlledOpenRouterProvider(OpenRouterProvider):
    """OpenRouter provider whose owned HTTP client keeps the final spend hook across reuse."""

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        client = self._own_http_client
        factory = self._http_client_factory
        if client is None or factory is None:  # pragma: no cover - app always lets provider own it
            raise RuntimeError("Spend-controlled OpenRouter requires an owned HTTP client.")
        client.event_hooks["request"].append(_require_openrouter_spend)

        def controlled_factory():
            replacement = factory()
            replacement.event_hooks["request"].append(_require_openrouter_spend)
            return replacement

        self._http_client_factory = controlled_factory


class _LedgerOpenRouterModel(OpenRouterModel):
    async def _completions_create(self, *args, **kwargs):
        """Re-check the live kill switch for every tool-loop model request and retry."""
        try:
            spend_control.require_enabled()
        except spend_control.ProviderSpendDisabled as exc:
            raise agent_mod.AgentError(str(exc)) from exc
        try:
            return await super()._completions_create(*args, **kwargs)
        except _OpenRouterSpendDisabled as exc:
            raise agent_mod.AgentError(str(exc)) from exc

    def _process_provider_details(self, response):
        return _retain_authoritative_zero_cost(
            super()._process_provider_details(response), getattr(response, "usage", None)
        )

    @property
    def _streamed_response_cls(self):
        return _LedgerOpenRouterStreamedResponse


def record_agent_run(
    run_usage, model: Model | None, operation: str, messages: Iterable | None = None
) -> None:
    """Best-effort, per-request accounting for an agentic run.

    Public despite living here: every path that builds its own Pydantic AI agent — the hunt,
    lab research, listening-preview research — must meter through this one function rather than
    grow its own, and a leading underscore invited exactly the second, weaker accounting path
    that had to be deleted from `usage.py`.

    **Pass `messages` whenever you have them.** Only the per-response branch below reads
    OpenRouter's authoritative `cost`; without messages a run records tokens with no dollars and
    settles its reservation at zero, which reads as free work rather than as unmetered work.

    The native Pydantic AI OpenRouter adapter retains authoritative ``usage.cost`` and the
    provider response id on each ``ModelResponse``. Record those responses individually: one
    tool loop can issue up to twelve separately billed generations, and aggregating them into one
    call loses both the spend shape and the ids needed to reconcile an interrupted response.

    A response with an id but no authoritative cost becomes one reconcilable pending record. The
    old aggregate fallback remains only for injected/non-OpenRouter models and for the rare failure
    before the provider response enters the captured history. Never raises: analytics must not
    fail the turn it observes.
    """
    try:
        openrouter_responses = [
            message
            for message in (messages or [])
            if isinstance(message, ModelResponse) and message.provider_name == "openrouter"
        ]
        if openrouter_responses:
            for response in openrouter_responses:
                model_name = response.model_name or getattr(model, "model_name", None)
                details = response.provider_details or {}
                cost = details.get("cost")
                request_usage = response.usage
                if (
                    isinstance(cost, (int, float))
                    and not isinstance(cost, bool)
                    and math.isfinite(cost)
                    and cost >= 0
                ):
                    usage.record(
                        operation,
                        model_name,
                        {
                            "prompt_tokens": int(request_usage.input_tokens or 0),
                            "completion_tokens": int(request_usage.output_tokens or 0),
                            "total_tokens": int(request_usage.total_tokens or 0),
                            "cost": cost,
                        },
                        generation_id=response.provider_response_id,
                    )
                else:
                    usage.record_pending(operation, model_name, response.provider_response_id)
            return
        if not run_usage:
            return
        model_name = getattr(model, "model_name", None) or config.load_settings().get("model")
        prompt = int(getattr(run_usage, "input_tokens", 0) or 0)
        completion = int(getattr(run_usage, "output_tokens", 0) or 0)
        requests = int(getattr(run_usage, "requests", 0) or 0)
        if prompt or completion:
            usage.record(operation, model_name, {
                "prompt_tokens": prompt,
                "completion_tokens": completion,
                "total_tokens": prompt + completion,
            })
        if requests > 0:
            # A billed request happened but its dollar cost is unknowable on this path — flag
            # totals estimated (no generation id to reconcile by) rather than implying $0.
            usage.record_pending(operation, model_name, None)
    except Exception as e:  # noqa: BLE001 — accounting is best-effort
        log.debug("agentic usage accounting skipped (error=%s)", type(e).__name__)

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


def _openrouter_model(
    model_id: str | None = None, operation: str = "analysis"
) -> OpenRouterModel:
    try:
        spend_control.require_enabled()
    except spend_control.ProviderSpendDisabled as exc:
        raise agent_mod.AgentError(str(exc)) from exc
    settings = config.load_settings()
    key = settings.get("openrouter_api_key")
    if not key:
        raise agent_mod.AgentError("No OpenRouter API key set. Add it in Settings.")
    provider = _SpendControlledOpenRouterProvider(
        api_key=key, app_url="http://localhost", app_title=config.APP_TITLE)
    # Native OpenRouter settings retain the same unconditional privacy constraint while also
    # requesting the authoritative usage/cost block on every tool-loop request.
    return _LedgerOpenRouterModel(
        model_id or settings.get("model"),
        provider=provider,
        settings=OpenRouterModelSettings(
            openrouter_provider=llm.routing_payload(),
            openrouter_usage={"include": True},
            # The per-REQUEST cap, and the one that actually stops money being spent. The run-level
            # `output_tokens_limit` below is an abort: on the non-streaming path it fires after a
            # response has already been generated and billed. This is what the raw client's
            # `max_tokens` does — generation physically stops at the ceiling — so the agentic path
            # gets the same bound rather than only a backstop.
            #
            # Sized to the OPERATION rather than always to `analysis`. The hunt, lab research and
            # preview research each declare a budget in `operation_limits` an order of magnitude
            # smaller than an analysis turn, and every one of them was silently handed the analysis
            # ceiling instead — so the table read as if it bound them while binding nothing.
            max_tokens=operation_limits.tokens_for(operation),
        ),
    )


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
              + "\n\n" + prompts.get("analyst_tool_guidance")
              + "\n\n" + model_provenance.SYSTEM_POLICY)
    return Agent(model or _openrouter_model(), system_prompt=system, tools=TOOLS,
                 output_type=str, retries=2)


def build_notes_editor(model: Model | None = None) -> Agent:
    """The notes-editing agent: same research tools as the analyst (plus the project's own
    notes, which a notes edit legitimately needs), governed by the notes_editor prompt. Output
    is the full revised markdown document — no section protocol."""
    system = (prompts.get("notes_editor") + "\n\n" + agent_mod.MATH_MARKDOWN_CONTRACT
              + "\n\n" + prompts.get("notes_tool_guidance")
              + "\n\n" + model_provenance.SYSTEM_POLICY)
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
    prior_messages = _to_message_history(prior)
    with capture_run_messages() as captured:
        try:
            result = ag.run_sync(prompt, message_history=prior_messages,
                                 usage_limits=_USAGE_LIMITS, usage=run_usage)
        except Exception as e:  # tool-incompatible / provider error → single-shot fallback
            log.warning("agentic turn failed for %s (error=%s); falling back to single-shot",
                        slug, type(e).__name__)
            # `model` here is a pydantic-ai Model; the single-shot path takes a model-id string.
            return agent_mod.run_turn(slug, history, model=_model_id(model))
        finally:
            # Meters whatever requests happened, on success or fallback (the single-shot fallback
            # additionally meters itself, with real cost, through llm.py).
            # `_to_message_history` rebuilds old assistant responses without provider metadata,
            # so filtering the whole capture for provider_name=openrouter is safe. Do not slice by
            # the input length: Pydantic compacts consecutive ModelRequests before capture, making
            # those lengths differ after failed turns and dropping the new paid response.
            record_agent_run(run_usage, ag.model, "analysis", captured)
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
    prior_messages = _to_message_history(prior or [])
    with capture_run_messages() as captured:
        try:
            async with ag.iter(prompt, message_history=prior_messages,
                               usage_limits=_USAGE_LIMITS, usage=run_usage) as run:
                async for node in run:
                    if Agent.is_model_request_node(node):
                        if not first_request:
                            yield {"type": "segment"}
                        first_request = False
                        async with node.stream(run.ctx) as request_stream:
                            async for event in request_stream:
                                if isinstance(event, PartStartEvent) and isinstance(
                                    event.part, TextPart
                                ):
                                    if event.part.content:
                                        yield {"type": "text", "text": event.part.content}
                                elif isinstance(event, PartDeltaEvent) and isinstance(
                                    event.delta, TextPartDelta
                                ):
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
            raise agent_mod.AgentError(
                "The model provider could not complete the agentic request.") from e
        finally:
            record_agent_run(run_usage, ag.model, operation, captured)


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
        log.warning("agentic stream failed (error=%s); falling back to single-shot",
                    type(e).__name__)
        yield {"type": "segment"}  # demote any partial commentary/text already shown
        for ev in single_shot():
            yield ev
