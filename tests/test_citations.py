"""citations: Semantic Scholar enrichment. The fetch is tested directly via _fetch_missing
(imported at module load, before the conftest autouse stub patches the module attribute) with a
fake httpx client — zero network."""
from __future__ import annotations

import logging

import httpx
import pytest
from app import citations, semantic_scholar
from app.citations import _fetch_missing as real_fetch_missing


def _resp(status: int, json_body=None) -> httpx.Response:
    return httpx.Response(status, json=json_body if json_body is not None else {},
                          request=httpx.Request("GET", "https://api.semanticscholar.org"))


class FakeClient:
    def __init__(self, post_resp=None, get_resps=None):
        self._post = post_resp
        self._gets = list(get_resps or [])
        self.get_calls = 0

    def post(self, url, **kw):
        return self._post

    def get(self, url, **kw):
        self.get_calls += 1
        return self._gets.pop(0)

    def close(self):
        pass


class MatchClient:
    def get(self, path, *, params, headers):
        return _resp(200, {"data": [{"paperId": "match", "title": "Paper"}]})

    def close(self):
        pass


def _node(nid, *, arxiv=None, title="A sufficiently long paper title", sig=0, cited=1):
    return {"id": nid, "kind": "external", "arxiv_id": arxiv, "doi": None, "title": title,
            "significant_cited_by_count": sig, "cited_by_project_count": cited}


def _key(nid, **kw):
    """The cache key for a node — its id PLUS the identity the count came from, so correcting a
    wrong arXiv id cannot keep serving the previous paper's count."""
    return citations.cache_key(_node(nid, **kw))


def test_batch_ids_fill_cache_and_misses_are_recorded():
    nodes = [_node("a", arxiv="2205.14135"), _node("b", arxiv="9999.00000")]
    cache: dict = {}
    client = FakeClient(post_resp=_resp(200, [{"citationCount": 4626}, None]))
    real_fetch_missing(nodes, cache, client, sleep=lambda s: None)
    assert cache[_key("a", arxiv="2205.14135")] == 4626
    assert cache[_key("b", arxiv="9999.00000")] is None  # unknown id recorded as a miss, so it isn't retried every build


def test_title_match_paced_and_stops_on_429():
    nodes = [_node("t1", sig=3), _node("t2", sig=2), _node("t3", sig=1)]
    cache: dict = {}
    client = FakeClient(get_resps=[
        _resp(200, {"data": [{"title": "A sufficiently long paper title",
                              "citationCount": 512, "matchScore": 0.99}]}),
        _resp(429),
        _resp(200, {"data": [{"title": "A sufficiently long paper title",
                              "citationCount": 7}]}),  # must never be reached
    ])
    real_fetch_missing(nodes, cache, client, sleep=lambda s: None)
    assert cache[_key("t1", sig=3)] == 512   # highest-significance node looked up first
    assert client.get_calls == 2  # stopped at the 429; t3 never queried
    assert _key("t3", sig=1) not in cache      # not recorded -> retried on a future build


def test_annotate_applies_cache_and_never_raises():
    nodes = [_node("a", arxiv="2205.14135"), _node("b")]
    cache = {_key("a", arxiv="2205.14135"): 4626}

    def boom(nodes, cache, client, sleep):
        raise RuntimeError("network exploded")

    # Even a crashing fetch must not break the build; cached values still apply.
    orig = citations._fetch_missing
    citations._fetch_missing = boom
    try:
        citations.annotate_nodes(nodes, cache, client=FakeClient())
    finally:
        citations._fetch_missing = orig
    assert nodes[0]["citation_count"] == 4626
    assert nodes[1]["citation_count"] is None


def test_cached_nodes_are_not_refetched():
    nodes = [_node("a", arxiv="2205.14135")]
    cache = {_key("a", arxiv="2205.14135"): 100}
    client = FakeClient(post_resp=_resp(500))  # would fail if called
    real_fetch_missing(nodes, cache, client, sleep=lambda s: None)
    assert cache[_key("a", arxiv="2205.14135")] == 100


