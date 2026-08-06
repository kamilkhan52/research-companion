"""Per-project reading-session routes: connection-independent paper retrieval and chat turns.

Every long or paid operation starts a background job and returns a snapshot for polling. The
legacy blocking and connection-tied SSE variants were deliberately retired: merely keeping those
compatibility routes exposed would let callers bypass M3 admission controls and violate invariant
1 before reservations even land.
"""
from __future__ import annotations

from typing import Literal

from fastapi import File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from .. import (
    affiliation_jobs,
    affiliations,
    chat_jobs,
    committer,
    config,
    graph,
    preview_jobs,
    prompts,
    retrieval_jobs,
    sessions,
    store,
)
from ..models import COMMITTED, REVIEW_SLUG, REVIEW_TITLE
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
    # The paper summary can be retried with the same prompt-type/model choices as session
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
            and not chat_jobs.active_for(slug)):
        with sessions.paper_lock(slug), sessions.mutation_lock(slug):
            if (not config.project_is_busy(config.active_project_id())
                    and not chat_jobs.active_for(slug)):
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
        # Context for the reading-mode screen: enough to decide whether this paper is worth
        # a summary before spending one. Both are cheap and, crucially, available for a
        # paper that has never been opened.
        paper["abstract"] = store.abstract_for(slug)
        paper["project_links"] = store.project_links(slug)
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
    session's edited opening if one exists (for paper-summary retry), else the default."""
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
            base = prompts.get("opening_message").replace(
                "{title}", prompts.OPENING_TITLE_MARKER,
            )
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


class RetrievalJobReq(StartReq):
    # R7.8: chain the paper's PAPER SUMMARY onto a successful retrieval, so "add paper →
    # analyzed and narrated" is one durable server-side flow the user can walk away from.
    auto_analyze: bool = False
    mode: Literal["balanced", "background", "technical", "detailed"] | None = None
    delivery_mode: Literal["reading", "listening"] = "reading"


def _paper_summary_hook(req: RetrievalJobReq):
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
            base = prompts.get("opening_message").replace(
                "{title}", prompts.OPENING_TITLE_MARKER,
            )
            prompt = _opening_prompt_templates(base).get(req.mode or "balanced", base)
            chat_req = ChatStartReq(
                slug=slug, prompt=prompt,
                mode=(req.mode if req.mode and req.mode != "balanced" else None),
                delivery_mode=req.delivery_mode,
            )
            _prep_chat_start(chat_req)
            # Auto-analyze continues the retrieval the account was already admitted for, and this
            # runs inside the retrieval worker — a refusal here would be swallowed into
            # `analysis_error` and the paper would silently never be analysed.
            chat_job = chat_jobs.start_turn(
                slug, delivery_mode=req.delivery_mode, metered=False,
            )
        retrieval_jobs.set_analysis_job(job, chat_job.id)
    return kick


@project_router.post("/retrieval/jobs")
def start_retrieval_job(req: RetrievalJobReq):
    """Start or join connection-independent paper retrieval and return immediately. With
    auto_analyze, a successful retrieval flows straight into the paper summary turn; the
    spawned chat job's id lands on the retrieval snapshot (`analysis_job_id`)."""
    hook = _paper_summary_hook(req) if req.auto_analyze else None
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
                detail="Opening prompt and reading mode can only change for the paper summary.",
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


# ---- Job-based turns: the turn runs in a background thread that records the result
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
    if chat_jobs.active_for(slug):
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
        if chat_jobs.active_for(req.slug):
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
