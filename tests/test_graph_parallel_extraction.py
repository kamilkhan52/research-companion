"""R7.11 — the extraction fan-out: papers genuinely extract concurrently, workers carry the
project contextvar, and the per-paper persist + progress protocol is unchanged."""
from __future__ import annotations

import threading

from app import config, graph, graph_store, sessions, store

from tests.conftest import add_paper


def _extraction(slug, full_text, model):
    return {
        "slug": slug, "content_hash": graph_store.content_hash(full_text),
        "extracted_at": "2026-01-01T00:00:00+00:00", "model": model, "status": "done",
        "references": [], "error": "",
    }


def test_extractions_overlap_and_rebind_the_project(temp_project):
    add_paper(temp_project, "a", "Paper A", full_text="text a")
    add_paper(temp_project, "b", "Paper B", full_text="text b")
    papers = store.list_papers(sessions.session_states())

    # Both extractions must be in flight at once to pass the barrier — a serial loop would
    # deadlock here (and time out the barrier).
    barrier = threading.Barrier(2, timeout=10)
    seen_pids: list[str | None] = []

    def extract(slug, title, full_text, model):
        seen_pids.append(config.active_project_id())
        barrier.wait()
        return _extraction(slug, full_text, model)

    events = list(graph.build_graph(papers, extract_fn=extract))

    assert events[-1]["type"] == "done"
    assert seen_pids == [temp_project, temp_project]  # invariant 2 inside pool workers

    extracting = [e["slug"] for e in events if e["type"] == "extracting"]
    progress = [e for e in events if e["type"] == "progress"]
    assert sorted(extracting) == ["a", "b"]
    assert sorted(e["slug"] for e in progress) == ["a", "b"]
    assert [e["done"] for e in sorted(progress, key=lambda e: e["done"])] == [1, 2]
    # Per-paper persistence survived the fan-out: both extractions are in the store.
    data = graph_store.load()
    assert set(data["papers"]) >= {"a", "b"}


def test_cached_papers_bypass_the_pool(temp_project):
    add_paper(temp_project, "a", "Paper A", full_text="text a")
    papers = store.list_papers(sessions.session_states())
    calls: list[str] = []

    def extract(slug, title, full_text, model):
        calls.append(slug)
        return _extraction(slug, full_text, model)

    list(graph.build_graph(papers, extract_fn=extract))
    events = list(graph.build_graph(papers, extract_fn=extract))

    assert calls == ["a"]  # second build served from the content-hash cache
    progress = [e for e in events if e["type"] == "progress"]
    assert progress and all(e["cached"] for e in progress)
