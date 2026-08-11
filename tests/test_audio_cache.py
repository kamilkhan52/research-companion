from __future__ import annotations

import os
from pathlib import Path

from app import audio_cache, config


def _name(number: int) -> str:
    return f"{number:040x}.mp3"


def _write(directory: Path, number: int, size: int, mtime_ns: int) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / _name(number)
    path.write_bytes(b"x" * size)
    os.utime(path, ns=(mtime_ns, mtime_ns))
    return path


def _limits(monkeypatch, *, per_user: int, total: int) -> None:
    monkeypatch.setenv("RC_AUDIO_CACHE_PER_USER_BYTES", str(per_user))
    monkeypatch.setenv("RC_AUDIO_CACHE_TOTAL_BYTES", str(total))


def test_per_user_lru_bound_counts_reads_as_recent(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "APP_STATE_DIR", tmp_path)
    _limits(monkeypatch, per_user=8, total=100)
    directory = tmp_path / "users" / "alice" / "audio"
    read_again = _write(directory, 1, 4, 1)
    next_oldest = _write(directory, 2, 4, 2)
    newest = _write(directory, 3, 4, 3)

    assert audio_cache.touch(read_again)
    audio_cache.enforce(directory, tmp_path / "audio")

    assert read_again.exists()
    assert not next_oldest.exists()
    assert newest.exists()
    assert sum(path.stat().st_size for path in directory.iterdir()) <= 8


def test_instance_bound_evicts_across_user_directories(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "APP_STATE_DIR", tmp_path)
    _limits(monkeypatch, per_user=100, total=8)
    alice = tmp_path / "users" / "alice" / "audio"
    bob = tmp_path / "users" / "bob" / "audio"
    oldest = _write(alice, 1, 5, 1)
    newest = _write(bob, 2, 5, 2)

    audio_cache.enforce(bob, tmp_path / "audio")

    assert not oldest.exists()
    assert newest.exists()


def test_protected_file_survives_concurrent_eviction(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "APP_STATE_DIR", tmp_path)
    _limits(monkeypatch, per_user=4, total=4)
    directory = tmp_path / "users" / "alice" / "audio"
    active = _write(directory, 1, 5, 1)
    expendable = _write(directory, 2, 5, 2)

    with audio_cache.protected([active]):
        audio_cache.enforce(directory, tmp_path / "audio")
        assert active.exists()
        assert not expendable.exists()

    audio_cache.enforce(directory, tmp_path / "audio")
    assert not active.exists()


def test_eviction_never_follows_or_removes_symlinks(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "APP_STATE_DIR", tmp_path)
    _limits(monkeypatch, per_user=1, total=1)
    directory = tmp_path / "users" / "alice" / "audio"
    regular = _write(directory, 1, 5, 1)
    outside = tmp_path / "outside.mp3"
    outside.write_bytes(b"private")
    link = directory / _name(2)
    link.symlink_to(outside)

    audio_cache.enforce(directory, tmp_path / "audio")

    assert not regular.exists()
    assert link.is_symlink()
    assert outside.read_bytes() == b"private"


def test_eviction_never_enters_a_symlinked_users_root(tmp_path, monkeypatch):
    app_state = tmp_path / "app-state"
    outside = tmp_path / "outside"
    app_state.mkdir()
    (app_state / "users").symlink_to(outside)
    monkeypatch.setattr(config, "APP_STATE_DIR", app_state)
    _limits(monkeypatch, per_user=1, total=1)
    target = _write(outside / "alice" / "audio", 1, 5, 1)

    audio_cache.enforce(app_state / "audio", app_state / "audio")

    assert target.read_bytes() == b"xxxxx"


def test_invalid_limits_keep_finite_defaults(monkeypatch):
    monkeypatch.setenv("RC_AUDIO_CACHE_PER_USER_BYTES", "not-a-number")
    monkeypatch.setenv("RC_AUDIO_CACHE_TOTAL_BYTES", "0")
    assert audio_cache.per_user_limit() == audio_cache.DEFAULT_PER_USER_BYTES
    assert audio_cache.total_limit() == audio_cache.DEFAULT_TOTAL_BYTES


def test_a_retired_tts_model_shares_the_live_models_cache_bucket(monkeypatch):
    """DR-042: a persisted tts-1-hd setting synthesizes tts-1 audio, so its cache key must be
    the tts-1 key — a raw-setting key kept a second namespace of identical, twice-billed
    audio."""
    from app import audio_jobs, config

    monkeypatch.setattr(config, "load_settings",
                        lambda: {"speech_provider": "openai", "tts_model": "tts-1-hd",
                                 "tts_voice": "alloy"})
    retired = audio_jobs._voice_key()
    monkeypatch.setattr(config, "load_settings",
                        lambda: {"speech_provider": "openai", "tts_model": "tts-1",
                                 "tts_voice": "alloy"})
    assert retired == audio_jobs._voice_key()
