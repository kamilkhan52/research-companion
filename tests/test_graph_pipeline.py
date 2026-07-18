"""End-to-end build_graph over a real temp project, with a fake extract_fn standing in for
the OpenRouter call (no network in tests, ever). Exercises the incremental-cache behavior
that's the whole point of keying extraction by content hash: unchanged papers must not be
re-"extracted" on a second build."""
from __future__ import annotations

from app import graph, graph_store, sessions, store

from tests.conftest import add_paper


def fake_extractor(calls: list[str]):
    """Returns an extract_fn that records which slugs it was actually called for, and
    returns a fixed reference so tests can assert on the resulting graph shape."""
    def _extract(slug: str, title: str, full_text: str, model: str) -> dict:
        calls.append(slug)
        return {
            "slug": slug, "content_hash": graph_store.content_hash(full_text),
            "extracted_at": "2026-01-01T00:00:00+00:00", "model": model, "status": "done",
            "references": [{"index": 1, "title": "An External Foundation Paper",
                            "arxiv_id": "1234.5678", "significant": True,
                            "significance_reason": "used as the baseline"}],
            "error": "",
        }
    return _extract


def test_build_graph_yields_lifecycle_events_and_persists(temp_project):
    add_paper(temp_project, "a", "Paper A", full_text="A's full text with references.")
    add_paper(temp_project, "b", "Paper B", full_text="B's full text with references.")
    papers = store.list_papers(sessions.session_states())

    calls: list[str] = []
    events = list(graph.build_graph(papers, extract_fn=fake_extractor(calls)))

    assert events[0]["type"] == "start"
    assert events[0]["total"] == 2
    assert events[-1]["type"] == "done"
    assert sorted(calls) == ["a", "b"]  # both papers extracted on a fresh build

    final = events[-1]
    skeleton = next(event for event in events if event["type"] == "skeleton")
    assert skeleton["graph"]["stage"] == "skeleton"
    assert skeleton["graph"]["completeness"]["analyzed_papers"] == 0
    assert final["graph"]["stage"] == "enriched"
    assert skeleton["graph"]["revision"] != final["graph"]["revision"]
    assert final["graph"]["completeness"]["analyzed_papers"] == 2
    assert final["graph"]["completeness"]["full_text_edges"] == 2
    assert final["graph"]["nodes"]
    assert any(n["kind"] == "external" for n in final["graph"]["nodes"])
    assert len(final["recommendations"]) == 1
    assert final["recommendations"][0]["cited_by_project_count"] == 2

    # Persisted to disk correctly (round-trips through JSON).
    reloaded = graph_store.load()
    assert reloaded["graph"]["nodes"]
    assert reloaded["papers"]["a"]["status"] == "done"


def test_unchanged_paper_is_not_reextracted_on_second_build(temp_project):
    add_paper(temp_project, "a", "Paper A", full_text="Stable text.")
    papers = store.list_papers(sessions.session_states())

    calls1: list[str] = []
    list(graph.build_graph(papers, extract_fn=fake_extractor(calls1)))
    assert calls1 == ["a"]

    calls2: list[str] = []
    list(graph.build_graph(papers, extract_fn=fake_extractor(calls2)))
    assert calls2 == []  # content hash unchanged -> served entirely from cache, zero LLM calls


def test_changed_paper_content_triggers_reextraction_of_only_that_paper(temp_project):
    add_paper(temp_project, "a", "Paper A", full_text="Version one.")
    add_paper(temp_project, "b", "Paper B", full_text="Never changes.")
    papers = store.list_papers(sessions.session_states())

    list(graph.build_graph(papers, extract_fn=fake_extractor([])))

    store.write_full_text("a", "Paper A", "Version two, materially different.", {"slug": "a"})
    papers = store.list_papers(sessions.session_states())  # re-list (paper.retrieved etc.)

    calls: list[str] = []
    list(graph.build_graph(papers, extract_fn=fake_extractor(calls)))
    assert calls == ["a"]  # only the changed paper re-extracted; b served from cache


def test_force_rebuild_reextracts_every_paper(temp_project):
    add_paper(temp_project, "a", "Paper A", full_text="Text.")
    add_paper(temp_project, "b", "Paper B", full_text="Text.")
    papers = store.list_papers(sessions.session_states())

    list(graph.build_graph(papers, extract_fn=fake_extractor([])))
    calls: list[str] = []
    list(graph.build_graph(papers, force=True, extract_fn=fake_extractor(calls)))
    assert sorted(calls) == ["a", "b"]


def test_errored_extraction_is_retried_on_next_build(temp_project):
    add_paper(temp_project, "a", "Paper A", full_text="Text.")
    papers = store.list_papers(sessions.session_states())

    def failing(slug, title, full_text, model):
        return {"slug": slug, "content_hash": graph_store.content_hash(full_text),
                "extracted_at": "t", "model": model, "status": "error",
                "references": [], "error": "boom"}

    list(graph.build_graph(papers, extract_fn=failing))
    calls: list[str] = []
    list(graph.build_graph(papers, extract_fn=fake_extractor(calls)))
    assert calls == ["a"]  # a prior error is not treated as a valid cache hit


