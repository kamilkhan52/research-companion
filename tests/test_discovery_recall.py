"""Recall channels: anchor resolution and the forward-citation chase, with no network.

Anchor resolution is the one part of the pipeline whose cost is paid in TIME rather than tokens —
every unresolved paper is an OpenAlex lookup and possibly a Semantic Scholar hop through a shared
~1 req/s pacer — so its bounds matter as much as its correctness.
"""
from __future__ import annotations

import threading
from datetime import date

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
    cache = {f"p{i}": {"openalex_id": f"https://openalex.org/W{i}",
                        "topics": [{"id": "T1"}]} for i in range(60)}
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
    assert cache["p1"]["openalex_id"] == "https://openalex.org/W999"  # paid once, ever


def test_anchor_topics_survive_the_cache_for_the_next_incremental_run():
    def handler(request):
        return httpx.Response(200, json={
            "id": "https://openalex.org/W1",
            "topics": [{"id": "https://openalex.org/T7", "display_name": "Memory", "score": 1}],
        })

    cache: dict = {}
    first_client = _client(handler)
    discovery_recall.resolve_anchors(
        [_Paper("p1", "2401.00001", "P")], client=first_client, cache=cache)
    first_client.close()

    calls = {"n": 0}
    second_client = _client(lambda request: (calls.__setitem__("n", calls["n"] + 1),
                                             httpx.Response(500))[1])
    anchors = discovery_recall.resolve_anchors(
        [_Paper("p1", "2401.00001", "P")], client=second_client, cache=cache)
    second_client.close()
    assert calls["n"] == 0
    assert anchors[0]["topics"][0]["display_name"] == "Memory"


def test_slice_one_id_only_cache_rows_are_upgraded_with_topics_once():
    cache = {"p1": "https://openalex.org/W1"}
    anchors = [{"slug": "p1", "openalex_id": "https://openalex.org/W1", "topics": []}]
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return httpx.Response(200, json={
            "id": "https://openalex.org/W1",
            "topics": [{"id": "https://openalex.org/T7", "display_name": "Memory"}],
        })

    client = _client(handler)
    discovery_recall.hydrate_anchor_topics(anchors, client=client, cache=cache)
    discovery_recall.hydrate_anchor_topics(anchors, client=client, cache=cache)
    client.close()
    assert calls["n"] == 1
    assert cache["p1"]["topics"][0]["display_name"] == "Memory"


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


def test_topic_fingerprint_combines_weight_across_library_anchors():
    anchors = [
        {"topics": [{"id": "https://openalex.org/T1", "display_name": "Memory", "score": .8}]},
        {"topics": [
            {"id": "https://openalex.org/T1", "display_name": "Memory", "score": .7},
            {"id": "https://openalex.org/T2", "display_name": "Networks", "score": .9},
        ]},
    ]
    topics = discovery_recall.topic_fingerprint(anchors)
    assert [t["id"] for t in topics[:2]] == ["T1", "T2"]
    assert topics[0]["score"] == 1.5


def test_topic_sweep_pages_with_a_date_frontier_and_returns_pending_updates():
    calls = []

    def handler(request):
        calls.append(request)
        cursor = request.url.params.get("cursor")
        row = {
            "id": f"https://openalex.org/W{len(calls)}", "title": f"Paper {len(calls)}",
            "publication_year": 2026, "cited_by_count": 3,
            "abstract_inverted_index": {"Fast": [0], "memory": [1]},
        }
        return httpx.Response(200, json={
            "results": [row], "meta": {"next_cursor": "next" if cursor == "*" else None},
        })

    client = _client(handler)
    rows, audit, updates = discovery_recall.sweep_topics(
        [{"topics": [{"id": "https://openalex.org/T7", "display_name": "Memory"}]}],
        client=client, frontier={"topics.id:T7": {"swept_to": "2026-06-30"}},
        today=date(2026, 7, 31))
    client.close()

    assert len(rows) == 2 and rows[0]["abstract"] == "Fast memory"
    assert all(row["channels"] == ["topic"] for row in rows)
    assert audit["pages"] == 2
    assert "from_publication_date:2026-07-01" in calls[0].url.params["filter"]
    assert updates == [{
        "key": "topics.id:T7", "swept_to": "2026-07-31", "from_date": "2026-07-01",
        "pages": 2, "topics": ["T7"],
    }]


