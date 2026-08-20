"""DR-052 PR 3 — lane-1 significance: the pre-filter, the classification, and the blend.

The design constraints under test (spec §3): the deterministic Valenzuela pre-filter decides
which edges are worth an LLM call (the honest prior says 5-15%); `isInfluential` boosts into
the slice but never gates; the classification is cached by CONTEXT hash, not profile, so a
goals rewrite re-buys nothing; and an unclassified candidate ranks exactly as it did before
this stage existed.
"""
from __future__ import annotations

from app import discovery, significance


def _candidate(contexts, *, influential=False, reference_count=40, anchor="Attention Is All",
               title="A New Citer", extra=None):
    return {
        "title": title,
        "abstract": "",
        "arxiv_id": "2608.00001",
        "year": 2026,
        "channels": ["new_citation"],
        "provenance": [{
            "channel": "new_citation",
            "anchor_slug": "attention",
            "anchor_title": anchor,
            "contexts": contexts,
            "is_influential": influential,
            "reference_count": reference_count,
        }],
        **(extra or {}),
    }


# ---------- the deterministic pre-filter ----------

def test_one_plain_mention_stays_below_the_threshold():
    score, features = significance.prescore(
        _candidate(["Prior work includes transformers [12]."], reference_count=80))
    assert score < significance.PRESCORE_THRESHOLD
    assert features["mentions"] == 1 and not features["cue"]


def test_cue_phrase_selects(monkeypatch):
    score, features = significance.prescore(
        _candidate(["We extend the attention mechanism of [12] to sparse graphs."],
                   reference_count=80))
    assert features["cue"] is True
    assert score >= significance.PRESCORE_THRESHOLD


def test_repeated_mentions_select():
    contexts = [f"As shown in [12], variant {i} applies." for i in range(3)]
    score, _ = significance.prescore(_candidate(contexts, reference_count=200))
    assert score >= significance.PRESCORE_THRESHOLD


def test_influential_flag_boosts_but_does_not_gate():
    plain = _candidate(["See [12]."], reference_count=300)
    flagged = _candidate(["See [12]."], reference_count=300, influential=True)
    plain_score, _ = significance.prescore(plain)
    flagged_score, _ = significance.prescore(flagged)
    assert flagged_score > plain_score
    # And a strongly-selected edge WITHOUT the flag still passes: the flag is not a gate.
    unflagged_strong = _candidate(
        ["We build on the method of [12].", "Following [12] we train..."])
    assert significance.prescore(unflagged_strong)[0] >= significance.PRESCORE_THRESHOLD


def test_reference_scarcity_counts():
    short_list = significance.prescore(_candidate(["See [3]."], reference_count=12))[0]
    long_list = significance.prescore(_candidate(["See [3]."], reference_count=240))[0]
    assert short_list > long_list


# ---------- classification ----------

def _llm_replying(lines):
    calls = []

    def cheap_llm(system, user, max_tokens):
        calls.append(user)
        return "\n".join(lines)

    cheap_llm.calls = calls
    return cheap_llm


def test_classify_attaches_blocks_and_counts_labels():
    kept = _candidate(["We extend the attention mechanism of [12]."])
    incidental = _candidate(["Prior work includes [12]."], reference_count=300,
                            title="Passing Mention")
    llm = _llm_replying(["1|EXTENDS|extends the attention mechanism to sparse graphs"])
    audit = significance.classify([kept, incidental], llm, cheap_model="m")

    assert kept["significance"]["label"] == "EXTENDS"
    assert kept["significance"]["significant"] is True
    assert kept["significance"]["note"].startswith("extends the attention")
    assert "significance" not in incidental          # never reached the model
    assert audit["lane"] == 2 and audit["selected"] == 1
    assert audit["labels"] == {"EXTENDS": 1}
    assert len(llm.calls) == 1 and "Passing Mention" not in llm.calls[0]


def test_background_label_attaches_but_is_not_significant():
    candidate = _candidate(["We extend [12]."])
    llm = _llm_replying(["1|BACKGROUND|mentioned among related work"])
    significance.classify([candidate], llm, cheap_model="m")
    assert candidate["significance"]["label"] == "BACKGROUND"
    assert candidate["significance"]["significant"] is False


def test_malformed_label_leaves_candidate_unclassified():
    candidate = _candidate(["We extend [12]."])
    llm = _llm_replying(["1|SOMETHING_ELSE|whatever"])
    significance.classify([candidate], llm, cheap_model="m")
    assert "significance" not in candidate


