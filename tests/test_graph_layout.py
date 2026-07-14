"""graph_layout: the server-side semantic layout (U.8). X encodes time (newer toward the
right), Y encodes citation impact (more-cited toward the top, unknowns in a bottom band).
Deterministic and cheap so it runs on every build."""
from __future__ import annotations

from app import graph_layout


def _node(nid, *, year=None, arxiv=None, kind="external", citations=None):
    return {"id": nid, "kind": kind, "year": year, "arxiv_id": arxiv, "title": nid,
            "citation_count": citations}


def test_year_parsed_from_arxiv_id():
    assert graph_layout._year_of({"arxiv_id": "2401.09670"}) == 2024
    assert graph_layout._year_of({"year": 2019, "arxiv_id": "1706.03762"}) == 2019
    assert graph_layout._year_of({"arxiv_id": "not-an-id"}) is None


def test_recent_papers_sit_right_of_older_ones():
    nodes = [_node("old", year=2005), _node("mid", year=2015), _node("new", year=2024)]
    edges = [{"source": "old", "target": "mid"}, {"source": "mid", "target": "new"}]
    graph_layout.compute_layout(nodes, edges)
    by_id = {n["id"]: n for n in nodes}
    # Larger x == further right == more recent (rule 1).
    assert by_id["old"]["x"] < by_id["mid"]["x"] < by_id["new"]["x"]
    assert all("x" in n and "y" in n for n in nodes)


def test_more_cited_papers_sit_above_less_cited_ones():
    nodes = [
        _node("landmark", year=2017, citations=50_000),
        _node("solid", year=2017, citations=400),
        _node("fresh", year=2017, citations=3),
    ]
    graph_layout.compute_layout(nodes, [])
    by_id = {n["id"]: n for n in nodes}
    # Smaller y == higher on screen == more cited (rule 2).
    assert by_id["landmark"]["y"] < by_id["solid"]["y"] < by_id["fresh"]["y"]


def test_unknown_citations_sit_in_the_bottom_band():
    nodes = [_node("ranked", year=2020, citations=0), _node("unknown", year=2020)]
    graph_layout.compute_layout(nodes, [])
    by_id = {n["id"]: n for n in nodes}
    # Even a zero-citation RANKED node sits above the unranked band.
    assert by_id["ranked"]["y"] < by_id["unknown"]["y"]
    band_top = graph_layout.HEIGHT - graph_layout._MARGIN - graph_layout._UNRANKED_BAND
    assert by_id["unknown"]["y"] > band_top - 1


def test_undated_nodes_inherit_their_neighbors_timeframe():
    nodes = [
        _node("old", year=2005, citations=10),
        _node("new", year=2024, citations=10),
        _node("mystery", citations=10),
    ]
    edges = [{"source": "new", "target": "mystery"}]
    graph_layout.compute_layout(nodes, edges)
    by_id = {n["id"]: n for n in nodes}
    # The undated node sits near its (recent) citing neighbor, not in a special band.
    assert abs(by_id["mystery"]["x"] - by_id["new"]["x"]) < abs(by_id["mystery"]["x"] - by_id["old"]["x"])


def test_same_year_same_citations_do_not_overlap():
    nodes = [_node(f"n{i}", year=2024, citations=100) for i in range(12)]
    graph_layout.compute_layout(nodes, [])
    for i in range(len(nodes)):
        for j in range(i + 1, len(nodes)):
            dx = nodes[i]["x"] - nodes[j]["x"]
            dy = nodes[i]["y"] - nodes[j]["y"]
            assert (dx * dx + dy * dy) ** 0.5 > 30.0


def test_deterministic_across_runs():
    def run():
        ns = [_node(f"n{i}", year=2000 + i, citations=i * 10) for i in range(8)]
        graph_layout.compute_layout(ns, [{"source": "n0", "target": "n7"}])
        return [(n["x"], n["y"]) for n in ns]
    assert run() == run()


