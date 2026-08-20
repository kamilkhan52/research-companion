"""Stage A: the free deterministic gate, and the ledger it consults.

Pure functions, so these tests pin the actual rules rather than a pipeline's emergent behaviour.
The rules that matter are the ones that are easy to get backwards: a citation floor that must
scale with age, and corpus-grounded candidates that must skip it entirely.
"""
from __future__ import annotations

import json

from app import discovery_gate, discovery_ledger

THIS_YEAR = 2026


class _Paper:
    def __init__(self, title="", arxiv_id=None, doi=None):
        self.title, self.arxiv_id, self.doi = title, arxiv_id, doi


def _keys(candidate: dict) -> list[str]:
    out = []
    if candidate.get("arxiv_id"):
        out.append(f"arxiv:{candidate['arxiv_id'].lower()}")
    if candidate.get("doi"):
        out.append(f"doi:{candidate['doi'].lower()}")
    if candidate.get("title"):
        out.append(f"title:{candidate['title'].lower()}")
    return out


def _gate(candidates, **kwargs):
    defaults = {
        "known_papers": [], "hidden_filter": lambda c: c,
        "titles_match": lambda a, b: a == b, "today_year": THIS_YEAR, "identity_keys": _keys}
    defaults.update(kwargs)
    return discovery_gate.apply_gate(candidates, **defaults)


# ---------- already known ----------

def test_a_paper_already_on_the_reading_list_is_dropped():
    """The most visible defect in the pipeline this replaces: recommending papers you have."""
    kept, counts = _gate(
        [{"arxiv_id": "1706.03762", "title": "Attention Is All You Need", "abstract": "a"}],
        known_papers=[_Paper(title="Attention Is All You Need", arxiv_id="1706.03762")])
    assert kept == []
    assert counts["already_known"] == 1


def test_a_versioned_arxiv_id_still_matches_the_paper_you_have():
    kept, _ = _gate([{"arxiv_id": "1706.03762v3", "title": "T", "abstract": "a"}],
                    known_papers=[_Paper(title="T", arxiv_id="1706.03762")])
    assert kept == []


def test_the_same_paper_under_a_different_identifier_is_caught_by_title():
    kept, counts = _gate(
        [{"doi": "10.1/x", "title": "attention is all you need", "abstract": "a"}],
        known_papers=[_Paper(title="Attention Is All You Need")],
        titles_match=lambda a, b: a == b)
    assert kept == []
    assert counts["already_known"] == 1


# ---------- the citation floor ----------

def test_an_old_paper_with_almost_no_citations_is_dropped():
    kept, counts = _gate([{"title": "T", "abstract": "a", "year": 2010, "citation_count": 3}])
    assert kept == []
    assert counts["citation_floor"] == 1


def test_a_recent_paper_survives_a_floor_that_would_otherwise_reject_it():
    """The rule a flat floor gets wrong: recent work has had no time to accrue citations, and
    deleting it is the opposite of what a discovery feature is for.

    Uses last year deliberately — at `THIS_YEAR` the computed floor is 0 and any paper passes, so
    a test there would hold even with the recency rule removed and would prove nothing.
    """
    last_year = {"title": "T", "abstract": "a", "year": THIS_YEAR - 1, "citation_count": 0}
    assert discovery_gate.CITATION_FLOOR_PER_YEAR > 0     # the floor here is non-zero...
    kept, counts = _gate([last_year])
    assert len(kept) == 1                                  # ...and recency is what clears it
    assert counts["citation_floor"] == 0


def test_the_floor_stops_rising_so_foundational_work_is_not_deleted():
    old_but_solid = {"title": "T", "abstract": "a", "year": 1996,
                     "citation_count": discovery_gate.CITATION_FLOOR_CAP}
    kept, _ = _gate([old_but_solid])
    assert len(kept) == 1


def test_unknown_age_or_unknown_impact_is_uncertainty_not_grounds_for_deletion():
    kept, _ = _gate([
        {"title": "no year", "abstract": "a", "citation_count": 0},
        {"title": "no count", "abstract": "a", "year": 2005},
    ])
    assert len(kept) == 2


def test_a_grounded_candidate_bypasses_the_citation_floor():
    """A paper reached from the reader's own library carries project-specific evidence; a generic
    popularity threshold knows nothing about that and would discard the most personal results."""
    for channel in ("cites", "graph"):
        kept, counts = _gate([{"title": "T", "abstract": "a", "year": 2010,
                               "citation_count": 0, "channels": [channel]}])
        assert len(kept) == 1, channel
        assert counts["citation_floor"] == 0


