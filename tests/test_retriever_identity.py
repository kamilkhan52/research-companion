from app import retriever


def test_explicit_arxiv_retrieval_reports_canonical_metadata_title(monkeypatch):
    monkeypatch.setattr(
        retriever,
        "fetch_arxiv_metadata",
        lambda aid: {
            "arxiv_id": aid,
            "title": "Attention Is All You Need",
            "abstract": "Abstract",
        },
    )
    monkeypatch.setattr(retriever, "_fetch", lambda url: b"pdf")
    monkeypatch.setattr(retriever, "_extract_pdf", lambda data: "full text")

    result = retriever.retrieve("arXiv 1706.03762", arxiv_id="1706.03762")

    assert result["matched_title"] == "Attention Is All You Need"
    assert result["arxiv_id"] == "1706.03762"
