"""Per-project reading-session routes: paper retrieval, the compose-first opening, and every
turn-delivery path — streaming SSE (web), background job + poll (mobile), and the plain
non-streaming variants. The `_prep_*` helpers validate and mutate the session exactly as each
endpoint always did; only how the resulting turn is delivered differs. See CLAUDE.md invariant 1
(long/LLM turns are jobs, never a connection-tied stream across the tunnel)."""
from __future__ import annotations

import asyncio
import json
import threading
import time
from typing import Literal

from fastapi import File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .. import (
    affiliation_jobs,
    affiliations,
    agent,
    agent_harness,
    chat_jobs,
    committer,
    config,
    cover_jobs,
    graph,
    preview_jobs,
    prompts,
    retrieval_agent,
    retrieval_jobs,
    retriever,
    sessions,
    store,
)
from ..agent import AgentError
from ..models import COMMITTED, REVIEW_SLUG, REVIEW_TITLE
from ..retriever import RetrievalError
from . import make_project_router

project_router = make_project_router()


class _PaperGoneError(Exception):
    """A split/move removed the paper while we were retrieving it — its corpus must not be
    recreated (that would orphan a file with no reading-list entry). See task #75b."""


def _guarded_write(slug: str, do_write) -> None:
    """Run a retrieval's corpus write under the project write guard, re-checking the paper is
    still in the project first. The (slow) retrieval itself stays OUTSIDE this guard, so a
    split/move never waits on a network call — only the quick write is serialized, and it can't
    recreate a paper the relocation just removed. Raises config.ProjectBusyError (project
    reserved by a relocation) or _PaperGoneError (paper removed mid-retrieve). `do_write` is a
    zero-arg callback holding the actual store writes (and any cover render, which runs
    in-thread here). Callers on the event loop invoke this via asyncio.to_thread."""
    with config.project_write_guard(config.active_project_id()):
        if store.get_paper(slug) is None:
            raise _PaperGoneError(slug)
        do_write()


# ---------- request models ----------

class StartReq(BaseModel):
    slug: str
    arxiv_id: str | None = None
    pdf_url: str | None = None


class DeliveryReq(BaseModel):
    delivery_mode: Literal["reading", "listening"] = "reading"
    thread_id: str = sessions.MAIN_THREAD
    # One-shot model override for this turn only — never persisted to settings (locked product
    # decision: composer model selection applies to one response only and never silently
    # changes the default). None falls through to the account's configured default.
    model: str | None = None


class ChatStartReq(DeliveryReq):
    slug: str
    prompt: str | None = None   # edited first-prompt template for this session
    # Reading mode chosen at session start (polish plan H.3); None keeps the default.
    mode: Literal["balanced", "background", "technical", "detailed"] | None = None


class ModeReq(BaseModel):
    slug: str
    mode: Literal["balanced", "background", "technical", "detailed"]
    thread_id: str = sessions.MAIN_THREAD


class ReplyComment(BaseModel):
    quote: str = Field(min_length=1, max_length=4000)
    comment: str = Field(min_length=1, max_length=4000)


class ReplyReq(DeliveryReq):
    slug: str
    text: str = ""
    comments: list[ReplyComment] = Field(default_factory=list, max_length=20)


class FinishReq(DeliveryReq):
    slug: str


class RequestChangesReq(DeliveryReq):
    slug: str
    text: str


class RetryReq(DeliveryReq):
    slug: str
    assistant_index: int
    # The first response can be retried with the same prompt-type/model choices as session
    # start. These are branch-scoped; later-turn retries cannot change the opening context.
    prompt: str | None = None
    mode: Literal["balanced", "background", "technical", "detailed"] | None = None


class BranchSwitchReq(BaseModel):
    slug: str
    assistant_index: int
    branch: int  # 1-based ordinal shown in the selector ("2/3" -> branch=2)
    thread_id: str = sessions.MAIN_THREAD


class EditReq(DeliveryReq):
    slug: str
    reply_index: int
    text: str


class CreateThreadReq(BaseModel):
    title: str | None = None


