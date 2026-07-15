"""build_nodes_and_edges: pure function of cached extractions -> (nodes, edges). No LLM."""
from __future__ import annotations

from app.graph import build_nodes_and_edges
from app.models import Paper


def paper(slug: str, title: str) -> Paper:
    return Paper(slug=slug, title=title, group="Serving", list_status="unread")


def done(refs: list[dict]) -> dict:
    return {"status": "done", "references": refs}


def test_in_project_citation_becomes_a_project_to_project_edge():
    papers = [paper("distserve", "DistServe: Disaggregating Prefill and Decoding"),
              paper("splitwise", "Splitwise: Efficient Generative LLM Inference")]
    extractions = {
        "distserve": done([{"title": "Splitwise: Efficient Generative LLM Inference",
                            "significant": True, "significance_reason": "concurrent work"}]),
        "splitwise": done([]),
    }
    nodes, edges = build_nodes_and_edges(papers, extractions)
    assert len(edges) == 1
    edge = edges[0]
    assert edge["source"] == "distserve"
    assert edge["target"] == "splitwise"
    assert edge["significant"] is True
    # No stray external node should be created for a reference that matched a project paper.
    assert not any(n["kind"] == "external" for n in nodes)


def test_external_citation_creates_external_node_and_edge():
    papers = [paper("distserve", "DistServe: Disaggregating Prefill and Decoding")]
    extractions = {"distserve": done([{"title": "Attention Is All You Need", "arxiv_id": "1706.03762",
                                        "significant": False}])}
    nodes, edges = build_nodes_and_edges(papers, extractions)
    ext_nodes = [n for n in nodes if n["kind"] == "external"]
    assert len(ext_nodes) == 1
    assert ext_nodes[0]["id"] == "ext:arxiv:1706.03762"
    assert edges[0]["target"] == ext_nodes[0]["id"]


def test_same_external_paper_cited_by_two_papers_dedupes_to_one_node():
    papers = [paper("distserve", "DistServe"), paper("splitwise", "Splitwise")]
    extractions = {
        "distserve": done([{"title": "PagedAttention", "arxiv_id": "2309.06180", "significant": True}]),
        "splitwise": done([{"title": "pagedattention.", "arxiv_id": "2309.06180", "significant": False}]),
    }
    nodes, edges = build_nodes_and_edges(papers, extractions)
    ext_nodes = [n for n in nodes if n["kind"] == "external"]
    assert len(ext_nodes) == 1
    node = ext_nodes[0]
    assert node["cited_by_project_count"] == 2
    assert node["significant_cited_by_count"] == 1  # only one of the two citations was significant
    assert len(edges) == 2


def test_dedupe_by_title_when_no_arxiv_id_present():
    papers = [paper("a", "Paper A"), paper("b", "Paper B")]
    extractions = {
        "a": done([{"title": "Some External Work", "significant": True}]),
        "b": done([{"title": "some external work", "significant": True}]),
    }
    nodes, edges = build_nodes_and_edges(papers, extractions)
    ext_nodes = [n for n in nodes if n["kind"] == "external"]
    assert len(ext_nodes) == 1
    assert ext_nodes[0]["cited_by_project_count"] == 2


def test_external_node_fields_fill_gaps_from_later_richer_mention():
    papers = [paper("a", "Paper A"), paper("b", "Paper B")]
    extractions = {
        "a": done([{"title": "External Work", "significant": False}]),  # no year/venue
        "b": done([{"title": "External Work", "year": 2023, "venue": "OSDI", "significant": True}]),
    }
    nodes, edges = build_nodes_and_edges(papers, extractions)
    ext = next(n for n in nodes if n["kind"] == "external")
    assert ext["year"] == 2023
    assert ext["venue"] == "OSDI"


def test_errored_extraction_contributes_no_edges():
    papers = [paper("a", "Paper A")]
    extractions = {"a": {"status": "error", "references": [{"title": "Should be ignored"}]}}
    nodes, edges = build_nodes_and_edges(papers, extractions)
    assert edges == []
    assert not any(n["kind"] == "external" for n in nodes)


