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


def test_throttled_search_falls_back_to_web_search_for_id(monkeypatch):
    # arXiv query API throttled -> id found via the web-search chain -> PDF fetched directly.
    monkeypatch.setattr(retriever, "search_arxiv",
                        lambda title, max_results=6: (_ for _ in ()).throw(
                            retriever.RetrievalError("arXiv is rate-limiting requests")))
    monkeypatch.setattr(retriever, "_arxiv_id_via_web", lambda title: "2205.14135")
    monkeypatch.setattr(retriever, "_fetch", lambda url: b"%PDF")
    monkeypatch.setattr(retriever, "_extract_pdf", lambda data: "Attention text. " * 40)

    res = retriever.retrieve("FlashAttention")
    assert res["arxiv_id"] == "2205.14135"
    assert res["full_text"].startswith("Attention text.")


def test_throttled_search_with_no_web_hit_reraises_actionable_error(monkeypatch):
    monkeypatch.setattr(retriever, "search_arxiv",
                        lambda title, max_results=6: (_ for _ in ()).throw(
                            retriever.RetrievalError("arXiv is rate-limiting requests right now")))
    monkeypatch.setattr(retriever, "_arxiv_id_via_web", lambda title: None)
    import pytest
    with pytest.raises(retriever.RetrievalError) as e:
        retriever.retrieve("Some Unfindable Paper")
    assert "rate-limiting" in str(e.value)


def _resp(status: int, headers: dict | None = None):
    import httpx
    return httpx.Response(status, headers=headers or {}, content=b"ok",
                          request=httpx.Request("GET", "https://export.arxiv.org/api/query"))


def test_arxiv_get_retries_429_then_succeeds(monkeypatch):
    calls = {"n": 0}

    def fake_get(url, **kw):
        calls["n"] += 1
        return _resp(429) if calls["n"] == 1 else _resp(200)

    monkeypatch.setattr(retriever.httpx, "get", fake_get)
    monkeypatch.setattr(retriever.time, "sleep", lambda s: None)  # no real waiting in tests
    r = retriever._arxiv_get("https://export.arxiv.org/api/query")
    assert r.status_code == 200
    assert calls["n"] == 2  # one 429, one retry that succeeded


def test_arxiv_get_exhausted_429s_raise_actionable_error(monkeypatch):
    monkeypatch.setattr(retriever.httpx, "get", lambda url, **kw: _resp(429))
    monkeypatch.setattr(retriever.time, "sleep", lambda s: None)
    import pytest
    with pytest.raises(retriever.RetrievalError) as e:
        retriever._arxiv_get("https://export.arxiv.org/api/query")
    # The message must tell the user what to do, not just echo an HTTP code.
    assert "rate-limiting" in str(e.value)
    assert "Provide a source" in str(e.value)
