"""DR-139 — a DOI is resolved to a readable copy, never downloaded from the publisher.

Kamil pasted an ACM DOI and the paper "was not found". `https://doi.org/10.1145/…` redirects to
`dl.acm.org`, which answers this server with a Cloudflare challenge (HTTP 403 and an HTML body),
so the download could never have worked however open-access the article is. The lane below asks
OpenAlex where the work's copies are and fetches one of those instead; when none is reachable it
says so and names the way in that does work — the reader's own browser plus PDF upload.
"""
from __future__ import annotations

import pytest
from app import retriever
from app.retriever import RetrievalError

DOI = "10.1145/3637867"


@pytest.mark.parametrize("value,expected", [
    ("https://doi.org/10.1145/3637867", DOI),
    ("http://dx.doi.org/10.1145/3637867", DOI),
    ("HTTPS://DOI.ORG/10.1145/3637867", DOI),
    ("doi:10.1145/3637867", DOI),
    ("10.1145/3637867", DOI),
    ("  10.1145/3637867  ", DOI),
    # Trailing prose punctuation is not part of the identifier.
    ("10.1145/3637867.", DOI),
])
def test_a_doi_given_as_an_identifier_is_recognised(value, expected):
    assert retriever.doi_identifier(value) == expected


@pytest.mark.parametrize("value", [
    "",
    "2608.11668",                                  # an arXiv id
    "cond-mat/0703185",                            # an old-style arXiv id
    "https://arxiv.org/abs/2608.11668",
    # A direct PDF link that merely CONTAINS a DOI is still a direct download: interpreting it as
    # an identifier would skip the copy the reader actually pointed at.
    "https://repo.example/papers/10.1145/3637867.pdf",
    "https://dl.acm.org/doi/pdf/10.1145/3637867",
])
def test_other_identifiers_and_plain_urls_are_not_dois(value):
    assert retriever.doi_identifier(value) is None


def _fake_openalex(monkeypatch, record):
    monkeypatch.setattr(retriever, "_open_access_record", lambda doi: record)


def test_a_doi_retrieves_the_first_open_access_copy_that_answers(monkeypatch):
    """The publisher's own copy is listed first and refuses; the repository copy is the paper."""
    tried: list[str] = []

    def fake_fetch(url):
        tried.append(url)
        if "dl.acm.org" in url:
            raise RetrievalError("Download refused for the ACM link: 403")
        return b"%PDF-repository-copy"

    _fake_openalex(monkeypatch, {
        "title": "New Computer Evaluation Metrics for a Changing World",
        "is_oa": True,
        "pdf_urls": [
            "https://dl.acm.org/doi/pdf/10.1145/3637867",
            "https://repo.example/3637867.pdf",
        ],
        "landing_pages": [],
    })
    monkeypatch.setattr(retriever, "_fetch", fake_fetch)
    monkeypatch.setattr(retriever, "_extract_pdf", lambda data: "Full text. " * 60)
    monkeypatch.setattr(retriever, "search_arxiv", _must_not_search)

    out = retriever.retrieve("whatever the reader typed", pdf_url=f"https://doi.org/{DOI}")
    assert tried == ["https://dl.acm.org/doi/pdf/10.1145/3637867", "https://repo.example/3637867.pdf"]
    assert out["source"] == "https://repo.example/3637867.pdf"
    assert out["matched_title"] == "New Computer Evaluation Metrics for a Changing World"
    assert out["pdf_bytes"] == b"%PDF-repository-copy"


def _must_not_search(*_args, **_kwargs):
    raise AssertionError("the arXiv title search must not run once a copy has been retrieved")


def test_a_challenge_page_is_not_filed_as_the_paper(monkeypatch):
    """Some challenged hosts answer 200 with HTML. Extracting that would store an error page as
    the paper's text, which is worse than failing."""
    _fake_openalex(monkeypatch, {
        "title": "", "is_oa": True,
        "pdf_urls": ["https://dl.acm.org/doi/pdf/10.1145/3637867"], "landing_pages": [],
    })
    monkeypatch.setattr(retriever, "_fetch", lambda url: b"<!DOCTYPE html><title>Just a moment")
    monkeypatch.setattr(retriever, "_extract_pdf",
                        lambda data: pytest.fail("an HTML challenge page reached the extractor"))
    monkeypatch.setattr(retriever, "search_arxiv", lambda title, **kw: [])

    with pytest.raises(RetrievalError) as excinfo:
        retriever.retrieve("A Title", pdf_url=f"https://doi.org/{DOI}")
    assert DOI in str(excinfo.value)
    assert "upload" in str(excinfo.value).lower()