def test_cites_count_and_cited_by_count_are_consistent():
    papers = [paper("a", "Paper A"), paper("b", "Paper B"), paper("c", "Paper C")]
    extractions = {
        "a": done([{"title": "Paper B", "significant": True}, {"title": "Paper C", "significant": False}]),
        "b": done([{"title": "Paper C", "significant": True}]),
        "c": done([]),
    }
    nodes, edges = build_nodes_and_edges(papers, extractions)
    by_id = {n["id"]: n for n in nodes}
    assert by_id["a"]["cites_count"] == 2
    assert by_id["b"]["cites_count"] == 1
    assert by_id["c"]["cited_by_project_count"] == 2
    assert by_id["c"]["significant_cited_by_count"] == 1
    assert by_id["b"]["cited_by_project_count"] == 1
    assert len(edges) == 3


def test_same_paper_citing_the_same_target_twice_merges_into_one_edge():
    # Observed live on a real paper: two separate bibliography entries (e.g. an arXiv preprint
    # + its conference version) can both fuzzy-match the same in-project paper. That must not
    # show up as the citing paper "citing itself twice" in the graph.
    papers = [paper("distserve", "DistServe"), paper("vllm", "vLLM: PagedAttention")]
    extractions = {
        "distserve": done([
            {"title": "vLLM: PagedAttention", "significant": False, "contexts": ["mentioned once"]},
            {"title": "vLLM: PagedAttention", "significant": True,
             "significance_reason": "used as the primary baseline", "contexts": ["used as baseline"]},
        ]),
    }
    nodes, edges = build_nodes_and_edges(papers, extractions)
    assert len(edges) == 1
    edge = edges[0]
    assert edge["significant"] is True  # either mention being significant wins
    assert edge["reason"] == "used as the primary baseline"
    assert "mentioned once" in edge["contexts"] and "used as baseline" in edge["contexts"]
    by_id = {n["id"]: n for n in nodes}
    assert by_id["distserve"]["cites_count"] == 1  # one relationship, not two
    assert by_id["vllm"]["cited_by_project_count"] == 1
    assert by_id["vllm"]["significant_cited_by_count"] == 1


def test_duplicate_citations_to_an_external_node_also_merge():
    papers = [paper("a", "Paper A")]
    extractions = {
        "a": done([
            {"title": "Some External Work", "arxiv_id": "1234.5678", "significant": False},
            {"title": "some external work.", "arxiv_id": "1234.5678", "significant": True},
        ]),
    }
    nodes, edges = build_nodes_and_edges(papers, extractions)
    assert len(edges) == 1
    assert edges[0]["significant"] is True
    ext = next(n for n in nodes if n["kind"] == "external")
    assert ext["cited_by_project_count"] == 1
    assert ext["significant_cited_by_count"] == 1


def test_project_nodes_carry_the_entry_year():
    """U.18 — the reading-list year (explicit comment or arXiv id) dates the project node, so
    the semantic layout's timeline axis works for non-arXiv papers too."""
    p = Paper(slug="osdi-paper", title="An OSDI Paper", group="Serving",
              list_status="unread", year=2019)
    nodes, _edges = build_nodes_and_edges([p], {"osdi-paper": done([])})
    node = next(nd for nd in nodes if nd["id"] == "osdi-paper")
    assert node["year"] == 2019


def test_project_node_year_gap_fills_from_citing_bibliographies():
    """U.18/U.20 — an undated project paper (no arXiv id, no year comment) is dated by the
    references that cite it, so the timeline X axis can place it."""
    papers = [paper("citing", "A Citing Paper"),
              paper("attention", "Attention Is All You Need")]
    extractions = {
        "citing": done([{"title": "Attention Is All You Need", "year": 2017}]),
        "attention": done([]),
    }
    nodes, _edges = build_nodes_and_edges(papers, extractions)
    node = next(nd for nd in nodes if nd["id"] == "attention")
    assert node["year"] == 2017
