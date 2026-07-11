"""Cover rendering: first-page rasterization, PDF-source resolution, and the cached/ pending/
unavailable status logic. Network-free — the one end-to-end render feeds a fitz-generated PDF
through a monkeypatched retriever._fetch, so the suite never touches arXiv."""
from __future__ import annotations

import struct

import fitz

from app import cover_jobs, store


def _make_pdf(text: str = "Hello cover") -> bytes:
    doc = fitz.open()
    page = doc.new_page(width=612, height=792)
    page.insert_text((72, 120), text, fontsize=24)
    data = doc.tobytes()
    doc.close()
    return data


def test_render_first_page_produces_sized_png():
    png = cover_jobs._render_first_page(_make_pdf())
    assert png[:8] == b"\x89PNG\r\n\x1a\n"           # PNG signature
    width, _height = struct.unpack(">II", png[16:24])  # IHDR width/height
    assert width == cover_jobs.COVER_WIDTH_PX


def test_source_url_for_reads_corpus_meta(temp_project):
    store.write_full_text("p1", "Paper One", "body",
                          {"slug": "p1", "source": "https://example.com/x.pdf"})
    assert store.source_url_for("p1") == "https://example.com/x.pdf"
    store.write_full_text("p2", "Paper Two", "body", {"slug": "p2"})
    assert store.source_url_for("p2") == ""
    assert store.source_url_for("missing") == ""


def test_pdf_url_for_prefers_arxiv(monkeypatch):
    monkeypatch.setattr(store, "arxiv_id_for", lambda s: "2201.11705")
    assert cover_jobs._pdf_url_for("x") == "https://arxiv.org/pdf/2201.11705"


def test_pdf_url_for_rewrites_abstract_link(monkeypatch):
    monkeypatch.setattr(store, "arxiv_id_for", lambda s: "")
    monkeypatch.setattr(store, "source_url_for", lambda s: "https://arxiv.org/abs/2201.11705")
    assert cover_jobs._pdf_url_for("x") == "https://arxiv.org/pdf/2201.11705"


def test_pdf_url_for_none_without_source(monkeypatch):
    monkeypatch.setattr(store, "arxiv_id_for", lambda s: "")
    monkeypatch.setattr(store, "source_url_for", lambda s: "")
    assert cover_jobs._pdf_url_for("x") is None


def test_ensure_ready_when_cached(temp_project):
    p = cover_jobs.cover_path("cached")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"\x89PNG\r\n\x1a\n")
    assert cover_jobs.ensure("cached") == "ready"


def test_ensure_unavailable_without_source(temp_project, monkeypatch):
    monkeypatch.setattr(store, "arxiv_id_for", lambda s: "")
    monkeypatch.setattr(store, "source_url_for", lambda s: "")
    assert cover_jobs.ensure("nope") == "unavailable"


def test_work_renders_and_caches(temp_project, monkeypatch):
    monkeypatch.setattr(store, "arxiv_id_for", lambda s: "1234.5678")
    monkeypatch.setattr(cover_jobs.retriever, "_fetch", lambda url: _make_pdf())
    job = cover_jobs.CoverJob(id="j1", slug="paper-x")
    cover_jobs._work(job)
    dst = cover_jobs.cover_path("paper-x")
    assert dst.exists() and dst.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"
