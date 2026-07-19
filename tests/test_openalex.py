"""U.9 — OpenAlex authorship enrichment: cached, best-effort, network-free in tests (fake
client), and never a build dependency."""
from __future__ import annotations

import httpx
from app import openalex


class FakeResp:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload or {}

    def json(self):
        return self._payload


class FakeClient:
    def __init__(self, responses: dict[str, FakeResp]):
        self.responses = responses
        self.calls: list[str] = []

    def get(self, url, **_kw):
        self.calls.append(url)
        for key, resp in self.responses.items():
            if key in url:
                return resp
        return FakeResp(404)


def _work(authorships):
    return FakeResp(200, {"authorships": authorships})


AWQ_SHIPS = [
    {"author": {"display_name": "Ji Lin"},
     "institutions": [{"display_name": "MIT"}]},
    {"author": {"display_name": "Song Han"}, "institutions": []},
]


def test_work_authorships_parses_names_and_first_institution():
    client = FakeClient({"10.48550/arXiv.2306.00978": _work(AWQ_SHIPS)})
    ships = openalex.work_authorships("2306.00978", client=client)
    assert ships == [{"name": "Ji Lin", "affiliation": "MIT"},
                     {"name": "Song Han", "affiliation": ""}]


def test_work_authorships_miss_returns_none():
    client = FakeClient({})
    assert openalex.work_authorships("1234.99999", client=client) is None
    assert openalex.work_authorships("", client=client) is None


def test_work_authorships_for_supports_non_arxiv_doi():
    client = FakeClient({"10.1145/123/456": _work(AWQ_SHIPS)})
    ships = openalex.work_authorships_for(doi="https://doi.org/10.1145/123/456", client=client)
    assert ships[0] == {"name": "Ji Lin", "affiliation": "MIT"}
    assert "doi:10.1145/123/456" in client.calls[0]


def test_discovery_authorships_adds_grounded_institutions_and_aborts_on_outage():
    candidates = [
        {"title": "Known", "arxiv_id": None, "doi": "10.1145/known", "authors": []},
        {"title": "Later", "arxiv_id": "2401.00001", "doi": None, "authors": []},
    ]
    client = FakeClient({"10.1145/known": _work(AWQ_SHIPS)})
    openalex.annotate_discovery_authorships(candidates, client=client, sleep=lambda *_: None)
    assert candidates[0]["authors"] == ["Ji Lin", "Song Han"]
    assert candidates[0]["affiliations"] == ["MIT"]
    assert len(client.calls) == 2

    calls = {"n": 0}

    class OutageClient:
        def get(self, *_a, **_k):
            calls["n"] += 1
            raise httpx.ConnectError("offline")

    openalex.annotate_discovery_authorships(
        candidates * 3, client=OutageClient(), sleep=lambda *_: None
    )
    assert calls["n"] == 1


def _project_node(node_id: str, arxiv_id: str | None):
    return {"id": node_id, "kind": "project", "arxiv_id": arxiv_id, "authors": []}


def test_annotate_fills_authors_and_caches():
    nodes = [_project_node("awq", "2306.00978"),
             {"id": "ext:x", "kind": "external", "arxiv_id": "1706.03762", "authors": []}]
    cache: dict = {}
    client = FakeClient({"10.48550/arXiv.2306.00978": _work(AWQ_SHIPS)})
    openalex.annotate_project_authors(nodes, cache, client=client, sleep=lambda *_: None)
    assert nodes[0]["authors"] == ["Ji Lin", "Song Han"]
    assert nodes[1]["authors"] == []          # external nodes are not fetched
    assert cache["awq"]["authorships"][0]["affiliation"] == "MIT"
    assert cache["awq"]["arxiv_id"] == "2306.00978"
    # Second pass: cache hit, no new network calls.
    client2 = FakeClient({})
    openalex.annotate_project_authors(nodes, cache, client=client2, sleep=lambda *_: None)
    assert client2.calls == []


def test_force_refetches_even_on_a_cache_hit():
    """A full rebuild-from-scratch must re-fetch every project node so affiliations OpenAlex
    has since gained get picked up — the plain cache-hit skip is bypassed under force."""
    nodes = [_project_node("awq", "2306.00978")]
    # Cache already holds a hit for the SAME id (no affiliation known last time).
    cache = {"awq": {"status": "done", "arxiv_id": "2306.00978",
                     "authorships": [{"name": "Ji Lin", "affiliation": ""},
                                     {"name": "Song Han", "affiliation": ""}]}}
    # OpenAlex now returns an affiliation for Ji Lin.
    client = FakeClient({"10.48550/arXiv.2306.00978": _work(AWQ_SHIPS)})
    openalex.annotate_project_authors(nodes, cache, client=client, sleep=lambda *_: None,
                                      force=True)
    assert client.calls, "force must re-fetch despite the cache hit"
    assert cache["awq"]["authorships"][0]["affiliation"] == "MIT"


