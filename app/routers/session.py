"""Per-project reading-session routes: paper retrieval, the compose-first opening, and every
turn-delivery path — streaming SSE (web), background job + poll (mobile), and the plain
non-streaming variants. The `_prep_*` helpers validate and mutate the session exactly as each
endpoint always did; only how the resulting turn is delivered differs. See CLAUDE.md invariant 1
(long/LLM turns are jobs, never a connection-tied stream across the tunnel)."""
from __future__ import annotations

import asyncio
import json
from typing import Literal

from fastapi import File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .. import (
    agent,
    agent_harness,
    chat_jobs,
    config,
    graph,
    preview_jobs,
    prompts,
    retrieval_agent,
    retriever,
    sessions,
    store,
)
from ..agent import AgentError
from ..models import REVIEW_SLUG, REVIEW_TITLE
from ..retriever import RetrievalError
from . import make_project_router

project_router = make_project_router()


# ---------- request models ----------

class StartReq(BaseModel):
    slug: str
    arxiv_id: str | None = None
    pdf_url: str | None = None


class DeliveryReq(BaseModel):
    delivery_mode: Literal["reading", "listening"] = "reading"
    # One-shot model override for this turn only — never persisted to settings (locked product
    # decision: composer model selection applies to one response only and never silently
    # changes the default). None falls through to the account's configured default.
    model: str | None = None


class ChatStartReq(DeliveryReq):
    slug: str
    prompt: str | None = None   # edited first-prompt template for this session


class ReplyReq(DeliveryReq):
    slug: str
    text: str


class FinishReq(DeliveryReq):
    slug: str


class RequestChangesReq(DeliveryReq):
    slug: str
    text: str


class RetryReq(DeliveryReq):
    slug: str
    assistant_index: int


class EditReq(DeliveryReq):
    slug: str
    reply_index: int
    text: str


# ---------- streaming helpers ----------

def _run_and_record(slug: str, model: str | None = None) -> dict:
    history = sessions.build_history(slug)
    try:
        turn = agent.run_turn(slug, history, model=model)
    except AgentError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    sessions.record_assistant(slug, turn)
    return turn.to_dict()


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


def _turn_stream(slug: str, model: str | None = None):
    """Stream the analysis turn as SSE: incremental CANONICAL text, then a final 'done'
    event carrying the parsed+recorded turn. The user message must already be recorded."""
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
    turn = agent.parse("".join(pieces))
    if not turn.canonical.strip():
        yield _sse({"type": "error", "detail":
                    "The model returned an empty response. Try again, or switch the analysis "
                    "model in Settings."})
        return
    sessions.record_assistant(slug, turn)
    yield _sse({"type": "done", "turn": turn.to_dict(), "state": sessions.get_state(slug)})


async def _agentic_turn_stream(slug: str, model: str | None = None):
    """Streaming turn through the Pydantic AI tool loop (when RC_AGENTIC is on). Same client
    contract as _turn_stream — incremental CANONICAL 'delta' events then a final 'done' — plus
    'tool' events announcing each research tool the model calls. The final answer is parsed from
    the agent's authoritative output."""
    history = sessions.build_history(slug)
    pieces: list[str] = []
    sent = 0
    final_text = ""
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
            elif ev["type"] == "tool":
                yield _sse({"type": "tool", "name": ev["name"], "detail": ev.get("detail", "")})
            elif ev["type"] == "final":
                final_text = ev["text"]
    except AgentError as e:
        yield _sse({"type": "error", "detail": str(e)})
        return
    turn = agent.parse(final_text or "".join(pieces))
    if not turn.canonical.strip():
        yield _sse({"type": "error", "detail":
                    "The model returned an empty response. Try again, or switch the analysis "
                    "model in Settings."})
        return
    sessions.record_assistant(slug, turn)
    yield _sse({"type": "done", "turn": turn.to_dict(), "state": sessions.get_state(slug)})


