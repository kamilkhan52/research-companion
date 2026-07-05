"""App-global model-catalogue routes: the full OpenRouter listing and the resolved
"favorite" model families the quick switcher offers."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import llm

router = APIRouter()


@router.get("/api/models")
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


@router.get("/api/favorite_models")
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
