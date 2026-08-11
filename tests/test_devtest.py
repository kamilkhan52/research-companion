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


def test_routes_do_not_exist_outside_dev(tmp_path, monkeypatch):
    monkeypatch.setenv("RC_DEVTEST_DIR", str(tmp_path / "inbox"))
    monkeypatch.setattr(config, "dev_mode", lambda: False)
    from app.main import app

    c = TestClient(app)
    assert c.get("/api/devtest/items").status_code == 404
    assert c.post("/api/devtest/feedback", json={"item_id": "DR-001", "verdict": "pass"}).status_code == 404


def test_ledger_rows_parse_with_state_and_test_instructions():
    items = devtest.parse_ledger(LEDGER_SAMPLE)
    assert [i["id"] for i in items] == ["DR-001", "DR-058", "DR-013"]
    assert items[0]["state"] == "implemented — verify"
    assert "Verify both densities" in items[0]["how_to_test"]
    assert items[2]["state"] == "closed"


def test_items_merge_untriaged_new_items(client, monkeypatch):
    monkeypatch.setattr(devtest, "_LEDGER", devtest._LEDGER)  # real ledger parses too
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
    png = base64.b64encode(b"\x89PNG fake").decode()
    r = client.post("/api/devtest/feedback", json={
        "item_id": "DR-001", "verdict": "fail", "comment": "Bar overlaps in Black theme",
        "route": "/paper/awq", "screenshot_b64": png,
    })
    assert r.status_code == 200
    entry = r.json()["entry"]
    assert entry["screenshot"].startswith(".dev-feedback/screenshots/")
    # The bytes landed where the entry points (relative to the inbox dir override).
    shot = tmp_path / "inbox" / "screenshots" / entry["screenshot"].split("/")[-1]
    assert shot.read_bytes() == b"\x89PNG fake"

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


def test_bad_screenshots_are_refused_not_stored(client, tmp_path):
    r = client.post("/api/devtest/feedback", json={
        "item_id": "DR-001", "verdict": "fail", "screenshot_b64": "not-base64!!!",
    })
    assert r.status_code == 400
    assert not list((tmp_path / "inbox" / "screenshots").glob("*"))


def test_the_inbox_survives_a_torn_line(client, tmp_path):
    client.post("/api/devtest/feedback", json={"item_id": "DR-001", "verdict": "pass"})
    p = tmp_path / "inbox" / "feedback.jsonl"
    p.write_text(p.read_text() + '{"torn": \n', encoding="utf-8")
    client.post("/api/devtest/feedback", json={"item_id": "DR-001", "verdict": "pass"})
    entries = client.get("/api/devtest/feedback").json()["entries"]
    assert len(entries) == 2  # both good lines read; the torn one skipped, file intact


def test_new_item_ids_never_touch_the_ledger(client):
    """The app writes the inbox only — the ledger is the agent's to edit (the same
    agent-proposes boundary as everywhere else)."""
    before = devtest._LEDGER.read_text(encoding="utf-8")
    client.post("/api/devtest/items", json={"title": "Something new"})
    client.post("/api/devtest/feedback", json={"item_id": "DR-001", "verdict": "fail",
                                               "comment": "x"})
    assert devtest._LEDGER.read_text(encoding="utf-8") == before
