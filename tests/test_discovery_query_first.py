"""DR-096 — Kamil (device, 2026-09-23): "When a query is provided it should be the highest
relevance criteria … The project content is secondary when the query is explicit."

The final blend added citation, provenance, connectivity and momentum terms to relevance at face
value. Together they reach 7.55 on a 0-10 scale, so a paper scored 3 for the query could outrank
one scored 9. They now order papers of equal relevance and nothing more.
"""
from __future__ import annotations

from datetime import UTC, datetime

from app import discovery


def _loaded(relevance: float, title: str = "Connected") -> dict:
    """Every secondary term at once: famous, young and fast, a significant new citer of the
    reading list, citing three of its papers, on the graph."""
    year = datetime.now(UTC).year
    return {
        "title": title, "relevance": relevance, "citation_count": 100_000, "year": year,
        "channels": ["new_citation", "cites", "graph"],
        "significance": {"label": "EXTENDS", "significant": True, "note": "extends it",
                         "anchor_title": "A", "anchor_slug": "a", "mentions": 2},
        "provenance": [
            {"channel": "new_citation", "anchor_slug": "a", "anchor_title": "A"},
            {"channel": "cites", "anchor_slug": "b", "anchor_title": "B"},
            {"channel": "cites", "anchor_slug": "c", "anchor_title": "C"},
            {"channel": "cites", "anchor_slug": "d", "anchor_title": "D"},
            {"channel": "graph", "reasons": ["Cited by 4 of your papers"]},
        ],
    }


def _plain(relevance: float, title: str = "On topic") -> dict:
    return {"title": title, "relevance": relevance, "citation_count": 0,
            "channels": ["lexical"], "provenance": []}


def test_a_paper_that_answers_the_query_outranks_a_better_connected_one():
    ranked = discovery.blend_and_rank([_loaded(3.0), _plain(9.0)])
    assert [c["title"] for c in ranked] == ["On topic", "Connected"]


def test_one_relevance_point_outweighs_every_secondary_term_together():
    ranked = discovery.blend_and_rank([_loaded(7.0), _plain(8.0)])
    assert ranked[0]["title"] == "On topic"
    assert ranked[0]["score"] > ranked[1]["score"]


def test_a_fractional_relevance_is_not_carried_past_a_higher_one():
    ranked = discovery.blend_and_rank([_loaded(7.5), _plain(8.0)])
    assert ranked[0]["title"] == "On topic"


def test_among_equally_relevant_papers_the_project_still_decides():
    ranked = discovery.blend_and_rank([_plain(8.0), _loaded(8.0)])
    assert ranked[0]["title"] == "Connected"
    assert any("reading list" in r for r in ranked[0]["reasons"]), "its reasons are kept"


def test_the_scale_covers_every_term_the_blend_can_add():
    """Adding a term without raising SECONDARY_TERMS_MAX would compress silently."""
    total = (discovery.CITATION_TERM_CAP + discovery.PROVENANCE_BONUS_NEW_CITATION
             + discovery.SIGNIFICANT_CITER_BONUS + discovery.PROVENANCE_BONUS_CITES
             + discovery.PROVENANCE_BONUS_GRAPH + discovery.CONNECTIVITY_BONUS_CAP
             + discovery.MOMENTUM_CAP)
    assert total == discovery.SECONDARY_TERMS_MAX
    assert discovery.SECONDARY_SPAN < 1.0
    top = discovery.blend_and_rank([_loaded(5.0)])[0]
    assert 5.0 <= top["score"] < 6.0


def test_the_screening_profile_says_the_list_is_context_not_a_criterion():
    class P:
        title = "Stratum"
    profile = discovery._profile_text("hybrid bonded 3D DRAM for AI workloads", [P()])
    assert profile.startswith("FOCUS: hybrid bonded 3D DRAM for AI workloads")
    assert "context only" in profile and "fit to the FOCUS" in profile
    assert "Stratum" in profile
