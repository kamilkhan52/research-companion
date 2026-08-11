"""discovery: the goals -> suggested-readings pipeline, driven entirely through injected
search/LLM/citation fakes (zero network). Covers query-plan parsing, candidate dedupe and
capping, citation enrichment, the relevance+citations score blend, the end-to-end event
sequence, and per-project persistence of the ranked result."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from app import config, discovery, discovery_checkpoint, discovery_ledger, prompts, retriever
from app.discovery import DiscoveryError

QUERIES_JSON = {
    "focus": "3D-stacked DRAM architectures",
    "queries": [
        {"query": 'all:"3D stacked DRAM"', "search_terms": "3D stacked DRAM architecture",
         "phase": "broad", "rationale": "core topic"},
        {"query": 'abs:"processing in memory" AND cat:cs.AR',
         "search_terms": "processing in memory architecture", "phase": "narrow",
         "rationale": "PIM"},
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


def fake_cheap_llm(relevance_by_key: dict, *, drop: set | None = None):
    """A deterministic stand-in for the batched cheap screen.

    Speaks the real line protocol — `<n>|K|TAG` for triage, `<n>|score|ROLE|note` for abstracts —
    and echoes back the numbers it was given, so the reconciler under test does real work rather
    than being bypassed. Keyed on whatever appears in the rendered line (arXiv id or title).
    """
    drop = drop or set()

    def _lookup(line: str):
        for key, value in relevance_by_key.items():
            if key in line:
                return key, value
        return None, None

    def _cheap(system: str, user: str, max_tokens: int) -> str:
        is_triage = "<K or D>" in system
        rows = []
        for line in user.splitlines():
            number = line.split("|", 1)[0].strip()
            if not number.isdigit():
                continue
            key, value = _lookup(line)
            if is_triage:
                verdict = "D" if key in drop else "K"
                rows.append(f"{number}|{verdict}|METHOD")
            else:
                rows.append(f"{number}|{value if value is not None else 5}|METHOD|fits the goal")
        return "\n".join(rows)
    return _cheap


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
    assert queries[0]["search_terms"] == "3D stacked DRAM architecture"


def test_generate_queries_derives_plain_terms_for_an_older_prompt_override():
    plan = {"queries": [{
        "query": 'abs:"processing in memory" AND cat:cs.AR',
        "phase": "broad",
    }]}
    _, queries = discovery.generate_queries("goals", "m", fake_llm(queries_json=plan))
    assert queries[0]["search_terms"] == "processing in memory"
    assert queries[0]["bulk_query"] == "processing in memory"


def test_generate_queries_keeps_the_wide_boolean_query_for_bulk_recall():
    plan = {"queries": [{
        "query": 'abs:"memory pooling" AND cat:cs.AR',
        "search_terms": "memory pooling fabrics",
        "bulk_query": '"memory pooling" OR "memory disaggregation"',
    }]}
    _, queries = discovery.generate_queries("goals", "m", fake_llm(queries_json=plan))
    assert queries[0]["bulk_query"] == '"memory pooling" OR "memory disaggregation"'


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


def test_collect_candidates_caps_only_after_all_queries_for_recall_fusion():
    def search(query, n):
        return [_cand(f"2222.{i:05d}") for i in range(40)] if query == "q1" \
            else [_cand(f"3333.{i:05d}") for i in range(40)]

    candidates, events = _collect(
        [{"query": "q1"}, {"query": "q2"}, {"query": "q3"}], search)
    assert len(candidates) == discovery.MAX_CANDIDATES
    # Every concept contributes evidence before the source-balanced cap is applied.
    assert [e["index"] for e in events] == [1, 2, 3]


def test_collect_candidates_merges_provider_identity_and_keeps_non_arxiv_work():
    def arxiv_search(query, n):
        return [_cand("1111.00001", "Shared paper")]

    def semantic_search(query, n):
        return [
            {**_cand("1111.00001", "Shared paper"), "paper_id": "shared",
             "citation_count": 200},
            {"paper_id": "conference-only", "doi": "10.1/conf", "arxiv_id": None,
             "title": "Conference Landmark", "abstract": "Important systems paper.",
             "authors": ["B. Author"], "year": 2018, "venue": "OSDI",
             "url": "https://example.test/conf", "pdf_url": ""},
        ]

    candidates, events = _collect(
        [{"query": "all:systems", "search_terms": "systems"}],
        lambda q, n: arxiv_search(q, n),
    )
    assert len(candidates) == 1  # legacy single-source seam remains supported

    merged = [
        event for event in discovery.collect_candidates(
            [{"query": "all:systems", "search_terms": "systems"}],
            arxiv_search,
            semantic_search,
        )
        if event["type"] == "candidates"
    ][0]["candidates"]
    assert len(merged) == 2
    shared = next(candidate for candidate in merged if candidate["title"] == "Shared paper")
    assert shared["sources"] == ["arxiv", "semantic_scholar"]
    assert shared["citation_count"] == 200
    landmark = next(candidate for candidate in merged if candidate["paper_id"] == "conference-only")
    assert landmark["arxiv_id"] is None
    assert events[-1]["found"] == 1


def test_collect_candidates_uses_normalized_title_as_a_cross_provider_alias():
    def arxiv_search(query, n):
        return [_cand("1111.00001", "The Shared-Paper: A Study")]

    def semantic_search(query, n):
        return [{
            "paper_id": "shared",
            "doi": "10.1/shared",
            "title": "The shared paper — a study",
            "abstract": "A richer abstract.",
            "authors": ["A. Author"],
            "year": 2020,
            "venue": "OSDI",
            "citation_count": 42,
        }]

    final = [
        event["candidates"]
        for event in discovery.collect_candidates(
            [{"query": "all:shared", "search_terms": "shared"}],
            arxiv_search,
            semantic_search,
        )
        if event["type"] == "candidates"
    ][0]

    assert len(final) == 1
    assert final[0]["candidate_id"] == "arxiv:1111.00001"
    assert final[0]["doi"] == "10.1/shared"
    assert final[0]["paper_id"] == "shared"
    assert final[0]["sources"] == ["arxiv", "semantic_scholar"]


def test_source_balanced_cap_reserves_semantic_scholar_only_candidates():
    queries = [{"query": f"q{i}", "search_terms": f"q{i}"} for i in range(3)]

    def arxiv_search(query, n):
        return [_cand(f"2401.{i:05d}", f"arXiv {i}") for i in range(30)]

    def semantic_search(query, n):
        return [{
            "paper_id": f"s2-{query}-{i}", "doi": f"10.1/{query}-{i}", "arxiv_id": None,
            "title": f"Conference {query} {i}", "abstract": "systems", "authors": [],
            "year": 2020, "venue": "OSDI", "url": "", "pdf_url": "",
        } for i in range(10)]

    final = [
        event["candidates"]
        for event in discovery.collect_candidates(queries, arxiv_search, semantic_search)
        if event["type"] == "candidates"
    ][0]
    assert len(final) == discovery.MAX_CANDIDATES
    assert sum(c["sources"] == ["semantic_scholar"] for c in final) >= (
        discovery.MIN_PROVIDER_EXCLUSIVE
    )


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
    scores = [{"index": 1, "relevance": 10, "credibility": 1, "reason": "exact fit"},
              {"index": 2, "relevance": 8, "credibility": 4, "reason": "strong fit"},
              {"index": 3, "relevance": 2, "credibility": 4, "reason": "tangential"}]

    ranked = discovery.score_candidates("goals", candidates, "m", fake_llm(scores=scores))

    # Credibility/impact lift the strongly relevant landmark over the uncited exact match,
    # without allowing the equally famous but tangential work to compete.
    assert [c["arxiv_id"] for c in ranked] == ["2", "1", "3", "4"]
    assert ranked[0]["score"] == 11.5
    assert ranked[1]["score"] == 10.5
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
        cheap_llm_fn=fake_cheap_llm({"7777.00001": 9, "7777.00002": 3}),
        library_fn=lambda: [],
        recall_fn=lambda papers: ([], {"degraded": []}),
        citations_fn=fake_citations({"7777.00001": 500, "7777.00002": 5})))

    types = [e["type"] for e in events]
    assert types[0] == "queries"
    assert types.count("search") == 2
    # The funnel's own stages are reported so a client can show real progress rather than a
    # spinner: recall -> gate -> cheap screens -> enrichment.
    # `finds` events interleave (the live reel) and are asserted separately below; the STAGE
    # order is what this pins.
    assert [x for x in types if x != "finds"][-8:] == [
        "library", "gathered", "gated", "triage", "citations", "scoring", "evidence", "done"]
    # The reel is refreshed at every stage that changes what we know, so it keeps moving through
    # the long screening passes instead of freezing on one set of titles.
    assert types.count("finds") >= 3

    result = events[-1]["result"]
    assert result["goals"] == "understand 3D DRAM"
    assert result["model"] == "test-model"
    assert result["candidate_count"] == 2
    assert result["top_n"] == discovery.TOP_SUGGESTIONS
    assert [s["arxiv_id"] for s in result["suggestions"]] == ["7777.00001", "7777.00002"]
    assert result["suggestions"][0]["citation_count"] == 500


def test_cancel_after_a_progress_event_does_not_start_the_next_provider_stage():
    """The job driver cannot enforce this by checking after ``next(generator)``—by then the
    generator has already executed the next stage. The checkpoint must live immediately after
    each yielded event inside ``run_discovery`` itself."""
    cancelled = False
    searches: list[str] = []

    def search(query: str, n: int):
        searches.append(query)
        return [_cand("7777.00001")]

    events = discovery.run_discovery(
        "goals",
        model="m",
        search_fn=search,
        llm_fn=fake_llm(),
        cheap_llm_fn=fake_cheap_llm({}),
        library_fn=lambda: [],
        recall_fn=lambda papers: ([], {"degraded": []}),
        citations_fn=fake_citations({}),
        should_cancel=lambda: cancelled,
    )
    assert next(events)["type"] == "queries"
    cancelled = True

    with pytest.raises(StopIteration):
        next(events)
    assert searches == []


def test_cancellation_inside_wide_recall_does_not_checkpoint_a_partial_stage(temp_project):
    cancelled = False
    wide_calls = 0

    def wide(anchors, queries, ledger):
        nonlocal cancelled, wide_calls
        wide_calls += 1
        cancelled = True
        return ([_cand("8888.00001", "Partial")], {"degraded": []}, [{
            "key": "bulk:test", "swept_to": "2026-07-31",
        }])

    events = list(discovery.run_discovery(
        "goals", model="m", search_fn=lambda query, n: [], llm_fn=fake_llm(),
        cheap_llm_fn=fake_cheap_llm({}), library_fn=lambda: [],
        recall_fn=lambda papers: ([], {"degraded": [], "_anchors": []}),
        wide_recall_fn=wide, citations_fn=lambda nodes, cache: None,
        authorships_fn=lambda candidates: None, should_cancel=lambda: cancelled))

    assert wide_calls == 1
    assert events[-1]["type"] == "library"
    assert not discovery_checkpoint.checkpoint_path().exists()
    assert discovery_ledger.swept_to(discovery_ledger.load(), "bulk:test") is None


def test_a_restarted_run_resumes_recall_and_only_then_commits_the_frontier(temp_project):
    calls = {"plan": 0, "search": 0, "grounded": 0, "wide": 0}

    def plan(model, system, user, max_tokens):
        calls["plan"] += 1
        return json.dumps(QUERIES_JSON)

    def search(query, n):
        calls["search"] += 1
        return []

    def grounded(papers):
        calls["grounded"] += 1
        return [], {"degraded": [], "_anchors": []}

    def wide(anchors, queries, ledger):
        calls["wide"] += 1
        return ([_cand("8888.00001", "Wide paper")], {"degraded": []}, [{
            "key": "bulk:test", "swept_to": "2026-07-31", "pages": 1,
        }])

    first = discovery.run_discovery(
        "goals", model="m", search_fn=search, llm_fn=plan,
        cheap_llm_fn=fake_cheap_llm({"Wide paper": 9}), library_fn=lambda: [],
        recall_fn=grounded, wide_recall_fn=wide, citations_fn=lambda nodes, cache: None,
        authorships_fn=lambda candidates: None)
    for event in first:
        if event["type"] == "gathered":
            break
    first.close()  # model a process dying after recall but before screening

    assert discovery_checkpoint.checkpoint_path().exists()
    assert discovery_ledger.swept_to(discovery_ledger.load(), "bulk:test") is None

    def should_not_run(*args, **kwargs):
        raise AssertionError("a completed recall stage was bought twice")

    events = list(discovery.run_discovery(
        "goals", model="m", search_fn=should_not_run, llm_fn=should_not_run,
        cheap_llm_fn=fake_cheap_llm({"Wide paper": 9}), library_fn=lambda: [],
        recall_fn=should_not_run, wide_recall_fn=should_not_run,
        citations_fn=lambda nodes, cache: None, authorships_fn=lambda candidates: None))

    assert events[0]["resumed"] is True
    assert events[-1]["result"]["suggestions"][0]["title"] == "Wide paper"
    assert calls == {"plan": 1, "search": 2, "grounded": 1, "wide": 1}
    assert discovery_ledger.swept_to(discovery_ledger.load(), "bulk:test") == "2026-07-31"
    assert not discovery_checkpoint.checkpoint_path().exists()


def test_resume_after_title_triage_does_not_rebuy_that_model_stage(temp_project):
    counts = {"triage": 0, "abstract": 0}

    def cheap(system, user, max_tokens):
        triage = "<K or D>" in system
        counts["triage" if triage else "abstract"] += 1
        return "\n".join(
            f"{line.split('|', 1)[0]}|{'K|METHOD' if triage else '8|METHOD|fit'}"
            for line in user.splitlines() if line.split("|", 1)[0].isdigit())

    wide = lambda anchors, queries, ledger: (  # noqa: E731 — compact injected stage fixture
        [_cand("8888.00001", "Wide paper")], {"degraded": []}, [])
    first = discovery.run_discovery(
        "goals", model="m", search_fn=lambda query, n: [], llm_fn=fake_llm(),
        cheap_llm_fn=cheap, library_fn=lambda: [],
        recall_fn=lambda papers: ([], {"degraded": [], "_anchors": []}),
        wide_recall_fn=wide, citations_fn=lambda nodes, cache: None,
        authorships_fn=lambda candidates: None)
    for event in first:
        if event["type"] == "finds" and event.get("stage") == "screened":
            break
    first.close()
    assert counts == {"triage": 1, "abstract": 0}

    list(discovery.run_discovery(
        "goals", model="m", search_fn=lambda *args: (_ for _ in ()).throw(
            AssertionError("search repeated")), llm_fn=fake_llm(), cheap_llm_fn=cheap,
        library_fn=lambda: [], recall_fn=lambda *args: (_ for _ in ()).throw(
            AssertionError("recall repeated")), wide_recall_fn=lambda *args: (_ for _ in ()).throw(
            AssertionError("wide recall repeated")), citations_fn=lambda nodes, cache: None,
        authorships_fn=lambda candidates: None))
    assert counts == {"triage": 1, "abstract": 1}


def test_protected_title_drops_are_abstract_scored_and_make_false_negatives_measurable(
    temp_project, monkeypatch,
):
    monkeypatch.setattr(discovery, "MAX_AFTER_ABSTRACTS", 1)
    def cheap(system, user, max_tokens):
        triage = "<K or D>" in system
        return "\n".join(
            f"{line.split('|', 1)[0]}|"
            f"{'D|OFF-TOPIC' if triage else '9|METHOD|actually relevant'}"
            for line in user.splitlines() if line.split("|", 1)[0].isdigit())

    candidates = [_cand(f"9000.{i:05d}", f"Candidate {i}") for i in range(100)]
    for candidate in candidates:
        candidate["channels"] = ["bulk"]
        candidate["sources"] = ["semantic_scholar"]
    result = list(discovery.run_discovery(
        "goals", model="m", search_fn=lambda query, n: [], llm_fn=fake_llm(),
        cheap_llm_fn=cheap, library_fn=lambda: [],
        recall_fn=lambda papers: ([], {"degraded": [], "_anchors": []}),
        wide_recall_fn=lambda anchors, queries, ledger: (
            candidates, {"degraded": []}, []),
        citations_fn=lambda nodes, cache: None,
        authorships_fn=lambda scored: None))[-1]["result"]

    audit = result["audit"]["abstract_scoring"]["title_drop_audit"]
    assert audit["reviewed"] > len(result["suggestions"]), (
        "the audit was calculated only over the final display cap")
    assert audit["false_negatives"] == audit["reviewed"]
    assert audit["rate"] == 1.0


def test_abstract_scores_below_the_display_cap_are_cached(temp_project):
    candidates = [_cand(f"9100.{i:05d}", f"Candidate {i}") for i in range(70)]
    calls = {"triage": 0, "abstract": 0}

    def cheap(system, user, max_tokens):
        triage = "<K or D>" in system
        calls["triage" if triage else "abstract"] += 1
        return "\n".join(
            f"{line.split('|', 1)[0]}|{'K|METHOD' if triage else '8|METHOD|fit'}"
            for line in user.splitlines() if line.split("|", 1)[0].isdigit())

    def run():
        return list(discovery.run_discovery(
            "goals", model="m", search_fn=lambda query, n: [], llm_fn=fake_llm(),
            cheap_llm_fn=cheap, library_fn=lambda: [],
            recall_fn=lambda papers: ([], {"degraded": [], "_anchors": []}),
            wide_recall_fn=lambda anchors, queries, ledger: (
                candidates, {"degraded": []}, []),
            citations_fn=lambda nodes, cache: None,
            authorships_fn=lambda scored: None))[-1]["result"]

    first = run()
    first_calls = dict(calls)
    second = run()

    assert first["candidate_count"] == discovery.MAX_AFTER_ABSTRACTS
    assert calls == first_calls
    assert second["audit"]["abstract_scoring"]["reused"] == 70


def test_a_paper_the_cheap_screen_never_answered_for_survives_the_triage(temp_project):
    """Fail toward recall. The batch runner is deliberately tolerant of a model that skips rows,
    and this pins what "tolerant" must mean: an unjudged paper is uncertainty, and uncertainty
    must not silently delete it. Dropping here would be invisible and permanent."""
    def search(query, n):
        return [_cand("7777.00001", "Answered"), _cand("7777.00002", "Ignored")]

    def cheap(system, user, max_tokens):
        # Never answers for "Ignored", whichever batch it lands in. Keyed on the title rather
        # than on position on purpose: the runner retries a lossy batch at half size, so a fake
        # that skips "the first line" would answer the item on the retry and prove nothing.
        rows = []
        for line in user.splitlines():
            number = line.split("|", 1)[0]
            if not number.isdigit() or "Ignored" in line:
                continue
            rows.append(f"{number}|K|METHOD" if "<K or D>" in system
                        else f"{number}|9|METHOD|note")
        return "\n".join(rows)

    result = list(discovery.run_discovery(
        "goals", model="m", search_fn=search, llm_fn=fake_llm(scores=[]),
        cheap_llm_fn=cheap, library_fn=lambda: [],
        recall_fn=lambda papers: ([], {"degraded": []}),
        citations_fn=fake_citations({"7777.00001": 10, "7777.00002": 10})))[-1]["result"]

    titles = {s["title"] for s in result["suggestions"]}
    assert titles == {"Answered", "Ignored"}
    # The unanswered one is present but takes the neutral score, not a zero that would bury it.
    ignored = next(s for s in result["suggestions"] if s["title"] == "Ignored")
    assert ignored["relevance"] == 5.0


def test_run_discovery_requires_goals():
    with pytest.raises(DiscoveryError):
        list(discovery.run_discovery("   ", model="m", search_fn=lambda q, n: [],
                                     llm_fn=fake_llm(), citations_fn=fake_citations({})))


def test_result_persists_per_project(temp_project):
    discovery.save_result({"goals": "g", "suggestions": [{"title": "Café paper"}]})
    assert (config.project_dir() / ".state" / "discovery.json").exists()
    loaded = discovery.load_result()
    assert loaded["suggestions"][0]["title"] == "Café paper"


def test_load_result_upgrades_arxiv_only_persisted_shape_without_rewriting(temp_project):
    old = {
        "goals": "g",
        "suggestions": [{
            "arxiv_id": "2201.00002",
            "title": "Old result",
            "relevance": 9,
            "score": 10,
            "reasons": [],
        }],
    }
    path = config.project_dir() / ".state" / "discovery.json"
    path.write_text(json.dumps(old))
    before = path.read_text()

    loaded = discovery.load_result()

    assert loaded["suggestions"][0]["candidate_id"] == "arxiv:2201.00002"
    assert loaded["suggestions"][0]["sources"] == ["arxiv"]
    assert loaded["suggestions"][0]["credibility"] == 0.0
    assert loaded["source_counts"] == {"arxiv": 1, "semantic_scholar": 0}
    assert path.read_text() == before


def test_load_result_backfills_authors_and_reasons_missing_entirely(temp_project):
    """A result persisted before these fields existed has the KEYS ABSENT, not empty — the
    genuine historical shape, reproducing the client crash: `s.authors.length` /
    `s.reasons[0]` throw on `undefined`, taking the whole screen down with them."""
    old = {
        "goals": "g",
        "suggestions": [{
            "arxiv_id": "2201.00003",
            "title": "Older still",
            "relevance": 9,
            "score": 10,
            # authors and reasons deliberately absent
        }],
    }
    path = config.project_dir() / ".state" / "discovery.json"
    path.write_text(json.dumps(old))

    loaded = discovery.load_result()

    assert loaded["suggestions"][0]["authors"] == []
    assert loaded["suggestions"][0]["reasons"] == []


def test_load_result_returns_none_when_absent_or_corrupt(temp_project):
    assert discovery.load_result() is None
    (config.project_dir() / ".state" / "discovery.json").write_text("{not json")
    assert discovery.load_result() is None


def test_fixed_quality_fixture_recovers_and_ranks_conference_landmark():
    fixture = json.loads(
        (Path(__file__).parent / "fixtures" / "discovery_quality.json").read_text()
    )
    screen_inputs: list[str] = []

    def llm_fn(model, system, user, max_tokens):
        return json.dumps({"focus": fixture["focus"], "queries": fixture["queries"]})

    scoring = fake_cheap_llm({t: row["relevance"] for t, row in fixture["scores"].items()})

    def cheap_llm_fn(system, user, max_tokens):
        screen_inputs.append(user)
        return scoring(system, user, max_tokens)

    def arxiv_search(query, n):
        return fixture["arxiv_results"]

    def semantic_search(query, n):
        return fixture["semantic_results"]

    def authorships(candidates):
        for candidate in candidates:
            candidate["affiliations"] = fixture["affiliations"].get(
                candidate["title"], []
            )

    arxiv_only = [
        event["candidates"]
        for event in discovery.collect_candidates(
            fixture["queries"], arxiv_search
        )
        if event["type"] == "candidates"
    ][0]
    assert "conference-landmark" not in {
        candidate.get("paper_id") for candidate in arxiv_only
    }

    result = list(discovery.run_discovery(
        fixture["goals"],
        model="fixture-model",
        search_fn=arxiv_search,
        semantic_search_fn=semantic_search,
        llm_fn=llm_fn,
        cheap_llm_fn=cheap_llm_fn,
        library_fn=lambda: [],
        recall_fn=lambda papers: ([], {"degraded": []}),
        citations_fn=fake_citations({
            "2401.00001": 3,
            "2201.00002": 120,
        }),
        authorships_fn=authorships,
    ))[-1]["result"]

    assert [candidate["candidate_id"] for candidate in result["suggestions"][:2]] == (
        fixture["expected_top"]
    )
    assert result["source_counts"]["arxiv"] == 2
    assert result["source_counts"]["semantic_scholar"] == 2
    assert result["suggestions"][0]["arxiv_id"] is None

    # Venue reaches the screen, because it is already on the candidate and is real credibility
    # evidence. Affiliations deliberately do NOT: enrichment now runs AFTER screening so the
    # OpenAlex authorship call covers ~60 papers rather than the whole pool. They still reach the
    # reader, which is what they were always for.
    assert any("OSDI" in seen for seen in screen_inputs)
    assert not any("MIT CSAIL" in seen for seen in screen_inputs)
    assert "MIT CSAIL" in result["suggestions"][0]["affiliations"]


# ---------- hidden recommendations (R12.3) ----------

def test_hide_candidate_persists_and_filters_by_any_identity(temp_project):
    entry = discovery.hide_candidate(
        {"arxiv_id": "2401.11111v2", "title": "Hidden Paper", "doi": "10.1/abc"})
    assert "arxiv:2401.11111" in entry["keys"]  # versionless
    assert "title:hidden paper" in entry["keys"]

    # The same work re-found through another provider (title only) stays hidden; an
    # unrelated paper passes through.
    kept = discovery.filter_hidden([
        {"title": "  Hidden PAPER! "},
        {"arxiv_id": "2402.22222", "title": "Different Paper"},
    ])
    assert [c["title"] for c in kept] == ["Different Paper"]

    # Idempotent: re-hiding via an overlapping identity returns the existing entry.
    assert discovery.hide_candidate({"title": "hidden paper"})["hidden_at"] == entry["hidden_at"]
    assert len(discovery.load_hidden()) == 1


def test_unhide_restores_by_any_key(temp_project):
    entry = discovery.hide_candidate({"arxiv_id": "2401.33333", "title": "Mistap"})
    assert discovery.filter_hidden([{"title": "Mistap"}]) == []
    assert discovery.unhide([entry["keys"][0]]) is True
    assert discovery.unhide([entry["keys"][0]]) is False  # already gone
    assert discovery.filter_hidden([{"title": "Mistap"}]) == [{"title": "Mistap"}]


def test_hide_candidate_without_identity_raises(temp_project):
    with pytest.raises(DiscoveryError):
        discovery.hide_candidate({"abstract": "no title, no ids"})


def test_hidden_is_scoped_per_project(temp_project):
    discovery.hide_candidate({"title": "Project Scoped"})
    assert discovery.filter_hidden([{"title": "Project Scoped"}]) == []
    # The entry lives under this project's .state, so other projects are unaffected.
    assert (Path(config.state_dir()) / "discovery-hidden.json").exists()


def test_hidden_survives_corrupt_file(temp_project):
    (Path(config.state_dir()) / "discovery-hidden.json").write_text("not json", encoding="utf-8")
    assert discovery.load_hidden() == []
    assert discovery.filter_hidden([{"title": "A"}]) == [{"title": "A"}]


def test_title_match_never_bridges_conflicting_strong_ids(temp_project):
    discovery.hide_candidate({"arxiv_id": "2401.00001", "title": "Shared Title Words"})
    kept = discovery.filter_hidden([
        {"arxiv_id": "2402.99999", "title": "Shared Title Words"},  # different work, same title
        {"title": "Shared Title Words"},  # no ids — the title fallback still hides
    ])
    assert kept == [{"arxiv_id": "2402.99999", "title": "Shared Title Words"}]
    # Hiding the conflicting work records its own entry rather than coalescing.
    discovery.hide_candidate({"arxiv_id": "2402.99999", "title": "Shared Title Words"})
    assert len(discovery.load_hidden()) == 2
    # Undoing one entry leaves the other hidden.
    assert discovery.unhide(["arxiv:2401.00001"]) is True
    assert len(discovery.load_hidden()) == 1


def test_title_match_never_bridges_conflicting_openalex_ids(temp_project):
    discovery.hide_candidate({"openalex_id": "https://openalex.org/W1",
                              "title": "Shared Title Words"})
    kept = discovery.filter_hidden([
        {"openalex_id": "https://openalex.org/W2", "title": "Shared Title Words"},
        {"title": "Shared Title Words"},
    ])
    assert kept == [{
        "openalex_id": "https://openalex.org/W2", "title": "Shared Title Words",
    }]


# ---------- already-in-library exclusion (DR-002, 2026-08-11 device pass) ----------

def test_filter_in_library_drops_a_suggestion_already_on_the_reading_list(temp_project):
    from app import store
    store.add_entry("Attention Is All You Need", arxiv_id="1706.03762")
    store.add_entry("A Paper With No arXiv Id")

    kept = discovery.filter_in_library([
        {"arxiv_id": "1706.03762v5", "title": "Attention is all you need"},  # versioned, same id
        {"title": "a paper with no arxiv id"},  # title-only match against the second entry
        {"arxiv_id": "2401.00000", "title": "Genuinely New Paper"},
    ])
    assert [c["title"] for c in kept] == ["Genuinely New Paper"]


def test_filter_in_library_keeps_everything_for_an_empty_project(temp_project):
    items = [{"arxiv_id": "1706.03762", "title": "Attention is all you need"}]
    assert discovery.filter_in_library(items) == items


def test_filter_in_library_does_not_bridge_conflicting_arxiv_ids(temp_project):
    from app import store
    store.add_entry("Shared Title Words", arxiv_id="2401.00001")

    kept = discovery.filter_in_library([
        {"arxiv_id": "2402.99999", "title": "Shared Title Words"},  # different work, same title
    ])
    assert kept == [{"arxiv_id": "2402.99999", "title": "Shared Title Words"}]


def test_filter_in_library_does_not_bridge_a_candidate_with_an_unconfirmable_strong_id(temp_project):
    # Opus review, PR #370: a library Paper only ever carries arxiv_id/title, never doi/openalex/
    # s2 — so a title-only library entry used to bridge, via _hidden_match's title fallback, to
    # a candidate carrying THREE strong ids none of which the library side had any way to
    # confirm or refute. That candidate must survive; it might genuinely be a different paper.
    from app import store
    store.add_entry("Deep Learning")  # no arxiv id at all — title is all this entry has

    kept = discovery.filter_in_library([
        {"title": "Deep learning", "doi": "10.1038/nature14539",
         "arxiv_id": "1234.56789", "openalex_id": "https://openalex.org/W999"},
    ])
    assert len(kept) == 1


def test_filter_in_library_still_bridges_two_equally_bare_titles(temp_project):
    # The case the title fallback exists for: neither side has ANY strong identifier, so title
    # is genuinely the only signal available on both sides.
    from app import store
    store.add_entry("A Wholly Undated Survey")

    kept = discovery.filter_in_library([{"title": "a wholly undated survey"}])
    assert kept == []


def test_distinct_openalex_only_rows_keep_separate_reservoir_and_verdict_keys():
    candidates = [
        {"openalex_id": "https://openalex.org/W1", "title": "Shared title",
         "abstract": "first", "channels": ["topic"]},
        {"openalex_id": "https://openalex.org/W2", "title": "Shared title",
         "abstract": "second", "channels": ["topic"]},
    ]
    ledger = {"entries": {}, "frontier": {}}
    for candidate in candidates:
        discovery_ledger.observe(
            ledger, discovery._candidate_key(candidate), candidate, "topic", "2026-07-31")

    assert [discovery._candidate_key(candidate) for candidate in candidates] == [
        "openalex:w1", "openalex:w2"]
    assert {row["openalex_id"] for row in discovery_ledger.reservoir(ledger)} == {
        "https://openalex.org/W1", "https://openalex.org/W2"}

    discovery_ledger.record_cheap_verdict(
        discovery_ledger.get(ledger, "openalex:w1"), verdict="D", tag="OFF-TOPIC",
        model="m", profile="p", today="2026-07-31")
    assert discovery_ledger.cached_cheap_drop(
        discovery_ledger.get(ledger, "openalex:w2"), model="m", profile="p") is False


def test_degenerate_title_normalizations_never_match(temp_project):
    discovery.hide_candidate({"title": "C++"})  # normalizes to "c" — too short to match
    assert discovery.filter_hidden([{"title": "C#"}]) == [{"title": "C#"}]


def test_concurrent_hides_lose_no_entries(temp_project):
    """hide is a read-modify-write over one file; without the per-project lock concurrent
    hides overwrite each other's snapshots (sol review, PR #206). Threads rebind the active
    project like every production job runner (CLAUDE.md invariant 2)."""
    import threading as _threading

    def hide(index: int) -> None:
        token = config.set_active_project(temp_project)
        try:
            discovery.hide_candidate(
                {"arxiv_id": f"24{index:02d}.0000{index}", "title": f"Concurrent Paper {index}"})
        finally:
            config.reset_active_project(token)

    threads = [_threading.Thread(target=hide, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(discovery.load_hidden()) == 8


def test_the_gate_never_fabricates_a_model_rejection(temp_project):
    """The deterministic gate's own drops must not be written to the ledger as cheap-model
    rejections. They were, and the gate then honoured them on later runs — so a paper the user
    un-hid could never come back, and an already-known paper stayed suppressed even after being
    removed from the reading list. Nothing surfaced the mistake; the ledger simply looked right."""
    from app import discovery_ledger

    def search(query, n):
        return [_cand("7777.00001", "Kept"), _cand("7777.00002", "HiddenByUser")]

    discovery.hide_candidate({"arxiv_id": "7777.00002", "title": "HiddenByUser"})

    list(discovery.run_discovery(
        "goals", model="m", search_fn=search, llm_fn=fake_llm(scores=[]),
        cheap_llm_fn=fake_cheap_llm({"Kept": 9}), library_fn=lambda: [],
        recall_fn=lambda papers: ([], {"degraded": []}),
        citations_fn=fake_citations({"7777.00001": 10, "7777.00002": 10})))

    ledger = discovery_ledger.load()
    hidden_entry = discovery_ledger.get(ledger, "arxiv:7777.00002")
    assert hidden_entry is not None, "the candidate should still be remembered as seen"
    assert hidden_entry.get("cheap") is None, (
        "the gate's drop was recorded as a cheap-model verdict")
    assert not discovery_ledger.cached_cheap_drop(hidden_entry, model=discovery.CHEAP_MODEL,
                                                  profile="anything")


def test_an_unchanged_rerun_does_not_re_buy_the_screening_it_already_paid_for(temp_project):
    """The ledger's whole purpose. Without reuse a rerun pays for every batch a second time."""
    def search(query, n):
        return [_cand("7777.00001", "A"), _cand("7777.00002", "B")]

    calls = {"n": 0}
    scoring = fake_cheap_llm({"A": 8, "B": 7})

    def counting_cheap(system, user, max_tokens):
        calls["n"] += 1
        return scoring(system, user, max_tokens)

    def run():
        return list(discovery.run_discovery(
            "goals", model="m", search_fn=search, llm_fn=fake_llm(scores=[]),
            cheap_llm_fn=counting_cheap, library_fn=lambda: [],
            recall_fn=lambda papers: ([], {"degraded": []}),
            citations_fn=fake_citations({"7777.00001": 5, "7777.00002": 5})))[-1]["result"]

    first = run()
    after_first = calls["n"]
    second = run()

    assert after_first > 0
    assert calls["n"] == after_first, "the rerun re-bought screening it had already cached"
    assert second["audit"]["title_triage"]["reused"] == 2
    assert second["audit"]["abstract_scoring"]["reused"] == 2
    assert [s["title"] for s in second["suggestions"]] == [s["title"] for s in first["suggestions"]]


