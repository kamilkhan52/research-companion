"""The corpus-neighbourhood substrate module (DR-052 PR 1): anchor resolution marks its
changes for the merge-on-save path, and the forward citer sets accumulate per anchor.

The provider-metadata phase itself is exercised through graph.build_graph's existing suite
(tests/test_graph_metadata.py) — moving it into neighbourhood.provider_metadata_events was
behavior-identical by construction, and those tests passing unchanged is the proof.
"""
from __future__ import annotations

import httpx
from app import graph_store, neighbourhood


class _Paper:
    def __init__(self, slug, arxiv_id=None, title=""):
        self.slug, self.arxiv_id, self.title = slug, arxiv_id, title


def _client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler), base_url="https://x")


def test_ensure_anchors_marks_dirty_only_when_the_cache_changed(temp_project):
    data = graph_store.load()
    data["openalex_anchors"]["p1"] = {
        "openalex_id": "https://openalex.org/W1", "topics": [{"id": "T1"}],
    }

    def handler(request):  # a fully cached project must not need the network at all
        raise AssertionError("cached anchor resolution must not hit the network")

    client = _client(handler)
    anchors = neighbourhood.ensure_anchors([_Paper("p1", "2401.00001")], data, client=client)
    client.close()
    assert len(anchors) == 1
    assert not graph_store.pending_changes(data)

    def resolving(request):
        return httpx.Response(200, json={"id": "https://openalex.org/W2"})

    client = _client(resolving)
    neighbourhood.ensure_anchors(
        [_Paper("p1", "2401.00001"), _Paper("p2", "2402.00002")], data, client=client)
    client.close()
    assert graph_store.pending_changes(data)  # a newly resolved anchor is a real change


def test_forward_sweep_groups_citers_by_anchor_and_accumulates(temp_project):
    data = graph_store.load()
    chase = [
        {"openalex_id": "https://openalex.org/W10",
         "provenance": [{"channel": "cites", "anchor_slug": "paper-a"}]},
        {"openalex_id": "https://openalex.org/W11",
         "provenance": [{"channel": "cites", "anchor_slug": "paper-a"}]},
        {"openalex_id": "https://openalex.org/W12",
         "provenance": [{"channel": "cites", "anchor_slug": "paper-b"}]},
        # a lane that isn't the citation chase must not pollute the citer sets
        {"openalex_id": "https://openalex.org/W13",
         "provenance": [{"channel": "topic", "anchor_slug": "paper-a"}]},
        {"openalex_id": "", "provenance": [{"channel": "cites", "anchor_slug": "paper-a"}]},
    ]
    neighbourhood.record_forward_sweep(data, chase)

    a = graph_store.get_forward(data, "paper-a")
    assert a["citers"] == ["W10", "W11"]
    assert a["complete"] is False
    assert graph_store.get_forward(data, "paper-b")["citers"] == ["W12"]
    assert graph_store.pending_changes(data)

    # A later chase ACCUMULATES: a citer once seen is never forgotten, and a chase that finds
    # only already-known citers writes nothing (no save, no swept_at churn).
    swept = a["swept_at"]
    neighbourhood.record_forward_sweep(data, [
        {"openalex_id": "https://openalex.org/W10",
         "provenance": [{"channel": "cites", "anchor_slug": "paper-a"}]},
    ])
    assert graph_store.get_forward(data, "paper-a")["citers"] == ["W10", "W11"]
    assert graph_store.get_forward(data, "paper-a")["swept_at"] == swept

    neighbourhood.record_forward_sweep(data, [
        {"openalex_id": "https://openalex.org/W14",
         "provenance": [{"channel": "cites", "anchor_slug": "paper-a"}]},
    ])
    assert graph_store.get_forward(data, "paper-a")["citers"] == ["W10", "W11", "W14"]


def test_forward_sweep_survives_a_concurrent_build_save(temp_project):
    """End-to-end shape of the write race: Discovery records citer sets on its copy while a
    build saves extractions from another copy; both must reach disk."""
    build = graph_store.load()
    discovery = graph_store.load()

    graph_store.set_paper_extraction(build, "paper-a", {"status": "done", "references": []})
    graph_store.save(build)

    neighbourhood.record_forward_sweep(discovery, [
        {"openalex_id": "https://openalex.org/W10",
         "provenance": [{"channel": "cites", "anchor_slug": "paper-a"}]},
    ])
    graph_store.save(discovery)

    on_disk = graph_store.load()
    assert on_disk["papers"]["paper-a"]["status"] == "done"
    assert graph_store.get_forward(on_disk, "paper-a")["citers"] == ["W10"]