def _stream_for(slug: str, model: str | None = None):
    """Pick the streaming turn implementation: the agentic tool loop when enabled, else the
    proven single-shot stream. Both are (async/sync) generators StreamingResponse can consume."""
    if agent_harness.AGENTIC_ENABLED:
        return _agentic_turn_stream(slug, model=model)
    return _turn_stream(slug, model=model)


_SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


# ---------- session flows (Section 9) ----------

@project_router.get("/session/{slug}")
def get_session(slug: str):
    if slug == REVIEW_SLUG:
        paper = {"slug": REVIEW_SLUG, "title": REVIEW_TITLE, "kind": "review",
                 "list_status": "n/a", "session_state": sessions.get_state(REVIEW_SLUG)}
    else:
        p = store.get_paper(slug, sessions.session_states())
        if not p:
            raise HTTPException(status_code=404, detail="Unknown paper")
        paper = p.to_dict()
    return {
        "paper": paper,
        "state": sessions.get_state(slug),
        "transcript": sessions.transcript(slug),
        "accepted_drafts": sessions.accepted_drafts(slug),
    }


@project_router.get("/opening_draft/{slug}")
def opening_draft(slug: str):
    """The editable first-prompt + default model for the compose-first screen. Returns the
    session's edited opening if one exists (for first-response retry), else the default."""
    model = config.load_settings().get("model")
    stored = sessions.get_opening(slug)
    if slug == REVIEW_SLUG:
        return {"prompt": stored or prompts.get("review_opening"), "model": model, "title": REVIEW_TITLE}
    p = store.get_paper(slug)
    if not p:
        raise HTTPException(status_code=404, detail="Unknown paper")
    prompt = stored or prompts.get("opening_message").replace("{title}", p.title)
    return {"prompt": prompt, "model": model, "title": p.title}


@project_router.post("/start")
def start_paper(req: StartReq):
    """Retrieve + cache a paper's full text (no session, no turn). The compose-first screen
    fires the first turn separately via /api/chat/start_stream."""
    paper = store.get_paper(req.slug)
    if not paper:
        raise HTTPException(status_code=404, detail="Unknown paper")
    if paper.retrieved and not req.arxiv_id and not req.pdf_url:
        return {"ok": True, "retrieved": True}
    try:
        res = retriever.retrieve(paper.title, req.arxiv_id, req.pdf_url)
    except RetrievalError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    if res.get("needs_confirmation"):
        return {"needs_confirmation": True, "candidates": res["candidates"], "slug": req.slug}
    store.write_full_text(req.slug, paper.title, res["full_text"], {
        "slug": req.slug, "arxiv_id": res.get("arxiv_id"), "source": res.get("source"),
    })
    return {"ok": True, "retrieved": True}


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
            store.write_full_text(req.slug, paper.title, res["full_text"], {
                "slug": req.slug, "arxiv_id": res.get("arxiv_id"), "source": res.get("source")})
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
                        store.write_full_text(req.slug, paper.title, ev["full_text"], {
                            "slug": req.slug, "source": ev.get("source")})
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
    there's no public PDF link). Extract its text and cache it like a normal retrieval."""
    paper = store.get_paper(slug)
    if not paper:
        raise HTTPException(status_code=404, detail="Unknown paper")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty file.")
    try:
        full_text = retriever.extract_pdf_bytes(data)
    except RetrievalError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    if not full_text.strip():
        raise HTTPException(status_code=422, detail="Could not extract text from that PDF.")
    store.write_full_text(slug, paper.title, full_text,
                          {"slug": slug, "source": f"upload:{file.filename}"})
    return {"ok": True, "retrieved": True}


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


def _prep_reply(req: ReplyReq) -> None:
    _require_session(req.slug)
    sessions.record_user(req.slug, req.text, kind="reply")


