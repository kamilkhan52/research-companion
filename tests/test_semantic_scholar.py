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
