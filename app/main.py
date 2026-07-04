"""FastAPI app: the deterministic orchestrator (state machine + session flows) plus the
thin API the mobile client talks to. Serves the web client from the same origin so a phone
and a desktop hit one backend.
"""
from __future__ import annotations

import asyncio
import json
import os
import re

from fastapi import APIRouter, Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import (
    agent,
    agent_harness,
    audio_jobs,
    auth,
    chat_jobs,
    committer,
    config,
    discovery,
    discovery_jobs,
    fileio,
    graph,
    graph_jobs,
    graph_store,
    llm,
    logging_config,
    notes_jobs,
    projects,
    prompts,
    retrieval_agent,
    retriever,
    sessions,
    store,
    tts,
    usage,
)
from .agent import AgentError
from .auth import AuthError
from .committer import CommitError
from .models import REVIEW_SLUG, REVIEW_TITLE
from .projects import ProjectError
from .prompts import PromptError
from .retriever import RetrievalError
from .tts import TTSError

logging_config.configure()  # install the rc.* log handler before any job/LLM/commit runs

app = FastAPI(title=config.APP_TITLE)

# ---------- exposure hardening: CORS + user auth (Supabase) ----------
# All env-gated and OFF by default, so local/tunnel use is unchanged. See app/auth.py for the
# three modes (supabase | token | open). Enable browser cross-origin with:
#   RC_CORS_ORIGINS=https://a,https://b | *   (native apps ignore CORS)
_CORS_ORIGINS = [o.strip() for o in os.environ.get("RC_CORS_ORIGINS", "").split(",") if o.strip()]
if _CORS_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_CORS_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

# Routes that must stay open even when auth is on (so clients can bootstrap login).
_AUTH_EXEMPT = {"/api/health", "/api/auth/config"}


@app.middleware("http")
async def authenticate(request: Request, call_next):
    """Gate /api/* per app.auth.mode(). Token arrives as `Authorization: Bearer <t>` (fetch/
    native) or `?token=<t>` (so <audio>/download/SSE tags work). OPTIONS, the exempt routes,
    and non-/api routes (static SPA shell) are always allowed. The verified user (if any) is
    stashed on request.state.user for handlers/future per-user data."""
    request.state.user = None
    if auth.enabled() and request.method != "OPTIONS" \
            and request.url.path.startswith("/api/") and request.url.path not in _AUTH_EXEMPT:
        hdr = request.headers.get("authorization", "")
        token = hdr[7:].strip() if hdr[:7].lower() == "bearer " else request.query_params.get("token", "")
        try:
            request.state.user = auth.check(token)
        except AuthError:
            return JSONResponse({"detail": "Unauthorized"}, status_code=401)
    return await call_next(request)


# All per-project data routes live under /api/projects/{pid}/… and run with that project bound
# as active (use_project sets config's contextvar for the whole request, incl. streaming).
project_router = APIRouter(prefix="/api/projects/{pid}",
                           dependencies=[Depends(projects.use_project)], tags=["project"])

AUDIO_DIR = audio_jobs.AUDIO_DIR  # app-global (TTS cache shared across projects)


# ---------- request models ----------

class StartReq(BaseModel):
    slug: str
    arxiv_id: str | None = None
    pdf_url: str | None = None


class ChatStartReq(BaseModel):
    slug: str
    prompt: str | None = None   # edited first-prompt template for this session
    model: str | None = None    # model for the first response


class ReplyReq(BaseModel):
    slug: str
    text: str


class FinishReq(BaseModel):
    slug: str


class RequestChangesReq(BaseModel):
    slug: str
    text: str


class ApproveReq(BaseModel):
    slug: str
    notes_block: str | None = None
    synthesis: str | None = None
    summary: str | None = None


class SettingsReq(BaseModel):
    openrouter_api_key: str | None = None
    model: str | None = None
    narration_model: str | None = None
    openai_api_key: str | None = None
    speech_provider: str | None = None
    tts_model: str | None = None
    tts_voice: str | None = None
    parallel_api_key: str | None = None    # web search provider (agent tools)
    firecrawl_api_key: str | None = None   # web search/fetch provider (agent tools)
    prior_notes_scope: str | None = None   # "related" | "all" — prior Notes in paper context


