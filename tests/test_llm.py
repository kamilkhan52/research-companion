"""The shared OpenRouter client (app/llm.py): retry/backoff, content flattening, empty-response
diagnostics, error normalization, and the TTL-cached catalogue + family matcher. All network is
faked — no real httpx calls."""
import json
import logging
import threading
import time

import httpx
import pytest
from app import config, llm


@pytest.fixture
def rc_logs(caplog):
    """Capture rc.* records: force propagation on (configure() sets it off elsewhere in the
    suite) so caplog's root handler sees them, and restore afterwards."""
    rc = logging.getLogger("rc")
    prev = rc.propagate
    rc.propagate = True
    caplog.set_level(logging.WARNING, logger="rc")
    yield caplog
    rc.propagate = prev


def _llm_msgs(caplog):
    return [r.getMessage() for r in caplog.records if r.name == "rc.llm"]


class FakeResp:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}
        self.text = text

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("err", request=None, response=None)


def _one_choice(content, finish_reason="stop", usage=None):
    return {"choices": [{"message": {"content": content}, "finish_reason": finish_reason}],
            "usage": usage or {}}


@pytest.fixture
def key(monkeypatch):
    monkeypatch.setattr(config, "load_settings",
                        lambda: {"openrouter_api_key": "sk-test", "model": "default/model"})


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    monkeypatch.setattr(llm.time, "sleep", lambda *_: None)


@pytest.fixture(autouse=True)
def _fresh_catalogue():
    llm._reset_catalogue_cache()
    yield
    llm._reset_catalogue_cache()


# ---- complete ----

def test_complete_returns_content(key, monkeypatch):
    monkeypatch.setattr(httpx, "post", lambda *a, **k: FakeResp(200, _one_choice("hello")))
    assert llm.complete([{"role": "user", "content": "hi"}]) == "hello"


def test_complete_flattens_list_content(key, monkeypatch):
    parts = [{"type": "text", "text": "foo"}, {"type": "text", "text": "bar"}]
    monkeypatch.setattr(httpx, "post", lambda *a, **k: FakeResp(200, _one_choice(parts)))
    assert llm.complete([{"role": "user", "content": "hi"}]) == "foobar"


def test_complete_uses_default_model_when_none_given(key, monkeypatch):
    seen = {}

    def fake_post(url, headers=None, json=None, timeout=None):
        seen["model"] = json["model"]
        return FakeResp(200, _one_choice("ok"))

    monkeypatch.setattr(httpx, "post", fake_post)
    llm.complete([{"role": "user", "content": "hi"}])
    assert seen["model"] == "default/model"


def test_complete_empty_response_raises_with_reasoning_hint(key, monkeypatch):
    payload = _one_choice("", finish_reason="length",
                          usage={"completion_tokens_details": {"reasoning_tokens": 4096}})
    monkeypatch.setattr(httpx, "post", lambda *a, **k: FakeResp(200, payload))
    with pytest.raises(llm.LLMError) as ei:
        llm.complete([{"role": "user", "content": "hi"}])
    assert "4096 tokens on hidden reasoning" in str(ei.value)


def test_the_empty_response_advice_is_something_a_reader_can_actually_do(key, monkeypatch):
    """The message used to say "raise max_tokens or lower the model's reasoning effort".

    `max_tokens` is a hardcoded argument in this module and reasoning effort is not a setting at
    all, so both were instructions to adjust controls that do not exist. Asserting the new wording
    alone would not stop the old advice coming back alongside it, so this asserts the absence too.
    """
    payload = _one_choice("", finish_reason="length",
                          usage={"completion_tokens_details": {"reasoning_tokens": 8000}})
    monkeypatch.setattr(httpx, "post", lambda *a, **k: FakeResp(200, payload))
    with pytest.raises(llm.LLMError) as ei:
        llm.complete([{"role": "user", "content": "hi"}], operation="narration")
    msg = str(ei.value)

    assert "max_tokens" not in msg          # not reachable from the app
    assert "reasoning effort" not in msg    # not a setting either
    assert "Settings" in msg
    # And it must name the control that actually governs THIS call, not the analysis model.
    assert "Narration model" in msg


def test_the_empty_response_names_the_setting_for_the_operation_that_failed(key, monkeypatch):
    """One generic "pick a different model" sent readers to the wrong control: narration and the
    listening preview have their own model pickers, and changing the analysis model does nothing
    for either."""
    monkeypatch.setattr(httpx, "post", lambda *a, **k: FakeResp(200, _one_choice("")))
    cases = {"narration": "Narration model",
             "listening_preview": "Listening-preview model",
             "analysis": "Analysis model",
             "graph_extraction": "Analysis model"}   # unlisted operations use the analysis model
    for operation, expected in cases.items():
        with pytest.raises(llm.LLMError) as ei:
            llm.complete([{"role": "user", "content": "hi"}], operation=operation)
        assert expected in str(ei.value), f"{operation} should point at {expected!r}"


