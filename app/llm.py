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
from types import MappingProxyType

import httpx

from . import config, logging_config, operation_limits, spend_control, usage

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


# Which Settings control picks the model for a given `operation`, so the error can name the one
# the reader would actually change. Anything absent falls back to the plain analysis model, which
# is what these operations use.
_MODEL_SETTING_FOR = {
    "narration": "Narration model",
    "listening_preview": "Listening-preview model",
}


def _empty_response_message(finish_reason, usage: dict, operation: str = "llm") -> str:
    """Explain an empty completion in terms of something the reader can DO.

    The previous wording advised raising `max_tokens` or lowering the model's reasoning effort.
    Neither is reachable from the app: `max_tokens` is a hardcoded argument here, and reasoning
    effort is not a setting at all. A reader who hit this — as happened on production narration
    with a reasoning model on 2026-07-29 — was told to adjust two things that do not exist,
    while the one fix that works (choose a model that does not spend its whole budget thinking)
    went unmentioned.
    """
    setting = _MODEL_SETTING_FOR.get(operation, "Analysis model")
    reasoning_tokens = ((usage.get("completion_tokens_details") or {}).get("reasoning_tokens"))
    if reasoning_tokens:
        return (f"The model returned an empty response (finish_reason={finish_reason}) — it spent "
                f"{reasoning_tokens} tokens on hidden reasoning and had none left for the answer. "
                f"This model reasons too much for this job: choose a non-reasoning model under "
                f"“{setting}” in Settings.")
    if finish_reason == "length":
        return (f"The model returned an empty response (finish_reason={finish_reason}) — it ran "
                f"out of output tokens. Try again; if it keeps happening, pick a different model "
                f"under “{setting}” in Settings.")
    return (f"The model returned an empty response (finish_reason={finish_reason}). Try again, or "
            f"pick a different model under “{setting}” in Settings.")


# The routing constraint that makes the privacy policy true and avoids paying a random premium
# among the endpoints that satisfy it.
#
# Every request carries a paper's full text, the reader's questions, and their notes. Without a
# `provider` block OpenRouter may route that to ANY endpoint eligible to serve the model — the
# provider-like prefix in a model id ("anthropic/", "openai/") names the model's author, not the
# organisation that receives the payload. Measured 2026-07-28: `openai/gpt-5.6-sol` routed to
# OpenAI unconstrained and to Azure constrained, and `deepseek/deepseek-v4-pro` to StreamLake and
# SiliconFlow respectively. So an unconstrained request cannot honestly be described in a privacy
# policy at all.
#
# The first two keys are NOT the same guarantee and both are needed: `data_collection: "deny"`
# excludes providers that may store or train on inputs, while `zdr` requires zero retention at
# rest — a provider can satisfy one and fail the other (30-day logs, no training).
#
# `sort: "price"` does not relax that eligible set or pin a vendor. OpenRouter documents that it
# disables price-weighted load balancing and tries eligible endpoints in ascending price order,
# with normal fallbacks retained. That is the cost-safe default for long research prompts; an
# explicit provider allowlist would be a separate availability/quality decision.
#
# Deliberately not env-configurable. `/legal/privacy` states this as an unconditional promise, and
# a flag that relaxes it would make the published policy false on whichever deployment set it.
# Cost, measured across the twelve favourite families: eleven still resolve; only Qwen Max has no
# conforming endpoint, and it was dropped from the favourites for that reason.
#
# Read-only because this one object would otherwise be shared by reference into every request body
# and into `agent_harness`'s model settings. Nothing mutates it today; a mapping proxy means nothing
# can start to, quietly, and weaken the promise for every subsequent request in the process.
#
# Callers must go through `routing_payload()`. A mapping proxy is NOT JSON-serializable, so putting
# this object into a request body directly raises `TypeError: Object of type mappingproxy is not
# JSON serializable` — on every LLM call in the app. Verified before shipping the immutability.
#: Turn a model's hidden reasoning OFF for jobs that do not need it.
#:
#: Sent as a HINT, never as a requirement: OpenRouter documents models whose reasoning is
#: mandatory, and this repo has no verified evidence of how they answer a request that tries to
#: disable it. Since the model is a USER SETTING, we cannot know whether today's choice is one of
#: them — so `complete()` retries once without this key if a request is rejected in a way that
#: mentions reasoning. A best-effort saving must not be able to break narration outright.
#:
#: Why this exists: narration is a rewrite, not a problem to think about — take one finished
#: analysis and adapt it for the ear. But the default narration model is DeepSeek v4 Flash, a
#: reasoning model, and on 2026-07-30 it spent **8,848 tokens on hidden reasoning and emitted
#: nothing**, so the audio failed and the listener got silence after two cues. The diagnostic told
#: Kamil to pick a non-reasoning model, which is real advice but the wrong default: the app should
#: not ship a narration default that cannot narrate. Same reasoning for preview cues, which are one
#: or two sentences under a latency budget.
NO_REASONING = MappingProxyType({"enabled": False})