def test_the_triage_cap_does_not_let_one_lane_starve_another():
    """Goes through the stage, not the helper. Grounded candidates are merged first and a single
    well-cited anchor can contribute hundreds of them, so applying the cap in input order fills
    the whole budget from one lane and silently deletes the lexical results — the only lane a
    project with no library has at all."""
    grounded = [{"title": f"grounded {i}", "abstract": "a", "channels": ["cites"]}
                for i in range(discovery.MAX_AFTER_TITLE_TRIAGE + 100)]
    lexical = [{"title": f"lexical {i}", "abstract": "a", "channels": ["lexical"]}
               for i in range(50)]

    def keep_everything(system, user, max_tokens):
        return "\n".join(f"{line.split('|', 1)[0]}|K|METHOD" for line in user.splitlines()
                         if line.split("|", 1)[0].isdigit())

    kept, audit = discovery.triage_titles(grounded + lexical, "FOCUS: x", keep_everything)

    lanes = {c["channels"][0] for c in kept}
    assert lanes == {"cites", "lexical"}, "one lane was starved out of the cap entirely"
    assert len(kept) == discovery.MAX_AFTER_TITLE_TRIAGE
    assert audit["kept"] == len(kept)          # the audit reports what went forward, not pre-cap
    assert audit["dropped_by_cap"] > 0


