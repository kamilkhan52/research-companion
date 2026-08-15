"""The new-citation delta lane (DR-052 PR 2): what has STARTED citing the reader's papers.

Two properties carry this lane, and both are about memory rather than fetching:

- It is a DELTA. The stored citer-id set is what stops a paper being reported twice.
- The set is committed only once the run's results are durable. Marking a citer known at fetch
  time would mean a stopped run had already suppressed papers it never showed anyone — and
  suppression is the one direction nothing downstream can recover from.

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
        "year": kw.get("year", 2026), "authors": kw.get("authors", []),
        "venue": kw.get("venue", ""), "doi": kw.get("doi", ""),
        "arxiv_id": kw.get("arxiv_id", ""), "url": "",
        "citation_count": kw.get("citation_count", 0), "reference_count": kw.get("ref", 30),
        "publication_types": [], "publication_date": kw.get("date", ""),
        "contexts": kw.get("contexts", []), "is_influential": kw.get("influential", False),
    }


def _sweep(data, anchors, papers, edges_by_call, **kw):
    """Run the lane and commit it, the way a completed discovery run does."""
    fresh, audit, pending = neighbourhood.forward_delta(
        anchors, papers, data, fetch=lambda ident: edges_by_call(ident), **kw)
    neighbourhood.commit_forward_delta(data, pending)
    return fresh, audit


def test_only_citers_we_have_never_seen_are_reported(temp_project):
    data = graph_store.load()
    anchors = [{"slug": "p1", "title": "Ours"}]
    papers = [_Paper("p1", "2401.00001", "Ours")]
    page = lambda _i: [_edge("S2-known", "Already seen"), _edge("S2-new", "Brand new")]  # noqa: E731

    graph_store.set_forward_sweep(data, "p1", {
        "s2_citers": ["S2-known"], "s2_swept_at": "2026-08-01T00:00:00+00:00"})

    fresh, audit = _sweep(data, anchors, papers, page)
    assert [c["title"] for c in fresh] == ["Brand new"]
    assert audit["new"] == 1 and audit["known"] == 1
    assert graph_store.get_forward(data, "p1")["s2_citers"] == ["S2-known", "S2-new"]

    # Run again over the same page: nothing is new the second time.
    again, audit2 = _sweep(data, anchors, papers, page)
    assert again == []
    assert audit2["new"] == 0


def test_a_stopped_run_does_not_suppress_the_papers_it_never_showed(temp_project):
    """The lane returns its swept ids instead of writing them, precisely so an interrupted run
    cannot mark a citer known before the reader ever saw it. A repeat report is harmless (the
    ledger reservoir merges it); a suppressed one is gone for good."""
    data = graph_store.load()
    anchors = [{"slug": "p1", "title": "Ours"}]
    papers = [_Paper("p1", "2401.00001", "Ours")]

    fresh, _, pending = neighbourhood.forward_delta(
        anchors, papers, data, fetch=lambda _i: [_edge("S2-a", "New citer")])
    assert [c["title"] for c in fresh] == ["New citer"]
    # The run dies here — Stop, a deploy, a reload. Nothing was committed.
    assert graph_store.get_forward(data, "p1") is None
    assert pending == {"p1": {"S2-a"}}

    fresh_again, _, _ = neighbourhood.forward_delta(
        anchors, papers, graph_store.load(), fetch=lambda _i: [_edge("S2-a", "New citer")])
    assert [c["title"] for c in fresh_again] == ["New citer"]  # still reportable


def test_the_two_forward_lanes_keep_separate_id_namespaces(temp_project):
    """A `W…` OpenAlex work key can never equal a 40-hex S2 paperId, so unioning both into one
    list would leave each lane's memory invisible to the other while looking shared — and would
    let the breadth chase's ids silently pass for delta memory."""
    data = graph_store.load()
    neighbourhood.record_forward_sweep(data, [
        {"openalex_id": "https://openalex.org/W2741809807",
         "provenance": [{"channel": "cites", "anchor_slug": "p1"}]}])

    fresh, _ = _sweep(data, [{"slug": "p1", "title": "Ours"}], [_Paper("p1", "2401.00001")],
                      lambda _i: [_edge("649def34f8be52c8b66281af98ae884c09aef38b", "A citer")])

    record = graph_store.get_forward(data, "p1")
    assert record["citers"] == ["W2741809807"]                        # untouched by the delta
    assert record["s2_citers"] == ["649def34f8be52c8b66281af98ae884c09aef38b"]
    assert record["source"] == "openalex"                             # still describes `citers`
    assert len(fresh) == 1

    # The delta's memory is the S2 list ONLY. Reading the OpenAlex list instead would make
    # whatever the breadth chase happened to store act as delta memory — the direction that
    # silently suppresses. Seed the OpenAlex list with an S2-shaped id (which real data never
    # contains) and the citer must still be reported.
    data2 = graph_store.load()
    graph_store.set_forward_sweep(data2, "p9", {"citers": ["S2-shaped-id"], "source": "openalex"})
    reported, _ = _sweep(data2, [{"slug": "p9", "title": "Nine"}], [_Paper("p9", "2409.00001")],
                         lambda _i: [_edge("S2-shaped-id", "Must still be reported")])
    assert [c["title"] for c in reported] == ["Must still be reported"]

    # And the reverse order: a later breadth chase must not clobber the S2 side.
    neighbourhood.record_forward_sweep(data, [
        {"openalex_id": "https://openalex.org/W999",
         "provenance": [{"channel": "cites", "anchor_slug": "p1"}]}])
    record = graph_store.get_forward(data, "p1")
    assert record["citers"] == ["W2741809807", "W999"]
    assert record["s2_citers"] == ["649def34f8be52c8b66281af98ae884c09aef38b"]


