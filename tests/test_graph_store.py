"""graph_store: pure JSON persistence. No LLM, no network."""
from __future__ import annotations

from app import config, graph_store


def test_content_hash_is_stable_and_sensitive_to_change():
    a = graph_store.content_hash("hello world")
    b = graph_store.content_hash("hello world")
    c = graph_store.content_hash("hello world!")
    assert a == b
    assert a != c


def test_content_hash_handles_none_and_empty():
    assert graph_store.content_hash(None) == graph_store.content_hash("")


def test_load_returns_empty_shape_when_no_file(temp_project):
    data = graph_store.load()
    assert data["papers"] == {}
    assert data["graph"] is None
    assert data["recommendations"] is None
    assert data["version"] == graph_store.GRAPH_VERSION


def test_save_and_load_round_trip(temp_project):
    data = graph_store.load()
    graph_store.set_paper_extraction(data, "a", {"status": "done", "references": []})
    graph_store.set_graph(data, {"built_at": "t", "model": "m", "nodes": [], "edges": []})
    graph_store.set_recommendations(data, [{"id": "ext:x", "recommend_score": 1.0}])
    graph_store.save(data)

    reloaded = graph_store.load()
    assert reloaded["papers"]["a"]["status"] == "done"
    assert reloaded["graph"]["model"] == "m"
    assert reloaded["recommendations"][0]["id"] == "ext:x"


def test_load_resets_on_version_mismatch(temp_project):
    data = graph_store.load()
    graph_store.set_paper_extraction(data, "a", {"status": "done", "references": []})
    graph_store.save(data)

    corrupted = graph_store.load()
    corrupted["version"] = -1
    graph_store._file().write_text(__import__("json").dumps(corrupted), encoding="utf-8")

    fresh = graph_store.load()
    assert fresh["papers"] == {}  # stale schema is dropped rather than risking bad reads


def test_load_handles_corrupt_json_gracefully(temp_project):
    graph_store._file().parent.mkdir(parents=True, exist_ok=True)
    graph_store._file().write_text("{not valid json", encoding="utf-8")
    data = graph_store.load()
    assert data["papers"] == {}


def test_provider_metadata_roundtrips_independently(temp_project):
    data = graph_store.load()
    graph_store.set_provider_paper(
        data,
        "semantic_scholar",
        "paper-a",
        {"status": "done", "source_key": "ARXIV:2401.00001", "references": []},
    )
    graph_store.save(data)

    reloaded = graph_store.load()
    assert graph_store.get_provider_paper(
        reloaded, "semantic_scholar", "paper-a"
    )["source_key"] == "ARXIV:2401.00001"
    assert reloaded["papers"] == {}


# ---------- concurrent writers: dirty-tracked merge-on-save (DR-052 PR 1) ----------

def test_save_bumps_store_revision_monotonically(temp_project):
    data = graph_store.load()
    assert data["store_revision"] == 0
    graph_store.set_paper_extraction(data, "a", {"status": "done", "references": []})
    graph_store.save(data)
    first = graph_store.load()["store_revision"]
    graph_store.save(data)
    second = graph_store.load()["store_revision"]
    assert first >= 1
    assert second > first


def test_interleaved_writers_both_survive(temp_project):
    """THE race this revision work exists to close: a graph build and a Discovery run each hold
    their own loaded copy and save at different times. Before merge-on-save, whichever saved
    last clobbered the other's section wholesale — a paid extraction record or the anchor
    cache, lost by write order."""
    build = graph_store.load()      # the build loads first…
    discovery = graph_store.load()  # …then a Discovery run loads its own copy

    graph_store.set_paper_extraction(build, "paper-a", {"status": "done", "references": []})
    graph_store.save(build)         # the build persists an expensive extraction

    discovery["openalex_anchors"]["paper-b"] = {"openalex_id": "https://openalex.org/W7"}
    graph_store.mark_dirty(discovery, "openalex_anchors")
    graph_store.save(discovery)     # discovery saves its stale copy afterwards

    on_disk = graph_store.load()
    assert on_disk["papers"]["paper-a"]["status"] == "done"       # not clobbered
    assert on_disk["openalex_anchors"]["paper-b"]["openalex_id"].endswith("W7")

    # And in the other order: the build saves again from its own (anchor-less) copy — the
    # anchors must survive that too, because the build only owns what it marked.
    graph_store.set_paper_extraction(build, "paper-c", {"status": "done", "references": []})
    graph_store.save(build)
    on_disk = graph_store.load()
    assert on_disk["openalex_anchors"]["paper-b"]["openalex_id"].endswith("W7")
    assert on_disk["papers"]["paper-c"]["status"] == "done"


def test_a_document_with_no_recorded_changes_saves_wholesale(temp_project):
    """Deletion-by-pop writers (project_split) rely on wholesale semantics: a per-key merge
    cannot express a removed entry, so a save with nothing marked must replace the file."""
    data = graph_store.load()
    graph_store.set_paper_extraction(data, "a", {"status": "done", "references": []})
    graph_store.set_paper_extraction(data, "b", {"status": "done", "references": []})
    graph_store.save(data)

    fresh = graph_store.load()  # a new document: no dirty bookkeeping
    fresh["papers"].pop("a")
    graph_store.save(fresh)

    assert set(graph_store.load()["papers"]) == {"b"}


