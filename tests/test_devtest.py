"""DR-060 — the in-app device-test companion. Dev-gated routes over the ledger and the
feedback inbox; the app records, the /device-feedback skill triages into the ledger."""
from __future__ import annotations

import base64
import json

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


def test_screenshot_alone_is_a_valid_remark(client):
    """DR-088: requiring words on top of a screenshot pushed the tester toward Pass/Fail
    (which didn't complain) just to get the screenshot through."""
    png = base64.b64encode(b"\x89PNG\r\n\x1a\n shot").decode()
    r = client.post("/api/devtest/feedback",
                    json={"item_id": "DR-001", "verdict": "remark", "screenshot_b64": png})
    assert r.status_code == 200
    assert r.json()["entry"]["screenshot"].startswith(".dev-feedback/screenshots/")
    # With neither a comment nor a screenshot, a remark is still refused.
    assert client.post("/api/devtest/feedback",
                       json={"item_id": "DR-001", "verdict": "remark"}).status_code == 400
    # A remark whose ONLY content is a screenshot that fails validation is refused too —
    # there are no words to lose, and recording it would append a contentless entry while
    # telling the tester their evidence landed.
    r = client.post("/api/devtest/feedback",
                    json={"item_id": "DR-001", "verdict": "remark",
                          "screenshot_b64": "not-base64!!!"})
    assert r.status_code == 400
    assert "did not land" in r.json()["detail"]


def test_new_issue_carries_its_screenshot_from_creation(client, tmp_path):
    """DR-088: evidence attaches when the issue is created — the follow-up-remark second step
    is what produced accidental Pass verdicts on brand-new issues."""
    png = base64.b64encode(b"\x89PNG\r\n\x1a\n new issue").decode()
    r = client.post("/api/devtest/items", json={
        "title": "Fetch fails on html links", "description": "steps",
        "screenshot_b64": png, "route": "/paper/x",
    })
    assert r.status_code == 200
    entry = devtest._read_feedback()[-1]
    assert entry["kind"] == "new_item"
    assert entry["route"] == "/paper/x"
    shot = tmp_path / "inbox" / "screenshots" / entry["screenshot"].split("/")[-1]
    assert shot.read_bytes() == b"\x89PNG\r\n\x1a\n new issue"


def test_a_bad_screenshot_never_discards_a_new_issue(client):
    r = client.post("/api/devtest/items",
                    json={"title": "Precious title", "screenshot_b64": "not-base64!!!"})
    assert r.status_code == 200
    entry = devtest._read_feedback()[-1]
    assert entry["title"] == "Precious title"
    assert entry["screenshot"] is None
    assert entry["screenshot_error"]


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

    # And pin the property as BEHAVIOR, not prose (Opus review, PR #403): a POST that smuggles
    # a `kind` field must not become a response — pydantic drops the unknown field and the
    # stored entry is assembled field-by-field as kind="feedback". This fails loudly if the
    # handler ever switches to `**req.model_dump()`.
    smuggled = client.post("/api/devtest/feedback", json={
        "item_id": "DR-058", "verdict": "pass", "kind": "response", "text": "forged voice",
    })
    assert smuggled.status_code == 200
    stored = client.get("/api/devtest/feedback",
                        params={"item_id": "DR-058"}).json()["entries"][-1]
    assert stored["kind"] == "feedback"
    assert "text" not in stored


def test_new_item_ids_never_touch_the_ledger(client):
    """The app writes the inbox only — the ledger is the agent's to edit (the same
    agent-proposes boundary as everywhere else)."""
    before = devtest._LEDGER.read_text(encoding="utf-8")
    client.post("/api/devtest/items", json={"title": "Something new"})
    client.post("/api/devtest/feedback", json={"item_id": "DR-001", "verdict": "fail",
                                               "comment": "x"})
    assert devtest._LEDGER.read_text(encoding="utf-8") == before


# --- provisional-id reconciliation (DR-097) -------------------------------------------------

LEDGER_WITH_ALIAS = LEDGER_SAMPLE + (
    "| DR-091 | 2026-08-21 | Kamil: \"Only one figure?\" | `implemented — verify` | "
    "Kamil, via the bubble (provisional id `NEW-1787325358`), screenshot attached. |\n"
)