# ---------- type and substance ----------

def test_editorials_and_datasets_are_never_a_reading_suggestion():
    kept, counts = _gate([{"title": "T", "abstract": "a", "publication_types": ["Editorial"]}])
    assert kept == []
    assert counts["excluded_type"] == 1


def test_a_scholarly_review_survives_for_the_survey_screening_protection():
    """S2 uses Review for surveys; dropping the type here bypasses the SURVEY title tag."""
    kept, counts = _gate([{
        "title": "A Survey of Memory Disaggregation", "abstract": "a",
        "publication_types": ["Review"],
    }])
    assert len(kept) == 1
    assert counts["excluded_type"] == 0


def test_a_row_with_neither_abstract_nor_citations_is_dropped_unless_grounded():
    kept, counts = _gate([{"title": "bare"}])
    assert kept == [] and counts["no_substance"] == 1
    kept, _ = _gate([{"title": "bare", "channels": ["cites"]}])
    assert len(kept) == 1


# ---------- the ledger ----------

def test_a_previous_drop_is_reused_only_when_model_and_profile_both_match(tmp_path, monkeypatch):
    """A cheaper check would make a model upgrade or a goals rewrite invisible, permanently
    burying papers the new configuration would have kept — with no way for the user to tell."""
    entry = {}
    discovery_ledger.record_cheap_verdict(
        entry, verdict="D", tag="OFF-TOPIC", model="m1", profile="p1", today="2026-07-30")

    assert discovery_ledger.cached_cheap_drop(entry, model="m1", profile="p1") is True
    assert discovery_ledger.cached_cheap_drop(entry, model="m2", profile="p1") is False
    assert discovery_ledger.cached_cheap_drop(entry, model="m1", profile="p2") is False
    assert discovery_ledger.cached_cheap_drop(None, model="m1", profile="p1") is False


def test_the_gate_drops_a_candidate_the_ledger_already_rejected():
    ledger = {"entries": {}}
    entry = discovery_ledger.observe(ledger, "arxiv:1", {"title": "T"}, "lexical", "2026-07-30")
    discovery_ledger.record_cheap_verdict(
        entry, verdict="D", tag="OFF-TOPIC", model="m1", profile="p1", today="2026-07-30")

    kept, counts = _gate([{"arxiv_id": "1", "title": "T", "abstract": "a"}],
                         ledger=ledger, cheap_model="m1", profile="p1")
    assert kept == []
    assert counts["ledger_dropped"] == 1


def test_a_corrupt_ledger_is_preserved_and_replaced_rather_than_trusted(tmp_path, monkeypatch):
    """Losing the ledger costs money (re-screening); half-trusting it costs correctness."""
    path = tmp_path / "discovery-ledger.json"
    path.write_text("{ this is not json")
    monkeypatch.setattr(discovery_ledger, "ledger_path", lambda: path)

    ledger = discovery_ledger.load()
    assert ledger["entries"] == {}
    assert "degraded" in ledger
    assert list(tmp_path.glob("discovery-ledger.bak-*")), "the corrupt bytes were not preserved"


def test_a_ledger_round_trips_and_is_written_atomically(tmp_path, monkeypatch):
    path = tmp_path / "discovery-ledger.json"
    monkeypatch.setattr(discovery_ledger, "ledger_path", lambda: path)

    ledger = discovery_ledger.load()
    discovery_ledger.observe(ledger, "arxiv:1", {"title": "T"}, "cites", "2026-07-30")
    discovery_ledger.record_sweep(ledger, "cites:W1", swept_to="2026-07-30")
    discovery_ledger.save(ledger)

    assert not list(tmp_path.glob("*.tmp*")), "an atomic write left its temporary file behind"
    reloaded = discovery_ledger.load()
    assert reloaded["entries"]["arxiv:1"]["channels"] == ["cites"]
    assert discovery_ledger.swept_to(reloaded, "cites:W1") == "2026-07-30"
    assert json.loads(path.read_text())["version"] == discovery_ledger.LEDGER_VERSION


