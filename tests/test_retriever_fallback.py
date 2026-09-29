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
    # DR-167: a title-search hit is filed only when its PDF names the title, so the fake PDF
    # carries it — a bare "Full text." body would now (correctly) be sent to confirmation.
    monkeypatch.setattr(retriever, "_extract_pdf",
                        lambda data: "A Real Paper Title. Author. " + "Full text. " * 60)
    monkeypatch.setattr(retriever, "search_arxiv", lambda title, max_results=6: [
        {"arxiv_id": "2401.00001", "title": title, "abstract": "",
         "pdf_url": "https://arxiv.org/pdf/2401.00001", "score": 0.99},
    ])

    res = retriever.retrieve("A Real Paper Title", arxiv_id="bad-id")
    assert "bad-id" in fetched[0]                 # the wrong id was tried first
    assert res["arxiv_id"] == "2401.00001"        # then title search rescued it
    assert "Full text." in res["full_text"]


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


# ---- DR-167: the title-search path checks the PDF too --------------------------------------
#
# The third wrong full text in two days arrived through the ORDINARY title search, the day after
# DR-165 guarded the throttled fallback and the hunt: "Monolithically Stackable 1T1C 3-D DRAM:
# A Technical Survey" scored past the 0.62 floor against arXiv's "Row Hammer Effect and Floating
# Body Effect of Monolithic 3D Stackable 1T1C DRAM" — a different paper sharing most of the
# title words — and the search path filed it with nothing to say so.

_SURVEY = "Monolithically Stackable 1T1C 3-D DRAM: A Technical Survey"
_ROW_HAMMER_HEAD = (
    "Row Hammer Effect and Floating Body Effect of Monolithic 3D Stackable 1T1C DRAM Sungwon "
    "Cho, Po-Kai Hsu, Kiseok Lee, Janak Sharda, Suman Datta, Shimeng Yu School of Electrical and "
    "Computer Engineering, Georgia Institute of Technology, GA, USA Abstract— Monolithic 3D "
    "stackable 1T1C DRAM technology is on the rise, with initial prototypes reported by the "
    "industry. " + "This work presents a comprehensive reliability study. " * 40
)


def _search_returns(monkeypatch, title: str, score: float):
    monkeypatch.setattr(retriever, "search_arxiv", lambda t, max_results=6: [
        {"arxiv_id": "2511.00638", "title": title, "abstract": "",
         "pdf_url": "https://arxiv.org/pdf/2511.00638", "score": score},
    ])


def test_a_search_match_whose_pdf_does_not_name_the_title_is_not_filed(monkeypatch):
    _search_returns(monkeypatch, "Row Hammer Effect and Floating Body Effect of Monolithic 3D "
                                 "Stackable 1T1C DRAM", 0.7)
    monkeypatch.setattr(retriever, "_fetch", lambda url: b"%PDF")
    monkeypatch.setattr(retriever, "_extract_pdf", lambda data: _ROW_HAMMER_HEAD)

    res = retriever.retrieve(_SURVEY)

    # Not a wrong paper, not an error: the reader's confirmation case, with the candidate's REAL
    # title on the list and a reason that names it.
    assert res.get("needs_confirmation") is True
    assert "full_text" not in res
    assert res["candidates"][0]["arxiv_id"] == "2511.00638"
    assert "Row Hammer" in res["reason"]


def test_a_search_match_whose_pdf_names_the_title_is_still_filed(monkeypatch):
    _search_returns(monkeypatch, _SURVEY, 0.7)
    monkeypatch.setattr(retriever, "_fetch", lambda url: b"%PDF")
    monkeypatch.setattr(retriever, "_extract_pdf",
                        lambda data: _SURVEY + " Jane Author. Abstract. " + "Body. " * 80)

    res = retriever.retrieve(_SURVEY)
    assert res["arxiv_id"] == "2511.00638"
    assert res["full_text"].startswith(_SURVEY)


def test_a_reader_picked_candidate_is_the_override_and_is_not_checked(monkeypatch):
    """DR-165's rule: an explicit id is the reader's own decision. Picking a candidate from the
    confirmation list retrieves by id, so a paper the reader insists on is filed as asked."""
    monkeypatch.setattr(retriever, "_fetch", lambda url: b"%PDF")
    monkeypatch.setattr(retriever, "_extract_pdf", lambda data: _ROW_HAMMER_HEAD)
    monkeypatch.setattr(retriever, "fetch_arxiv_metadata", lambda aid: None)

    res = retriever.retrieve(_SURVEY, arxiv_id="2511.00638")
    assert res["arxiv_id"] == "2511.00638"
    assert res["full_text"] == _ROW_HAMMER_HEAD
