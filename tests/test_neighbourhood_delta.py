"""The new-citation delta lane (DR-052 PR 2): what has STARTED citing the reader's papers.

The property that matters is that it is a DELTA — the stored citer-id set is the memory, so a
paper is reported once and never again, however many times it comes back on the newest page.
No network: the provider call is injected, and the one test of the provider client itself uses
an httpx MockTransport.
"""
from __future__ import annotations

import httpx
from app import graph_store, neighbourhood, semantic_scholar


class _Paper:
    def __init__(self, slug, arxiv_id=None, title=""):
        self.slug, self.arxiv_id, self.title = slug, arxiv_id, title


def _edge(paper_id, title, **kw):
    return {
        "paper_id": paper_id, "title": title, "abstract": kw.get("abstract", ""),
        "year": kw.get("year", 2026), "authors": kw.get("authors", []), "venue": "",
        "doi": kw.get("doi", ""), "arxiv_id": kw.get("arxiv_id", ""), "url": "",
        "citation_count": kw.get("citation_count", 0), "reference_count": kw.get("ref", 30),
        "publication_types": [], "publication_date": "",
        "contexts": kw.get("contexts", []), "is_influential": kw.get("influential", False),
    }


def test_only_citers_we_have_never_seen_are_reported(temp_project):
    data = graph_store.load()
    graph_store.set_forward_sweep(data, "p1", {
        "citers": ["S2-known"], "swept_at": "t", "complete": False, "source": "openalex"})

    fresh, audit = neighbourhood.forward_delta(
        [{"slug": "p1", "title": "Ours"}], [_Paper("p1", "2401.00001", "Ours")], data,
        fetch=lambda ident: [_edge("S2-known", "Already seen"), _edge("S2-new", "Brand new")])

    assert [c["title"] for c in fresh] == ["Brand new"]
    assert audit["new"] == 1 and audit["known"] == 1
    # The set is a UNION, so the paper that fell off nothing still cannot come back as new.
    assert graph_store.get_forward(data, "p1")["citers"] == ["S2-known", "S2-new"]

    again, audit2 = neighbourhood.forward_delta(
        [{"slug": "p1", "title": "Ours"}], [_Paper("p1", "2401.00001", "Ours")], data,
        fetch=lambda ident: [_edge("S2-known", "Already seen"), _edge("S2-new", "Brand new")])
    assert again == []
    assert audit2["new"] == 0


def test_a_delta_candidate_carries_the_evidence_and_its_anchor(temp_project):
    data = graph_store.load()
    fresh, _ = neighbourhood.forward_delta(
        [{"slug": "p1", "title": "Our Paper"}], [_Paper("p1", "2401.00001", "Our Paper")], data,
        fetch=lambda ident: [_edge(
            "S2-a", "The citer", contexts=["We extend the method of Our Paper."],
            influential=True, ref=12, doi="10.1/x")])

    candidate = fresh[0]
    assert candidate["channels"] == ["new_citation"]
    assert candidate["doi"] == "10.1/x"
    provenance = candidate["provenance"][0]
    assert provenance["anchor_slug"] == "p1"
    assert provenance["anchor_title"] == "Our Paper"
    assert provenance["contexts"] == ["We extend the method of Our Paper."]
    assert provenance["is_influential"] is True
    assert provenance["reference_count"] == 12


def test_one_anchors_outage_does_not_cost_the_others(temp_project):
    data = graph_store.load()

    def flaky(identifier):
        if "2401" in identifier:
            raise semantic_scholar.SemanticScholarError("HTTP 503")
        return [_edge("S2-b", "From the healthy anchor")]

    fresh, audit = neighbourhood.forward_delta(
        [{"slug": "p1", "title": "A"}, {"slug": "p2", "title": "B"}],
        [_Paper("p1", "2401.00001"), _Paper("p2", "2402.00002")], data, fetch=flaky)

    assert [c["title"] for c in fresh] == ["From the healthy anchor"]
    assert audit["anchors"] == 1
    assert any("p1" in note for note in audit["degraded"])
    assert graph_store.get_forward(data, "p1") is None      # nothing recorded for the failure
    assert graph_store.get_forward(data, "p2")["citers"] == ["S2-b"]


def test_the_lane_declines_to_run_without_an_api_key(temp_project, monkeypatch):
    """Unauthenticated S2 shares a global ~1 req/s pool, and this lane is one call PER corpus
    paper — without a key it would spend the run's time budget collecting 429s."""
    monkeypatch.setattr(semantic_scholar, "api_key", lambda: "")
    fresh, audit = neighbourhood.forward_delta(
        [{"slug": "p1", "title": "A"}], [_Paper("p1", "2401.00001")], graph_store.load())
    assert fresh == []
    assert any("API key" in note for note in audit["degraded"])


def test_a_paper_with_no_resolvable_identifier_is_skipped(temp_project):
    data = graph_store.load()
    fresh, audit = neighbourhood.forward_delta(
        [{"slug": "p1", "title": "A"}], [_Paper("p1", arxiv_id=None)], data,
        fetch=lambda ident: [_edge("S2-x", "never reached")])
    assert fresh == [] and audit["anchors"] == 0


def test_citing_papers_asks_for_the_citer_object_and_keeps_the_contexts():
    """Two live-measured traps in one: requesting edge fields alone silently omits citingPaper,
    and the contexts are the lane's evidence, so a row without a usable citer is dropped rather
    than carried as a nameless candidate."""
    seen = {}

    def handler(request):
        seen["fields"] = request.url.params.get("fields", "")
        seen["limit"] = request.url.params.get("limit")
        return httpx.Response(200, json={"data": [
            {"contexts": ["We build on it."], "isInfluential": True, "citingPaper": {
                "paperId": "abc", "title": "A citer", "year": 2026, "referenceCount": 20,
                "externalIds": {"DOI": "10.1/ABC", "ArXiv": "2601.00001"},
                "authors": [{"name": "R. Ash"}]}},
            {"contexts": [], "citingPaper": None},          # unusable: no citer object
            {"contexts": [], "citingPaper": {"paperId": "", "title": "no id"}},
        ]})

    client = httpx.Client(transport=httpx.MockTransport(handler),
                          base_url=semantic_scholar.BASE_URL)
    rows = semantic_scholar.citing_papers("ARXIV:2401.00001", key="k", client=client,
                                          pacer=semantic_scholar.RequestPacer(0.0))
    client.close()

    assert "citingPaper.title" in seen["fields"]
    assert "intents" not in seen["fields"]      # the 18%-coverage signal we deliberately skip
    assert seen["limit"] == str(neighbourhood.FORWARD_PAGE) or seen["limit"] == "100"
    assert len(rows) == 1
    assert rows[0]["paper_id"] == "abc"
    assert rows[0]["doi"] == "10.1/abc"         # lower-cased for identity matching
    assert rows[0]["arxiv_id"] == "2601.00001"
    assert rows[0]["contexts"] == ["We build on it."]
    assert rows[0]["is_influential"] is True
