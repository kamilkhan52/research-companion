"""Background chat turns (the analyst's response to a message), on the shared JobRegistry.

An agentic turn — web searches, page fetches, then a long streamed answer — routinely runs
for minutes. The original design executed it inside a single live SSE response, so the turn's
survival was tied to one HTTP connection crossing a quick tunnel and a cellular link. When that
connection died mid-stream (confirmed live: the Cloudflare edge canceled a reply_stream ~3
minutes in), uvicorn cancelled the generator before sessions.record_assistant ran and the
entire response was silently discarded — the transcript kept the user's message and lost the
answer.

The fix (see app/jobs.py, CLAUDE.md invariant 1): run the turn in a background thread decoupled
from any connection, persist it server-side the moment it completes, and let clients POLL a
cheap snapshot endpoint. A client that comes back mid-turn reattaches to the running job and
still sees the live progression (interleaved text and tool calls, in arrival order); one that
comes back late finds the turn already in the transcript.

One job per session slug at a time: starting while one is running joins it (server-side twin of
the client's double-tap guard).
"""
from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator, Callable, Iterable
from dataclasses import dataclass, field

from . import agent, agent_harness, audio_jobs, config, logging_config, preview_jobs, sessions
from .agent import AgentError
from .jobs import Job, JobRegistry, new_id, now_iso
from .models import Turn

# runner(slug, history) yields the same event dicts as agent_harness.stream_agentic_events:
# {'type': 'text'|'tool'|'final', ...}. Sync or async iterator; injectable for tests.
RunnerFn = Callable[[str, list], "AsyncIterator[dict] | Iterable[dict]"]
PREVIEW_CADENCE_SECONDS = 3.0
log = logging_config.get("chat")


@dataclass
class ChatJob(Job):
    slug: str = ""                   # session this turn belongs to (also the registry dedup key)
    # The live turn as the client should render it: runs of assistant text and tool calls in
    # arrival order ({kind: 'text', text} | {kind: 'tool', name, detail}). Consecutive text is
    # merged server-side so a poll returns a handful of items, not thousands of deltas.
    items: list = field(default_factory=list)
    turn: dict | None = None         # parsed+recorded Turn.to_dict(), once done
    state: str | None = None         # session state after the turn, once done
    delivery_mode: str = "reading"  # reading | listening
    audio_job_id: str | None = None
    audio_error: str | None = None
    assistant_index: int | None = None
    preview_job_ids: list[str] = field(default_factory=list)
    preview_coordinator_id: str | None = None
    preview_complete: bool = True
    preview_phase: str | None = None
    preview_progress: dict = field(default_factory=dict)
    timings: dict[str, str] = field(default_factory=dict)
    # Best-effort stop requested by the user. The consume loops check it between runner events,
    # so the turn ends at the next event boundary; whatever canonical text already streamed is
    # recorded marked as stopped. The job still settles as 'done' — pollers see it finish early.
    cancelled: bool = False


# Finished jobs kept for late polls (pruned oldest-first past the cap). `_jobs` aliases the
# registry dict so tests can clear() it to reset.
_registry: JobRegistry[ChatJob] = JobRegistry("chat", max_finished=20)
_jobs = _registry.jobs


def get_job(job_id: str) -> ChatJob | None:
    return _registry.get(job_id)


def snapshot(job_id: str) -> dict | None:
    return _registry.snapshot(job_id)


def active_for(slug: str) -> ChatJob | None:
    """The running job for a session, if any — how a client that navigated away and returned
    finds the turn it left mid-flight."""
    return _registry.active_for(slug)


def request_cancel(job_id: str) -> dict | None:
    """Flag a running turn to stop at its next event boundary (no-op on settled jobs). Returns
    the job's snapshot, or None if the id is unknown. The actual stop happens in the worker
    thread: abandoning the runner iterator closes it, which tears down the model stream."""
    job = _registry.get(job_id)  # project-scoped, like get_job/snapshot
    if job is None:
        return None
    with _registry.lock:
        if job.status == "running":
            job.cancelled = True
    return snapshot(job_id)


