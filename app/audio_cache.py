"""Bounded LRU maintenance for derived audio files.

Audio is reproducible from the approved text and voice settings, so old mp3s are the rare class
of app data that can be deleted automatically.  The cache is per-user for isolation, but the Fly
volume is shared: enforce both a per-user bound and an instance-wide bound.  Reads explicitly
touch mtime, which makes it the LRU clock without adding a database or metadata sidecar.

Only ordinary content-addressed mp3 files are candidates.  Directory symlinks are never walked,
file symlinks are never followed or removed, and files being synthesized or served are protected
under the same process-wide lock as eviction.  This matches the app's single-worker invariant.
"""
from __future__ import annotations

import contextlib
import logging
import os
import re
import stat
import threading
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path

from . import config

log = logging.getLogger("rc.audio_cache")

DEFAULT_PER_USER_BYTES = 2 * 1024**3
DEFAULT_TOTAL_BYTES = 8 * 1024**3
_MP3_NAME = re.compile(r"[0-9a-f]{40}\.mp3")
_lock = threading.RLock()
_protected: dict[Path, int] = {}


@dataclass(frozen=True)
class _Entry:
    path: Path
    size: int
    mtime_ns: int


def _key(path: Path) -> Path:
    """Stable comparison key without resolving (and therefore following) symlinks."""
    return Path(os.path.abspath(path))


def _limit(env_name: str, default: int) -> int:
    raw = os.environ.get(env_name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    # A typo or zero must not silently turn eviction off on a finite production volume.
    return value if value > 0 else default


def per_user_limit() -> int:
    return _limit("RC_AUDIO_CACHE_PER_USER_BYTES", DEFAULT_PER_USER_BYTES)


def total_limit() -> int:
    return _limit("RC_AUDIO_CACHE_TOTAL_BYTES", DEFAULT_TOTAL_BYTES)


def _entry(path: Path) -> _Entry | None:
    if not _MP3_NAME.fullmatch(path.name):
        return None
    try:
        details = path.lstat()
    except OSError:
        return None
    if not stat.S_ISREG(details.st_mode):
        return None
    return _Entry(path, details.st_size, details.st_mtime_ns)


def _entries(directory: Path) -> list[_Entry]:
    try:
        directory_details = directory.lstat()
    except OSError:
        return []
    if not stat.S_ISDIR(directory_details.st_mode):
        return []
    try:
        children = list(directory.iterdir())
    except OSError:
        return []
    return [item for child in children if (item := _entry(child)) is not None]


def _all_audio_dirs(legacy_dir: Path) -> list[Path]:
    """Return real cache directories without descending through user-controlled symlinks."""
    roots = [legacy_dir]
    users = config.APP_STATE_DIR / "users"
    try:
        if not stat.S_ISDIR(users.lstat().st_mode):
            return roots
        user_dirs = list(users.iterdir())
    except OSError:
        return roots
    for user_dir in user_dirs:
        try:
            if not stat.S_ISDIR(user_dir.lstat().st_mode):
                continue
            audio_dir = user_dir / "audio"
            if stat.S_ISDIR(audio_dir.lstat().st_mode):
                roots.append(audio_dir)
        except OSError:
            continue
    return roots


def _trim(entries: list[_Entry], maximum: int) -> int:
    total = sum(item.size for item in entries)
    for item in sorted(entries, key=lambda candidate: (candidate.mtime_ns, candidate.path.name)):
        if total <= maximum:
            break
        if _protected.get(_key(item.path), 0):
            continue
        try:
            item.path.unlink()
        except FileNotFoundError:
            total -= item.size
        except OSError as exc:
            log.warning("could not evict derived audio file: %s", type(exc).__name__)
        else:
            total -= item.size
    return total


def enforce(user_dir: Path, legacy_dir: Path) -> None:
    """Bring the caller's cache and then the shared volume under their configured bounds."""
    with _lock:
        _trim(_entries(user_dir), per_user_limit())
        all_entries = [
            entry
            for directory in _all_audio_dirs(legacy_dir)
            for entry in _entries(directory)
        ]
        _trim(all_entries, total_limit())


def touch(path: Path) -> bool:
    """Mark a valid cached file recently used.  Return false if it vanished or is not regular."""
    with _lock:
        if _entry(path) is None:
            return False
        try:
            os.utime(path, None, follow_symlinks=False)
        except OSError:
            return False
        return True


def claim(path: Path) -> bool:
    """Protect and touch a file until the matching ``release`` after response streaming."""
    with _lock:
        if not touch(path):
            return False
        key = _key(path)
        _protected[key] = _protected.get(key, 0) + 1
        return True


def release(path: Path) -> None:
    with _lock:
        key = _key(path)
        count = _protected.get(key, 0)
        if count <= 1:
            _protected.pop(key, None)
        else:
            _protected[key] = count - 1


@contextlib.contextmanager
def protected(paths: Iterable[Path]) -> Iterator[None]:
    """Protect future or existing paths while an atomic writer constructs a cache result."""
    keys = [_key(path) for path in paths]
    with _lock:
        for key in keys:
            _protected[key] = _protected.get(key, 0) + 1
    try:
        yield
    finally:
        with _lock:
            for key in keys:
                count = _protected.get(key, 0)
                if count <= 1:
                    _protected.pop(key, None)
                else:
                    _protected[key] = count - 1
