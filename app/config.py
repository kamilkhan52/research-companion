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
import threading
from pathlib import Path

from dotenv import load_dotenv

from .fileio import atomic_write_text

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

# Author for the commits the app makes into a project's git store (committer.commit,
# notes_jobs.save, projects.create_project). The store shells out to `git commit`, which needs
# an author; relying on the host's global git identity means a fresh server/container/CI runner
# with no `git config --global` fails ("empty ident name") on note approval and silently skips a
# new project's baseline commit. We pin the author explicitly instead (see git_identity_args),
# so commits always succeed and are attributed consistently regardless of host config. Default
# matches the identity the existing project repos already use. Once projects are scoped per user
# this is the natural hook for per-user attribution (pass the authenticated user through).
GIT_AUTHOR_NAME = os.environ.get("RC_GIT_AUTHOR_NAME", "Research Companion")
GIT_AUTHOR_EMAIL = os.environ.get("RC_GIT_AUTHOR_EMAIL", "companion@local")


def git_identity_args() -> list[str]:
    """`git -c` flags pinning the commit author/committer to the app identity. Prepended to every
    app-issued git invocation so a commit never depends on (or is broken by the absence of) the
    host's global git config. `-c` takes precedence over repo/global config, so authorship is
    deterministic."""
    return [
        "-c", f"user.name={GIT_AUTHOR_NAME}",
        "-c", f"user.email={GIT_AUTHOR_EMAIL}",
    ]

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
    # which prior per-paper Notes go into every paper turn's context:
    #   "related" = only citation-related papers (compact); "all" = every paper read so far
    #   (richer cross-paper grounding for a single-project workflow; larger context per turn)
    "prior_notes_scope": os.environ.get("RC_PRIOR_NOTES_SCOPE", "related"),
}


_SETTING_KEYS = ("openrouter_api_key", "model", "narration_model", "openai_api_key",
                 "speech_provider", "tts_model", "tts_voice", "parallel_api_key",
                 "firecrawl_api_key", "prior_notes_scope")

# Serializes the read-modify-write of the shared settings file. A turn persisting its model
# choice, a UI settings save, and a prompt-override edit all mutate the same file; without this
# two concurrent saves race and one silently drops the other's change (single-process app, so a
# threading.Lock is sufficient — see CLAUDE.md on the single-worker assumption).
_settings_lock = threading.Lock()


def load_settings() -> dict:
    """File settings (UI-set) layered over env defaults. A stored key is honored even when its
    value is empty — an explicit "" is a deliberate unset (revert to no value), distinct from a
    key being absent (use the env default)."""
    data = dict(_ENV_DEFAULTS)
    stored = _read_settings_file()
    for key in _SETTING_KEYS:
        if key in stored:
            data[key] = stored[key]
    return data


def save_settings(patch: dict) -> dict:
    """Merge a patch into the settings file and return the merged settings. Per key:
    absent or None => leave unchanged; "" => clear the override (falls back to the env default);
    any other value => set it. Serialized under _settings_lock so concurrent saves don't clobber."""
    with _settings_lock:
        current = _read_settings_file()
        for key in _SETTING_KEYS:
            if key not in patch or patch[key] is None:
                continue
            if patch[key] == "":
                current.pop(key, None)  # explicit unset -> revert to env default / absent
            else:
                current[key] = patch[key]
        # 0o600: this file holds API keys.
        atomic_write_text(SETTINGS_FILE, json.dumps(current, indent=2), mode=0o600)
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
    """Persist a prompt override; value None/empty removes it (reverts to default). Shares
    _settings_lock with save_settings since both read-modify-write the same file."""
    with _settings_lock:
        data = _read_settings_file()
        overrides = data.get("prompts") or {}
        if value:
            overrides[key] = value
        else:
            overrides.pop(key, None)
        data["prompts"] = overrides
        atomic_write_text(SETTINGS_FILE, json.dumps(data, indent=2), mode=0o600)