def test_annotate_fetch_false_applies_cache_without_network():
    nodes = [_project_node("awq", "2306.00978")]
    cache = {"awq": {"status": "done", "arxiv_id": "2306.00978", "authorships": AWQ_SHIPS_PARSED}}
    openalex.annotate_project_authors(nodes, cache, fetch=False)
    assert nodes[0]["authors"] == ["Ji Lin", "Song Han"]


AWQ_SHIPS_PARSED = [{"name": "Ji Lin", "affiliation": "MIT"},
                    {"name": "Song Han", "affiliation": ""}]


def test_a_miss_is_not_cached_so_the_next_build_retries():
    nodes = [_project_node("late", "2501.00001")]
    cache: dict = {}
    openalex.annotate_project_authors(nodes, cache, client=FakeClient({}),
                                      sleep=lambda *_: None)
    assert "late" not in cache


def test_annotation_failures_never_raise():
    class ExplodingClient:
        def get(self, *_a, **_k):
            raise RuntimeError("boom")

    nodes = [_project_node("awq", "2306.00978")]
    openalex.annotate_project_authors(nodes, {}, client=ExplodingClient(),
                                      sleep=lambda *_: None)
    assert nodes[0]["authors"] == []


def test_a_corrected_arxiv_id_invalidates_the_cached_authorships():
    """Retrieval can correct a misidentified entry's id while the node id stays put; the
    wrong paper's authors must not survive the correction."""
    nodes = [_project_node("fixed", "1706.03762")]
    cache = {"fixed": {"status": "done", "arxiv_id": "2401.99999",
                       "authorships": [{"name": "Wrong Person", "affiliation": ""}]}}
    client = FakeClient({"10.48550/arXiv.1706.03762": _work([
        {"author": {"display_name": "Ashish Vaswani"}, "institutions": []},
    ])})
    openalex.annotate_project_authors(nodes, cache, client=client, sleep=lambda *_: None)
    assert nodes[0]["authors"] == ["Ashish Vaswani"]
    assert cache["fixed"]["arxiv_id"] == "1706.03762"


def test_contact_header_is_configuration_not_hardcoded(monkeypatch):
    monkeypatch.delenv("RC_CONTACT_EMAIL", raising=False)
    assert "mailto" not in openalex._headers()["User-Agent"]
    monkeypatch.setenv("RC_CONTACT_EMAIL", "ops@example.com")
    assert openalex._headers()["User-Agent"] == "research-companion (mailto:ops@example.com)"


def test_versioned_arxiv_id_is_normalized_for_lookup_and_cache():
    nodes = [_project_node("awq", "2306.00978v3")]
    cache: dict = {}
    client = FakeClient({"10.48550/arXiv.2306.00978": _work(AWQ_SHIPS)})
    openalex.annotate_project_authors(nodes, cache, client=client, sleep=lambda *_: None)
    assert nodes[0]["authors"] == ["Ji Lin", "Song Han"]
    # Keyed by the versionless id, so a later plain-id node is a cache hit (no refetch).
    assert cache["awq"]["arxiv_id"] == "2306.00978"
    assert all("2306.00978v3" not in c for c in client.calls)


def test_corrected_id_with_a_missing_refetch_drops_stale_authors():
    """Identity corrected but the replacement lookup misses/outages: the old paper'"'"'s authors
    must NOT be published — the stale record is dropped."""
    nodes = [_project_node("fixed", "1706.03762")]
    cache = {"fixed": {"status": "done", "arxiv_id": "2401.99999",
                       "authorships": [{"name": "Wrong Person", "affiliation": ""}]}}
    openalex.annotate_project_authors(nodes, cache, client=FakeClient({}),
                                      sleep=lambda *_: None)
    assert nodes[0]["authors"] == []
    assert "fixed" not in cache


def test_fetch_false_ignores_a_record_for_a_different_id():
    nodes = [_project_node("fixed", "1706.03762")]
    cache = {"fixed": {"status": "done", "arxiv_id": "2401.99999",
                       "authorships": [{"name": "Wrong Person", "affiliation": ""}]}}
    openalex.annotate_project_authors(nodes, cache, fetch=False)
    assert nodes[0]["authors"] == []


def test_transport_failure_aborts_the_pass_instead_of_timing_out_each_paper():
    """An outage must not cost a full timeout per paper; the whole enrichment pass aborts
    after the first transport error."""
    calls = {"n": 0}

    class OutageClient:
        def get(self, *_a, **_k):
            calls["n"] += 1
            raise httpx.ConnectError("unreachable")

    nodes = [_project_node(f"p{i}", f"240{i}.0000{i}") for i in range(5)]
    openalex.annotate_project_authors(nodes, {}, client=OutageClient(), sleep=lambda *_: None)
    assert calls["n"] == 1  # broke out after the first failure, did not hit all five
    assert all(n["authors"] == [] for n in nodes)
