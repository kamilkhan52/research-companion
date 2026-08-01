"""The instance kill switch refuses at every provider-dispatch seam without making a request."""
from __future__ import annotations

import asyncio

import pytest
from app import (
    agent,
    agent_harness,
    llm,
    openalex,
    research_tools,
    semantic_scholar,
    spend_control,
    tts,
)


class NoDispatchClient:
    def __init__(self):
        self.calls = 0

    def get(self, *_args, **_kwargs):
        self.calls += 1
        raise AssertionError("provider GET must not be dispatched")

    def post(self, *_args, **_kwargs):
        self.calls += 1
        raise AssertionError("provider POST must not be dispatched")

    def close(self):
        pass


@pytest.mark.parametrize("value", ["1", "true", "YES", "on", "treu", "stop-now"])
def test_any_non_false_value_fails_toward_no_spend(monkeypatch, value):
    monkeypatch.setenv("RC_PROVIDER_SPEND_DISABLED", value)
    assert spend_control.disabled() is True
    with pytest.raises(spend_control.ProviderSpendDisabled, match="temporarily paused"):
        spend_control.require_enabled()


@pytest.mark.parametrize("value", [None, "", "0", "false", "NO", "off"])
def test_only_absent_or_explicit_false_values_allow_spend(monkeypatch, value):
    if value is None:
        monkeypatch.delenv("RC_PROVIDER_SPEND_DISABLED", raising=False)
    else:
        monkeypatch.setenv("RC_PROVIDER_SPEND_DISABLED", value)
    assert spend_control.disabled() is False
    spend_control.require_enabled()


def test_raw_and_agentic_openrouter_paths_refuse_before_dispatch(monkeypatch):
    monkeypatch.setenv("RC_PROVIDER_SPEND_DISABLED", "true")
    monkeypatch.setattr(
        llm.config,
        "load_settings",
        lambda: {"openrouter_api_key": "test-key", "model": "test/model"},
    )
    monkeypatch.setattr(
        llm.httpx,
        "post",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("OpenRouter must not be dispatched")
        ),
    )

    with pytest.raises(llm.LLMError, match="temporarily paused"):
        llm.complete([{"role": "user", "content": "hello"}], tries=1)
    with pytest.raises(llm.LLMError, match="temporarily paused"):
        list(llm.stream([{"role": "user", "content": "hello"}], tries=1))
    with pytest.raises(agent.AgentError, match="temporarily paused"):
        agent_harness._openrouter_model("test/model")

    # A model built while service was enabled still re-checks at EACH eventual dispatch. This is
    # the Pydantic tool-loop seam; checking construction alone would miss later requests/retries.
    monkeypatch.setenv("RC_PROVIDER_SPEND_DISABLED", "false")
    model = agent_harness._openrouter_model("test/model")
    monkeypatch.setenv("RC_PROVIDER_SPEND_DISABLED", "true")
    from pydantic_ai.models import ModelRequestParameters

    with pytest.raises(agent.AgentError, match="temporarily paused"):
        asyncio.run(model._completions_create([], False, {}, ModelRequestParameters()))


def test_openai_speech_refuses_without_recording_or_dispatching(monkeypatch):
    monkeypatch.setenv("RC_PROVIDER_SPEND_DISABLED", "true")
    monkeypatch.setattr(
        tts.config,
        "load_settings",
        lambda: {"openai_api_key": "test-key", "tts_model": "tts-1", "tts_voice": "alloy"},
    )
    recorded: list[tuple] = []
    monkeypatch.setattr(tts, "_record_dispatch", lambda *args, **kwargs: recorded.append(args))
    monkeypatch.setattr(
        tts.httpx,
        "post",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("OpenAI must not be dispatched")
        ),
    )

    with pytest.raises(tts.TTSError, match="temporarily paused"):
        tts.openai_speech("hello")
    assert recorded == []


def test_data_providers_refuse_or_degrade_before_dispatch(monkeypatch):
    monkeypatch.setenv("RC_PROVIDER_SPEND_DISABLED", "true")

    firecrawl = NoDispatchClient()
    monkeypatch.setattr(research_tools, "_firecrawl_key", lambda: "test-key")
    with pytest.raises(research_tools.ToolError, match="temporarily paused"):
        research_tools._firecrawl_search("topic", ["query"], client=firecrawl)
    assert firecrawl.calls == 0

    oa = NoDispatchClient()
    assert openalex.work_authorships("2401.00001", client=oa) is None
    assert oa.calls == 0

    # Production OpenAlex workflows share make_client (citations + all Discovery recall calls),
    # whose request hook is the final structural boundary for those direct call sites.
    openalex_client = openalex.make_client()
    try:
        with pytest.raises(spend_control.ProviderSpendDisabled, match="temporarily paused"):
            openalex_client.get("https://api.openalex.org/works/W1")
    finally:
        openalex_client.close()

    scholar = NoDispatchClient()
    with pytest.raises(spend_control.ProviderSpendDisabled, match="temporarily paused"):
        semantic_scholar.paced_request(
            lambda: scholar.get("/direct", params={}, headers={}),
            pacer=semantic_scholar.RequestPacer(interval=0),
        )
    with pytest.raises(semantic_scholar.SemanticScholarError, match="temporarily paused"):
        semantic_scholar.search_papers(
            "topic",
            key="",
            client=scholar,
            pacer=semantic_scholar.RequestPacer(interval=0),
        )
    assert scholar.calls == 0