def test_forward_sweep_roundtrip_and_merge_isolation(temp_project):
    data = graph_store.load()
    graph_store.set_forward_sweep(
        data, "paper-a",
        {"citers": ["W1", "W2"], "swept_at": "t", "complete": False, "source": "openalex"},
    )
    graph_store.save(data)

    other = graph_store.load()
    graph_store.set_forward_sweep(
        other, "paper-b",
        {"citers": ["W9"], "swept_at": "t", "complete": False, "source": "openalex"},
    )
    graph_store.save(other)

    on_disk = graph_store.load()
    assert graph_store.get_forward(on_disk, "paper-a")["citers"] == ["W1", "W2"]
    assert graph_store.get_forward(on_disk, "paper-b")["citers"] == ["W9"]


def test_dirty_bookkeeping_never_reaches_disk(temp_project):
    data = graph_store.load()
    graph_store.set_graph(data, {"built_at": "t", "model": "m", "nodes": [], "edges": []})
    graph_store.save(data)
    raw = __import__("json").loads(graph_store._file().read_text(encoding="utf-8"))
    assert not any(key.startswith("_") for key in raw)


def test_two_writers_of_the_SAME_section_each_keep_their_own_key(temp_project):
    """The per-key merge, pinned properly: both copies are loaded BEFORE either saves, so
    neither contains the other's key. A merge that replaced the whole keyed section would
    pass the interleaved test above (its second writer loaded after the first saved) and
    fail here."""
    first = graph_store.load()
    second = graph_store.load()

    graph_store.set_paper_extraction(first, "paper-a", {"status": "done", "references": []})
    graph_store.set_paper_extraction(second, "paper-b", {"status": "done", "references": []})
    graph_store.save(first)
    graph_store.save(second)

    assert set(graph_store.load()["papers"]) == {"paper-a", "paper-b"}


def test_a_merged_save_does_not_claim_the_callers_copy_is_current(temp_project):
    """A merged save leaves the caller holding a document without the other writer's
    sections. Stamping it with the file's revision would make the freshness compare the
    counter exists for answer "current" for a stale copy."""
    build = graph_store.load()
    other = graph_store.load()
    other["citations"]["node-1"] = 42
    graph_store.mark_dirty(other, "citations")
    graph_store.save(other)

    graph_store.set_paper_extraction(build, "paper-a", {"status": "done", "references": []})
    graph_store.save(build)

    assert build["store_revision"] < graph_store.load()["store_revision"]
    assert build.get("citations") == {}  # it really is missing the other writer's section


def test_a_reset_file_does_not_swallow_a_live_writers_unmarked_sections(temp_project):
    """A version bump or a wiped .state/ mid-build makes the disk read come back empty. The
    merge must not then write only the marked entries and drop everything else the writer is
    holding — the wholesale write it replaced kept the lot."""
    seed = graph_store.load()
    seed["citations"]["node-1"] = 42
    graph_store.mark_dirty(seed, "citations")
    graph_store.save(seed)

    build = graph_store.load()                      # holds citations
    graph_store._file().unlink()                    # …and the file disappears under it
    graph_store.set_paper_extraction(build, "paper-a", {"status": "done", "references": []})
    graph_store.save(build)

    on_disk = graph_store.load()
    assert on_disk["papers"]["paper-a"]["status"] == "done"
    assert on_disk["citations"] == {"node-1": 42}


def test_a_stale_wholesale_save_cannot_move_the_revision_backwards(temp_project):
    stale = graph_store.load()          # revision 0
    for _ in range(3):
        fresh = graph_store.load()
        graph_store.set_paper_extraction(fresh, "a", {"status": "done", "references": []})
        graph_store.save(fresh)
    high = graph_store.load()["store_revision"]

    graph_store.save(stale)             # no marks: the wholesale path, from an old copy
    assert graph_store.load()["store_revision"] > high


def test_concurrent_saves_serialize_without_losing_an_entry(temp_project):
    """The lock makes load-merge-write atomic in-process; every racing writer's own key must
    survive and the counter must advance exactly once per save."""
    import threading

    pid = config.active_project_id()
    docs = [graph_store.load() for _ in range(8)]
    for n, doc in enumerate(docs):
        graph_store.set_paper_extraction(doc, f"paper-{n}", {"status": "done", "references": []})

    def writer(doc):
        # Invariant 2: a thread inherits no contextvar, so without this the save lands in the
        # wrong project and the assertions below read an empty file.
        token = config.set_active_project(pid)
        try:
            graph_store.save(doc)
        finally:
            config.reset_active_project(token)

    threads = [threading.Thread(target=writer, args=(doc,)) for doc in docs]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    on_disk = graph_store.load()
    assert set(on_disk["papers"]) == {f"paper-{n}" for n in range(8)}
    assert on_disk["store_revision"] == 8
