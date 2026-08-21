from __future__ import annotations

from typing import Any

import pytest
from app import semantic_scholar as s2


class FakeResponse:
    def __init__(self, status: int, payload: Any, headers: dict[str, str] | None = None):
        self.status_code = status
        self._payload = payload
        self.headers = headers or {}

    def json(self):
        return self._payload


class FakeClient:
    def __init__(self, *responses: FakeResponse):
        self.responses = list(responses)
        self.calls: list[dict[str, Any]] = []
        self.closed = False

    def get(self, path: str, *, params: dict, headers: dict):
        self.calls.append({"path": path, "params": params, "headers": headers})
        return self.responses.pop(0)

    def close(self):
        self.closed = True


def no_wait_pacer() -> s2.RequestPacer:
    return s2.RequestPacer(interval=0)


def test_request_pacer_serializes_with_the_configured_gap():
    now = [10.0]
    sleeps: list[float] = []

    def sleep(seconds: float):
        sleeps.append(seconds)
        now[0] += seconds

    pacer = s2.RequestPacer(interval=1.1, sleep=sleep, clock=lambda: now[0])
    response = FakeResponse(200, {})
    assert pacer.call(lambda: response) is response
    assert pacer.call(lambda: response) is response
    assert sleeps == [pytest.approx(1.1)]


def test_paper_identifier_prefers_arxiv_and_strips_version():
    assert s2.paper_identifier(arxiv_id="2401.09670v2", doi="10.1/fallback") == "ARXIV:2401.09670"
    assert s2.paper_identifier(doi="https://doi.org/10.1000/example") == "DOI:10.1000/example"


def test_resolve_paper_uses_key_header_without_exposing_it_in_result():
    client = FakeClient(FakeResponse(200, {"data": [{"paperId": "s2-id", "title": "Paper"}]}))
    result = s2.resolve_paper("Paper", key="private-key", client=client, pacer=no_wait_pacer())
    assert result == {"paperId": "s2-id", "title": "Paper"}
    assert client.calls[0]["headers"] == {"x-api-key": "private-key"}
    assert "private-key" not in repr(result)


def test_search_papers_normalizes_cross_venue_results_and_allows_anonymous_access():
    client = FakeClient(FakeResponse(200, {"data": [{
        "paperId": "s2-landmark",
        "title": "Conference Landmark",
        "abstract": "A systems result.",
        "authors": [{"authorId": "a1", "name": "A. Author"}],
        "year": 2019,
        "venue": "OSDI",
        "externalIds": {"DOI": "10.1/example"},
        "url": "https://www.semanticscholar.org/paper/s2-landmark",
        "citationCount": 500,
        "influentialCitationCount": 30,
        "fieldsOfStudy": ["Computer Science"],
        "publicationTypes": ["Conference"],
        "publicationDate": "2019-10-01",
    }]}))

    result = s2.search_papers(
        "memory systems", key="", client=client, pacer=no_wait_pacer()
    )

    assert result[0] == {
        "provider": "semantic_scholar",
        "paper_id": "s2-landmark",
        "title": "Conference Landmark",
        "abstract": "A systems result.",
        "authors": ["A. Author"],
        "author_ids": ["a1"],
        "year": 2019,
        "venue": "OSDI",
        "arxiv_id": None,
        "doi": "10.1/example",
        "url": "https://doi.org/10.1/example",
        "provider_url": "https://www.semanticscholar.org/paper/s2-landmark",
        "pdf_url": "",
        "citation_count": 500,
        "influential_citation_count": 30,
        "fields_of_study": ["Computer Science"],
        "publication_types": ["Conference"],
        "publication_date": "2019-10-01",
        "category": "Computer Science",
    }
    assert client.calls[0]["path"] == "/paper/search"
    assert client.calls[0]["headers"] == {}
    assert client.calls[0]["params"]["fields"] == s2.SEARCH_FIELDS