PRIVACY_ROUTING = MappingProxyType({
    "data_collection": "deny",
    "zdr": True,
    "sort": "price",
})


def routing_payload() -> dict:
    """A fresh, JSON-serializable copy of `PRIVACY_ROUTING` for one request body."""
    return dict(PRIVACY_ROUTING)


def no_reasoning_payload() -> dict:
    """A fresh, JSON-serializable copy of `NO_REASONING` for one request body."""
    return dict(NO_REASONING)


def _build_body(messages: list[dict], model: str | None, default_model: str | None,
                temperature: float, max_tokens: int, reasoning: dict | None,
                stream: bool) -> dict:
    body = {
        "model": model or default_model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "provider": routing_payload(),
        # Ask OpenRouter to return authoritative token counts + dollar cost in `usage` (for
        # streaming it arrives in a final usage-only chunk). See app/usage.py.
        "usage": {"include": True},
    }
    if reasoning is not None:
        body["reasoning"] = reasoning
    if stream:
        body["stream"] = True
    return body


def _is_data_policy_refusal(status: int, text: str) -> bool:
    """Did OpenRouter refuse because `PRIVACY_ROUTING` left no eligible endpoint?

    It answers 404 with "No endpoints found matching your data policy", which is indistinguishable
    by status from the unknown-model 404 — and telling a reader their model "doesn't exist" when it
    exists but has no zero-retention provider sends them to fix the wrong thing.

    Matches the response text; never echoes it. An upstream body can quote prompts or paper text,
    which is why neither this message nor the logs include it.
    """
    return status == 404 and "data policy" in text.lower()


def _friendly_http_error(status: int, model: str | None, *, data_policy: bool = False) -> str:
    """The user-facing message for an OpenRouter HTTP failure. Quota, key, and rate problems
    read in the app's voice with the action to take. Provider payloads are deliberately excluded
    from both this message and logs: an upstream error can echo prompts or paper text."""
    name = model or "the selected model"
    if data_policy:
        return (f"No provider for {name} meets this app's privacy requirement — that your paper "
                "text is never retained or trained on. Pick a different model in Settings.")
    if status == 401:
        return "OpenRouter rejected the API key. Check it in Settings."
    if status == 402:
        return ("Your OpenRouter account is out of credits, so this request was declined. "
                "Add credits at openrouter.ai, or switch to a cheaper model in Settings.")
    if status == 403:
        return (f"OpenRouter refused this request for {name} — the model may not be "
                "available to your account. Try another model.")
    if status == 404:
        return f"OpenRouter doesn't recognize {name}. Pick another model in Settings."
    if status == 429:
        return (f"{name} is rate-limited right now. Wait a moment and retry, or switch "
                "models in Settings.")
    if status >= 500:
        return (f"OpenRouter or the provider behind {name} is having trouble "
                f"(HTTP {status}). This is usually brief — retry shortly.")
    return f"OpenRouter declined the request (HTTP {status}). Try again or choose another model."


_TRANSPORT_FRIENDLY = "Could not reach OpenRouter. Check the connection and retry."


