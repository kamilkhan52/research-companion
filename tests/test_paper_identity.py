"""Cross-project paper identity and duplicate-add preflight (R10.18)."""
from __future__ import annotations

import pytest
from app import config, paper_identity, projects, sessions, store
from app.routers.notes import AddPaperReq, add_paper
from fastapi import HTTPException


class _AnonRequest:
    """A request with no signed-in user — the single-tenant shape these tests exercise.

    These routes now take `Request` so they can scope results to the caller. With no database
    configured, `tenancy` short-circuits before ever reading `state.user`, so this stub only has to
    exist, not carry an identity.
    """

    class state:  # noqa: N801 — mirrors Starlette's attribute name, not a class of its own
        user = None




def _add_to_project(
    pid: str,
    title: str,
    *,
    arxiv_id: str | None = None,
    source_url: str | None = None,
    notes: bool = False,
) -> str:
    token = config.set_active_project(pid)
    try:
        slug = store.add_entry(title, arxiv_id=arxiv_id)
        if source_url:
            store.write_full_text(
                slug,
                title,
                "Paper text.",
                {"slug": slug, "source": source_url, "arxiv_id": arxiv_id},
            )
        if notes:
            if not store.corpus_path(slug).exists():
                store.write_full_text(slug, title, "Paper text.", {"slug": slug})
            store.append_notes_block(slug, title, "## Notes\n\nA retained finding.")
        return slug
    finally:
        config.reset_active_project(token)


def test_identity_normalizers_handle_arxiv_doi_and_source_urls():
    assert paper_identity.normalize_arxiv_id("https://arxiv.org/pdf/2303.08774v2") == "2303.08774"
    assert paper_identity.normalize_arxiv_id("2303.08774v1") == "2303.08774"
    # A random numeric pattern on a non-arXiv host is not an arXiv identity.
    assert paper_identity.normalize_arxiv_id("https://example.org/2303.08774.pdf") is None
    assert paper_identity.normalize_doi("https://doi.org/10.1145/1234.5678)") == "10.1145/1234.5678"
    assert (
        paper_identity.normalize_source_url("HTTPS://Example.org//paper.pdf?download=1#page=2")
        == "https://example.org/paper.pdf"
    )


def test_find_locations_prefers_strong_identity_and_reports_reusable_work(temp_project):
    source = projects.create_project("Source Library")["id"]
    slug = _add_to_project(
        source,
        "GPT-4 Technical Report",
        arxiv_id="2303.08774v1",
        notes=True,
    )
    token = config.set_active_project(source)
    try:
        jsonl, _ = sessions.transcript_paths(slug)
        jsonl.write_text('{"role":"user","text":"hello"}\n', encoding="utf-8")
    finally:
        config.reset_active_project(token)

    matches = paper_identity.find_locations(
        title="A placeholder title",
        arxiv_id="2303.08774v4",
        exclude_pid=temp_project,
    )

    assert len(matches) == 1
    assert matches[0]["project_id"] == source
    assert matches[0]["project_name"] == "Source Library"
    assert matches[0]["identity"] == "arxiv:2303.08774"
    assert matches[0]["has_notes"] is True
    assert matches[0]["has_discussion"] is True
    # The aggregate scan must restore the request's active target project.
    assert config.active_project_id() == temp_project


def test_known_different_ids_do_not_collapse_on_same_title(temp_project):
    source = projects.create_project("Other")["id"]
    _add_to_project(source, "Shared Title", arxiv_id="2401.00001")

    assert paper_identity.find_locations(
        title="Shared Title",
        arxiv_id="2401.00002",
        exclude_pid=temp_project,
    ) == []


def test_exact_title_fallback_finds_an_unidentified_existing_paper(temp_project):
    source = projects.create_project("Other")["id"]
    _add_to_project(source, "  A Study: Of Systems  ")

    matches = paper_identity.find_locations(
        title="a study — of systems",
        exclude_pid=temp_project,
    )
    assert [match["project_id"] for match in matches] == [source]
    assert matches[0]["identity"] == "title:a study of systems"


def test_add_route_refuses_silent_cross_project_duplicate(temp_project):
    source = projects.create_project("Other")["id"]
    _add_to_project(source, "Canonical Paper", arxiv_id="2401.00001")

    with pytest.raises(HTTPException) as exc:
        add_paper(
            temp_project,
            AddPaperReq(title="Incomplete search text", arxiv_id="2401.00001"),
            _AnonRequest(),
        )

    assert exc.value.status_code == 409
    assert exc.value.detail["code"] == "paper_exists_elsewhere"
    assert exc.value.detail["matches"][0]["project_id"] == source
    assert store.get_paper("incomplete-search-text") is None
