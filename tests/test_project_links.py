"""Relevance signals for a paper the reader has not opened yet."""
from __future__ import annotations

from app import store

from tests.conftest import add_paper


def _cite(slug: str, targets: list[str]) -> None:
    """Add a `<!-- cites: ... -->` annotation to an existing entry, the way a project's own
    reading-list.md carries them."""
    rl = store._reading_list()
    text = rl.read_text(encoding="utf-8")
    marker = f"<!-- slug: {slug} -->"
    text = text.replace(marker, marker + f"\n<!-- cites: {', '.join(targets)} -->", 1)
    rl.write_text(text, encoding="utf-8")
    store._parse_cache.pop(str(rl), None)


def test_counts_citations_from_the_reading_list_alone(temp_project):
    # Derived from the reading list, so it works for an UNREAD paper — which is the only case
    # that matters here: the reader is deciding whether to spend a summary on it.
    add_paper(temp_project, "orca", "Orca", full_text="t")
    add_paper(temp_project, "vllm", "vLLM", full_text="t")
    _cite("vllm", ["orca"])
    add_paper(temp_project, "sarathi", "Sarathi", full_text="t")
    _cite("sarathi", ["orca"])

    links = store.project_links("orca")

    assert links["cited_by_in_project"] == 2
    assert links["cites_in_project"] == 0


def test_a_citation_from_a_paper_you_have_READ_is_counted_separately(temp_project):
    """A citation from a paper the reader actually read is a stronger signal than one from
    another unread entry, so it is not folded into the same number."""
    add_paper(temp_project, "orca", "Orca", full_text="t")
    add_paper(temp_project, "vllm", "vLLM", full_text="t")
    _cite("vllm", ["orca"])
    add_paper(temp_project, "sarathi", "Sarathi", full_text="t")
    _cite("sarathi", ["orca"])
    store.set_status_read("vllm")

    links = store.project_links("orca")

    assert links["cited_by_in_project"] == 2
    assert links["cited_by_read"] == 1


def test_citations_pointing_outside_the_project_are_not_counted(temp_project):
    # A `cites` entry naming a slug this project does not have says nothing about how the paper
    # sits in THIS reading list, which is what the number claims to describe.
    add_paper(temp_project, "vllm", "vLLM", full_text="t")
    _cite("vllm", ["orca", "not-in-this-project"])

    assert store.project_links("vllm")["cites_in_project"] == 0

    add_paper(temp_project, "orca", "Orca", full_text="t")
    assert store.project_links("vllm")["cites_in_project"] == 1


def test_an_unknown_slug_answers_with_zeroes_rather_than_raising(temp_project):
    assert store.project_links("nothing-here") == {
        "cites_in_project": 0, "cited_by_in_project": 0, "cited_by_read": 0,
    }


def test_a_self_reference_is_not_a_citation(temp_project):
    """`<!-- cites: orca -->` on Orca itself would otherwise render "Cited by 1 here" for a paper
    nothing points at — a claim about other papers, made from the paper's own annotation."""
    add_paper(temp_project, "orca", "Orca", full_text="t")
    _cite("orca", ["orca"])

    assert store.project_links("orca") == {
        "cites_in_project": 0, "cited_by_in_project": 0, "cited_by_read": 0,
    }


def test_a_repeated_target_counts_once(temp_project):
    # The number claims distinct linked papers, not annotation entries.
    add_paper(temp_project, "orca", "Orca", full_text="t")
    add_paper(temp_project, "vllm", "vLLM", full_text="t")
    _cite("vllm", ["orca", "orca"])

    assert store.project_links("vllm")["cites_in_project"] == 1
    assert store.project_links("orca")["cited_by_in_project"] == 1


def test_reads_no_corpus_files(temp_project, monkeypatch):
    """The reason this uses `_parse_entries` and not `list_papers`: the latter builds a Paper per
    entry, which calls `source_url_for`, which reads each corpus file IN FULL. On a 200-paper
    project that is 200 whole-file reads added to every paper open."""
    add_paper(temp_project, "orca", "Orca", full_text="t")
    add_paper(temp_project, "vllm", "vLLM", full_text="t")

    called = []
    monkeypatch.setattr(store, "source_url_for", lambda slug: called.append(slug) or "")
    store.project_links("orca")

    assert called == [], f"project_links must not touch corpus files, read: {called}"
