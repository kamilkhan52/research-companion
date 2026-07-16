"""U.9 v1 — author_board: the ranked in-project author aggregation. Pure function of a
stored graph snapshot + the OpenAlex cache; no LLM, no network."""
from __future__ import annotations

from app.graph import AUTHOR_EXPLAINERS, author_board


def project_node(node_id, authors, *, significant=0, year=None):
    return {"id": node_id, "kind": "project", "slug": node_id, "title": node_id.title(),
            "authors": authors, "significant_cited_by_count": significant, "year": year}


def external_node(node_id, authors, *, year=None):
    return {"id": node_id, "kind": "external", "slug": None, "title": node_id,
            "authors": authors, "year": year}


def test_activity_weights_are_3_2_1():
    graph = {"nodes": [
        project_node("awq", ["Song Han"], significant=2, year=2023),
        project_node("smoothquant", ["Song Han"], significant=1, year=2022),
        external_node("ext:streaming", ["Song Han"], year=2023),
    ]}
    [entry] = author_board(graph, {})
    assert entry["in_project_count"] == 2
    assert entry["significant_count"] == 3
    assert entry["external_count"] == 1
    assert entry["activity"] == 3 * 2 + 2 * 3 + 1
    assert entry["active_years"] == [2022, 2023]


def test_external_only_authors_are_excluded_in_v1():
    graph = {"nodes": [
        project_node("awq", ["Song Han"]),
        external_node("ext:gpt", ["Famous Outsider"]),
    ]}
    board = author_board(graph, {})
    assert [e["name"] for e in board] == ["Song Han"]


def test_affiliation_comes_from_the_openalex_cache_and_absent_stays_empty():
    graph = {"nodes": [project_node("awq", ["Ji Lin", "Song Han"])]}
    cache = {"awq": {"status": "done", "authorships": [
        {"name": "Ji Lin", "affiliation": "MIT"},
        {"name": "Song Han", "affiliation": ""},
    ]}}
    board = author_board(graph, cache)
    by_name = {e["name"]: e for e in board}
    assert by_name["Ji Lin"]["affiliation"] == "MIT"
    assert by_name["Song Han"]["affiliation"] == ""


def test_name_dedup_tolerates_periods_and_case_but_not_initials():
    graph = {"nodes": [
        project_node("a", ["Song Han"]),
        project_node("b", ["song  han"]),      # same person, sloppy source
        project_node("c", ["S. Han"]),         # NOT merged — initials are ambiguous
    ]}
    board = author_board(graph, {})
    assert {e["name"] for e in board} == {"Song Han", "S. Han"}
    assert next(e for e in board if e["name"] == "Song Han")["in_project_count"] == 2


def test_ranked_by_activity_then_name():
    graph = {"nodes": [
        project_node("a", ["Minor Author"]),
        project_node("b", ["Major Author"], significant=5),
        project_node("c", ["Major Author"]),
    ]}
    board = author_board(graph, {})
    assert [e["name"] for e in board] == ["Major Author", "Minor Author"]


def test_papers_ride_along_for_the_author_sheet():
    graph = {"nodes": [
        project_node("awq", ["Song Han"], year=2023),
        external_node("ext:streaming", ["Song Han"], year=2023),
    ]}
    [entry] = author_board(graph, {})
    kinds = {p["kind"] for p in entry["papers"]}
    assert kinds == {"project", "external"}
    project_paper = next(p for p in entry["papers"] if p["kind"] == "project")
    assert project_paper["slug"] == "awq"


def test_empty_graph_and_explainers():
    assert author_board(None, {}) == []
    assert author_board({"nodes": []}, {}) == []
    assert "weight 3" in AUTHOR_EXPLAINERS["activity"]
    assert "significant" in AUTHOR_EXPLAINERS["significant"].casefold()


def test_display_name_tidies_leaked_initial_spacing():
    # Bibliography extraction leaks a space before the initial's period ("Quoc V . Le").
    graph = {"nodes": [
        project_node("seq2seq", ["Quoc V . Le"]),
        project_node("adam", ["Diederik P .  Kingma"]),  # extra whitespace too
    ]}
    names = {e["name"] for e in author_board(graph, {})}
    assert names == {"Quoc V. Le", "Diederik P. Kingma"}


def test_display_name_does_not_split_dedup():
    # The tidy is display-only: sloppy and clean spellings still merge into one entry.
    graph = {"nodes": [
        project_node("a", ["Quoc V . Le"]),
        project_node("b", ["Quoc V. Le"]),
    ]}
    [entry] = author_board(graph, {})
    assert entry["name"] == "Quoc V. Le"
    assert entry["in_project_count"] == 2


def test_et_al_and_junk_tokens_are_not_authors():
    graph = {"nodes": [
        project_node("awq", ["Song Han", "et al."]),
        project_node("x", ["and others", "  ", "Ji Lin"]),
    ]}
    names = {e["name"] for e in author_board(graph, {})}
    assert names == {"Song Han", "Ji Lin"}