def _thread_id(value: str | None) -> str:
    try:
        return sessions.validate_thread_id(value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# ---------- streaming helpers ----------

def _run_and_record(slug: str, model: str | None = None) -> dict:
    history = sessions.build_history(slug)
    try:
        turn = agent.run_turn(slug, history, model=model)
    except AgentError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    sessions.record_assistant(slug, turn, model=chat_jobs.override_label(model))
    return turn.to_dict()


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


# SSE turns are connection-tied and invisible to the chat JobRegistry, so the empty-fork
# recovery in get_session and the branch-mutation guards must consult this in-process marker
# too. Registered EAGERLY by the route (a generator body doesn't run until its first pull, so
# lazy registration left a guard window) and refreshed/discarded by the generator itself.
# Entries carry a timestamp: if a response object is never consumed, its finally never runs,
# so stale entries expire instead of wedging the session's guards forever. Single-worker
# process (CLAUDE.md invariant 6).
_active_sse_turns: dict[tuple[str | None, str, str], float] = {}
_active_sse_lock = threading.Lock()
_SSE_TURN_TTL_S = 2 * 60 * 60.0


def _register_sse_turn(slug: str) -> None:
    with _active_sse_lock:
        _active_sse_turns[
            (config.active_project_id(), slug, sessions.active_thread_id())
        ] = time.monotonic()


def _discard_sse_turn(slug: str) -> None:
    with _active_sse_lock:
        _active_sse_turns.pop(
            (config.active_project_id(), slug, sessions.active_thread_id()),
            None,
        )


def _sse_turn_active(slug: str) -> bool:
    with _active_sse_lock:
        started = _active_sse_turns.get(
            (config.active_project_id(), slug, sessions.active_thread_id()),
        )
        return started is not None and time.monotonic() - started < _SSE_TURN_TTL_S


def any_sse_turn_active(slug: str) -> bool:
    """Whether any independent thread for this paper has a live legacy SSE turn."""
    pid = config.active_project_id()
    now = time.monotonic()
    with _active_sse_lock:
        return any(
            key_pid == pid and key_slug == slug and now - started < _SSE_TURN_TTL_S
            for (key_pid, key_slug, _thread_id_), started in _active_sse_turns.items()
        )


def _turn_stream(
    slug: str,
    model: str | None = None,
    thread_id: str = sessions.MAIN_THREAD,
):
    """Stream the analysis turn as SSE: incremental CANONICAL text, then a final 'done'
    event carrying the parsed+recorded turn. The user message must already be recorded."""
    with sessions.thread_scope(thread_id):
        try:
            _register_sse_turn(slug)
            history = sessions.build_history(slug)
            pieces: list[str] = []
            sent = 0
            try:
                for piece in agent.stream_tokens(slug, history, model=model):
                    pieces.append(piece)
                    canon = agent.canonical_prefix("".join(pieces))
                    if len(canon) > sent:
                        yield _sse({"type": "delta", "text": canon[sent:]})
                        sent = len(canon)
            except AgentError as e:
                yield _sse({"type": "error", "detail": str(e)})
                return
            turn = agent.parse(
                "".join(pieces),
                allow_proposed_commit=sessions.proposal_expected(slug),
            )
            if not turn.canonical.strip():
                yield _sse({"type": "error", "detail":
                            "The model returned an empty response. Try again, or switch the "
                            "analysis model in Settings."})
                return
            sessions.record_assistant(slug, turn, model=chat_jobs.override_label(model))
            yield _sse({
                "type": "done",
                "turn": turn.to_dict(),
                "state": sessions.get_state(slug),
            })
        finally:
            _discard_sse_turn(slug)


async def _agentic_turn_stream(
    slug: str,
    model: str | None = None,
    thread_id: str = sessions.MAIN_THREAD,
):
    """Streaming turn through the Pydantic AI tool loop (when RC_AGENTIC is on). Same client
    contract as _turn_stream — incremental CANONICAL 'delta' events then a final 'done' — plus
    'tool' events announcing each research tool the model calls. The final answer is parsed from
    the agent's authoritative output."""
    with sessions.thread_scope(thread_id):
        _register_sse_turn(slug)
        try:
            async for chunk in _agentic_turn_events(slug, model):
                yield chunk
        finally:
            _discard_sse_turn(slug)


async def _agentic_turn_events(slug: str, model: str | None = None):
    history = sessions.build_history(slug)
    pieces: list[str] = []
    sent = 0
    final_text = ""
    trail: list[dict] = []  # demoted commentary + tool calls, persisted with the turn (R6.8)
    try:
        async for ev in agent_harness.stream_agentic_events(
            slug, history, model=agent_harness.model_override(model)
        ):
            if ev["type"] == "text":
                pieces.append(ev["text"])
                canon = agent.canonical_prefix("".join(pieces))
                if len(canon) > sent:
                    yield _sse({"type": "delta", "text": canon[sent:]})
                    sent = len(canon)
            elif ev["type"] == "segment":
                # A new model request begins: what streamed so far was pre-tool commentary,
                # not the answer. Demote it to the trail, restart accumulation, and tell the
                # client to reset its bubble (the recorded answer comes only from the final
                # request — R6.8).
                if pieces:
                    thought = agent.canonical_prefix("".join(pieces)).strip()
                    if thought:
                        trail.append({"kind": "thought", "text": thought})
                    pieces.clear()
                    sent = 0
                    yield _sse({"type": "segment"})
            elif ev["type"] == "tool":
                trail.append({"kind": "tool", "name": ev["name"],
                              "detail": ev.get("detail", "")})
                yield _sse({"type": "tool", "name": ev["name"], "detail": ev.get("detail", "")})
            elif ev["type"] == "final":
                final_text = ev["text"]
    except AgentError as e:
        yield _sse({"type": "error", "detail": str(e)})
        return
    turn = agent.parse(
        final_text or "".join(pieces),
        allow_proposed_commit=sessions.proposal_expected(slug),
    )
    if not turn.canonical.strip():
        yield _sse({"type": "error", "detail":
                    "The model returned an empty response. Try again, or switch the analysis "
                    "model in Settings."})
        return
    sessions.record_assistant(slug, turn, model=chat_jobs.override_label(model),
                              agent_trail=trail or None)
    yield _sse({"type": "done", "turn": turn.to_dict(), "state": sessions.get_state(slug)})


def _stream_for(
    slug: str,
    model: str | None = None,
    thread_id: str = sessions.MAIN_THREAD,
):
    """Pick the streaming turn implementation: the agentic tool loop when enabled, else the
    proven single-shot stream. Both are (async/sync) generators StreamingResponse can consume."""
    if agent_harness.AGENTIC_ENABLED:
        return _agentic_turn_stream(slug, model=model, thread_id=thread_id)
    return _turn_stream(slug, model=model, thread_id=thread_id)


_SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


# ---------- session flows (Section 9) ----------

@project_router.get("/session/{slug}")
def get_session(slug: str, thread_id: str = sessions.MAIN_THREAD):
    thread_id = _thread_id(thread_id)
    with sessions.thread_scope(thread_id):
        return _get_session(slug, thread_id)


def _get_session(slug: str, thread_id: str):
    if thread_id != sessions.MAIN_THREAD:
        known = {thread["id"] for thread in sessions.list_threads(slug)}
        if thread_id not in known:
            raise HTTPException(status_code=404, detail="Unknown discussion thread")
    # Durable empty-fork recovery: a crash/restart between a retry's fork and its response
    # loses the worker's own rollback. If no turn is generating and an aged fork's active
    # tail is still empty, restore the branch it left (no-op otherwise; the grace window
    # keeps this from racing a retry that was just prepped).
    if (not config.project_is_busy(config.active_project_id())
            and not chat_jobs.active_for(slug)
            and not _sse_turn_active(slug)):
        with sessions.paper_lock(slug), sessions.mutation_lock(slug):
            if (not config.project_is_busy(config.active_project_id())
                    and not chat_jobs.active_for(slug)
                    and not _sse_turn_active(slug)):
                sessions.rollback_empty_fork(slug, min_age_s=30.0)
    if slug == REVIEW_SLUG:
        paper = {"slug": REVIEW_SLUG, "title": REVIEW_TITLE, "kind": "review",
                 "list_status": "n/a", "session_state": sessions.get_state(REVIEW_SLUG)}
    else:
        p = store.get_paper(slug, sessions.session_states())
        if not p:
            raise HTTPException(status_code=404, detail="Unknown paper")
        affiliation_jobs.reconcile_pending([slug])
        paper = p.to_dict()
        paper.update(affiliations.paper_summary(slug))
        paper["last_interacted_at"] = (sessions.index_entry(slug) or {}).get("updated_at")
    return {
        "paper": paper,
        "state": sessions.get_state(slug),
        "reading_mode": sessions.get_reading_mode(slug),
        "transcript": sessions.transcript(slug),
        "accepted_drafts": sessions.accepted_drafts(slug),
        "thread_id": thread_id,
        "threads": sessions.list_threads(slug),
    }


@project_router.get("/opening_draft/{slug}")
def opening_draft(slug: str, thread_id: str = sessions.MAIN_THREAD):
    """The editable first-prompt + default model for the compose-first screen. Returns the
    session's edited opening if one exists (for first-response retry), else the default."""
    with sessions.thread_scope(_thread_id(thread_id)):
        model = config.load_settings().get("model")
        stored = sessions.get_opening(slug)
        if slug == REVIEW_SLUG:
            base = prompts.get("review_opening")
            title = REVIEW_TITLE
        else:
            p = store.get_paper(slug)
            if not p:
                raise HTTPException(status_code=404, detail="Unknown paper")
            base = prompts.get("opening_message").replace("{title}", p.title)
            title = p.title
        return {
            "prompt": stored or base,
            "templates": _opening_prompt_templates(base),
            "model": model,
            "title": title,
        }


@project_router.post("/session/{slug}/threads")
def create_thread(slug: str, req: CreateThreadReq):
    if slug == REVIEW_SLUG:
        raise HTTPException(status_code=400, detail="The working-notes review has one thread.")
    if not store.get_paper(slug):
        raise HTTPException(status_code=404, detail="Unknown paper")
    if config.project_is_busy(config.active_project_id()):
        raise HTTPException(
            status_code=409,
            detail="This project is being moved or split — wait, then start a thread.",
        )
    try:
        with sessions.paper_lock(slug):
            thread = sessions.create_thread(slug, req.title or "New thread")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"thread": thread, "threads": sessions.list_threads(slug)}