class NarrateReq(BaseModel):
    text: str


class PromptReq(BaseModel):
    key: str
    value: str | None = None


class RetryReq(BaseModel):
    slug: str
    assistant_index: int
    model: str | None = None


class EditReq(BaseModel):
    slug: str
    reply_index: int
    text: str


class ProjectReq(BaseModel):
    name: str
    method: str | None = None   # optional starting reading-method; defaults to the template


class GraphBuildReq(BaseModel):
    force: bool = False   # re-extract every retrievable paper, ignoring the content-hash cache


class AddPaperReq(BaseModel):
    title: str
    group: str | None = None
    arxiv_id: str | None = None   # provenance only (e.g. from a graph node); not auto-retrieved


class DiscoverReq(BaseModel):
    goals: str


class NotesSaveReq(BaseModel):
    markdown: str
    summary: str | None = None   # optional commit message override


class NotesAgentReq(BaseModel):
    instruction: str


# ---------- helpers ----------

def _paper_dict(slug: str) -> dict:
    p = store.get_paper(slug, sessions.session_states())
    return p.to_dict() if p else {"slug": slug}


def _run_and_record(slug: str) -> dict:
    history = sessions.build_history(slug)
    try:
        turn = agent.run_turn(slug, history)
    except AgentError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    sessions.record_assistant(slug, turn)
    return turn.to_dict()


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


def _turn_stream(slug: str):
    """Stream the analysis turn as SSE: incremental CANONICAL text, then a final 'done'
    event carrying the parsed+recorded turn. The user message must already be recorded."""
    history = sessions.build_history(slug)
    pieces: list[str] = []
    sent = 0
    try:
        for piece in agent.stream_tokens(slug, history):
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


async def _agentic_turn_stream(slug: str):
    """Streaming turn through the Pydantic AI tool loop (when RC_AGENTIC is on). Same client
    contract as _turn_stream — incremental CANONICAL 'delta' events then a final 'done' — plus
    'tool' events announcing each research tool the model calls. The final answer is parsed from
    the agent's authoritative output."""
    history = sessions.build_history(slug)
    pieces: list[str] = []
    sent = 0
    final_text = ""
    try:
        async for ev in agent_harness.stream_agentic_events(slug, history):
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


def _stream_for(slug: str):
    """Pick the streaming turn implementation: the agentic tool loop when enabled, else the
    proven single-shot stream. Both are (async/sync) generators StreamingResponse can consume."""
    if agent_harness.AGENTIC_ENABLED:
        return _agentic_turn_stream(slug)
    return _turn_stream(slug)


_SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


# ---------- state / settings ----------

@app.get("/api/health")
def health():
    return {"ok": True, "title": config.APP_TITLE}


@app.get("/api/auth/config")
def auth_config():
    """Public: tells clients the auth mode and (for supabase) the publishable URL + anon key,
    so login config isn't hardcoded in the web/mobile clients."""
    return auth.public_config()


# ---------- projects (management) ----------

@app.get("/api/projects")
def list_projects():
    return {"projects": projects.list_projects()}


@app.post("/api/projects")
def create_project(req: ProjectReq):
    try:
        meta = projects.create_project(req.name, req.method)
    except ProjectError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"project": meta}


@app.get("/api/projects/{pid}/meta")
def project_meta(pid: str):
    if not projects.exists(pid):
        raise HTTPException(status_code=404, detail=f"Unknown project: {pid}")
    return {"project": projects._read_meta(pid)}


@app.patch("/api/projects/{pid}/meta")
def rename_project(pid: str, req: ProjectReq):
    try:
        meta = projects.rename_project(pid, req.name)
    except ProjectError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"project": meta}


# ---------- per-project state ----------

@project_router.get("/state")
def get_state(pid: str):
    settings = config.load_settings()
    states = sessions.session_states()
    papers = [p.to_dict() for p in store.list_papers(states)]
    return {
        "project": projects._read_meta(pid) or {"id": pid, "name": pid},
        "has_key": bool(settings.get("openrouter_api_key")),
        "model": settings.get("model"),
        "narration_model": settings.get("narration_model"),
        "speech_provider": settings.get("speech_provider"),
        "has_openai_key": bool(settings.get("openai_api_key")),
        "papers": papers,
    }


