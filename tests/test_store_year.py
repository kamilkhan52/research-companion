"""U.17 — publication year: derived from arXiv ids, overridable with a `<!-- year -->`
comment, surfaced on Paper and in the agent's reading-list overview. Pure parsing, no
network (store invariant)."""
from __future__ import annotations

from app import assembler, store


def test_year_from_new_style_arxiv_id():
    assert store.year_from_arxiv_id("2211.10438") == 2022
    assert store.year_from_arxiv_id("2211.10438v3") == 2022
    assert store.year_from_arxiv_id("1706.03762") == 2017


def test_year_from_old_style_arxiv_id():
    assert store.year_from_arxiv_id("hep-th/9901001") == 1999
    assert store.year_from_arxiv_id("cs.CL/0301101") == 2003


def test_year_from_unrecognized_id_is_none():
    assert store.year_from_arxiv_id("") is None
    assert store.year_from_arxiv_id("not-an-id") is None


def test_paper_year_derived_from_arxiv_comment(temp_project):
    slug = store.add_entry("Attention Is All You Need", arxiv_id="1706.03762")
    paper = store.get_paper(slug)
    assert paper.year == 2017
    assert store.year_for(slug) == 2017


def test_explicit_year_comment_wins_over_arxiv_id(temp_project):
    slug = store.add_entry("Some Paper", arxiv_id="1706.03762")
    rl = store._reading_list()
    text = rl.read_text(encoding="utf-8").replace(
        "<!-- arxiv: 1706.03762 -->",
        "<!-- arxiv: 1706.03762 -->\n<!-- year: 2018 -->",
    )
    rl.write_text(text, encoding="utf-8")
    assert store.year_for(slug) == 2018


def test_add_entry_records_year_only_when_arxiv_id_cannot_date_it(temp_project):
    store.add_entry("Non Arxiv Paper", year=2019)
    store.add_entry("Arxiv Paper", arxiv_id="2201.11705", year=2022)
    text = store._reading_list().read_text(encoding="utf-8")
    assert "<!-- year: 2019 -->" in text
    # The arXiv id already encodes 2022; no duplicate comment.
    assert text.count("<!-- year:") == 1
    assert store.year_for(store.derive_slug("Non Arxiv Paper")) == 2019


def test_reading_list_overview_carries_the_year(temp_project):
    store.add_entry("Dated Paper", arxiv_id="2201.11705")
    store.add_entry("Undated Paper")
    overview = store.reading_list_overview()
    assert "Dated Paper (2022)" in overview
    assert "Undated Paper —" in overview  # no "(None)" artifact


def test_assembler_states_the_publication_year(temp_project):
    slug = store.add_entry("Dated Paper", arxiv_id="2201.11705")
    ctx = assembler.build_context(slug)
    assert "Published: 2022." in ctx


def test_assembler_omits_year_line_when_unknown(temp_project):
    slug = store.add_entry("Undated Paper")
    ctx = assembler.build_context(slug)
    assert "Published:" not in ctx
