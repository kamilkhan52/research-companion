"""DR-060 — the in-app device-test companion. Dev-gated routes over the ledger and the
feedback inbox; the app records, the /device-feedback skill triages into the ledger."""
from __future__ import annotations

import base64

import pytest
from app import config
from app.routers import devtest
from starlette.testclient import TestClient


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("RC_DEVTEST_DIR", str(tmp_path / "inbox"))
    monkeypatch.setattr(config, "dev_mode", lambda: True)
    from app.main import app

    return TestClient(app)


LEDGER_SAMPLE = """# Device-review feedback ledger

| ID | Raised | Feedback / acceptance | State | Evidence / next action |
|---|---|---|---|---|
| DR-001 | 2026-07-21 | Notes must show progress. | `implemented — verify` | Verify both densities. |
| DR-058 | 2026-08-11 | One paper changes the notes too much. | `open` | Kamil's design: a change plan first. |
| DR-013 | 2026-07-21 | Canonical pass reuse. | `closed` | Device-confirmed. |
"""


def test_every_route_is_absent_outside_dev(tmp_path, monkeypatch):
    """ALL five routes, not a sample: the first cut gated two in test, and deleting the guard
    from the other three left the whole suite green — the only thing between production and
    this surface was uncovered."""
    monkeypatch.setenv("RC_DEVTEST_DIR", str(tmp_path / "inbox"))
    monkeypatch.setattr(config, "dev_mode", lambda: False)
    from app.main import app

    c = TestClient(app)
    assert c.get("/api/devtest/items").status_code == 404
    assert c.post("/api/devtest/items", json={"title": "x"}).status_code == 404
    assert c.post("/api/devtest/feedback",
                  json={"item_id": "DR-001", "verdict": "pass"}).status_code == 404
    assert c.get("/api/devtest/feedback").status_code == 404
    assert c.get("/api/devtest/status").status_code == 404


def test_ledger_rows_parse_with_state_and_test_instructions():
    items = devtest.parse_ledger(LEDGER_SAMPLE)
    assert [i["id"] for i in items] == ["DR-001", "DR-058", "DR-013"]
    assert items[0]["state"] == "implemented — verify"
    assert "Verify both densities" in items[0]["how_to_test"]
    assert items[2]["state"] == "closed"


def test_items_merge_untriaged_new_items(client):
    created = client.post("/api/devtest/items",
                          json={"title": "Composer clips on fold", "description": "Open composer"})
    assert created.status_code == 200
    new_id = created.json()["item"]["id"]
    assert new_id.startswith("NEW-")
    items = client.get("/api/devtest/items").json()["items"]
    mine = next(i for i in items if i["id"] == new_id)
    assert mine["state"] == "new — untriaged"
    assert mine["how_to_test"] == "Open composer"


def test_feedback_roundtrip_with_screenshot(client, tmp_path):
    png = base64.b64encode(b"\x89PNG\r\n\x1a\n fake").decode()
    r = client.post("/api/devtest/feedback", json={
        "item_id": "DR-001", "verdict": "fail", "comment": "Bar overlaps in Black theme",
        "route": "/paper/awq", "screenshot_b64": png,
    })
    assert r.status_code == 200
    entry = r.json()["entry"]
    assert entry["screenshot"].startswith(".dev-feedback/screenshots/")
    # The bytes landed where the entry points (relative to the inbox dir override).
    shot = tmp_path / "inbox" / "screenshots" / entry["screenshot"].split("/")[-1]
    assert shot.read_bytes() == b"\x89PNG\r\n\x1a\n fake"

    listed = client.get("/api/devtest/feedback", params={"item_id": "DR-001"}).json()["entries"]
    assert listed[-1]["comment"] == "Bar overlaps in Black theme"
    assert listed[-1]["route"] == "/paper/awq"

    # Pending count reflects the untriaged inbox; the skill's cursor drains it.
    assert client.get("/api/devtest/status").json()["pending"] >= 1
    devtest.mark_processed_through("2999-01-01T00:00:00")
    assert client.get("/api/devtest/status").json()["pending"] == 0


def test_remark_requires_a_comment_and_verdicts_are_closed(client):
    assert client.post("/api/devtest/feedback",
                       json={"item_id": "DR-001", "verdict": "remark"}).status_code == 400
    assert client.post("/api/devtest/feedback",
                       json={"item_id": "DR-001", "verdict": "maybe"}).status_code == 400
    # Pass with no comment is the quick path and is fine.
    assert client.post("/api/devtest/feedback",
                       json={"item_id": "DR-001", "verdict": "pass"}).status_code == 200