@project_router.get("/usage")
def get_usage(pid: str):
    """This project's accumulated LLM token/cost usage (lifetime aggregate + per-model /
    per-operation breakdowns). Cheap read of .state/usage.json; no LLM call."""
    return usage.load()


@app.get("/api/settings")
def read_settings():
    s = config.load_settings()
    key = s.get("openrouter_api_key") or ""
    okey = s.get("openai_api_key") or ""
    pkey = s.get("parallel_api_key") or ""
    fkey = s.get("firecrawl_api_key") or ""
    return {
        "has_key": bool(key), "key_hint": (key[:6] + "…") if key else "",
        "model": s.get("model"), "narration_model": s.get("narration_model"),
        "has_openai_key": bool(okey), "openai_key_hint": (okey[:6] + "…") if okey else "",
        "speech_provider": s.get("speech_provider"), "tts_model": s.get("tts_model"),
        "tts_voice": s.get("tts_voice"), "voices": tts.OPENAI_VOICES,
        "has_parallel_key": bool(pkey), "parallel_key_hint": (pkey[:6] + "…") if pkey else "",
        "has_firecrawl_key": bool(fkey), "firecrawl_key_hint": (fkey[:6] + "…") if fkey else "",
        "prior_notes_scope": s.get("prior_notes_scope") or "related",
    }


@app.post("/api/settings")
def write_settings(req: SettingsReq):
    merged = config.save_settings(req.model_dump())
    return {
        "has_key": bool(merged.get("openrouter_api_key")), "model": merged.get("model"),
        "narration_model": merged.get("narration_model"),
        "has_openai_key": bool(merged.get("openai_api_key")),
        "speech_provider": merged.get("speech_provider"),
        "tts_model": merged.get("tts_model"), "tts_voice": merged.get("tts_voice"),
        "has_parallel_key": bool(merged.get("parallel_api_key")),
        "has_firecrawl_key": bool(merged.get("firecrawl_api_key")),
        "prior_notes_scope": merged.get("prior_notes_scope") or "related",
    }


@app.post("/api/speak")
def speak(req: NarrateReq):
    """Synthesize one passage to mp3 (OpenAI), cached on disk; returns its URL. Blocking —
    long passages can outlive proxy timeouts; prefer the /api/audio/jobs flow for those."""
    s = config.load_settings()
    if s.get("speech_provider") != "openai":
        raise HTTPException(status_code=400, detail="Speech provider is not OpenAI.")
    path = audio_jobs.audio_cache_path(req.text)
    if not path.exists():
        try:
            fileio.atomic_write_bytes(path, tts.synthesize_long(req.text))
        except TTSError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
    return {"url": f"/api/audio/{path.name}"}


@app.post("/api/audio/jobs")
def start_audio_job(req: NarrateReq):
    """Start (or join) a background narrate→synthesize job for one canonical message and
    return its snapshot immediately; instant 'done' when the result is already cached. The
    client polls /api/audio/jobs/{id} — nothing here depends on a long-lived connection, so
    tunnels/proxy timeouts and app backgrounding can't kill a preparation in flight."""
    s = config.load_settings()
    if s.get("speech_provider") != "openai":
        raise HTTPException(status_code=400, detail="Speech provider is not OpenAI.")
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Nothing to narrate.")
    return {"job": audio_jobs.start_job(req.text).to_dict()}


@app.get("/api/audio/jobs/{job_id}")
def get_audio_job(job_id: str):
    """Cheap poll for a preparation job's live progress (stage + segments done/total)."""
    job = audio_jobs.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Unknown audio job")
    return {"job": job.to_dict()}


@app.get("/api/audio/{name}")
def audio(name: str):
    if not re.fullmatch(r"[0-9a-f]{40}\.mp3", name):
        raise HTTPException(status_code=404, detail="Not found")
    path = AUDIO_DIR / name
    if not path.exists():
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(path, media_type="audio/mpeg",
                        headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/prompts")
def get_prompts():
    """All workflow prompts (built-in default or user-edited), for the in-app editor."""
    return {"prompts": prompts.listing()}


@app.post("/api/prompts")
def save_prompt(req: PromptReq):
    try:
        prompts.set_prompt(req.key, req.value or "")
    except PromptError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"key": req.key, "value": prompts.get(req.key), "is_overridden": prompts.is_overridden(req.key)}


