"""R6.4 — LLM affiliation fallback: provider-first (OpenAlex wins when it has data), the LLM
pass reads the paper's own first page, results are cached per node, and nothing here can fail
a build. Extraction tests call _extract_missing directly with a fake completion function
(bypassing the conftest stub, like citations._fetch_missing); no network, no real LLM."""
from __future__ import annotations

import time

from app import affiliations, llm
from app.affiliations import _extract_missing as real_extract_missing

from tests.conftest import add_paper

HEADER = ("DeepStack: Scalable Exploration Zhiwen Mo1, Hongxiang Fan1 "
          "1Imperial College London Abstract Advances in hybrid bonding...")


def node(node_id, slug, arxiv_id="2401.00001", authors=None):
    return {"id": node_id, "kind": "project", "slug": slug, "arxiv_id": arxiv_id,
            "authors": authors or []}


def fake_complete(reply):
    calls = []

    def complete(messages, **kwargs):
        calls.append(messages)
        return reply
    complete.calls = calls
    return complete


def test_parse_keeps_name_bar_institution_lines_only():
    raw = ("Here you go:\n"
           "Zhiwen Mo | Imperial College London\n"
           "- Hongxiang Fan | Imperial College London\n"
           "Nameless Person |\n"
           "not a mapping line\n")
    ships = affiliations._parse(raw)
    assert ships == [
        {"name": "Zhiwen Mo", "affiliation": "Imperial College London"},
        {"name": "Hongxiang Fan", "affiliation": "Imperial College London"},
        {"name": "Nameless Person", "affiliation": ""},
    ]


def test_extract_reads_the_papers_own_first_page(temp_project):
    add_paper(temp_project, "deepstack", "DeepStack", full_text=HEADER)
    complete = fake_complete("Zhiwen Mo | Imperial College London")

    ships = affiliations.extract("deepstack", complete=complete)

    assert ships == [{"name": "Zhiwen Mo", "affiliation": "Imperial College London"}]
    sent = complete.calls[0][0]["content"]
    assert "Zhiwen Mo1" in sent  # the paper text itself was shown to the model


def test_extract_without_cached_text_returns_none(temp_project):
    assert affiliations.extract("missing-paper", complete=fake_complete("x | y")) is None


def test_provider_first_skips_papers_openalex_covered(temp_project):
    add_paper(temp_project, "covered", "Covered", full_text=HEADER)
    complete = fake_complete("Someone | Somewhere")
    openalex_cache = {"covered": {"authorships": [{"name": "A", "affiliation": "MIT"}]}}
    cache = {}

    real_extract_missing(
        [node("covered", "covered")], openalex_cache, cache, complete=complete)

    assert complete.calls == []  # no tokens spent
    assert cache == {}


def test_uncovered_paper_is_extracted_cached_and_fills_missing_authors(temp_project):
    add_paper(temp_project, "deepstack", "DeepStack", full_text=HEADER)
    complete = fake_complete("Zhiwen Mo | Imperial College London")
    cache = {}
    n = node("deepstack", "deepstack")

    real_extract_missing([n], {}, cache, complete=complete)
    affiliations.apply_cached([n], cache)

    assert cache["deepstack"]["authorships"] == [
        {"name": "Zhiwen Mo", "affiliation": "Imperial College London"}]
    assert n["authors"] == ["Zhiwen Mo"]  # provider missed this paper entirely

    # Second build: cache hit, no new LLM call.
    real_extract_missing([n], {}, cache, complete=complete)
    assert len(complete.calls) == 1

    # Force re-extracts.
    real_extract_missing([n], {}, cache, complete=complete, force=True)
    assert len(complete.calls) == 2


def test_identity_correction_drops_the_stale_record(temp_project):
    complete = fake_complete("irrelevant")
    cache = {"p": {"status": "done", "key": "2401.00001", "authorships": [
        {"name": "Old Author", "affiliation": "Old Lab"}]}}
    # Same node id, corrected arXiv id, and no cached text for the new identity yet.
    n = node("p", "p-slug", arxiv_id="2502.99999")

    real_extract_missing([n], {}, cache, complete=complete)
    affiliations.apply_cached([n], cache)

    assert "p" not in cache  # never keep another paper's affiliations
    assert n["authors"] == []


def test_llm_failure_never_raises_and_is_retried_next_build(temp_project):
    add_paper(temp_project, "deepstack", "DeepStack", full_text=HEADER)

    def exploding(messages, **kwargs):
        raise llm.LLMError("provider down")
    cache = {}
    n = node("deepstack", "deepstack")

    real_extract_missing([n], {}, cache, complete=exploding)

    assert cache == {}  # nothing cached → automatically retried next build


