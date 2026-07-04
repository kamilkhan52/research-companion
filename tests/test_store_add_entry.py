"""store.add_entry: appending a new reading-list entry (e.g. from a graph recommendation).
No LLM, no network -- pure markdown editing, exercised against a real temp project."""
from __future__ import annotations

import pytest
from app import sessions, store
from app.store import DuplicatePaperError


def test_add_entry_creates_new_unread_paper(temp_project):
    slug = store.add_entry("A Brand New Paper", group="Serving")
    papers = store.list_papers(sessions.session_states())
    added = next(p for p in papers if p.slug == slug)
    assert added.title == "A Brand New Paper"
    assert added.list_status == "unread"
    assert added.group == "Serving"
    assert added.retrieved is False


def test_add_entry_creates_the_group_heading_if_missing(temp_project):
    store.add_entry("First In New Group", group="Brand New Section")
    text = store._reading_list().read_text(encoding="utf-8")
    assert "## Brand New Section" in text
    assert "First In New Group" in text


def test_add_entry_appends_into_an_existing_group_without_duplicating_heading(temp_project):
    store.add_entry("Paper One", group="Serving")
    store.add_entry("Paper Two", group="Serving")
    text = store._reading_list().read_text(encoding="utf-8")
    assert text.count("## Serving") == 1
    papers = store.list_papers()
    assert {p.title for p in papers} == {"Paper One", "Paper Two"}


def test_add_entry_rejects_duplicate_title_slug(temp_project):
    store.add_entry("DistServe: Something")
    with pytest.raises(DuplicatePaperError):
        store.add_entry("DistServe: Something")


def test_add_entry_rejects_empty_title(temp_project):
    with pytest.raises(ValueError):
        store.add_entry("   ")


def test_add_entry_defaults_group_to_unsorted(temp_project):
    store.add_entry("No Group Specified")
    papers = store.list_papers()
    assert papers[0].group == "Unsorted"


def test_add_entry_records_arxiv_id_as_provenance_comment_only(temp_project):
    slug = store.add_entry("Has An Arxiv Id", arxiv_id="1706.03762")
    text = store._reading_list().read_text(encoding="utf-8")
    assert "<!-- arxiv: 1706.03762 -->" in text
    # Provenance only -- it must not be picked up as a slug/cites override.
    papers = store.list_papers()
    assert papers[0].slug == slug
    assert papers[0].cites == []


def test_add_entry_does_not_retrieve_or_commit(temp_project):
    slug = store.add_entry("Not Yet Retrieved")
    assert not store.corpus_path(slug).exists()
    import subprocess

    from app import config
    status = subprocess.run(["git", "status", "--porcelain"], cwd=str(config.project_dir()),
                            capture_output=True, text=True).stdout
    assert "reading-list.md" in status  # a real, uncommitted working-tree change