@app.post("/api/prompts/reset")
def reset_prompt(req: PromptReq):
    try:
        prompts.reset(req.key)
    except PromptError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"key": req.key, "value": prompts.get(req.key), "is_overridden": prompts.is_overridden(req.key)}


@app.post("/api/narrate")
def narrate(req: NarrateReq):
    """Stage 2: adapt one canonical response into a TTS transcript (cached by text hash)."""
    cached = sessions.get_cached_narration(req.text)
    if cached is not None:
        return {"narration": cached, "cached": True}
    try:
        narration = agent.narrate(req.text)
    except AgentError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    sessions.cache_narration(req.text, narration)
    return {"narration": narration, "cached": False}


@app.get("/api/models")
def list_models():
    """Proxy OpenRouter's public model catalogue (TTL-cached in llm) so the UI can offer a switcher."""
    try:
        data = llm.catalogue()
    except llm.LLMError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    models = [{"id": m.get("id"), "name": m.get("name", m.get("id"))} for m in data if m.get("id")]
    models.sort(key=lambda m: m["id"])
    return {"models": models}


# Favorite-model "families": resolved to the LATEST matching model by creation date, so the
# quick switcher self-updates as OpenRouter adds new versions. Each: all `inc` substrings
# must be in the id, no `exc` substring may be.
# Excluded from every family: non-text / specialized variants and imprecise aliases, so
# "newest in family" lands on a real chat model rather than an image/code/alias build.
FAVORITE_GLOBAL_EXC = ["image", "audio", "tts", "embedding", "embed", "vision", "ocr",
                       "search", "guard", "moderation", "rerank", ":free", "latest", "online",
                       "customtools", "computer-use"]
FAVORITE_FAMILIES = [
    {"label": "Claude Opus",   "inc": ["anthropic/", "claude-opus"], "exc": ["fast"]},
    {"label": "Claude Sonnet", "inc": ["anthropic/", "claude-sonnet"], "exc": []},
    {"label": "GPT (flagship)", "inc": ["openai/", "gpt-5"], "exc": ["mini", "nano", "chat", "codex", "pro"]},
    {"label": "GPT (mini)",    "inc": ["openai/", "gpt-5", "mini"], "exc": ["nano"]},
    {"label": "Gemini Pro",    "inc": ["google/", "gemini", "pro"], "exc": ["flash", "lite"]},
    {"label": "Gemini Flash",  "inc": ["google/", "gemini", "flash"], "exc": ["lite", "thinking"]},
    {"label": "GLM",           "inc": ["z-ai/", "glm"], "exc": ["air", "flash"]},
    {"label": "Kimi K2",       "inc": ["kimi-k2"], "exc": ["code"]},
    {"label": "DeepSeek V4 Pro", "inc": ["deepseek", "v4"], "exc": []},
]


@app.get("/api/favorite_models")
def favorite_models():
    """Resolve each favorite family to its latest chat model id from the OpenRouter catalogue."""
    try:
        data = llm.catalogue()
    except llm.LLMError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    out = []
    for fam in FAVORITE_FAMILIES:
        best = llm.newest_matching(fam["inc"], fam["exc"] + FAVORITE_GLOBAL_EXC, models=data)
        if best:
            out.append({"label": fam["label"], "id": best["id"]})
    return {"models": out}


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
    if req.model:
        config.save_settings({"model": req.model})
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
    if req.model:
        config.save_settings({"model": req.model})
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
                         kind="revision")


@project_router.post("/chat/start_stream")
def chat_start_stream(req: ChatStartReq):
    """Fire the first response for any chat (paper or review) with the edited opening prompt
    and chosen model, streaming it. Restarts the session (used for start and first-retry)."""
    _prep_chat_start(req)
    return StreamingResponse(_stream_for(req.slug), media_type="text/event-stream",
                             headers=_SSE_HEADERS)


@project_router.post("/reply")
def reply(req: ReplyReq):
    if not sessions.get_state(req.slug):
        raise HTTPException(status_code=409, detail="No active session for this paper.")
    sessions.record_user(req.slug, req.text, kind="reply")
    turn = _run_and_record(req.slug)
    return {"state": sessions.get_state(req.slug), "turn": turn}