def test_no_lane_candidates_never_calls_the_model():
    llm = _llm_replying(["1|EXTENDS|x"])
    audit = significance.classify(
        [{"title": "Keyword hit", "channels": ["lexical"], "provenance": []}],
        llm, cheap_model="m")
    assert audit["lane"] == 0 and not llm.calls


def test_ledger_cache_short_circuits_by_context_hash():
    candidate = _candidate(["We extend the attention mechanism of [12]."])
    digest = significance._contexts_hash(
        ["We extend the attention mechanism of [12]."])
    entry = {"citation": {"label": "USES", "note": "cached", "model": "m",
                          "contexts_hash": digest}}
    llm = _llm_replying(["1|EXTENDS|fresh"])
    audit = significance.classify(
        [candidate], llm, cheap_model="m",
        ledger={"k": entry}, get_entry=lambda ledger, key: entry)
    assert candidate["significance"]["label"] == "USES"      # the cache, not the model
    assert audit["reused"] == 1 and not llm.calls


def test_stale_cache_wrong_model_reclassifies():
    candidate = _candidate(["We extend the attention mechanism of [12]."])
    entry = {"citation": {"label": "USES", "note": "old", "model": "OTHER",
                          "contexts_hash": "aaaa"}}
    recorded = {}

    def record(cand, **kw):
        recorded.update(kw)

    llm = _llm_replying(["1|EXTENDS|fresh evidence"])
    significance.classify([candidate], llm, cheap_model="m",
                          ledger={}, get_entry=lambda ledger, key: entry,
                          record_entry=record)
    assert candidate["significance"]["label"] == "EXTENDS"
    assert recorded["label"] == "EXTENDS" and recorded["model"] == "m"
    assert recorded["contexts_hash"]


# ---------- the blend ----------

def test_significant_citer_outranks_and_carries_the_evidence_line():
    base = dict(_candidate(["We extend [12]."]), relevance=7.0, citation_count=0)
    plain = dict(base)
    winner = dict(base, title="Significant One",
                  significance={"label": "EXTENDS", "significant": True,
                                "note": "extends the method to sparse graphs",
                                "mentions": 3, "prescore": 1.2})
    ranked = discovery.blend_and_rank([plain, winner])
    assert ranked[0]["title"] == "Significant One"
    assert ranked[0]["score"] - ranked[1]["score"] == discovery.SIGNIFICANT_CITER_BONUS
    line = next(r for r in ranked[0]["reasons"] if r.startswith("Significant"))
    assert "extends" in line and "3×" in line and "sparse graphs" in line


def test_connectivity_bonus_needs_more_than_one_anchor():
    single = {"title": "One edge", "relevance": 7.0, "citation_count": 0,
              "channels": ["cites"],
              "provenance": [{"channel": "cites", "anchor_slug": "a", "anchor_title": "A"}]}
    triple = {"title": "Three edges", "relevance": 7.0, "citation_count": 0,
              "channels": ["cites"],
              "provenance": [
                  {"channel": "cites", "anchor_slug": s, "anchor_title": s.upper()}
                  for s in ("a", "b", "c")]}
    ranked = discovery.blend_and_rank([single, triple])
    assert ranked[0]["title"] == "Three edges"
    assert any("Connects to 3 papers" in r for r in ranked[0]["reasons"])
    assert not any(r.startswith("Connects") for r in ranked[1]["reasons"])


def test_momentum_lifts_a_young_fast_paper_but_never_an_old_one():
    from datetime import UTC, datetime
    year = datetime.now(UTC).year
    young = {"year": year, "citation_count": 40,
             "counts_by_year": [{"year": year, "cited_by_count": 30},
                                {"year": year - 1, "cited_by_count": 10}]}
    old = {"year": year - 7, "citation_count": 600}
    assert discovery._momentum_term(young, 40) > 0
    assert discovery._momentum_term(old, 600) == 0.0
    # Capped: absurd velocity cannot swamp relevance.
    surge = {"year": year, "citation_count": 100_000}
    assert discovery._momentum_term(surge, 100_000) == discovery.MOMENTUM_CAP


def test_momentum_velocity_fallback_without_counts_by_year():
    from datetime import UTC, datetime
    year = datetime.now(UTC).year
    s2_only = {"year": year - 1, "citation_count": 60}
    assert discovery._momentum_term(s2_only, 60) > 0
