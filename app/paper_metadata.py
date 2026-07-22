"""Canonical derived per-paper metadata available outside a full Map build.

The reference-graph cache is rewritten throughout a long graph build, so retrieval-triggered
enrichment must not race it with a second read/modify/write cycle.  This independent cache owns
metadata derived directly from one paper's retrieved text: first-page affiliations and the
bibliography/context extraction used to assemble the Map.  It is gitignored working state,
guarded in-process, and written atomically.
"""
from __future__ import annotations

import copy
import json
import threading

from . import config
from .fileio import atomic_write_text

_VERSION = 2
_lock = threading.RLock()


def _file():
    return config.state_dir() / "paper-metadata.json"


def _empty() -> dict:
    return {"version": _VERSION, "affiliations": {}, "references": {}}


def _load_unlocked() -> dict:
    path = _file()
    if not path.exists():
        return _empty()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return _empty()
    if not isinstance(data, dict) or data.get("version") not in {1, _VERSION}:
        return _empty()
    # V1 contained only affiliations. Preserve those paid results while adding the canonical
    # reference section; the next write atomically persists the upgraded shape.
    data["version"] = _VERSION
    data.setdefault("affiliations", {})
    data.setdefault("references", {})
    return data


def _save_unlocked(data: dict) -> None:
    data["version"] = _VERSION
    atomic_write_text(_file(), json.dumps(data, ensure_ascii=False, indent=2))


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
        _save_unlocked(data)
        return True


def reference_record(slug: str) -> dict | None:
    """Return the canonical reference extraction, whether fresh or stale."""
    with _lock:
        record = _load_unlocked()["references"].get(slug)
        return copy.deepcopy(record) if isinstance(record, dict) else None


def reference_records() -> dict[str, dict]:
    with _lock:
        return {
            slug: copy.deepcopy(record)
            for slug, record in _load_unlocked()["references"].items()
            if isinstance(record, dict)
        }


def fresh_reference_record(
    slug: str,
    full_text: str,
    *,
    graph_data: dict | None = None,
) -> dict | None:
    """Return a successful extraction for exactly ``full_text``.

    On upgrade, import a matching extraction from the legacy reference-graph cache instead of
    paying for the same LLM work again. ``graph_data`` lets a Map build supply its captured
    snapshot; other callers lazily load the current graph cache on first access.
    """
    from . import graph_store  # lazy: keep the canonical cache independent of graph.py

    content_hash = graph_store.content_hash(full_text)
    with _lock:
        data = _load_unlocked()
        record = data["references"].get(slug)
        if (
            isinstance(record, dict)
            and record.get("status") == "done"
            and record.get("content_hash") == content_hash
        ):
            return copy.deepcopy(record)

        legacy_data = graph_data if graph_data is not None else graph_store.load()
        legacy = graph_store.get_paper_extraction(legacy_data, slug)
        if (
            (not isinstance(record, dict) or record.get("content_hash") == content_hash)
            and
            isinstance(legacy, dict)
            and legacy.get("status") == "done"
            and legacy.get("content_hash") == content_hash
        ):
            imported = copy.deepcopy(legacy)
            data["references"][slug] = imported
            _save_unlocked(data)
            return copy.deepcopy(imported)
        return None


def set_reference_record(
    slug: str,
    record: dict,
    *,
    expected_key: str | None = None,
) -> bool:
    """Persist one reference extraction with the same stale-writer CAS as affiliations."""
    with _lock:
        data = _load_unlocked()
        current = data["references"].get(slug)
        if (
            expected_key is not None
            and isinstance(current, dict)
            and current.get("content_hash") != expected_key
        ):
            return False
        data["references"][slug] = copy.deepcopy(record)
        _save_unlocked(data)
        return True


def remove_records(slug: str) -> None:
    """Drop all derived metadata for a paper removed by a project relocation."""
    with _lock:
        data = _load_unlocked()
        data["affiliations"].pop(slug, None)
        data["references"].pop(slug, None)
        _save_unlocked(data)
