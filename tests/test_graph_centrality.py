"""betweenness_centrality: Brandes' algorithm, verified against known textbook results.
No LLM, no filesystem -- pure graph math."""
from __future__ import annotations

from app.graph import betweenness_centrality, score_recommendations


def test_path_graph_middle_node_has_betweenness_one():
    # A-B-C: B lies on the unique shortest path between A and C. Textbook result: B=1.0.
    bc = betweenness_centrality(["A", "B", "C"], [("A", "B"), ("B", "C")])
    assert bc == {"A": 0.0, "B": 1.0, "C": 0.0}


def test_star_graph_center_betweenness_equals_pairs_of_leaves():
    # Center X with 4 leaves: every pair of leaves' shortest path routes through X.
    # C(4,2) = 6 pairs -> center betweenness = 6.0 (textbook result for a star graph).
    nodes = ["X", "a", "b", "c", "d"]
    edges = [("X", "a"), ("X", "b"), ("X", "c"), ("X", "d")]
    bc = betweenness_centrality(nodes, edges)
    assert bc["X"] == 6.0
    assert all(bc[leaf] == 0.0 for leaf in ("a", "b", "c", "d"))


def test_disconnected_triangles_have_zero_betweenness_everywhere():
    # A triangle is a complete graph on 3 nodes -- no node is ever strictly "between" the
    # other two (they're all directly connected), and there's no path BETWEEN components.
    nodes = ["A", "B", "C", "D", "E", "F"]
    edges = [("A", "B"), ("B", "C"), ("A", "C"), ("D", "E"), ("E", "F"), ("D", "F")]
    bc = betweenness_centrality(nodes, edges)
    assert all(v == 0.0 for v in bc.values())


def test_longer_path_middle_nodes_score_higher_than_near_ends():
    # A-B-C-D-E: centrality should increase toward the middle and be symmetric.
    nodes = ["A", "B", "C", "D", "E"]
    edges = [("A", "B"), ("B", "C"), ("C", "D"), ("D", "E")]
    bc = betweenness_centrality(nodes, edges)
    assert bc["A"] == bc["E"] == 0.0
    assert bc["B"] == bc["D"]
    assert bc["C"] > bc["B"] > bc["A"]


def test_ignores_edges_referencing_unknown_nodes():
    bc = betweenness_centrality(["A", "B"], [("A", "B"), ("A", "ghost"), ("ghost", "other")])
    assert set(bc.keys()) == {"A", "B"}


def test_ignores_self_loops():
    bc = betweenness_centrality(["A", "B"], [("A", "A"), ("A", "B")])
    assert bc == {"A": 0.0, "B": 0.0}  # a 2-node graph has no room for betweenness anyway


def test_duplicate_edges_do_not_double_count():
    # (A,B) and (B,A) are the same undirected edge; listing it twice shouldn't change the
    # graph's shape.
    bc_once = betweenness_centrality(["A", "B", "C"], [("A", "B"), ("B", "C")])
    bc_dup = betweenness_centrality(["A", "B", "C"], [("A", "B"), ("B", "A"), ("B", "C")])
    assert bc_once == bc_dup


def test_empty_graph_returns_zeros():
    assert betweenness_centrality([], []) == {}
    assert betweenness_centrality(["A"], []) == {"A": 0.0}


# ---------- integration: centrality feeds score_recommendations ----------

def ext_node(id_: str, cited_by: int, sig: int) -> dict:
    return {"id": id_, "kind": "external", "title": id_, "cited_by_project_count": cited_by,
            "significant_cited_by_count": sig}


def edge(source: str, target: str, significant: bool = False) -> dict:
    return {"source": source, "target": target, "significant": significant}


def test_high_centrality_node_gets_the_reason_and_a_higher_score():
    # ext:hub sits between two otherwise-unconnected clusters of citers; ext:leaf is cited
    # by just one paper with no bridging role at all.
    nodes = [ext_node("ext:hub", 2, 0), ext_node("ext:leaf", 1, 0)]
    edges = [
        edge("p1", "ext:hub"), edge("p1", "ext:only-a"),
        edge("p2", "ext:hub"), edge("p2", "ext:only-b"),
        edge("p3", "ext:leaf"),
    ]
    out = score_recommendations(nodes, edges, project_paper_count=3)
    by_id = {n["id"]: n for n in out}
    assert by_id["ext:hub"]["betweenness_centrality"] >= by_id["ext:leaf"]["betweenness_centrality"]
    assert by_id["ext:hub"]["recommend_score"] > by_id["ext:leaf"]["recommend_score"]


def test_betweenness_centrality_field_is_always_present_and_bounded():
    nodes = [ext_node("ext:x", 1, 0)]
    edges = [edge("p1", "ext:x")]
    out = score_recommendations(nodes, edges, project_paper_count=1)
    assert 0.0 <= out[0]["betweenness_centrality"] <= 1.0