def test_complete_allow_empty_returns_empty_string(key, monkeypatch):
    monkeypatch.setattr(httpx, "post", lambda *a, **k: FakeResp(200, _one_choice("")))
    assert llm.complete([{"role": "user", "content": "hi"}], allow_empty=True) == ""


def test_complete_retries_transient_then_succeeds(key, monkeypatch):
    calls = {"n": 0}

    def flaky(*a, **k):
        calls["n"] += 1
        if calls["n"] < 3:
            return FakeResp(502, text="bad gateway")
        return FakeResp(200, _one_choice("recovered"))

    monkeypatch.setattr(httpx, "post", flaky)
    assert llm.complete([{"role": "user", "content": "hi"}]) == "recovered"
    assert calls["n"] == 3


def test_complete_does_not_retry_a_client_error(key, monkeypatch):
    calls = {"n": 0}

    def four_hundred(*a, **k):
        calls["n"] += 1
        return FakeResp(400, text="bad request")

    monkeypatch.setattr(httpx, "post", four_hundred)
    with pytest.raises(llm.LLMError):
        llm.complete([{"role": "user", "content": "hi"}])
    assert calls["n"] == 1  # 400 is fatal, not retried


def test_complete_retries_transport_error_then_gives_up(key, monkeypatch):
    calls = {"n": 0}

    def boom(*a, **k):
        calls["n"] += 1
        raise httpx.ConnectError("no route")

    monkeypatch.setattr(httpx, "post", boom)
    with pytest.raises(llm.LLMError):
        llm.complete([{"role": "user", "content": "hi"}], tries=3)
    assert calls["n"] == 3  # exhausted all attempts


def test_complete_without_key_raises(monkeypatch):
    monkeypatch.setattr(config, "load_settings", lambda: {"openrouter_api_key": ""})
    with pytest.raises(llm.LLMError):
        llm.complete([{"role": "user", "content": "hi"}])


# ---- catalogue + newest_matching ----

CATALOGUE = [
    {"id": "anthropic/claude-opus-4", "name": "Opus 4", "created": 100},
    {"id": "anthropic/claude-opus-4.1", "name": "Opus 4.1", "created": 200},
    {"id": "anthropic/claude-opus-4-fast", "name": "Opus Fast", "created": 300},
    {"id": "deepseek/deepseek-v4-pro", "name": "DS V4", "created": 150},
    {"id": "x-ai/grok-4.3", "name": "Grok 4.3", "created": 400},
    {"id": "x-ai/grok-4.5", "name": "Grok 4.5", "created": 500},
    {"id": "x-ai/grok-build-0.1", "name": "Grok Build", "created": 600},
]


def test_catalogue_is_ttl_cached(monkeypatch):
    calls = {"n": 0}

    def fake_get(*a, **k):
        calls["n"] += 1
        return FakeResp(200, {"data": CATALOGUE})

    monkeypatch.setattr(httpx, "get", fake_get)
    first = llm.catalogue()
    second = llm.catalogue()
    assert first == second == CATALOGUE
    assert calls["n"] == 1  # second call served from cache


def test_catalogue_serves_stale_on_failure(monkeypatch):
    monkeypatch.setattr(httpx, "get", lambda *a, **k: FakeResp(200, {"data": CATALOGUE}))
    llm.catalogue()  # populate cache

    def boom(*a, **k):
        raise httpx.ConnectError("down")

    monkeypatch.setattr(httpx, "get", boom)
    # ttl=0 forces a refetch attempt, which fails -> stale cache is served rather than raising
    assert llm.catalogue(ttl=0) == CATALOGUE


def test_catalogue_raises_when_nothing_cached(monkeypatch):
    monkeypatch.setattr(httpx, "get", lambda *a, **k: (_ for _ in ()).throw(httpx.ConnectError("x")))
    with pytest.raises(llm.LLMError):
        llm.catalogue()


def test_newest_matching_picks_latest_and_respects_exclusions(monkeypatch):
    monkeypatch.setattr(httpx, "get", lambda *a, **k: FakeResp(200, {"data": CATALOGUE}))
    best = llm.newest_matching(["anthropic/", "claude-opus"], ["fast"])
    assert best["id"] == "anthropic/claude-opus-4.1"  # newest non-fast opus