@project_router.post("/reply_stream")
def reply_stream(req: ReplyReq):
    _prep_reply(req)
    return StreamingResponse(_stream_for(req.slug), media_type="text/event-stream",
                             headers=_SSE_HEADERS)


@project_router.post("/continue_stream")
def continue_stream(req: FinishReq):
    _prep_continue(req)
    return StreamingResponse(_stream_for(req.slug), media_type="text/event-stream",
                             headers=_SSE_HEADERS)


@project_router.post("/retry_stream")
def retry_stream(req: RetryReq):
    """Regenerate the n-th assistant turn: discard it (and anything after) and stream a fresh
    response to the preceding user message."""
    _prep_retry(req)
    return StreamingResponse(_stream_for(req.slug), media_type="text/event-stream",
                             headers=_SSE_HEADERS)


@project_router.post("/edit_stream")
def edit_stream(req: EditReq):
    """Edit an earlier user reply and regenerate from it: replace the reply's text, discard the
    old response and everything after it, then stream a fresh answer to the edited message."""
    _prep_edit(req)
    return StreamingResponse(_stream_for(req.slug), media_type="text/event-stream",
                             headers=_SSE_HEADERS)


@project_router.post("/finish_stream")
def finish_stream(req: FinishReq):
    _prep_finish(req)
    return StreamingResponse(_stream_for(req.slug), media_type="text/event-stream",
                             headers=_SSE_HEADERS)


