"""graph_store: pure JSON persistence. No LLM, no network."""
from __future__ import annotations

from app import graph_store


def test_content_hash_is_stable_and_sensitive_to_change():
    a = graph_store.content_hash("hello world")
    b = graph_store.content_hash("hello world")
    c = graph_store.content_hash("hello world!")
    assert a == b
    assert a != c


def test_content_hash_handles_none_and_empty():
    assert graph_store.content_hash(None) == graph_store.content_hash("")


def test_load_returns_empty_shape_when_no_file(temp_project):
    data = graph_store.load()
    assert data["papers"] == {}
    assert data["graph"] is None
    assert data["recommendations"] is None
    assert data["version"] == graph_store.GRAPH_VERSION


def test_save_and_load_round_trip(temp_project):
    data = graph_store.load()
    graph_store.set_paper_extraction(data, "a", {"status": "done", "references": []})
    graph_store.set_graph(data, {"built_at": "t", "model": "m", "nodes": [], "edges": []})
    graph_store.set_recommendations(data, [{"id": "ext:x", "recommend_score": 1.0}])
    graph_store.save(data)

    reloaded = graph_store.load()
    assert reloaded["papers"]["a"]["status"] == "done"
    assert reloaded["graph"]["model"] == "m"
    assert reloaded["recommendations"][0]["id"] == "ext:x"


def test_load_resets_on_version_mismatch(temp_project):
    data = graph_store.load()
    graph_store.set_paper_extraction(data, "a", {"status": "done", "references": []})
    graph_store.save(data)

    corrupted = graph_store.load()
    corrupted["version"] = -1
    graph_store._file().write_text(__import__("json").dumps(corrupted), encoding="utf-8")

    fresh = graph_store.load()
    assert fresh["papers"] == {}  # stale schema is dropped rather than risking bad reads


def test_load_handles_corrupt_json_gracefully(temp_project):
    graph_store._file().parent.mkdir(parents=True, exist_ok=True)
    graph_store._file().write_text("{not valid json", encoding="utf-8")
    data = graph_store.load()
    assert data["papers"] == {}
