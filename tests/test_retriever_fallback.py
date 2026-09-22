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
    monkeypatch.setattr(retriever, "_arxiv_ids_via_web", lambda title: ["2205.14135"])
    monkeypatch.setattr(retriever, "_fetch", lambda url: b"%PDF")
    monkeypatch.setattr(retriever, "_extract_pdf",
                        lambda data: "FlashAttention: fast attention. " + "Attention text. " * 40)

    res = retriever.retrieve("FlashAttention")
    assert res["arxiv_id"] == "2205.14135"
    assert res["full_text"].startswith("FlashAttention:")


def _throttled(monkeypatch):
    monkeypatch.setattr(retriever, "search_arxiv",
                        lambda title, max_results=6: (_ for _ in ()).throw(
                            retriever.RetrievalError("arXiv is rate-limiting requests right now")))


# DR-165, verbatim shapes: the web search for a non-arXiv IEEE title returned an arXiv paper that
# CITES it, and that citer was filed as the full text. Its bibliography carries the title — far
# past the first page.
_WANTED = ("A 135 GBps/Gbit 0.66 pJ/bit Stacked Embedded DRAM with Multilayer Arrays by Fine "
           "Pitch Hybrid Bonding and Mini-TSV")
_CITER = ("Tasa: Thermal-aware 3D-Stacked Architecture Design with Bandwidth Sharing for LLM "
          "Inference. Siyuan He, Peiran Yan. Abstract: stacked DRAM with hybrid bonding offers "
          "bandwidth for LLM inference. " + "Body text about thermal design. " * 200
          + "References [18] S. Wang et al., " + _WANTED + ", VLSI 2023.")


def test_throttled_fallback_refuses_a_paper_that_only_cites_the_title(monkeypatch):
    _throttled(monkeypatch)
    monkeypatch.setattr(retriever, "_arxiv_ids_via_web", lambda title: ["2508.07252"])
    monkeypatch.setattr(retriever, "_fetch", lambda url: b"%PDF")
    monkeypatch.setattr(retriever, "_extract_pdf", lambda data: _CITER)
    import pytest
    with pytest.raises(retriever.RetrievalError) as e:
        retriever.retrieve(_WANTED)
    # The original, actionable throttle error — not a silently filed citer.
    assert "rate-limiting" in str(e.value)


def test_throttled_fallback_skips_a_citer_and_takes_the_paper_itself(monkeypatch):
    _throttled(monkeypatch)
    monkeypatch.setattr(retriever, "_arxiv_ids_via_web",
                        lambda title: ["2508.07252", "2401.00077"])
    texts = {"https://arxiv.org/pdf/2508.07252": _CITER,
             "https://arxiv.org/pdf/2401.00077": _WANTED + ". Song Wang. Abstract. " * 30}
    monkeypatch.setattr(retriever, "_fetch", lambda url: url.encode())
    monkeypatch.setattr(retriever, "_extract_pdf", lambda data: texts[data.decode()])
    res = retriever.retrieve(_WANTED)
    assert res["arxiv_id"] == "2401.00077"


def test_throttled_fallback_moves_past_a_candidate_that_fails_to_download(monkeypatch):
    _throttled(monkeypatch)
    monkeypatch.setattr(retriever, "_arxiv_ids_via_web",
                        lambda title: ["2508.07252", "2401.00077"])

    def fetch(url):
        if "2508.07252" in url:
            raise retriever.RetrievalError("404")
        return b"%PDF"

    monkeypatch.setattr(retriever, "_fetch", fetch)
    monkeypatch.setattr(retriever, "_extract_pdf", lambda data: _WANTED + " text. " * 50)
    assert retriever.retrieve(_WANTED)["arxiv_id"] == "2401.00077"


def test_web_ids_are_distinct_ranked_and_capped(monkeypatch):
    from app import research_tools
    out = ("https://arxiv.org/abs/2508.07252 then arxiv.org/pdf/2508.07252v3 and "
           "arxiv.org/html/2604.08044v1, arxiv.org/abs/2401.00001, arxiv.org/abs/2401.00002")
    monkeypatch.setattr(research_tools, "web_search", lambda objective, queries: out)
    assert retriever._arxiv_ids_via_web("x") == ["2508.07252", "2604.08044", "2401.00001"]


def test_throttled_search_with_no_web_hit_reraises_actionable_error(monkeypatch):
    monkeypatch.setattr(retriever, "search_arxiv",
                        lambda title, max_results=6: (_ for _ in ()).throw(
                            retriever.RetrievalError("arXiv is rate-limiting requests right now")))
    monkeypatch.setattr(retriever, "_arxiv_ids_via_web", lambda title: [])
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
