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


@pytest.mark.parametrize("url,expected", [
    # Old-style (pre-2007) archive ids: an /abs/ link for one must not fall through to the
    # raw-URL branch and then fail with a message claiming abs links work.
    ("https://arxiv.org/abs/cond-mat/0703185", "cond-mat/0703185"),
    ("https://arxiv.org/pdf/hep-th/9901001v2", "hep-th/9901001v2"),
    ("https://arxiv.org/abs/math.GT/0309136", "math.GT/0309136"),
])
def test_old_style_archive_ids_extracted(url, expected):
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


def test_a_pasted_url_whose_fetch_fails_does_not_silently_swap_papers(monkeypatch):
    """The reader pastes a link precisely to override the automatic match — a failed fetch of
    that exact id must surface, not fall back to a best-title-match that may be the very paper
    being overridden. (The raw pdf_url branch this replaced always surfaced its failure.)"""
    def failing_fetch(url):
        raise RetrievalError("HTTP 404")

    def no_search(*a, **k):
        raise AssertionError("title search must not run for an explicitly pasted URL")

    monkeypatch.setattr(retriever, "_fetch", failing_fetch)
    monkeypatch.setattr(retriever, "search_arxiv", no_search)
    with pytest.raises(RetrievalError, match="404"):
        retriever.retrieve("Some Title", pdf_url="https://arxiv.org/abs/2608.99999")


def test_a_bare_id_still_falls_back_to_title_search(monkeypatch):
    """The graph pipeline supplies extracted (often wrong) ids WITHOUT a pasted URL — that
    fallback must survive the explicit-URL hardening above."""
    monkeypatch.setattr(retriever, "_fetch",
                        lambda url: (_ for _ in ()).throw(RetrievalError("HTTP 404"))
                        if "9999" in url else b"%PDF-fake")
    monkeypatch.setattr(retriever, "_extract_pdf", lambda data, **k: "Full text. " * 60)
    monkeypatch.setattr(retriever, "search_arxiv", lambda title: [
        {"arxiv_id": "2201.11705", "title": title, "score": 0.99,
         "pdf_url": "https://arxiv.org/pdf/2201.11705"}])
    out = retriever.retrieve("Some Title", arxiv_id="2608.99999")
    assert out["arxiv_id"] == "2201.11705"


def test_pdf_marker_within_the_full_spec_allowance_is_accepted(monkeypatch):
    """%PDF- may start anywhere in the first 1024 bytes; a marker beginning at 1020-1023 must
    not be truncated by the sniff window."""
    data = b"\x00" * 1023 + b"%PDF-1.4 rest"
    assert retriever.looks_like_pdf(data) is True
    assert retriever.looks_like_pdf(b"\x00" * 1030 + b"%PDF-1.4") is False


def test_upload_refusal_speaks_upload_not_link():
    with pytest.raises(RetrievalError, match="Upload the paper's PDF"):
        retriever.extract_pdf_bytes(b"<html>not a pdf</html>")


def test_html_bytes_refused_with_a_legible_message():
    with pytest.raises(RetrievalError, match="web page, not a PDF"):
        retriever._extract_pdf(b"<!DOCTYPE html><html><body>arXiv HTML view</body></html>")


def test_non_pdf_bytes_refused_even_when_not_html():
    with pytest.raises(RetrievalError, match="not a PDF"):
        retriever._extract_pdf(b"\x00\x01 binary junk that is not a pdf")


def test_truncated_pdf_fails_as_a_retrieval_error_not_a_pypdf_internal():
    with pytest.raises(RetrievalError, match="Could not parse"):
        retriever._extract_pdf(b"%PDF-1.4 then nothing that pypdf can read")


def test_pdf_cleanup_repairs_unpaired_surrogates_without_corrupting_a_valid_pair():
    # Exact malformed shape from the Stratum PDF: each U+D835 is followed by the digit 2,
    # rather than by a low surrogate. A real high/low pair is normalized to its scalar.
    cleaned = retriever._clean("SelectTop-\ud8352\ud8352 / valid \ud83d\ude00")

    assert cleaned == "SelectTop-\ufffd2\ufffd2 / valid 😀"
    assert cleaned.encode("utf-8")