def test_good_finds_are_emitted_before_any_model_has_judged_them(temp_project):
    """A run takes minutes. Grounded candidates — reached by forward-citation from the reader's
    own library, or already ranked by their reference graph — are worth showing on provenance
    alone, so the screen has something real seconds in rather than spinning. They are marked
    provisional: a paper shown early and then absent from the results must read as the screen
    doing its job, not as a bug."""
    grounded = [{"title": "Sparse attention for long-context transformers", "abstract": "a",
                 "channels": ["cites"], "citation_count": 900,
                 "provenance": [{"channel": "cites", "anchor_title": "Attention Is All You Need"}]}]

    events = list(discovery.run_discovery(
        "sparse attention in transformers", model="m", search_fn=lambda q, n: [],
        llm_fn=fake_llm(scores=[]),
        cheap_llm_fn=fake_cheap_llm({"Sparse attention": 9}), library_fn=lambda: [],
        recall_fn=lambda papers: (grounded, {"degraded": []}),
        citations_fn=fake_citations({})))

    finds = [e for e in events if e["type"] == "finds"]
    assert [f["stage"] for f in finds] == ["grounded", "screened", "ranked"]

    early = finds[0]
    assert early["items"][0]["title"] == "Sparse attention for long-context transformers"
    assert early["items"][0]["provisional"] is True
    assert "Attention Is All You Need" in early["items"][0]["reason"]
    # It arrives BEFORE the model stages, which is the whole point.
    types = [e["type"] for e in events]
    assert types.index("finds") < types.index("citations")

    assert finds[-1]["items"][0]["provisional"] is False