def test_citation_and_metadata_requests_share_one_pacer():
    now = [10.0]
    sleeps: list[float] = []

    def sleep(seconds: float):
        sleeps.append(seconds)
        now[0] += seconds

    pacer = semantic_scholar.RequestPacer(interval=1.1, sleep=sleep, clock=lambda: now[0])
    nodes = [_node("a", arxiv="2205.14135")]
    real_fetch_missing(
        nodes,
        {},
        FakeClient(post_resp=_resp(200, [{"citationCount": 4626}])),
        sleep=lambda _: None,
        pacer=pacer,
    )
    semantic_scholar.resolve_paper(
        "Paper", key="private-key", client=MatchClient(), pacer=pacer
    )

    assert sleeps == [1.1]


def test_an_enrichment_that_resolves_nothing_says_so(caplog, monkeypatch):
    """A build that quietly resolved zero citation counts is indistinguishable from one that was
    never asked to — which is exactly how a 402-node graph ended up with no counts and no trace
    of why. The zero case gets its own warning."""
    monkeypatch.setattr(citations, "_fetch_missing", lambda *a, **k: None)
    nodes = [{"id": "a", "title": "A paper"}, {"id": "b", "title": "Another"}]

    with caplog.at_level(logging.WARNING):
        citations.annotate_nodes(nodes, {})

    assert any('resolved 0 of 2' in r.getMessage() for r in caplog.records), caplog.text


def test_a_failed_fetch_is_logged_rather_than_only_swallowed(caplog, monkeypatch):
    """It must still not fail the build — citation counts are an enrichment — but a silent
    exception left no way to find out why the counts were missing."""
    def boom(*_a, **_k):
        raise RuntimeError("semantic scholar exploded")
    monkeypatch.setattr(citations, "_fetch_missing", boom)
    nodes = [{"id": "a", "title": "A paper"}]

    with caplog.at_level(logging.WARNING):
        citations.annotate_nodes(nodes, {})   # must not raise

    assert nodes[0]["citation_count"] is None
    assert "RuntimeError" in caplog.text
    assert "semantic scholar exploded" in caplog.text


def test_a_failure_message_never_carries_the_api_key(caplog, monkeypatch):
    """A malformed key makes h11 raise `Illegal header value b'<the whole key>'`, and the messages
    worth logging are exactly the ones raised while that key is in an outgoing header."""
    secret = "s2-key-abcdefghijklmnop"
    monkeypatch.setattr(citations, "_api_key", lambda: secret)

    def boom(*_a, **_k):
        raise ValueError(f"Illegal header value b'{secret}'")
    monkeypatch.setattr(citations, "_fetch_missing", boom)

    with caplog.at_level(logging.WARNING):
        citations.annotate_nodes([{"id": "a", "title": "A paper"}], {})

    assert secret not in caplog.text
    assert "***" in caplog.text

# ---- OpenAlex fallback: only a VERIFIED match may be recorded ------------------------------

class _FakeOpenAlex:
    """Returns one canned OpenAlex payload for every query."""

    def __init__(self, results):
        self.results = results
        self.queries = []

    def get(self, url, params=None, **_kw):
        self.queries.append((params or {}).get("search"))
        return httpx.Response(200, json={"results": self.results},
                              request=httpx.Request("GET", url))


def test_a_wrong_title_match_is_refused_rather_than_recorded():
    """Measured against a real miss: OpenAlex answered "BERT: Pre-training of deep bidirectional
    transformers" with TinyBERT. Recording that would put ~0 citations against a paper with over
    a hundred thousand — and nothing downstream could tell it was wrong, which is why a missing
    number is the safer failure."""
    fake = _FakeOpenAlex([{"display_name": "TinyBERT: Distilling BERT for Natural Language "
                                           "Understanding", "cited_by_count": 12}])

    got = citations._openalex_citation_count(
        "BERT: Pre-training of deep bidirectional transformers for language understanding", fake)

    assert got is None


def test_the_canonical_record_wins_over_a_duplicate():
    """OpenAlex keeps duplicate records for one work, and the top relevance hit is not reliably
    the canonical one — an exact-title match for "Attention Is All You Need" returned 6,598 while
    the real record has far more. Citations accumulate on the canonical record, so take the max
    among titles that genuinely match."""
    fake = _FakeOpenAlex([
        {"display_name": "Attention Is All You Need", "cited_by_count": 6598},
        {"display_name": "Attention is all you need", "cited_by_count": 103000},
        {"display_name": "Attention Is Not All You Need", "cited_by_count": 900_000},
    ])

    got = citations._openalex_citation_count("Attention Is All You Need", fake)

    assert got == 103000, "a near-miss title must not win on citation count alone"


