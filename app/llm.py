"""One OpenRouter client — the single seam for every raw-HTTP LLM call (improvements §1.3).

Before this module, OpenRouter was reached through four hand-rolled copies — the agent's
complete/stream pair, graph extraction, and discovery — that each re-derived the same auth
headers, the same "content may be a list of parts" flattening, the same empty-response
diagnostics, and their own error handling. None of them retried a transient 502/timeout, so a
single upstream blip killed a whole (paid, minutes-long) turn or graph build. This consolidates
the raw paths behind `complete()` / `stream()`, which own:

- auth headers + the app's OpenRouter identity, and the API key / default model from settings;
- **retry with backoff** on transient failures (connect/read errors, 429/5xx) so one blip is
  invisible instead of fatal — jobs made failures survivable; retries make many of them never
  happen;
- content-as-list flattening (some providers return `content` as a list of text parts);
- empty-response detection with a `finish_reason` / reasoning-token diagnostic (reasoning
  models can spend the entire token budget on hidden reasoning and emit nothing — see the
  EXTRACTION_MAX_TOKENS note in graph.py);
- normalization of every failure to one exception type, `LLMError`.

This is also the single place where per-call token usage / cost accounting will be recorded
(§3.3), and where a second provider would plug in. The Pydantic AI path in `agent_harness`
keeps its own framework client by design — this module owns only the raw-HTTP callers, which
each translate `LLMError` into their own domain error (AgentError / DiscoveryError / an error
dict) so the public error surface is unchanged.

The model catalogue (`catalogue()`) is TTL-cached here so `/api/models`,
`/api/favorite_models`, and `graph.resolve_model()` share one fetch instead of hitting
OpenRouter three separate times per interaction.
"""
from __future__ import annotations

import json
import threading
import time
from collections.abc import Iterator

import httpx

from . import config, logging_config, usage

log = logging_config.get("llm")


class LLMError(Exception):
    pass


# Per-attempt HTTP timeout. Note httpx's `timeout=N` is a per-phase budget, not a wall-clock
# cap — graph.py wraps its extraction call in a real deadline for exactly that reason.
DEFAULT_TIMEOUT = 300
STREAM_TIMEOUT = 300

# Transient statuses worth a retry (rate limits + upstream hiccups). A single blip on a paid,
# minutes-long call shouldn't scrap the whole thing.
_RETRY_STATUS = {429, 500, 502, 503, 504}
_DEFAULT_TRIES = 3           # 1 attempt + 2 retries
_BACKOFF_BASE = 2.0          # seconds; sleep before retry N is _BACKOFF_BASE * N


def _headers(key: str) -> dict:
    return {"Authorization": f"Bearer {key}", "HTTP-Referer": "http://localhost",
            "X-Title": config.APP_TITLE}


def _key_and_default_model() -> tuple[str, str | None]:
    settings = config.load_settings()
    key = settings.get("openrouter_api_key")
    if not key:
        raise LLMError("No OpenRouter API key set. Add it in Settings.")
    return key, settings.get("model")


def _flatten_content(content) -> str:
    """Some providers return `content` as a list of `{type, text}` parts; flatten to a string."""
    if isinstance(content, list):
        return "".join(p.get("text", "") for p in content if isinstance(p, dict))
    return content or ""


def _empty_response_message(finish_reason, usage: dict) -> str:
    reasoning_tokens = ((usage.get("completion_tokens_details") or {}).get("reasoning_tokens"))
    if reasoning_tokens:
        hint = (f" — it spent {reasoning_tokens} tokens on hidden reasoning before running out "
                "of output budget; raise max_tokens or lower the model's reasoning effort")
    elif finish_reason == "length":
        hint = " — it ran out of output tokens"
    else:
        hint = ""
    return (f"The model returned an empty response (finish_reason={finish_reason}){hint}. "
            "Try again, or pick a different model in Settings.")