def test_a_find_carries_only_what_the_card_renders(temp_project):
    """Finds ride on every poll of a multi-minute job, so they must not carry abstracts or
    authorship lists for hundreds of candidates."""
    fat = [{"title": "Retrieval augmented generation", "abstract": "x" * 5000,
            "channels": ["graph"], "authors": [f"Author {i}" for i in range(50)],
            "provenance": [{"channel": "graph", "reasons": ["3 of your papers cite it"]}]}]
    events = list(discovery.run_discovery(
        "retrieval augmented generation", model="m", search_fn=lambda q, n: [],
        llm_fn=fake_llm(scores=[]),
        cheap_llm_fn=fake_cheap_llm({"Retrieval": 8}), library_fn=lambda: [],
        recall_fn=lambda papers: (fat, {"degraded": []}), citations_fn=fake_citations({})))

    item = next(e for e in events if e["type"] == "finds")["items"][0]
    assert set(item) == {"title", "year", "citation_count", "channels", "reason", "provisional"}
    assert item["reason"] == "3 of your papers cite it"


def test_no_more_than_a_handful_of_finds_are_sent():
    many = [{"title": f"P{i}", "channels": ["graph"], "citation_count": i} for i in range(50)]
    assert len(discovery._preview(many)) == discovery.PREVIEW_FINDS