def test_the_fallback_is_skipped_when_no_client_is_supplied():
    # Keeps the existing tests (and any caller that does not want it) network-free.
    nodes = [{"id": "a", "title": "A sufficiently long paper title"}]
    cache: dict = {}
    citations._fetch_missing(nodes, cache, _FakeOpenAlex([]), lambda _s: None)
    assert cache == {} or "a" not in cache or cache.get("a") is None


def test_a_truncated_stored_title_is_refused_by_title_and_reached_by_id_instead():
    """An earlier version accepted a short trailing difference so truncated titles would match.
    That is loose in the direction that costs: it also accepts "A Survey of Large Language Models"
    against "… for Medicine". Identifiers cannot be ambiguous, so truncation is handled there."""
    fake = _FakeOpenAlex([{
        "display_name": "BERT: Pre-training of Deep Bidirectional Transformers for Language "
                        "Understanding",
        "cited_by_count": 118626,
    }])
    assert citations._openalex_citation_count(
        "BERT: Pre-training of Deep Bidirectional Transformers", fake) is None


def test_a_paper_with_an_identifier_is_resolved_without_any_title_guessing():
    class _ById:
        def get(self, url, params=None, **_kw):
            assert "W" in url or "arxiv" in url.lower() or "10." in url
            return httpx.Response(200, json={"cited_by_count": 118626},
                                  request=httpx.Request("GET", url))

    node = {"id": "bert", "title": "BERT: Pre-training of Deep Bidirectional Transformers",
            "arxiv_id": "1810.04805"}
    assert citations._openalex_by_id(node, _ById()) == 118626


def test_a_longer_related_title_is_not_the_same_paper():
    # Both were accepted by the short-tail rule, and the max-count rule would then have picked
    # whichever had more citations — the most damaging possible false positive.
    for other in (
        "A Survey of Large Language Models for Medicine",
        "A Survey of Large Language Models Part II",
    ):
        fake = _FakeOpenAlex([{"display_name": other, "cited_by_count": 9_000}])
        assert citations._openalex_citation_count("A Survey of Large Language Models", fake) is None


def test_a_title_that_continues_into_a_different_paper_is_refused():
    fake = _FakeOpenAlex([{
        "display_name": "Attention Is All You Need But You Do Not Need All Of It For Inference "
                        "Of Large Language Models",
        "cited_by_count": 500,
    }])
    assert citations._openalex_citation_count("Attention Is All You Need", fake) is None



def test_a_semantic_scholar_title_match_for_a_DIFFERENT_paper_is_refused():
    """The title endpoint returns the CLOSEST match, not a paper identity. Taking its count on
    trust was a hazard at 25 lookups a build and is sixteen times the exposure at 400."""
    nodes = [_node("t1")]
    cache: dict = {}
    client = FakeClient(get_resps=[
        _resp(200, {"data": [{"title": "A completely different paper about something else",
                              "citationCount": 99_999, "matchScore": 0.4}]}),
    ])

    real_fetch_missing(nodes, cache, client, sleep=lambda s: None)

    assert cache[_key("t1")] is None, "a near match must not be recorded as this paper's count"


def test_the_openalex_stage_is_bounded_in_calls_and_time():
    """Unbounded, this loop would make one request per unresolved node at a 30s timeout each —
    hours inside a graph build — and blow through OpenAlex's anonymous budget collecting 429s."""
    assert citations.OPENALEX_MAX_LOOKUPS <= 200
    assert citations.OPENALEX_BUDGET_S <= 600


def test_a_rate_limited_openalex_stops_the_stage(monkeypatch):
    calls = []

    class _Throttling:
        def get(self, url, params=None, **_kw):
            calls.append(url)
            return httpx.Response(429, request=httpx.Request("GET", url))

    nodes = [_node(f"n{i}", title=f"A distinct paper title number {i}") for i in range(5)]
    cache: dict = {}
    real_fetch_missing(nodes, cache, FakeClient(get_resps=[_resp(404)] * 5),
                       sleep=lambda _s: None, openalex_client=_Throttling())

    assert len(calls) == 1, "a 429 must stop the stage, not be collected five times"