def start_turn(slug: str, runner: RunnerFn | None = None,
               delivery_mode: str = "reading", model: str | None = None) -> ChatJob:
    """Start generating the assistant turn for `slug` in a background thread, or join the job
    already running for it. The user message must already be recorded (history is rebuilt from
    the session file inside the thread). Callers poll get_job(id) until it settles; the turn is
    recorded to the session the moment it completes, whether or not anyone is polling.

    `model` is a one-shot override for this turn only (ignored if a custom `runner` is
    injected — that's the tests' seam, not a production caller)."""
    if delivery_mode not in ("reading", "listening"):
        raise ValueError(f"Unknown delivery mode: {delivery_mode}")
    runner = runner or (lambda s, h: _default_events(s, h, model=model))

    def generate(job: ChatJob) -> None:
        job._preview_enabled = (job.delivery_mode == "listening"
                                and config.load_settings().get("speech_provider") == "openai")
        job._preview_last_started = time.monotonic()
        job._preview_next_sentence = 0
        job._preview_context = []
        job._tool_activity = []  # agent_activity source items, so cues can narrate tool use
        if job._preview_enabled:
            try:
                job._preview_context = preview_jobs.research_sources(job.slug)
            except Exception as exc:
                log.warning("could not build listening preview context chat=%s: %s",
                            job.id[:8], str(exc)[:200])
            with _registry.lock:
                job.preview_complete = False
                job.preview_phase = "analysis"
                job.preview_progress = {
                    "phase": "analysis",
                    "remaining_known": False,
                }
        history = sessions.build_history(job.slug)
        events = runner(job.slug, history)
        if hasattr(events, "__aiter__"):
            final_text = asyncio.run(_consume_async(job, events))
        else:
            final_text = _consume_sync(job, events)
        if job.cancelled:
            _record_cancelled(job, final_text)
            return
        turn = agent.parse(final_text)
        with _registry.lock:
            job.timings["analysis_complete"] = now_iso()
        if not turn.canonical.strip():
            raise AgentError("The model returned an empty response. Try again, or switch the "
                             "analysis model in Settings.")
        audio_job_id = None
        audio_error = None
        if job.delivery_mode == "listening":
            if config.load_settings().get("speech_provider") != "openai":
                audio_error = "Listening mode requires the OpenAI speech provider."
            else:
                try:
                    # Deterministic and side-effect free: persist the recoverable handoff before
                    # starting audio, so a restart can re-POST the same canonical text by id.
                    audio_job_id = audio_jobs.job_id_for(turn.canonical)
                except Exception as exc:
                    audio_error = f"Could not start listening audio: {str(exc)[:240]}"
        # Record before audio starts. A client that sees a completed chat job or refetches after
        # navigation always finds both the canonical response and its recoverable handoff.
        assistant_ts, assistant_index = sessions.record_assistant(
            job.slug,
            turn,
            delivery_mode=job.delivery_mode,
            chat_job_id=job.id,
            audio_job_id=audio_job_id,
            audio_error=audio_error,
        )
        if audio_job_id:
            try:
                started_audio_id = audio_jobs.start_job(
                    turn.canonical,
                    billing_project=config.active_project_id(),
                ).id
                if started_audio_id != audio_job_id:
                    audio_job_id = started_audio_id
                    sessions.update_assistant_audio(
                        job.slug,
                        assistant_ts,
                        audio_job_id=audio_job_id,
                        audio_error=None,
                    )
            except Exception as exc:
                audio_job_id = None
                audio_error = f"Could not start listening audio: {str(exc)[:240]}"
                sessions.update_assistant_audio(
                    job.slug,
                    assistant_ts,
                    audio_job_id=None,
                    audio_error=audio_error,
                )
        with _registry.lock:
            job.turn = turn.to_dict()
            job.state = sessions.get_state(job.slug)
            job.audio_job_id = audio_job_id
            job.audio_error = audio_error
            job.assistant_index = assistant_index

        if getattr(job, "_preview_enabled", False) and audio_job_id:
            sources = (preview_jobs.response_sources(turn.canonical)
                       + list(getattr(job, "_tool_activity", []))
                       + list(job._preview_context))

            def publish(ids: list[str], phase: str, progress: dict, complete: bool) -> None:
                with _registry.lock:
                    job.preview_job_ids = list(ids)
                    job.preview_phase = phase
                    job.preview_progress = dict(progress)
                    job.preview_complete = complete

            try:
                coordinator = preview_jobs.start_coordinator(
                    job.id,
                    audio_job_id,
                    sources,
                    job.preview_job_ids,
                    publish,
                    cadence_seconds=PREVIEW_CADENCE_SECONDS,
                    last_started_at=getattr(job, "_preview_last_started", time.monotonic()),
                    slug=job.slug,
                )
                with _registry.lock:
                    job.preview_coordinator_id = coordinator.id
            except Exception as exc:
                log.warning("could not continue listening previews chat=%s: %s",
                            job.id[:8], str(exc)[:200])
                _suppress_previews(job)
        else:
            _suppress_previews(job)

    def work(job: ChatJob) -> None:
        succeeded = False
        try:
            generate(job)
            succeeded = True
        finally:
            # On success, the coordinator owns suppression and runs until final narration is
            # ready. On any runner/parse/persistence failure, suppress before JobRegistry can
            # publish the terminal parent error.
            if not succeeded:
                _suppress_previews(job)
                # A failed turn that was a retry left an empty fork slot with no selector to
                # escape it; restore the branch the fork left (no-op otherwise).
                try:
                    sessions.rollback_empty_fork(job.slug)
                except Exception:
                    log.warning("empty-fork rollback failed for %s", job.slug)

    return _registry.start_or_join(
        slug,
        lambda: ChatJob(id=new_id(), slug=slug, delivery_mode=delivery_mode),
        work,
    )