def test_an_empty_keyword_search_no_longer_kills_a_run_the_library_can_carry(temp_project):
    """Keyword search used to BE the pipeline, so finding nothing was fatal. It is now one lane of
    several, and a project with a good library must not lose its grounded results because one
    generated query happened to match nothing."""
    grounded = [{"title": "Found Via Your Library", "abstract": "a", "channels": ["graph"],
                 "provenance": [{"channel": "graph", "reasons": ["2 of your papers cite it"]}]}]

    result = list(discovery.run_discovery(
        "goals", model="m", search_fn=lambda q, n: [],          # every query returns nothing
        llm_fn=fake_llm(scores=[]), cheap_llm_fn=fake_cheap_llm({"Found Via Your Library": 9}),
        library_fn=lambda: [], recall_fn=lambda papers: (grounded, {"degraded": []}),
        citations_fn=fake_citations({})))[-1]["result"]

    assert [s["title"] for s in result["suggestions"]] == ["Found Via Your Library"]


def test_a_run_with_nothing_from_any_lane_still_fails_loudly(temp_project):
    with pytest.raises(DiscoveryError):
        list(discovery.run_discovery(
            "goals", model="m", search_fn=lambda q, n: [], llm_fn=fake_llm(scores=[]),
            cheap_llm_fn=fake_cheap_llm({}), library_fn=lambda: [],
            recall_fn=lambda papers: ([], {"degraded": []}), citations_fn=fake_citations({})))


