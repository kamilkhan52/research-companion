"""related_works_for: the per-paper 'Related works' menu — significant edges only, both
directions, ranked by how load-bearing the work is, capped."""
from __future__ import annotations

from app import graph, graph_store


def _seed_graph(nodes, edges):
    data = graph_store.load()
    data["graph"] = {"built_at": "t", "model": "m", "nodes": nodes, "edges": edges}
    graph_store.save(data)


def _n(nid, kind="external", **kw):
    base = {"id": nid, "kind": kind, "slug": nid if kind == "project" else None,
            "title": f"Paper {nid}", "year": 2020, "venue": "", "arxiv_id": None, "url": None,
            "list_status": "unread" if kind == "project" else None,
            "cited_by_project_count": 0, "citation_count": None}
    base.update(kw)
    return base


def test_related_includes_both_directions_and_only_significant(temp_project):
    _seed_graph(
        [_n("p", kind="project"), _n("q", kind="project"), _n("ext:a"), _n("ext:b")],
        [
            {"source": "p", "target": "ext:a", "significant": True, "reason": "baseline"},
            {"source": "p", "target": "ext:b", "significant": False, "reason": "passing mention"},
            {"source": "q", "target": "p", "significant": True, "reason": "extends the method"},
        ])
    rel = graph.related_works_for("p")
    ids = [(r["id"], r["direction"]) for r in rel]
    assert ("ext:a", "builds_on") in ids
    assert ("q", "built_on_by") in ids
    assert all(r["id"] != "ext:b" for r in rel)  # non-significant edge excluded
    a = next(r for r in rel if r["id"] == "ext:a")
    assert a["reason"] == "baseline"


def test_related_ranked_and_capped(temp_project):
    nodes = [_n("p", kind="project")]
    edges = []
    for i in range(10):
        nodes.append(_n(f"ext:{i}", cited_by_project_count=i, citation_count=i * 100))
        edges.append({"source": "p", "target": f"ext:{i}", "significant": True, "reason": "r"})
    _seed_graph(nodes, edges)
    rel = graph.related_works_for("p", limit=5)
    assert len(rel) == 5
    # most load-bearing (highest in-project citation breadth) first
    assert rel[0]["id"] == "ext:9"


def test_related_empty_without_graph(temp_project):
    assert graph.related_works_for("p") == []