def test_an_unreachable_doi_falls_back_to_arxiv_under_the_dois_own_title(monkeypatch):
    """A closed publisher copy but an arXiv preprint of the same work: retrieve the preprint,
    searched under the title OpenAlex gave for the DOI rather than whatever the reader typed."""
    searched: list[str] = []

    def fake_search(title, max_results=6):
        searched.append(title)
        return [{"arxiv_id": "2401.00001", "title": "New Computer Evaluation Metrics",
                 "pdf_url": "https://arxiv.org/pdf/2401.00001", "score": 0.97}]

    _fake_openalex(monkeypatch, {
        "title": "New Computer Evaluation Metrics", "is_oa": False,
        "pdf_urls": [], "landing_pages": ["https://doi.org/10.1145/3637867"],
    })
    monkeypatch.setattr(retriever, "search_arxiv", fake_search)
    monkeypatch.setattr(retriever, "_fetch", lambda url: b"%PDF-preprint")
    monkeypatch.setattr(retriever, "_extract_pdf", lambda data: "Full text. " * 60)

    out = retriever.retrieve("metrics paper", pdf_url=f"https://doi.org/{DOI}")
    assert searched == ["New Computer Evaluation Metrics"]
    assert out["arxiv_id"] == "2401.00001"


def test_a_near_miss_on_a_doi_asks_the_human_instead_of_swapping_papers(monkeypatch):
    """A DOI names ONE work. A 0.7 title match is good enough for a free-text search and not good
    enough to answer an identifier, so it must come back as a confirmation."""
    weak = [{"arxiv_id": "2401.00002", "title": "Evaluation Metrics for Changing Worlds",
             "pdf_url": "https://arxiv.org/pdf/2401.00002", "score": 0.7}]
    _fake_openalex(monkeypatch, {
        "title": "New Computer Evaluation Metrics", "is_oa": False,
        "pdf_urls": [], "landing_pages": [],
    })
    monkeypatch.setattr(retriever, "search_arxiv", lambda title, max_results=6: weak)
    monkeypatch.setattr(retriever, "_fetch",
                        lambda url: pytest.fail("a 0.7 match must not be downloaded for a DOI"))

    out = retriever.retrieve("metrics paper", pdf_url=f"https://doi.org/{DOI}")
    assert out["needs_confirmation"] is True
    assert out["candidates"] == weak
    # The same match WOULD be retrieved for an ordinary title search, which is the point of the
    # raised threshold rather than a stricter default.
    assert weak[0]["score"] > 0.62


def test_a_bare_doi_typed_into_add_a_paper_takes_the_lane(monkeypatch):
    """The client sends anything without a scheme as `arxiv_id`, so a typed DOI arrives there."""
    _fake_openalex(monkeypatch, {
        "title": "A Paper", "is_oa": True,
        "pdf_urls": ["https://repo.example/a.pdf"], "landing_pages": [],
    })
    monkeypatch.setattr(retriever, "_fetch", lambda url: b"%PDF-ok")
    monkeypatch.setattr(retriever, "_extract_pdf", lambda data: "Full text. " * 60)

    out = retriever.retrieve("", arxiv_id=DOI)
    assert out["source"] == "https://repo.example/a.pdf"


def test_a_publisher_pdf_link_is_tried_first_and_then_resolved_as_a_doi(monkeypatch):
    """`dl.acm.org/doi/pdf/<doi>` is a direct link the reader chose — it is attempted as one, and
    only its FAILURE turns the DOI in its path into the fallback."""
    tried: list[str] = []

    def fake_fetch(url):
        tried.append(url)
        if "dl.acm.org" in url:
            raise RetrievalError("403")
        return b"%PDF-elsewhere"

    _fake_openalex(monkeypatch, {
        "title": "A Paper", "is_oa": True,
        "pdf_urls": ["https://repo.example/a.pdf"], "landing_pages": [],
    })
    monkeypatch.setattr(retriever, "_fetch", fake_fetch)
    monkeypatch.setattr(retriever, "_extract_pdf", lambda data: "Full text. " * 60)

    out = retriever.retrieve("A Paper", pdf_url="https://dl.acm.org/doi/pdf/10.1145/3637867")
    assert tried == ["https://dl.acm.org/doi/pdf/10.1145/3637867", "https://repo.example/a.pdf"]
    assert out["source"] == "https://repo.example/a.pdf"