def _opening_prompt_templates(base: str) -> dict[str, str]:
    """Compose the visible first-turn prompt for every Reading Mode.

    The mode prompt files remain the editable source of truth. Presets partially write the
    initial instruction by appending their guidance to the common opening; Customize Prompt
    can then expose the complete composed text for unrestricted editing in the client.
    """
    templates = {"balanced": base}
    for mode in ("background", "technical", "detailed"):
        templates[mode] = (
            base
            + "\n\n[READING MODE GUIDANCE FOR THIS OPENING]\n"
            + prompts.get(f"reading_mode_{mode}").strip()
        )
    return templates


@project_router.post("/start")
def start_paper(req: StartReq):
    """Retrieve + cache a paper's full text (no session, no turn). The compose-first screen
    fires the first turn separately via /api/chat/start_stream."""
    paper = store.get_paper(req.slug)
    if not paper:
        raise HTTPException(status_code=404, detail="Unknown paper")
    if paper.retrieved and not req.arxiv_id and not req.pdf_url:
        affiliation_jobs.warm_async(req.slug)
        return {"ok": True, "retrieved": True}
    try:
        res = retriever.retrieve(paper.title, req.arxiv_id, req.pdf_url)
    except RetrievalError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    if res.get("needs_confirmation"):
        return {"needs_confirmation": True, "candidates": res["candidates"], "slug": req.slug}

    def _write():
        store.write_full_text(req.slug, paper.title, res["full_text"], {
            "slug": req.slug, "arxiv_id": res.get("arxiv_id"), "source": res.get("source"),
            "match_score": res.get("score"),
        })
        # An explicitly supplied id corrects any machine-resolved one on the entry — but only
        # when the result IS that id (a failed explicit download falls back to title search).
        if (req.arxiv_id and res.get("arxiv_id")
                and store.arxiv_base_id(res["arxiv_id"]) == store.arxiv_base_id(req.arxiv_id)):
            store.annotate_entry(req.slug, arxiv_id=res["arxiv_id"], authoritative=True)
        cover_jobs.render_from_pdf(req.slug, res.get("pdf_bytes"))  # reuse the just-downloaded PDF

    try:
        _guarded_write(req.slug, _write)
    except config.ProjectBusyError as e:
        raise HTTPException(
            status_code=409,
            detail="This project is being moved or split — wait, then retrieve.") from e
    except _PaperGoneError as e:
        raise HTTPException(
            status_code=409,
            detail="This paper is no longer in the project (it may have just been moved).") from e
    affiliation_jobs.warm_async(req.slug)
    return {"ok": True, "retrieved": True}


class RetrievalJobReq(StartReq):
    # R7.8: chain the paper's FIRST analysis onto a successful retrieval, so "add paper →
    # analyzed and narrated" is one durable server-side flow the user can walk away from.
    auto_analyze: bool = False
    mode: Literal["balanced", "background", "technical", "detailed"] | None = None
    delivery_mode: Literal["reading", "listening"] = "reading"