def _prep_continue(req: FinishReq) -> None:
    _require_session(req.slug)
    records = sessions.read_records(req.slug)
    if not records or records[-1]["role"] != "user":
        raise HTTPException(status_code=409, detail="Nothing to continue — last turn already answered.")


def _prep_retry(req: RetryReq) -> None:
    _require_session(req.slug)
    sessions.truncate_before_assistant(req.slug, req.assistant_index)


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
    sessions.record_user(req.slug, prompts.get(key), kind="finish")


def _prep_request_changes(req: RequestChangesReq) -> None:
    _require_session(req.slug)
    sessions.record_user(req.slug, prompts.render("request_changes", feedback=req.text),
                         kind="revision", authored_text=req.text)


@project_router.post("/chat/start_stream")
def chat_start_stream(req: ChatStartReq):
    """Fire the first response for any chat (paper or review) with the edited opening prompt
    and chosen model, streaming it. Restarts the session (used for start and first-retry)."""
    _prep_chat_start(req)
    return StreamingResponse(_stream_for(req.slug, model=req.model), media_type="text/event-stream",
                             headers=_SSE_HEADERS)


@project_router.post("/reply")
def reply(req: ReplyReq):
    if not sessions.get_state(req.slug):
        raise HTTPException(status_code=409, detail="No active session for this paper.")
    sessions.record_user(req.slug, req.text, kind="reply")
    turn = _run_and_record(req.slug, model=req.model)
    return {"state": sessions.get_state(req.slug), "turn": turn}


@project_router.post("/reply_stream")
def reply_stream(req: ReplyReq):
    _prep_reply(req)
    return StreamingResponse(_stream_for(req.slug, model=req.model), media_type="text/event-stream",
                             headers=_SSE_HEADERS)


@project_router.post("/continue_stream")
def continue_stream(req: FinishReq):
    _prep_continue(req)
    return StreamingResponse(_stream_for(req.slug, model=req.model), media_type="text/event-stream",
                             headers=_SSE_HEADERS)


@project_router.post("/retry_stream")
def retry_stream(req: RetryReq):
    """Regenerate the n-th assistant turn: discard it (and anything after) and stream a fresh
    response to the preceding user message."""
    _prep_retry(req)
    return StreamingResponse(_stream_for(req.slug, model=req.model), media_type="text/event-stream",
                             headers=_SSE_HEADERS)


@project_router.post("/edit_stream")
def edit_stream(req: EditReq):
    """Edit an earlier user reply and regenerate from it: replace the reply's text, discard the
    old response and everything after it, then stream a fresh answer to the edited message."""
    _prep_edit(req)
    return StreamingResponse(_stream_for(req.slug, model=req.model), media_type="text/event-stream",
                             headers=_SSE_HEADERS)


@project_router.post("/finish_stream")
def finish_stream(req: FinishReq):
    _prep_finish(req)
    return StreamingResponse(_stream_for(req.slug, model=req.model), media_type="text/event-stream",
                             headers=_SSE_HEADERS)


@project_router.post("/request_changes_stream")
def request_changes_stream(req: RequestChangesReq):
    _prep_request_changes(req)
    return StreamingResponse(_stream_for(req.slug, model=req.model), media_type="text/event-stream",
                             headers=_SSE_HEADERS)


# ---- job-based turns (mobile): the turn runs in a background thread that records the result
#      regardless of what any client does, and clients poll short-lived snapshot requests. This
#      is the same job+poll pattern as audio/graph builds — a live SSE across the tunnel gets
#      killed on long turns and takes the un-persisted response with it (see chat_jobs). ----

def _no_turn_in_flight(slug: str) -> None:
    """Job starts mutate the session first (record/truncate/edit), so refuse while a turn is
    already generating — the client should reattach to it instead."""
    if chat_jobs.active_for(slug):
        raise HTTPException(status_code=409,
                            detail="A response is already being generated for this paper.")


