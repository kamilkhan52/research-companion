"""Atomic file writes.

Every durable state/store file (settings, session index, reading-list.md, working-notes.md,
corpus files, caches, the reference-graph store) is written by replacing the whole file. A
plain ``Path.write_text`` truncates the target first, so a crash or a full disk mid-write
leaves a half-written (often JSON-invalid) file — and several readers here swallow
``JSONDecodeError`` silently, so corruption would present as "my settings/sessions vanished".

``atomic_write_*`` writes to a temp file in the *same directory* (so ``os.replace`` is a real
atomic rename, not a cross-filesystem copy), fsyncs it, then renames over the target. A reader
therefore always sees either the old file or the new one, never a torn write. ``mode`` sets
the final file permissions explicitly (default 0o644; settings files pass 0o600 since they
hold API keys) rather than inheriting mkstemp's 0o600 for everything.
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path


def atomic_write_text(path: str | os.PathLike, data: str, encoding: str = "utf-8",
                      mode: int = 0o644) -> None:
    _atomic_write(Path(path), data.encode(encoding), mode)


def atomic_write_bytes(path: str | os.PathLike, data: bytes, mode: int = 0o644) -> None:
    _atomic_write(Path(path), data, mode)


def _atomic_write(path: Path, data: bytes, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