def test_annotate_wrapper_never_raises_even_on_unexpected_errors(temp_project, monkeypatch):
    # Bypass the conftest no-op stub to prove the wrapper's own guard holds.
    def exploding(*args, **kwargs):
        raise RuntimeError("unexpected")
    monkeypatch.setattr(affiliations, "_extract_missing", exploding)

    affiliations.annotate_project_affiliations([node("p", "p")], {}, {})  # must not raise


def test_stalled_llm_call_hits_the_hard_deadline_and_aborts_the_pass(temp_project, monkeypatch):
    """A provider that accepts the request but never returns must not wedge the build's
    enrichment phase — the wall-clock deadline turns it into a retryable miss, and the FIRST
    stall aborts the pass so a dead provider costs one deadline per build, not one per paper."""
    add_paper(temp_project, "a", "Paper A", full_text=HEADER)
    add_paper(temp_project, "b", "Paper B", full_text=HEADER)
    monkeypatch.setattr(affiliations, "HARD_DEADLINE_S", 0.05)
    calls = []

    def stalled(messages, **kwargs):
        calls.append(1)
        time.sleep(0.4)
        return "Too | Late"

    cache = {}
    real_extract_missing([node("a", "a"), node("b", "b")], {}, cache, complete=stalled)

    assert cache == {}          # nothing cached → retried next build
    assert len(calls) == 1      # aborted after the first stall

    # While the orphaned worker is still alive, the next pass must not stack another
    # thread on the same dead provider — it skips entirely.
    real_extract_missing([node("b", "b")], {}, cache, complete=stalled)
    assert len(calls) == 1

    # Cleanup: let the fake stall finish so later tests aren't guarded against.
    for orphan in list(affiliations._orphans):
        orphan.join(timeout=2)
    assert not affiliations._orphan_alive()


def test_each_paid_extraction_is_persisted_as_it_lands(temp_project):
    """A restart mid-pass must not re-bill papers whose extraction already completed."""
    add_paper(temp_project, "a", "Paper A", full_text=HEADER)
    add_paper(temp_project, "b", "Paper B", full_text=HEADER)
    cache = {}
    persists = []

    real_extract_missing(
        [node("a", "a"), node("b", "b")], {}, cache,
        complete=fake_complete("Zhiwen Mo | Imperial College London"),
        persist=lambda: persists.append(len(cache)))

    assert persists == [1, 2]  # saved after EACH paper, not once at the end


def test_extract_falls_back_to_graph_retrieved_text(temp_project):
    """Graph-only papers (no corpus file) keep their text in the graph store — exactly the
    papers OpenAlex can't cover, so the fallback must reach them too."""
    from app import graph_store
    graph_store.write_retrieved_text("ghost", HEADER)

    ships = affiliations.extract(
        "ghost", complete=fake_complete("Zhiwen Mo | Imperial College London"))

    assert ships == [{"name": "Zhiwen Mo", "affiliation": "Imperial College London"}]


def test_graph_only_paper_reextracts_when_its_stored_text_changes(temp_project):
    """A graph-only slug (no arXiv id) can have its stored text replaced by a DIFFERENT
    confirmed paper without force — the cache key follows the text identity, so the old
    paper's people are never republished for the new one."""
    from app import graph_store
    graph_store.write_retrieved_text("ghost", HEADER)
    complete = fake_complete("Zhiwen Mo | Imperial College London")
    cache = {}
    n = node("ghost", "ghost", arxiv_id=None)

    real_extract_missing([n], {}, cache, complete=complete)
    assert len(complete.calls) == 1
    real_extract_missing([n], {}, cache, complete=complete)
    assert len(complete.calls) == 1  # same text → cache hit

    graph_store.write_retrieved_text("ghost", "A Different Paper Someone Else | Elsewhere U")
    real_extract_missing([n], {}, cache, complete=complete)
    assert len(complete.calls) == 2  # replaced text → re-extracted

    # And the apply step refuses a record whose key doesn't match the current text.
    stale = {"ghost": {"status": "done", "key": "text:0000000000000000",
                       "authorships": [{"name": "Old Author", "affiliation": "Old Lab"}]}}
    fresh = node("ghost", "ghost", arxiv_id=None)
    affiliations.apply_cached([fresh], stale)
    assert fresh["authors"] == []