def test_two_overlapping_runs_each_keep_the_anchors_they_resolved(temp_project):
    """Anchor marks are PER SLUG, not whole-section. Two discovery runs can overlap on one
    project (the discovery dedup key is per user scope, not bare pid), and PR 2 adds the
    neighbourhood job as a second writer by design — a whole-section mark would make the
    later save erase every anchor the earlier one resolved."""
    first = graph_store.load()
    second = graph_store.load()

    def responder(work_id):
        def handler(request):
            return httpx.Response(200, json={"id": f"https://openalex.org/{work_id}"})
        return handler

    client = _client(responder("W1"))
    neighbourhood.ensure_anchors([_Paper("p1", "2401.00001")], first, client=client)
    client.close()
    client = _client(responder("W2"))
    neighbourhood.ensure_anchors([_Paper("p2", "2402.00002")], second, client=client)
    client.close()

    graph_store.save(first)
    graph_store.save(second)

    anchors = graph_store.load()["openalex_anchors"]
    assert set(anchors) == {"p1", "p2"}
    assert anchors["p1"]["openalex_id"].endswith("W1")
    assert anchors["p2"]["openalex_id"].endswith("W2")


def test_substrate_timestamps_keep_the_graph_builds_second_precision(temp_project):
    """The provider-metadata phase moved modules, and its timestamps land in the same stored
    records `graph` wrote before the move — so the precision has to match, or a
    behavior-identical refactor quietly changes the shape of persisted data. (A direct
    `graph._now` import would cycle, so the two are pinned equal here instead.)"""
    from app import graph

    assert len(neighbourhood._now()) == len(graph._now())
    assert "." not in neighbourhood._now()  # no microseconds


# --- shared freshness status (DR-052 PR 4) ---------------------------------------------------

def _swept(data, slug, *, s2=None, oa=None):
    rec = {}
    if s2:
        rec["s2_swept_at"] = s2
    if oa:
        rec["swept_at"] = oa
    graph_store.set_forward_sweep(data, slug, rec)


def test_status_reports_freshness_and_the_two_kinds_of_stale(temp_project):
    from datetime import UTC, datetime, timedelta

    data = graph_store.load()
    recent = (datetime.now(UTC) - timedelta(hours=2)).isoformat()
    old = (datetime.now(UTC) - timedelta(days=30)).isoformat()
    _swept(data, "paper-a", s2=recent)
    _swept(data, "paper-b", oa=old)          # older; last_swept is the max across anchors

    papers = [_Paper("paper-a"), _Paper("paper-b"), _Paper("paper-c")]  # c never swept
    st = neighbourhood.status(papers, data)
    assert st["monitored"] == 2 and st["total_papers"] == 3
    assert st["composition_stale"] == 1      # paper-c added since the last sweep
    assert st["last_swept"] == recent        # newest wins
    assert st["ever_swept"] is True
    assert st["time_stale"] is False         # 2h < a week
    assert st["age_seconds"] is not None and st["age_seconds"] < 3 * 3600


def test_status_flags_time_stale_past_the_cadence(temp_project):
    from datetime import UTC, datetime, timedelta

    data = graph_store.load()
    _swept(data, "paper-a", s2=(datetime.now(UTC) - timedelta(days=10)).isoformat())
    st = neighbourhood.status([_Paper("paper-a")], data)
    assert st["time_stale"] is True


def test_status_never_built_is_not_stale(temp_project):
    """DR-046: an absent neighbourhood must read as 'not built', an offer — never as stale/loss."""
    st = neighbourhood.status([_Paper("paper-a"), _Paper("paper-b")], graph_store.load())
    assert st["ever_swept"] is False
    assert st["time_stale"] is False
    assert st["last_swept"] is None and st["age_seconds"] is None
    assert st["monitored"] == 0 and st["composition_stale"] == 2
