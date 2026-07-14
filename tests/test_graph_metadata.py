"""Semantic Scholar metadata caching and deterministic full-text/provider graph merging."""
from __future__ import annotations

from app import graph, graph_store, semantic_scholar, sessions, store
from app.models import Paper

from tests.conftest import add_paper


def paper(slug: str, title: str, *, arxiv_id: str = "") -> Paper:
    return Paper(
        slug=slug, title=title, group="Group", list_status="unread", arxiv_id=arxiv_id
    )


def provider_record(refs: list[dict]) -> dict:
    return {"status": "done", "references": refs, "error": ""}


def test_title_resolution_is_verified_before_references_are_fetched(monkeypatch):
    reference_calls: list[str] = []
    monkeypatch.setattr(semantic_scholar, "resolve_paper", lambda _title: {
        "paperId": "s2-source", "title": "Source Paper", "externalIds": {"DOI": "10.1/source"},
    })
    monkeypatch.setattr(
        semantic_scholar, "references",
        lambda identifier: reference_calls.append(identifier) or [],
    )

    result = graph.fetch_semantic_scholar_metadata(paper("source", "Source Paper"))

    assert result["status"] == "done"
    assert result["paper"]["paper_id"] == "s2-source"
    assert reference_calls == ["s2-source"]


def test_bad_title_resolution_is_rejected_without_fetching_references(monkeypatch):
    monkeypatch.setattr(semantic_scholar, "resolve_paper", lambda _title: {
        "paperId": "wrong", "title": "An Unrelated Work", "externalIds": {},
    })
    monkeypatch.setattr(
        semantic_scholar, "references",
        lambda _identifier: (_ for _ in ()).throw(AssertionError("must not fetch")),
    )

    result = graph.fetch_semantic_scholar_metadata(paper("source", "Source Paper"))

    assert result["status"] == "not_found"


def test_arxiv_identity_skips_title_resolution(monkeypatch):
    reference_calls: list[str] = []
    monkeypatch.setattr(
        semantic_scholar, "resolve_paper",
        lambda _title: (_ for _ in ()).throw(AssertionError("must not resolve")),
    )
    monkeypatch.setattr(
        semantic_scholar, "references",
        lambda identifier: reference_calls.append(identifier) or [],
    )

    result = graph.fetch_semantic_scholar_metadata(
        paper("source", "Source Paper", arxiv_id="2401.12345v3")
    )

    assert result["status"] == "done"
    assert reference_calls == ["ARXIV:2401.12345"]


def test_provider_match_enriches_full_text_edge_without_replacing_significance():
    papers = [paper("source", "Source Paper")]
    extractions = {
        "source": {
            "status": "done",
            "references": [{
                "title": "A Foundational Method",
                "contexts": ["Local full-text context."],
                "significant": True,
                "significance_reason": "The primary baseline.",
            }],
        }
    }
    metadata = {
        "source": provider_record([{
            "paper_id": "s2-target",
            "title": "A Foundational Method",
            "arxiv_id": "2401.00001",
            "doi": "10.1/foundation",
            "contexts": ["Provider citation context."],
            "intents": ["methodology"],
            "is_influential": False,
        }])
    }

    combined = graph.merge_reference_sources(papers, extractions, metadata)
    nodes, edges = graph.build_nodes_and_edges(papers, combined)

    edge = edges[0]
    assert edge["significant"] is True
    assert edge["reason"] == "The primary baseline."
    assert edge["provenance"] == ["full_text", "semantic_scholar"]
    assert edge["full_text_verified"] is True
    assert edge["provider_evidence"]["semantic_scholar"]["intents"] == ["methodology"]
    assert edge["provider_evidence"]["semantic_scholar"]["is_influential"] is False
    assert edge["contexts"] == ["Local full-text context.", "Provider citation context."]
    target = next(node for node in nodes if node["kind"] == "external")
    assert target["arxiv_id"] == "2401.00001"
    assert target["doi"] == "10.1/foundation"
    assert extractions["source"]["references"][0]["contexts"] == ["Local full-text context."]


def test_provider_only_edge_is_never_locally_significant():
    papers = [paper("source", "Source Paper")]
    metadata = {
        "source": provider_record([{
            "paper_id": "s2-target",
            "title": "Provider Only Work",
            "contexts": ["Provider evidence."],
            "intents": ["background"],
            "is_influential": True,
            "significant": True,
        }])
    }

    combined = graph.merge_reference_sources(papers, {}, metadata)
    _, edges = graph.build_nodes_and_edges(papers, combined)

    assert len(edges) == 1
    assert edges[0]["significant"] is False
    assert edges[0]["reason"] == ""
    assert edges[0]["full_text_verified"] is False
    assert edges[0]["provenance"] == ["semantic_scholar"]
    assert edges[0]["provider_evidence"]["semantic_scholar"]["is_influential"] is True


def test_provider_identifier_matches_a_project_paper_without_title_similarity():
    papers = [
        paper("source", "Source Paper"),
        paper("target", "The Project's Display Title", arxiv_id="2401.12345v2"),
    ]
    metadata = {
        "source": provider_record([{
            "paper_id": "s2-target", "title": "A Completely Different Provider Title",
            "arxiv_id": "2401.12345", "contexts": [], "intents": [],
            "is_influential": False,
        }])
    }

    combined = graph.merge_reference_sources(papers, {}, metadata)
    nodes, edges = graph.build_nodes_and_edges(papers, combined)

    assert edges[0]["target"] == "target"
    assert not any(node["kind"] == "external" for node in nodes)


