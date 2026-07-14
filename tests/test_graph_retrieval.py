"""Phase 5.1 graph-only missing-paper retrieval and resumability."""
from __future__ import annotations

import pytest
from app import graph, graph_store, sessions, store
from app.models import Paper


def _add_unretrieved(title: str = "Missing Paper", slug: str = "missing") -> list[Paper]:
    reading_list = store._reading_list()
    reading_list.write_text(
        reading_list.read_text(encoding="utf-8")
        + f"\n**{title}** — *unread*\n<!-- slug: {slug} -->\n",
        encoding="utf-8",
    )
    return store.list_papers(sessions.session_states())


def _extractor(calls: list[str]):
    def extract(slug: str, title: str, full_text: str, model: str) -> dict:
        calls.append(full_text)
        return {
            "slug": slug, "content_hash": graph_store.content_hash(full_text),
            "extracted_at": "t", "model": model, "status": "done", "references": [],
            "error": "",
        }
    return extract


def test_confident_retrieval_is_graph_only_and_feeds_extraction(temp_project):
    papers = _add_unretrieved()
    extracted: list[str] = []

    events = list(graph.build_graph(
        papers,
        extract_fn=_extractor(extracted),
        retrieval_fn=lambda paper, provider: {
            "full_text": "Retrieved graph text.", "arxiv_id": "2401.00001",
            "source": "https://arxiv.org/abs/2401.00001",
        },
    ))

    assert extracted == ["Retrieved graph text."]
    assert events[-1]["type"] == "done"
    assert not store.corpus_path("missing").exists()  # never writes the git-backed corpus
    assert graph_store.read_retrieved_text("missing") == "Retrieved graph text."
    assert graph_store.get_retrieval(graph_store.load(), "missing")["status"] == "done"


def test_retrieval_cache_resumes_without_network_or_reextracting(temp_project):
    papers = _add_unretrieved()
    retrieval_calls = 0

    def retrieve(_paper, _provider):
        nonlocal retrieval_calls
        retrieval_calls += 1
        return {"full_text": "Stable graph text.", "arxiv_id": "2401.00001"}

    list(graph.build_graph(
        papers, extract_fn=_extractor([]), retrieval_fn=retrieve
    ))
    second_extractions: list[str] = []
    list(graph.build_graph(
        papers, extract_fn=_extractor(second_extractions), retrieval_fn=retrieve
    ))

    assert retrieval_calls == 1
    assert second_extractions == []


def test_ambiguous_retrieval_surfaces_candidates_without_extraction(temp_project):
    papers = _add_unretrieved()
    candidates = [{"arxiv_id": "2401.00001", "title": "Candidate", "score": 0.7}]

    events = list(graph.build_graph(
        papers,
        extract_fn=lambda *_: (_ for _ in ()).throw(AssertionError("must not extract")),
        retrieval_fn=lambda paper, provider: {
            "needs_confirmation": True, "candidates": candidates,
        },
    ))

    progress = next(event for event in events if event["type"] == "retrieval_progress")
    assert progress["status"] == "needs_confirmation"
    assert progress["candidates"] == candidates
    assert progress["ready"] == 0
    status = graph.status(papers)
    assert status["retrieval_candidates"] == {"missing": candidates}
    assert status["retrievable_papers"] == 0


def test_confirmed_candidate_is_used_without_writing_reading_list(temp_project, monkeypatch):
    papers = _add_unretrieved()
    calls: list[str] = []

    list(graph.build_graph(
        papers,
        extract_fn=_extractor([]),
        retrieval_fn=lambda *_: {
            "needs_confirmation": True,
            "candidates": [{"arxiv_id": "2401.54321", "title": "Candidate", "score": 0.7}],
        },
    ))

    def retrieve(title, arxiv_id=None, pdf_url=None, min_score=0.62):
        calls.append(arxiv_id)
        return {"full_text": "Confirmed text.", "arxiv_id": arxiv_id}

    monkeypatch.setattr(graph.retriever, "retrieve", retrieve)
    list(graph.build_graph(
        papers,
        extract_fn=_extractor([]),
        retrieval_fn=lambda *_: (_ for _ in ()).throw(AssertionError("use override")),
        retrieval_sources={"missing": "2401.54321"},
    ))

    assert calls == ["2401.54321"]
    assert store.arxiv_id_for("missing") == ""
    assert not store.corpus_path("missing").exists()


def test_retrieval_failure_is_per_paper_and_retried_next_build(temp_project):
    papers = _add_unretrieved()
    calls = 0

    def fail(_paper, _provider):
        nonlocal calls
        calls += 1
        raise RuntimeError("download failed")

    first = list(graph.build_graph(papers, extract_fn=_extractor([]), retrieval_fn=fail))
    assert first[-1]["type"] == "done"
    assert graph.status(papers)["retrieval_errors"] == {"missing": "download failed"}

    list(graph.build_graph(papers, extract_fn=_extractor([]), retrieval_fn=fail))
    assert calls == 2


def test_failed_forced_refresh_does_not_count_stale_text_as_ready(temp_project):
    papers = _add_unretrieved()

    def extract_with_edge(slug, title, full_text, model):
        return {
            "slug": slug, "content_hash": graph_store.content_hash(full_text),
            "extracted_at": "t", "model": model, "status": "done",
            "references": [{"title": "Stale Local Reference", "significant": True}],
            "error": "",
        }

    list(graph.build_graph(
        papers,
        extract_fn=extract_with_edge,
        retrieval_fn=lambda *_: {"full_text": "Initial text."},
    ))

    events = list(graph.build_graph(
        papers,
        force=True,
        extract_fn=_extractor([]),
        retrieval_fn=lambda *_: (_ for _ in ()).throw(RuntimeError("refresh failed")),
    ))

    progress = next(event for event in events if event["type"] == "retrieval_progress")
    assert progress["ready"] == 0
    assert events[-1]["graph"]["edges"] == []
    assert graph.status(papers)["retrievable_papers"] == 0


def test_retrieved_text_path_rejects_traversal(temp_project):
    with pytest.raises(ValueError, match="Invalid graph retrieval slug"):
        graph_store.write_retrieved_text("../escape", "text")