def _first_analysis_hook(req: RetrievalJobReq):
    """The after-retrieval continuation: start the session with the chosen Reading Mode's
    opening template and spawn the normal chat turn job. Runs inside the retrieval worker
    (project contextvar rebound by the registry) or, for an already-retrieved paper, on the
    request thread. Mirrors /chat/start_job exactly — same lock, same prep."""
    def kick(job) -> None:
        slug = req.slug
        with sessions.mutation_lock(slug):
            if sessions.get_state(slug):
                return  # an existing discussion must never be clobbered by an auto-start
            p = store.get_paper(slug)
            if not p:
                raise RetrievalError("Unknown paper")
            base = prompts.get("opening_message").replace("{title}", p.title)
            prompt = _opening_prompt_templates(base).get(req.mode or "balanced", base)
            chat_req = ChatStartReq(
                slug=slug, prompt=prompt,
                mode=(req.mode if req.mode and req.mode != "balanced" else None),
                delivery_mode=req.delivery_mode,
            )
            _prep_chat_start(chat_req)
            chat_job = chat_jobs.start_turn(slug, delivery_mode=req.delivery_mode)
        retrieval_jobs.set_analysis_job(job, chat_job.id)
    return kick


@project_router.post("/retrieval/jobs")
def start_retrieval_job(req: RetrievalJobReq):
    """Start or join connection-independent paper retrieval and return immediately. With
    auto_analyze, a successful retrieval flows straight into the first analysis turn; the
    spawned chat job's id lands on the retrieval snapshot (`analysis_job_id`)."""
    hook = _first_analysis_hook(req) if req.auto_analyze else None
    try:
        # start_retrieval owns the whole chain: worker-side on a fresh job, attach-on-join for
        # a retrieval already running, and inline for the already-retrieved short-circuit.
        job = retrieval_jobs.start_retrieval(
            req.slug, req.arxiv_id, req.pdf_url, after_retrieved=hook,
        )
    except RetrievalError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return {"job": retrieval_jobs.snapshot(job.id)}


@project_router.get("/retrieval/jobs/latest/{slug}")
def latest_retrieval_job(slug: str):
    """Latest retained retrieval for re-entry, including terminal candidates/errors."""
    job = retrieval_jobs.latest_for(slug)
    return {"job": retrieval_jobs.snapshot(job.id) if job else None}


@project_router.get("/retrieval/jobs/{job_id}")
def retrieval_job_status(job_id: str):
    snap = retrieval_jobs.snapshot(job_id)
    if not snap:
        raise HTTPException(status_code=404, detail="Unknown retrieval job")
    return {"job": snap}


@project_router.get("/related/{slug}")
def related_works(slug: str):
    """The paper's most significant related works (from the stored reference graph), backing
    the reading session's 'Related works' menu."""
    return {"related": graph.related_works_for(slug)}


@project_router.post("/start_stream")
async def start_paper_stream(req: StartReq):
    """Streaming variant of /start: emits 'step' events (deterministic stages + the PDF-hunt
    agent's tool calls) so the client can show what retrieval is doing, then 'done' /
    'needs_confirmation' / 'error'. Escalation: deterministic retriever first (fast, free);
    if it fails, an agentic web hunt for the PDF (papers not on arXiv, throttled APIs...)."""
    paper = store.get_paper(req.slug)

    async def gen():
        if not paper:
            yield _sse({"type": "error", "detail": "Unknown paper"})
            return
        if paper.retrieved and not req.arxiv_id and not req.pdf_url:
            affiliation_jobs.warm_async(req.slug)
            yield _sse({"type": "done", "retrieved": True})
            return
        yield _sse({"type": "step", "name": "arxiv", "detail": req.arxiv_id or req.pdf_url or paper.title[:60]})
        first_error = None
        try:
            res = await asyncio.to_thread(retriever.retrieve, paper.title, req.arxiv_id, req.pdf_url)
        except RetrievalError as e:
            res, first_error = None, str(e)
        if res and res.get("needs_confirmation"):
            yield _sse({"type": "needs_confirmation", "candidates": res["candidates"]})
            return
        if res:
            def _write_deterministic():
                store.write_full_text(req.slug, paper.title, res["full_text"], {
                    "slug": req.slug, "arxiv_id": res.get("arxiv_id"),
                    "source": res.get("source"), "match_score": res.get("score")})
                # An explicitly supplied id corrects any machine-resolved one on the entry —
                # but only when the result IS that id (a failed explicit download falls back to
                # title search).
                if (req.arxiv_id and res.get("arxiv_id")
                        and store.arxiv_base_id(res["arxiv_id"])
                        == store.arxiv_base_id(req.arxiv_id)):
                    store.annotate_entry(req.slug, arxiv_id=res["arxiv_id"], authoritative=True)
                cover_jobs.render_from_pdf(req.slug, res.get("pdf_bytes"))  # sync, in-thread
            # Whole write (guard + re-check + cover render) runs in one worker thread, off the
            # event loop; the guard keeps it from overlapping a split/move (task #75b).
            try:
                await asyncio.to_thread(_guarded_write, req.slug, _write_deterministic)
            except config.ProjectBusyError:
                yield _sse({"type": "error", "detail":
                            "This project is being moved or split — retry in a moment."})
                return
            except _PaperGoneError:
                yield _sse({"type": "error", "detail":
                            "This paper is no longer in the project (it may have been moved)."})
                return
            affiliation_jobs.warm_async(req.slug)
            yield _sse({"type": "done", "retrieved": True})
            return
        # Deterministic path failed — agentic hunt (needs an OpenRouter key like any turn).
        if not config.has_api_key():
            yield _sse({"type": "error", "detail": first_error})
            return
        try:
            async for ev in retrieval_agent.stream_hunt(paper.title):
                if ev["type"] == "tool":
                    yield _sse({"type": "step", "name": ev["name"], "detail": ev.get("detail", "")})
                elif ev["type"] == "result":
                    if ev.get("ok"):
                        def _write_hunted(ev=ev):
                            store.write_full_text(req.slug, paper.title, ev["full_text"], {
                                "slug": req.slug, "source": ev.get("source")})
                        try:
                            await asyncio.to_thread(_guarded_write, req.slug, _write_hunted)
                        except config.ProjectBusyError:
                            yield _sse({"type": "error", "detail":
                                        "This project is being moved or split — retry."})
                            return
                        except _PaperGoneError:
                            yield _sse({"type": "error", "detail":
                                        "This paper is no longer in the project."})
                            return
                        affiliation_jobs.warm_async(req.slug)
                        yield _sse({"type": "done", "retrieved": True})
                    else:
                        yield _sse({"type": "error", "detail":
                                    (first_error or "Retrieval failed.") + " The PDF hunt also "
                                    "came up empty — paste a PDF link in 'Provide a source'."})
                    return
        except Exception as e:
            yield _sse({"type": "error", "detail": f"{first_error or 'Retrieval failed.'} "
                        f"(hunt error: {str(e)[:150]})"})

    return StreamingResponse(gen(), media_type="text/event-stream", headers=_SSE_HEADERS)