def test_provider_identifier_and_title_only_mentions_dedupe_to_one_external_node():
    papers = [paper("a", "Paper A"), paper("b", "Paper B")]
    extractions = {
        "a": {"status": "done", "references": [{
            "title": "Shared External Work", "significant": False,
        }]},
        "b": {"status": "done", "references": [{
            "title": "Shared External Work", "significant": True,
        }]},
    }
    metadata = {
        "a": provider_record([{
            "paper_id": "s2-shared", "title": "Shared External Work",
            "arxiv_id": "2401.00003", "contexts": [], "intents": [],
            "is_influential": False,
        }])
    }

    combined = graph.merge_reference_sources(papers, extractions, metadata)
    nodes, edges = graph.build_nodes_and_edges(papers, combined)

    external = [node for node in nodes if node["kind"] == "external"]
    assert len(external) == 1
    assert external[0]["arxiv_id"] == "2401.00003"
    assert external[0]["cited_by_project_count"] == 2
    assert len(edges) == 2


def test_provider_cache_is_independent_from_full_text_extraction(temp_project, monkeypatch):
    add_paper(temp_project, "source", "Source Paper", full_text="Version one.")
    papers = store.list_papers(sessions.session_states())
    metadata_calls: list[str] = []
    extraction_calls: list[str] = []

    def metadata_fn(item: Paper) -> dict:
        metadata_calls.append(item.slug)
        return provider_record([{
            "paper_id": "s2-target", "title": "Provider Work", "arxiv_id": "2401.00001",
            "contexts": [], "intents": [], "is_influential": False,
        }])

    def extract_fn(slug: str, title: str, full_text: str, model: str) -> dict:
        extraction_calls.append(slug)
        return {
            "slug": slug, "content_hash": graph_store.content_hash(full_text),
            "extracted_at": "t", "model": model, "status": "done", "references": [],
            "error": "",
        }

    list(graph.build_graph(papers, extract_fn=extract_fn, metadata_fn=metadata_fn))
    assert metadata_calls == ["source"]
    assert extraction_calls == ["source"]

    store.write_full_text("source", "Source Paper", "Version two.", {"slug": "source"})
    papers = store.list_papers(sessions.session_states())
    list(graph.build_graph(papers, extract_fn=extract_fn, metadata_fn=metadata_fn))

    assert metadata_calls == ["source"]
    assert extraction_calls == ["source", "source"]
    cached = graph_store.get_provider_paper(
        graph_store.load(), "semantic_scholar", "source"
    )
    assert cached["status"] == "done"
    assert cached["source_key"] == "TITLE:source paper"
    monkeypatch.setattr(semantic_scholar, "api_key", lambda: "configured")
    status = graph.status(papers)
    assert status["semantic_scholar_papers"] == 1
    assert status["semantic_scholar_stale_papers"] == []


def test_status_requests_rebuild_when_provider_cache_is_missing(temp_project, monkeypatch):
    add_paper(temp_project, "source", "Source Paper", full_text="Text.")
    papers = store.list_papers(sessions.session_states())

    def extract_fn(slug: str, title: str, full_text: str, model: str) -> dict:
        return {
            "slug": slug, "content_hash": graph_store.content_hash(full_text),
            "extracted_at": "t", "model": model, "status": "done", "references": [],
            "error": "",
        }

    list(graph.build_graph(papers, extract_fn=extract_fn))
    monkeypatch.setattr(semantic_scholar, "api_key", lambda: "configured")

    status = graph.status(papers)
    assert status["stale_papers"] == ["source"]
    assert status["semantic_scholar_stale_papers"] == ["source"]


def test_provider_failure_is_cached_as_retryable_and_does_not_abort_graph(temp_project):
    add_paper(temp_project, "source", "Source Paper", full_text="Text.")
    papers = store.list_papers(sessions.session_states())
    calls = 0

    def failing_metadata(_paper: Paper) -> dict:
        nonlocal calls
        calls += 1
        raise semantic_scholar.SemanticScholarError("temporary provider failure")

    def extract_fn(slug: str, title: str, full_text: str, model: str) -> dict:
        return {
            "slug": slug, "content_hash": graph_store.content_hash(full_text),
            "extracted_at": "t", "model": model, "status": "done",
            "references": [{"title": "Local Work", "significant": True}], "error": "",
        }

    first = list(graph.build_graph(
        papers, extract_fn=extract_fn, metadata_fn=failing_metadata
    ))
    assert first[-1]["type"] == "done"
    assert first[-1]["graph"]["edges"][0]["significant"] is True
    assert graph_store.get_provider_paper(
        graph_store.load(), "semantic_scholar", "source"
    )["status"] == "error"

    list(graph.build_graph(papers, extract_fn=extract_fn, metadata_fn=failing_metadata))
    assert calls == 2


def test_provider_builds_edges_for_a_paper_without_cached_full_text(temp_project):
    reading_list = store._reading_list()
    reading_list.write_text(
        reading_list.read_text(encoding="utf-8")
        + "\n**Metadata Source** — *unread*\n<!-- slug: metadata-source -->\n",
        encoding="utf-8",
    )
    papers = store.list_papers(sessions.session_states())

    events = list(graph.build_graph(
        papers,
        extract_fn=lambda *_: (_ for _ in ()).throw(AssertionError("must not extract")),
        metadata_fn=lambda _paper: provider_record([{
            "paper_id": "s2-target", "title": "Metadata Target", "arxiv_id": "2401.00002",
            "contexts": [], "intents": [], "is_influential": False,
        }]),
    ))

    assert events[0]["total"] == 0
    assert len(events[-1]["graph"]["edges"]) == 1
    assert events[-1]["graph"]["edges"][0]["provenance"] == ["semantic_scholar"]