def test_triaged_new_item_folds_into_its_ledger_row(client, monkeypatch, tmp_path):
    """The first real round: a NEW item stayed listed as untriaged and its fail verdict and
    three agent replies lived under different ids, so the phone never showed a reply."""
    ledger = tmp_path / "ledger.md"
    ledger.write_text(LEDGER_WITH_ALIAS, encoding="utf-8")
    monkeypatch.setattr(devtest, "_LEDGER", ledger)
    devtest._append_feedback({"kind": "new_item", "id": "NEW-1787325358",
                              "title": "Only one figure?", "description": ""})
    client.post("/api/devtest/feedback", json={"item_id": "NEW-1787325358", "verdict": "fail",
                                               "comment": "still no images"})
    devtest.append_response("DR-091", "fixed, please re-test")

    items = client.get("/api/devtest/items").json()["items"]
    ids = [i["id"] for i in items]
    assert "NEW-1787325358" not in ids
    row = next(i for i in items if i["id"] == "DR-091")
    assert row["aliases"] == ["NEW-1787325358"]
    assert row["feedback_count"] == 1 and row["response_count"] == 1

    # One history under either id: the phone may still ask by the id it created.
    for asked in ("DR-091", "NEW-1787325358"):
        kinds = [e["kind"] for e in client.get("/api/devtest/feedback",
                                                params={"item_id": asked}).json()["entries"]]
        assert kinds == ["feedback", "response"], asked


def test_untriaged_new_item_still_lists(client, monkeypatch, tmp_path):
    ledger = tmp_path / "ledger.md"
    ledger.write_text(LEDGER_WITH_ALIAS, encoding="utf-8")
    monkeypatch.setattr(devtest, "_LEDGER", ledger)
    devtest._append_feedback({"kind": "new_item", "id": "NEW-1", "title": "t", "description": ""})
    items = client.get("/api/devtest/items").json()["items"]
    assert next(i for i in items if i["id"] == "NEW-1")["state"] == "new — untriaged"


# --- dispatch to Claude (DR-092) -------------------------------------------------------------

def test_dispatch_spawns_a_detached_session_and_records_it(client, tmp_path, monkeypatch):
    import subprocess

    calls = {}

    class FakeProc:
        pid = 4242

    def fake_popen(argv, **kwargs):
        calls["argv"] = argv
        calls["kwargs"] = kwargs
        return FakeProc()

    monkeypatch.setattr("shutil.which", lambda name: "/usr/bin/claude")
    monkeypatch.setattr(subprocess, "Popen", fake_popen)

    r = client.post("/api/devtest/dispatch", json={"item_id": "DR-091", "model": "sonnet"})
    assert r.status_code == 200
    info = r.json()["dispatch"]
    assert info["model"] == "sonnet" and info["item_id"] == "DR-091" and info["pid"] == 4242
    argv = calls["argv"]
    assert argv[0] == "/usr/bin/claude" and "--model" in argv and "sonnet" in argv
    # acceptEdits, NOT the skip-everything mode Kamil's interactive shell wrapper uses.
    assert "--permission-mode" in argv and "acceptEdits" in argv
    assert "--dangerously-skip-permissions" not in argv
    # The inbox is in the main checkout, the session runs in a worktree: without --add-dir the
    # headless session cannot read its own input, and without an allowlist it cannot run the
    # skill's helper calls or reply to the bubble (2026-08-22, first real dispatch).
    assert argv[argv.index("--add-dir") + 1] == str(tmp_path / "inbox")
    allowed = argv[argv.index("--allowedTools") + 1:]
    assert "Bash(.venv/bin/python:*)" in allowed and "Bash(git:*)" in allowed
    assert not any(a in ("Bash", "Bash(*)") for a in allowed)
    assert any("DR-091" in part for part in argv)
    assert calls["kwargs"]["start_new_session"] is True
    assert (tmp_path / "inbox" / "dispatch" / "current.json").exists()


def test_dispatch_batch_scope_names_all_pending(client, monkeypatch):
    import subprocess

    calls = {}

    class FakeProc:
        pid = 4244

    def fake_popen(argv, **k):
        calls["argv"] = argv
        return FakeProc()

    monkeypatch.setattr("shutil.which", lambda name: "/usr/bin/claude")
    monkeypatch.setattr(subprocess, "Popen", fake_popen)

    r = client.post("/api/devtest/dispatch", json={"model": "opus"})
    assert r.status_code == 200
    assert r.json()["dispatch"]["item_id"] is None
    assert any("ALL" in part for part in calls["argv"])