def test_an_early_find_must_share_vocabulary_with_what_was_asked_for():
    """Provenance alone is not enough to put a title on screen. A live run for '3D-stacked DRAM'
    offered 'The AI gambit: leveraging AI to combat climate change' — a real paper citing the
    reader's library, ranked up by citation count, and completely off-topic. An early find that
    looks irrelevant makes the search look worse than showing nothing."""
    candidates = [
        {"title": "The AI gambit: leveraging AI to combat climate change",
         "channels": ["cites"], "citation_count": 5000},
        {"title": "A 3D-stacked DRAM architecture for near-memory compute",
         "channels": ["cites"], "citation_count": 12},
    ]
    finds = discovery._preview(candidates, focus="3D-stacked DRAM architectures",
                               provisional=True)
    assert [f["title"] for f in finds] == [
        "A 3D-stacked DRAM architecture for near-memory compute"]


def test_showing_nothing_beats_showing_something_irrelevant():
    finds = discovery._preview(
        [{"title": "Entirely unrelated work", "channels": ["cites"], "citation_count": 9000}],
        focus="3D-stacked DRAM", provisional=True)
    assert finds == []


def test_ranked_finds_are_not_filtered_by_vocabulary():
    """By then a model has judged them on the abstract, which beats a word-overlap heuristic —
    a paper can be exactly right without repeating the reader's phrasing in its title."""
    finds = discovery._preview(
        [{"title": "Processing-in-memory for transformers", "score": 9.0}],
        focus="3D-stacked DRAM")
    assert len(finds) == 1