@project_router.post("/request_changes_stream")
def request_changes_stream(req: RequestChangesReq):
    _prep_request_changes(req)
    return StreamingResponse(_stream_for(req.slug), media_type="text/event-stream",
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


def _started_job(slug: str) -> dict:
    return {"job": chat_jobs.snapshot(chat_jobs.start_turn(slug).id)}


@project_router.post("/chat/start_job")
def chat_start_job(req: ChatStartReq):
    _no_turn_in_flight(req.slug)
    _prep_chat_start(req)
    return _started_job(req.slug)


@project_router.post("/reply_job")
def reply_job(req: ReplyReq):
    _no_turn_in_flight(req.slug)
    _prep_reply(req)
    return _started_job(req.slug)


@project_router.post("/continue_job")
def continue_job(req: FinishReq):
    _no_turn_in_flight(req.slug)
    _prep_continue(req)
    return _started_job(req.slug)


@project_router.post("/retry_job")
def retry_job(req: RetryReq):
    _no_turn_in_flight(req.slug)
    _prep_retry(req)
    return _started_job(req.slug)


@project_router.post("/edit_job")
def edit_job(req: EditReq):
    _no_turn_in_flight(req.slug)
    _prep_edit(req)
    return _started_job(req.slug)


@project_router.post("/finish_job")
def finish_job(req: FinishReq):
    _no_turn_in_flight(req.slug)
    _prep_finish(req)
    return _started_job(req.slug)


@project_router.post("/request_changes_job")
def request_changes_job(req: RequestChangesReq):
    _no_turn_in_flight(req.slug)
    _prep_request_changes(req)
    return _started_job(req.slug)


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


@project_router.post("/continue")
def continue_turn(req: FinishReq):
    """Generate the assistant response for a reply that was recorded but never answered
    (e.g. a prior turn errored). No new user message is added."""
    if not sessions.get_state(req.slug):
        raise HTTPException(status_code=409, detail="No active session for this paper.")
    records = sessions.read_records(req.slug)
    if not records or records[-1]["role"] != "user":
        raise HTTPException(status_code=409, detail="Nothing to continue — last turn already answered.")
    turn = _run_and_record(req.slug)
    return {"state": sessions.get_state(req.slug), "turn": turn}


@project_router.post("/finish")
def finish(req: FinishReq):
    if not sessions.get_state(req.slug):
        raise HTTPException(status_code=409, detail="No active session for this paper.")
    sessions.record_user(req.slug, prompts.get("finish_instruction"), kind="finish")
    turn = _run_and_record(req.slug)
    return {"state": sessions.get_state(req.slug), "turn": turn}


@project_router.post("/request_changes")
def request_changes(req: RequestChangesReq):
    _prep_request_changes(req)
    turn = _run_and_record(req.slug)
    return {"state": sessions.get_state(req.slug), "turn": turn}


@project_router.post("/reopen")
def reopen(req: FinishReq):
    """NotesDrafted -> InDiscussion: discard the rejected draft and go back to discussing,
    so the wrap-up step can be redone (e.g. after editing a prompt)."""
    if not sessions.get_state(req.slug):
        raise HTTPException(status_code=409, detail="No active session for this paper.")
    sessions.reopen_discussion(req.slug)
    return {"state": sessions.get_state(req.slug), "transcript": sessions.transcript(req.slug)}


# ---------- committed notes: view / edit / agent-assisted edit ----------
# `target` is a paper slug, or "working" for the cross-paper working notes. Reading and
# saving are quick, plain requests (a save git-commits, like every change to the record);
# the agent edit is a background job (job + poll) whose result is a PROPOSAL the client
# applies explicitly via the save endpoint. Job routes are declared before /notes/{target}
# so "jobs" is never captured as a target.

@project_router.get("/notes/jobs/active/{target}")
def notes_job_active(target: str):
    """The running notes-edit job for a target, if any — lets a client that navigated away
    reattach instead of finding a silent screen."""
    job = notes_jobs.active_for(target)
    return {"job": notes_jobs.snapshot(job.id) if job else None}


@project_router.get("/notes/jobs/{job_id}")
def notes_job_status(job_id: str):
    snap = notes_jobs.snapshot(job_id)
    if not snap:
        raise HTTPException(status_code=404, detail="Unknown notes job")
    return {"job": snap}


@project_router.get("/notes/{target}")
def get_notes(target: str):
    try:
        markdown = notes_jobs.read(target)
    except notes_jobs.NotesError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    return {"target": target, "title": notes_jobs.title_for(target), "markdown": markdown}


@project_router.post("/notes/{target}")
def save_notes(target: str, req: NotesSaveReq):
    """Persist a human-approved notes document (a manual edit, or an applied agent proposal)
    and git-commit it."""
    try:
        result = notes_jobs.save(target, req.markdown, req.summary or "")
    except notes_jobs.NotesError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {**result, "target": target}


@project_router.post("/notes/{target}/agent_job")
def notes_agent_job(target: str, req: NotesAgentReq):
    """Start (or join) a background agent revision of the target's notes from a natural-
    language instruction. Poll /notes/jobs/{id}; the result is applied via POST /notes/{target}."""
    if not config.has_api_key():
        raise HTTPException(status_code=400, detail="No OpenRouter API key set. Open Settings.")
    try:
        job = notes_jobs.start_edit(target, req.instruction)
    except notes_jobs.NotesError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"job": notes_jobs.snapshot(job.id)}


@project_router.get("/review/{slug}")
def get_review(slug: str):
    return committer.review(slug)


@project_router.post("/approve")
def approve(req: ApproveReq):
    proposed = sessions.latest_proposed_commit(req.slug) or {}
    notes = req.notes_block if req.notes_block is not None else proposed.get("notes_block", "")
    synth = req.synthesis if req.synthesis is not None else proposed.get("synthesis", "")
    summary = req.summary or proposed.get("summary", "")
    try:
        result = committer.commit(req.slug, notes, synth, summary)
    except CommitError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"result": result, "paper": _paper_dict(req.slug)}


@project_router.post("/papers")
def add_paper(pid: str, req: AddPaperReq):
    """Add a new *unread* entry to this project's reading list — e.g. accepting a reference-
    graph recommendation. Metadata only: full text stays lazily retrieved (first time it's
    opened, like every other paper) and nothing is git-committed (like every other change to
    the record, that stays an explicit human action via /approve)."""
    try:
        slug = store.add_entry(req.title, req.group or "Unsorted", arxiv_id=req.arxiv_id)
    except store.DuplicatePaperError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"paper": _paper_dict(slug)}


# ---------- discovery (goals -> suggested readings) ----------
# For a fresh project with no papers: the researcher describes their goals, a background job
# (app/discovery_jobs.py) turns them into arXiv searches and ranks up to 50 candidates by
# LLM-scored relevance + global citation counts (app/discovery.py). Job + poll like every
# other long operation here; the ranked list persists in the project's .state/discovery.json.