def test_search_papers_rejects_malformed_provider_payload():
    client = FakeClient(FakeResponse(200, {"data": {}}))
    with pytest.raises(s2.SemanticScholarError, match="malformed search metadata"):
        s2.search_papers("query", key="", client=client, pacer=no_wait_pacer())


def test_bulk_search_follows_tokens_and_preserves_the_incremental_date():
    row = {
        "paperId": "p1", "title": "Wide result", "abstract": "a", "authors": [],
        "year": 2026, "externalIds": {}, "citationCount": 1,
    }
    client = FakeClient(
        FakeResponse(200, {"token": "next-page", "data": [row]}),
        FakeResponse(200, {"data": [{**row, "paperId": "p2", "title": "Second"}]}),
    )

    results, audit = s2.bulk_search_papers(
        "memory systems", from_date="2026-07-01", key="", client=client,
        pacer=no_wait_pacer())

    assert [r["paper_id"] for r in results] == ["p1", "p2"]
    assert audit == {"pages": 2, "complete": True, "next_token": None, "rows": 2,
                     "cancelled": False}
    assert client.calls[0]["path"] == "/paper/search/bulk"
    assert client.calls[0]["params"]["publicationDateOrYear"] == "2026-07-01:"
    assert client.calls[0]["params"]["limit"] == 1000
    assert client.calls[1]["params"]["token"] == "next-page"


def test_bulk_search_reports_a_cap_before_the_continuation_is_exhausted():
    rows = [{"paperId": f"p{i}", "title": f"P{i}"} for i in range(3)]
    client = FakeClient(FakeResponse(200, {"token": "more", "data": rows}))
    results, audit = s2.bulk_search_papers(
        "q", limit=2, key="", client=client, pacer=no_wait_pacer())
    assert len(results) == 2
    assert audit["complete"] is False
    assert audit["next_token"] == "more"


def test_bulk_search_refuses_a_repeated_token_instead_of_looping_forever():
    row = {"paperId": "p", "title": "P"}
    client = FakeClient(
        FakeResponse(200, {"token": "same", "data": [row]}),
        FakeResponse(200, {"token": "same", "data": [row]}),
    )
    with pytest.raises(s2.SemanticScholarError, match="repeated"):
        s2.bulk_search_papers("q", key="", client=client, pacer=no_wait_pacer())


def test_bulk_search_cancellation_stops_before_the_next_page():
    cancelled = False
    row = {"paperId": "p", "title": "P"}

    class CancellingClient(FakeClient):
        def get(self, path: str, *, params: dict, headers: dict):
            nonlocal cancelled
            response = super().get(path, params=params, headers=headers)
            cancelled = True
            return response

    client = CancellingClient(FakeResponse(200, {"token": "next", "data": [row]}))
    rows, audit = s2.bulk_search_papers(
        "q", key="", client=client, pacer=no_wait_pacer(), should_cancel=lambda: cancelled)
    assert len(client.calls) == 1
    assert len(rows) == 1
    assert audit["cancelled"] is True


def test_references_normalizes_edges_and_follows_pagination():
    first = FakeResponse(200, {
        "next": 1,
        "data": [{
            "contexts": ["We use the baseline."],
            "intents": ["methodology"],
            "isInfluential": True,
            "citedPaper": {
                "paperId": "target-1",
                "title": "Target Paper",
                "authors": [{"name": "A. Author"}],
                "year": 2024,
                "venue": "OSDI",
                "externalIds": {"ArXiv": "2401.00001", "DOI": "10.1/example"},
                "url": "https://www.semanticscholar.org/paper/target-1",
            },
        }],
    })
    second = FakeResponse(200, {"data": []})
    client = FakeClient(first, second)

    result = s2.references(
        "ARXIV:2401.09670", key="private-key", client=client, pacer=no_wait_pacer(),
    )

    assert result == [{
        "provider": "semantic_scholar",
        "paper_id": "target-1",
        "title": "Target Paper",
        "authors": ["A. Author"],
        "venue": "OSDI",
        "year": 2024,
        "arxiv_id": "2401.00001",
        "doi": "10.1/example",
        "url": "https://www.semanticscholar.org/paper/target-1",
        "contexts": ["We use the baseline."],
        "intents": ["methodology"],
        "is_influential": True,
    }]
    assert [call["params"]["offset"] for call in client.calls] == [0, 1]


