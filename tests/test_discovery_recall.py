"""Recall channels: anchor resolution and the forward-citation chase, with no network.

Anchor resolution is the one part of the pipeline whose cost is paid in TIME rather than tokens —
every unresolved paper is an OpenAlex lookup and possibly a Semantic Scholar hop through a shared
~1 req/s pacer — so its bounds matter as much as its correctness.
"""
from __future__ import annotations

import httpx
from app import discovery_recall


class _Paper:
    def __init__(self, slug, arxiv_id=None, title=""):
        self.slug, self.arxiv_id, self.title = slug, arxiv_id, title


def _client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler), base_url="https://x")


def test_anchor_resolution_is_bounded_on_a_cold_cache():
    """A large library must not turn one discovery run into hundreds of paced requests. The
    citation chase only ever uses MAX_ANCHORS of them, so resolving more is pure latency."""
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return httpx.Response(200, json={"id": f"https://openalex.org/W{calls['n']}"})

    papers = [_Paper(f"p{i}", f"24{i:02d}.00001", f"Paper {i}") for i in range(200)]
    client = _client(handler)
    anchors = discovery_recall.resolve_anchors(papers, client=client, cache={})
    client.close()

    assert calls["n"] <= discovery_recall.MAX_ANCHORS
    assert len(anchors) <= discovery_recall.MAX_ANCHORS


def test_a_cached_anchor_costs_nothing_and_is_not_budgeted():
    """Cache hits are free, so they must not consume the resolution budget — otherwise a project
    whose anchors are all already resolved would still stop after MAX_ANCHORS papers."""
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return httpx.Response(200, json={"id": "https://openalex.org/Wnew"})

    papers = [_Paper(f"p{i}", f"24{i:02d}.00001") for i in range(60)]
    cache = {f"p{i}": f"https://openalex.org/W{i}" for i in range(60)}
    client = _client(handler)
    anchors = discovery_recall.resolve_anchors(papers, client=client, cache=cache)
    client.close()

    assert calls["n"] == 0
    assert len(anchors) == 60


def test_a_paper_that_openalex_cannot_resolve_falls_back_to_the_published_doi():
    """OpenAlex canonicalises a published paper to its published version and DROPS the arXiv DOI,
    so no arXiv-DOI variant will ever find it — the hop through Semantic Scholar's external ids
    is the only route."""
    def handler(request):
        if "/works/doi:10.48550" in str(request.url):
            return httpx.Response(404, text="not found")
        return httpx.Response(200, json={"results": [
            {"id": "https://openalex.org/W999", "doi": "https://doi.org/10.1145/real"}]})

    client = _client(handler)
    cache: dict = {}
    anchors = discovery_recall.resolve_anchors(
        [_Paper("p1", "1706.03762", "Attention")], client=client, cache=cache,
        s2_lookup=lambda arxiv_id: "10.1145/real")
    client.close()

    assert [a["openalex_id"] for a in anchors] == ["https://openalex.org/W999"]
    assert cache["p1"] == "https://openalex.org/W999"     # paid once, ever


def test_the_citation_chase_carries_the_anchor_it_came_from():
    """Provenance is the reason a grounded result is good AND what tells the gate to waive the
    generic popularity floor for it."""
    def handler(request):
        return httpx.Response(200, json={"results": [
            {"id": "https://openalex.org/W5", "title": "Cites You",
             "publication_year": 2025, "cited_by_count": 7}]})

    client = _client(handler)
    out = discovery_recall.chase_citations(
        [{"slug": "p1", "openalex_id": "https://openalex.org/W1", "title": "My Paper"}],
        client=client)
    client.close()

    assert len(out) == 1
    assert out[0]["channels"] == ["cites"]
    assert out[0]["provenance"][0]["anchor_title"] == "My Paper"


def test_an_outage_during_the_chase_yields_no_candidates_rather_than_raising():
    def handler(request):
        raise httpx.ConnectError("down")

    client = _client(handler)
    out = discovery_recall.chase_citations(
        [{"slug": "p1", "openalex_id": "https://openalex.org/W1", "title": "T"}], client=client)
    client.close()
    assert out == []


def test_graph_recommendations_are_read_with_their_reasons_and_marked_grounded():
    """These are already computed on every graph build and were never read by Discovery."""
    out = discovery_recall.graph_recommendations({"recommendations": [
        {"title": "Cited A Lot Here", "doi": "10.1/x", "citation_count": 50,
         "reasons": ["3 of your papers cite it"], "score": 9.1},
        {"title": ""},                                    # unusable rows are skipped
    ]})
    assert len(out) == 1
    assert out[0]["channels"] == ["graph"]
    assert out[0]["provenance"][0]["reasons"] == ["3 of your papers cite it"]


def test_a_graph_with_no_recommendations_is_not_an_error():
    assert discovery_recall.graph_recommendations({}) == []
    assert discovery_recall.graph_recommendations({"recommendations": None}) == []