@project_router.post("/discover")
def start_discovery(pid: str, req: DiscoverReq):
    """Start (or join) a discovery run for this project's goals and return its snapshot
    immediately. Saves the goals into project.json so the field is prefilled on return."""
    goals = req.goals.strip()
    if not goals:
        raise HTTPException(status_code=400, detail="Describe the project's goals first.")
    if not config.has_api_key():
        raise HTTPException(status_code=400, detail="No OpenRouter API key set. Open Settings.")
    projects.update_meta(pid, goals=goals)
    discovery_jobs.start_discovery(pid, goals)
    return {"job": discovery_jobs.snapshot(pid)}


@project_router.get("/discover")
def get_discovery(pid: str):
    """Live job snapshot (poll every ~1.5s while running) plus the last persisted result, so
    the screen shows previous suggestions on re-entry."""
    return {"job": discovery_jobs.snapshot(pid), "result": discovery.load_result(),
            "goals": (projects._read_meta(pid) or {}).get("goals") or ""}


# ---------- reference graph ----------
# Builds a citation graph over the project's papers (see app/graph.py): in-project citation
# edges, external cited papers, and a recommendation ranking for which external papers to
# add. Extraction is the only step that calls an LLM (OpenRouter, DeepSeek V4 Pro by default)
# and is cached per paper by content hash, so rebuilds only spend tokens on changed papers.
#
# The build runs as a server-side background job (app/graph_jobs.py), NOT tied to any single
# request/connection: POST /graph/build starts it (or joins one already running) and returns
# immediately; GET /graph/build/status is polled by the client for progress. This survives a
# mobile app being backgrounded, a dropped connection, or the app being closed and reopened —
# none of that can kill a job that isn't waiting on it. An earlier SSE-stream-IS-the-build
# design didn't survive any of those (confirmed live: a real build silently stopped partway
# through when its driving connection went away, with no way to tell it had happened).

@project_router.get("/graph")
def get_graph(pid: str):
    papers = store.list_papers(sessions.session_states())
    data = graph_store.load()
    job = graph_jobs.get_job(pid)
    return {
        "graph": data.get("graph"),
        "recommendations": data.get("recommendations") or [],
        "status": graph.status(papers),
        "build": job.to_dict() if job else None,
    }


@project_router.get("/graph/recommendations")
def get_graph_recommendations(pid: str):
    data = graph_store.load()
    return {"recommendations": data.get("recommendations") or []}


@project_router.get("/graph/build/status")
def get_graph_build_status(pid: str):
    """Lightweight, cheap-to-poll endpoint for live build progress — the client polls this
    every second or two while a build is running instead of holding a connection open."""
    job = graph_jobs.get_job(pid)
    return {"build": job.to_dict() if job else None}


@project_router.post("/graph/build")
def build_graph_start(pid: str, req: GraphBuildReq):
    """Starts a build in the background and returns its current snapshot immediately (does
    NOT block until it finishes). If a build is already running for this project, joins it
    (returns its current progress) rather than starting a duplicate."""
    job = graph_jobs.start_build(pid, force=req.force)
    return {"build": job.to_dict()}


app.include_router(project_router)


# ---------- static client (mounted last so /api/* wins) ----------

def _asset_version() -> str:
    """Newest mtime of the client assets — used to bust browser caches on each deploy."""
    try:
        return str(int(max((config.WEB_DIR / f).stat().st_mtime for f in ("app.js", "styles.css"))))
    except OSError:
        return "0"


@app.get("/")
def index():
    # Serve index.html with versioned asset URLs and no-cache, so phones always pick up the
    # latest app.js / styles.css instead of a stale cached copy.
    html = (config.WEB_DIR / "index.html").read_text(encoding="utf-8")
    v = _asset_version()
    html = html.replace("/app.js", f"/app.js?v={v}").replace("/styles.css", f"/styles.css?v={v}")
    return HTMLResponse(html, headers={"Cache-Control": "no-cache, no-store, must-revalidate"})


app.mount("/", StaticFiles(directory=str(config.WEB_DIR), html=True), name="web")