def test_references_retries_429_without_returning_partial_data():
    client = FakeClient(
        FakeResponse(429, {}, {"retry-after": "2"}),
        FakeResponse(200, {"data": []}),
    )
    sleeps: list[float] = []
    assert s2.references(
        "paper-id",
        key="private-key",
        client=client,
        pacer=no_wait_pacer(),
        sleep=sleeps.append,
    ) == []
    assert sleeps == [2.0]
    assert len(client.calls) == 2


def test_missing_key_fails_before_any_network_call():
    client = FakeClient()
    with pytest.raises(s2.SemanticScholarError, match="No Semantic Scholar API key"):
        s2.resolve_paper("Paper", key="", client=client, pacer=no_wait_pacer())
    assert client.calls == []


@pytest.mark.parametrize("payload", [[], "not-json-object", None, {"data": {}}])
def test_resolve_paper_rejects_non_object_payloads(payload):
    client = FakeClient(FakeResponse(200, payload))
    with pytest.raises(s2.SemanticScholarError, match="malformed paper metadata"):
        s2.resolve_paper("Paper", key="private-key", client=client, pacer=no_wait_pacer())


def test_references_rejects_non_object_payload():
    client = FakeClient(FakeResponse(200, []))
    with pytest.raises(s2.SemanticScholarError, match="malformed reference metadata"):
        s2.references("paper-id", key="private-key", client=client, pacer=no_wait_pacer())


class FakePostClient(FakeClient):
    def post(self, path: str, *, params: dict, headers: dict, json: dict):
        self.calls.append({"path": path, "params": params, "headers": headers, "json": json})
        return self.responses.pop(0)


def test_recommendations_posts_positives_and_negatives_and_normalizes():
    client = FakePostClient(FakeResponse(200, {"recommendedPapers": [{
        "paperId": "s2-rec", "title": "Recommended Work",
        "externalIds": {"ArXiv": "2608.12345"}, "year": 2026, "citationCount": 3,
    }]}))
    rows = s2.recommendations(
        ["ARXIV:1706.03762"], ["DOI:10.1/hidden"],
        key="", client=client, pacer=no_wait_pacer())
    assert rows[0]["paper_id"] == "s2-rec"
    assert rows[0]["arxiv_id"] == "2608.12345"
    call = client.calls[0]
    assert call["path"] == s2.RECOMMENDATIONS_URL
    assert call["json"] == {"positivePaperIds": ["ARXIV:1706.03762"],
                            "negativePaperIds": ["DOI:10.1/hidden"]}
    assert call["params"]["fields"] == s2.SEARCH_FIELDS


def test_recommendations_with_no_positives_never_calls_the_api():
    client = FakePostClient()
    assert s2.recommendations([], ["DOI:10.1/x"], key="", client=client,
                              pacer=no_wait_pacer()) == []
    assert client.calls == []


def test_snippet_search_normalizes_and_drops_unnameable_rows():
    client = FakeClient(FakeResponse(200, {"data": [
        {"snippet": {"text": "We measure decode latency on 3D-stacked DRAM."},
         "paper": {"title": "Near-Memory Decoding", "corpusId": 7,
                   "externalIds": {"ArXiv": "2608.00042"}}},
        {"snippet": {"text": "orphan passage"}, "paper": {}},         # no title: dropped
        {"snippet": {}, "paper": {"title": "No passage"}},            # no text: dropped
    ]}))
    rows = s2.snippet_search("3D-stacked DRAM decode", key="", client=client,
                             pacer=no_wait_pacer())
    assert len(rows) == 1
    assert rows[0]["title"] == "Near-Memory Decoding"
    assert rows[0]["arxiv_id"] == "2608.00042"
    assert rows[0]["snippet"].startswith("We measure decode latency")
    assert client.calls[0]["path"] == "/snippet/search"