def test_newest_matching_skips_newer_specialized_model():
    best = llm.newest_matching(["x-ai/", "grok"], ["build"], models=CATALOGUE)
    assert best["id"] == "x-ai/grok-4.5"


def test_newest_matching_returns_none_when_no_match():
    assert llm.newest_matching(["nonexistent"], [], models=CATALOGUE) is None


# ---- stream ----

def _sse(content):
    return "data: " + json.dumps({"choices": [{"delta": {"content": content}}]})


_DONE = "data: [DONE]"


class FakeStream:
    """Context manager mimicking the object httpx.stream(...) returns."""

    def __init__(self, status_code=200, lines=None, body="", raise_at=None):
        self.status_code = status_code
        self._lines = lines or []
        self._body = body
        self._raise_at = raise_at  # int index, or "end", at which iter_lines drops the connection
        self.headers = {}

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return self._body.encode()

    def iter_lines(self):
        for i, ln in enumerate(self._lines):
            if self._raise_at == i:
                raise httpx.ReadError("connection dropped")
            yield ln
        if self._raise_at == "end":
            raise httpx.ReadError("connection dropped")


def _scripted(*responses):
    """A fake httpx.stream: returns/raises each scripted response in turn (last one repeats)."""
    state = {"n": 0}

    def fn(*a, **k):
        r = responses[min(state["n"], len(responses) - 1)]
        state["n"] += 1
        if isinstance(r, Exception):
            raise r
        return r

    fn.state = state
    return fn


def test_stream_yields_content(key, monkeypatch):
    monkeypatch.setattr(httpx, "stream",
                        _scripted(FakeStream(200, [_sse("hel"), _sse("lo"), _DONE])))
    assert list(llm.stream([{"role": "user", "content": "hi"}])) == ["hel", "lo"]


def test_stream_retries_initial_502_then_succeeds(key, monkeypatch):
    fn = _scripted(FakeStream(502, body="bad gateway"),
                   FakeStream(200, [_sse("ok"), _DONE]))
    monkeypatch.setattr(httpx, "stream", fn)
    assert list(llm.stream([{"role": "user", "content": "hi"}])) == ["ok"]
    assert fn.state["n"] == 2  # retried once after the 502


def test_stream_retries_connect_error_then_succeeds(key, monkeypatch):
    fn = _scripted(httpx.ConnectError("no route"),
                   FakeStream(200, [_sse("ok"), _DONE]))
    monkeypatch.setattr(httpx, "stream", fn)
    assert list(llm.stream([{"role": "user", "content": "hi"}])) == ["ok"]
    assert fn.state["n"] == 2


def test_stream_fatal_4xx_not_retried(key, monkeypatch):
    fn = _scripted(FakeStream(400, body="bad request"))
    monkeypatch.setattr(httpx, "stream", fn)
    with pytest.raises(llm.LLMError):
        list(llm.stream([{"role": "user", "content": "hi"}]))
    assert fn.state["n"] == 1  # 400 is fatal, not retried


def test_stream_mid_stream_failure_is_not_retried(key, monkeypatch):
    # A drop AFTER the first token must not restart the stream (that would duplicate text).
    fn = _scripted(FakeStream(200, [_sse("part1")], raise_at="end"),
                   FakeStream(200, [_sse("would-duplicate"), _DONE]))
    monkeypatch.setattr(httpx, "stream", fn)
    out = []
    with pytest.raises(llm.LLMError):
        for piece in llm.stream([{"role": "user", "content": "hi"}]):
            out.append(piece)
    assert out == ["part1"]     # got the first token
    assert fn.state["n"] == 1   # no retry once content had been emitted


def test_stream_exhausts_retries_and_raises(key, monkeypatch):
    fn = _scripted(FakeStream(503, body="unavailable"))
    monkeypatch.setattr(httpx, "stream", fn)
    with pytest.raises(llm.LLMError):
        list(llm.stream([{"role": "user", "content": "hi"}], tries=3))
    assert fn.state["n"] == 3  # all attempts used


# ---- LLM-layer logging (retries + failures are visible, for streaming too) ----

def test_stream_logs_retry_before_recovery(key, monkeypatch, rc_logs):
    monkeypatch.setattr(httpx, "stream",
                        _scripted(FakeStream(502, body="bad"), FakeStream(200, [_sse("ok"), _DONE])))
    list(llm.stream([{"role": "user", "content": "hi"}]))
    assert any("stream retry" in m for m in _llm_msgs(rc_logs))


