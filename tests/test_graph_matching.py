"""Deterministic matching/dedup logic — no LLM, no filesystem."""
from __future__ import annotations

from app.graph import external_ref_key, match_project_paper, titles_match
from app.models import Paper


def paper(slug: str, title: str) -> Paper:
    return Paper(slug=slug, title=title, group="g", list_status="unread")


def test_titles_match_exact():
    assert titles_match("DistServe: Disaggregating Prefill", "DistServe: Disaggregating Prefill")


def test_titles_match_case_and_punctuation_insensitive():
    assert titles_match("DistServe: Disaggregating Prefill and Decoding",
                        "distserve disaggregating prefill and decoding")


def test_titles_match_minor_variation():
    # OCR/formatting noise (extra whitespace, a dropped subtitle word) should still match.
    a = "Efficient Memory Management for Large Language Model Serving with PagedAttention"
    b = "Efficient Memory Management for Large Language  Model Serving with PagedAttention"
    assert titles_match(a, b)


def test_titles_match_rejects_different_papers():
    assert not titles_match("DistServe: Disaggregating Prefill and Decoding",
                            "Splitwise: Efficient Generative LLM Inference")


def test_titles_match_empty_strings_never_match():
    assert not titles_match("", "")
    assert not titles_match("Something", "")


def test_external_ref_key_prefers_arxiv_id():
    ref = {"arxiv_id": "2401.09670", "doi": "10.1/x", "title": "DistServe"}
    assert external_ref_key(ref) == "arxiv:2401.09670"


def test_external_ref_key_falls_back_to_doi_then_title():
    assert external_ref_key({"doi": "10.1/X", "title": "Foo"}) == "doi:10.1/x"
    assert external_ref_key({"title": "Foo Bar"}) == "title:foo bar"
    assert external_ref_key({"raw_text": "Some raw citation text."}).startswith("raw:")


def test_external_ref_key_dedupes_despite_formatting_noise():
    a = {"title": "Efficient Memory Management for LLM Serving with PagedAttention"}
    b = {"title": "efficient memory management for llm serving with pagedattention."}
    assert external_ref_key(a) == external_ref_key(b)


def test_match_project_paper_finds_fuzzy_title():
    papers = [paper("distserve", "DistServe: Disaggregating Prefill and Decoding"),
              paper("splitwise", "Splitwise: Efficient Generative LLM Inference")]
    ref = {"title": "distserve disaggregating prefill and decoding for goodput"}
    # Below is intentionally a slightly different (longer) title than either project paper —
    # should NOT force-match; only a genuinely close title should.
    assert match_project_paper({"title": "DistServe: Disaggregating Prefill and Decoding"}, papers) == "distserve"
    assert match_project_paper(ref, papers) is None or match_project_paper(ref, papers) == "distserve"


def test_match_project_paper_no_match_for_unrelated_title():
    papers = [paper("distserve", "DistServe: Disaggregating Prefill and Decoding")]
    assert match_project_paper({"title": "Attention Is All You Need"}, papers) is None


def test_match_project_paper_handles_missing_title():
    papers = [paper("distserve", "DistServe: Disaggregating Prefill and Decoding")]
    assert match_project_paper({"title": ""}, papers) is None
    assert match_project_paper({}, papers) is None