def test_topic_sweep_combines_topics_under_one_total_page_budget():
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json={
            "results": [{
                "id": "W1", "title": "P", "cited_by_count": 1,
                "topics": [{"id": "https://openalex.org/T2"}],
            }],
            "meta": {"next_cursor": None},
        })

    client = _client(handler)
    rows, audit, updates = discovery_recall.sweep_topics(
        [{"topics": [
            {"id": "T1", "display_name": "Memory", "score": .9},
            {"id": "T2", "display_name": "Networks", "score": .8},
        ]}],
        client=client, frontier={}, today=date(2026, 7, 31))
    client.close()

    assert len(calls) == 1 and audit["pages"] == 1
    assert "topics.id:T1|T2" in calls[0].url.params["filter"]
    assert rows[0]["provenance"] == [{
        "channel": "topic", "topic_id": "T2", "topic": "Networks",
    }]
    assert updates[0]["key"] == "topics.id:T1|T2"
    assert updates[0]["topics"] == ["T1", "T2"]


def test_a_repeated_topic_cursor_stops_without_advancing_the_frontier():
    client = _client(lambda request: httpx.Response(200, json={
        "results": [{"id": "W1", "title": "P", "cited_by_count": 1}],
        "meta": {"next_cursor": "*"},
    }))
    _, audit, updates = discovery_recall.sweep_topics(
        [{"topics": [{"id": "T7", "display_name": "Memory"}]}], client=client,
        frontier={}, today=date(2026, 7, 31))
    client.close()

    assert audit["pages"] == 1
    assert updates == []
    assert any("repeated cursor" in item for item in audit["degraded"])


def test_a_truncated_topic_sweep_does_not_advance_the_frontier(monkeypatch):
    monkeypatch.setattr(discovery_recall, "MAX_TOPIC_PAGES", 1)
    client = _client(lambda request: httpx.Response(
        200, json={"results": [{"id": "W1", "title": "P", "cited_by_count": 1}],
                   "meta": {"next_cursor": "more"}}))
    _, audit, updates = discovery_recall.sweep_topics(
        [{"topics": [{"id": "T7", "display_name": "Memory"}]}], client=client,
        frontier={}, today=date(2026, 7, 31))
    client.close()
    assert updates == []
    assert any("frontier not advanced" in item for item in audit["degraded"])


def test_topic_cancellation_stops_before_the_next_cursor_page():
    cancelled = False
    calls = {"n": 0}

    def handler(request):
        nonlocal cancelled
        calls["n"] += 1
        cancelled = True
        return httpx.Response(200, json={
            "results": [{"id": "W1", "title": "P", "cited_by_count": 1}],
            "meta": {"next_cursor": "more"},
        })

    client = _client(handler)
    rows, audit, updates = discovery_recall.sweep_topics(
        [{"topics": [{"id": "T7", "display_name": "Memory"}]}], client=client,
        frontier={}, today=date(2026, 7, 31), should_cancel=lambda: cancelled)
    client.close()
    assert calls["n"] == 1 and len(rows) == 1
    assert audit["cancelled"] is True
    assert updates == []


def test_bulk_goal_search_keeps_lanes_independent_and_frontier_pending():
    seen = []

    def search(query, limit, *, from_date, should_cancel):
        seen.append((query, limit, from_date))
        return ([{"paper_id": query, "title": query}], {"pages": 1, "complete": True})

    rows, audit, updates = discovery_recall.bulk_goal_search(
        [{"search_terms": "memory systems"}, {"search_terms": "network fabrics"}],
        frontier={}, search_fn=search, today=date(2026, 7, 31))
    assert [row["channels"] for row in rows] == [["bulk"], ["bulk"]]
    assert {row["provenance"][0]["query"] for row in rows} == {
        "memory systems", "network fabrics"}
    assert audit["rows"] == 2 and len(updates) == 2
    assert all(item[2] == "2017-01-01" for item in seen)


def test_a_bulk_cap_does_not_advance_that_query_frontier():
    def truncated(query, limit, *, from_date, should_cancel):
        return ([{"paper_id": "p", "title": "P"}], {"pages": 2, "complete": False})

    _, audit, updates = discovery_recall.bulk_goal_search(
        [{"search_terms": "q"}], frontier={}, search_fn=truncated,
        today=date(2026, 7, 31))
    assert updates == []
    assert any("frontier not advanced" in item for item in audit["degraded"])


def test_wide_recall_runs_openalex_and_s2_in_parallel_without_fanning_out_s2():
    started = threading.Barrier(2, timeout=3)

    def handler(request):
        started.wait()
        return httpx.Response(200, json={"results": [], "meta": {"next_cursor": None}})

    def bulk(query, limit, *, from_date, should_cancel):
        started.wait()
        return [], {"pages": 1, "complete": True}

    client = _client(handler)
    _, audit, updates = discovery_recall.wide_recall(
        [{"topics": [{"id": "T7", "display_name": "Memory"}]}],
        [{"bulk_query": "memory systems"}], frontier={}, client=client,
        bulk_search_fn=bulk, today=date(2026, 7, 31))
    client.close()
    assert audit["topic"]["pages"] == 1
    assert audit["bulk"]["pages"] == 1
    assert len(updates) == 2