@project_router.post("/upload_paper")
async def upload_paper(slug: str = Form(...), file: UploadFile = File(...)):
    """Last-resort source: the user uploads the paper's PDF directly (when it isn't on arXiv and
    there's no public PDF link). The request only receives the file; extraction and persistence
    run in a registered background job that the client polls."""
    paper = store.get_paper(slug)
    if not paper:
        raise HTTPException(status_code=404, detail="Unknown paper")
    max_bytes = 40_000_000
    if file.size is not None and file.size > max_bytes:
        raise HTTPException(status_code=413, detail="PDF is larger than the 40 MB limit.")
    data = await file.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise HTTPException(status_code=413, detail="PDF is larger than the 40 MB limit.")
    if not data:
        raise HTTPException(status_code=400, detail="Empty file.")
    try:
        job = retrieval_jobs.start_upload(slug, data, file.filename or "paper.pdf")
    except RetrievalError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return {"job": retrieval_jobs.snapshot(job.id)}


# ---- turn setup, shared by the SSE endpoints (web) and the job endpoints (mobile).
#      Each _prep_* validates and mutates the session exactly as its endpoint always did;
#      what differs is only how the resulting turn is delivered. ----

def _require_session(slug: str) -> None:
    if not sessions.get_state(slug):
        raise HTTPException(status_code=409, detail="No active session for this paper.")


def _prep_chat_start(req: ChatStartReq) -> None:
    if not config.has_api_key():
        raise HTTPException(status_code=400, detail="No OpenRouter API key set. Open Settings.")
    is_review = req.slug == REVIEW_SLUG
    if is_review:
        title = REVIEW_TITLE
    else:
        p = store.get_paper(req.slug)
        if not p:
            raise HTTPException(status_code=404, detail="Unknown paper")
        if not store.corpus_path(req.slug).exists():
            raise HTTPException(status_code=422, detail="Paper text isn't cached yet — open it once to fetch.")
        title = p.title
    sessions.start_session(req.slug, title, kind=("review" if is_review else "paper"),
                           opening=(req.prompt or None))
    if req.mode:
        sessions.set_reading_mode(req.slug, req.mode)


def _prep_reply(req: ReplyReq) -> None:
    _require_session(req.slug)
    rendered = _compose_reply_text(req)
    sessions.record_user(
        req.slug,
        rendered,
        kind="reply",
        # Once comments change the durable text, keep the human's composer text separately so
        # persisted-draft reconciliation compares like with like.
        authored_text=req.text if req.comments else None,
    )


def _compose_reply_text(req: ReplyReq) -> str:
    """Deterministically turn transient sentence comments into the ordinary durable user turn.

    Empty comments preserve the existing endpoint byte-for-byte. With comments, each reader-
    visible quote and its comment becomes a Markdown blockquote, followed by optional free text.
    The transcript and model history therefore need no annotation protocol or side store.
    """
    if not req.comments:
        return req.text
    parts = ["Regarding specific passages of your last response:"]
    for item in req.comments:
        quote = item.quote.strip()
        comment = item.comment.strip()
        if not quote or not comment:
            raise HTTPException(status_code=400, detail="Passage comments cannot be empty.")
        quoted = "\n".join(f"> {line}" for line in f"“{quote}”".splitlines())
        noted = "\n".join(f"> {line}" for line in f"— {comment}".splitlines())
        parts.append(f"{quoted}\n>\n{noted}")
    if req.text.strip():
        parts.append(req.text.strip())
    return "\n\n".join(parts)


def _prep_continue(req: FinishReq) -> None:
    _require_session(req.slug)
    records = sessions.read_records(req.slug)
    if not records or records[-1]["role"] != "user":
        raise HTTPException(status_code=409, detail="Nothing to continue — last turn already answered.")


def _prep_retry(req: RetryReq) -> None:
    _require_session(req.slug)
    if committer.approval_in_flight(req.slug):
        raise HTTPException(status_code=409, detail="Wait for the approval to finish.")
    # Committed is a resting point: forking would archive the committed proposal and a later
    # switch-back would re-offer Approve for notes already in git (duplicate commit).
    if sessions.get_state(req.slug) == COMMITTED:
        raise HTTPException(status_code=409,
                            detail="Notes are committed — continue the discussion first.")
    # U.14: a retry forks the conversation instead of discarding the old response — the
    # previous tail is archived as a branch, switchable via /branch_switch.
    context = None
    if req.prompt is not None or req.mode is not None:
        if req.assistant_index != 0:
            raise HTTPException(
                status_code=400,
                detail="Opening prompt and reading mode can only change on the first response.",
            )
        context = {
            "opening": req.prompt if req.prompt is not None else sessions.get_opening(req.slug),
            "reading_mode": req.mode or sessions.get_reading_mode(req.slug),
        }
    sessions.fork_before_assistant(req.slug, req.assistant_index, context=context)