def _post_with_retry(body: dict, key: str, timeout: float, tries: int) -> dict:
    """POST the chat-completions body, retrying transient failures with backoff. Returns the
    parsed JSON response; raises LLMError once retries are exhausted or the error is fatal.
    Logs retain status/attempt/model diagnostics but never the provider response body."""
    last = "unknown error"
    friendly = _TRANSPORT_FRIENDLY
    attempts = 0
    for attempt in range(tries):
        if attempt:
            log.warning("openrouter retry %d/%d (model=%s): %s",
                        attempt + 1, tries, body.get("model"), last)
            time.sleep(_BACKOFF_BASE * attempt)
        attempts = attempt + 1
        try:
            spend_control.require_enabled()
            r = httpx.post(f"{config.OPENROUTER_BASE}/chat/completions",
                           headers=_headers(key), json=body, timeout=timeout)
        except spend_control.ProviderSpendDisabled as e:
            raise LLMError(str(e)) from e
        except httpx.HTTPError as e:
            last = f"transport={type(e).__name__}"
            friendly = _TRANSPORT_FRIENDLY
            continue  # transport-level: always worth a retry
        if r.status_code == 200:
            try:
                return r.json()
            except ValueError as e:
                log.error("openrouter returned invalid JSON (model=%s, HTTP 200)",
                          body.get("model"))
                raise LLMError("OpenRouter returned an invalid response. Retry shortly.") from e
        last = f"HTTP {r.status_code}"
        friendly = _friendly_http_error(
            r.status_code, body.get("model"),
            data_policy=_is_data_policy_refusal(r.status_code, r.text))
        if r.status_code not in _RETRY_STATUS:
            break  # fatal: don't count attempts we never made
    # `attempts` is what we actually tried (1 if the first HTTP response was fatal, `tries` if
    # exhausted). "first HTTP response" is deliberate wording: this has nothing to do with a
    # paper summary, and a find-and-replace over "first response" must not touch it.
    log.error("openrouter failed after %d attempt(s) (model=%s): %s",
              attempts, body.get("model"), last)
    raise LLMError(friendly)


def _rejected_for_reasoning(message: str) -> bool:
    """Whether a failure looks like the provider objecting to the `reasoning` field itself.

    Deliberately loose. The alternative is enumerating provider-specific wordings, which would go
    stale silently and leave narration broken for the exact users this is meant to help; a false
    positive only costs one extra request that was already failing.
    """
    lowered = message.lower()
    return "reasoning" in lowered and any(
        marker in lowered for marker in ("400", "422", "not support", "unsupported", "invalid",
                                         "required", "mandatory", "cannot be disabled")
    )


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
    # Clamped here rather than trusted from the caller: `max_tokens` is a per-call argument with a
    # permissive default, so a new call site inherits a budget nobody chose and an existing one can
    # be raised without review. One runaway completion costs real money in a single shot, long
    # before the monthly ledger notices.
    max_tokens = operation_limits.clamp_tokens(operation, max_tokens)
    timeout = operation_limits.clamp_timeout(operation, timeout)
    body = _build_body(messages, model, default_model, temperature, max_tokens, reasoning,
                       stream=False)
    try:
        data = _post_with_retry(body, key, timeout, tries)
    except LLMError as e:
        # Disabling reasoning is an optimization, not a requirement. A model whose reasoning is
        # mandatory may refuse the request outright, and that must not be how narration fails —
        # the whole point of sending it was to stop a reasoning model producing silence. Drop the
        # hint and try once more; if it fails again the error is genuinely about something else.
        if reasoning is None or not _rejected_for_reasoning(str(e)):
            raise
        log.info("retrying without the reasoning hint (model=%s)", body.get("model"))
        body.pop("reasoning", None)
        data = _post_with_retry(body, key, timeout, tries)
    usage.record(
        operation, body.get("model"), data.get("usage"), generation_id=data.get("id"),
    )  # any 200 was billed
    try:
        choice = data["choices"][0]
        message = choice.get("message", {}) or {}
    except (KeyError, IndexError, TypeError) as e:
        log.error("openrouter returned an unexpected response shape (model=%s)",
                  body.get("model"))
        raise LLMError("OpenRouter returned an unexpected response. Retry shortly.") from e
    content = _flatten_content(message.get("content"))
    if not content.strip() and not allow_empty:
        raise LLMError(_empty_response_message(
            choice.get("finish_reason"), data.get("usage") or {}, operation))
    return content


