"""The agentic core, now a two-stage pipeline.

Stage 1 — the analysis model reads the paper and produces only the CANONICAL scholarly
output (the written record). It does not think about audio at all.

Stage 2 — a separate, lighter narration model (see `narrate`) receives ONLY that canonical
text, without the paper, and adapts it sentence-for-sentence into a TTS-friendly transcript:
it preserves all technical content, numbers, and quotes, and changes only what speech
requires. This is the deliberate decoupling that keeps the narration faithful to the
analysis instead of drifting from it.

The analysis response uses a delimiter protocol (not literal JSON) because long scholarly
prose with equations/quotes/links breaks JSON string escaping.
"""
from __future__ import annotations

import json
import re

import httpx

from . import assembler, config, prompts
from .models import REVIEW_SLUG, ProposedCommit, Turn

SECTIONS = ["CANONICAL", "STATE", "COMMIT_SUMMARY", "NOTES_BLOCK", "SYNTHESIS"]
_SECTION_RE = re.compile(r"^###\s*(" + "|".join(SECTIONS) + r")\s*###\s*$", re.M)


def _system_for(slug: str) -> str:
    """The system prompt + assembled context for a turn (review chat vs paper chat)."""
    if slug == REVIEW_SLUG:
        return prompts.get("review_system") + "\n\n=== REVIEW CONTEXT ===\n\n" + assembler.build_context(slug)
    return prompts.get("analysis_system") + "\n\n=== READING CONTEXT ===\n\n" + assembler.build_context(slug)





class AgentError(Exception):
    pass


def _parse(content: str) -> Turn:
    content = content if isinstance(content, str) else (content or "")
    matches = list(_SECTION_RE.finditer(content))
    if not matches:
        # Model ignored the protocol: treat the whole thing as the canonical record.
        return Turn(role="assistant", canonical=content.strip(), state_signal="in_discussion")
    sections: dict[str, str] = {}
    for i, m in enumerate(matches):
        name = m.group(1)
        end = matches[i + 1].start() if i + 1 < len(matches) else len(content)
        body = content[m.end():end].strip()
        body = re.sub(r"###\s*END\s*###\s*$", "", body).strip()
        sections[name] = body

    def val(key: str) -> str:
        v = sections.get(key, "").strip()
        return "" if v.upper() == "NONE" else v

    state = (sections.get("STATE", "in_discussion") or "in_discussion").strip().lower()
    state = "ready_to_draft_notes" if "ready" in state else "in_discussion"

    commit = None
    notes, synth, summary = val("NOTES_BLOCK"), val("SYNTHESIS"), val("COMMIT_SUMMARY")
    if notes or synth:  # paper commit has both; the review chat has working notes (synth) only
        commit = ProposedCommit(summary=summary or "Notes + working-notes update",
                                notes_block=notes, synthesis=synth).to_dict()

    return Turn(
        role="assistant",
        canonical=val("CANONICAL") or content.strip(),
        narration="",  # produced lazily by the narration model
        state_signal=state,
        proposed_commit=commit,
    )