def _prep_edit(req: EditReq) -> None:
    _require_session(req.slug)
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Edited message cannot be empty.")
    if not sessions.edit_reply(req.slug, req.reply_index, req.text.strip()):
        raise HTTPException(status_code=404, detail="No such message to edit.")


def _prep_finish(req: FinishReq) -> None:
    _require_session(req.slug)
    # The review chat folds the discussion into the working notes; a paper drafts its Notes.
    key = "review_finish" if req.slug == REVIEW_SLUG else "finish_instruction"
    instruction = prompts.get(key)
    if req.slug != REVIEW_SLUG:
        instruction += sessions.other_threads_context(req.slug)
    sessions.record_user(req.slug, instruction, kind="finish")


def _prep_request_changes(req: RequestChangesReq) -> None:
    _require_session(req.slug)
    sessions.record_user(req.slug, prompts.render("request_changes", feedback=req.text),
                         kind="revision", authored_text=req.text)


@project_router.post("/chat/start_stream")
def chat_start_stream(req: ChatStartReq):
    """Fire the first response for any chat (paper or review) with the edited opening prompt
    and chosen model, streaming it. Restarts the session (used for start and first-retry)."""
    thread_id = _thread_id(req.thread_id)
    with sessions.thread_scope(thread_id), sessions.paper_lock(req.slug), \
            sessions.mutation_lock(req.slug):
        _no_turn_in_flight(req.slug)
        _prep_chat_start(req)
        _register_sse_turn(req.slug)
    return StreamingResponse(_stream_for(req.slug, model=req.model, thread_id=thread_id),
                             media_type="text/event-stream",
                             headers=_SSE_HEADERS)


@project_router.post("/reply")
def reply(req: ReplyReq):
    with sessions.thread_scope(_thread_id(req.thread_id)), sessions.paper_lock(req.slug):
        _no_turn_in_flight(req.slug)
        with sessions.mutation_lock(req.slug):
            _prep_reply(req)
        turn = _run_and_record(req.slug, model=req.model)
        return {"state": sessions.get_state(req.slug), "turn": turn}


@project_router.post("/reply_stream")
def reply_stream(req: ReplyReq):
    thread_id = _thread_id(req.thread_id)
    with sessions.thread_scope(thread_id), sessions.paper_lock(req.slug), \
            sessions.mutation_lock(req.slug):
        _no_turn_in_flight(req.slug)
        _prep_reply(req)
        _register_sse_turn(req.slug)
    return StreamingResponse(_stream_for(req.slug, model=req.model, thread_id=thread_id),
                             media_type="text/event-stream",
                             headers=_SSE_HEADERS)


@project_router.post("/continue_stream")
def continue_stream(req: FinishReq):
    thread_id = _thread_id(req.thread_id)
    with sessions.thread_scope(thread_id), sessions.paper_lock(req.slug), \
            sessions.mutation_lock(req.slug):
        _no_turn_in_flight(req.slug)
        _prep_continue(req)
        _register_sse_turn(req.slug)
    return StreamingResponse(_stream_for(req.slug, model=req.model, thread_id=thread_id),
                             media_type="text/event-stream",
                             headers=_SSE_HEADERS)


@project_router.post("/retry_stream")
def retry_stream(req: RetryReq):
    """Regenerate the n-th assistant turn: discard it (and anything after) and stream a fresh
    response to the preceding user message."""
    thread_id = _thread_id(req.thread_id)
    with sessions.thread_scope(thread_id), sessions.paper_lock(req.slug), \
            sessions.mutation_lock(req.slug):
        _no_turn_in_flight(req.slug)
        _prep_retry(req)
        _register_sse_turn(req.slug)
    return StreamingResponse(_stream_for(req.slug, model=req.model, thread_id=thread_id),
                             media_type="text/event-stream",
                             headers=_SSE_HEADERS)


@project_router.post("/edit_stream")
def edit_stream(req: EditReq):
    """Edit an earlier user reply and regenerate from it: replace the reply's text, discard the
    old response and everything after it, then stream a fresh answer to the edited message."""
    thread_id = _thread_id(req.thread_id)
    with sessions.thread_scope(thread_id), sessions.paper_lock(req.slug), \
            sessions.mutation_lock(req.slug):
        _no_turn_in_flight(req.slug)
        _prep_edit(req)
        _register_sse_turn(req.slug)
    return StreamingResponse(_stream_for(req.slug, model=req.model, thread_id=thread_id),
                             media_type="text/event-stream",
                             headers=_SSE_HEADERS)


@project_router.post("/finish_stream")
def finish_stream(req: FinishReq):
    thread_id = _thread_id(req.thread_id)
    with sessions.thread_scope(thread_id), sessions.paper_lock(req.slug), \
            sessions.mutation_lock(req.slug):
        _no_turn_in_flight(req.slug)
        _prep_finish(req)
        _register_sse_turn(req.slug)
    return StreamingResponse(_stream_for(req.slug, model=req.model, thread_id=thread_id),
                             media_type="text/event-stream",
                             headers=_SSE_HEADERS)


@project_router.post("/request_changes_stream")
def request_changes_stream(req: RequestChangesReq):
    thread_id = _thread_id(req.thread_id)
    with sessions.thread_scope(thread_id), sessions.paper_lock(req.slug), \
            sessions.mutation_lock(req.slug):
        _no_turn_in_flight(req.slug)
        _prep_request_changes(req)
        _register_sse_turn(req.slug)
    return StreamingResponse(_stream_for(req.slug, model=req.model, thread_id=thread_id),
                             media_type="text/event-stream",
                             headers=_SSE_HEADERS)


