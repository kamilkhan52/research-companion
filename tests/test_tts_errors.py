"""U.22 — OpenAI speech failures surface in the app's voice (quota, key, rate), not as raw
provider payloads. No real httpx calls."""
from __future__ import annotations

import httpx
import pytest
from app import config, tts


class FakeResp:
    def __init__(self, status_code: int, text: str = "", content: bytes = b""):
        self.status_code = status_code
        self.text = text
        self.content = content


@pytest.fixture(autouse=True)
def _fast(monkeypatch):
    monkeypatch.setattr(tts.time, "sleep", lambda *_: None)
    monkeypatch.setattr(config, "load_settings", lambda: {"openai_api_key": "sk-test"})


def test_quota_exhaustion_reads_as_an_actionable_message(monkeypatch):
    raw = '{"error":{"type":"insufficient_quota","message":"You exceeded your current quota"}}'
    monkeypatch.setattr(httpx, "post", lambda *a, **k: FakeResp(429, text=raw))
    with pytest.raises(tts.TTSError) as err:
        tts.openai_speech("hello")
    msg = str(err.value)
    assert "quota" in msg and "platform.openai.com" in msg
    assert "exceeded your current quota" not in msg


def test_plain_rate_limit_suggests_retry(monkeypatch):
    monkeypatch.setattr(httpx, "post", lambda *a, **k: FakeResp(429, text='{"error":"rl"}'))
    with pytest.raises(tts.TTSError) as err:
        tts.openai_speech("hello")
    assert "rate-limiting" in str(err.value)


def test_bad_key_points_at_settings(monkeypatch):
    monkeypatch.setattr(httpx, "post", lambda *a, **k: FakeResp(401, text="no"))
    with pytest.raises(tts.TTSError) as err:
        tts.openai_speech("hello")
    assert "Settings" in str(err.value)


def test_unknown_status_excludes_provider_body(monkeypatch):
    secret = "PRIVATE_PAPER_TEXT_tts"
    monkeypatch.setattr(httpx, "post", lambda *a, **k: FakeResp(418, text=secret))
    with pytest.raises(tts.TTSError) as err:
        tts.openai_speech("hello")
    assert "418" in str(err.value)
    assert secret not in str(err.value)


def test_success_returns_audio_bytes(monkeypatch):
    monkeypatch.setattr(httpx, "post", lambda *a, **k: FakeResp(200, content=b"mp3!"))
    assert tts.openai_speech("hello") == b"mp3!"


def test_tts_1_records_exact_character_cost_per_dispatch(monkeypatch):
    recorded = []
    monkeypatch.setattr(tts.usage, "record",
                        lambda op, model, data, **_kwargs: recorded.append((op, model, data)))
    monkeypatch.setattr(httpx, "post", lambda *a, **k: FakeResp(200, content=b"mp3!"))

    tts.openai_speech("See arXiv")

    assert recorded == [(
        "speech_synthesis",
        "tts-1",
        {"cost": len("See archive") * 15 / 1_000_000},
    )]


def test_provider_rejection_is_not_charged_but_successful_retry_is(monkeypatch):
    recorded = []
    responses = iter([FakeResp(500), FakeResp(200, content=b"mp3!")])
    monkeypatch.setattr(tts.usage, "record",
                        lambda op, model, data, **_kwargs: recorded.append((op, model, data)))
    monkeypatch.setattr(httpx, "post", lambda *a, **k: next(responses))

    assert tts.openai_speech("hello") == b"mp3!"
    assert len(recorded) == 1
    assert all(item[2]["cost"] == pytest.approx(5 * 15 / 1_000_000) for item in recorded)


def test_returned_rate_limit_records_no_speech_spend(temp_project, monkeypatch):
    monkeypatch.setattr(httpx, "post", lambda *a, **k: FakeResp(429, text='{"error":"rl"}'))

    with pytest.raises(tts.TTSError):
        tts.openai_speech("hello")

    summary = tts.usage.summary()
    assert summary["total"]["calls"] == 0
    assert summary["pending_count"] == 0
    assert summary["estimated"] is False


def test_transport_ambiguity_is_charged_and_marked_estimated(temp_project, monkeypatch):
    responses = iter([httpx.ReadTimeout("late response"), FakeResp(200, content=b"mp3!")])

    def post(*_args, **_kwargs):
        result = next(responses)
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(httpx, "post", post)
    assert tts.openai_speech("hello") == b"mp3!"

    summary = tts.usage.summary()
    assert summary["by_operation"]["speech_synthesis"]["calls"] == 2
    assert summary["by_operation"]["speech_synthesis"]["cost_nanousd"] == 150_000
    assert summary["pending_count"] == 1
    assert summary["estimated"] is True


def test_transport_ambiguity_marks_the_usage_event_estimated(monkeypatch):
    seen = []
    monkeypatch.setattr(
        tts.usage,
        "record",
        lambda op, model, data, **kwargs: seen.append(kwargs),
    )
    monkeypatch.setattr(tts.usage, "record_pending", lambda *_args: None)
    tts._record_dispatch("tts-1", "hello", estimated=True)
    assert seen == [{"estimated": True}]


def test_unpriceable_speech_model_is_counted_and_marked_estimated(temp_project, monkeypatch):
    monkeypatch.setattr(
        config,
        "load_settings",
        lambda: {"openai_api_key": "sk-test", "tts_model": "gpt-4o-mini-tts"},
    )
    monkeypatch.setattr(httpx, "post", lambda *a, **k: FakeResp(200, content=b"mp3!"))

    assert tts.openai_speech("hello") == b"mp3!"
    summary = tts.usage.summary()
    assert summary["by_operation"]["speech_synthesis"]["calls"] == 1
    assert summary["by_operation"]["speech_synthesis"]["cost_nanousd"] == 0
    assert summary["pending_count"] == 1
    assert summary["estimated"] is True


def test_exact_speech_dispatch_leaves_ledger_unestimated(temp_project, monkeypatch):
    monkeypatch.setattr(httpx, "post", lambda *a, **k: FakeResp(200, content=b"mp3!"))

    assert tts.openai_speech("hello") == b"mp3!"
    summary = tts.usage.summary()
    assert summary["by_operation"]["speech_synthesis"]["calls"] == 1
    assert summary["by_operation"]["speech_synthesis"]["cost_nanousd"] == 75_000
    assert summary["pending_count"] == 0
    assert summary["estimated"] is False
