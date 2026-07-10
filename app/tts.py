"""TTS behind a thin, swappable interface (Section 10).

Two providers:
- `browser` — passthrough; the client speaks the narration via the Web Speech API (free,
  zero setup). Used when speech_provider == "browser".
- `openai`  — server synthesizes mp3 via OpenAI's /audio/speech (premium quality). The route
  layer caches and serves the audio. OpenRouter does not expose TTS, so this uses a separate
  OpenAI key.

The narration TEXT is always produced by the stage-2 narration model first (see agent.narrate);
this module only turns that text into sound.
"""
from __future__ import annotations

import re
import time
from typing import Protocol

import httpx

from . import config, prompts

# OpenAI /audio/speech caps input at 4096 chars; stay under with margin and synthesize long
# narrations as several segments concatenated into one mp3.
MAX_TTS_CHARS = 3800

# Voices valid for gpt-4o-mini-tts / tts-1; surfaced in the UI picker.
OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx",
                 "sage", "shimmer", "verse"]


class TTSError(Exception):
    pass


class TTSProvider(Protocol):
    name: str

    def synthesize(self, narration: str) -> dict:
        ...


# Spoken-form substitutions applied at the synthesis boundary ONLY (polish plan I.4):
# display text, canonical records, and cached narration text all keep the written form
# ("arXiv"); the voice gets the accepted pronunciation. Keyed small and word-bounded —
# add entries here as more mispronunciations are reported.
_SPOKEN_FORMS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\barxiv\b", re.IGNORECASE), "archive"),
)


def normalize_for_speech(text: str) -> str:
    for pattern, spoken in _SPOKEN_FORMS:
        text = pattern.sub(spoken, text)
    return text


class BrowserTTS:
    """Passthrough: the client synthesizes locally from this text."""
    name = "browser"

    def synthesize(self, narration: str) -> dict:
        return {"mode": "browser", "text": normalize_for_speech(narration)}


# Transient statuses worth retrying per segment (rate limits, upstream hiccups). A long
# narration is many sequential segments, so one blip shouldn't scrap the whole synthesis.
_RETRYABLE = {429, 500, 502, 503, 504}
_TRIES = 3


def openai_speech(text: str) -> bytes:
    """Synthesize one passage to mp3 bytes via OpenAI, retrying transient failures.
    Settings supply key/model/voice."""
    s = config.load_settings()
    key = s.get("openai_api_key")
    if not key:
        raise TTSError("No OpenAI API key set. Add it in Settings → Speech.")
    model = s.get("tts_model") or "gpt-4o-mini-tts"
    voice = s.get("tts_voice") or "alloy"
    body = {"model": model, "voice": voice, "input": normalize_for_speech(text),
            "response_format": "mp3"}
    if model == "gpt-4o-mini-tts":
        body["instructions"] = prompts.get("tts_instructions")
    last_err = "unknown error"
    for attempt in range(_TRIES):
        if attempt:
            time.sleep(2 * attempt)
        try:
            r = httpx.post(
                f"{config.OPENAI_BASE}/audio/speech",
                headers={"Authorization": f"Bearer {key}"},
                json=body, timeout=120,
            )
        except httpx.HTTPError as e:
            last_err = f"OpenAI TTS request failed: {e}"
            continue
        if r.status_code == 200:
            return r.content
        last_err = f"OpenAI TTS error {r.status_code}: {r.text[:300]}"
        if r.status_code not in _RETRYABLE:
            break
    raise TTSError(last_err)


def split_for_tts(text: str, limit: int = MAX_TTS_CHARS) -> list[str]:
    """Split on sentence boundaries into segments under the API char limit."""
    text = text.strip()
    if len(text) <= limit:
        return [text] if text else []
    out, cur = [], ""
    for s in re.split(r"(?<=[.!?])\s+", text):
        while len(s) > limit:                      # pathological single sentence
            out.append(s[:limit])
            s = s[limit:]
        if not cur:
            cur = s
        elif len(cur) + 1 + len(s) <= limit:
            cur += " " + s
        else:
            out.append(cur)
            cur = s
    if cur:
        out.append(cur)
    return out


def synthesize_long(text: str) -> bytes:
    """Synthesize an arbitrarily long narration into ONE mp3 (segments concatenated). mp3 is
    frame-based, so byte-concatenating segments yields a single file that plays end to end."""
    parts = split_for_tts(text)
    if not parts:
        raise TTSError("Nothing to synthesize.")
    if len(parts) == 1:
        return openai_speech(parts[0])
    return b"".join(openai_speech(p) for p in parts)
