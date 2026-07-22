from __future__ import annotations

import json

from app import config, graph_store, paper_metadata


def _extraction(slug: str, text: str, *, title: str = "External") -> dict:
    return {
        "slug": slug,
        "content_hash": graph_store.content_hash(text),
        "extracted_at": "2026-01-01T00:00:00+00:00",
        "model": "test",
        "status": "done",
        "references": [{"index": 1, "title": title}],
        "error": "",
    }


def test_v1_affiliations_survive_schema_upgrade(temp_project):
    path = config.state_dir() / "paper-metadata.json"
    path.write_text(json.dumps({
        "version": 1,
        "affiliations": {
            "paper": {"status": "done", "key": "text:1", "authorships": []},
        },
    }), encoding="utf-8")

    assert paper_metadata.affiliation_record("paper")["key"] == "text:1"
    paper_metadata.set_reference_record("paper", _extraction("paper", "Text"))

    upgraded = json.loads(path.read_text(encoding="utf-8"))
    assert upgraded["version"] == 2
    assert upgraded["affiliations"]["paper"]["key"] == "text:1"
    assert upgraded["references"]["paper"]["content_hash"] == graph_store.content_hash("Text")


def test_matching_legacy_graph_extraction_is_backfilled_without_extraction(temp_project):
    legacy = graph_store.load()
    graph_store.set_paper_extraction(
        legacy,
        "paper",
        _extraction("paper", "Current full text", title="Already Paid"),
    )
    graph_store.save(legacy)

    imported = paper_metadata.fresh_reference_record("paper", "Current full text")

    assert imported is not None
    assert imported["references"][0]["title"] == "Already Paid"
    assert paper_metadata.reference_record("paper") == imported


def test_stale_legacy_extraction_is_not_backfilled(temp_project):
    legacy = graph_store.load()
    graph_store.set_paper_extraction(legacy, "paper", _extraction("paper", "Old text"))
    graph_store.save(legacy)

    assert paper_metadata.fresh_reference_record("paper", "New text") is None
    assert paper_metadata.reference_record("paper") is None


def test_older_reference_result_cannot_replace_newer_fingerprint(temp_project):
    old = _extraction("paper", "Old text", title="Old")
    new = _extraction("paper", "New text", title="New")
    paper_metadata.set_reference_record("paper", {
        **new,
        "status": "pending",
        "references": [],
    })

    assert paper_metadata.set_reference_record(
        "paper",
        old,
        expected_key=old["content_hash"],
    ) is False
    assert paper_metadata.reference_record("paper")["content_hash"] == new["content_hash"]
