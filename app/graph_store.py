"""Persistent store for the per-project reference graph: cached LLM extraction results
keyed by paper slug + content hash (so rebuilding never re-spends tokens on unchanged
papers), plus the last computed graph (nodes/edges/recommendations), which is cheap to
recompute from the cache and safe to invalidate independently of extraction.

Lives in the per-project .state/ dir (gitignored, rebuildable — same convention as
sessions.json), not in the project's git history: this is a derived cache over the papers'
own committed text, not authored content.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from . import config
from .fileio import atomic_write_text

# Bump when the stored shape changes incompatibly. A version mismatch drops the cache
# (including extractions) rather than risk feeding a new analysis stage malformed records —
# acceptable because extraction is fully rebuildable, just costs tokens to redo.
GRAPH_VERSION = 1


def _file() -> Path:
    return config.state_dir() / "reference-graph.json"


def content_hash(text: str) -> str:
    return hashlib.sha1((text or "").encode("utf-8")).hexdigest()


def _empty() -> dict:
    return {
        "version": GRAPH_VERSION,
        "papers": {},        # slug -> PaperExtraction dict (see graph.extract_references_for_paper)
        "graph": None,       # last computed {built_at, model, nodes, edges}
        "recommendations": None,
        "citations": {},     # node id -> global citation count (Semantic Scholar cache)
        # Provider metadata is cached independently from LLM/full-text extraction so a
        # provider refresh never invalidates or re-spends the scholarly analysis cache.
        "providers": {"semantic_scholar": {"papers": {}}},
    }


def load() -> dict:
    f = _file()
    if not f.exists():
        return _empty()
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return _empty()
    if not isinstance(data, dict) or data.get("version") != GRAPH_VERSION:
        return _empty()
    data.setdefault("papers", {})
    data.setdefault("graph", None)
    data.setdefault("recommendations", None)
    data.setdefault("citations", {})  # node id -> global citation count (Semantic Scholar cache)
    providers = data.setdefault("providers", {})
    providers.setdefault("semantic_scholar", {}).setdefault("papers", {})
    return data


def save(data: dict) -> None:
    data["version"] = GRAPH_VERSION
    atomic_write_text(_file(), json.dumps(data, ensure_ascii=False, indent=2))


def get_paper_extraction(data: dict, slug: str) -> dict | None:
    return data["papers"].get(slug)


def set_paper_extraction(data: dict, slug: str, extraction: dict) -> None:
    data["papers"][slug] = extraction


def get_provider_paper(data: dict, provider: str, slug: str) -> dict | None:
    return data.get("providers", {}).get(provider, {}).get("papers", {}).get(slug)


def set_provider_paper(data: dict, provider: str, slug: str, record: dict) -> None:
    data.setdefault("providers", {}).setdefault(provider, {}).setdefault("papers", {})[slug] = record


def set_graph(data: dict, graph_payload: dict) -> None:
    data["graph"] = graph_payload


def set_recommendations(data: dict, recs: list[dict]) -> None:
    data["recommendations"] = recs
