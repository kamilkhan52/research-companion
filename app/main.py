"""FastAPI app: the deterministic orchestrator (state machine + session flows) plus the
thin API the mobile client talks to. Serves the web client from the same origin so a phone
and a desktop hit one backend.
"""
from __future__ import annotations

import hashlib
import json
import re

import httpx
from fastapi import APIRouter, Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import agent, committer, config, projects, prompts, retriever, sessions, store, tts
from .agent import AgentError
from .committer import CommitError
from .models import REVIEW_SLUG, REVIEW_TITLE
from .projects import ProjectError
from .prompts import PromptError
from .retriever import RetrievalError
from .tts import TTSError

app = FastAPI(title=config.APP_TITLE)

# All per-project data routes live under /api/projects/{pid}/… and run with that project bound
# as active (use_project sets config's contextvar for the whole request, incl. streaming).
project_router = APIRouter(prefix="/api/projects/{pid}",
                           dependencies=[Depends(projects.use_project)], tags=["project"])

AUDIO_DIR = config.APP_STATE_DIR / "audio"  # app-global (TTS cache shared across projects)
AUDIO_DIR.mkdir(parents=True, exist_ok=True)


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


class NarrateReq(BaseModel):
    text: str


class PromptReq(BaseModel):
    key: str
    value: str | None = None


class RetryReq(BaseModel):
    slug: str
    assistant_index: int
    model: str | None = None


class ProjectReq(BaseModel):
    name: str
    method: str | None = None   # optional starting reading-method; defaults to the template


# ---------- helpers ----------

def _paper_dict(slug: str) -> dict:
    p = store.get_paper(slug, sessions.session_states())
    return p.to_dict() if p else {"slug": slug}


def _run_and_record(slug: str) -> dict:
    history = sessions.build_history(slug)
    try:
        turn = agent.run_turn(slug, history)
    except AgentError as e:
        raise HTTPException(status_code=400, detail=str(e))
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


_SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


# ---------- state / settings ----------

@app.get("/api/health")
def health():
    return {"ok": True, "title": config.APP_TITLE}


# ---------- projects (management) ----------

@app.get("/api/projects")
def list_projects():
    return {"projects": projects.list_projects()}


@app.post("/api/projects")
def create_project(req: ProjectReq):
    try:
        meta = projects.create_project(req.name, req.method)
    except ProjectError as e:
        raise HTTPException(status_code=400, detail=str(e))
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
        raise HTTPException(status_code=400, detail=str(e))
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


@app.get("/api/settings")
def read_settings():
    s = config.load_settings()
    key = s.get("openrouter_api_key") or ""
    okey = s.get("openai_api_key") or ""
    return {
        "has_key": bool(key), "key_hint": (key[:6] + "…") if key else "",
        "model": s.get("model"), "narration_model": s.get("narration_model"),
        "has_openai_key": bool(okey), "openai_key_hint": (okey[:6] + "…") if okey else "",
        "speech_provider": s.get("speech_provider"), "tts_model": s.get("tts_model"),
        "tts_voice": s.get("tts_voice"), "voices": tts.OPENAI_VOICES,
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
    }


@app.post("/api/speak")
def speak(req: NarrateReq):
    """Synthesize one passage to mp3 (OpenAI), cached on disk; returns its URL."""
    s = config.load_settings()
    if s.get("speech_provider") != "openai":
        raise HTTPException(status_code=400, detail="Speech provider is not OpenAI.")
    cache_key = f"openai|{s.get('tts_model')}|{s.get('tts_voice')}|{req.text}"
    name = hashlib.sha1(cache_key.encode("utf-8")).hexdigest() + ".mp3"
    path = AUDIO_DIR / name
    if not path.exists():
        try:
            path.write_bytes(tts.synthesize_long(req.text))
        except TTSError as e:
            raise HTTPException(status_code=400, detail=str(e))
    return {"url": f"/api/audio/{name}"}


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
        raise HTTPException(status_code=400, detail=str(e))
    return {"key": req.key, "value": prompts.get(req.key), "is_overridden": prompts.is_overridden(req.key)}


