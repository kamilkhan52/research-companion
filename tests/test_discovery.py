"""discovery: the goals -> suggested-readings pipeline, driven entirely through injected
search/LLM/citation fakes (zero network). Covers query-plan parsing, candidate dedupe and
capping, citation enrichment, the relevance+citations score blend, the end-to-end event
sequence, and per-project persistence of the ranked result."""
from __future__ import annotations

import json

import pytest
from app import config, discovery, prompts, retriever
from app.discovery import DiscoveryError

QUERIES_JSON = {
    "focus": "3D-stacked DRAM architectures",
    "queries": [
        {"query": 'all:"3D stacked DRAM"', "phase": "broad", "rationale": "core topic"},
        {"query": 'abs:"processing in memory" AND cat:cs.AR', "phase": "narrow", "rationale": "PIM"},
    ],
}


def _cand(aid: str, title: str = "Paper", abstract: str = "An abstract.") -> dict:
    return {"arxiv_id": aid, "title": title, "abstract": abstract, "authors": ["A. Author"],
            "year": 2020, "category": "cs.AR", "url": f"https://arxiv.org/abs/{aid}",
            "pdf_url": f"https://arxiv.org/pdf/{aid}"}


def fake_llm(queries_json: dict | None = None, scores: list | None = None, fenced: bool = False):
    """Dispatches on which discovery prompt a call carries, like the real two-step run."""
    def _llm(model: str, system: str, user: str, max_tokens: int) -> str:
        if system == prompts.get("discover_queries"):
            out = json.dumps(queries_json or QUERIES_JSON)
        else:
            out = json.dumps({"scores": scores or []})
        return f"```json\n{out}\n```" if fenced else out
    return _llm


def fake_citations(counts: dict[str, int | None]):
    def _annotate(nodes: list[dict], cache: dict) -> None:
        for n in nodes:
            n["citation_count"] = counts.get(n["arxiv_id"])
    return _annotate


# ---------- query generation ----------

def test_generate_queries_parses_fenced_json_and_keeps_phases():
    focus, queries = discovery.generate_queries(
        "understand 3D DRAM", "m", fake_llm(fenced=True))
    assert focus == "3D-stacked DRAM architectures"
    assert [q["phase"] for q in queries] == ["broad", "narrow"]
    assert queries[0]["query"] == 'all:"3D stacked DRAM"'


def test_generate_queries_caps_at_max_queries():
    many = {"queries": [{"query": f"all:q{i}", "phase": "narrow", "rationale": ""}
                        for i in range(12)]}
    _, queries = discovery.generate_queries("goals", "m", fake_llm(queries_json=many))
    assert len(queries) == discovery.MAX_QUERIES


def test_generate_queries_rejects_a_plan_with_no_usable_queries():
    with pytest.raises(DiscoveryError):
        discovery.generate_queries("goals", "m",
                                   fake_llm(queries_json={"queries": [{"query": "  "}]}))


# ---------- candidate collection ----------

def _collect(queries, search_fn):
    candidates, events = [], []
    for ev in discovery.collect_candidates(queries, search_fn):
        if ev["type"] == "candidates":
            candidates = ev["candidates"]
        else:
            events.append(ev)
    return candidates, events


def test_collect_candidates_dedupes_across_queries_first_hit_wins():
    def search(query, n):
        if "broad" in query:
            return [_cand("1111.0001", title="From broad"), _cand("1111.0002")]
        return [_cand("1111.0001", title="From narrow"), _cand("1111.0003")]

    candidates, events = _collect(
        [{"query": "broad q"}, {"query": "narrow q"}], search)
    assert [c["arxiv_id"] for c in candidates] == ["1111.0001", "1111.0002", "1111.0003"]
    assert candidates[0]["title"] == "From broad"  # first occurrence kept
    assert events[-1]["found"] == 3


def test_collect_candidates_caps_at_max_and_stops_early():
    def search(query, n):
        return [_cand(f"2222.{i:05d}") for i in range(40)] if query == "q1" \
            else [_cand(f"3333.{i:05d}") for i in range(40)]

    candidates, events = _collect(
        [{"query": "q1"}, {"query": "q2"}, {"query": "q3"}], search)
    assert len(candidates) == discovery.MAX_CANDIDATES
    # The cap was hit on q2, so q3 never ran.
    assert [e["index"] for e in events] == [1, 2]