def _account_stream(operation: str, model: str | None, seen_usage: dict | None,
                    gen_id: str | None) -> None:
    """Account one accepted (200) streaming generation: exact usage if its final usage chunk
    arrived, else a pending record (billed, cost unknown, reconcilable by gen_id)."""
    if seen_usage is not None:
        usage.record(operation, model, seen_usage, generation_id=gen_id)
    else:
        usage.record_pending(operation, model, gen_id)


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
    # Same ceiling as the non-streaming path. A stream is if anything the more important of the
    # two to bound: it bills as it emits, so an oversized budget is spent before anything can
    # decide it was a mistake.
    max_tokens = operation_limits.clamp_tokens(operation, max_tokens)
    timeout = operation_limits.clamp_timeout(operation, timeout)
    body = _build_body(messages, model, default_model, temperature, max_tokens, reasoning,
                       stream=True)
    url = f"{config.OPENROUTER_BASE}/chat/completions"
    emitted = False
    last = "unknown error"
    friendly = _TRANSPORT_FRIENDLY
    attempts = 0
    for attempt in range(tries):
        if attempt:
            log.warning("openrouter stream retry %d/%d (model=%s): %s",
                        attempt + 1, tries, body.get("model"), last)
            time.sleep(_BACKOFF_BASE * attempt)
        attempts = attempt + 1
        seen_usage: dict | None = None
        gen_id: str | None = None
        got_200 = False
        try:
            spend_control.require_enabled()
            with httpx.stream("POST", url, headers=_headers(key), json=body,
                              timeout=timeout) as r:
                if r.status_code != 200:
                    last = f"HTTP {r.status_code}"
                    # `r.read()` because a streaming response has no body until it is pulled;
                    # without it the data-policy 404 would read as "model doesn't exist".
                    friendly = _friendly_http_error(
                        r.status_code, body.get("model"),
                        data_policy=_is_data_policy_refusal(r.status_code, r.read().decode(
                            "utf-8", "replace")))
                    if r.status_code in _RETRY_STATUS:
                        continue  # not billed — safe to retry, nothing to account
                    log.error("openrouter stream fatal (model=%s): %s", body.get("model"), last)
                    raise LLMError(friendly)
                got_200 = True
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
            _account_stream(operation, body.get("model"), seen_usage, gen_id)  # exact or pending
            return  # stream finished cleanly
        except spend_control.ProviderSpendDisabled as e:
            raise LLMError(str(e)) from e
        except httpx.HTTPError as e:
            last = f"transport={type(e).__name__}"
            friendly = _TRANSPORT_FRIENDLY
            # A 200 generation is billed the moment OpenRouter accepts it (it can spend on hidden
            # reasoning before any content), so account it even if it dropped before a token — as
            # exact usage if the final chunk arrived, else pending. A non-200 attempt wasn't billed.
            if got_200:
                _account_stream(operation, body.get("model"), seen_usage, gen_id)
            if emitted:  # mid-stream: a retry would duplicate text, so fail fast
                log.error("openrouter stream dropped after first token (model=%s): %s",
                          body.get("model"), last)
                raise LLMError("The connection dropped mid-response. Retry the turn.") from e
            continue  # transport failure before any content — retry a fresh generation
    log.error("openrouter stream failed after %d attempt(s) (model=%s): %s",
              attempts, body.get("model"), last)
    raise LLMError(friendly)


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
            msg = "Could not load the OpenRouter model catalogue. Retry shortly."
            if isinstance(e, httpx.HTTPStatusError) and e.response is not None:
                diagnostic = f"HTTP {e.response.status_code}"
            else:
                diagnostic = type(e).__name__
            with _catalogue_lock:
                _catalogue_cooldown_until = time.monotonic() + _CATALOGUE_ERROR_COOLDOWN
                _catalogue_last_error = msg
                have_stale = _catalogue_cache is not None
                stale_data = _catalogue_cache[1] if _catalogue_cache else None
            log.warning("catalogue refresh failed, serving %s (%s)",
                        "stale" if have_stale else "error", diagnostic)
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