@app.post("/api/prompts/reset")
def reset_prompt(req: PromptReq):
    try:
        prompts.reset(req.key)
    except PromptError as e:
        raise HTTPException(status_code=400, detail=str(e))
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
        raise HTTPException(status_code=400, detail=str(e))
    sessions.cache_narration(req.text, narration)
    return {"narration": narration, "cached": False}


@app.get("/api/models")
def list_models():
    """Proxy OpenRouter's public model catalogue so the UI can offer a switcher."""
    try:
        r = httpx.get(f"{config.OPENROUTER_BASE}/models", timeout=30)
        r.raise_for_status()
        data = r.json().get("data", [])
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Could not reach OpenRouter: {e}")
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
        r = httpx.get(f"{config.OPENROUTER_BASE}/models", timeout=30)
        r.raise_for_status()
        data = r.json().get("data", [])
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Could not reach OpenRouter: {e}")
    out = []
    for fam in FAVORITE_FAMILIES:
        exc = fam["exc"] + FAVORITE_GLOBAL_EXC
        matches = [m for m in data if m.get("id") and m["id"][:1].isalnum()
                   and all(s in m["id"].lower() for s in fam["inc"])
                   and not any(s in m["id"].lower() for s in exc)]
        if not matches:
            continue
        best = max(matches, key=lambda m: m.get("created", 0))  # newest = latest version
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
        raise HTTPException(status_code=422, detail=str(e))
    if res.get("needs_confirmation"):
        return {"needs_confirmation": True, "candidates": res["candidates"], "slug": req.slug}
    store.write_full_text(req.slug, paper.title, res["full_text"], {
        "slug": req.slug, "arxiv_id": res.get("arxiv_id"), "source": res.get("source"),
    })
    return {"ok": True, "retrieved": True}


@project_router.post("/chat/start_stream")
def chat_start_stream(req: ChatStartReq):
    """Fire the first response for any chat (paper or review) with the edited opening prompt
    and chosen model, streaming it. Restarts the session (used for start and first-retry)."""
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
    return StreamingResponse(_turn_stream(req.slug), media_type="text/event-stream",
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
    if not sessions.get_state(req.slug):
        raise HTTPException(status_code=409, detail="No active session for this paper.")
    sessions.record_user(req.slug, req.text, kind="reply")
    return StreamingResponse(_turn_stream(req.slug), media_type="text/event-stream",
                             headers=_SSE_HEADERS)


@project_router.post("/continue_stream")
def continue_stream(req: FinishReq):
    if not sessions.get_state(req.slug):
        raise HTTPException(status_code=409, detail="No active session for this paper.")
    records = sessions.read_records(req.slug)
    if not records or records[-1]["role"] != "user":
        raise HTTPException(status_code=409, detail="Nothing to continue — last turn already answered.")
    return StreamingResponse(_turn_stream(req.slug), media_type="text/event-stream",
                             headers=_SSE_HEADERS)


@project_router.post("/retry_stream")
def retry_stream(req: RetryReq):
    """Regenerate the n-th assistant turn: discard it (and anything after) and stream a fresh
    response to the preceding user message."""
    if not sessions.get_state(req.slug):
        raise HTTPException(status_code=409, detail="No active session for this paper.")
    if req.model:
        config.save_settings({"model": req.model})
    sessions.truncate_before_assistant(req.slug, req.assistant_index)
    return StreamingResponse(_turn_stream(req.slug), media_type="text/event-stream",
                             headers=_SSE_HEADERS)


@project_router.post("/finish_stream")
def finish_stream(req: FinishReq):
    if not sessions.get_state(req.slug):
        raise HTTPException(status_code=409, detail="No active session for this paper.")
    # The review chat folds the discussion into the working notes; a paper drafts its Notes.
    key = "review_finish" if req.slug == REVIEW_SLUG else "finish_instruction"
    sessions.record_user(req.slug, prompts.get(key), kind="finish")
    return StreamingResponse(_turn_stream(req.slug), media_type="text/event-stream",
                             headers=_SSE_HEADERS)


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
    instruction = prompts.render("request_changes", feedback=req.text)
    sessions.record_user(req.slug, instruction, kind="revision")
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
        raise HTTPException(status_code=400, detail=str(e))
    return {"result": result, "paper": _paper_dict(req.slug)}


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