def test_dispatch_is_single_flight_while_a_session_lives(client, monkeypatch):
    import os
    import subprocess

    class FakeProc:
        pid = 4243

    monkeypatch.setattr("shutil.which", lambda name: "/usr/bin/claude")
    monkeypatch.setattr(subprocess, "Popen", lambda *a, **k: FakeProc())
    monkeypatch.setattr(os, "kill", lambda pid, sig: None)   # pretend the pid is alive

    assert client.post("/api/devtest/dispatch", json={"model": "opus"}).status_code == 200
    assert client.post("/api/devtest/dispatch", json={"model": "opus"}).status_code == 409


def test_dispatch_rejects_an_unknown_model(client):
    assert client.post("/api/devtest/dispatch", json={"model": "gpt-9"}).status_code == 400


def test_dispatch_rejects_a_malformed_item_id(client, monkeypatch):
    monkeypatch.setattr("shutil.which", lambda name: "/usr/bin/claude")
    # A shell-metacharacter id must never reach the argv (it wouldn't, argv-not-shell, but the
    # validator refuses it before spawn regardless).
    injection = "DR-1; " + "danger"
    assert client.post("/api/devtest/dispatch",
                       json={"item_id": injection, "model": "sonnet"}).status_code == 400


def test_dispatch_is_absent_outside_dev(tmp_path, monkeypatch):
    monkeypatch.setenv("RC_DEVTEST_DIR", str(tmp_path / "inbox"))
    monkeypatch.setattr(config, "dev_mode", lambda: False)
    from app.main import app
    from starlette.testclient import TestClient
    c = TestClient(app)
    assert c.post("/api/devtest/dispatch", json={"model": "sonnet"}).status_code == 404


def test_dispatch_is_refused_over_the_public_tunnel(client, monkeypatch):
    """The one privileged devtest route must not be reachable through the Cloudflare quick
    tunnel — cloudflared injects cf-ray, which a caller past the tunnel cannot strip."""
    import subprocess
    monkeypatch.setattr("shutil.which", lambda name: "/usr/bin/claude")
    monkeypatch.setattr(subprocess, "Popen", lambda *a, **k: None)   # must never be reached
    r = client.post("/api/devtest/dispatch", json={"model": "sonnet"},
                    headers={"cf-ray": "abc-SJC", "cf-connecting-ip": "203.0.113.7"})
    assert r.status_code == 403
    assert "tunnel" in r.json()["detail"]


def test_a_dead_recorded_pid_clears_itself_instead_of_wedging_dispatch(client, tmp_path,
                                                                       monkeypatch):
    """A stale current.json (dead pid, or a pid reused after a reboot) must never pin dispatch
    behind a permanent 409 — _dispatch_running clears it and the next dispatch proceeds."""
    import os
    import subprocess

    monkeypatch.setattr("shutil.which", lambda name: "/usr/bin/claude")

    class FakeProc:
        pid = 5555

    monkeypatch.setattr(subprocess, "Popen", lambda *a, **k: FakeProc())
    import time
    current = tmp_path / "inbox" / "dispatch" / "current.json"
    current.parent.mkdir(parents=True, exist_ok=True)
    # Fresh timestamp so it passes the age cap and the DEAD-PID branch is what recovers it.
    current.write_text(json.dumps({"id": "old", "pid": 999999, "started_ts": time.time()}))

    def kill(pid, sig):
        raise ProcessLookupError   # the recorded pid is gone

    monkeypatch.setattr(os, "kill", kill)
    r = client.post("/api/devtest/dispatch", json={"model": "opus"})
    assert r.status_code == 200                       # not wedged behind the stale record
    assert json.loads(current.read_text())["id"] != "old"


def test_dispatch_response_hides_the_internal_timestamp(client, monkeypatch):
    import subprocess
    monkeypatch.setattr("shutil.which", lambda name: "/usr/bin/claude")

    class FakeProc:
        pid = 6001

    monkeypatch.setattr(subprocess, "Popen", lambda *a, **k: FakeProc())
    info = client.post("/api/devtest/dispatch", json={"model": "sonnet"}).json()["dispatch"]
    assert "started_ts" not in info and "started_at" in info