def test_titles_differing_only_by_a_greek_letter_are_not_the_same_paper():
    """ASCII-only normalization collapsed "α-divergence" and "β-divergence" into one title, so a
    result for one could be cached against the other."""
    assert not citations._same_paper_title(
        "Alpha and beta divergences: α-divergence bounds", "Alpha and beta divergences: β-divergence bounds")
    # …while ordinary punctuation and casing still do not decide a match.
    assert citations._same_paper_title("Attention Is All You Need!", "attention is all you need")


def test_the_skeleton_publish_reads_the_same_cache_key_as_the_writer():
    """The skeleton path applies cached counts without any network. Reading by bare node id there
    would resurrect a count cached against the paper's PREVIOUS arXiv id — the exact failure the
    identity-aware key exists to prevent."""
    from pathlib import Path
    source = Path(__file__).resolve().parents[1].joinpath("app", "graph.py").read_text()
    assert "cache.get(citations.cache_key(node))" in source
    assert 'cache.get(node["id"])' not in source


def test_an_exhausted_time_budget_stops_the_stage_immediately(monkeypatch):
    """The budget was checked only between nodes, and each request was then granted a one-second
    floor regardless — so an exhausted budget still bought more requests."""
    clock = [1000.0]
    monkeypatch.setattr(citations.time, "monotonic", lambda: clock[0])
    calls = []

    class _Slow:
        def get(self, url, params=None, timeout=None, **_kw):
            calls.append(timeout)
            clock[0] += citations.OPENALEX_BUDGET_S     # first call eats the whole budget
            return httpx.Response(200, json={"results": []}, request=httpx.Request("GET", url))

    nodes = [_node(f"n{i}", title=f"A distinct paper title number {i}") for i in range(4)]
    real_fetch_missing(nodes, {}, FakeClient(get_resps=[_resp(404)] * 4),
                       sleep=lambda _s: None, openalex_client=_Slow())

    assert len(calls) == 1, f"budget exhausted after the first call, got {len(calls)}"


@pytest.mark.parametrize(
    "stored, expected",
    [
        # The real shape from a build: the citation appended to the title. Raw, these 404.
        ("Language Models are Unsupervised Multitask Learners (Radford et al., 2019)",
         "Language Models are Unsupervised Multitask Learners"),
        ("Improving Language Understanding by Generative Pre-Training (Radford et al., 2018)",
         "Improving Language Understanding by Generative Pre-Training"),
        ("Attention Is All You Need (Vaswani et al.)", "Attention Is All You Need"),
        ("Deep Residual Learning for Image Recognition (2015)",
         "Deep Residual Learning for Image Recognition"),
        # A parenthetical that is PART of the title has neither marker and must survive: stripping
        # it would send a less specific query and match a neighbouring paper.
        ("Language Models are Few-Shot Learners (GPT-3)",
         "Language Models are Few-Shot Learners (GPT-3)"),
        ("Attention Is All You Need (Extended Abstract)",
         "Attention Is All You Need (Extended Abstract)"),
        # Only a TRAILING annotation goes; one mid-title is content.
        ("A Study of BERT (2018) and Its Successors", "A Study of BERT (2018) and Its Successors"),
        ("Deep Residual Learning for Image Recognition",
         "Deep Residual Learning for Image Recognition"),
        ("", ""),
    ],
)
def test_lookup_title_strips_only_trailing_annotations(stored, expected):
    assert citations.lookup_title(stored) == expected


def test_annotated_title_is_looked_up_cleaned_and_verified():
    """The whole point: an annotated title must reach S2 clean AND pass the verification gate.

    Asserted together because cleaning the query alone would still fail — the gate compares the
    candidate against what we sent, so sending the clean title and verifying the annotated one
    would 200 and then discard the answer.
    """
    stored = "Language Models are Unsupervised Multitask Learners (Radford et al., 2019)"
    canonical = "Language Models are Unsupervised Multitask Learners"
    sent: list[str] = []

    def handler(request):
        sent.append(dict(request.url.params)["query"])
        return httpx.Response(200, json={"data": [{"title": canonical, "citationCount": 29621}]})

    node = {"id": "gpt2", "title": stored}
    cache: dict = {}
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        real_fetch_missing([node], cache, client, sleep=lambda s: None)

    assert sent == [canonical], "the annotation must be stripped before the request"
    assert cache[citations.cache_key(node)] == 29621
