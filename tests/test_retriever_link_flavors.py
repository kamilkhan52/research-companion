"""A pasted arXiv link of any flavor resolves to the paper, and a non-PDF download fails legibly.

DR-087: `https://arxiv.org/html/<id>` pasted into "Use your own source" reached the raw
pdf_url branch, the HTML page bytes went to pypdf, and pypdf's truncated-stream internal
("Stream has ended unexpectedly") surfaced verbatim as the job error on the device.
"""
from __future__ import annotations

import pytest
from app import retriever
from app.retriever import RetrievalError


@pytest.mark.parametrize("url,expected", [
    ("https://arxiv.org/html/2608.11668", "2608.11668"),
    ("https://arxiv.org/abs/2608.11668", "2608.11668"),
    ("https://arxiv.org/pdf/2608.11668", "2608.11668"),
    ("https://arxiv.org/html/2608.11668v2", "2608.11668v2"),
    ("https://ARXIV.ORG/abs/2201.11705", "2201.11705"),
])
def test_arxiv_id_extracted_from_any_paper_url_flavor(url, expected):
    assert retriever._arxiv_id_from_url(url) == expected


@pytest.mark.parametrize("url", [
    "http://evil.example/html/2201.11705#arxiv.org",   # fragment lookalike, wrong host
    "http://evil.example/arxiv.org/abs/2201.11705",    # path-segment lookalike
    "https://arxiv.org/list/cs.AR/recent",             # arXiv, but not a paper URL
    "https://example.com/paper.pdf",                   # ordinary direct PDF link
])
def test_non_paper_urls_do_not_yield_an_id(url):
    assert retriever._arxiv_id_from_url(url) is None


def test_html_link_takes_the_arxiv_id_branch(monkeypatch):
    """End to end through `retrieve`: the /html/ page itself must never be downloaded — the
    fetch goes to the canonical PDF and the result carries the arXiv identity."""
    fetched = []

    def fake_fetch(url):
        fetched.append(url)
        return b"%PDF-fake"

    monkeypatch.setattr(retriever, "_fetch", fake_fetch)
    monkeypatch.setattr(retriever, "_extract_pdf", lambda data: "Full text. " * 60)
    monkeypatch.setattr(retriever, "fetch_arxiv_metadata",
                        lambda aid: {"arxiv_id": aid, "title": "Canonical Title", "abstract": ""})

    out = retriever.retrieve("Pasted Title", pdf_url="https://arxiv.org/html/2608.11668")

    assert fetched == ["https://arxiv.org/pdf/2608.11668"]
    assert out["arxiv_id"] == "2608.11668"
    assert out["source"] == "https://arxiv.org/abs/2608.11668"
    assert out["matched_title"] == "Canonical Title"


def test_non_arxiv_pdf_url_still_fetched_directly(monkeypatch):
    monkeypatch.setattr(retriever, "_fetch", lambda url: b"%PDF-fake")
    monkeypatch.setattr(retriever, "_extract_pdf", lambda data: "Full text. " * 60)
    out = retriever.retrieve("T", pdf_url="https://example.com/paper.pdf")
    assert out["arxiv_id"] is None
    assert out["source"] == "https://example.com/paper.pdf"


def test_html_bytes_refused_with_a_legible_message():
    with pytest.raises(RetrievalError, match="web page, not a PDF"):
        retriever._extract_pdf(b"<!DOCTYPE html><html><body>arXiv HTML view</body></html>")


def test_non_pdf_bytes_refused_even_when_not_html():
    with pytest.raises(RetrievalError, match="not a PDF"):
        retriever._extract_pdf(b"\x00\x01 binary junk that is not a pdf")


def test_truncated_pdf_fails_as_a_retrieval_error_not_a_pypdf_internal():
    with pytest.raises(RetrievalError, match="Could not parse"):
        retriever._extract_pdf(b"%PDF-1.4 then nothing that pypdf can read")
