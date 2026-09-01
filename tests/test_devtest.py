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


# --- dispatch status / heartbeat (2026-09-01) -------------------------------------------------

def _stream_log(*records) -> str:
    """A `--output-format stream-json` log: one COMPACT JSON record per line, exactly as the
    CLI writes it. Compact matters — the step count reads bytes, not parsed records."""
    return "".join(json.dumps(r, separators=(",", ":")) + "\n" for r in records)


def _assistant(*blocks) -> dict:
    return {"type": "assistant", "message": {"content": list(blocks)}}


def _tool_use(name, **inp) -> dict:
    return {"type": "tool_use", "name": name, "input": inp}


def _kill_says_gone(monkeypatch) -> None:
    """Make the recorded pid look dead, so the reap branch runs."""
    import os

    def kill(pid, sig):
        raise ProcessLookupError

    monkeypatch.setattr(os, "kill", kill)


def _record_dispatch(tmp_path, pid, log_text=""):
    """Plant a current.json and its log the way a spawn would have."""
    import time as _time

    d = tmp_path / "inbox" / "dispatch"
    d.mkdir(parents=True, exist_ok=True)
    log = d / "session.log"
    log.write_text(log_text)
    (d / "current.json").write_text(json.dumps({
        "id": "dispatch-test", "pid": pid, "model": "opus", "item_id": "DR-115",
        "log": str(log), "started_at": "2026-09-01T08:01:31-0700",
        "started_ts": _time.time() - 120}))
    return d


def test_dispatch_status_reports_a_live_session_and_what_it_is_doing(client, tmp_path):
    """The heartbeat: while the process lives the bubble gets a step count and the last action,
    so a session thinking hard is distinguishable from one that died on its first tool call."""
    import os

    _record_dispatch(tmp_path, os.getpid(), _stream_log(   # our own pid is certainly alive
        {"type": "system", "subtype": "init"},
        _assistant(_tool_use("Read", file_path="mobile/src/App.tsx")),
        {"type": "system", "subtype": "post_turn_summary", "status_detail": "wired the rail"},
        _assistant(_tool_use("Edit", file_path="mobile/src/components/ChatNavRail.tsx")),
    ))
    d = client.get("/api/devtest/dispatch").json()["dispatch"]
    assert d["state"] == "running"
    assert d["item_id"] == "DR-115" and d["model"] == "opus"
    assert d["steps"] == 2                                  # both tool_use records counted
    assert d["last_step"] == "Edit: mobile/src/components/ChatNavRail.tsx"
    assert d["last_summary"] == "wired the rail"
    assert d["result"] is None and d["elapsed_s"] >= 120


def test_dispatch_status_reports_the_outcome_after_the_session_exits(client, tmp_path,
                                                                    monkeypatch):
    """A finished session must stay reportable. The pre-existing reap DELETED current.json, so
    the outcome vanished at exactly the moment Kamil wanted to read it."""
    d = _record_dispatch(tmp_path, 999999, _stream_log(
        _assistant(_tool_use("Bash", command="gh pr create")),
        {"type": "result", "subtype": "success", "is_error": False, "result": "Opened PR #467",
         "total_cost_usd": 1.25, "num_turns": 42, "permission_denials": [],
         "duration_ms": 930000},
    ))
    _kill_says_gone(monkeypatch)
    body = client.get("/api/devtest/dispatch").json()["dispatch"]
    assert body["state"] == "finished"
    assert body["result"]["text"] == "Opened PR #467"
    assert body["result"]["num_turns"] == 42 and body["result"]["denials"] == 0
    assert body["elapsed_s"] == 930         # the session's own duration, not "when we noticed"
    assert not (d / "current.json").exists()   # reaped, so dispatch is not wedged behind a 409
    assert (d / "last.json").exists()
    # Polled again with the record already archived, it still answers — from last.json.
    again = client.get("/api/devtest/dispatch").json()["dispatch"]
    assert again["state"] == "finished" and again["id"] == "dispatch-test"


def test_dispatch_status_flags_an_errored_session_as_failed(client, tmp_path, monkeypatch):
    _record_dispatch(tmp_path, 999999, _stream_log(
        {"type": "result", "subtype": "error_during_execution", "is_error": True,
         "result": "hit the turn limit", "permission_denials": [{"tool": "Bash"}]},
    ))
    _kill_says_gone(monkeypatch)
    d = client.get("/api/devtest/dispatch").json()["dispatch"]
    assert d["state"] == "failed"
    # Refused steps are the August-2026 failure mode; the count has to reach the phone.
    assert d["result"]["denials"] == 1