def test_a_bad_screenshot_never_discards_the_verdict(client, tmp_path):
    """The comment is the reader's typed input; a broken IMAGE must record the entry anyway,
    with the reason in its place — the first cut 400ed and lost both."""
    for payload in ("not-base64!!!",
                    base64.b64encode(b"#!/bin/sh not an image").decode(),
                    "A" * (9_000_000)):
        r = client.post("/api/devtest/feedback", json={
            "item_id": "DR-001", "verdict": "fail", "comment": "precious words",
            "screenshot_b64": payload,
        })
        assert r.status_code == 200
        assert r.json()["entry"]["screenshot"] is None
        assert r.json()["entry"]["screenshot_error"]
    assert not list((tmp_path / "inbox" / "screenshots").glob("*"))
    entries = client.get("/api/devtest/feedback").json()["entries"]
    assert all(e["comment"] == "precious words" for e in entries)


def test_same_second_screenshots_do_not_collide(client, tmp_path):
    png = base64.b64encode(b"\x89PNG\r\n\x1a\n bytes").decode()
    paths = set()
    for _ in range(3):
        r = client.post("/api/devtest/feedback", json={
            "item_id": "DR-001", "verdict": "remark", "comment": "x",
            "screenshot_b64": png,
        })
        paths.add(r.json()["entry"]["screenshot"])
    assert len(paths) == 3  # a shared name would point one entry at another's pixels


def test_line_separator_characters_cannot_swallow_an_entry(client):
    """U+2028 is a line separator to str.splitlines(): written raw, one entry became several
    unreadable fragments and a 200 silently lost the input."""
    r = client.post("/api/devtest/feedback", json={
        "item_id": "DR-001", "verdict": "remark", "comment": "before\u2028after",
    })
    assert r.status_code == 200
    entries = client.get("/api/devtest/feedback").json()["entries"]
    assert entries[-1]["comment"] == "before\u2028after"


def test_the_inbox_survives_a_real_torn_write(client, tmp_path):
    """A genuine torn append ends mid-line with NO trailing newline. The first version of this
    test appended a newline-terminated fragment — a shape torn writes never produce — and
    passed while the real case welded the next entry onto the fragment and lost both."""
    client.post("/api/devtest/feedback", json={"item_id": "DR-001", "verdict": "pass"})
    p = tmp_path / "inbox" / "feedback.jsonl"
    with p.open("ab") as f:
        f.write(b'{"torn": ')   # no newline — the crash happened mid-write
    client.post("/api/devtest/feedback", json={"item_id": "DR-002", "verdict": "pass"})
    entries = client.get("/api/devtest/feedback").json()["entries"]
    assert [e["item_id"] for e in entries] == ["DR-001", "DR-002"]


def test_agent_responses_interleave_with_feedback_and_are_counted(client):
    """DR-080: the triage skill's `append_response` entries must reach the phone — both in the
    item's history (interleaved, in ts order, distinguishable by kind) and as a per-item count
    on the items list so the card can show a reply exists before the history is opened."""
    client.post("/api/devtest/feedback", json={"item_id": "DR-058", "verdict": "fail",
                                               "comment": "the plan never appears"})
    devtest.append_response("DR-058", "Root-caused: the plan step 404s. **Fixed in PR #999** — "
                                      "please re-test and pass this row.")
    client.post("/api/devtest/feedback", json={"item_id": "DR-058", "verdict": "remark",
                                               "comment": "will retest tonight"})

    entries = client.get("/api/devtest/feedback",
                         params={"item_id": "DR-058"}).json()["entries"]
    kinds = [e.get("kind") for e in entries]
    assert kinds == ["feedback", "response", "feedback"]
    assert "Fixed in PR #999" in entries[1]["text"]

    items = client.get("/api/devtest/items").json()["items"]
    row = next(i for i in items if i["id"] == "DR-058")
    assert row["response_count"] == 1
    assert row["feedback_count"] == 2

    # A response is agent-authored, never HTTP-authored: the POST body has no way to mint one
    # (verdict is a closed set), and empty inputs are refused at the helper.
    with pytest.raises(ValueError):
        devtest.append_response("DR-058", "   ")
    with pytest.raises(ValueError):
        devtest.append_response("", "text")


def test_new_item_ids_never_touch_the_ledger(client):
    """The app writes the inbox only — the ledger is the agent's to edit (the same
    agent-proposes boundary as everywhere else)."""
    before = devtest._LEDGER.read_text(encoding="utf-8")
    client.post("/api/devtest/items", json={"title": "Something new"})
    client.post("/api/devtest/feedback", json={"item_id": "DR-001", "verdict": "fail",
                                               "comment": "x"})
    assert devtest._LEDGER.read_text(encoding="utf-8") == before