def test_interrupted_build_persists_completed_papers(temp_project):
    # Extraction is a real, possibly slow network call per paper; a build over many papers
    # can be interrupted (client disconnect, server restart, killed request) partway through.
    # Only consuming part of the generator simulates that -- the "done" event (and its final
    # save) is never reached, so this proves per-paper saves are what persisted, not the
    # final one. Since R7.11 extraction fans out over a pool, so 'b'/'c' are deliberately
    # STALLED (never completing) while 'a' finishes -- close() must persist 'a', orphan the
    # stalled calls without blocking, and a resume re-spends only 'b' and 'c'.
    import threading

    add_paper(temp_project, "a", "Paper A", full_text="Text A.")
    add_paper(temp_project, "b", "Paper B", full_text="Text B.")
    add_paper(temp_project, "c", "Paper C", full_text="Text C.")
    papers = store.list_papers(sessions.session_states())

    release = threading.Event()
    base = fake_extractor(calls := [])

    def stalling_extract(slug, title, full_text, model):
        if slug != "a":
            release.wait(timeout=10)  # orphaned after close(); released below
        return base(slug, title, full_text, model)

    gen = graph.build_graph(papers, extract_fn=stalling_extract)
    while next(gen)["type"] != "progress":  # 'a' is the only extraction that can complete
        pass
    gen.close()  # must NOT block on the stalled 'b'/'c' workers
    release.set()

    assert "a" in calls
    reloaded = graph_store.load()
    assert reloaded["papers"]["a"]["status"] == "done"
    assert "b" not in reloaded["papers"]
    assert reloaded["graph"]["stage"] == "skeleton"
    assert reloaded["graph"]["completeness"]["analyzed_papers"] == 0

    # Resuming should pick up right where it left off: 'a' is cached, 'b' and 'c' still run.
    resume_calls: list[str] = []
    list(graph.build_graph(papers, extract_fn=fake_extractor(resume_calls)))
    assert sorted(resume_calls) == ["b", "c"]


def test_status_reports_stale_and_missing_text(temp_project):
    add_paper(temp_project, "a", "Paper A", full_text="Text.")
    papers = store.list_papers(sessions.session_states())

    st = graph.status(papers)
    assert st["has_graph"] is False
    assert st["stale_papers"] == ["a"]  # never extracted yet

    list(graph.build_graph(papers, extract_fn=fake_extractor([])))
    papers = store.list_papers(sessions.session_states())
    st = graph.status(papers)
    assert st["has_graph"] is True
    assert st["graph_stage"] == "enriched"
    assert st["graph_completeness"]["analyzed_papers"] == 1
    assert st["stale_papers"] == []


def test_status_flags_a_paper_absent_from_a_built_graph(temp_project):
    """A paper present in the project but with NO node in the existing built graph is stale —
    even when its extraction cache is fresh (the R9.13 move copies a paper's extraction, so
    the moved paper looks up to date but isn't in the destination's snapshot)."""
    from app import graph_store

    add_paper(temp_project, "a", "Paper A", full_text="Text A.")
    papers = store.list_papers(sessions.session_states())
    list(graph.build_graph(papers, extract_fn=fake_extractor([])))
    assert graph.status(store.list_papers(sessions.session_states()))["stale_papers"] == []

    # Simulate a moved-in paper: a reading-list entry + corpus + a FRESH extraction cache,
    # but no node in the already-built graph.
    add_paper(temp_project, "b", "Paper B", full_text="Text B.")
    data = graph_store.load()
    graph_store.set_paper_extraction(data, "b", {
        "slug": "b", "status": "done", "references": [],
        "content_hash": graph_store.content_hash("Text B."),
    })
    graph_store.save(data)

    st = graph.status(store.list_papers(sessions.session_states()))
    assert st["has_graph"] is True
    assert "b" in st["stale_papers"]  # missing from the snapshot ⇒ rebuild affordance lights
    assert "a" not in st["stale_papers"]


def test_interrupted_cached_rebuild_marks_skeleton_for_resume(temp_project):
    add_paper(temp_project, "a", "Paper A", full_text="Stable text.")
    papers = store.list_papers(sessions.session_states())
    list(graph.build_graph(papers, extract_fn=fake_extractor([])))

    interrupted = graph.build_graph(papers, extract_fn=fake_extractor([]))
    for event in interrupted:
        if event["type"] == "skeleton":
            break
    interrupted.close()  # simulate a server restart losing the in-memory job

    st = graph.status(papers)
    assert st["stale_papers"] == []  # caches alone would not light the old rebuild affordance
    assert st["graph_stage"] == "skeleton"
    assert st["graph_needs_enrichment"] is True
    assert st["graph_revision"]


def test_papers_without_cached_full_text_are_skipped_not_errored(temp_project):
    # A paper with no corpus file yet (never "started") shouldn't block or crash the build.
    rl = store._reading_list()
    rl.write_text(rl.read_text(encoding="utf-8") + "\n**Unretrieved Paper** — *unread*\n",
                  encoding="utf-8")
    papers = store.list_papers(sessions.session_states())
    assert any(not p.retrieved for p in papers)

    events = list(graph.build_graph(papers, extract_fn=fake_extractor([])))
    assert events[0]["total"] == 1
    assert events[0]["ready"] == 0  # total project papers and analyzable papers stay distinct
    st = graph.status(papers)
    assert st["missing_text_papers"] == [store.derive_slug("Unretrieved Paper")]


def test_skeleton_snapshot_uses_cached_citation_counts(temp_project):
    """U.8 round-2 fix: the fast skeleton is published without network fetches, but it must
    still apply citation counts the cache ALREADY knows — otherwise the whole skeleton lays
    out in the unranked band while stamped with the semantic layout marker."""
    add_paper(temp_project, "a", "Paper A", full_text="A's full text with references.")
    papers = store.list_papers(sessions.session_states())

    # Seed the persisted citation cache before the build (as a prior enriched build would).
    data = graph_store.load()
    data["citations"]["a"] = 1234
    graph_store.save(data)

    events = list(graph.build_graph(papers, extract_fn=fake_extractor([])))
    skeleton = next(event for event in events if event["type"] == "skeleton")
    node_a = next(n for n in skeleton["graph"]["nodes"] if n["id"] == "a")
    assert node_a["citation_count"] == 1234
    assert skeleton["graph"]["layout"]["algo"] == "semantic-v2"
