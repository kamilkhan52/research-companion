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

One job per paper/thread at a time: starting again in the same thread joins it (server-side
twin of the client's double-tap guard), while independent threads may generate concurrently.
"""
from __future__ import annotations

import asyncio
import re
import time
from collections.abc import AsyncIterator, Callable, Iterable
from dataclasses import dataclass, field

from . import (
    agent,
    agent_harness,
    audio_jobs,
    config,
    figures,
    graph,
    logging_config,
    preview_jobs,
    projects,
    quotas,
    rate_limits,
    sessions,
    store,
)
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
    slug: str = ""
    thread_id: str = sessions.MAIN_THREAD
    # The live turn as the client should render it: runs of assistant text and tool calls in
    # arrival order ({kind: 'text', text} | {kind: 'tool', name, detail}). Consecutive text is
    # merged server-side so a poll returns a handful of items, not thousands of deltas.
    items: list = field(default_factory=list)
    turn: dict | None = None         # parsed+recorded Turn.to_dict(), once done
    state: str | None = None         # session state after the turn, once done
    delivery_mode: str = "reading"  # reading | listening
    audio_job_id: str | None = None
    audio_error: str | None = None
    #: DR-056 — which section of the marker document the model is currently writing, so the
    #: client can stage the Finish-reading wait honestly: None/'drafting' (canonical preview),
    #: 'notes' (###NOTES_BLOCK### has appeared — the paper's notes are being drafted),
    #: 'synthesis' (###SYNTHESIS### — the Project Notes are being rewritten). Derived from the
    #: RAW stream server-side; markers never reach client items (only the canonical prefix
    #: streams), so the server is the only place this can be observed. Forward-only.
    notes_phase: str | None = None
    #: Structured refusal (DR-049) when starting the listening audio was REFUSED — the AudioJob
    #: that would carry it was never created, so this job is the only carrier (the exact shape
    #: of retrieval's `analysis_refusal`).
    audio_refusal: dict | None = None
    assistant_index: int | None = None
    preview_job_ids: list[str] = field(default_factory=list)
    preview_coordinator_id: str | None = None
    preview_complete: bool = True
    preview_phase: str | None = None
    preview_progress: dict = field(default_factory=dict)
    timings: dict[str, str] = field(default_factory=dict)
    # Honest reader-facing description while no canonical text is visible yet. It reflects
    # context actually available to this turn and updates when the agent begins tool work.
    activity: str = "Reading the paper…"
    # Best-effort stop requested by the user. The consume loops check it between runner events,
    # so the turn ends at the next event boundary; whatever canonical text already streamed is
    # recorded marked as stopped. The job still settles as 'done' — pollers see it finish early.
    cancelled: bool = False


# Finished jobs kept for late polls (pruned oldest-first past the cap). `_jobs` aliases the
# registry dict so tests can clear() it to reset.
_registry: JobRegistry[ChatJob] = JobRegistry("chat", max_finished=20, metered=True, operation="analysis")
_jobs = _registry.jobs


def get_job(job_id: str) -> ChatJob | None:
    return _registry.get(job_id)


def snapshot(job_id: str) -> dict | None:
    return _registry.snapshot(job_id)


def _session_key(slug: str, thread_id: str | None = None) -> str:
    selected = thread_id if thread_id is not None else sessions.active_thread_id()
    return f"{slug}::{sessions.validate_thread_id(selected)}"


def active_for(slug: str, thread_id: str | None = None) -> ChatJob | None:
    """The running job for a session, if any — how a client that navigated away and returned
    finds the turn it left mid-flight."""
    return _registry.active_for(_session_key(slug, thread_id))


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


def override_label(model: str | None) -> str | None:
    """The model name to record on a turn: the one-shot override when it differs from the
    settings default at generation time, else None (a default-model turn stays unlabeled —
    the UI only badges responses produced by a *different* model, e.g. a cross-model retry)."""
    if not model:
        return None
    return model if model != config.load_settings().get("model") else None


def start_turn(slug: str, runner: RunnerFn | None = None,
               delivery_mode: str = "reading", model: str | None = None,
               thread_id: str | None = None, metered: bool = True) -> ChatJob:
    """Start generating the assistant turn for `slug` in a background thread, or join the job
    already running for it. The user message must already be recorded (history is rebuilt from
    the session file inside the thread). Callers poll get_job(id) until it settles; the turn is
    recorded to the session the moment it completes, whether or not anyone is polling.

    `model` is a one-shot override for this turn only (ignored if a custom `runner` is
    injected — that's the tests' seam, not a production caller)."""
    if delivery_mode not in ("reading", "listening"):
        raise ValueError(f"Unknown delivery mode: {delivery_mode}")
    thread_id = sessions.validate_thread_id(
        thread_id if thread_id is not None else sessions.active_thread_id(),
    )
    runner = runner or (lambda s, h: _default_events(s, h, model=model))

    activity = _preparation_activity(slug)

    def generate(job: ChatJob) -> None:
        model_label = override_label(model)
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
            _record_cancelled(job, final_text, model_label=model_label)
            return
        turn = agent.parse(
            final_text,
            allow_proposed_commit=sessions.proposal_expected(job.slug),
        )
        with _registry.lock:
            job.timings["analysis_complete"] = now_iso()
        if not turn.canonical.strip():
            raise AgentError("The model returned an empty response. Try again, or switch the "
                             "analysis model in Settings.")
        # Stop boundaries around the editor pass: it is the longest post-stream window this
        # worker has (up to the per-attempt ceiling), with no runner events inside it — a Stop
        # tapped while the card says "Updating Project Notes…" must be honored at these
        # checkpoints rather than silently recording a full turn minutes later.
        if job.cancelled:
            _record_cancelled(job, final_text, model_label=model_label)
            return
        _maybe_edit_synthesis(job, turn, model=model)
        if job.cancelled:
            _record_cancelled(job, final_text, model_label=model_label)
            return
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
            model=model_label,
            agent_trail=_trail(job),
        )
        if audio_job_id:
            try:
                started_audio_id = audio_jobs.start_job(
                    turn.canonical,
                    billing_project=config.active_project_id(),
                    # Continuation of a turn the account was already admitted for. Charging it
                    # again would let one listening turn consume two concurrency slots, and the
                    # refusal would surface here as an `audio_error` string rather than a 429.
                    metered=False,
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
                if isinstance(exc, (quotas.QuotaError, rate_limits.RateLimited)):
                    with _registry.lock:
                        job.audio_refusal = exc.refusal_payload()
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
        with sessions.thread_scope(job.thread_id):
            try:
                generate(job)
                succeeded = True
            finally:
                # On success, the coordinator owns suppression and runs until final narration
                # is ready. On any failure, suppress before JobRegistry publishes the error.
                if not succeeded:
                    _suppress_previews(job)
                    # A failed retry left an empty fork slot with no selector to escape it.
                    try:
                        sessions.rollback_empty_fork(job.slug)
                    except Exception:
                        log.warning("empty-fork rollback failed for %s", job.slug)

    return _registry.start_or_join(
        _session_key(slug, thread_id),
        lambda: ChatJob(
            id=new_id(),
            slug=slug,
            thread_id=thread_id,
            delivery_mode=delivery_mode,
            activity=activity,
        ),
        work,
        metered=metered,
        # Exempt from the concurrency ceiling as a continuation, but its spend is still held:
        # an auto-analysis turn costs the same money as one the reader started.
        reserves=True,
    )


def _preparation_activity(slug: str) -> str:
    """Describe real context available to the pending turn, without exposing model internals.

    One short phrase, no explanatory second line. Each of these used to carry a subtitle that
    restated it in longer words — "Reviewing the discussion…" over "Connecting your message to the
    paper and prior turns." — which is prose occupying the moment a reader is waiting, and says
    nothing the phrase above it did not (DR-006). Genuine progress state still belongs in the UI;
    see the notes-revision card, which reports characters drafted.
    """
    if sessions.read_records(slug):
        return "Reviewing the discussion…"
    manifest = figures.manifest_for(slug) or {}
    has_figures = manifest.get("status") == "done" and bool(manifest.get("figures"))
    has_citers = bool(graph.project_citers_for(slug))
    if has_figures:
        return "Viewing figures…"
    if has_citers:
        return "Tracing project citations…"
    return "Reading the paper…"


def _tool_activity(name: str) -> str:
    """The one-line status for a tool call. See `_preparation_activity` on why there is no
    second line."""
    labels = {
        "web_search": "Searching the literature…",
        "web_fetch": "Reading sources…",
        "read_paper_text": "Comparing project papers…",
        "related_papers": "Tracing project citations…",
        "list_project_papers": "Reviewing the project…",
    }
    return labels.get(name, "Gathering evidence…")


def _single_shot_events(slug: str, history: list, model: str | None = None):
    """The single-shot token stream wrapped in the runner's event shape — the non-agentic
    path, and the fallback when an agentic turn can't tool-call."""
    pieces: list[str] = []
    for piece in agent.stream_tokens(slug, history, model=model):
        pieces.append(piece)
        yield {"type": "text", "text": piece}
    yield {"type": "final", "text": "".join(pieces)}


def _default_events(slug: str, history: list, model: str | None = None):
    """The production runner: the agentic tool loop when enabled, else the single-shot token
    stream wrapped in the same event shape. `model` is a one-shot override for this turn only
    (see routers.session.DeliveryReq.model); None uses the account default. When agentic, a
    tool-incompatible model falls back to the single-shot path rather than failing (R12.8)."""
    if agent_harness.AGENTIC_ENABLED:
        return agent_harness.stream_with_single_shot_fallback(
            lambda: agent_harness.stream_agentic_events(
                slug, history, model=agent_harness.model_override(model)),
            lambda: _single_shot_events(slug, history, model),
        )
    return _single_shot_events(slug, history, model)


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


def _trail(job: ChatJob) -> list[dict]:
    """The finished turn's activity trail: everything the agent did before the answer (tool
    calls + demoted pre-tool commentary), in arrival order. Persisted on the assistant record
    so the collapsed trail survives refetch/restart."""
    with _registry.lock:
        return [dict(it) for it in job.items if it.get("kind") in ("tool", "thought")]


# Tolerant of heading drift like agent._parse ("## NOTES_BLOCK"), but anchored to a line of
# its own: the finish prompt asks the CANONICAL preview to talk ABOUT the notes and synthesis,
# so prose like "## SYNTHESIS OF RESULTS" must not skip a stage — that is precisely the
# dishonesty DR-056 exists to remove.
_NOTES_MARKER_RE = re.compile(r"^\s*#{2,}\s*NOTES_BLOCK\s*#*\s*$", re.M)
_SYNTHESIS_MARKER_RE = re.compile(r"^\s*#{2,}\s*SYNTHESIS\s*#*\s*$", re.M)
#: Base scan window. The effective window also covers the whole incoming delta (plus slack for
#: a straddled marker): a provider that emits its completion in one large chunk would otherwise
#: hide a marker deeper than any fixed tail.
_PHASE_SCAN_TAIL = 4_000


def _advance_notes_phase(job: ChatJob, full: str, delta_len: int = 0) -> None:
    """Forward-only phase advance from the raw stream (DR-056). Cheap: scans a tail sized to
    the delta, and only for markers not yet seen. Ordinary turns emit no NOTES/SYNTHESIS marker
    lines, so their phase stays None and the client's staged card never renders for them."""
    tail = full[-max(_PHASE_SCAN_TAIL, delta_len + 200):]
    if job.notes_phase != "synthesis" and _SYNTHESIS_MARKER_RE.search(tail):
        with _registry.lock:
            job.notes_phase = "synthesis"
    elif job.notes_phase is None and _NOTES_MARKER_RE.search(tail):
        with _registry.lock:
            job.notes_phase = "notes"


def _maybe_edit_synthesis(job: ChatJob, turn, model: str | None = None) -> None:
    """DR-058 — replace the finish turn's single-shot working-notes rewrite with the separate
    synthesis-editor pass, and OVERWRITE any synthesis the model emitted despite the prompt:
    skipping the editor when the model drifted would silently revert to the over-weighted
    rewrite this feature removes.

    Finish turns only. Revisions stay single-shot (the reader's feedback addresses an existing
    proposal, both halves of which the model must adjust together), and the project review
    chat's synthesis-only proposals have no paper notes to edit from.

    Spend semantics, decided deliberately (the admission-state lesson): this is a CONTINUATION
    of the one thing the reader asked for — Finish — on the chat worker, inside the turn's own
    reservation, exactly like the narration continuation. `usage.record` meters the pass under
    `synthesis_edit` against that hold; the analysis hold ($0.15) comfortably covers the
    measured turn (~$0.06) plus this pass. A second admission would let one Finish consume two
    concurrency slots and refuse mid-flight with a ghost 429.

    Runs BEFORE record_assistant: a failed editor fails the turn cleanly (retryable, like a
    parse failure) rather than persisting a proposal whose approval would erase the working
    notes. The paid first pass is lost on that path — the same cost a parse failure already
    carries.
    """
    if job.slug == sessions.REVIEW_SLUG:
        # The review chat's synthesis-only proposals come from a discussion ABOUT the corpus;
        # an editor pass that never saw that discussion must not replace its deliverable. By
        # name, not by shape — excluding it only via an empty notes_block left it one model
        # drift away from exactly that.
        return
    proposed = turn.proposed_commit
    if not proposed:
        return
    records = sessions.read_records(job.slug)
    if not (records and records[-1].get("role") == "user"
            and records[-1].get("kind") == "finish"):
        return
    if not proposed.get("notes_block"):
        # A paper finish that proposed a SYNTHESIS but no Paper Notes block is drift the guard must
        # not wave through: skipping the editor here would let the over-weighted single-shot
        # rewrite survive — the exact thing this pass exists to remove.
        raise AgentError("The model returned no Paper Notes block for this paper. "
                         "Try Finish reading again.")
    # DR-056's second stage IS this pass now: the finish stream no longer carries a SYNTHESIS
    # marker (the prompt says leave it NONE), so the stage flips here, honestly.
    with _registry.lock:
        job.notes_phase = "synthesis"
        job.activity = "Updating the Project Notes…"
    pid = config.active_project_id()
    meta = projects._read_meta(pid) if pid else {}
    plan, synthesis = agent.edit_synthesis(
        project_name=meta.get("name") or (pid or "this project"),
        goals=(meta.get("goals") or "").strip(),
        current_synthesis=store.read_synthesis(),
        paper_title=store.title_for(job.slug),
        notes_block=proposed["notes_block"],
        # The turn's one-shot model override applies to the whole Finish, this pass included —
        # a cross-model retry must not silently edit the notes on the account default.
        model=model,
    )
    proposed["synthesis"] = synthesis
    proposed["plan"] = plan


def _apply(job: ChatJob, ev: dict, pieces: list[str], sent: int) -> int:
    """Fold one runner event into the job's items. Text deltas surface only their CANONICAL
    prefix (same incremental extraction the SSE path used), merged into the trailing text item;
    tool calls append a tool item; a 'segment' boundary demotes the text streamed so far to a
    'thought' trail item and restarts answer accumulation (the text of every request but the
    run's last is pre-tool commentary, not the answer — R6.8). Returns the updated
    canonical-chars-shown count."""
    if ev["type"] == "segment":
        if not pieces:
            return sent
        pieces.clear()
        with _registry.lock:
            job.activity = "Analyzing results…"
            # The boundary means "the answer starts over" — including the single-shot fallback
            # replaying the whole turn. notes_phase must restart with the document, or pre-tool
            # commentary that named a marker pins a stage before the real document exists.
            job.notes_phase = None
            # At most one live text item exists (each boundary demotes the previous one); it
            # sits before any tool items from the same segment, so demote it in place.
            for i in range(len(job.items) - 1, -1, -1):
                if job.items[i]["kind"] == "text":
                    thought = job.items[i]["text"].strip()
                    if thought:
                        job.items[i] = {"kind": "thought", "text": thought}
                    else:
                        del job.items[i]
                    break
        # Let the real answer's opening sentences feed listening cues too (commentary
        # sentences already cued are fine — cues exist to fill exactly this wait).
        job._preview_next_sentence = 0
        return 0
    if ev["type"] == "text":
        pieces.append(ev["text"])
        full = "".join(pieces)
        _advance_notes_phase(job, full, len(ev["text"]))
        canon = agent.canonical_prefix(full)
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
            job.activity = _tool_activity(str(ev.get("name") or ""))
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
    # The cue allowance covers the whole wait, and this producer runs FIRST — a long analysis
    # would otherwise spend the entire budget (and more) before the post-analysis coordinator,
    # which is the other producer, ever sees these ids.
    if preview_jobs.budget_exhausted(job.preview_job_ids):
        return
    completed = preview_jobs.completed_sentences(canonical)
    next_index = getattr(job, "_preview_next_sentence", 0)
    if len(completed) <= next_index:
        return
    now = time.monotonic()
    if now - getattr(job, "_preview_last_started", now) < PREVIEW_CADENCE_SECONDS:
        return

    # Don't launch a new cue while the previous one is still generating (avoids stacking).
    if job.preview_job_ids:
        last = preview_jobs.get_job(job.preview_job_ids[-1])
        if last and last.status == "running":
            return
    # The client explicitly acknowledges cues its audio layer accepted. Give the next
    # generation the complete played history, plus all generated cues as a second guard
    # against repeating a cue that was produced but dropped during the audio handoff.
    played_cues, generated_cues = preview_jobs.cue_history(job.preview_job_ids)
    previous_cue = "\n".join(played_cues or generated_cues)

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
            played_cues=played_cues,
            generated_cues=generated_cues,
        )
    except Exception as exc:
        log.warning("could not start listening preview chat=%s: %s", job.id[:8], str(exc)[:200])
        return
    with _registry.lock:
        job.preview_job_ids.append(cue_job.id)
    job._preview_next_sentence = len(completed)
    job._preview_last_started = now


STOP_MARKER = "> Stopped by you — the response above is partial."


def _record_cancelled(job: ChatJob, partial_text: str, model_label: str | None = None) -> None:
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
            job.slug, turn, delivery_mode=job.delivery_mode, chat_job_id=job.id,
            model=model_label, agent_trail=_trail(job))
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