def test_seeing_a_candidate_again_updates_rather_than_duplicates_it():
    ledger = {"entries": {}}
    discovery_ledger.observe(ledger, "arxiv:1", {"title": "T"}, "cites", "2026-07-01")
    entry = discovery_ledger.observe(ledger, "arxiv:1", {"title": "T"}, "graph", "2026-07-30")
    assert entry["times_seen"] == 2
    assert entry["channels"] == ["cites", "graph"]
    assert entry["first_seen"] == "2026-07-01" and entry["last_seen"] == "2026-07-30"


def test_the_ledger_keeps_a_compact_candidate_reservoir_for_incremental_runs():
    ledger = {"entries": {}}
    discovery_ledger.observe(
        ledger, "s2:p1", {
            "paper_id": "p1", "title": "A", "abstract": "useful", "channels": ["bulk"],
            "sources": ["semantic_scholar"], "authors": ["Ada"],
        }, "bulk", "2026-07-30")
    discovery_ledger.observe(
        ledger, "s2:p1", {"paper_id": "p1", "title": "A", "citation_count": 9,
                           "channels": ["topic"]}, "topic", "2026-07-31")

    rows = discovery_ledger.reservoir(ledger)
    assert len(rows) == 1
    assert rows[0]["abstract"] == "useful"
    assert rows[0]["citation_count"] == 9
    assert set(rows[0]["channels"]) == {"bulk", "topic"}


def test_frontier_updates_are_applied_only_from_complete_provider_results():
    ledger = {"frontier": {}}
    discovery_ledger.apply_frontier_updates(ledger, [
        {"key": "topic:T1", "swept_to": "2026-07-31", "pages": 2},
        {"key": "", "swept_to": "2026-07-31"},
    ])
    assert discovery_ledger.swept_to(ledger, "topic:T1") == "2026-07-31"
    assert ledger["frontier"]["topic:T1"]["pages"] == 2


# ---------- isolation (found the hard way) ----------

def test_per_project_state_never_resolves_into_the_developers_working_tree():
    """A test without `temp_project` used to resolve `config.state_dir()` to `<repo>/project`,
    because `project_dir` falls back to the legacy directory when no project is scoped. It wrote
    a discovery ledger there and then READ it back on later runs — stale KEEP verdicts silently
    satisfied a screening stage, so the pipeline skipped work and the failure looked like a bug
    in the code under test. The conftest fixture closes it; this pins it shut."""
    from app import config
    resolved = config.state_dir().resolve()
    repo_project = (config.BASE_DIR / "project").resolve()
    assert repo_project not in resolved.parents and resolved != repo_project, resolved


def test_a_brand_new_citer_is_not_dropped_by_the_citation_floor():
    """The delta lane (DR-052 PR 2) reports papers that have just started citing the reader's
    own work. They are new by construction and so have almost no citations of their own — an
    age-scaled floor would drop exactly the frontier work the lane exists to surface."""
    candidate = {
        "title": "Just cited you", "abstract": "", "year": 2019, "citation_count": 0,
        "channels": ["new_citation"], "publication_types": [],
        "provenance": [{"channel": "new_citation", "anchor_slug": "p1",
                        "contexts": ["We extend their method."]}],
    }
    kept, counts = _gate([candidate])
    assert counts["citation_floor"] == 0
    assert [c["title"] for c in kept] == ["Just cited you"]


# ---------- lane 3's S2 primitives (DR-052 PR 3b) ----------

def test_a_recommendation_is_grounded_and_bypasses_the_citation_floor():
    """Seeded entirely by the reader's library and dismissals: a citation floor would delete
    exactly the fresh work a corpus-seeded recommender surfaces best."""
    kept, counts = _gate([{"title": "T", "abstract": "a", "year": 2010,
                           "citation_count": 0, "channels": ["s2_recommendations"]}])
    assert len(kept) == 1
    assert counts["citation_floor"] == 0


def test_a_snippet_passage_counts_as_substance():
    """Snippet hits often carry externalIds only — no abstract, no counts. The matched
    full-text passage is more substance than an abstract fragment, not less."""
    kept, counts = _gate([{"title": "T", "snippet": "We measure decode latency on ...",
                           "channels": ["snippet"]}])
    assert len(kept) == 1
    assert counts["no_substance"] == 0
    # And a snippet-less equivalent still drops, so the pass above is the passage's doing.
    kept, counts = _gate([{"title": "T", "channels": ["snippet"]}])
    assert kept == []
    assert counts["no_substance"] == 1