def _default_events(slug: str, history: list, model: str | None = None):
    """The production runner: the agentic tool loop when enabled, else the single-shot token
    stream wrapped in the same event shape. `model` is a one-shot override for this turn only
    (see routers.session.DeliveryReq.model); None uses the account default."""
    if agent_harness.AGENTIC_ENABLED:
        return agent_harness.stream_agentic_events(slug, history,
                                                    model=agent_harness.model_override(model))

    def _single_shot():
        pieces: list[str] = []
        for piece in agent.stream_tokens(slug, history, model=model):
            pieces.append(piece)
            yield {"type": "text", "text": piece}
        yield {"type": "final", "text": "".join(pieces)}
    return _single_shot()


async def _consume_async(job: ChatJob, events: AsyncIterator[dict]) -> str:
    pieces: list[str] = []
    sent = 0
    final_text = ""
    async for ev in events:
        if job.cancelled:
            break  # abandoning the iterator closes it (loop shutdown), ending the model stream
        sent = _apply(job, ev, pieces, sent)
        if ev["type"] == "final":
            final_text = ev["text"]
    return final_text or "".join(pieces)


def _consume_sync(job: ChatJob, events: Iterable[dict]) -> str:
    pieces: list[str] = []
    sent = 0
    final_text = ""
    for ev in events:
        if job.cancelled:
            break  # abandoning the iterator closes it, ending the model stream
        sent = _apply(job, ev, pieces, sent)
        if ev["type"] == "final":
            final_text = ev["text"]
    return final_text or "".join(pieces)


def _apply(job: ChatJob, ev: dict, pieces: list[str], sent: int) -> int:
    """Fold one runner event into the job's items. Text deltas surface only their CANONICAL
    prefix (same incremental extraction the SSE path used), merged into the trailing text item;
    tool calls append a tool item. Returns the updated canonical-chars-shown count."""
    if ev["type"] == "text":
        pieces.append(ev["text"])
        canon = agent.canonical_prefix("".join(pieces))
        if len(canon) > sent:
            delta = canon[sent:]
            with _registry.lock:
                if "analysis_first_token" not in job.timings:
                    job.timings["analysis_first_token"] = now_iso()
                if job.items and job.items[-1]["kind"] == "text":
                    job.items[-1] = {"kind": "text", "text": job.items[-1]["text"] + delta}
                else:
                    job.items.append({"kind": "text", "text": delta})
            _maybe_start_preview(job, canon)
            return len(canon)
    elif ev["type"] == "tool":
        with _registry.lock:
            job.items.append({"kind": "tool", "name": ev["name"], "detail": ev.get("detail", "")})
        # Surface agentic tool use (web search, paper fetch, …) as grounded sources so listening
        # cues can narrate what the agent is doing, not just the prose it has written so far.
        acts = getattr(job, "_tool_activity", None)
        if acts is not None:
            name = str(ev.get("name") or "tool").replace("_", " ").strip()
            detail = str(ev.get("detail") or "").strip()
            text = f"The agent is using its {name} tool" + (f": {detail}" if detail else "") + "."
            acts.append({"id": f"tool{len(acts) + 1:04d}", "text": text[:300],
                         "kind": "agent_activity"})
            del acts[:-12]  # keep only the most recent dozen tool actions
    return sent