def test_a_delta_candidate_carries_the_evidence_and_its_anchor(temp_project):
    data = graph_store.load()
    fresh, _ = _sweep(
        data, [{"slug": "p1", "title": "Our Paper"}], [_Paper("p1", "2401.00001", "Our Paper")],
        lambda _i: [_edge("S2-a", "The citer", contexts=["We extend the method of Our Paper."],
                          influential=True, ref=12, doi="10.1/x", venue="NeurIPS",
                          date="2026-08-01")])

    candidate = fresh[0]
    assert candidate["channels"] == ["new_citation"]
    assert candidate["doi"] == "10.1/x"
    assert candidate["venue"] == "NeurIPS"           # paid for in the request; fed to the screen
    assert candidate["paper_id"] == "S2-a"           # links the candidate back to the substrate
    assert candidate["publication_date"] == "2026-08-01"
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

    fresh, audit = _sweep(
        data, [{"slug": "p1", "title": "A"}, {"slug": "p2", "title": "B"}],
        [_Paper("p1", "2401.00001"), _Paper("p2", "2402.00002")], flaky)

    assert [c["title"] for c in fresh] == ["From the healthy anchor"]
    assert audit["anchors"] == 1 and audit["skipped"] == 1
    # One reader-facing sentence, not one raw exception name per failing anchor.
    assert audit["degraded"] and "Could not check 1 paper" in audit["degraded"][0]
    # The failure records an ATTEMPT (so it rotates) but marks no citer known — nothing the
    # reader never saw is suppressed.
    failed = graph_store.get_forward(data, "p1")
    assert failed["s2_attempted_at"] and "s2_citers" not in failed
    assert graph_store.get_forward(data, "p2")["s2_citers"] == ["S2-b"]


def test_cancellation_is_answered_between_anchors(temp_project):
    """Up to 25 serial paced requests: without a per-anchor check, Stop would sit unanswered for
    a minute or more."""
    calls = []
    anchors = [{"slug": f"p{n}", "title": f"P{n}"} for n in range(5)]
    papers = [_Paper(f"p{n}", f"240{n}.00001") for n in range(5)]

    def fetch(identifier):
        calls.append(identifier)
        return [_edge(f"S2-{len(calls)}", "A citer")]

    fresh, _, pending = neighbourhood.forward_delta(
        anchors, papers, graph_store.load(), fetch=fetch,
        should_cancel=lambda: len(calls) >= 2)

    assert len(calls) == 2
    assert len(fresh) == 2          # what it did fetch is still returned, not thrown away
    assert set(pending) == {"p0", "p1"}


def test_the_sweep_rotates_through_a_library_larger_than_one_runs_budget(temp_project):
    """`anchors[:25]` in list order would leave papers 26+ of a 34-paper project unmonitored
    forever. Ordering by how long ago each was last swept makes the budget a rotation, using the
    substrate's own timestamps as the cursor."""
    data = graph_store.load()
    anchors = [{"slug": f"p{n}", "title": f"P{n}"} for n in range(4)]
    graph_store.set_forward_sweep(data, "p0", {"s2_swept_at": "2026-08-10T00:00:00+00:00"})
    graph_store.set_forward_sweep(data, "p1", {"s2_swept_at": "2026-08-01T00:00:00+00:00"})
    graph_store.set_forward_sweep(data, "p2", {"s2_swept_at": "2026-08-05T00:00:00+00:00"})
    # p3 has never been swept at all.

    chosen, left_over = neighbourhood.stalest_first(anchors, data, limit=2)
    assert [a["slug"] for a in chosen] == ["p3", "p1"]   # never-swept first, then the oldest
    assert left_over == 2