def test_stream_logs_exhaustion_with_actual_attempts(key, monkeypatch, rc_logs):
    monkeypatch.setattr(httpx, "stream", _scripted(FakeStream(503, body="down")))
    with pytest.raises(llm.LLMError):
        list(llm.stream([{"role": "user", "content": "hi"}], tries=2))
    assert any("stream failed after 2 attempt" in m for m in _llm_msgs(rc_logs))


def test_stream_logs_fatal_status(key, monkeypatch, rc_logs):
    monkeypatch.setattr(httpx, "stream", _scripted(FakeStream(400, body="bad request")))
    with pytest.raises(llm.LLMError):
        list(llm.stream([{"role": "user", "content": "hi"}]))
    assert any("stream fatal" in m for m in _llm_msgs(rc_logs))


def test_stream_logs_mid_stream_drop(key, monkeypatch, rc_logs):
    monkeypatch.setattr(httpx, "stream",
                        _scripted(FakeStream(200, [_sse("part1")], raise_at="end")))
    with pytest.raises(llm.LLMError):
        list(llm.stream([{"role": "user", "content": "hi"}]))
    assert any("dropped after first token" in m for m in _llm_msgs(rc_logs))


def test_complete_logs_actual_attempts_on_fatal(key, monkeypatch, rc_logs):
    monkeypatch.setattr(httpx, "post", lambda *a, **k: FakeResp(400, text="bad request"))
    with pytest.raises(llm.LLMError):
        llm.complete([{"role": "user", "content": "hi"}])
    # a non-retryable 400 breaks after ONE attempt — the log must say so, not "after 3"
    assert any("failed after 1 attempt" in m for m in _llm_msgs(rc_logs))


def test_complete_logs_exhausted_attempts(key, monkeypatch, rc_logs):
    monkeypatch.setattr(httpx, "post", lambda *a, **k: FakeResp(503, text="down"))
    with pytest.raises(llm.LLMError):
        llm.complete([{"role": "user", "content": "hi"}], tries=3)
    assert any("failed after 3 attempt" in m for m in _llm_msgs(rc_logs))


# ---- catalogue single-flight ----

def test_catalogue_is_single_flight_under_concurrency(monkeypatch):
    calls = {"n": 0}

    def slow_get(*a, **k):
        calls["n"] += 1
        time.sleep(0.05)  # widen the window so threads genuinely overlap
        return FakeResp(200, {"data": CATALOGUE})

    monkeypatch.setattr(httpx, "get", slow_get)
    results, lock = [], threading.Lock()

    def worker():
        r = llm.catalogue()
        with lock:
            results.append(r)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert calls["n"] == 1                       # exactly one upstream fetch for 8 callers
    assert len(results) == 8
    assert all(r == CATALOGUE for r in results)  # everyone got the same catalogue


def _counting_failing_get(calls, lock):
    def fn(*a, **k):
        with lock:
            calls["n"] += 1
        time.sleep(0.03)  # widen the window so the wave genuinely overlaps
        raise httpx.ConnectError("upstream down")
    return fn