def test_dispatch_status_calls_a_session_that_wrote_nothing_gone(client, tmp_path, monkeypatch):
    """Killed, or dead before its first record. No reply is coming, so say so rather than
    leaving the bubble on a hopeful 'running' forever."""
    _record_dispatch(tmp_path, 999999, "")
    _kill_says_gone(monkeypatch)
    d = client.get("/api/devtest/dispatch").json()["dispatch"]
    assert d["state"] == "gone" and d["ended_reason"] == "process gone"


def test_dispatch_status_still_reads_a_pre_stream_json_log(client, tmp_path, monkeypatch):
    """Dispatches started before the stream-json switch wrote only a closing prose recap. They
    reached a reply, so they are `finished` with no step detail — never `gone`, never a 500."""
    _record_dispatch(tmp_path, 999999, "Done. Recap for whoever reads only this: ...\n")
    _kill_says_gone(monkeypatch)
    d = client.get("/api/devtest/dispatch").json()["dispatch"]
    assert d["state"] == "finished"
    assert d["steps"] == 0 and d["last_step"] is None


def test_dispatch_status_tolerates_a_record_caught_mid_write(client, tmp_path):
    """The log is read while the session writes it, so the last line is routinely partial. It
    must be skipped — not crash the poll, and not lose the complete records before it."""
    import os

    _record_dispatch(tmp_path, os.getpid(),
                     _stream_log(_assistant(_tool_use("Grep", pattern="ChatNavRail")))
                     + '{"type":"assis')
    d = client.get("/api/devtest/dispatch").json()["dispatch"]
    assert d["state"] == "running" and d["last_step"] == "Grep: ChatNavRail"


def test_dispatch_status_is_null_before_anything_is_dispatched(client):
    assert client.get("/api/devtest/dispatch").json()["dispatch"] is None


def test_dispatch_status_is_absent_outside_dev(tmp_path, monkeypatch):
    monkeypatch.setenv("RC_DEV", "0")
    monkeypatch.setenv("RC_DEVTEST_DIR", str(tmp_path / "inbox"))
    from app.main import app
    assert TestClient(app).get("/api/devtest/dispatch").status_code == 404


def test_step_count_survives_a_record_split_across_a_read_chunk(tmp_path):
    """`_count_tool_uses` streams in 1 MiB chunks. A needle straddling a boundary must be
    counted exactly once — neither dropped nor double-counted by the overlap."""
    chunk, needle = 1 << 20, '"tool_use"'
    first = _stream_log(_assistant(_tool_use("Read", file_path="a")))
    rest = _stream_log(_assistant(_tool_use("Edit", file_path="b")),
                       _assistant(_tool_use("Write", file_path="c")))
    # Pad so that `rest`'s FIRST needle straddles the boundary — five of its bytes in chunk one,
    # the remainder in chunk two. Without the carry it is invisible to both reads.
    pad_len = chunk - len(first) - rest.index(needle) - 5
    assert pad_len > 0
    log = tmp_path / "big.log"
    log.write_text(first + "x" * pad_len + rest)
    blob = log.read_bytes()                      # all ASCII, so byte offsets == char offsets
    start = blob.index(needle.encode(), len(first) + pad_len)
    assert start < chunk < start + len(needle), "the fixture must actually straddle the chunk"
    assert devtest._count_tool_uses(log) == 3


def test_step_count_is_not_fooled_by_tool_use_id_keys(tmp_path):
    """`parent_tool_use_id` / `tool_use_id` appear on ordinary records. Counting them would
    inflate every session's progress."""
    log = tmp_path / "ids.log"
    log.write_text(_stream_log(
        {"type": "user", "parent_tool_use_id": None, "tool_use_id": "abc"},
        _assistant(_tool_use("Read", file_path="a")),
    ))
    assert devtest._count_tool_uses(log) == 1


def test_spawn_asks_for_streaming_records_so_the_log_grows_as_it_runs(client, monkeypatch):
    """The default text format emits only the closing recap, which left the log at 0 bytes for
    an entire run — the reason there was no feedback to give."""
    import subprocess

    calls = {}

    class FakeProc:
        pid = 7007

    monkeypatch.setattr("shutil.which", lambda name: "/usr/bin/claude")
    monkeypatch.setattr(subprocess, "Popen",
                        lambda argv, **kw: (calls.update(argv=argv), FakeProc())[1])
    assert client.post("/api/devtest/dispatch", json={"model": "opus"}).status_code == 200
    argv = calls["argv"]
    assert argv[argv.index("--output-format") + 1] == "stream-json"
    # Not optional: the CLI refuses stream-json in print mode without it.
    assert "--verbose" in argv


# --- the full dispatch loop (2026-09-01) ------------------------------------------------------