def _build_body(messages: list[dict], model: str | None, default_model: str | None,
                temperature: float, max_tokens: int, reasoning: dict | None,
                stream: bool) -> dict:
    body = {
        "model": model or default_model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        # Ask OpenRouter to return authoritative token counts + dollar cost in `usage` (for
        # streaming it arrives in a final usage-only chunk). See app/usage.py.
        "usage": {"include": True},
    }
    if reasoning is not None:
        body["reasoning"] = reasoning
    if stream:
        body["stream"] = True
    return body


def _post_with_retry(body: dict, key: str, timeout: float, tries: int) -> dict:
    """POST the chat-completions body, retrying transient failures with backoff. Returns the
    parsed JSON response; raises LLMError once retries are exhausted or the error is fatal."""
    last = "unknown error"
    attempts = 0
    for attempt in range(tries):
        if attempt:
            log.warning("openrouter retry %d/%d (model=%s): %s",
                        attempt + 1, tries, body.get("model"), last)
            time.sleep(_BACKOFF_BASE * attempt)
        attempts = attempt + 1
        try:
            r = httpx.post(f"{config.OPENROUTER_BASE}/chat/completions",
                           headers=_headers(key), json=body, timeout=timeout)
        except httpx.HTTPError as e:
            last = f"OpenRouter request failed: {e}"
            continue  # transport-level: always worth a retry
        if r.status_code == 200:
            try:
                return r.json()
            except ValueError as e:
                raise LLMError(f"OpenRouter returned a non-JSON 200: {r.text[:400]}") from e
        last = f"OpenRouter error {r.status_code}: {r.text[:400]}"
        if r.status_code not in _RETRY_STATUS:
            break  # fatal: don't count attempts we never made
    # `attempts` is what we actually tried (1 for a fatal first response, `tries` if exhausted).
    log.error("openrouter failed after %d attempt(s) (model=%s): %s",
              attempts, body.get("model"), last)
    raise LLMError(last)


def complete(messages: list[dict], *, model: str | None = None, temperature: float = 0.3,
             max_tokens: int = 8000, reasoning: dict | None = None,
             timeout: float = DEFAULT_TIMEOUT, tries: int = _DEFAULT_TRIES,
             allow_empty: bool = False, operation: str = "llm") -> str:
    """One non-streaming chat completion, returning the model's content string. `model` falls
    back to the settings default. Retries transient failures. Records token/cost usage against
    the active project under `operation` (a billed response is recorded even when empty). Raises
    LLMError on transport / HTTP / malformed-response errors and (unless allow_empty) on an empty
    completion, with a diagnostic that surfaces reasoning-token exhaustion."""
    key, default_model = _key_and_default_model()
    body = _build_body(messages, model, default_model, temperature, max_tokens, reasoning,
                       stream=False)
    data = _post_with_retry(body, key, timeout, tries)
    usage.record(operation, body.get("model"), data.get("usage"))  # any 200 was billed
    try:
        choice = data["choices"][0]
        message = choice.get("message", {}) or {}
    except (KeyError, IndexError, TypeError) as e:
        raise LLMError(f"Unexpected OpenRouter response: {str(data)[:400]}") from e
    content = _flatten_content(message.get("content"))
    if not content.strip() and not allow_empty:
        raise LLMError(_empty_response_message(choice.get("finish_reason"), data.get("usage") or {}))
    return content