def test_an_unsweepable_paper_cannot_hold_the_front_of_the_rotation(temp_project):
    """Head-of-line starvation, the failure mode the rotation itself introduced: an anchor that
    can never be swept has no timestamp, so ordering by timestamp alone would hand it the same
    slot on every future run — and 25 such anchors would silently sweep nothing at all, forever.

    Two kinds: a paper with no resolvable identifier (excluded from the budget entirely) and one
    the provider keeps failing on (records the attempt, so it rotates to the back)."""
    data = graph_store.load()
    anchors = [{"slug": "no-id", "title": "Unresolvable"}, {"slug": "ok", "title": "Fine"}]
    papers = [_Paper("no-id", arxiv_id=None), _Paper("ok", "2401.00001")]

    # The unresolvable paper does not consume a slot: a budget of one still reaches the real one.
    fresh, audit, pending = neighbourhood.forward_delta(
        anchors, papers, data, fetch=lambda _i: [_edge("S2-a", "A citer")])
    assert [c["title"] for c in fresh] == ["A citer"]
    assert set(pending) == {"ok"}

    # A failing anchor records the ATTEMPT — no citers marked known, but it stops being first.
    failing = [{"slug": "flaky", "title": "Flaky"}]
    failing_papers = [_Paper("flaky", "2402.00002")]

    def boom(_identifier):
        raise semantic_scholar.SemanticScholarError("HTTP 503")

    _, _, pending2 = neighbourhood.forward_delta(failing, failing_papers, data, fetch=boom)
    assert pending2 == {"flaky": None}
    neighbourhood.commit_forward_delta(data, pending2)
    record = graph_store.get_forward(data, "flaky")
    assert record["s2_attempted_at"]
    assert "s2_citers" not in record      # nothing was suppressed on a failed fetch
    assert not record.get("s2_swept_at")

    # With an attempt recorded, a never-tried paper now outranks it in the rotation.
    order, _ = neighbourhood.stalest_first(
        [{"slug": "flaky"}, {"slug": "never-tried"}], data, limit=1)
    assert [a["slug"] for a in order] == ["never-tried"]


def test_a_library_larger_than_one_runs_budget_is_not_a_degradation(temp_project):
    """Every library over the per-run budget would otherwise report itself as degraded on every
    healthy run."""
    data = graph_store.load()
    anchors = [{"slug": f"p{n}", "title": f"P{n}"} for n in range(3)]
    papers = [_Paper(f"p{n}", f"240{n}.00001") for n in range(3)]
    original = neighbourhood.MAX_DELTA_ANCHORS
    try:
        neighbourhood.MAX_DELTA_ANCHORS = 1
        _, audit, _ = neighbourhood.forward_delta(
            anchors, papers, data, fetch=lambda _i: [])
    finally:
        neighbourhood.MAX_DELTA_ANCHORS = original
    assert audit["unmonitored"] == 2
    assert audit["degraded"] == []


def test_a_sweep_that_finds_nothing_still_advances_its_timestamp(temp_project):
    """"We looked and there was nothing new" is a different fact from "we never looked" — the
    freshness display depends on it, and so does the rotation above."""
    data = graph_store.load()
    graph_store.set_forward_sweep(data, "p1", {
        "s2_citers": ["S2-a"], "s2_swept_at": "2026-01-01T00:00:00+00:00"})

    _sweep(data, [{"slug": "p1", "title": "A"}], [_Paper("p1", "2401.00001")],
           lambda _i: [_edge("S2-a", "Already seen")])

    assert graph_store.get_forward(data, "p1")["s2_swept_at"] > "2026-01-01T00:00:00+00:00"


def test_the_known_count_survives_a_duplicated_row(temp_project):
    """S2 does return the same citer twice on one page; a set/list mix-up made the audit's
    `known` count go negative."""
    data = graph_store.load()
    _, audit = _sweep(data, [{"slug": "p1", "title": "A"}], [_Paper("p1", "2401.00001")],
                      lambda _i: [_edge("S2-a", "One"), _edge("S2-a", "One again")])
    assert audit["known"] == 0
    assert audit["new"] >= 1


def test_the_lane_declines_to_run_without_an_api_key(temp_project, monkeypatch):
    """Unauthenticated S2 shares a global ~1 req/s pool, and this lane is one call PER corpus
    paper — without a key it would spend the run's time budget collecting 429s. It is a log
    line, not a reader-facing degradation: nothing is missing that the reader asked for."""
    monkeypatch.setattr(semantic_scholar, "api_key", lambda: "")
    fresh, audit, pending = neighbourhood.forward_delta(
        [{"slug": "p1", "title": "A"}], [_Paper("p1", "2401.00001")], graph_store.load())
    assert fresh == [] and pending == {}
    assert audit["degraded"] == []


def test_a_paper_with_no_resolvable_identifier_is_skipped(temp_project):
    data = graph_store.load()
    fresh, audit = _sweep(data, [{"slug": "p1", "title": "A"}], [_Paper("p1", arxiv_id=None)],
                          lambda _i: [_edge("S2-x", "never reached")])
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
    assert len(rows) == 1
    assert rows[0]["paper_id"] == "abc"
    assert rows[0]["doi"] == "10.1/abc"         # lower-cased for identity matching
    assert rows[0]["arxiv_id"] == "2601.00001"
    assert rows[0]["contexts"] == ["We build on it."]
    assert rows[0]["is_influential"] is True
