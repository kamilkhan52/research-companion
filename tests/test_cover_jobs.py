"""Cover rendering: first-page rasterization (incl. resource-limit clamps), PDF-source
resolution, the byte-capped download, and the cached/pending/unavailable status logic. Network-
free — the end-to-end render feeds a fitz-generated PDF through a monkeypatched _download_pdf, and
the download tests fake httpx.stream, so the suite never touches the network."""
from __future__ import annotations

import struct

import fitz
import pytest
from app import cover_jobs, store


def _make_pdf(text: str = "Hello cover") -> bytes:
    doc = fitz.open()
    page = doc.new_page(width=612, height=792)
    page.insert_text((72, 120), text, fontsize=24)
    data = doc.tobytes()
    doc.close()
    return data


class _FakeStream:
    """Minimal stand-in for httpx.stream()'s context manager."""

    def __init__(self, chunks: list[bytes], headers: dict | None = None):
        self._chunks = chunks
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False

    def raise_for_status(self):
        return None

    def iter_bytes(self):
        yield from self._chunks


def test_render_first_page_produces_sized_png():
    png = cover_jobs._render_first_page(_make_pdf())
    assert png[:8] == b"\x89PNG\r\n\x1a\n"           # PNG signature
    width, _height = struct.unpack(">II", png[16:24])  # IHDR width/height
    assert width == cover_jobs.COVER_WIDTH_PX


def test_render_clamps_extreme_aspect_ratio():
    # A tall, thin page: rasterizing to the width target alone would produce a ~540k-px-tall image.
    doc = fitz.open()
    doc.new_page(width=10, height=6000)
    data = doc.tobytes()
    doc.close()
    png = cover_jobs._render_first_page(data)
    width, height = struct.unpack(">II", png[16:24])
    assert height <= cover_jobs.COVER_MAX_DIM
    assert width * height <= cover_jobs.COVER_MAX_PIXELS


def test_download_pdf_returns_joined_body(monkeypatch):
    monkeypatch.setattr(cover_jobs.httpx, "stream", lambda *a, **k: _FakeStream([b"%PDF-", b"data"]))
    assert cover_jobs._download_pdf("https://example.com/x.pdf") == b"%PDF-data"


def test_download_pdf_rejects_oversized_stream(monkeypatch):
    monkeypatch.setattr(cover_jobs, "COVER_MAX_PDF_BYTES", 100)
    monkeypatch.setattr(cover_jobs.httpx, "stream",
                        lambda *a, **k: _FakeStream([b"x" * 60, b"y" * 60]))
    with pytest.raises(cover_jobs.CoverError):
        cover_jobs._download_pdf("https://example.com/big.pdf")


def test_download_pdf_rejects_declared_length(monkeypatch):
    monkeypatch.setattr(cover_jobs, "COVER_MAX_PDF_BYTES", 100)
    monkeypatch.setattr(cover_jobs.httpx, "stream",
                        lambda *a, **k: _FakeStream([b"x"], headers={"content-length": "999"}))
    with pytest.raises(cover_jobs.CoverError):
        cover_jobs._download_pdf("https://example.com/big.pdf")


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


def test_render_from_pdf_caches(temp_project):
    assert cover_jobs.render_from_pdf("paper-y", _make_pdf()) is True
    dst = cover_jobs.cover_path("paper-y")
    assert dst.exists() and dst.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"


def test_render_from_pdf_skips_when_cached(temp_project):
    p = cover_jobs.cover_path("already")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"sentinel")
    assert cover_jobs.render_from_pdf("already", _make_pdf()) is False
    assert p.read_bytes() == b"sentinel"  # not overwritten


def test_render_from_pdf_none_and_garbage_are_noops(temp_project):
    assert cover_jobs.render_from_pdf("none", None) is False
    assert cover_jobs.render_from_pdf("bad", b"not a pdf at all") is False  # never raises
    assert not cover_jobs.cover_path("none").exists()
    assert not cover_jobs.cover_path("bad").exists()


def test_work_renders_and_caches(temp_project, monkeypatch):
    monkeypatch.setattr(store, "arxiv_id_for", lambda s: "1234.5678")
    monkeypatch.setattr(cover_jobs, "_download_pdf", lambda url: _make_pdf())
    job = cover_jobs.CoverJob(id="j1", slug="paper-x")
    cover_jobs._work(job)
    dst = cover_jobs.cover_path("paper-x")
    assert dst.exists() and dst.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"