def _started_job(slug: str, delivery_mode: str, model: str | None = None) -> dict:
    job = chat_jobs.start_turn(slug, delivery_mode=delivery_mode, model=model)
    return {"job": chat_jobs.snapshot(job.id)}


@project_router.post("/chat/start_job")
def chat_start_job(req: ChatStartReq):
    _no_turn_in_flight(req.slug)
    _prep_chat_start(req)
    return _started_job(req.slug, req.delivery_mode, model=req.model)


@project_router.post("/reply_job")
def reply_job(req: ReplyReq):
    _no_turn_in_flight(req.slug)
    _prep_reply(req)
    return _started_job(req.slug, req.delivery_mode, model=req.model)


@project_router.post("/continue_job")
def continue_job(req: FinishReq):
    _no_turn_in_flight(req.slug)
    _prep_continue(req)
    return _started_job(req.slug, req.delivery_mode, model=req.model)


@project_router.post("/retry_job")
def retry_job(req: RetryReq):
    _no_turn_in_flight(req.slug)
    _prep_retry(req)
    return _started_job(req.slug, req.delivery_mode, model=req.model)


@project_router.post("/edit_job")
def edit_job(req: EditReq):
    _no_turn_in_flight(req.slug)
    _prep_edit(req)
    return _started_job(req.slug, req.delivery_mode, model=req.model)


@project_router.post("/finish_job")
def finish_job(req: FinishReq):
    _no_turn_in_flight(req.slug)
    _prep_finish(req)
    return _started_job(req.slug, req.delivery_mode, model=req.model)


@project_router.post("/request_changes_job")
def request_changes_job(req: RequestChangesReq):
    _no_turn_in_flight(req.slug)
    _prep_request_changes(req)
    return _started_job(req.slug, req.delivery_mode, model=req.model)


@project_router.get("/chat/jobs/active/{slug}")
def chat_job_active(slug: str):
    """The running turn job for a session, if any — lets a client that navigated away (or got
    disconnected) reattach to the live turn instead of finding a silent screen."""
    job = chat_jobs.active_for(slug)
    return {"job": chat_jobs.snapshot(job.id) if job else None}


@project_router.get("/chat/jobs/{job_id}")
def chat_job_status(job_id: str):
    snap = chat_jobs.snapshot(job_id)
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


@project_router.post("/continue")
def continue_turn(req: FinishReq):
    """Generate the assistant response for a reply that was recorded but never answered
    (e.g. a prior turn errored). No new user message is added."""
    if not sessions.get_state(req.slug):
        raise HTTPException(status_code=409, detail="No active session for this paper.")
    records = sessions.read_records(req.slug)
    if not records or records[-1]["role"] != "user":
        raise HTTPException(status_code=409, detail="Nothing to continue — last turn already answered.")
    turn = _run_and_record(req.slug, model=req.model)
    return {"state": sessions.get_state(req.slug), "turn": turn}


@project_router.post("/finish")
def finish(req: FinishReq):
    if not sessions.get_state(req.slug):
        raise HTTPException(status_code=409, detail="No active session for this paper.")
    sessions.record_user(req.slug, prompts.get("finish_instruction"), kind="finish")
    turn = _run_and_record(req.slug, model=req.model)
    return {"state": sessions.get_state(req.slug), "turn": turn}


@project_router.post("/request_changes")
def request_changes(req: RequestChangesReq):
    _prep_request_changes(req)
    turn = _run_and_record(req.slug, model=req.model)
    return {"state": sessions.get_state(req.slug), "turn": turn}


@project_router.post("/reopen")
def reopen(req: FinishReq):
    """NotesDrafted -> InDiscussion: discard the rejected draft and go back to discussing,
    so the wrap-up step can be redone (e.g. after editing a prompt)."""
    if not sessions.get_state(req.slug):
        raise HTTPException(status_code=409, detail="No active session for this paper.")
    sessions.reopen_discussion(req.slug)
    return {"state": sessions.get_state(req.slug), "transcript": sessions.transcript(req.slug)}