def test_a_run_with_no_stated_focus_still_previews_rather_than_filtering_everything_out():
    finds = discovery._preview(
        [{"title": "Anything", "channels": ["graph"]}], focus="", provisional=True)
    assert len(finds) == 1


def test_every_grounded_find_says_why_it_is_on_screen():
    """A titled row with no explanation is what makes a suggestion feel arbitrary. A live run
    showed three of five finds with a blank reason line, because the citation anchor had no
    stored title and the fallbacks did not cover it."""
    candidates = [
        {"title": "3D DRAM one", "channels": ["cites"],
         "provenance": [{"channel": "cites", "anchor_slug": "s"}]},        # anchor, no title
        {"title": "3D DRAM two", "channels": ["cites"]},                    # no provenance at all
        {"title": "3D DRAM three", "channels": ["graph"],
         "provenance": [{"channel": "graph", "reasons": []}]},             # graph, no reasons
    ]
    finds = discovery._preview(candidates, focus="3D DRAM", provisional=True)
    assert len(finds) == 3
    assert all(f["reason"] for f in finds), [f["reason"] for f in finds]


def test_short_but_meaningful_acronyms_are_not_discarded_from_the_topic():
    """A four-character floor dropped LLM, RAG, NLP, PIM and DNN — exactly what a reader types.
    That emptied the word set, which disabled the filter entirely and admitted the high-citation
    noise the filter exists to stop."""
    finds = discovery._preview(
        [{"title": "A survey of RAG systems", "channels": ["cites"]},
         {"title": "Completely unrelated cardiology work", "channels": ["cites"],
          "citation_count": 90000}],
        focus="RAG", provisional=True)
    assert [f["title"] for f in finds] == ["A survey of RAG systems"]


