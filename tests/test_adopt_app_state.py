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


def test_an_uppercase_uuid_lands_where_the_app_will_look(flat_state):
    """`db.is_uuid` accepts either case but a hash does not, so an uppercase argument would move
    the cache under a directory the running app — which sees Supabase's lowercase `sub` — never
    looks in. The script would report success and the user would open an empty cache: exactly the
    failure it exists to prevent, now wearing a disguise."""
    from app import audio_jobs

    assert adopt.main([ALICE.upper(), "--apply"]) == 0
    token = config.set_active_user(ALICE)
    try:
        assert (audio_jobs.user_audio_dir() / "aaa.mp3").exists()
    finally:
        config.reset_active_user(token)


def test_the_scope_is_the_same_directory_whatever_the_case(flat_state):
    assert _scope_for(ALICE) == _scope_for(ALICE.upper())


def test_a_symlinked_cache_is_refused_rather_than_re_pointed(flat_state, tmp_path, capsys):
    """A 2.8 GB cache is exactly the thing someone symlinks onto another disk. Relocating the link
    several directories deeper re-points a relative target — at best somewhere else, at worst
    nowhere — and the original path is gone."""
    elsewhere = tmp_path.parent / "elsewhere-audio"
    elsewhere.mkdir()
    (elsewhere / "bbb.mp3").write_bytes(b"mp3-b")
    real = flat_state / "audio"
    for child in real.iterdir():
        child.unlink()
    real.rmdir()
    real.symlink_to(elsewhere)

    assert adopt.main([ALICE, "--apply"]) == 1
    assert "symlink" in capsys.readouterr().err
    assert real.is_symlink()          # untouched
    assert (elsewhere / "bbb.mp3").exists()


def test_a_destination_appearing_mid_run_is_never_nested_or_clobbered(flat_state, monkeypatch):
    """`shutil.move` into an existing directory nests the source inside it — `audio/audio` — and
    reports success, which is the worst outcome available: the migration claims to have worked and
    the cache is invisible. A signed-in server still running can create that directory between the
    check and the move."""
    scope = _scope_for(ALICE)
    real_rename = adopt.os.rename
    calls = {"n": 0}

    def _rename_after_someone_else_got_there(src, dst):
        calls["n"] += 1
        if calls["n"] == 1:
            # Simulate the running app creating the destination in the window.
            (scope / "audio").mkdir(parents=True, exist_ok=True)
            (scope / "audio" / "live.mp3").write_bytes(b"written by the server")
        return real_rename(src, dst)

    monkeypatch.setattr(adopt.os, "rename", _rename_after_someone_else_got_there)
    assert adopt.main([ALICE, "--apply"]) == 1   # reported, not a traceback

    # This test drives the race through `os.rename`. If the script switched to something else
    # (`shutil.move`, which NESTS instead of refusing), the hook would never fire and everything
    # below would pass without exercising anything. Fail loudly rather than go quiet.
    assert calls["n"] > 0, "the script no longer routes through os.rename; this test went vacuous"

    # The legacy cache must not be nested inside the live one, and the live file must survive.
    assert not (scope / "audio" / "audio").exists()
    assert (scope / "audio" / "live.mp3").read_bytes() == b"written by the server"
    # ...and the source is still there to retry from, rather than half gone.
    assert (flat_state / "audio" / "aaa.mp3").exists()


def test_a_partial_move_says_which_half_moved(flat_state, monkeypatch, capsys):
    """Two things move; if the second fails the operator has to know the first already went, or
    re-running looks like it did nothing and the state looks corrupt."""
    real_rename = adopt.os.rename
    calls = {"n": 0}

    def _fail_the_second(src, dst):
        calls["n"] += 1
        if calls["n"] == 2:
            raise OSError(66, "Directory not empty")
        return real_rename(src, dst)

    monkeypatch.setattr(adopt.os, "rename", _fail_the_second)
    assert adopt.main([ALICE, "--apply"]) == 1
    assert calls["n"] > 0, "the script no longer routes through os.rename; this test went vacuous"
    err = capsys.readouterr().err
    assert "already moved" in err
    assert "audio" in err


def test_a_dangling_symlink_is_reported_not_skipped(flat_state, capsys):
    """`Path.exists()` follows symlinks, so a cache symlinked onto a disk that is not mounted looks
    ABSENT — it would drop out of the plan before the symlink refusal ran, and the script would
    report "nothing to move" while the real cache sat unmigrated. Silence is the worst answer here:
    the operator would sign in, find an empty cache, and have no reason to suspect the migration."""
    real = flat_state / "audio"
    for child in real.iterdir():
        child.unlink()
    real.rmdir()
    real.symlink_to(flat_state / "a-disk-that-is-not-mounted")

    assert adopt.main([ALICE, "--apply"]) == 1
    err = capsys.readouterr().err
    assert "symlink" in err
    assert real.is_symlink()   # untouched


def test_a_dangling_symlink_is_not_silently_reported_as_nothing_to_move(flat_state, capsys):
    (flat_state / "narration-cache.json").unlink()
    real = flat_state / "audio"
    for child in real.iterdir():
        child.unlink()
    real.rmdir()
    real.symlink_to(flat_state / "a-disk-that-is-not-mounted")

    assert adopt.main([ALICE, "--apply"]) == 1
    out = capsys.readouterr()
    assert "nothing to move" not in out.out


def test_a_dangling_destination_symlink_is_refused_not_replaced(flat_state, capsys):
    """The same defect as the source check, one round later and on the other side. A DESTINATION
    that is a dangling symlink reads as absent to `exists()`, so the refusal misses it and
    `os.rename` replaces the link — orphaning whatever the signed-in user had pointed it at, while
    the migration reports success."""
    scope = _scope_for(ALICE)
    scope.mkdir(parents=True, exist_ok=True)
    (scope / "narration-cache.json").symlink_to(scope / "on-an-unmounted-disk.json")

    assert adopt.main([ALICE, "--apply"]) == 1
    assert "REFUSING" in capsys.readouterr().err
    # The user's pointer survives, and the source is still there to retry from.
    assert (scope / "narration-cache.json").is_symlink()
    assert (flat_state / "narration-cache.json").exists()