def test_openalex_being_unavailable_is_not_a_failed_retrieval(monkeypatch):
    """The lookup is best effort: an outage leaves the ordinary arXiv title search in charge."""
    _fake_openalex(monkeypatch, None)
    monkeypatch.setattr(retriever, "search_arxiv", lambda title, max_results=6: [
        {"arxiv_id": "2401.00003", "title": "A Paper", "pdf_url": "https://arxiv.org/pdf/2401.00003",
         "score": 0.99},
    ])
    monkeypatch.setattr(retriever, "_fetch", lambda url: b"%PDF-ok")
    monkeypatch.setattr(retriever, "_extract_pdf", lambda data: "Full text. " * 60)

    out = retriever.retrieve("A Paper", pdf_url=f"https://doi.org/{DOI}")
    assert out["arxiv_id"] == "2401.00003"


def test_only_a_bounded_number_of_open_access_copies_is_tried(monkeypatch):
    """OpenAlex lists every mirror it has ever seen. Each attempt is a full PDF download with its
    own timeout inside a background job, so the tail must not be walked: the hazard is that the
    count grows with the record, not that it reaches some floor."""
    tried: list[str] = []

    def fake_fetch(url):
        tried.append(url)
        raise RetrievalError("403")

    _fake_openalex(monkeypatch, {
        "title": "A Paper", "is_oa": True,
        "pdf_urls": [f"https://mirror{i}.example/a.pdf" for i in range(20)],
        "landing_pages": [],
    })
    monkeypatch.setattr(retriever, "_fetch", fake_fetch)
    monkeypatch.setattr(retriever, "search_arxiv", lambda title, max_results=6: [])

    with pytest.raises(RetrievalError):
        retriever.retrieve("A Paper", pdf_url=f"https://doi.org/{DOI}")
    assert len(tried) == retriever._MAX_OA_COPIES
    # Best-first: the ones tried are the front of the list, not an arbitrary slice.
    assert tried == [f"https://mirror{i}.example/a.pdf" for i in range(retriever._MAX_OA_COPIES)]


def test_a_throttled_arxiv_api_does_not_let_a_web_hit_answer_a_doi(monkeypatch):
    """The rate-limit fallback files whatever the web search found without comparing titles. That
    is tolerable for a free-text search and not for a DOI, which names ONE work — and Kamil's
    paper is not on arXiv, so this is the path that would file a different paper as his."""
    _fake_openalex(monkeypatch, {
        "title": "New Computer Evaluation Metrics for a Changing World", "is_oa": False,
        "pdf_urls": [], "landing_pages": [],
    })

    def throttled(title, max_results=6):
        raise RetrievalError("arXiv query API is rate limiting us (429)")

    monkeypatch.setattr(retriever, "search_arxiv", throttled)
    monkeypatch.setattr(retriever, "_arxiv_id_via_web",
                        lambda title: pytest.fail("a DOI must not be answered by a web-search id"))
    monkeypatch.setattr(retriever, "_fetch",
                        lambda url: pytest.fail("nothing may be downloaded on this path"))

    with pytest.raises(RetrievalError) as excinfo:
        retriever.retrieve("metrics paper", pdf_url=f"https://doi.org/{DOI}")
    assert DOI in str(excinfo.value)
    assert "upload" in str(excinfo.value).lower()


def test_the_web_search_fallback_still_serves_an_ordinary_title_search(monkeypatch):
    """The guard above is scoped to the DOI lane — it must not disable the rate-limit fallback
    for the free-text searches it was built for."""
    def throttled(title, max_results=6):
        raise RetrievalError("arXiv query API is rate limiting us (429)")

    monkeypatch.setattr(retriever, "search_arxiv", throttled)
    monkeypatch.setattr(retriever, "_arxiv_id_via_web", lambda title: "2401.00009")
    monkeypatch.setattr(retriever, "_fetch", lambda url: b"%PDF-ok")
    monkeypatch.setattr(retriever, "_extract_pdf", lambda data: "Full text. " * 60)

    out = retriever.retrieve("A Paper Not On The DOI Lane")
    assert out["arxiv_id"] == "2401.00009"
