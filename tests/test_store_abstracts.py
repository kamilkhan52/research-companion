"""Abstracts on reading-list entries: parsing, writing, and what reaches the agent.

An unread paper contributes nothing to a discussion's context except its reading-list line, so
its abstract is the only substantive thing the agent can know about it. Once the paper is read,
its Paper Notes block carries that weight and the abstract drops out.
"""
from __future__ import annotations

import pytest
from app import store

ABSTRACT = ("We present Orca, a distributed serving system for Transformer-based generative "
            "models, which introduces iteration-level scheduling and selective batching.")


def _write_list(body: str) -> None:
    store._reading_list().write_text(f"# Reading list\n\n## Group\n\n{body}", encoding="utf-8")
    store._parse_cache.clear()


def test_abstract_paragraph_is_parsed_off_an_entry(temp_project):
    _write_list(f"**Orca: A Serving System** — *unread*\n\nAbstract: {ABSTRACT}\n")
    assert store.abstract_for("orca") == ABSTRACT


def test_abstract_is_unwrapped_into_one_line(temp_project):
    _write_list("**Orca: A Serving System** — *unread*\n\n"
                "Abstract: We present Orca, a distributed\nserving system for Transformer-based\n"
                "generative models.\n")
    assert store.abstract_for("orca") == ("We present Orca, a distributed serving system for "
                                          "Transformer-based generative models.")


def test_abstract_stops_at_the_blank_line_before_the_next_paragraph(temp_project):
    _write_list("**Orca: A Serving System** — *unread*\n\n"
                "Abstract: Iteration-level scheduling.\n\n"
                "Authors: Gyeong-In Yu et al. Venue: OSDI 2022.\n")
    assert store.abstract_for("orca") == "Iteration-level scheduling."


def test_entry_without_an_abstract_reports_empty(temp_project):
    _write_list("**Orca: A Serving System** — *unread*\n")
    assert store.abstract_for("orca") == ""


def test_arxiv_comment_is_parsed_but_is_not_the_abstract(temp_project):
    _write_list("**Orca: A Serving System** — *unread*\n<!-- arxiv: 2201.11705 -->\n")
    assert store.arxiv_id_for("orca") == "2201.11705"
    assert store.abstract_for("orca") == ""


# ---- writing ----

def test_set_abstract_adds_a_wrapped_paragraph_below_the_title(temp_project):
    _write_list("**Orca: A Serving System** — *unread*\n")
    assert store.set_abstract("orca", ABSTRACT) is True
    text = store._reading_list().read_text(encoding="utf-8")
    assert "\n\nAbstract: We present Orca" in text
    assert all(len(line) <= store._ABSTRACT_WRAP_COLS for line in text.splitlines())
    assert store.abstract_for("orca") == ABSTRACT


def test_set_abstract_goes_below_the_arxiv_comment_not_between_it_and_the_title(temp_project):
    _write_list("**Orca: A Serving System** — *unread*\n<!-- arxiv: 2201.11705 -->\n")
    store.set_abstract("orca", ABSTRACT)
    lines = store._reading_list().read_text(encoding="utf-8").splitlines()
    assert lines[4] == "**Orca: A Serving System** — *unread*"
    assert lines[5] == "<!-- arxiv: 2201.11705 -->"
    assert lines[6] == ""
    assert lines[7].startswith("Abstract: ")
    assert store.arxiv_id_for("orca") == "2201.11705"


def test_set_abstract_replaces_an_existing_one_and_keeps_the_rest_of_the_block(temp_project):
    _write_list("**Orca: A Serving System** — *unread*\n\n"
                "Abstract: An old, wrong abstract.\n\n"
                "Authors: Gyeong-In Yu et al. Venue: OSDI 2022.\n")
    store.set_abstract("orca", ABSTRACT)
    text = store._reading_list().read_text(encoding="utf-8")
    assert "old, wrong abstract" not in text
    assert text.count("Abstract:") == 1
    assert "Authors: Gyeong-In Yu et al. Venue: OSDI 2022." in text
    assert store.abstract_for("orca") == ABSTRACT