# ---- job-based turns (mobile): the turn runs in a background thread that records the result
#      regardless of what any client does, and clients poll short-lived snapshot requests. This
#      is the same job+poll pattern as audio/graph builds — a live SSE across the tunnel gets
#      killed on long turns and takes the un-persisted response with it (see chat_jobs). ----

def _no_turn_in_flight(slug: str) -> None:
    """Job starts mutate the session first (record/truncate/edit), so refuse while a turn is
    already generating — the client should reattach to it instead."""
    if config.project_is_busy(config.active_project_id()):
        raise HTTPException(
            status_code=409,
            detail="This project is being moved or split — wait, then try again.",
        )
    if chat_jobs.active_for(slug) or _sse_turn_active(slug):
        raise HTTPException(status_code=409,
                            detail="A response is already being generated for this paper.")


def _started_job(slug: str, delivery_mode: str, model: str | None = None) -> dict:
    # start_turn reads the request-scoped thread context; keeping the public call shape stable
    # also preserves injected test runners and older internal callers.
    job = chat_jobs.start_turn(slug, delivery_mode=delivery_mode, model=model)
    return {"job": chat_jobs.snapshot(job.id)}


@project_router.post("/chat/start_job")
def chat_start_job(req: ChatStartReq):
    with sessions.thread_scope(_thread_id(req.thread_id)), sessions.paper_lock(req.slug), \
            sessions.mutation_lock(req.slug):
        _no_turn_in_flight(req.slug)
        _prep_chat_start(req)
        return _started_job(req.slug, req.delivery_mode, model=req.model)


@project_router.post("/reply_job")
def reply_job(req: ReplyReq):
    with sessions.thread_scope(_thread_id(req.thread_id)), sessions.paper_lock(req.slug), \
            sessions.mutation_lock(req.slug):
        _no_turn_in_flight(req.slug)
        _prep_reply(req)
        return _started_job(req.slug, req.delivery_mode, model=req.model)


@project_router.post("/continue_job")
def continue_job(req: FinishReq):
    with sessions.thread_scope(_thread_id(req.thread_id)), sessions.paper_lock(req.slug), \
            sessions.mutation_lock(req.slug):
        _no_turn_in_flight(req.slug)
        _prep_continue(req)
        return _started_job(req.slug, req.delivery_mode, model=req.model)


@project_router.post("/branch_switch")
def branch_switch(req: BranchSwitchReq):
    """Make another retry branch the live conversation at a fork point. Quick action (no
    LLM); the client refreshes from the returned transcript/state. Refused while a turn is
    generating — the in-flight job appends to whichever tail is live."""
    # Checks and mutation share the per-thread lock: a snapshot guard alone could interleave
    # with a turn prep (between record_user and job registration) or an approval.
    with sessions.thread_scope(_thread_id(req.thread_id)), sessions.paper_lock(req.slug), \
            sessions.mutation_lock(req.slug):
        _require_session(req.slug)
        if sessions.get_state(req.slug) == COMMITTED:
            # Switching would rewrite the transcript under a committed record, and restoring
            # an older proposed-draft branch would re-offer Approve for notes already in git.
            raise HTTPException(status_code=409,
                                detail="Notes are committed — continue the discussion first.")
        if chat_jobs.active_for(req.slug) or _sse_turn_active(req.slug):
            raise HTTPException(status_code=409,
                                detail="Wait for the current response to finish.")
        if committer.approval_in_flight(req.slug):
            raise HTTPException(status_code=409, detail="Wait for the approval to finish.")
        if not sessions.switch_branch(req.slug, req.assistant_index, req.branch):
            raise HTTPException(status_code=404, detail="No such branch at this turn.")
        return {
            "state": sessions.get_state(req.slug),
            "transcript": sessions.transcript(req.slug),
        }


@project_router.post("/retry_job")
def retry_job(req: RetryReq):
    with sessions.thread_scope(_thread_id(req.thread_id)), sessions.paper_lock(req.slug), \
            sessions.mutation_lock(req.slug):
        _no_turn_in_flight(req.slug)
        _prep_retry(req)
        return _started_job(req.slug, req.delivery_mode, model=req.model)


@project_router.post("/edit_job")
def edit_job(req: EditReq):
    with sessions.thread_scope(_thread_id(req.thread_id)), sessions.paper_lock(req.slug), \
            sessions.mutation_lock(req.slug):
        _no_turn_in_flight(req.slug)
        _prep_edit(req)
        return _started_job(req.slug, req.delivery_mode, model=req.model)


@project_router.post("/finish_job")
def finish_job(req: FinishReq):
    with sessions.thread_scope(_thread_id(req.thread_id)), sessions.paper_lock(req.slug), \
            sessions.mutation_lock(req.slug):
        _no_turn_in_flight(req.slug)
        _prep_finish(req)
        return _started_job(req.slug, req.delivery_mode, model=req.model)


@project_router.post("/request_changes_job")
def request_changes_job(req: RequestChangesReq):
    with sessions.thread_scope(_thread_id(req.thread_id)), sessions.paper_lock(req.slug), \
            sessions.mutation_lock(req.slug):
        _no_turn_in_flight(req.slug)
        _prep_request_changes(req)
        return _started_job(req.slug, req.delivery_mode, model=req.model)


@project_router.get("/chat/jobs/active/{slug}")
def chat_job_active(slug: str, thread_id: str = sessions.MAIN_THREAD):
    """The running turn job for a session, if any — lets a client that navigated away (or got
    disconnected) reattach to the live turn instead of finding a silent screen."""
    job = chat_jobs.active_for(slug, _thread_id(thread_id))
    return {"job": chat_jobs.snapshot(job.id) if job else None}


