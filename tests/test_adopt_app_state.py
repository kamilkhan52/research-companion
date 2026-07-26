"""Carrying a single-tenant instance's caches over to a signed-in user.

The failure this guards against is silent and expensive: an instance that has been running open-auth
has its whole narration/mp3 cache under the flat path, and the first signed-in user resolves to an
empty directory. Correct isolation, ~$70 of re-synthesis on the dev instance alone.
"""
from __future__ import annotations

import importlib

import pytest
from app import config

adopt = importlib.import_module("scripts.adopt_app_state")

ALICE = "f4a33e1b-b3c4-4eb2-a0ea-d110b36a072e"


@pytest.fixture
def flat_state(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "APP_STATE_DIR", tmp_path)
    (tmp_path / "audio").mkdir()
    (tmp_path / "audio" / "aaa.mp3").write_bytes(b"mp3-a")
    (tmp_path / "narration-cache.json").write_text('{"k": "v"}')
    yield tmp_path
    config.set_active_user(None)


def _scope_for(user_id: str):
    token = config.set_active_user(user_id)
    try:
        return config.user_scope_dir()
    finally:
        config.reset_active_user(token)


def test_a_dry_run_moves_nothing(flat_state, capsys):
    assert adopt.main([ALICE]) == 0
    assert (flat_state / "audio" / "aaa.mp3").exists()
    assert "dry run" in capsys.readouterr().out


def test_applying_puts_the_cache_where_the_signed_in_user_will_look(flat_state):
    assert adopt.main([ALICE, "--apply"]) == 0

    scope = _scope_for(ALICE)
    assert (scope / "audio" / "aaa.mp3").read_bytes() == b"mp3-a"
    assert (scope / "narration-cache.json").exists()
    # Moved, not copied: 2.8 GB duplicated on the volume holding the projects is not a no-op.
    assert not (flat_state / "audio").exists()


def test_the_app_agrees_with_where_the_script_put_it(flat_state):
    """The property that actually matters, and the one a reimplemented hash would break silently:
    the running app must resolve to the same directory the script wrote."""
    from app import audio_jobs, sessions

    adopt.main([ALICE, "--apply"])
    token = config.set_active_user(ALICE)
    try:
        assert (audio_jobs.user_audio_dir() / "aaa.mp3").exists()
        assert sessions._narration_cache_file().exists()
    finally:
        config.reset_active_user(token)


def test_it_refuses_rather_than_merging_two_caches(flat_state, capsys):
    scope = _scope_for(ALICE)
    (scope / "audio").mkdir(parents=True)
    (scope / "audio" / "existing.mp3").write_bytes(b"already here")

    assert adopt.main([ALICE, "--apply"]) == 1
    assert "REFUSING" in capsys.readouterr().err
    # Both sides untouched — a refusal that half-moved would be worse than either outcome.
    assert (flat_state / "audio" / "aaa.mp3").exists()
    assert (scope / "audio" / "existing.mp3").exists()


@pytest.mark.parametrize("bad", ["", "../../etc", "not-a-uuid", "alice@example.com"])
def test_a_value_that_would_become_a_directory_name_is_validated(flat_state, bad):
    assert adopt.main([bad, "--apply"]) == 2
    assert (flat_state / "audio" / "aaa.mp3").exists()


def test_nothing_to_move_is_not_an_error(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(config, "APP_STATE_DIR", tmp_path)
    assert adopt.main([ALICE, "--apply"]) == 0
    assert "nothing to move" in capsys.readouterr().out