def test_catalogue_stale_failure_is_single_flight(monkeypatch):
    # Populate a cache, then have every refresh fail. A wave of callers that all see the cache as
    # stale must produce ONE upstream attempt (not one per caller) and all be served the stale copy.
    monkeypatch.setattr(httpx, "get", lambda *a, **k: FakeResp(200, {"data": CATALOGUE}))
    llm.catalogue()

    calls = {"n": 0}
    monkeypatch.setattr(httpx, "get", _counting_failing_get(calls, threading.Lock()))
    results, rlock = [], threading.Lock()

    def worker():
        r = llm.catalogue(ttl=0)  # ttl=0 forces the cache to be treated as stale
        with rlock:
            results.append(r)

    threads = [threading.Thread(target=worker) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert calls["n"] == 1                       # one shared upstream attempt for the whole wave
    assert len(results) == 6
    assert all(r == CATALOGUE for r in results)  # all six served the stale catalogue


def test_catalogue_cold_failure_is_single_flight(monkeypatch):
    # Cold cache + every refresh fails: one shared upstream attempt, and all callers get the same
    # error outcome rather than each hammering upstream.
    calls = {"n": 0}
    monkeypatch.setattr(httpx, "get", _counting_failing_get(calls, threading.Lock()))
    errors, elock = [], threading.Lock()

    def worker():
        try:
            llm.catalogue()
        except llm.LLMError as e:
            with elock:
                errors.append(e)

    threads = [threading.Thread(target=worker) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert calls["n"] == 1     # one shared upstream attempt for the whole wave
    assert len(errors) == 6    # every caller received the shared error outcome


# ---- U.22: provider failures surface in the app's voice; raw payloads stay private ----

def test_out_of_credits_reads_as_an_actionable_message(key, monkeypatch, rc_logs):
    raw = '{"error":{"message":"Insufficient credits","code":402}}'
    monkeypatch.setattr(httpx, "post", lambda *a, **k: FakeResp(402, text=raw))
    with pytest.raises(llm.LLMError) as err:
        llm.complete([{"role": "user", "content": "hi"}])
    msg = str(err.value)
    assert "credits" in msg and "openrouter.ai" in msg
    assert "Insufficient credits" not in msg
    assert all("Insufficient credits" not in m for m in _llm_msgs(rc_logs))


def test_bad_key_message_points_at_settings(key, monkeypatch):
    monkeypatch.setattr(httpx, "post", lambda *a, **k: FakeResp(401, text='{"error":"bad key"}'))
    with pytest.raises(llm.LLMError) as err:
        llm.complete([{"role": "user", "content": "hi"}])
    assert "API key" in str(err.value) and "Settings" in str(err.value)


def test_rate_limit_exhausted_names_the_model(key, monkeypatch):
    monkeypatch.setattr(httpx, "post", lambda *a, **k: FakeResp(429, text="slow down"))
    with pytest.raises(llm.LLMError) as err:
        llm.complete([{"role": "user", "content": "hi"}], model="some/model", tries=2)
    assert "rate-limited" in str(err.value)
    assert "some/model" in str(err.value)


def test_provider_5xx_reads_as_transient(key, monkeypatch):
    monkeypatch.setattr(httpx, "post", lambda *a, **k: FakeResp(503, text="upstream sad"))
    with pytest.raises(llm.LLMError) as err:
        llm.complete([{"role": "user", "content": "hi"}], tries=2)
    assert "retry shortly" in str(err.value).lower()


def test_unrecognized_status_keeps_status_but_not_raw_body(key, monkeypatch, rc_logs):
    secret = "PRIVATE_PROMPT_ECHO_teapot"
    monkeypatch.setattr(httpx, "post", lambda *a, **k: FakeResp(418, text=secret))
    with pytest.raises(llm.LLMError) as err:
        llm.complete([{"role": "user", "content": "hi"}])
    assert "418" in str(err.value)
    assert secret not in str(err.value)
    assert all(secret not in m for m in _llm_msgs(rc_logs))


def test_retryable_http_body_never_reaches_logs(key, monkeypatch, rc_logs):
    secret = "PRIVATE_PROMPT_ECHO_retry"
    monkeypatch.setattr(httpx, "post", lambda *a, **k: FakeResp(503, text=secret))
    with pytest.raises(llm.LLMError) as err:
        llm.complete([{"role": "user", "content": "hi"}], tries=2)
    assert secret not in str(err.value)
    assert all(secret not in m for m in _llm_msgs(rc_logs))


def test_stream_http_body_never_reaches_logs(key, monkeypatch, rc_logs):
    secret = "PRIVATE_PAPER_TEXT_stream"
    monkeypatch.setattr(httpx, "stream", _scripted(FakeStream(503, body=secret)))
    with pytest.raises(llm.LLMError) as err:
        list(llm.stream([{"role": "user", "content": "hi"}], tries=2))
    assert secret not in str(err.value)
    assert all(secret not in m for m in _llm_msgs(rc_logs))


def test_non_json_success_body_never_reaches_errors_or_logs(key, monkeypatch, rc_logs):
    secret = "PRIVATE_PAPER_TEXT_non_json"

    class InvalidJsonResp(FakeResp):
        def json(self):
            raise ValueError("not json")

    monkeypatch.setattr(httpx, "post", lambda *a, **k: InvalidJsonResp(200, text=secret))
    with pytest.raises(llm.LLMError) as err:
        llm.complete([{"role": "user", "content": "hi"}])
    assert secret not in str(err.value)
    assert all(secret not in m for m in _llm_msgs(rc_logs))


def test_unexpected_response_shape_never_reaches_errors_or_logs(key, monkeypatch, rc_logs):
    secret = "PRIVATE_PAPER_TEXT_shape"
    monkeypatch.setattr(
        httpx, "post", lambda *a, **k: FakeResp(200, {"provider_echo": secret}))
    with pytest.raises(llm.LLMError) as err:
        llm.complete([{"role": "user", "content": "hi"}])
    assert secret not in str(err.value)
    assert all(secret not in m for m in _llm_msgs(rc_logs))