def _call_openrouter(messages: list[dict], model: str | None = None,
                     temperature: float = 0.3, max_tokens: int = 8000) -> str:
    settings = config.load_settings()
    key = settings.get("openrouter_api_key")
    if not key:
        raise AgentError("No OpenRouter API key set. Add it in Settings.")
    headers = {
        "Authorization": f"Bearer {key}",
        "HTTP-Referer": "http://localhost",
        "X-Title": config.APP_TITLE,
    }
    body = {
        "model": model or settings.get("model"),
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    try:
        r = httpx.post(f"{config.OPENROUTER_BASE}/chat/completions",
                       headers=headers, json=body, timeout=300)
    except httpx.HTTPError as e:
        raise AgentError(f"OpenRouter request failed: {e}") from e
    if r.status_code != 200:
        raise AgentError(f"OpenRouter error {r.status_code}: {r.text[:400]}")
    data = r.json()
    try:
        choice = data["choices"][0]
        message = choice.get("message", {}) or {}
    except (KeyError, IndexError, TypeError) as e:
        raise AgentError(f"Unexpected OpenRouter response: {str(data)[:400]}") from e
    content = message.get("content")
    if isinstance(content, list):  # some providers return content as a list of parts
        content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
    if not content or not str(content).strip():
        fr = choice.get("finish_reason")
        hint = (" — it ran out of output tokens"
                if fr == "length" else "")
        raise AgentError(
            f"The model returned an empty response (finish_reason={fr}){hint}. "
            "Try again, or pick a different analysis model in Settings.")
    return content


def parse(content: str) -> Turn:
    """Public wrapper: parse a complete analysis response into a Turn."""
    return _parse(content)


def run_turn(slug: str, history: list[dict]) -> Turn:
    """Stage 1: history is [{role, content}] (assistant content is the prior CANONICAL text).
    Returns the parsed analysis Turn (narration is filled later by `narrate`). The analysis
    model gets a large output budget because reasoning models spend tokens before the answer."""
    messages = [{"role": "system", "content": _system_for(slug)}] + history
    return _parse(_call_openrouter(messages, max_tokens=16000))


# ---- streaming (Stage 1) ----

_CANON_START_RE = re.compile(r"###\s*CANONICAL\s*###")
_NEXT_SECTION_RE = re.compile(r"###\s*(STATE|COMMIT_SUMMARY|NOTES_BLOCK|SYNTHESIS|END)\s*###")


def canonical_prefix(raw: str) -> str:
    """The CANONICAL text visible so far in a partial stream — i.e. everything after the
    CANONICAL marker and before the next section marker. Used to stream only the scholarly
    answer to the client, never the protocol scaffolding. Holds back a trailing partial
    marker (e.g. '###STA' while '###STATE###' is still arriving)."""
    m = _CANON_START_RE.search(raw)
    if not m:
        return "" if "###" in raw else raw.strip()
    rest = raw[m.end():]
    nxt = _NEXT_SECTION_RE.search(rest)
    if nxt:
        rest = rest[:nxt.start()]
    else:
        rest = re.sub(r"\s*#{1,3}[A-Z_]*$", "", rest)  # a forming next-section marker
    return rest.strip()


def _stream_openrouter(messages: list[dict], model: str | None = None,
                       temperature: float = 0.3, max_tokens: int = 16000):
    settings = config.load_settings()
    key = settings.get("openrouter_api_key")
    if not key:
        raise AgentError("No OpenRouter API key set. Add it in Settings.")
    headers = {
        "Authorization": f"Bearer {key}",
        "HTTP-Referer": "http://localhost",
        "X-Title": config.APP_TITLE,
    }
    body = {
        "model": model or settings.get("model"),
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": True,
    }
    try:
        with httpx.stream("POST", f"{config.OPENROUTER_BASE}/chat/completions",
                          headers=headers, json=body, timeout=300) as r:
            if r.status_code != 200:
                detail = r.read().decode("utf-8", "ignore")[:400]
                raise AgentError(f"OpenRouter error {r.status_code}: {detail}")
            for line in r.iter_lines():
                if not line or line.startswith(":"):
                    continue
                if line.startswith("data:"):
                    line = line[5:].strip()
                if line == "[DONE]":
                    break
                try:
                    chunk = json.loads(line)
                    delta = chunk["choices"][0].get("delta", {}) or {}
                except (json.JSONDecodeError, KeyError, IndexError):
                    continue
                piece = delta.get("content")
                if piece:
                    yield piece
    except httpx.HTTPError as e:
        raise AgentError(f"OpenRouter stream failed: {e}") from e


def stream_tokens(slug: str, history: list[dict]):
    """Yield raw content pieces of the analysis response as they arrive."""
    messages = [{"role": "system", "content": _system_for(slug)}] + history
    yield from _stream_openrouter(messages, max_tokens=16000)


def narrate(canonical_text: str) -> str:
    """Stage 2: faithfully adapt one canonical response into a TTS transcript. Uses the
    (separate, lighter) narration model with no paper context."""
    if not canonical_text.strip():
        return ""
    settings = config.load_settings()
    model = settings.get("narration_model") or settings.get("model")
    messages = [
        {"role": "system", "content": prompts.get("narration_system")},
        {"role": "user", "content": canonical_text},
    ]
    return _call_openrouter(messages, model=model, temperature=0.2).strip()
