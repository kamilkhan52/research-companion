"""The shared OpenRouter client (app/llm.py): retry/backoff, content flattening, empty-response
diagnostics, error normalization, and the TTL-cached catalogue + family matcher. All network is
faked — no real httpx calls."""
import httpx
import pytest
from app import config, llm


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


def test_newest_matching_returns_none_when_no_match():
    assert llm.newest_matching(["nonexistent"], [], models=CATALOGUE) is None