def test_collect_candidates_tolerates_a_throttled_query():
    def search(query, n):
        if query == "bad":
            raise retriever.RetrievalError("429")
        return [_cand("4444.00001")]

    candidates, _ = _collect([{"query": "bad"}, {"query": "good"}], search)
    assert len(candidates) == 1


def test_collect_candidates_raises_when_nothing_found():
    with pytest.raises(DiscoveryError):
        _collect([{"query": "q"}], lambda q, n: [])


# ---------- citation enrichment ----------

def test_add_citation_counts_maps_counts_onto_candidates():
    candidates = [_cand("5555.00001"), _cand("5555.00002")]
    discovery.add_citation_counts(candidates,
                                  fake_citations({"5555.00001": 1234, "5555.00002": None}))
    assert candidates[0]["citation_count"] == 1234
    assert candidates[1]["citation_count"] is None


# ---------- scoring + blend ----------

def test_score_blend_relevance_dominates_but_citations_lift_landmarks():
    candidates = [_cand("1", "Exact match, uncited"),
                  _cand("2", "Strongly relevant landmark"),
                  _cand("3", "Famous but tangential"),
                  _cand("4", "Unscored by the model")]
    candidates[0]["citation_count"] = 0
    candidates[1]["citation_count"] = 1_000_000
    candidates[2]["citation_count"] = 1_000_000
    candidates[3]["citation_count"] = 10
    scores = [{"index": 1, "relevance": 10, "reason": "exact fit"},
              {"index": 2, "relevance": 8, "reason": "strong fit"},
              {"index": 3, "relevance": 2, "reason": "tangential"}]

    ranked = discovery.score_candidates("goals", candidates, "m", fake_llm(scores=scores))

    # landmark (8 + capped 4) > exact match (10 + 0) > tangential-famous (2 + 4) > unscored (~1)
    assert [c["arxiv_id"] for c in ranked] == ["2", "1", "3", "4"]
    assert ranked[0]["score"] == 12.0  # citation term capped at CITATION_TERM_CAP
    assert ranked[0]["reasons"][0] == "strong fit"
    assert any("1,000,000 citations" in r for r in ranked[0]["reasons"])
    assert ranked[3]["relevance"] == 0.0  # unscored -> ranked last, not dropped


def test_score_candidates_rejects_a_response_without_scores():
    with pytest.raises(DiscoveryError):
        discovery.score_candidates("goals", [_cand("1")], "m",
                                   fake_llm(scores=None))


# ---------- end-to-end run + persistence ----------

def test_run_discovery_event_sequence_and_result_shape():
    def search(query, n):
        return [_cand("7777.00001", "A"), _cand("7777.00002", "B")]

    events = list(discovery.run_discovery(
        "understand 3D DRAM", model="test-model", search_fn=search,
        llm_fn=fake_llm(scores=[{"index": 1, "relevance": 9, "reason": "r1"},
                                {"index": 2, "relevance": 3, "reason": "r2"}]),
        citations_fn=fake_citations({"7777.00001": 500, "7777.00002": 5})))

    types = [e["type"] for e in events]
    assert types[0] == "queries"
    assert types.count("search") == 2
    assert types[-3:] == ["citations", "scoring", "done"]

    result = events[-1]["result"]
    assert result["goals"] == "understand 3D DRAM"
    assert result["model"] == "test-model"
    assert result["candidate_count"] == 2
    assert result["top_n"] == discovery.TOP_SUGGESTIONS
    assert [s["arxiv_id"] for s in result["suggestions"]] == ["7777.00001", "7777.00002"]
    assert result["suggestions"][0]["citation_count"] == 500


def test_run_discovery_requires_goals():
    with pytest.raises(DiscoveryError):
        list(discovery.run_discovery("   ", model="m", search_fn=lambda q, n: [],
                                     llm_fn=fake_llm(), citations_fn=fake_citations({})))


def test_result_persists_per_project(temp_project):
    discovery.save_result({"goals": "g", "suggestions": [{"title": "Café paper"}]})
    assert (config.project_dir() / ".state" / "discovery.json").exists()
    loaded = discovery.load_result()
    assert loaded["suggestions"][0]["title"] == "Café paper"


def test_load_result_returns_none_when_absent_or_corrupt(temp_project):
    assert discovery.load_result() is None
    (config.project_dir() / ".state" / "discovery.json").write_text("{not json")
    assert discovery.load_result() is None