def test_set_abstract_preserves_neighbouring_entries(temp_project):
    _write_list("**Orca: A Serving System** — *unread*\n\n"
                "**Sarathi: Chunked Prefill** — *unread*\n<!-- arxiv: 2308.16369 -->\n")
    store.set_abstract("orca", ABSTRACT)
    papers = store.list_papers()
    assert [p.slug for p in papers] == ["orca", "sarathi"]
    assert store.abstract_for("sarathi") == ""
    assert store.arxiv_id_for("sarathi") == "2308.16369"
    # The blank line separating the two entries survives, so both still parse as entries.
    assert "\n\n**Sarathi" in store._reading_list().read_text(encoding="utf-8")


def test_set_abstract_returns_false_for_an_unknown_slug(temp_project):
    _write_list("**Orca: A Serving System** — *unread*\n")
    assert store.set_abstract("nonexistent", ABSTRACT) is False


def test_set_abstract_rejects_an_empty_abstract(temp_project):
    _write_list("**Orca: A Serving System** — *unread*\n")
    with pytest.raises(ValueError):
        store.set_abstract("orca", "   ")


# Each pads the text so the interesting token straddles the wrap column — where the default
# textwrap settings split it. Without the padding these pass whatever the settings are.
_PAD = "word " * 15


@pytest.mark.parametrize("abstract", [
    _PAD + "3D DRAM-stacked accelerators beat the baseline.",                      # hyphen
    "word " * 5 + "https://github.com/some-org/a-very-long-repository-name/tree/main is it.",
    "word " * 9 + "1.83-7.98x speedup over state-of-the-art.",                     # numeric range
])
def test_wrapping_round_trips_without_breaking_tokens(temp_project, abstract):
    """Wrapping writes lines; _extract_abstract joins them back with a space. A break *inside* a
    token silently corrupts the text the agent reads — "3D DRAM- stacked", a dead URL — and the
    reading-list file looks perfectly fine while it happens."""
    abstract = abstract.strip()
    _write_list("**Orca: A Serving System** — *unread*\n")
    store.set_abstract("orca", abstract)
    assert store.abstract_for("orca") == abstract


def test_set_abstract_is_idempotent(temp_project):
    _write_list("**Orca: A Serving System** — *unread*\n")
    store.set_abstract("orca", ABSTRACT)
    first = store._reading_list().read_text(encoding="utf-8")
    store.set_abstract("orca", ABSTRACT)
    assert store._reading_list().read_text(encoding="utf-8") == first


def test_add_entry_stores_a_supplied_abstract(temp_project):
    slug = store.add_entry("Orca: A Serving System", group="Serving",
                           arxiv_id="2201.11705", abstract=ABSTRACT)
    assert store.abstract_for(slug) == ABSTRACT
    assert store.arxiv_id_for(slug) == "2201.11705"


# ---- what the agent sees ----

def test_overview_carries_the_abstract_of_an_unread_paper(temp_project):
    _write_list(f"**Orca: A Serving System** — *unread*\n\nAbstract: {ABSTRACT}\n")
    overview = store.reading_list_overview()
    assert "- Orca: A Serving System — *unread* (slug: orca; link: rc-paper:orca)" in overview
    assert f"  Abstract: {ABSTRACT}" in overview


def test_overview_drops_the_abstract_once_the_paper_has_notes(temp_project):
    _write_list(f"**Orca: A Serving System** — *read*\n\nAbstract: {ABSTRACT}\n")
    store.write_full_text("orca", "Orca", "Full text.", {"slug": "orca"})
    store.append_notes_block("orca", "Orca", "## Notes\n\nIteration-level scheduling wins.")
    overview = store.reading_list_overview()
    assert "- Orca: A Serving System — *read* (slug: orca; link: rc-paper:orca)" in overview
    assert "Abstract:" not in overview


def test_overview_keeps_the_abstract_of_a_read_paper_whose_notes_are_not_written_yet(temp_project):
    """`read` is a marker in reading-list.md; the Paper Notes block is what actually reaches the
    context. Between the two, the abstract is still the only thing the agent has."""
    _write_list(f"**Orca: A Serving System** — *read*\n\nAbstract: {ABSTRACT}\n")
    assert f"  Abstract: {ABSTRACT}" in store.reading_list_overview()
