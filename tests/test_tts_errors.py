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
