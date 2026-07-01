"""Runtime configuration.

Two scopes:
- **App-global** (one OpenRouter key, model picks, TTS settings, prompt overrides, audio +
  narration caches) live in APP_STATE_DIR, shared across every research project.
- **Per-project** data (reading list, method, corpus, sessions, notes, session-state index)
  lives under PROJECTS_ROOT/<project-id>/, each its own git repo.

The *active project* for the current request is held in a contextvar set by the API layer
(see app.projects.use_project). Lower layers call project_dir()/state_dir() to resolve paths,
so nothing binds a single project at import time.
"""
from __future__ import annotations

import contextvars
import json
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent
WEB_DIR = BASE_DIR / "web"

# Where all projects live (each subdir is one project, its own git repo). Gitignored.
PROJECTS_ROOT = Path(os.environ.get("RC_PROJECTS_ROOT", str(BASE_DIR / "projects"))).resolve()
# App-global state (settings, prompt overrides, audio + narration caches). Gitignored.
APP_STATE_DIR = Path(os.environ.get("RC_APP_STATE_DIR", str(BASE_DIR / ".app-state"))).resolve()
APP_STATE_DIR.mkdir(parents=True, exist_ok=True)
SETTINGS_FILE = APP_STATE_DIR / "settings.json"

# Default project id used when the request didn't scope one (single-project / legacy callers).
DEFAULT_PROJECT_ID = os.environ.get("RC_DEFAULT_PROJECT", "default")
# Legacy single-project dir (pre-multiproject). Used as a fallback so the app keeps working
# before/without migration. RC_PROJECT_DIR overrides; else ./project if it exists.
_LEGACY_PROJECT_DIR = os.environ.get("RC_PROJECT_DIR")

OPENROUTER_BASE = "https://openrouter.ai/api/v1"
OPENAI_BASE = "https://api.openai.com/v1"
APP_TITLE = os.environ.get("RC_APP_TITLE", "Research Reading Companion")

# ---- active project (per-request) ----

_active_project: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "active_project", default=None)


def set_active_project(project_id: str | None) -> contextvars.Token:
    return _active_project.set(project_id)


def reset_active_project(token: contextvars.Token) -> None:
    _active_project.reset(token)


def active_project_id() -> str | None:
    return _active_project.get()


def project_dir() -> Path:
    """Directory of the active project. Falls back to the legacy single-project dir when no
    project is scoped and no projects root has been populated yet."""
    pid = _active_project.get()
    if pid:
        return PROJECTS_ROOT / pid
    if _LEGACY_PROJECT_DIR:
        return Path(_LEGACY_PROJECT_DIR).resolve()
    legacy = BASE_DIR / "project"
    if legacy.exists() and not (PROJECTS_ROOT / DEFAULT_PROJECT_ID).exists():
        return legacy.resolve()
    return PROJECTS_ROOT / DEFAULT_PROJECT_ID


def state_dir() -> Path:
    """Per-project transient state (session index). Created lazily."""
    d = project_dir() / ".state"
    d.mkdir(parents=True, exist_ok=True)
    return d


# ---- app-global settings (UI-overridable) ----

_ENV_DEFAULTS = {
    "openrouter_api_key": os.environ.get("OPENROUTER_API_KEY", ""),
    # analysis model: reads the paper, writes the scholarly record
    "model": os.environ.get("RC_MODEL", "anthropic/claude-opus-4.6"),
    # narration model: faithfully adapts the canonical text for TTS (lighter/faster)
    "narration_model": os.environ.get("RC_NARRATION_MODEL", "anthropic/claude-haiku-4.5"),
    # speech (audio) — OpenRouter has no TTS, so OpenAI uses its own key
    "openai_api_key": os.environ.get("OPENAI_API_KEY", ""),
    "speech_provider": os.environ.get("RC_SPEECH_PROVIDER", "openai"),  # openai | browser
    "tts_model": os.environ.get("RC_TTS_MODEL", "gpt-4o-mini-tts"),
    "tts_voice": os.environ.get("RC_TTS_VOICE", "alloy"),
    # web search/fetch for the agent's research tools — a provider chain (Firecrawl -> Parallel
    # -> keyless DuckDuckGo). Keys optional; also read from env at call time (see research_tools).
    "parallel_api_key": os.environ.get("PARALLEL_API_KEY", "") or os.environ.get("PARALLEL_SEARCH_API_KEY", ""),
    "firecrawl_api_key": os.environ.get("FIRECRAWL_API_KEY", ""),
}


def load_settings() -> dict:
    """File settings (UI-set) layered over env defaults."""
    data = dict(_ENV_DEFAULTS)
    if SETTINGS_FILE.exists():
        try:
            data.update({k: v for k, v in json.loads(SETTINGS_FILE.read_text()).items() if v})
        except (json.JSONDecodeError, OSError):
            pass
    return data


def save_settings(patch: dict) -> dict:
    """Persist non-empty keys; returns the merged settings."""
    current = {}
    if SETTINGS_FILE.exists():
        try:
            current = json.loads(SETTINGS_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            current = {}
    for key in ("openrouter_api_key", "model", "narration_model", "openai_api_key",
                "speech_provider", "tts_model", "tts_voice", "parallel_api_key",
                "firecrawl_api_key"):
        if key in patch and patch[key] is not None:
            current[key] = patch[key]
    SETTINGS_FILE.write_text(json.dumps(current, indent=2))
    return load_settings()


def has_api_key() -> bool:
    return bool(load_settings().get("openrouter_api_key"))


def _read_settings_file() -> dict:
    if SETTINGS_FILE.exists():
        try:
            return json.loads(SETTINGS_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def get_prompt_override(key: str) -> str | None:
    """User-edited prompt text, or None if using the built-in default."""
    return (_read_settings_file().get("prompts") or {}).get(key)


def set_prompt_override(key: str, value: str | None) -> None:
    """Persist a prompt override; value None/empty removes it (reverts to default)."""
    data = _read_settings_file()
    overrides = data.get("prompts") or {}
    if value:
        overrides[key] = value
    else:
        overrides.pop(key, None)
    data["prompts"] = overrides
    SETTINGS_FILE.write_text(json.dumps(data, indent=2))
