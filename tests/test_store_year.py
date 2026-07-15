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


# ---- U.18: annotate_entry + retrieval write-through ----

def test_annotate_entry_inserts_missing_arxiv_id_and_dates_the_entry(temp_project):
    slug = store.add_entry("Resolved By Title Search")
    assert store.annotate_entry(slug, arxiv_id="2201.11705") is True
    assert store.arxiv_id_for(slug) == "2201.11705"
    assert store.year_for(slug) == 2022
    # The id already dates it — no redundant year comment.
    assert "<!-- year:" not in store._reading_list().read_text(encoding="utf-8")


def test_annotate_entry_never_overwrites_a_pinned_id(temp_project):
    slug = store.add_entry("Pinned", arxiv_id="1706.03762")
    assert store.annotate_entry(slug, arxiv_id="9999.99999") is False
    assert store.arxiv_id_for(slug) == "1706.03762"


def test_annotate_entry_year_for_non_arxiv_paper(temp_project):
    slug = store.add_entry("Non Arxiv Work")
    assert store.annotate_entry(slug, year=2019) is True
    assert store.year_for(slug) == 2019
    # Idempotent: a second call has nothing to add.
    assert store.annotate_entry(slug, year=2020) is False
    assert store.year_for(slug) == 2019


def test_annotate_entry_unknown_slug_is_a_noop(temp_project):
    assert store.annotate_entry("no-such-paper", arxiv_id="2201.11705") is False


def test_write_full_text_records_resolved_arxiv_id_on_the_entry(temp_project):
    slug = store.add_entry("Found On Arxiv By Title")
    store.write_full_text(slug, "Found On Arxiv By Title", "body", {
        "slug": slug, "arxiv_id": "2201.11705", "source": "https://arxiv.org/abs/2201.11705",
    })
    assert store.arxiv_id_for(slug) == "2201.11705"
    assert store.year_for(slug) == 2022
    assert store.corpus_arxiv_id_for(slug) == "2201.11705"


def test_write_full_text_without_id_leaves_the_entry_alone(temp_project):
    slug = store.add_entry("Uploaded Pdf")
    store.write_full_text(slug, "Uploaded Pdf", "body", {"slug": slug, "source": "upload:x.pdf"})
    assert store.arxiv_id_for(slug) == ""
    assert store.corpus_arxiv_id_for(slug) == ""


def test_annotate_entry_keeps_abstract_and_block_shape(temp_project):
    slug = store.add_entry("Shaped Entry", abstract="A tidy abstract about things.")
    store.annotate_entry(slug, arxiv_id="2201.11705")
    assert store.abstract_for(slug) == "A tidy abstract about things."
    # Re-parse still finds exactly one entry with the same slug.
    assert [p.slug for p in store.list_papers()].count(slug) == 1
