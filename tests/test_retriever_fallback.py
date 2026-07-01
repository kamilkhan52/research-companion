"""retriever: a supplied arXiv id that fails to fetch (common for ids the graph pipeline
extracted from a bibliography — often wrong) must fall back to a title search rather than
hard-failing the whole start."""
from __future__ import annotations

from app import retriever


def test_bad_arxiv_id_falls_back_to_title_search(monkeypatch):
    fetched = []

    def fake_fetch(url):
        fetched.append(url)
        if "bad-id" in url:
            raise retriever.RetrievalError("404 Not Found")
        return b"%PDF-fake-bytes"

    monkeypatch.setattr(retriever, "_fetch", fake_fetch)
    monkeypatch.setattr(retriever, "_extract_pdf", lambda data: "Full text. " * 60)
    monkeypatch.setattr(retriever, "search_arxiv", lambda title, max_results=6: [
        {"arxiv_id": "2401.00001", "title": title, "abstract": "",
         "pdf_url": "https://arxiv.org/pdf/2401.00001", "score": 0.99},
    ])

    res = retriever.retrieve("A Real Paper Title", arxiv_id="bad-id")
    assert "bad-id" in fetched[0]                 # the wrong id was tried first
    assert res["arxiv_id"] == "2401.00001"        # then title search rescued it
    assert res["full_text"].startswith("Full text.")


def test_bad_arxiv_id_with_no_title_still_raises(monkeypatch):
    monkeypatch.setattr(retriever, "_fetch",
                        lambda url: (_ for _ in ()).throw(retriever.RetrievalError("404")))
    import pytest
    with pytest.raises(retriever.RetrievalError):
        retriever.retrieve("", arxiv_id="bad-id")
