"""U.9 — OpenAlex authorship enrichment: cached, best-effort, network-free in tests (fake
client), and never a build dependency."""
from __future__ import annotations

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
    client = FakeClient({"arxiv:2306.00978": _work(AWQ_SHIPS)})
    ships = openalex.work_authorships("2306.00978", client=client)
    assert ships == [{"name": "Ji Lin", "affiliation": "MIT"},
                     {"name": "Song Han", "affiliation": ""}]


def test_work_authorships_miss_returns_none():
    client = FakeClient({})
    assert openalex.work_authorships("1234.99999", client=client) is None
    assert openalex.work_authorships("", client=client) is None


def _project_node(node_id: str, arxiv_id: str | None):
    return {"id": node_id, "kind": "project", "arxiv_id": arxiv_id, "authors": []}


def test_annotate_fills_authors_and_caches():
    nodes = [_project_node("awq", "2306.00978"),
             {"id": "ext:x", "kind": "external", "arxiv_id": "1706.03762", "authors": []}]
    cache: dict = {}
    client = FakeClient({"arxiv:2306.00978": _work(AWQ_SHIPS)})
    openalex.annotate_project_authors(nodes, cache, client=client, sleep=lambda *_: None)
    assert nodes[0]["authors"] == ["Ji Lin", "Song Han"]
    assert nodes[1]["authors"] == []          # external nodes are not fetched
    assert cache["awq"]["authorships"][0]["affiliation"] == "MIT"
    # Second pass: cache hit, no new network calls.
    client2 = FakeClient({})
    openalex.annotate_project_authors(nodes, cache, client=client2, sleep=lambda *_: None)
    assert client2.calls == []


def test_annotate_fetch_false_applies_cache_without_network():
    nodes = [_project_node("awq", "2306.00978")]
    cache = {"awq": {"status": "done", "authorships": AWQ_SHIPS_PARSED}}
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