def test_ordinary_plurals_still_match():
    finds = discovery._preview(
        [{"title": "Learning disentangled representations", "channels": ["graph"]}],
        focus="representation learning", provisional=True)
    assert len(finds) == 1


def test_a_lexical_outage_is_reported_rather_than_presented_as_a_clean_run(temp_project):
    """Continuing on the grounded channels is right; saying nothing about it is not. A run that
    searched half its sources and reports success presents an incomplete result as a complete
    one, and the reader cannot tell why their topic looks thin."""
    def exploding_search(query, n):
        raise RuntimeError("provider down")

    grounded = [{"title": "Sparse attention for transformers", "abstract": "a",
                 "channels": ["graph"],
                 "provenance": [{"channel": "graph", "reasons": ["2 of your papers cite it"]}]}]

    result = list(discovery.run_discovery(
        "sparse attention transformers", model="m", search_fn=exploding_search,
        llm_fn=fake_llm(scores=[]), cheap_llm_fn=fake_cheap_llm({"Sparse": 9}),
        library_fn=lambda: [], recall_fn=lambda papers: (grounded, {"degraded": []}),
        citations_fn=fake_citations({})))[-1]["result"]

    assert result["suggestions"], "the grounded lane should still have carried the run"
    assert any("Keyword search returned nothing" in d for d in result["degraded"]), \
        result["degraded"]


def test_a_failed_query_plan_degrades_to_the_readers_own_words(temp_project):
    """Observed in production 2026-07-31: the planner answered with something that was not JSON
    and the run ended 168s in with nothing to show. The plan is a convenience — the reader's own
    words are a usable query, and the library-grounded channels never used the plan at all."""
    searched: list[str] = []

    def llm_fn(model, system, user, max_tokens):
        return "Sure! Here are some good queries you might try:"   # prose, not JSON

    def search(query, n):
        searched.append(query)
        return [_cand("7777.00001", "Compute Express Link memory pooling")]

    result = list(discovery.run_discovery(
        "Compute Express Link uses and applications", model="m", search_fn=search,
        llm_fn=llm_fn, cheap_llm_fn=fake_cheap_llm({"Compute Express Link": 9}),
        library_fn=lambda: [], recall_fn=lambda papers: ([], {"degraded": []}),
        citations_fn=fake_citations({"7777.00001": 20})))[-1]["result"]

    assert result["suggestions"], "the run should have completed on the fallback plan"
    assert any("Compute Express Link" in q for q in searched)
    assert any("Query planning failed" in d for d in result["degraded"]), result["degraded"]


def test_the_first_finds_arrive_before_the_slow_grounded_recall(temp_project):
    """The reel should start almost immediately, not a minute in. Keyword hits are relevant by
    construction and land within seconds; grounded recall (anchor resolution + citation chase)
    takes far longer. Emitting only after recall left the panel empty through the longest part
    of the run, which is exactly when the reader most needs to see something happening."""
    order: list[str] = []

    def slow_recall(papers):
        order.append("recall")
        return [], {"degraded": []}

    def search(query, n):
        return [_cand("7777.00001", "Compute Express Link memory pooling")]

    events = list(discovery.run_discovery(
        "Compute Express Link", model="m", search_fn=search, llm_fn=fake_llm(scores=[]),
        cheap_llm_fn=fake_cheap_llm({"Compute Express Link": 9}), library_fn=lambda: [],
        recall_fn=slow_recall, citations_fn=fake_citations({"7777.00001": 3})))

    first_finds = next(i for i, e in enumerate(events) if e["type"] == "finds")
    library_at = next(i for i, e in enumerate(events) if e["type"] == "library")
    assert first_finds < library_at, "the reel waited for grounded recall"
    assert events[first_finds]["stage"] == "searching"
    assert events[first_finds]["items"][0]["title"] == "Compute Express Link memory pooling"


def test_the_reel_is_long_enough_to_scroll_without_visibly_repeating():
    """The client shows two rows and loops the reel; a five-item reel repeats every few seconds."""
    many = [{"title": f"Compute Express Link paper {i}", "channels": ["graph"]}
            for i in range(40)]
    assert len(discovery._preview(many, focus="Compute Express Link")) == discovery.PREVIEW_FINDS
    assert discovery.PREVIEW_FINDS >= 8
