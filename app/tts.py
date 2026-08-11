"""TTS behind a thin, swappable interface (Section 10).

Two providers:
- `browser` — passthrough; the client speaks the narration via the Web Speech API (free,
  zero setup). Used when speech_provider == "browser".
- `openai`  — server synthesizes mp3 via OpenAI's /audio/speech (premium quality). The route
  layer caches and serves the audio. OpenRouter does not expose TTS, so this uses a separate
  OpenAI key.

The narration TEXT is always produced by the stage-2 narration model first (see agent.narrate);
this module only turns that text into sound.

**The default OpenAI model is `tts-1`** (H22, revised 2026-07-25), and the reason is metering
rather than quality. It is character-priced at $15/1M, so the cost of a narration is exactly
computable *before* synthesis — which is what the spend ceiling needs, since this API returns raw
mp3 with no usage payload and never reports a cost back. It is also half the price of `tts-1-hd`,
and audio is the largest variable cost in the app. `tts-1-hd` and `gpt-4o-mini-tts` stay
selectable; the latter is the only one that accepts the `tts_instructions` steerability prompt.
"""
from __future__ import annotations

import re
import time
from typing import Protocol

import httpx

from . import config, logging_config, prompts, spend_control, usage

# OpenAI /audio/speech caps input at 4096 chars; stay under with margin and synthesize long
# narrations as several segments concatenated into one mp3.
MAX_TTS_CHARS = 3800

# Voices valid for tts-1 / tts-1-hd / gpt-4o-mini-tts; surfaced in the UI picker.
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

# OpenAI publishes these two speech models per input character. Keep the price beside the only
# dispatch seam so retries and every caller use the same accounting.
log = logging_config.get("tts")

_USD_PER_CHARACTER = {
    "tts-1": 15 / 1_000_000,
    "tts-1-hd": 30 / 1_000_000,
}

# Token/audio-priced models. This binary endpoint returns no per-request usage, so there is no
# exact figure to record — but recording NOTHING is worse than recording an estimate now that a
# spend ceiling settles against these numbers. `gpt-4o-mini-tts` is user-selectable (it is a
# per-user preference and the first entry in the voice picker), so an unpriced model was a
# self-service way to make the app's largest variable cost invisible: the job settled at exactly
# zero and handed back its whole hold.
#
# Deliberately pessimistic, in the same direction as every other number in the ceiling: an
# over-estimate binds the ceiling slightly early, an under-estimate lets spend escape it. Rated
# above `tts-1-hd` because audio-token pricing runs higher per character of speech than either
# character-priced model. The call is still ALSO recorded pending, so the exact figure can replace
# this if a reconciliation source ever appears.
_ESTIMATED_USD_PER_CHARACTER = {
    "gpt-4o-mini-tts": 40 / 1_000_000,
}


def nanousd_per_char(model: str) -> int | None:
    """The per-character rate the ceiling should assume for `model`, in nano-USD, or None for a
    model this module cannot price. Estimated rates count — an under-sized hold lets spend
    escape the ceiling, which is the failure the estimates exist to prevent (DR-042 round 2:
    sizing every hold at tts-1's rate under-reserved 2.7x on gpt-4o-mini-tts)."""
    usd = _USD_PER_CHARACTER.get(model) or _ESTIMATED_USD_PER_CHARACTER.get(model)
    if usd is None:
        return None
    return int(usd * 1_000_000_000)


def _record_dispatch(model: str, spoken_text: str, *, estimated: bool = False) -> None:
    """Charge one completed or transport-ambiguous dispatch to the active usage scope.

    A returned non-2xx response is a definite provider rejection and records nothing. A successful
    response is exact. A transport failure after connection may mean OpenAI completed and billed
    work even though this process never received the bytes, so charge it conservatively and leave
    the ledger estimated. Analytics remains best-effort and must never block synthesis.
    """
    rate = _USD_PER_CHARACTER.get(model)
    if rate is None:
        estimate = _ESTIMATED_USD_PER_CHARACTER.get(model)
        if estimate is None:
            # An unknown model: still no made-up number, but say so loudly. A speech model that
            # reaches here bills real money the ceiling cannot see.
            log.warning("speech model %s has no price; its spend is invisible to the ceiling",
                        model)
            usage.record("speech_synthesis", model, {})
            usage.record_pending("speech_synthesis", model, None)
            return
        usage.record(
            "speech_synthesis",
            model,
            {"cost": len(spoken_text) * estimate},
            estimated=True,
        )
        usage.record_pending("speech_synthesis", model, None)
        return
    usage.record(
        "speech_synthesis",
        model,
        {"cost": len(spoken_text) * rate},
        estimated=estimated,
    )
    if estimated:
        usage.record_pending("speech_synthesis", model, None)


