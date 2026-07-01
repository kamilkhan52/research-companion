"""graph_layout: the server-side temporal layout. Y encodes time (recent toward the bottom),
X is force-directed. Deterministic and cheap so it runs on every build."""
from __future__ import annotations

from app import graph_layout


def _node(nid, *, year=None, arxiv=None, kind="external"):
    return {"id": nid, "kind": kind, "year": year, "arxiv_id": arxiv, "title": nid}


def test_year_parsed_from_arxiv_id():
    assert graph_layout._year_of({"arxiv_id": "2401.09670"}) == 2024
    assert graph_layout._year_of({"year": 2019, "arxiv_id": "1706.03762"}) == 2019
    assert graph_layout._year_of({"arxiv_id": "not-an-id"}) is None


def test_recent_papers_sit_below_older_ones():
    nodes = [_node("old", year=2005), _node("mid", year=2015), _node("new", year=2024)]
    edges = [{"source": "old", "target": "mid"}, {"source": "mid", "target": "new"}]
    graph_layout.compute_layout(nodes, edges)
    by_id = {n["id"]: n for n in nodes}
    # Larger y == lower on screen == more recent.
    assert by_id["old"]["y"] < by_id["mid"]["y"] < by_id["new"]["y"]
    assert all("x" in n and "y" in n for n in nodes)


def test_deterministic_across_runs():
    def run():
        ns = [_node(f"n{i}", year=2000 + i) for i in range(8)]
        graph_layout.compute_layout(ns, [{"source": "n0", "target": "n7"}])
        return [(n["x"], n["y"]) for n in ns]
    assert run() == run()


def test_empty_graph_is_safe():
    assert graph_layout.compute_layout([], []) == {"width": graph_layout.WIDTH, "height": graph_layout.HEIGHT}
