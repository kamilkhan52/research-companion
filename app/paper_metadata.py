"""Small derived per-paper metadata that becomes available outside a full Map build.

The reference-graph cache is rewritten throughout a long graph build, so retrieval-triggered
enrichment must not race it with a second read/modify/write cycle.  This independent cache owns
metadata derived directly from one paper's retrieved text (currently first-page affiliations).
It is gitignored working state, guarded in-process, and written atomically.
"""
from __future__ import annotations

import json
import threading

from . import config
from .fileio import atomic_write_text

_VERSION = 1
_lock = threading.RLock()


def _file():
    return config.state_dir() / "paper-metadata.json"


def _empty() -> dict:
    return {"version": _VERSION, "affiliations": {}}


def _load_unlocked() -> dict:
    path = _file()
    if not path.exists():
        return _empty()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return _empty()
    if not isinstance(data, dict) or data.get("version") != _VERSION:
        return _empty()
    data.setdefault("affiliations", {})
    return data


def affiliation_record(slug: str) -> dict | None:
    with _lock:
        record = _load_unlocked()["affiliations"].get(slug)
        return dict(record) if isinstance(record, dict) else None


def affiliation_records() -> dict[str, dict]:
    with _lock:
        return {
            slug: dict(record)
            for slug, record in _load_unlocked()["affiliations"].items()
            if isinstance(record, dict)
        }


def set_affiliation_record(slug: str, record: dict, *, expected_key: str | None = None) -> bool:
    """Persist one record.

    ``expected_key`` makes a slow older extraction harmless after newer full text has already
    started another pass: only the record for the same paper-text fingerprint may be replaced.
    """
    with _lock:
        data = _load_unlocked()
        current = data["affiliations"].get(slug)
        if (
            expected_key is not None
            and isinstance(current, dict)
            and current.get("key") != expected_key
        ):
            return False
        data["affiliations"][slug] = dict(record)
        atomic_write_text(_file(), json.dumps(data, ensure_ascii=False, indent=2))
        return True