def _friendly_tts_error(status: int, raw: str) -> str:
    """User-facing message for an OpenAI speech failure — quota/key/rate problems in the
    app's voice with the action to take. The raw body is inspected only to distinguish quota from
    rate limiting; it is never included in the returned error."""
    if status == 401:
        return "OpenAI rejected the speech API key. Check it in Settings → Speech."
    if status == 429:
        if "insufficient_quota" in raw:
            return ("The OpenAI account is out of speech quota — audio can't be synthesized "
                    "until it's topped up at platform.openai.com.")
        return "OpenAI is rate-limiting speech synthesis. Wait a moment and retry."
    if status >= 500:
        return f"OpenAI's speech service is having trouble (HTTP {status}). Retry shortly."
    return f"OpenAI declined speech synthesis (HTTP {status}). Check Speech settings and retry."


def resolve_model(configured: str | None) -> str:
    """The model that will actually synthesize, from a stored setting or override.

    `tts-1-hd` is retired (DR-042, Kamil 2026-08-10): not audibly better than tts-1, slower,
    and twice the price — and audio quality is no longer a plan dimension. Mapped here rather
    than only removed from pickers, so a persisted setting or an RC_TTS_MODEL override naming
    it cannot quietly double every narration's cost. The audio cache key uses this same
    resolution, so a retired setting shares the tts-1 bucket instead of re-billing identical
    audio under a second namespace.
    """
    model = configured or "tts-1"
    if model == "tts-1-hd":
        log.info("tts-1-hd is retired; synthesizing with tts-1")
        model = "tts-1"
    return model


def openai_speech(text: str) -> bytes:
    """Synthesize one passage to mp3 bytes via OpenAI, retrying transient failures.
    Settings supply key/model/voice."""
    s = config.load_settings()
    key = s.get("openai_api_key")
    if not key:
        raise TTSError("No OpenAI API key set. Add it in Settings → Speech.")
    model = resolve_model(s.get("tts_model"))
    voice = s.get("tts_voice") or "alloy"
    spoken_text = normalize_for_speech(text)
    body = {"model": model, "voice": voice, "input": spoken_text,
            "response_format": "mp3"}
    if model == "gpt-4o-mini-tts":
        # Steerability is a gpt-4o-mini-tts feature; the character-priced tts-1 family rejects
        # `instructions`. Keep the send conditional on the model, not on the setting existing.
        body["instructions"] = prompts.get("tts_instructions")
    last_err = "Could not reach OpenAI's speech service. Check the connection and retry."
    for attempt in range(_TRIES):
        if attempt:
            time.sleep(2 * attempt)
        try:
            spend_control.require_enabled()
            r = httpx.post(
                f"{config.OPENAI_BASE}/audio/speech",
                headers={"Authorization": f"Bearer {key}"},
                json=body, timeout=120,
            )
        except spend_control.ProviderSpendDisabled as e:
            raise TTSError(str(e)) from e
        except (httpx.ConnectError, httpx.ConnectTimeout):
            # No connection means no provider dispatch and therefore no possible synthesis bill.
            continue
        except httpx.HTTPError:
            # The connection existed but no authoritative response arrived. It may have completed
            # upstream, so account conservatively and keep totals visibly estimated.
            _record_dispatch(model, spoken_text, estimated=True)
            continue
        if r.status_code == 200:
            _record_dispatch(model, spoken_text)
            return r.content
        last_err = _friendly_tts_error(r.status_code, r.text)
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