def test_empty_graph_is_safe():
    assert graph_layout.compute_layout([], []) == {
        "width": graph_layout.WIDTH, "height": graph_layout.HEIGHT, "algo": graph_layout.LAYOUT_ALGO,
    }


def test_crowded_unknowns_stay_inside_the_unranked_band():
    """Collision relief must not falsify the Y axis: a pile of unknown-citation nodes may
    spread along X, but never escape upward past the band boundary into ranked territory."""
    nodes = [_node(f"u{i}", year=2024) for i in range(14)]
    nodes.append(_node("zero", year=2024, citations=0))
    graph_layout.compute_layout(nodes, [])
    band_top = graph_layout.HEIGHT - graph_layout._MARGIN - graph_layout._UNRANKED_BAND
    by_id = {n["id"]: n for n in nodes}
    for n in nodes:
        if n["id"] != "zero":
            assert n["y"] >= band_top - 0.1
    # And the ranked zero-citation node stays above every unranked one.
    assert by_id["zero"]["y"] < min(n["y"] for n in nodes if n["id"] != "zero")


def test_layout_is_stamped_with_the_algo_marker():
    nodes = [_node("a", year=2020, citations=5)]
    layout = graph_layout.compute_layout(nodes, [])
    assert layout["algo"] == "semantic-v2"


def test_dense_unknown_cohorts_pack_without_breaking_time_order():
    """Round-2 review stress case: 20 unknown-citation nodes per year across many years must
    neither overlap, nor escape the unranked band upward, nor invert year ordering in X."""
    nodes = []
    for year in range(2015, 2025):
        nodes.extend(_node(f"u{year}-{i}", year=year) for i in range(20))
    layout = graph_layout.compute_layout(nodes, [])

    band_top = graph_layout.HEIGHT - graph_layout._MARGIN - graph_layout._UNRANKED_BAND
    by_year_max_x = {}
    by_year_min_x = {}
    for n in nodes:
        year = int(n["id"][1:5])
        by_year_max_x[year] = max(by_year_max_x.get(year, -1e9), n["x"])
        by_year_min_x[year] = min(by_year_min_x.get(year, 1e9), n["x"])
        assert n["y"] >= band_top  # never escapes upward into ranked territory
    # X ordering: every node of year Y sits left of every node of year Y+1.
    for year in range(2015, 2024):
        assert by_year_max_x[year] < by_year_min_x[year + 1]
    # No overlapping pairs.
    pts = [(n["x"], n["y"]) for n in nodes]
    for i in range(len(pts)):
        for j in range(i + 1, len(pts)):
            dx = pts[i][0] - pts[j][0]
            dy = pts[i][1] - pts[j][1]
            assert (dx * dx + dy * dy) ** 0.5 > 30.0
    # The band grew the canvas downward instead of overflowing.
    assert layout["height"] > graph_layout.HEIGHT
    assert max(p[1] for p in pts) < layout["height"]


def test_dense_ranked_cohorts_pack_without_overlap():
    """Round-3 review stress case: 50 same-year nodes with the SAME citation count (common for
    recent zero-cited references) must never overlap — packing, not relaxation, guarantees it."""
    nodes = [_node(f"r{i}", year=2024, citations=100) for i in range(50)]
    nodes.extend(_node(f"o{i}", year=2023, citations=100) for i in range(50))
    graph_layout.compute_layout(nodes, [])
    pts = [(n["x"], n["y"]) for n in nodes]
    for i in range(len(pts)):
        for j in range(i + 1, len(pts)):
            dx = pts[i][0] - pts[j][0]
            dy = pts[i][1] - pts[j][1]
            assert (dx * dx + dy * dy) ** 0.5 >= 50.0
    # Year ordering still strict.
    assert max(n["x"] for n in nodes if n["id"].startswith("o")) < min(
        n["x"] for n in nodes if n["id"].startswith("r"))