def stream(messages: list[dict], *, model: str | None = None, temperature: float = 0.3,
           max_tokens: int = 16000, reasoning: dict | None = None,
           timeout: float = STREAM_TIMEOUT, tries: int = _DEFAULT_TRIES,
           operation: str = "llm") -> Iterator[str]:
    """Yield content pieces of one streaming completion as they arrive. Retries transient
    failures (a retryable status or a transport error) with backoff **only until the first
    content token is emitted** — before any output, a failed attempt is safe to restart; once
    the client has seen a token, a reconnect would duplicate text, so from there it fails fast.
    Records token/cost usage (from the final usage chunk) against the active project under
    `operation` once the stream completes. Raises LLMError on a fatal status, an exhausted retry,
    or a post-first-token failure."""
    key, default_model = _key_and_default_model()
    body = _build_body(messages, model, default_model, temperature, max_tokens, reasoning,
                       stream=True)
    url = f"{config.OPENROUTER_BASE}/chat/completions"
    emitted = False
    last = "unknown error"
    attempts = 0
    for attempt in range(tries):
        if attempt:
            log.warning("openrouter stream retry %d/%d (model=%s): %s",
                        attempt + 1, tries, body.get("model"), last)
            time.sleep(_BACKOFF_BASE * attempt)
        attempts = attempt + 1
        seen_usage: dict | None = None
        gen_id: str | None = None
        try:
            with httpx.stream("POST", url, headers=_headers(key), json=body,
                              timeout=timeout) as r:
                if r.status_code != 200:
                    detail = r.read().decode("utf-8", "ignore")[:400]
                    last = f"OpenRouter error {r.status_code}: {detail}"
                    if r.status_code in _RETRY_STATUS:
                        continue  # nothing emitted yet — safe to retry
                    log.error("openrouter stream fatal (model=%s): %s", body.get("model"), last)
                    raise LLMError(last)
                gen_id = r.headers.get("x-generation-id") or None
                for line in r.iter_lines():
                    if not line or line.startswith(":"):
                        continue
                    if line.startswith("data:"):
                        line = line[5:].strip()
                    if line == "[DONE]":
                        break
                    try:
                        chunk = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    gen_id = chunk.get("id") or gen_id  # generation id, for later reconciliation
                    if chunk.get("usage"):  # final usage-only chunk (choices empty)
                        seen_usage = chunk["usage"]
                    choices = chunk.get("choices") or []
                    delta = choices[0].get("delta", {}) or {} if choices else {}
                    piece = delta.get("content")
                    if piece:
                        emitted = True
                        yield piece
            if seen_usage is not None:
                usage.record(operation, body.get("model"), seen_usage)
            elif emitted:
                # Clean EOF but no final usage chunk (proxy/provider truncation): content was
                # billed, cost unknown — record as pending so totals read as estimates, not a
                # silent zero-cost completed call.
                usage.record_pending(operation, body.get("model"), gen_id)
            return  # stream finished cleanly
        except httpx.HTTPError as e:
            last = f"OpenRouter stream failed: {e}"
            if emitted:  # mid-stream: a retry would duplicate text, so fail fast
                log.error("openrouter stream dropped after first token (model=%s): %s",
                          body.get("model"), last)
                # Billed upstream but no final usage chunk — flag it (with the generation id) so
                # totals are honest estimates and this can be reconciled later.
                usage.record_pending(operation, body.get("model"), gen_id)
                raise LLMError(last) from e
            continue  # transport failure before any content — retry
    log.error("openrouter stream failed after %d attempt(s) (model=%s): %s",
              attempts, body.get("model"), last)
    raise LLMError(last)


# ---------- model catalogue (TTL-cached; shared by three callers) ----------

_CATALOGUE_TTL = 300  # seconds
# After a failed refresh, don't re-hit upstream for this long: serve stale (or, cold, share the
# error) instead. This makes the FAILURE path single-flight too — without it, a wave of callers
# on a stale/cold cache would each acquire the fetch lock, still see an expired cache, and repeat
# the same failing request. Short relative to the TTL so recovery is quick once upstream is back.
_CATALOGUE_ERROR_COOLDOWN = 30  # seconds
_catalogue_lock = threading.Lock()          # guards the cache/cooldown state (never held over I/O)
_catalogue_fetch_lock = threading.Lock()    # single-flight: at most one refresh in flight at a time
_catalogue_cache: tuple[float, list[dict]] | None = None
_catalogue_cooldown_until: float = 0.0      # monotonic deadline; within it, skip the upstream fetch
_catalogue_last_error: str = ""             # error shared with waiters during a cold-cache cooldown