def _maybe_start_preview(job: ChatJob, canonical: str) -> None:
    """Publish a cue job without waiting for it; any cue failure is isolated from analysis."""
    if not getattr(job, "_preview_enabled", False):
        return
    completed = preview_jobs.completed_sentences(canonical)
    next_index = getattr(job, "_preview_next_sentence", 0)
    if len(completed) <= next_index:
        return
    now = time.monotonic()
    if now - getattr(job, "_preview_last_started", now) < PREVIEW_CADENCE_SECONDS:
        return

    previous_cue = ""
    if job.preview_job_ids:
        previous = preview_jobs.get_job(job.preview_job_ids[-1])
        if previous and previous.status == "running":
            return
        if previous and previous.status == "done" and previous.cue:
            previous_cue = previous.cue

    sentences = (
        [
            {"id": f"s{index + 1:04d}", "text": completed[index], "kind": "live_response"}
            for index in range(next_index, len(completed))
        ]
        + list(getattr(job, "_tool_activity", []))[-6:]
        + list(getattr(job, "_preview_context", []))
    )
    try:
        cue_job = preview_jobs.start_job(
            job.id,
            len(job.preview_job_ids) + 1,
            sentences,
            previous_cue,
            {
                "phase": "analysis",
                "completed_response_sentences": len(completed),
                "remaining_known": False,
            },
        )
    except Exception as exc:
        log.warning("could not start listening preview chat=%s: %s", job.id[:8], str(exc)[:200])
        return
    with _registry.lock:
        job.preview_job_ids.append(cue_job.id)
    job._preview_next_sentence = len(completed)
    job._preview_last_started = now


STOP_MARKER = "> Stopped by you — the response above is partial."


def _record_cancelled(job: ChatJob, partial_text: str) -> None:
    """Settle a stopped turn: record EXACTLY the canonical text the user watched stream
    (agent.canonical_prefix — the same extraction that fed job.items, so protocol scaffolding
    like a bare '### CANONICAL ###' never lands in the transcript), marked as stopped, and
    skip audio/cue work entirely. A turn stopped before any visible text records nothing —
    the user's message simply has no reply yet. A stopped partial never advances session
    state (a half-streamed proposal is not a proposal)."""
    with _registry.lock:
        job.timings["analysis_complete"] = now_iso()
    shown = agent.canonical_prefix(partial_text)
    if not shown:
        # Nothing recorded: if this turn was a retry, the fork's empty slot must not strand
        # the conversation without a selector — restore the branch it left.
        sessions.rollback_empty_fork(job.slug)
    if shown:
        turn = Turn(role="assistant", canonical=f"{shown}\n\n{STOP_MARKER}",
                    state_signal="in_discussion")
        _, assistant_index = sessions.record_assistant(
            job.slug, turn, delivery_mode=job.delivery_mode, chat_job_id=job.id)
        with _registry.lock:
            job.turn = turn.to_dict()
            job.assistant_index = assistant_index
    with _registry.lock:
        job.state = sessions.get_state(job.slug)
    _suppress_previews(job)


def _suppress_previews(job: ChatJob) -> None:
    if job.delivery_mode != "listening" or getattr(job, "_previews_suppressed", False):
        return
    preview_jobs.suppress(job.preview_job_ids)
    job._previews_suppressed = True
    with _registry.lock:
        job.preview_complete = True
        job.preview_phase = "complete"