@project_router.get("/chat/jobs/{job_id}")
def chat_job_status(job_id: str):
    snap = chat_jobs.snapshot(job_id)
    if not snap:
        raise HTTPException(status_code=404, detail="Unknown chat job")
    return {"job": snap}


@project_router.post("/chat/jobs/{job_id}/cancel")
def chat_job_cancel(job_id: str):
    """Best-effort stop for a running turn (the composer's Stop button). The worker stops at
    its next event boundary; canonical text already streamed is recorded marked as stopped
    (an empty partial records nothing). The job settles through its normal done path, so
    pollers simply see it finish early. Idempotent; a no-op on already-settled jobs."""
    snap = chat_jobs.request_cancel(job_id)
    if not snap:
        raise HTTPException(status_code=404, detail="Unknown chat job")
    return {"job": snap}


@project_router.get("/preview/jobs/{job_id}")
def preview_job_status(job_id: str):
    """Cheap project-scoped poll for one grounded listening cue."""
    snap = preview_jobs.snapshot(job_id)
    if not snap:
        raise HTTPException(status_code=404, detail="Unknown preview job")
    return {"job": snap}


@project_router.post("/preview/jobs/{job_id}/played")
def preview_job_played(job_id: str):
    """Acknowledge that this project's audio layer accepted the cue for playback."""
    snap = preview_jobs.acknowledge_played(job_id)
    if not snap:
        raise HTTPException(status_code=404, detail="Unknown preview job")
    return {"job": snap}


@project_router.post("/continue")
def continue_turn(req: FinishReq):
    """Generate the assistant response for a reply that was recorded but never answered
    (e.g. a prior turn errored). No new user message is added."""
    with sessions.thread_scope(_thread_id(req.thread_id)), sessions.paper_lock(req.slug):
        _no_turn_in_flight(req.slug)
        if not sessions.get_state(req.slug):
            raise HTTPException(status_code=409, detail="No active session for this paper.")
        records = sessions.read_records(req.slug)
        if not records or records[-1]["role"] != "user":
            raise HTTPException(
                status_code=409,
                detail="Nothing to continue — last turn already answered.",
            )
        turn = _run_and_record(req.slug, model=req.model)
        return {"state": sessions.get_state(req.slug), "turn": turn}


@project_router.post("/finish")
def finish(req: FinishReq):
    with sessions.thread_scope(_thread_id(req.thread_id)), sessions.paper_lock(req.slug):
        _no_turn_in_flight(req.slug)
        _prep_finish(req)
        turn = _run_and_record(req.slug, model=req.model)
        return {"state": sessions.get_state(req.slug), "turn": turn}


@project_router.post("/request_changes")
def request_changes(req: RequestChangesReq):
    with sessions.thread_scope(_thread_id(req.thread_id)), sessions.paper_lock(req.slug):
        _no_turn_in_flight(req.slug)
        _prep_request_changes(req)
        turn = _run_and_record(req.slug, model=req.model)
        return {"state": sessions.get_state(req.slug), "turn": turn}


@project_router.post("/reopen")
def reopen(req: FinishReq):
    """NotesDrafted -> InDiscussion: discard the rejected draft and go back to discussing,
    so the wrap-up step can be redone (e.g. after editing a prompt). Gated to notes_drafted
    ONLY — on a committed session the same truncation would delete the accepted finish/
    proposal records from the log (a stale client must get a 409, not silent data loss);
    committed sessions continue via /continue_discussion, which touches nothing."""
    with sessions.thread_scope(_thread_id(req.thread_id)), sessions.paper_lock(req.slug), \
            sessions.mutation_lock(req.slug):
        if config.project_is_busy(config.active_project_id()):
            raise HTTPException(
                status_code=409,
                detail="This project is being moved or split — wait, then reopen.",
            )
        state = sessions.get_state(req.slug)
        if not state:
            raise HTTPException(status_code=409, detail="No active session for this paper.")
        if state != "notes_drafted":
            raise HTTPException(status_code=409,
                                detail="Nothing to reopen — no draft is awaiting review.")
        sessions.reopen_discussion(req.slug)
        return {"state": sessions.get_state(req.slug), "transcript": sessions.transcript(req.slug)}


@project_router.post("/continue_discussion")
def continue_discussion(req: FinishReq):
    """Committed -> InDiscussion (polish plan H.2): bring the composer back after 'Finish
    reading' without touching anything recorded — committed notes stay committed, the
    transcript stands, and a later finish proposes a fresh draft through the normal flow.
    Deterministic state change, so a plain request (invariant 1 does not apply)."""
    with sessions.thread_scope(_thread_id(req.thread_id)), sessions.paper_lock(req.slug), \
            sessions.mutation_lock(req.slug):
        if config.project_is_busy(config.active_project_id()):
            raise HTTPException(
                status_code=409,
                detail="This project is being moved or split — wait, then continue.",
            )
        state = sessions.get_state(req.slug)
        if not state:
            raise HTTPException(status_code=409, detail="No active session for this paper.")
        if state != "committed":
            raise HTTPException(status_code=409, detail="The discussion is already open.")
        sessions.continue_discussion(req.slug)
        return {"state": sessions.get_state(req.slug)}


@project_router.post("/session_mode")
def session_mode(req: ModeReq):
    """Switch the session's reading mode (polish plan H.3) — applies to every subsequent
    turn. One tap from the overflow menu; deterministic, so a plain request."""
    with sessions.thread_scope(_thread_id(req.thread_id)), sessions.paper_lock(req.slug), \
            sessions.mutation_lock(req.slug):
        if config.project_is_busy(config.active_project_id()):
            raise HTTPException(
                status_code=409,
                detail="This project is being moved or split — wait, then change mode.",
            )
        if not sessions.get_state(req.slug):
            raise HTTPException(status_code=409, detail="No active session for this paper.")
        sessions.set_reading_mode(req.slug, req.mode)
        return {"mode": sessions.get_reading_mode(req.slug)}
