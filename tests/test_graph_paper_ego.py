"""The per-paper reference graph (ego view): a readable derived view over the built graph —
the paper centred, references to the left, in-project citers to the right, external citers as a
count. Pure function, no LLM/network."""
from __future__ import annotations

from app import graph


def _node(node_id: str, *, kind: str = "external", year: int | None = None,
          citation_count: int = 0) -> dict:
    return {"id": node_id, "kind": kind, "slug": node_id if kind == "project" else None,
            "title": node_id.title(), "year": year, "citation_count": citation_count,
            "authors": [], "venue": "", "arxiv_id": None, "doi": None, "url": None,
            "group": "G" if kind == "project" else None,
            "list_status": "read" if kind == "project" else None,
            "cited_by_project_count": 0, "significant_cited_by_count": 0, "cites_count": 0}


def _edge(source: str, target: str, *, significant: bool = False) -> dict:
    return {"source": source, "target": target, "significant": significant,
            "reason": "", "contexts": [], "confidence": 0.5}


def _graph(nodes: list[dict], edges: list[dict]) -> dict:
    return {"nodes": nodes, "edges": edges}


def test_ego_places_references_left_and_citers_right_of_the_centre():
    g = _graph(
        [_node("p", kind="project"), _node("r1"), _node("r2"),
         _node("c1", kind="project"), _node("c2", kind="project")],
        [_edge("p", "r1"), _edge("p", "r2"),       # p references r1, r2
         _edge("c1", "p"), _edge("c2", "p")],       # c1, c2 cite p
    )
    ego = graph.paper_ego(g, "p")
    assert ego["center_id"] == "p"
    assert ego["references_count"] == 2 and ego["citers_count"] == 2
    pos = {n["id"]: (n["x"], n["y"]) for n in ego["nodes"]}
    assert pos["p"] == (0.0, 0.0)
    assert pos["r1"][0] < 0 and pos["r2"][0] < 0     # references left
    assert pos["c1"][0] > 0 and pos["c2"][0] > 0     # citers right
    # Only the ego edges, and every edge touches the centre.
    assert len(ego["edges"]) == 4
    assert all(e["source"] == "p" or e["target"] == "p" for e in ego["edges"])


def test_ego_returns_none_for_a_non_project_or_missing_paper():
    g = _graph([_node("p", kind="project"), _node("x")], [])
    assert graph.paper_ego(g, "x") is None          # external node, not a project paper
    assert graph.paper_ego(g, "missing") is None
    assert graph.paper_ego(None, "p") is None
    assert graph.paper_ego({"nodes": []}, "p") is None


def test_significant_citations_and_impact_sort_to_the_top_and_survive_the_cap():
    # More references than the cap; one significant + high-impact ref must be kept and ranked
    # ahead of the incidental majority.
    edges = [_edge("p", f"r{i}") for i in range(graph.EGO_MAX_PER_SIDE + 5)]
    edges.append(_edge("p", "star", significant=True))
    nodes = [_node("p", kind="project"), _node("star", citation_count=9999)]
    nodes += [_node(f"r{i}") for i in range(graph.EGO_MAX_PER_SIDE + 5)]
    ego = graph.paper_ego(_graph(nodes, edges), "p")

    assert ego["references_count"] == graph.EGO_MAX_PER_SIDE + 6
    assert ego["capped"] is True
    ref_ids = [n["id"] for n in ego["nodes"] if n["x"] < 0]
    assert len(ref_ids) == graph.EGO_MAX_PER_SIDE          # capped to the readable maximum
    assert "star" in ref_ids                               # the significant one survived
    # The column NEAREST the centre (least-negative x for a left side) holds the most
    # significant, and its top row (smallest y) is the single most significant reference.
    ref_nodes = [n for n in ego["nodes"] if n["x"] < 0]
    nearest_x = max(n["x"] for n in ref_nodes)
    top_of_nearest = min((n for n in ref_nodes if n["x"] == nearest_x), key=lambda n: n["y"])
    assert top_of_nearest["id"] == "star"


def test_external_citer_count_reads_the_forward_substrate():
    g = _graph([_node("p", kind="project")], [])
    forward = {"p": {"citers": ["W1", "W2"], "s2_citers": ["abc", "W2"]}}  # W2 dedupes
    ego = graph.paper_ego(g, "p", forward)
    assert ego["external_citer_count"] == 3
    # No forward record at all is "not scanned" (null), distinct from a scan that found zero.
    assert graph.paper_ego(g, "p", {})["external_citer_count"] is None
    assert graph.paper_ego(g, "p", {"p": {"citers": []}})["external_citer_count"] == 0


# --- the route wrapper -----------------------------------------------------------------------

def test_paper_graph_route_returns_the_ego_for_a_built_project_paper(temp_project):
    from app import graph_store
    from app.routers import graph as graph_routes

    from tests.conftest import add_paper

    add_paper("test-project", "p", "Center Paper")
    data = graph_store.load()
    data["graph"] = {"nodes": [_node("p", kind="project"), _node("r1")],
                     "edges": [_edge("p", "r1")]}
    data["forward"] = {"p": {"s2_citers": ["a", "b"]}}
    graph_store.save(data)

    out = graph_routes.get_paper_graph("test-project", "p")
    assert out["ego"]["center_id"] == "p"
    assert out["ego"]["references_count"] == 1
    assert out["ego"]["external_citer_count"] == 2
    assert out["build"] is None

    # A slug that isn't a built project node → ego null (the client shows an offer, not an error).
    assert graph_routes.get_paper_graph("test-project", "missing")["ego"] is None


def test_a_mutual_citation_and_a_self_loop_never_duplicate_a_node():
    """P references X and X cites P (mutual), plus a self-loop P->P: X appears once (on the
    reference side, tie to references), the self-loop never re-adds the centre, and no node id
    repeats — a duplicate would collide as a React key on the canvas and lay out twice."""
    g = _graph(
        [_node("p", kind="project"), _node("x", kind="project")],
        [_edge("p", "x"), _edge("x", "p"), _edge("p", "p")],
    )
    ego = graph.paper_ego(g, "p")
    ids = [n["id"] for n in ego["nodes"]]
    assert len(ids) == len(set(ids))                    # no duplicate node ids
    assert ids.count("p") == 1                           # self-loop didn't re-add the centre
    x = next(n for n in ego["nodes"] if n["id"] == "x")
    assert x["x"] < 0                                    # placed once, on the reference side