def _fresh(ttl: float) -> list[dict] | None:
    with _catalogue_lock:
        if _catalogue_cache and time.monotonic() - _catalogue_cache[0] < ttl:
            return _catalogue_cache[1]
    return None


def catalogue(*, timeout: float = 30, ttl: float = _CATALOGUE_TTL) -> list[dict]:
    """OpenRouter's public model catalogue (the raw `data` list of model dicts), TTL-cached so
    /api/models, /api/favorite_models, and graph.resolve_model() share one fetch. Refreshes are
    single-flight: simultaneous callers on a cold/stale cache serialize on a dedicated fetch lock
    (the cache lock is never held across network I/O), so exactly one OpenRouter request goes out
    and the rest consume its result. This holds on the FAILURE path too — a failed refresh starts
    a short cooldown during which waiters serve stale (or, cold, share the same error) instead of
    each repeating the failing request. If nothing is cached, raises LLMError."""
    global _catalogue_cache, _catalogue_cooldown_until, _catalogue_last_error
    cached = _fresh(ttl)
    if cached is not None:
        return cached
    with _catalogue_fetch_lock:
        # Re-check under the fetch lock: a caller just ahead of us may have refreshed the cache,
        # or failed and opened a cooldown we should honor rather than re-hitting upstream.
        cached = _fresh(ttl)
        if cached is not None:
            return cached
        with _catalogue_lock:
            in_cooldown = time.monotonic() < _catalogue_cooldown_until
            stale = _catalogue_cache[1] if _catalogue_cache else None
            last_error = _catalogue_last_error
        if in_cooldown:
            if stale is not None:
                return stale
            raise LLMError(last_error or "OpenRouter catalogue is unavailable.")
        try:
            r = httpx.get(f"{config.OPENROUTER_BASE}/models", timeout=timeout)
            r.raise_for_status()
            data = r.json().get("data", [])
        except (httpx.HTTPError, ValueError) as e:
            msg = f"Could not reach OpenRouter: {e}"
            with _catalogue_lock:
                _catalogue_cooldown_until = time.monotonic() + _CATALOGUE_ERROR_COOLDOWN
                _catalogue_last_error = msg
                have_stale = _catalogue_cache is not None
                stale_data = _catalogue_cache[1] if _catalogue_cache else None
            log.warning("catalogue refresh failed, serving %s: %s",
                        "stale" if have_stale else "error", e)
            if have_stale:
                return stale_data  # serve stale rather than fail the caller
            raise LLMError(msg) from e
        with _catalogue_lock:
            _catalogue_cache = (time.monotonic(), data)
            _catalogue_cooldown_until = 0.0
            _catalogue_last_error = ""
        return data


def newest_matching(inc: list[str], exc: list[str], *,
                    models: list[dict] | None = None) -> dict | None:
    """The newest catalogue model (by `created`) whose id contains every `inc` substring and no
    `exc` substring and starts with an alphanumeric (skipping aliases). None if nothing matches.
    Shared by the favorite-model families (main.py) and graph's extraction-model resolution;
    pass `models` to reuse an already-fetched catalogue for several families in a row."""
    models = catalogue() if models is None else models
    matches = [m for m in models if m.get("id") and m["id"][:1].isalnum()
               and all(s in m["id"].lower() for s in inc)
               and not any(s in m["id"].lower() for s in exc)]
    if not matches:
        return None
    return max(matches, key=lambda m: m.get("created", 0))


def _reset_catalogue_cache() -> None:
    """Test hook: drop the cached catalogue + any error cooldown so a test controls the next fetch."""
    global _catalogue_cache, _catalogue_cooldown_until, _catalogue_last_error
    with _catalogue_lock:
        _catalogue_cache = None
        _catalogue_cooldown_until = 0.0
        _catalogue_last_error = ""
