"""U.19 — overlay_membership: node membership re-derived from the live reading list at read
time, so papers added/removed since the last build color correctly without a rebuild. Pure
function of a stored snapshot + the current papers; no LLM, no I/O."""
from __future__ import annotations

from app.graph import overlay_membership
from app.models import Paper


def paper(slug: str, title: str, *, arxiv_id: str = "", group: str = "Serving",
          list_status: str = "unread") -> Paper:
    return Paper(slug=slug, title=title, group=group, list_status=list_status,
                 arxiv_id=arxiv_id)


def project_node(slug: str, title: str) -> dict:
    return {"id": slug, "kind": "project", "slug": slug, "title": title,
            "arxiv_id": None, "group": "Serving", "list_status": "unread",
            "cited_by_project_count": 3}


def external_node(node_id: str, title: str, *, arxiv_id: str | None = None) -> dict:
    return {"id": node_id, "kind": "external", "slug": None, "title": title,
            "arxiv_id": arxiv_id, "group": None, "list_status": None,
            "cited_by_project_count": 2}


def test_external_node_matching_a_newly_added_paper_becomes_project():
    graph = {"nodes": [external_node("ext:kivi", "KIVI: A Tuning-Free 2bit KV Cache "
                                     "Quantization Method", arxiv_id="2402.02750v2")],
             "edges": []}
    papers = [paper("kivi", "KIVI: A Tuning-Free 2bit KV Cache Quantization Method",
                    arxiv_id="2402.02750")]
    out = overlay_membership(graph, papers)
    node = out["nodes"][0]
    assert node["kind"] == "project"
    assert node["slug"] == "kivi"
    assert node["group"] == "Serving"
    assert node["list_status"] == "unread"


def test_external_node_matches_by_exact_title_without_an_id():
    graph = {"nodes": [external_node("ext:t", "Efficient Memory Management for LLM Serving")],
             "edges": []}
    papers = [paper("paged", "Efficient Memory Management for LLM Serving")]
    out = overlay_membership(graph, papers)
    assert out["nodes"][0]["kind"] == "project"
    assert out["nodes"][0]["slug"] == "paged"


def test_project_node_for_a_removed_paper_becomes_external():
    graph = {"nodes": [project_node("gone", "A Removed Paper")], "edges": []}
    out = overlay_membership(graph, [])
    node = out["nodes"][0]
    assert node["kind"] == "external"
    assert node["slug"] is None
    assert node["list_status"] is None
    # The id survives so stored edges keep resolving.
    assert node["id"] == "gone"


def test_project_node_status_refreshes_from_the_live_list():
    graph = {"nodes": [project_node("kept", "A Kept Paper")], "edges": []}
    out = overlay_membership(graph, [paper("kept", "A Kept Paper", list_status="read")])
    assert out["nodes"][0]["list_status"] == "read"
    assert out["nodes"][0]["kind"] == "project"


def test_counts_layout_and_stored_snapshot_are_untouched():
    stored = {"nodes": [external_node("ext:kivi", "KIVI Paper", arxiv_id="2402.02750")],
              "edges": [{"source": "a", "target": "ext:kivi"}],
              "layout": {"algo": "semantic-v2"}}
    out = overlay_membership(stored, [paper("kivi", "KIVI Paper", arxiv_id="2402.02750")])
    # Counts ride along unchanged; edges/layout are the same objects.
    assert out["nodes"][0]["cited_by_project_count"] == 2
    assert out["edges"] == stored["edges"]
    assert out["layout"] == stored["layout"]
    # The stored snapshot itself was not mutated (it must never be persisted overlaid).
    assert stored["nodes"][0]["kind"] == "external"


def test_empty_or_missing_graph_passes_through():
    assert overlay_membership(None, []) is None
    assert overlay_membership({"nodes": []}, []) == {"nodes": []}
