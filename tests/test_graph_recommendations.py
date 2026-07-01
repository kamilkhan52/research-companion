"""score_recommendations / _bridge_score: pure ranking logic, no LLM."""
from __future__ import annotations

from app.graph import _bridge_score, score_recommendations


def ext_node(id_: str, cited_by: int, sig: int) -> dict:
    return {"id": id_, "kind": "external", "title": id_, "cited_by_project_count": cited_by,
            "significant_cited_by_count": sig}


def edge(source: str, target: str, significant: bool = False) -> dict:
    return {"source": source, "target": target, "significant": significant}


def test_uncited_external_nodes_are_excluded():
    nodes = [ext_node("ext:a", 0, 0)]
    out = score_recommendations(nodes, [], project_paper_count=3)
    assert out == []


def test_significant_citation_outranks_plain_citation_at_equal_cited_by_count():
    # Isolate the significance weighting: same cited_by count, same single citer (so bridge
    # is 0 for both and doesn't confound the comparison) — only significance differs.
    nodes = [ext_node("ext:sig", 1, 1), ext_node("ext:plain", 1, 0)]
    edges = [edge("p1", "ext:sig", significant=True), edge("p1", "ext:plain")]
    out = score_recommendations(nodes, edges, project_paper_count=3)
    scores = {n["id"]: n["recommend_score"] for n in out}
    assert scores["ext:sig"] > scores["ext:plain"]


def test_recommendations_sorted_descending():
    nodes = [ext_node("ext:low", 1, 0), ext_node("ext:high", 3, 2)]
    edges = [edge("p1", "ext:low"),
             edge("p1", "ext:high"), edge("p2", "ext:high", True), edge("p3", "ext:high", True)]
    out = score_recommendations(nodes, edges, project_paper_count=3)
    assert [n["id"] for n in out] == ["ext:high", "ext:low"]


def test_reasons_mention_citation_count_and_significance():
    nodes = [ext_node("ext:x", 2, 1)]
    edges = [edge("p1", "ext:x", True), edge("p2", "ext:x")]
    out = score_recommendations(nodes, edges, project_paper_count=5)
    reasons = " ".join(out[0]["recommend_reasons"])
    assert "2 of 5" in reasons
    assert "significantly" in reasons


def test_bridge_score_zero_for_single_citer():
    edges = [edge("p1", "ext:x")]
    assert _bridge_score("ext:x", edges) == 0.0


def test_bridge_score_high_when_citers_dont_overlap():
    # p1 and p2 cite ext:x but share no other external references -> good bridge.
    edges = [
        edge("p1", "ext:x"), edge("p1", "ext:a"),
        edge("p2", "ext:x"), edge("p2", "ext:b"),
    ]
    score = _bridge_score("ext:x", edges)
    assert score > 1.5  # 2 citers * (1 - 0 overlap)


def test_bridge_score_low_when_citers_fully_overlap():
    # p1 and p2 cite the exact same set of externals -> ext:x isn't really "bridging" anything.
    edges = [
        edge("p1", "ext:x"), edge("p1", "ext:a"),
        edge("p2", "ext:x"), edge("p2", "ext:a"),
    ]
    score = _bridge_score("ext:x", edges)
    assert score == 0.0


def test_bridge_reason_appears_only_above_threshold():
    nodes = [ext_node("ext:bridge", 2, 0)]
    edges = [edge("p1", "ext:bridge"), edge("p1", "ext:only-a"),
             edge("p2", "ext:bridge"), edge("p2", "ext:only-b")]
    out = score_recommendations(nodes, edges, project_paper_count=4)
    assert any("Bridges" in r for r in out[0]["recommend_reasons"])
