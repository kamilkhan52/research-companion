"""Task #75b — the retrieval writers (/start, /start_stream, /upload_paper) persist their
corpus under the project write guard via the shared `_guarded_write`: refused while a split/
move reserves the project, and never recreating a paper the relocation removed mid-retrieve."""
from __future__ import annotations

import pytest
from app import config, store
from app.routers import session as sroutes
from app.routers.session import StartReq, _guarded_write, _PaperGoneError, start_paper
from fastapi import HTTPException


def test_guarded_write_refuses_while_reserved(temp_project):
    slug = store.add_entry("Reserved Paper")
    config.mark_project_busy(temp_project)
    try:
        with pytest.raises(config.ProjectBusyError):
            _guarded_write(slug, lambda: store.write_full_text(slug, "X", "t", {"slug": slug}))
    finally:
        config.unmark_project_busy(temp_project)
    assert store.corpus_path(slug).exists() is False  # the write did not happen


def test_guarded_write_refuses_a_paper_removed_mid_retrieve(temp_project):
    slug = store.add_entry("Vanishing Paper")
    store.remove_entry(slug)  # a relocation removed it while we were "retrieving"
    with pytest.raises(_PaperGoneError):
        _guarded_write(slug, lambda: store.write_full_text(slug, "X", "t", {"slug": slug}))
    assert store.corpus_path(slug).exists() is False  # corpus NOT recreated (no orphan)


def test_guarded_write_persists_when_free(temp_project):
    slug = store.add_entry("Fine Paper")
    _guarded_write(slug, lambda: store.write_full_text(slug, "Fine Paper", "body", {"slug": slug}))
    assert store.corpus_path(slug).exists() is True


def test_start_route_refuses_while_reserved(temp_project, monkeypatch):
    """End-to-end through /start: the retrieval runs, but the guarded write is refused (409)
    while the project is reserved — proving the wiring, not just the helper."""
    slug = store.add_entry("Paper To Start")  # no corpus ⇒ not retrieved ⇒ takes the fetch path
    monkeypatch.setattr(sroutes.retriever, "retrieve", lambda *a: {
        "full_text": "the text", "arxiv_id": None, "source": "test", "score": None})
    config.mark_project_busy(temp_project)
    try:
        with pytest.raises(HTTPException) as exc:
            start_paper(StartReq(slug=slug))
        assert exc.value.status_code == 409
    finally:
        config.unmark_project_busy(temp_project)
    assert store.corpus_path(slug).exists() is False


def test_start_route_does_not_recreate_a_removed_paper(temp_project, monkeypatch):
    slug = store.add_entry("Paper To Vanish")

    def fake_retrieve(title, arxiv_id, pdf_url):
        store.remove_entry(slug)  # removed by a relocation during the (fake) retrieval
        return {"full_text": "the text", "arxiv_id": None, "source": "test", "score": None}

    monkeypatch.setattr(sroutes.retriever, "retrieve", fake_retrieve)
    with pytest.raises(HTTPException) as exc:
        start_paper(StartReq(slug=slug))
    assert exc.value.status_code == 409
    assert store.corpus_path(slug).exists() is False  # not recreated as an orphan
