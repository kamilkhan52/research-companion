"""Runtime configuration. Defaults come from env / .env; the UI can override the
OpenRouter key and model at runtime, persisted to project/.state/settings.json."""
from __future__ import annotations

import json
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = Path(os.environ.get("RC_PROJECT_DIR", str(BASE_DIR / "project"))).resolve()
WEB_DIR = BASE_DIR / "web"
STATE_DIR = PROJECT_DIR / ".state"
STATE_DIR.mkdir(parents=True, exist_ok=True)
SETTINGS_FILE = STATE_DIR / "settings.json"

OPENROUTER_BASE = "https://openrouter.ai/api/v1"
OPENAI_BASE = "https://api.openai.com/v1"
APP_TITLE = os.environ.get("RC_APP_TITLE", "Research Reading Companion")

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
                "speech_provider", "tts_model", "tts_voice"):
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