def _spawn_argv(client, monkeypatch) -> list[str]:
    """Fire a dispatch with a stubbed Popen and hand back the command line it built."""
    import subprocess

    calls = {}

    class FakeProc:
        pid = 8100

    monkeypatch.setattr("shutil.which", lambda name: "/usr/bin/claude")
    monkeypatch.setattr(subprocess, "Popen",
                        lambda argv, **kw: (calls.update(argv=argv, kwargs=kw), FakeProc())[1])
    assert client.post("/api/devtest/dispatch", json={"model": "opus"}).status_code == 200
    return calls["argv"]


def test_the_session_can_launch_the_opus_review_its_own_pr_needs(client, monkeypatch):
    """CLAUDE.md requires an independent Opus review before merge. Without the Task tool the
    session can only ever hand back an unreviewed PR — which is exactly where DR-115 stopped."""
    allowed = _spawn_argv(client, monkeypatch)
    assert "Task" in allowed
    prompt = next(a for a in allowed if "device-feedback" in a)
    assert "INDEPENDENT Opus review" in prompt
    # Its standing instructions discourage subagents, so the brief must override that here.
    assert "even though your standing instructions" in prompt


def test_the_session_can_run_the_client_suites_it_reports_on(client, monkeypatch):
    """The DR-115 session had every way of running Jest refused, so CI was the first execution
    of its code — and CI caught a real 10-test failure it had already called done."""
    allowed = _spawn_argv(client, monkeypatch)
    assert "Bash(npm:*)" in allowed and "Bash(npx:*)" in allowed
    assert not any(a in ("Bash", "Bash(*)") for a in allowed)   # still not a blanket shell


def test_the_brief_gates_the_merge_on_the_review_rather_than_the_agents_own_judgement(
        client, monkeypatch):
    prompt = next(a for a in _spawn_argv(client, monkeypatch) if "device-feedback" in a)
    assert "only once — the review approves" in prompt
    assert "Never merge on your own say-so" in prompt
    # The stacked-PR trap: a stacked PR does not retarget when its base is deleted.
    assert "baseRefName" in prompt
    # Anything Kamil must test has to be a ledger row or it never reaches his phone.
    assert "implemented — verify" in prompt


def test_worktree_preparation_is_skipped_when_the_seam_is_off(client, monkeypatch, tmp_path):
    """conftest turns it off for the whole suite: preparing the worktree runs `git fetch`
    against the real checkout's remote, and these tests make no external network calls."""
    from app.routers import devtest as dt

    def explode(*a, **k):
        raise AssertionError("dispatch prepared a worktree with the seam off")

    monkeypatch.setattr(dt, "_dispatch_git", explode)
    assert dt._dispatch_cwd() == str(dt._REPO_ROOT)


def test_worktree_preparation_resets_an_existing_worktree_to_origin_main(monkeypatch, tmp_path):
    """Every dispatch starts from a clean origin/main, so a session never builds on the
    leftovers of the previous one."""
    from app.routers import devtest as dt

    monkeypatch.setenv("RC_DISPATCH_WORKTREE", "1")
    root = tmp_path / "checkout"
    worktree = root / dt.DISPATCH_WORKTREE
    (worktree / ".git").mkdir(parents=True)
    monkeypatch.setattr(dt, "_REPO_ROOT", root)
    ran: list[tuple] = []
    monkeypatch.setattr(dt, "_dispatch_git", lambda cwd, *a: ran.append((str(cwd), a)))

    assert dt._dispatch_cwd() == str(worktree)
    verbs = [a for _, a in ran]
    assert ("fetch", "origin", "main") in verbs
    assert ("checkout", "-B", dt.DISPATCH_BASE_BRANCH, "origin/main") in verbs
    # `clean -fd` WITHOUT -x: ignored files are spared, which is what keeps node_modules alive
    # across dispatches. Adding -x would mean an npm ci before every session could start.
    assert ("clean", "-fd") in verbs and not any("-fdx" in a for a in verbs)


def test_worktree_preparation_falls_back_to_the_checkout_rather_than_failing_the_dispatch(
        monkeypatch, tmp_path):
    """A dispatch that runs in a slightly wrong place beats one that cannot run at all."""
    from app.routers import devtest as dt

    monkeypatch.setenv("RC_DISPATCH_WORKTREE", "1")
    root = tmp_path / "checkout"
    root.mkdir()
    monkeypatch.setattr(dt, "_REPO_ROOT", root)

    def fail(*a, **k):
        raise OSError("no git here")

    monkeypatch.setattr(dt, "_dispatch_git", fail)
    assert dt._dispatch_cwd() == str(root)
