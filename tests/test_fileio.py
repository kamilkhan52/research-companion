"""Atomic write helper: replace-in-place semantics, explicit permissions, no torn writes."""
from __future__ import annotations

import os

import pytest
from app.fileio import atomic_write_bytes, atomic_write_text


def test_write_text_roundtrip_and_default_mode(tmp_path):
    p = tmp_path / "sub" / "dir" / "file.txt"  # parents created on demand
    atomic_write_text(p, "hello")
    assert p.read_text() == "hello"
    assert (p.stat().st_mode & 0o777) == 0o644


def test_overwrite_replaces_contents(tmp_path):
    p = tmp_path / "f.json"
    atomic_write_text(p, "old")
    atomic_write_text(p, "new")
    assert p.read_text() == "new"


def test_secret_mode_is_owner_only(tmp_path):
    p = tmp_path / "settings.json"
    atomic_write_text(p, "{}", mode=0o600)
    assert (p.stat().st_mode & 0o777) == 0o600


def test_write_bytes(tmp_path):
    p = tmp_path / "a.mp3"
    atomic_write_bytes(p, b"\x00\x01\x02")
    assert p.read_bytes() == b"\x00\x01\x02"


def test_no_temp_files_left_behind(tmp_path):
    p = tmp_path / "f.txt"
    atomic_write_text(p, "x")
    # Only the target remains — the temp file was renamed, not left as clutter.
    assert [f.name for f in tmp_path.iterdir()] == ["f.txt"]


def test_failed_write_does_not_clobber_existing(tmp_path, monkeypatch):
    p = tmp_path / "f.txt"
    atomic_write_text(p, "original")

    real_replace = os.replace

    def boom(src, dst):
        raise OSError("simulated failure before rename completes")

    monkeypatch.setattr(os, "replace", boom)
    with pytest.raises(OSError):
        atomic_write_text(p, "corrupt")
    monkeypatch.setattr(os, "replace", real_replace)

    # The old file is untouched and no temp litter survives the failure.
    assert p.read_text() == "original"
    assert [f.name for f in tmp_path.iterdir()] == ["f.txt"]