def _backfill_fixtures(tmp_path, monkeypatch, papers, cached):
    """Set up a single fake project with `papers` (all retrieved) where `cached` already have a
    cover; stub out projects/store/time so _backfill_work runs offline."""
    from app.models import Paper

    (tmp_path / "corpus").mkdir()
    for slug in papers:
        (tmp_path / "corpus" / f"{slug}.md").write_text("x", encoding="utf-8")
    covers = tmp_path / "covers"
    covers.mkdir()
    for slug in cached:
        (covers / f"{slug}.png").write_bytes(b"cached")

    monkeypatch.setattr(cover_jobs.projects, "list_projects", lambda: [{"id": "P"}])
    # The mid-backfill deletion guard consults the real registry; this fake project has no dir.
    monkeypatch.setattr(cover_jobs.projects, "exists", lambda pid: True)
    monkeypatch.setattr(cover_jobs.store, "list_papers",
                        lambda: [Paper(slug=s, title=s, group="g", list_status="unread")
                                 for s in papers])
    monkeypatch.setattr(cover_jobs.store, "corpus_path",
                        lambda slug: tmp_path / "corpus" / f"{slug}.md")
    monkeypatch.setattr(cover_jobs, "cover_path", lambda slug: covers / f"{slug}.png")
    monkeypatch.setattr(cover_jobs.time, "sleep", lambda *_a: None)
    cover_jobs._backfill_failed.clear()  # module-level; isolate from other tests


def test_backfill_renders_only_coverless_retrieved(tmp_path, monkeypatch):
    _backfill_fixtures(tmp_path, monkeypatch, papers=["a", "b"], cached=["a"])
    rendered: list[str] = []
    monkeypatch.setattr(cover_jobs, "_render_and_cache", lambda slug: rendered.append(slug))

    job = cover_jobs.BackfillJob(id="bf")
    cover_jobs._backfill_work(job)

    assert rendered == ["b"]  # "a" already cached, skipped
    assert (job.scanned, job.rendered, job.skipped) == (2, 1, 0)


def test_backfill_counts_render_failures_as_skips(tmp_path, monkeypatch):
    _backfill_fixtures(tmp_path, monkeypatch, papers=["b"], cached=[])

    def boom(slug):
        raise cover_jobs.CoverError("no source")

    monkeypatch.setattr(cover_jobs, "_render_and_cache", boom)
    job = cover_jobs.BackfillJob(id="bf2")
    cover_jobs._backfill_work(job)

    assert (job.scanned, job.rendered, job.skipped) == (1, 0, 1)


def test_backfill_does_not_retry_a_failed_paper_on_the_next_pass(tmp_path, monkeypatch):
    _backfill_fixtures(tmp_path, monkeypatch, papers=["b"], cached=[])
    attempts: list[str] = []

    def boom(slug):
        attempts.append(slug)
        raise cover_jobs.CoverError("no source")

    monkeypatch.setattr(cover_jobs, "_render_and_cache", boom)
    cover_jobs._backfill_work(cover_jobs.BackfillJob(id="p1"))
    cover_jobs._backfill_work(cover_jobs.BackfillJob(id="p2"))

    assert attempts == ["b"]  # second pass skips it via the negative cache, no re-download


def test_backfill_isolates_a_failing_project(tmp_path, monkeypatch):
    from app import config
    from app.models import Paper

    (tmp_path / "corpus").mkdir()
    (tmp_path / "corpus" / "b.md").write_text("x", encoding="utf-8")
    covers = tmp_path / "covers"
    covers.mkdir()

    def list_papers():
        if config.active_project_id() == "P1":
            raise RuntimeError("unreadable project")
        return [Paper(slug="b", title="b", group="g", list_status="unread")]

    monkeypatch.setattr(cover_jobs.projects, "list_projects",
                        lambda: [{"id": "P1"}, {"id": "P2"}])
    monkeypatch.setattr(cover_jobs.projects, "exists", lambda pid: True)
    monkeypatch.setattr(cover_jobs.store, "list_papers", list_papers)
    monkeypatch.setattr(cover_jobs.store, "corpus_path", lambda slug: tmp_path / "corpus" / f"{slug}.md")
    monkeypatch.setattr(cover_jobs, "cover_path", lambda slug: covers / f"{slug}.png")
    monkeypatch.setattr(cover_jobs.time, "sleep", lambda *_a: None)
    cover_jobs._backfill_failed.clear()
    rendered: list[str] = []
    monkeypatch.setattr(cover_jobs, "_render_and_cache", lambda slug: rendered.append(slug))

    cover_jobs._backfill_work(cover_jobs.BackfillJob(id="bf"))

    assert rendered == ["b"]                    # P1 raised, P2 still backfilled
    assert config.active_project_id() is None   # contextvar restored, no leak
