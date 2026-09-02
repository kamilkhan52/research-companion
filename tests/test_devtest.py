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


# --- last activity per item (DR-118) ----------------------------------------------------------
#
# Kamil: "I usually want to just find the last item I opened or dispatched or was last worked on
# by Claude." Two of those three are server-side facts; the third is device-local, so the client
# maxes this against its own draft state.

def _epoch(ts: str) -> float:
    from datetime import datetime

    return datetime.fromisoformat(ts).timestamp()


def _ledger(tmp_path, monkeypatch, text=LEDGER_SAMPLE):
    path = tmp_path / "ledger.md"
    path.write_text(text, encoding="utf-8")
    monkeypatch.setattr(devtest, "_LEDGER", path)
    return path


def _plant_dispatch_record(tmp_path, name, **info):
    d = tmp_path / "inbox" / "dispatch"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{name}.json").write_text(json.dumps(info), encoding="utf-8")


def _by_id(client):
    return {i["id"]: i for i in client.get("/api/devtest/items").json()["items"]}


def test_last_activity_reports_the_newest_event_and_what_kind_it_was(client, tmp_path, monkeypatch):
    """The kind belongs to the WINNING event, not to whichever source is checked last. BOTH
    directions are needed (Opus review, PR #471): with only "a dispatch after a reply", a
    dispatch loop that overwrote the kind unconditionally would pass. DR-002 is the mirror —
    a dispatch first, then the reply that must win."""
    _ledger(tmp_path, monkeypatch, LEDGER_SAMPLE + (
        "| DR-002 | 2026-07-21 | Dispatched, then answered. | `open` | — |\n"))
    devtest._append_feedback({"ts": "2026-09-01T09:00:00+00:00", "kind": "response",
                              "item_id": "DR-001", "text": "shipped"})
    _plant_dispatch_record(tmp_path, "dispatch-20260901-100000-aaaaaa",
                           item_id="DR-001", started_ts=_epoch("2026-09-01T10:00:00+00:00"))
    devtest._append_feedback({"ts": "2026-09-01T08:00:00+00:00", "kind": "feedback",
                              "item_id": "DR-058", "verdict": "fail", "comment": "no"})
    devtest._append_feedback({"ts": "2026-09-01T11:00:00+00:00", "kind": "response",
                              "item_id": "DR-058", "text": "looking"})
    _plant_dispatch_record(tmp_path, "dispatch-20260901-090000-bbbbbb",
                           item_id="DR-002", started_ts=_epoch("2026-09-01T09:00:00+00:00"))
    devtest._append_feedback({"ts": "2026-09-01T12:00:00+00:00", "kind": "response",
                              "item_id": "DR-002", "text": "done"})

    items = _by_id(client)
    assert items["DR-001"]["last_activity"] == _epoch("2026-09-01T10:00:00+00:00")
    assert items["DR-001"]["last_activity_kind"] == "dispatch"
    assert items["DR-058"]["last_activity"] == _epoch("2026-09-01T11:00:00+00:00")
    assert items["DR-058"]["last_activity_kind"] == "claude"
    assert items["DR-002"]["last_activity"] == _epoch("2026-09-01T12:00:00+00:00")
    assert items["DR-002"]["last_activity_kind"] == "claude"
    # An item nothing has ever happened to says so, rather than reporting 0 (which would sort as
    # 1970 in one direction and as "just now" in a client that treats falsy as missing).
    assert items["DR-013"]["last_activity"] is None
    assert items["DR-013"]["last_activity_kind"] is None


def test_activity_recorded_under_a_provisional_id_counts_toward_its_ledger_row(
        client, tmp_path, monkeypatch):
    """The DR-097 aliasing again: a dispatch fired from the phone names the NEW id, and the row
    it was triaged into is the only card that will ever be on screen for it."""
    _ledger(tmp_path, monkeypatch, LEDGER_WITH_ALIAS)
    _plant_dispatch_record(tmp_path, "dispatch-20260901-120000-bbbbbb",
                     item_id="NEW-1787325358", started_ts=_epoch("2026-09-01T12:00:00+00:00"))
    row = _by_id(client)["DR-091"]
    assert row["last_activity"] == _epoch("2026-09-01T12:00:00+00:00")
    assert row["last_activity_kind"] == "dispatch"


def test_raising_an_untriaged_item_is_itself_activity(client, tmp_path, monkeypatch):
    """It is the ONLY activity a brand-new item has, and it is the item most likely to be the
    one being looked for — without this it sorts as though nothing ever happened to it."""
    _ledger(tmp_path, monkeypatch)
    devtest._append_feedback({"ts": "2026-09-01T13:00:00+00:00", "kind": "new_item",
                              "id": "NEW-9", "title": "t", "description": ""})
    row = _by_id(client)["NEW-9"]
    assert row["last_activity"] == _epoch("2026-09-01T13:00:00+00:00")
    assert row["last_activity_kind"] == "raised"


def test_a_batch_dispatch_is_not_credited_to_any_item(client, tmp_path, monkeypatch):
    """`item_id: null` means "all pending issues". Crediting it to every open row would give
    them all one identical timestamp and flatten the ordering this field exists to produce."""
    _ledger(tmp_path, monkeypatch)
    _plant_dispatch_record(tmp_path, "dispatch-20260901-140000-cccccc",
                           item_id=None, started_ts=_epoch("2026-09-01T14:00:00+00:00"))
    assert all(i["last_activity"] is None for i in _by_id(client).values())
    # The route assertion above is double-guarded (a `None` target is also dropped when the
    # activity is recorded), so it stays green with the skip deleted — assert on the scan itself,
    # which is where the decision actually lives (Opus review, PR #471).
    assert devtest._dispatch_activity({}) == {}


@pytest.fixture
def non_utc_timezone():
    """Run a test in a zone with a real UTC offset.

    Both timestamp tests below are TAUTOLOGIES on a UTC machine — reading a naive local value as
    if it were UTC gives the same number — and GitHub's runners are UTC while the dev Mac is not.
    Since merges are gated on CI, the blind spot was on exactly the side that matters (Opus
    review, PR #471).

    It takes its OWN `MonkeyPatch` rather than the shared per-test one: `undo()` on that would
    also unwind whatever the `client` fixture had patched (`RC_DEVTEST_DIR`, `dev_mode`) for any
    test using both. Harmless today given LIFO finalization, latent otherwise (Opus review,
    PR #471, round 2).
    """
    import time as _time

    with pytest.MonkeyPatch.context() as mp:
        mp.setenv("TZ", "America/New_York")
        _time.tzset()
        yield
    _time.tzset()       # after the context restored the previous TZ


def test_one_instant_spelled_three_ways_reads_as_one_timestamp(non_utc_timezone):
    """The inbox is append-only and still holds pre-UTC NAIVE local timestamps beside today's
    UTC-aware ones, so the two are compared against each other constantly. The property that
    makes that safe is this one, and it is what a text comparison (or reading a naive value as
    UTC) breaks: one instant, however spelled, is one number.

    Pinned to a non-UTC zone by the fixture, because in UTC the two implementations agree and
    the assertion proves nothing.
    """
    from datetime import UTC, datetime

    naive_local = datetime.now().replace(microsecond=0)
    # The property has teeth only if the two spellings really differ here.
    assert naive_local.isoformat() != naive_local.astimezone(UTC).isoformat()
    assert devtest._entry_epoch(naive_local.isoformat()) == naive_local.timestamp()
    assert devtest._entry_epoch(naive_local.astimezone().isoformat()) == naive_local.timestamp()
    assert devtest._entry_epoch(
        naive_local.astimezone(UTC).isoformat()) == naive_local.timestamp()
    # Unreadable input contributes nothing rather than raising through the route.
    assert devtest._entry_epoch("not a timestamp") is None
    assert devtest._entry_epoch(None) is None and devtest._entry_epoch(17) is None


def test_naive_and_aware_inbox_timestamps_are_ordered_against_each_other(
        client, tmp_path, monkeypatch, non_utc_timezone):
    """The same property through the route: a mixed-format history still orders by instant."""
    from datetime import datetime, timedelta

    older = datetime.now().replace(microsecond=0) - timedelta(hours=1)
    newer = older.astimezone() + timedelta(minutes=30)   # 30 min later, and AWARE
    _ledger(tmp_path, monkeypatch)
    devtest._append_feedback({"ts": older.isoformat(), "kind": "feedback",   # naive, local
                              "item_id": "DR-001", "verdict": "fail", "comment": "old"})
    devtest._append_feedback({"ts": newer.isoformat(), "kind": "response",   # aware
                              "item_id": "DR-001", "text": "new"})
    row = _by_id(client)["DR-001"]
    assert row["last_activity_kind"] == "claude"
    assert row["last_activity"] == pytest.approx(newer.timestamp())


def test_a_corrupt_dispatch_record_loses_only_itself(client, tmp_path, monkeypatch):
    _ledger(tmp_path, monkeypatch)
    (tmp_path / "inbox" / "dispatch").mkdir(parents=True, exist_ok=True)
    (tmp_path / "inbox" / "dispatch" / "dispatch-20260901-150000-dddddd.json").write_text(
        "{not json", encoding="utf-8")
    _plant_dispatch_record(tmp_path, "dispatch-20260901-160000-eeeeee",
                           item_id="DR-058", started_ts=_epoch("2026-09-01T16:00:00+00:00"))
    items = _by_id(client)
    assert items["DR-058"]["last_activity"] == _epoch("2026-09-01T16:00:00+00:00")


def test_the_dispatch_scan_is_bounded_to_the_newest_records(client, tmp_path, monkeypatch):
    """The directory only grows and this runs on every bubble open. The bound is safe only
    because the filenames sort by spawn time — the newest record must survive it.

    DR-001 is what makes this discriminating (Opus review, PR #471): the filler records ascend in
    step with their names, so a max over all of them equals a max over the tail, and the earlier
    version of this test stayed green with the bound deleted. DR-001's record is the OLDEST by
    name and therefore outside the tail, while carrying the NEWEST timestamp of the lot — so it
    is visible if and only if the bound is gone."""
    _ledger(tmp_path, monkeypatch)
    _plant_dispatch_record(tmp_path, "dispatch-20260701-000000-000000",
                           item_id="DR-001", started_ts=_epoch("2026-09-03T00:00:00+00:00"))
    for n in range(devtest.DISPATCH_ACTIVITY_SCAN + 5):
        _plant_dispatch_record(tmp_path, f"dispatch-20260801-{n:06d}-aaaaaa",
                               item_id="DR-013", started_ts=1.0 + n)
    _plant_dispatch_record(tmp_path, "dispatch-20260902-000000-ffffff",
                           item_id="DR-058", started_ts=_epoch("2026-09-02T00:00:00+00:00"))
    items = _by_id(client)
    assert items["DR-058"]["last_activity"] == _epoch("2026-09-02T00:00:00+00:00")
    # Off the tail entirely, however new its timestamp — the bound's real cost, stated.
    assert items["DR-001"]["last_activity"] is None
    # Records inside the tail still count.
    assert items["DR-013"]["last_activity"] == 1.0 + devtest.DISPATCH_ACTIVITY_SCAN + 4


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


def _pid_says_alive(monkeypatch) -> None:
    """Our own pid is a live process but its command line is pytest, not `claude`, so the
    identity check correctly refuses it. Tests that plant a LIVE record say so directly."""
    from app.routers import devtest as dt

    monkeypatch.setattr(dt, "_dispatch_liveness", lambda pid, started=0.0: "alive")


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


def test_dispatch_status_reports_a_live_session_and_what_it_is_doing(client, tmp_path,
                                                                    monkeypatch):
    """The heartbeat: while the process lives the bubble gets a step count and the last action,
    so a session thinking hard is distinguishable from one that died on its first tool call."""
    import os

    _pid_says_alive(monkeypatch)
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


def test_dispatch_status_tolerates_a_record_caught_mid_write(client, tmp_path, monkeypatch):
    """The log is read while the session writes it, so the last line is routinely partial. It
    must be skipped — not crash the poll, and not lose the complete records before it."""
    import os

    _pid_says_alive(monkeypatch)
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
    assert "Opus review" in prompt and "Task tool" in prompt


def test_the_session_can_run_the_client_suites_it_reports_on(client, monkeypatch):
    """The DR-115 session had every way of running Jest refused, so CI was the first execution
    of its code — and CI caught a real 10-test failure it had already called done."""
    allowed = _spawn_argv(client, monkeypatch)
    assert "Bash(npm:*)" in allowed and "Bash(npx:*)" in allowed
    assert not any(a in ("Bash", "Bash(*)") for a in allowed)   # still not a blanket shell


def test_the_brief_gates_the_merge_on_the_review_rather_than_the_agents_own_judgement(
        client, monkeypatch):
    prompt = next(a for a in _spawn_argv(client, monkeypatch) if "device-feedback" in a)
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
    # `_main_root()`, not `_REPO_ROOT`: they are the same in the main checkout and in CI, and
    # DIFFER inside a git worktree — which is exactly where CLAUDE.md says to do backend work,
    # so asserting the wrong one made the suite red for every agent and green only here.
    assert dt._dispatch_cwd() == str(dt._main_root())


def test_worktree_preparation_resets_an_existing_worktree_to_origin_main(monkeypatch, tmp_path):
    """Every dispatch starts from a clean origin/main, so a session never builds on the
    leftovers of the previous one."""
    from app.routers import devtest as dt

    monkeypatch.setenv("RC_DISPATCH_WORKTREE", "1")
    root = tmp_path / "checkout"
    worktree = root / dt.DISPATCH_WORKTREE
    (worktree / ".git").mkdir(parents=True)
    monkeypatch.setattr(dt, "_main_root", lambda: root)
    ran: list[tuple] = []
    monkeypatch.setattr(dt, "_dispatch_git", lambda cwd, *a: ran.append((str(cwd), a)))

    class Clean:            # the scratch-tree inspection: on the base branch, nothing dirty
        returncode = 0
        stdout = ""

    monkeypatch.setattr("subprocess.run", lambda *a, **k: Clean())

    assert dt._dispatch_cwd() == str(worktree)
    verbs = [a for _, a in ran]
    assert ("fetch", "origin", "main") in verbs
    assert ("checkout", "-B", dt.DISPATCH_BASE_BRANCH, "origin/main") in verbs
    # `clean -fd` WITHOUT -x: ignored files are spared, which is what keeps node_modules alive
    # across dispatches. Adding -x would mean an npm ci before every session could start.
    assert ("clean", "-fd") in verbs and not any("-fdx" in a for a in verbs)


def test_worktree_preparation_raises_rather_than_using_the_live_checkout(monkeypatch, tmp_path):
    """It used to return _REPO_ROOT on any failure. That was defensible when the fallback was a
    spare worktree and the session only proposed a branch; it is not when the session edits
    `app/` (restarting the live server — DR-083) and merges its own PR."""
    from app.routers import devtest as dt

    monkeypatch.setenv("RC_DISPATCH_WORKTREE", "1")
    root = tmp_path / "checkout"
    root.mkdir()
    monkeypatch.setattr(dt, "_main_root", lambda: root)

    def fail(cwd, *args):
        raise OSError("no git here")

    monkeypatch.setattr(dt, "_dispatch_git", fail)
    with pytest.raises(dt.DispatchPrepError):
        dt._dispatch_cwd()


# --- review round 2 (Opus review of PR #468) --------------------------------------------------

def test_a_long_running_session_is_not_declared_dead_by_age_alone(client, tmp_path, monkeypatch):
    """The age cap used to OVERRIDE liveness. Harmless when its only effect was releasing the
    409 — but a dispatch now resets its worktree on the way in, so declaring a live session
    dead makes the next one `git reset --hard` the tree it is still editing. And the full loop
    (build, suites, PR, an Opus round-trip, CI, merge) makes a long session unremarkable."""
    import os
    import time as _time

    from app.routers import devtest as dt

    d = _record_dispatch(tmp_path, os.getpid(), _stream_log(
        _assistant(_tool_use("Bash", command="npm test"))))
    aged = json.loads((d / "current.json").read_text())
    aged["started_ts"] = _time.time() - (dt.DISPATCH_MAX_AGE_S + 3600)
    (d / "current.json").write_text(json.dumps(aged))
    monkeypatch.setattr(dt, "_dispatch_liveness", lambda pid, started=0.0: "alive")

    body = client.get("/api/devtest/dispatch").json()["dispatch"]
    assert body["state"] == "running"
    assert (d / "current.json").exists()            # NOT archived out from under itself
    # And single-flight still holds, so no second session can reach the worktree reset.
    monkeypatch.setattr("shutil.which", lambda name: "/usr/bin/claude")
    assert client.post("/api/devtest/dispatch", json={"model": "opus"}).status_code == 409


def test_pid_reuse_is_caught_by_identity_and_by_the_age_of_the_process_itself(monkeypatch):
    """What replaced the age cap as the pid-reuse defence. A bare `claude` substring was far too
    loose — it also matches the desktop app, its helpers, and every shell any Claude Code session
    spawns — so a coincidental match wedged dispatch at 409 with no way to clear it from the
    phone. Two checks now: the command line must look like a DISPATCH, and the process must not
    be younger than the record claiming to describe it."""
    import os
    import time as _time

    from app.routers import devtest as dt

    monkeypatch.setattr(os, "kill", lambda pid, sig: None)      # the number exists

    class Out:
        returncode = 0
        stdout = "05:00 /usr/sbin/some-unrelated-daemon --serve\n"

    monkeypatch.setattr("subprocess.run", lambda *a, **k: Out())
    started = _time.time() - 300
    assert dt._dispatch_liveness(4242, started) == "dead"

    # Claude-ish but NOT a dispatch — the old substring claimed this one as ours.
    Out.stdout = "05:00 /bin/zsh -c source /Users/k/.claude/shell-snapshots/snapshot.sh\n"
    assert dt._dispatch_liveness(4242, started) == "dead"

    Out.stdout = ("05:00 /opt/homebrew/bin/claude -p Run the skill --output-format stream-json "
                  "--verbose\n")
    assert dt._dispatch_liveness(4242, started) == "alive"

    # A real dispatch command line, but the process is far YOUNGER than the record — so the
    # number was reused after we wrote it, and this cannot be our session.
    assert dt._dispatch_liveness(4242, _time.time() - 30 * 3600) == "dead"


def test_etime_parses_every_shape_ps_emits():
    from app.routers import devtest as dt

    assert dt._parse_etime("05:00") == 300
    assert dt._parse_etime("01:05:00") == 3900
    assert dt._parse_etime("2-01:05:00") == 3900 + 2 * 86400
    assert dt._parse_etime("") is None and dt._parse_etime("garbage") is None


def test_liveness_is_unknown_rather_than_a_guess_when_it_cannot_tell(monkeypatch):
    """Wrongly declaring a session dead is the DESTRUCTIVE direction — it gets the worktree
    reset — but claiming alive forever would wedge dispatch. Hence the third value."""
    import os

    from app.routers import devtest as dt

    monkeypatch.setattr(os, "kill", lambda pid, sig: None)

    def boom(*a, **k):
        raise OSError("no ps on this box")

    monkeypatch.setattr("subprocess.run", boom)
    # "unknown", not "alive": treated as running, but the age cap may still overrule it — the
    # only case where age decides anything.
    assert dt._dispatch_liveness(4242) == "unknown"


def test_a_killed_stream_json_session_is_gone_not_finished(client, tmp_path, monkeypatch):
    """Print mode ALWAYS terminates with a `result` record, so its absence in a stream-json log
    means killed. Reporting that as 'finished — check the item for its reply' would send Kamil
    looking for something that does not exist: this feature's own failure mode, inverted."""
    _record_dispatch(tmp_path, 999999, _stream_log(
        _assistant(_tool_use("Edit", file_path="mobile/src/App.tsx"))))
    _kill_says_gone(monkeypatch)
    d = client.get("/api/devtest/dispatch").json()["dispatch"]
    assert d["state"] == "gone"
    assert d["steps"] == 1                      # it did work; it just never got to say so


def test_the_public_tunnel_gets_state_without_the_session_transcript(client, tmp_path,
                                                                    monkeypatch):
    """`last_step` carries file paths, command lines and Task prompts; `result.text` carries the
    closing message. The dev server is open-auth and sometimes tunnelled. State and progress
    still cross so the banner works off-tailnet — redaction, not the refusal POST uses."""
    _record_dispatch(tmp_path, 999999, _stream_log(
        _assistant(_tool_use("Bash", command="gh pr merge 467 --squash")),
        {"type": "result", "subtype": "success", "is_error": False,
         "result": "merged, and here is everything I learned", "permission_denials": []},
    ))
    _kill_says_gone(monkeypatch)
    d = client.get("/api/devtest/dispatch",
                   headers={"cf-ray": "8a1b2c3d4e5f6789-LHR"}).json()["dispatch"]
    assert d["state"] == "finished" and d["steps"] == 1     # still useful
    assert d["last_step"] is None and d["result"]["text"] is None
    assert "gh pr merge" not in json.dumps(d)


def test_the_step_count_is_memoized_across_polls_and_stays_exact(tmp_path):
    """A multi-hour log reaches hundreds of MB and the bubble polls every 5s, so the count
    resumes from where it left off. Appends must stay exact, including a needle straddling the
    resume point, and a file that SHRANK is a different log and is recounted."""
    from app.routers import devtest as dt

    log = tmp_path / "grow.log"
    first = _stream_log(_assistant(_tool_use("Read", file_path="a")))
    log.write_text(first)
    assert dt._count_tool_uses(log) == 1

    # Append, splitting a needle exactly across the resume point.
    rest = _stream_log(_assistant(_tool_use("Edit", file_path="b")))
    split = rest.index('"tool_use"') + 4
    with log.open("a") as fh:
        fh.write(rest[:split])
    dt._count_tool_uses(log)                     # counts the partial, carries the fragment
    with log.open("a") as fh:
        fh.write(rest[split:])
    assert dt._count_tool_uses(log) == 2         # not 1 (dropped) and not 3 (double-counted)

    log.write_text(first)                        # shorter: a different log reusing the name
    assert dt._count_tool_uses(log) == 1


def test_progress_reads_a_result_record_past_the_tail_window(tmp_path):
    """The tail seek only runs on a log bigger than the window, which no other test produces."""
    from app.routers import devtest as dt

    log = tmp_path / "huge.log"
    filler = _stream_log(*[_assistant(_tool_use("Read", file_path=f"f{i}")) for i in range(200)])
    log.write_text(filler * ((dt.DISPATCH_LOG_TAIL_BYTES // len(filler)) + 2)
                   + _stream_log({"type": "result", "subtype": "success", "is_error": False,
                                  "result": "done", "permission_denials": []}))
    assert log.stat().st_size > dt.DISPATCH_LOG_TAIL_BYTES
    progress = dt._dispatch_progress(str(log))
    assert progress["structured"] is True
    assert progress["result"]["text"] == "done"          # the seek landed on whole lines


def test_uncommitted_work_is_stashed_before_the_reset_rather_than_refused(monkeypatch, tmp_path):
    """The belt to the liveness braces — but it must not become a lockout. Refusing was the first
    cut and the wrong trade: `git status --porcelain` is non-empty for UNTRACKED files too, so
    one leftover scratch file 503s every future dispatch, from a phone that cannot resolve it.
    This PR's own flow reaches that state routinely (ceiling mid-edit, resume declined).
    Stashing loses nothing and wedges nothing."""
    import subprocess

    from app.routers import devtest as dt

    monkeypatch.setenv("RC_DISPATCH_WORKTREE", "1")
    root = tmp_path / "checkout"
    worktree = root / dt.DISPATCH_WORKTREE
    (worktree / ".git").mkdir(parents=True)
    monkeypatch.setattr(dt, "_main_root", lambda: root)
    ran: list[tuple] = []
    monkeypatch.setattr(dt, "_dispatch_git", lambda cwd, *a: ran.append(a))

    # Dirty when first inspected, clean once the stash has taken it — which is what a real
    # `git stash push -u` does, and what the post-stash re-check is there to confirm.
    statuses = iter(["?? junk-from-a-killed-session.txt\n", ""])

    def status(*a, **k):
        class Out:
            returncode = 0
            stdout = next(statuses, "")
        return Out()

    monkeypatch.setattr(subprocess, "run", status)
    assert dt._dispatch_cwd(dispatch_id="dispatch-xyz") == str(worktree)
    stash = next(a for a in ran if a[0] == "stash")
    assert stash[:3] == ("stash", "push", "-u")     # -u: untracked is most of what accumulates
    assert "pre-dispatch-xyz" in stash              # recoverable, and named for its dispatch
    assert ("reset", "--hard") in ran               # and the reset still happens afterwards


def test_a_failed_fetch_does_not_push_the_session_into_the_live_checkout(monkeypatch, tmp_path):
    """An offline Mac or a slow remote must not silently drop an unattended, merge-authorized
    session into the checkout the live backend serves from."""
    import subprocess

    from app.routers import devtest as dt

    monkeypatch.setenv("RC_DISPATCH_WORKTREE", "1")
    root = tmp_path / "checkout"
    worktree = root / dt.DISPATCH_WORKTREE
    (worktree / ".git").mkdir(parents=True)
    monkeypatch.setattr(dt, "_main_root", lambda: root)

    def git(cwd, *args):
        if args[0] == "fetch":
            raise OSError("network is down")

    monkeypatch.setattr(dt, "_dispatch_git", git)

    class Clean:
        returncode = 0
        stdout = ""

    monkeypatch.setattr(subprocess, "run", lambda *a, **k: Clean())
    # Fetch failure is survivable — reset to the origin/main already on disk.
    assert dt._dispatch_cwd() == str(worktree)


def test_preparation_failure_refuses_the_dispatch_instead_of_using_the_live_checkout(
        client, monkeypatch):
    """The old fallback returned _REPO_ROOT. Fine when the session only proposed a branch;
    not when it edits app/ (restarting the live server — DR-083) and merges its own PR."""
    from app.routers import devtest as dt

    monkeypatch.setattr("shutil.which", lambda name: "/usr/bin/claude")

    def refuse(reset=True, dispatch_id="dispatch"):
        raise dt.DispatchPrepError("worktree is dirty")

    monkeypatch.setattr(dt, "_dispatch_cwd", refuse)
    r = client.post("/api/devtest/dispatch", json={"model": "opus"})
    assert r.status_code == 503
    assert "worktree" in r.json()["detail"]


def test_the_worktree_gets_the_venv_the_session_cannot_bootstrap(monkeypatch, tmp_path):
    """`git worktree add` materialises TRACKED files only and `.venv` is gitignored, so the
    session's one permitted interpreter — the RELATIVE path `.venv/bin/python` — would not
    exist. Without it there is no pytest and, far worse, no `append_response`: that is
    filesystem-side by design (DR-080), so the bubble reply, which is the whole deliverable,
    becomes impossible."""
    import subprocess

    from app.routers import devtest as dt

    monkeypatch.setenv("RC_DISPATCH_WORKTREE", "1")
    root = tmp_path / "checkout"
    worktree = root / dt.DISPATCH_WORKTREE
    (worktree / ".git").mkdir(parents=True)
    (root / ".venv" / "bin").mkdir(parents=True)
    (root / ".venv" / "bin" / "python").write_text("#!/bin/sh\n")
    monkeypatch.setattr(dt, "_main_root", lambda: root)
    monkeypatch.setattr(dt, "_dispatch_git", lambda cwd, *a: None)

    class Clean:
        returncode = 0
        stdout = ""

    monkeypatch.setattr(subprocess, "run", lambda *a, **k: Clean())
    dt._dispatch_cwd()
    assert (worktree / ".venv" / "bin" / "python").exists()
    # Gitignored, so it survives the `clean -fd` of every subsequent dispatch.
    assert (worktree / ".venv").is_symlink()


# --- hitting the account ceiling, and picking the session back up (Kamil, 2026-09-01) ---------

def _rate_limit_event(status="rejected", resets_at=1788282600, scope="five_hour") -> dict:
    return {"type": "rate_limit_event",
            "rate_limit_info": {"status": status, "resetsAt": resets_at,
                                "rateLimitType": scope}}


def test_a_session_stopped_by_the_usage_limit_is_not_reported_as_failed(client, tmp_path,
                                                                       monkeypatch):
    """`failed` says "look at this"; the ceiling says "wait". Kamil watched a review agent die
    at the limit on 2026-09-01 and the surface could not tell him which it was."""
    _record_dispatch(tmp_path, 999999, _stream_log(
        _assistant(_tool_use("Bash", command="npm test")),
        _rate_limit_event(status="allowed"),          # fine for most of the run...
        _rate_limit_event(status="rejected"),         # ...and then not
    ))
    _kill_says_gone(monkeypatch)
    d = client.get("/api/devtest/dispatch").json()["dispatch"]
    assert d["state"] == "rate_limited"
    assert d["resumable"] is True
    assert d["rate_limit"]["resets_at"] == 1788282600     # when the window reopens
    assert d["rate_limit"]["scope"] == "five_hour"


def test_a_429_in_the_result_record_also_reads_as_the_ceiling(client, tmp_path, monkeypatch):
    """The other shape: a session that gets the 429 mid-turn terminates with a result record
    rather than being killed, so it never writes a rejecting rate_limit_event."""
    _record_dispatch(tmp_path, 999999, _stream_log(
        {"type": "result", "subtype": "error_during_execution", "is_error": True,
         "result": "usage limit reached", "api_error_status": 429, "permission_denials": []},
    ))
    _kill_says_gone(monkeypatch)
    d = client.get("/api/devtest/dispatch").json()["dispatch"]
    assert d["state"] == "rate_limited" and d["resumable"] is True


def test_an_ordinary_failure_is_still_a_failure(client, tmp_path, monkeypatch):
    """The counterweight: an errored session that merely SAW an allowed rate-limit record must
    not be mistaken for one the ceiling stopped, or a real defect gets waited on instead of
    read."""
    _record_dispatch(tmp_path, 999999, _stream_log(
        _rate_limit_event(status="allowed"),
        {"type": "result", "subtype": "error_during_execution", "is_error": True,
         "result": "hit the turn limit", "api_error_status": None, "permission_denials": []},
    ))
    _kill_says_gone(monkeypatch)
    d = client.get("/api/devtest/dispatch").json()["dispatch"]
    assert d["state"] == "failed" and d["resumable"] is False
    assert d["rate_limit"] is None


def test_resume_continues_the_same_cli_session_rather_than_starting_over(client, tmp_path,
                                                                        monkeypatch):
    """The point of resuming: the interrupted session already worked things out, and throwing
    that away is most of what the wasted window cost."""
    import subprocess

    d = _record_dispatch(tmp_path, 999999, _stream_log(
        {"type": "system", "subtype": "init", "session_id": "sess-abc-123"},
        _rate_limit_event(status="rejected"),
    ))
    _kill_says_gone(monkeypatch)
    client.get("/api/devtest/dispatch")               # reap archives it to last.json
    assert (d / "last.json").exists()

    calls = {}

    class FakeProc:
        pid = 9100

    monkeypatch.setattr("shutil.which", lambda name: "/usr/bin/claude")
    monkeypatch.setattr(subprocess, "Popen",
                        lambda argv, **kw: (calls.update(argv=argv, kwargs=kw), FakeProc())[1])
    # The model in the body is ignored — a resume must not quietly become a different job.
    r = client.post("/api/devtest/dispatch", json={"model": "haiku", "resume": True})
    assert r.status_code == 200
    argv = calls["argv"]
    assert argv[argv.index("--resume") + 1] == "sess-abc-123"
    assert argv[argv.index("--model") + 1] == "opus"          # from the record, not the request
    assert r.json()["dispatch"]["item_id"] == "DR-115"        # likewise
    # The brief must not restate the whole loop: a resumed session has the transcript already.
    prompt = argv[argv.index("-p") + 1]
    assert "Continue where you left off" in prompt
    assert "Run the /device-feedback skill" not in prompt


def test_resume_keeps_the_worktree_it_left_behind(monkeypatch, tmp_path):
    """A resume must NOT reset: the uncommitted half of the interrupted session is exactly what
    `git reset --hard` would destroy, and it is what we are resuming."""
    from app.routers import devtest as dt

    monkeypatch.setenv("RC_DISPATCH_WORKTREE", "1")
    root = tmp_path / "checkout"
    worktree = root / dt.DISPATCH_WORKTREE
    (worktree / ".git").mkdir(parents=True)
    monkeypatch.setattr(dt, "_main_root", lambda: root)

    def git(cwd, *args):
        raise AssertionError(f"a resume must not run git {args[0]} on the worktree")

    monkeypatch.setattr(dt, "_dispatch_git", git)
    assert dt._dispatch_cwd(reset=False) == str(worktree)


def test_resume_is_refused_when_there_is_nothing_rate_limited_to_resume(client, tmp_path,
                                                                       monkeypatch):
    """A finished session has nothing to continue and a failed one should be READ, not blindly
    carried on — so neither is resumable."""
    _record_dispatch(tmp_path, 999999, _stream_log(
        {"type": "result", "subtype": "success", "is_error": False, "result": "done",
         "permission_denials": []},
    ))
    _kill_says_gone(monkeypatch)
    client.get("/api/devtest/dispatch")               # archive it
    # Not merely refused — not OFFERED. The banner reading "resumable" while the server always
    # 409s is a worse shape than either alone, and the flag is what the button renders from.
    assert client.get("/api/devtest/dispatch").json()["dispatch"]["resumable"] is False
    monkeypatch.setattr("shutil.which", lambda name: "/usr/bin/claude")
    r = client.post("/api/devtest/dispatch", json={"model": "opus", "resume": True})
    assert r.status_code == 409
    assert "no rate-limited session" in r.json()["detail"]


# --- review round 3 (Opus review of PR #468, round 2) -----------------------------------------

def test_a_completed_session_is_never_offered_as_rate_limited(client, tmp_path, monkeypatch):
    """The first cut treated ANY rate-limit status other than `allowed` as the ceiling, and
    checked it BEFORE the terminating record. So a session that finished its work and merely
    brushed the warning threshold on its last turn came back as "hit the usage limit — Resume?",
    and a tap would re-run a merged loop in the un-reset worktree."""
    for status in ("allowed_warning", "queueing", "some_future_status"):
        _record_dispatch(tmp_path, 999999, _stream_log(
            _rate_limit_event(status=status),
            {"type": "result", "subtype": "success", "is_error": False,
             "result": "Merged PR #470", "api_error_status": None, "permission_denials": []},
        ))
        _kill_says_gone(monkeypatch)
        d = client.get("/api/devtest/dispatch").json()["dispatch"]
        assert d["state"] == "finished", f"{status} was misread as the ceiling"
        assert d["resumable"] is False


def test_a_blocking_status_still_reads_as_the_ceiling_when_there_is_no_result(client, tmp_path,
                                                                             monkeypatch):
    """The counterweight to the allow-list: the killed-before-it-could-say-so case must survive.
    That is the whole reason the rate-limit events are consulted at all."""
    _record_dispatch(tmp_path, 999999, _stream_log(_rate_limit_event(status="rejected")))
    _kill_says_gone(monkeypatch)
    d = client.get("/api/devtest/dispatch").json()["dispatch"]
    assert d["state"] == "rate_limited" and d["resumable"] is True


def test_the_step_count_does_not_inflate_while_the_session_is_still_writing(tmp_path):
    """The memo recorded `seen = size` from the stat but read to EOF, so anything appended
    between the two was counted, then counted AGAIN on the next poll — and the error was
    permanent. A live session appends constantly, so this was the normal case, and it got worse
    the bigger the log."""
    from app.routers import devtest as dt

    log = tmp_path / "live.log"
    log.write_text(_stream_log(*[_assistant(_tool_use("Read", file_path=f"f{i}"))
                                 for i in range(3)]))

    class GrowsWhileRead:
        """A Path that appends right after its size is taken — exactly the race a live session
        creates between `_count_tool_uses`'s stat() and its read reaching EOF."""

        def __init__(self, real):
            self._real = real

        def stat(self):
            info = self._real.stat()
            with self._real.open("a") as fh:
                fh.write(_stream_log(*[_assistant(_tool_use("Edit", file_path=f"g{i}"))
                                       for i in range(4)]))
            return info

        def open(self, *a, **k):
            return self._real.open(*a, **k)

        def __str__(self):
            return str(self._real)

    assert dt._count_tool_uses(GrowsWhileRead(log)) == 3   # only what the stat covered
    assert dt._count_tool_uses(log) == 7                   # the 4 appended, counted exactly once

def test_a_stale_rate_limited_session_is_no_longer_offered_for_resume(client, tmp_path,
                                                                     monkeypatch):
    """The CLI expires stored sessions, so `--resume` on a days-old id spawns a process that
    dies at once — which would present as a brand-new failure rather than as an expiry."""
    import time as _time

    from app.routers import devtest as dt

    d = _record_dispatch(tmp_path, 999999, _stream_log(
        {"type": "system", "subtype": "init", "session_id": "sess-old"},
        _rate_limit_event(status="rejected"),
    ))
    _kill_says_gone(monkeypatch)
    client.get("/api/devtest/dispatch")                     # archive it
    archived = json.loads((d / "last.json").read_text())
    archived["started_ts"] = _time.time() - (dt.DISPATCH_RESUME_MAX_AGE_S + 3600)
    (d / "last.json").write_text(json.dumps(archived))

    # Not merely refused — not OFFERED. The banner reading "resumable" while the server always
    # 409s is a worse shape than either alone, and the flag is what the button renders from.
    assert client.get("/api/devtest/dispatch").json()["dispatch"]["resumable"] is False
    monkeypatch.setattr("shutil.which", lambda name: "/usr/bin/claude")
    r = client.post("/api/devtest/dispatch", json={"model": "opus", "resume": True})
    assert r.status_code == 409


def test_a_still_dirty_tree_after_stashing_refuses_rather_than_resetting_over_it(monkeypatch,
                                                                                 tmp_path):
    """The stash exiting 0 is not proof the tree is clean. This guard exists to make "cannot
    lose work" provable rather than probable, so it re-checks instead of inferring."""
    import subprocess

    from app.routers import devtest as dt

    monkeypatch.setenv("RC_DISPATCH_WORKTREE", "1")
    root = tmp_path / "checkout"
    worktree = root / dt.DISPATCH_WORKTREE
    (worktree / ".git").mkdir(parents=True)
    monkeypatch.setattr(dt, "_main_root", lambda: root)
    monkeypatch.setattr(dt, "_dispatch_git", lambda cwd, *a: None)   # a stash that "succeeds"

    class StillDirty:
        returncode = 0
        stdout = " M app/routers/devtest.py\n"

    monkeypatch.setattr(subprocess, "run", lambda *a, **k: StillDirty())
    with pytest.raises(dt.DispatchPrepError, match="still dirty"):
        dt._dispatch_cwd()


# --- deploying what a dispatch built (Kamil, 2026-09-01) --------------------------------------

def _fake_git(monkeypatch, *, server="aaa", device="bbb", target="ccc", dirty="",
              server_behind="2", device_behind="3", lockfile=""):
    """Stub the git helpers. Returns the list of MUTATING calls made."""
    from app.routers import devtest as dt

    ran: list[tuple] = []

    def out(cwd, *args):
        if args[:2] == ("rev-parse", "--abbrev-ref"):
            return "main"          # the deploy target's normal, and required, state
        if args[:2] == ("rev-parse", "origin/main"):
            return target
        if args[:2] == ("rev-parse", "HEAD"):
            return device if "device" in str(cwd) else server
        if args[0] == "rev-list":
            # The range is "<head>..<target>", so which checkout is being asked about is read
            # from the HEAD it starts at — not from the cwd, which is always the main root.
            return device_behind if args[-1].startswith(device) else server_behind
        if args[0] == "diff":
            return lockfile
        if args[:2] == ("status", "--porcelain"):
            return dirty
        if args[0] == "log":
            return "DR-116: the newest merged thing"
        return ""

    def tried(cwd, *args):
        # `_git_try` carries the MUTATING calls too (the device advance, the fast-forward), so
        # record here as well or a test asserting "it moved the worktree" sees an empty list.
        ran.append((str(cwd), args))
        return True, out(cwd, *args)

    monkeypatch.setattr(dt, "_git_out", out)
    monkeypatch.setattr(dt, "_git_try", tried)
    monkeypatch.setattr(dt, "_dispatch_git", lambda cwd, *a: ran.append((str(cwd), a)))
    monkeypatch.setattr(dt, "_preserve_worktree", lambda wt, label: None)
    monkeypatch.setattr(dt, "_active_job", lambda force: None)
    return ran


def _device_wt(dt, tmp_path):
    """A stand-in device worktree. Idempotent: `_device_worktree` is called several times per
    deploy, so this runs more than once per test."""
    device = tmp_path / "device-wt"
    (device / ".git").mkdir(parents=True, exist_ok=True)
    return device


def test_deploy_status_says_how_far_the_phone_is_behind_what_merged(client, monkeypatch,
                                                                    tmp_path):
    """The number that explains "I reloaded and nothing changed": a merged PR moves origin/main
    and NOTHING the reader can see until the checkouts follow."""
    from app.routers import devtest as dt

    _fake_git(monkeypatch, server="aaa", device="bbb", target="ccc",
              server_behind="2", device_behind="3")
    monkeypatch.setattr(dt, "_main_root", lambda: tmp_path)
    monkeypatch.setattr(dt, "_device_worktree", lambda: _device_wt(dt, tmp_path))
    monkeypatch.setattr(dt.jobs, "any_active", lambda: None)
    d = client.get("/api/devtest/deploy").json()["deploy"]
    assert d["target"] == "ccc" and d["server"] == "aaa" and d["device"] == "bbb"
    # Each checkout gets its OWN count — the first cut's stub could not tell them apart.
    assert d["server_behind"] == 2 and d["device_behind"] == 3
    assert d["target_subject"].startswith("DR-116")
    assert d["active_job"] is None


def test_the_status_route_fetches_or_the_banner_is_blind(client, monkeypatch, tmp_path):
    """`origin/main` is a LOCAL ref: merging a PR on GitHub does not move it. Without a fetch
    every checkout looks level with a commit that predates the merge, the banner never renders,
    and the reader gets the DR-116 experience from the feature built to end it."""
    from app.routers import devtest as dt

    _fake_git(monkeypatch)
    monkeypatch.setattr(dt, "_main_root", lambda: tmp_path)
    monkeypatch.setattr(dt, "_device_worktree", lambda: _device_wt(dt, tmp_path))
    monkeypatch.setattr(dt.jobs, "any_active", lambda: None)
    fetched: list = []
    monkeypatch.setattr(dt, "_fetch_main", lambda root: fetched.append(str(root)))
    client.get("/api/devtest/deploy")
    assert fetched, "the status route must refresh origin/main before comparing against it"


def test_deploy_fetches_before_it_decides_anything(monkeypatch, tmp_path):
    from app.routers import devtest as dt

    _fake_git(monkeypatch)
    monkeypatch.setattr(dt, "_main_root", lambda: tmp_path)
    monkeypatch.setattr(dt, "_device_worktree", lambda: _device_wt(dt, tmp_path))
    order: list[str] = []
    monkeypatch.setattr(dt, "_fetch_main", lambda root: order.append("fetch"))
    monkeypatch.setattr(dt, "_advance_server_checkout",
                        lambda root, defer: order.append("server"))
    dt.deploy()
    assert order[0] == "fetch"          # before anything is compared or moved


def test_deploy_advances_the_worktree_metro_serves_and_the_server_checkout(monkeypatch,
                                                                           tmp_path):
    """Both, not one. The device worktree is where his JS comes from; the server checkout is
    where the BACKEND and — the non-obvious half — the LEDGER the bubble reads come from, so a
    mobile-only change still leaves its new DR row invisible without it."""
    from app.routers import devtest as dt

    device = _device_wt(dt, tmp_path)
    ran = _fake_git(monkeypatch)
    monkeypatch.setattr(dt, "_main_root", lambda: tmp_path)
    monkeypatch.setattr(dt, "_device_worktree", lambda: device)
    monkeypatch.setattr(dt, "_fetch_main", lambda root: None)
    moved: list = []
    monkeypatch.setattr(dt, "_advance_server_checkout",
                        lambda root, defer: moved.append(defer))

    result = dt.deploy()
    # The worktree Metro serves is advanced onto the branch it parks on.
    assert (str(device), ("checkout", "-B", dt.DEVICE_BRANCH, "origin/main")) in ran
    assert moved == [False]             # synchronous off the HTTP path, so failures can raise
    assert result["needs_app_reload"] is True and result["backend_restarting"] is True


def test_the_server_checkout_is_fast_forwarded_never_reset(monkeypatch, tmp_path):
    """`reset --hard origin/main` silently orphaned unpushed commits on local `main` —
    recoverable only through the reflog, and invisible to the dirty check, because git calls
    that tree clean. Fast-forward is non-destructive by construction and fails loudly."""
    from app.routers import devtest as dt

    calls: list[tuple] = []
    monkeypatch.setattr(dt, "_git_try", lambda cwd, *a: (calls.append(a), (True, ""))[1])
    dt._advance_server_checkout(tmp_path, defer=False)
    assert ("checkout", "main") in calls
    assert ("merge", "--ff-only", "origin/main") in calls
    assert not any(a[0] == "reset" for a in calls)


def test_a_failed_fast_forward_is_raised_not_swallowed(monkeypatch, tmp_path):
    from app.routers import devtest as dt

    monkeypatch.setattr(dt, "_git_try",
                        lambda cwd, *a: (True, "") if a[0] == "checkout"
                        else (False, "Not possible to fast-forward"))
    with pytest.raises(dt.DeployError, match="fast-forward"):
        dt._advance_server_checkout(tmp_path, defer=False)


def test_the_deferred_child_is_detached_and_runs_no_shell(monkeypatch, tmp_path):
    """The first cut interpolated the checkout path into `/bin/sh -c`, which broke on a path
    with a space and was one careless edit from being injectable."""
    import subprocess
    import sys

    from app.routers import devtest as dt

    spawned: list = []
    monkeypatch.setattr(subprocess, "Popen", lambda argv, **k: spawned.append((argv, k)))
    dt._advance_server_checkout(tmp_path / "a path with spaces", defer=True)
    argv, kwargs = spawned[0]
    assert argv[0] == sys.executable and argv[1] == "-c"
    assert "/bin/sh" not in argv                        # nothing is shell-parsed
    assert str(tmp_path / "a path with spaces") in argv  # passed as its own argv entry
    assert kwargs["start_new_session"] is True          # the reload cannot interrupt it


def test_the_dirty_check_fails_closed_when_git_cannot_answer(monkeypatch, tmp_path):
    """The next statement after this check moves the tree. `_git_out` returns "" for a clean
    tree AND for a timeout or a corrupt index, so reading "" as clean would run a destructive
    step precisely when the guard was least able to see."""
    from app.routers import devtest as dt

    monkeypatch.setattr(dt, "_git_try", lambda cwd, *a: (False, "index.lock exists"))
    with pytest.raises(dt.DeployError, match="could not determine"):
        dt._assert_clean(tmp_path, "the server checkout")


def test_deploy_refuses_to_discard_uncommitted_work_in_the_server_checkout(monkeypatch,
                                                                          tmp_path):
    """Someone is working in the checkout the server runs from. This is a convenience action;
    it is not worth losing their changes over."""
    from app.routers import devtest as dt

    _fake_git(monkeypatch, dirty=" M app/routers/devtest.py\n")
    monkeypatch.setattr(dt, "_main_root", lambda: tmp_path)
    monkeypatch.setattr(dt, "_device_worktree", lambda: _device_wt(dt, tmp_path))
    monkeypatch.setattr(dt, "_fetch_main", lambda root: None)
    with pytest.raises(dt.DeployError, match="uncommitted"):
        dt.deploy()


def test_a_missing_device_worktree_is_an_error_not_a_silent_success(monkeypatch, tmp_path):
    """A deploy that cannot move the phone's JS is not the thing the button promises. Reporting
    success would send him to reload for a build that never changed."""
    from app.routers import devtest as dt

    _fake_git(monkeypatch)
    monkeypatch.setattr(dt, "_main_root", lambda: tmp_path)
    monkeypatch.setattr(dt, "_device_worktree", lambda: tmp_path / "not-here")
    monkeypatch.setattr(dt, "_fetch_main", lambda root: None)
    with pytest.raises(dt.DeployError, match="no device worktree"):
        dt.deploy()


def test_the_job_guard_is_on_the_work_not_on_the_route(monkeypatch, tmp_path):
    """The dispatched session calls `deploy()` from its OWN process, where the job registries
    are empty — so a guard living on the HTTP route could not protect the default path, and the
    brief's "skip it if a job is live" was an instruction the session could not follow. DR-083
    cost ~50 minutes of a Discover run to exactly this restart."""
    from app.routers import devtest as dt

    _fake_git(monkeypatch)
    monkeypatch.setattr(dt, "_main_root", lambda: tmp_path)
    monkeypatch.setattr(dt, "_device_worktree", lambda: _device_wt(dt, tmp_path))
    monkeypatch.setattr(dt, "_fetch_main", lambda root: None)
    monkeypatch.setattr(dt, "_active_job", lambda force: None if force else "discover")
    with pytest.raises(dt.DeployError, match="discover"):
        dt.deploy()                       # the dispatch's path: refused
    dt.deploy(force=True)                 # the route's path: it already checked


def test_the_cross_process_check_asks_the_server_and_treats_silence_as_idle(monkeypatch):
    """A server that cannot be reached has no jobs to kill, so an unreachable loopback is the
    one thing here that is safe to read as idle."""
    from app.routers import devtest as dt

    monkeypatch.setattr(dt.jobs, "any_active", lambda: None)

    def boom(*a, **k):
        raise OSError("connection refused")

    monkeypatch.setattr("urllib.request.urlopen", boom)
    assert dt._active_job(force=False) is None


def test_backend_restarting_is_true_for_a_diverged_checkout_not_just_a_behind_one(monkeypatch,
                                                                                  tmp_path):
    """A checkout on a feature branch that already contains origin/main is 0 BEHIND, yet moving
    it to main still rewrites app/ and still restarts the worker. Reporting otherwise toasts
    "reload the app" while the backend is coming down."""
    from app.routers import devtest as dt

    _fake_git(monkeypatch, server="feature-sha", target="ccc", server_behind="0")
    monkeypatch.setattr(dt, "_main_root", lambda: tmp_path)
    monkeypatch.setattr(dt, "_device_worktree", lambda: _device_wt(dt, tmp_path))
    monkeypatch.setattr(dt, "_fetch_main", lambda root: None)
    monkeypatch.setattr(dt, "_advance_server_checkout", lambda root, defer: None)
    assert dt.deploy()["backend_restarting"] is True


def test_a_lockfile_change_warns_that_the_bundle_needs_npm_ci(client, monkeypatch, tmp_path):
    """Otherwise a deploy hands him a broken or unchanged bundle with no signal."""
    from app.routers import devtest as dt

    _fake_git(monkeypatch, lockfile="mobile/package-lock.json\n")
    monkeypatch.setattr(dt, "_main_root", lambda: tmp_path)
    monkeypatch.setattr(dt, "_device_worktree", lambda: _device_wt(dt, tmp_path))
    monkeypatch.setattr(dt, "_fetch_main", lambda root: None)
    monkeypatch.setattr(dt.jobs, "any_active", lambda: None)
    assert client.get("/api/devtest/deploy").json()["deploy"]["needs_npm_ci"] is True


def test_deploy_over_http_reports_what_it_did(client, monkeypatch, tmp_path):
    """The happy path, which every other route test here only ever refuses."""
    from app.routers import devtest as dt

    _fake_git(monkeypatch)
    monkeypatch.setattr(dt, "_main_root", lambda: tmp_path)
    monkeypatch.setattr(dt, "_device_worktree", lambda: _device_wt(dt, tmp_path))
    monkeypatch.setattr(dt, "_fetch_main", lambda root: None)
    monkeypatch.setattr(dt, "_advance_server_checkout", lambda root, defer: None)
    monkeypatch.setattr(dt.jobs, "any_active", lambda: None)
    r = client.post("/api/devtest/deploy", json={})
    assert r.status_code == 200
    body = r.json()["deploy"]
    assert body["target"] == "ccc" and body["needs_app_reload"] is True


def test_a_refusal_reads_as_a_conflict_not_a_crash(client, monkeypatch, tmp_path):
    from app.routers import devtest as dt

    _fake_git(monkeypatch)
    monkeypatch.setattr(dt, "_main_root", lambda: tmp_path)
    monkeypatch.setattr(dt.jobs, "any_active", lambda: None)
    monkeypatch.setattr(dt, "_device_worktree", lambda: tmp_path / "not-here")
    r = client.post("/api/devtest/deploy", json={})
    assert r.status_code == 409 and "device worktree" in r.json()["detail"]


def test_deploy_refuses_while_a_background_job_is_running(client, monkeypatch, tmp_path):
    """Advancing the server checkout trips `--reload`, and a reload kills every in-flight job —
    DR-083 cost ~50 minutes of a Discover run exactly that way."""
    from app.routers import devtest as dt

    _fake_git(monkeypatch)
    monkeypatch.setattr(dt, "_main_root", lambda: tmp_path)
    monkeypatch.setattr(dt.jobs, "any_active", lambda: "discover")
    r = client.post("/api/devtest/deploy", json={})
    assert r.status_code == 409
    assert "discover" in r.json()["detail"]


def test_deploy_refuses_while_a_dispatch_is_still_running(client, monkeypatch, tmp_path):
    from app.routers import devtest as dt

    _fake_git(monkeypatch)
    monkeypatch.setattr(dt, "_main_root", lambda: tmp_path)
    monkeypatch.setattr(dt.jobs, "any_active", lambda: None)
    monkeypatch.setattr(dt, "_dispatch_running", lambda: {"id": "dispatch-1"})
    assert client.post("/api/devtest/deploy", json={}).status_code == 409


def test_deploy_is_refused_over_the_public_tunnel(client, monkeypatch, tmp_path):
    """It runs git in the checkout the server serves from — not something a stranger who found
    the tunnel URL should be able to trigger."""
    from app.routers import devtest as dt

    _fake_git(monkeypatch)
    monkeypatch.setattr(dt, "_main_root", lambda: tmp_path)
    r = client.post("/api/devtest/deploy", json={}, headers={"cf-ray": "8a1b2c3d-LHR"})
    assert r.status_code == 403


def test_the_status_route_redacts_host_paths_over_the_tunnel(client, monkeypatch, tmp_path):
    """And does not offer a button for a POST that will always 403 — the same "offered but
    refused" shape the resume flag exists to avoid."""
    from app.routers import devtest as dt

    _fake_git(monkeypatch)
    monkeypatch.setattr(dt, "_main_root", lambda: tmp_path)
    monkeypatch.setattr(dt, "_device_worktree", lambda: _device_wt(dt, tmp_path))
    monkeypatch.setattr(dt, "_fetch_main", lambda root: None)
    monkeypatch.setattr(dt.jobs, "any_active", lambda: None)
    d = client.get("/api/devtest/deploy", headers={"cf-ray": "8a1b-LHR"}).json()["deploy"]
    assert d["deployable"] is False
    assert d["device_worktree"] is None and d["target_subject"] is None
    # Names unmerged work on the dev Mac, same class as the host path beside it.
    assert d["server_branch"] == ""
    assert d["device_behind"] > 0        # state still crosses, so the banner still works


def test_deploy_routes_are_absent_outside_dev(tmp_path, monkeypatch):
    monkeypatch.setenv("RC_DEV", "0")
    monkeypatch.setenv("RC_DEVTEST_DIR", str(tmp_path / "inbox"))
    from app.main import app
    c = TestClient(app)
    assert c.get("/api/devtest/deploy").status_code == 404
    assert c.post("/api/devtest/deploy", json={}).status_code == 404


def test_the_dispatch_brief_ends_on_the_phone_not_at_merged(client, monkeypatch):
    """The loop used to stop at a merged PR, which changes nothing Kamil can see."""
    prompt = next(a for a in _spawn_argv(client, monkeypatch) if "device-feedback" in a)
    assert "DEPLOY it" in prompt and "devtest.deploy()" in prompt
    # The reason a mobile-only change still needs the server checkout moved.
    assert "ledger the bubble reads comes from the server checkout" in prompt
    assert "whether he needs to reload the app" in prompt


# --- deploy review round 2 --------------------------------------------------------------------

class _Resp:
    def __init__(self, body: bytes):
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_the_cross_process_probe_reads_the_running_servers_answer(monkeypatch):
    """The success path, which nothing covered: renaming the `active_job` key would have left
    the whole suite green with the guard dead."""
    from app.routers import devtest as dt

    monkeypatch.setattr(dt.jobs, "any_active", lambda: None)
    seen: list[str] = []

    def urlopen(url, timeout=None):
        seen.append(url)
        return _Resp(b'{"deploy": {"active_job": "discover"}}')

    monkeypatch.setattr("urllib.request.urlopen", urlopen)
    assert dt._active_job(force=False) == "discover"
    # `fetch=0`: the probe must not trigger the route's own git fetch, which is bounded at 20s
    # and would otherwise routinely outlast the probe and be read as "idle".
    assert "fetch=0" in seen[0]


def test_a_server_that_answers_unusably_is_not_read_as_idle(monkeypatch):
    """"Unreachable means no jobs" is true for a refused connection and FALSE for a server that
    answered, just not with the answer. Collapsing them disarmed the DR-083 guard on a 401 (as
    soon as auth is on locally), a 503, or any link slow enough to outlast the probe."""
    import urllib.error

    from app.routers import devtest as dt

    monkeypatch.setattr(dt.jobs, "any_active", lambda: None)

    def raises(exc):
        def urlopen(url, timeout=None):
            raise exc
        return urlopen

    for exc in (urllib.error.HTTPError("u", 401, "Unauthorized", {}, None),
                urllib.error.HTTPError("u", 503, "Unavailable", {}, None),
                TimeoutError("timed out"),
                urllib.error.URLError(TimeoutError("timed out"))):
        monkeypatch.setattr("urllib.request.urlopen", raises(exc))
        with pytest.raises(dt.DeployError, match="refusing rather than restarting it blind"):
            dt._active_job(force=False)

    # A body we cannot make sense of is also "we did not find out".
    monkeypatch.setattr("urllib.request.urlopen", lambda url, timeout=None: _Resp(b'"nope"'))
    with pytest.raises(dt.DeployError):
        dt._active_job(force=False)


def test_a_server_that_is_not_running_is_idle(monkeypatch):
    """The one failure that IS safe to read as idle: nothing listening means nothing running
    means nothing a restart could kill."""
    import urllib.error

    from app.routers import devtest as dt

    monkeypatch.setattr(dt.jobs, "any_active", lambda: None)

    def refused(url, timeout=None):
        raise urllib.error.URLError(ConnectionRefusedError(61, "Connection refused"))

    monkeypatch.setattr("urllib.request.urlopen", refused)
    assert dt._active_job(force=False) is None


def test_the_probe_waits_longer_than_the_endpoint_it_calls(monkeypatch):
    """A probe that gives up before its own endpoint can answer reports idle on every slow
    link, which is the guard failing exactly when the fetch is slowest."""
    from app.routers import devtest as dt

    assert dt.PROBE_TIMEOUT_S > dt.DISPATCH_GIT_TIMEOUT_S


def test_nothing_moves_when_the_server_checkout_could_not_complete(monkeypatch, tmp_path):
    """`checkout main` runs BEFORE `merge --ff-only`, so a refused merge used to leave the
    checkout already moved off its branch — restarting the worker and killing every in-flight
    job, on a deploy that then reported failure. And it happened only after the device worktree
    had been advanced, leaving the phone on new main and the server on old."""
    from app.routers import devtest as dt

    device = _device_wt(dt, tmp_path)
    ran = _fake_git(monkeypatch)
    monkeypatch.setattr(dt, "_main_root", lambda: tmp_path)
    monkeypatch.setattr(dt, "_device_worktree", lambda: device)
    monkeypatch.setattr(dt, "_fetch_main", lambda root: None)
    monkeypatch.setattr(dt, "_assert_server_can_fast_forward", lambda root: (_ for _ in ()).throw(
        dt.DeployError("local main has commits that are not on origin/main")))

    with pytest.raises(dt.DeployError, match="not on origin/main"):
        dt.deploy()
    # The device worktree must NOT have been advanced into a split deployment.
    assert not any(a[0] == "checkout" and "-B" in a for _cwd, a in ran)


def test_local_main_ahead_of_origin_is_refused_before_anything_moves(monkeypatch, tmp_path):
    from app.routers import devtest as dt

    def try_git(cwd, *args):
        if args[:2] == ("rev-parse", "--verify"):
            return True, "localmainsha"
        if args[0] == "merge-base":
            return False, ""            # local main is NOT an ancestor of origin/main
        return True, ""

    monkeypatch.setattr(dt, "_git_try", try_git)
    monkeypatch.setattr(dt, "_git_out", lambda cwd, *a: "main")   # already the deploy target
    with pytest.raises(dt.DeployError, match="cannot be fast-forwarded"):
        dt._assert_server_can_fast_forward(tmp_path)


def test_main_held_by_another_worktree_is_refused(monkeypatch, tmp_path):
    """`git checkout main` fails outright when another worktree holds the branch, and this repo
    habitually runs several."""
    from app.routers import devtest as dt

    listing = (f"worktree {tmp_path}\nHEAD abc\nbranch refs/heads/feature\n\n"
               "worktree /elsewhere/device-main\nHEAD def\nbranch refs/heads/main\n")

    def try_git(cwd, *args):
        if args[:2] == ("rev-parse", "--verify"):
            return False, ""            # no local main; ancestry check is skipped
        if args[0] == "worktree":
            return True, listing
        return True, ""

    monkeypatch.setattr(dt, "_git_try", try_git)
    monkeypatch.setattr(dt, "_git_out", lambda cwd, *a: "main")
    with pytest.raises(dt.DeployError, match="another worktree"):
        dt._assert_server_can_fast_forward(tmp_path)


def test_the_deferred_child_actually_runs_and_fast_forwards(tmp_path):
    """The child is a source STRING executed by `python -c`; the argv test only inspected it, so
    a syntax error or a wrong sys.argv index would have shipped silently."""
    import subprocess
    import sys

    from app.routers import devtest as dt

    origin, work = tmp_path / "origin.git", tmp_path / "work"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(origin)], check=True)
    subprocess.run(["git", "clone", "-q", str(origin), str(work)], check=True)
    git = ["git", "-C", str(work), "-c", "user.email=t@t", "-c", "user.name=t"]
    (work / "f").write_text("one")
    subprocess.run([*git, "add", "-A"], check=True)
    subprocess.run([*git, "commit", "-qm", "one"], check=True)
    subprocess.run([*git, "push", "-q", "origin", "main"], check=True)
    (work / "f").write_text("two")
    subprocess.run([*git, "add", "-A"], check=True)
    subprocess.run([*git, "commit", "-qm", "two"], check=True)
    subprocess.run([*git, "push", "-q", "origin", "main"], check=True)
    subprocess.run([*git, "reset", "-q", "--hard", "HEAD~1"], check=True)
    subprocess.run([*git, "checkout", "-qb", "sidetrack"], check=True)

    record = tmp_path / "deploy-last.json"
    done = subprocess.run([sys.executable, "-c", dt._DEPLOY_CHILD, str(work), str(record)],
                          capture_output=True, text=True, timeout=60)
    assert done.returncode == 0, done.stderr
    assert json.loads(record.read_text())["error"] is None
    head = subprocess.run(["git", "-C", str(work), "rev-parse", "HEAD"],
                          capture_output=True, text=True, check=True).stdout.strip()
    target = subprocess.run(["git", "-C", str(work), "rev-parse", "origin/main"],
                            capture_output=True, text=True, check=True).stdout.strip()
    assert head == target and (work / "f").read_text() == "two"


def test_the_deferred_child_records_a_failure_instead_of_vanishing(tmp_path):
    """Its failures have nowhere else to surface: by the time it runs the response is long sent.
    Silence here would leave the banner saying "behind" forever."""
    import subprocess
    import sys

    from app.routers import devtest as dt

    record = tmp_path / "deploy-last.json"
    done = subprocess.run(
        [sys.executable, "-c", dt._DEPLOY_CHILD, str(tmp_path / "not-a-repo"), str(record)],
        capture_output=True, text=True, timeout=60)
    assert done.returncode == 0                 # it reports, rather than crashing
    assert json.loads(record.read_text())["error"]


def test_a_sibling_worktree_on_a_main_prefixed_branch_does_not_block_deploying(monkeypatch,
                                                                               tmp_path):
    """The holder test is an exact line, not a substring: `mainline` and `main-backup` both
    contain "refs/heads/main", and matching them would refuse every deploy on a repo that keeps
    such a branch checked out somewhere."""
    from app.routers import devtest as dt

    def listing_for(branch: str) -> str:
        return (f"worktree {tmp_path}\nHEAD abc\nbranch refs/heads/feature\n\n"
                f"worktree /elsewhere/wt\nHEAD def\nbranch refs/heads/{branch}\n")

    def make(branch):
        def try_git(cwd, *args):
            if args[:2] == ("rev-parse", "--verify"):
                return False, ""
            if args[0] == "worktree":
                return True, listing_for(branch)
            return True, ""
        return try_git

    monkeypatch.setattr(dt, "_git_out", lambda cwd, *a: "main")
    for benign in ("mainline", "main-backup", "device-main", "feature/main"):
        monkeypatch.setattr(dt, "_git_try", make(benign))
        dt._assert_server_can_fast_forward(tmp_path)      # must not raise

    monkeypatch.setattr(dt, "_git_try", make("main"))
    with pytest.raises(dt.DeployError, match="another worktree"):
        dt._assert_server_can_fast_forward(tmp_path)


# --- readable titles and visible comments (Kamil, 2026-09-02) ---------------------------------

def test_a_triaged_phone_item_shows_his_words_not_the_attribution_around_them():
    """Kamil: "the title for the last few dev test items … start with what appears like some
    formatting or syntax of some sort. I want it clean like the rest." The triage step had been
    writing the source, the provisional id and the route in front of his title, backticks and
    all, so the card led with metadata instead of the issue."""
    row = ("| DR-115 | 2026-09-01 | Kamil (bubble, provisional id `NEW-1788274884`, "
           "`/paper/chime`): \"Advanced chat navigation controls\" — \"I would like an option "
           "in settings\" | `open` | Evidence. |")
    item = devtest.parse_ledger(f"|---|\n{row}")[0]
    assert item["title"] == "Advanced chat navigation controls"
    # DR-097's link between the phone item and the row it became is read from the RAW text, so
    # cleaning the display must not cost the alias.
    assert item["aliases"] == ["NEW-1788274884"]


def test_the_annotation_after_his_words_is_not_part_of_the_title():
    """Rows carry a triager's aside after the quote — "(description empty; his screenshot is …)"
    — which belongs in the evidence column, not in front of him on a card."""
    row = ("| DR-116 | 2026-09-01 | Kamil (bubble, provisional id `NEW-1788308416`, route `/`): "
           "\"Dev test bubble shows 11 of 117\" (description empty; his screenshot is the "
           "Library screen) | `open` | Evidence. |")
    assert devtest.parse_ledger(f"|---|\n{row}")[0]["title"] == "Dev test bubble shows 11 of 117"


def test_the_attribution_is_recognised_in_every_shape_the_ledger_uses():
    """The parenthetical varies — "bubble, provisional id …", "chat", "on DR-091's fail" — and
    is sometimes absent entirely (DR-075, DR-079), which the EMULATOR pass is what caught: the
    unit tests only had the bracketed shape because that was the one I had gone looking for."""
    for lead in ("Kamil (chat): ", "Kamil (bubble, provisional id `NEW-1`, `/x`): ",
                 "Kamil (on DR-091's fail, filed under its provisional id): ", "Kamil: "):
        row = f"| DR-900 | 2026-09-01 | {lead}\"The actual thing\" | `open` | E. |"
        assert devtest.parse_ledger(f"|---|\n{row}")[0]["title"] == "The actual thing", lead


def test_attribution_followed_by_prose_loses_the_prefix_and_keeps_the_prose():
    """DR-093 is `Kamil: the paper's "Reference graph" option loaded the full Map…` — the quote
    is mid-sentence, so taking the first quoted run would leave two words. Strip the prefix,
    keep everything after it."""
    row = ("| DR-093 | 2026-08-01 | Kamil: the paper's \"Reference graph\" option loaded the "
           "full Map. | `open` | E. |")
    assert devtest.parse_ledger(f"|---|\n{row}")[0]["title"] == (
        "the paper's \"Reference graph\" option loaded the full Map.")


def test_a_title_that_merely_has_a_colon_keeps_its_subject():
    """The tempting generalisation — strip any capitalised word before a colon — would eat the
    subject of a perfectly good title. The reporter's NAME is the discriminator."""
    for text in ('Discover: "no results" state is confusing',
                 "The immersive discussion canvas itself (#413, merged 2026-08-21): full-bleed."):
        row = f"| DR-901 | 2026-08-01 | {text} | `open` | E. |"
        assert devtest.parse_ledger(f"|---|\n{row}")[0]["title"] == text


def test_ordinary_prose_rows_are_returned_untouched():
    """Most of the ledger was always fine, and a title cleaner that rewords those is worse than
    the problem. Anything without the attribution shape comes back byte-identical — including
    prose that merely opens with a capitalised word and a bracket."""
    for text in ("Toast notifications (`mobile/src/ui/Toast.tsx`) are absolutely positioned.",
                 "The immersive discussion canvas itself (#413, merged 2026-08-21): full-bleed.",
                 "Opening the keyboard hides the mini player (comment mode enabled)."):
        row = f"| DR-901 | 2026-08-01 | {text} | `open` | E. |"
        assert devtest.parse_ledger(f"|---|\n{row}")[0]["title"] == text


def test_an_unterminated_quote_still_loses_the_attribution():
    """A row someone hand-edited into a broken shape should still read better, not blow up."""
    row = ("| DR-902 | 2026-09-01 | Kamil (chat): \"a thought he never closed | `open` | E. |")
    assert devtest.parse_ledger(f"|---|\n{row}")[0]["title"] == "a thought he never closed"


def test_an_inner_quote_never_truncates_the_title():
    """The quoted-run pattern stops at the first closing quote, and his own words routinely
    contain one — his keyboard emits smart quotes and he quotes UI labels constantly. Cutting
    there produced a one-word title, silently, and made the row unfindable by title search."""
    row = ('| DR-903 | 2026-09-02 | Kamil (chat): "the "Done" button does nothing" '
           '| `open` | E. |')
    assert devtest.parse_ledger(f"|---|\n{row}")[0]["title"] == 'the "Done" button does nothing'


def test_a_smart_quoted_label_keeps_both_of_its_quotes():
    """Set-stripping the wrapper ate the opening smart quote with it, so only ONE character
    comes off each end."""
    row = '| DR-904 | 2026-09-02 | Kamil (chat): "“Done” does nothing" | `open` | E. |'
    assert devtest.parse_ledger(f"|---|\n{row}")[0]["title"] == "“Done” does nothing"


def test_a_title_is_never_emptied():
    """A blank title is a card with no subject and an accessibility label reading "DR-9xx: ."."""
    row = '| DR-905 | 2026-09-02 | Kamil (chat): "   " | `open` | E. |'
    assert devtest.parse_ledger(f"|---|\n{row}")[0]["title"].strip()


def test_the_quoted_run_is_only_taken_when_an_ASIDE_follows_it():
    """What may follow his words is the triager's annotation, never more of his sentence."""
    for tail, expected in ((' — "his longer description"', "His words"),
                           (' Description: "and the rest of it"', "His words"),
                           (' (description empty; screenshot below)', "His words"),
                           (' [screenshot](assets/x.jpg)', "His words"),
                           ('', "His words")):
        row = f'| DR-906 | 2026-09-02 | Kamil (chat): "His words"{tail} | `open` | E. |'
        assert devtest.parse_ledger(f"|---|\n{row}")[0]["title"] == expected, tail

def test_deploy_refuses_to_switch_a_checkout_someone_is_working_in(monkeypatch, tmp_path):
    """The first cut ran `git checkout main` to move the server checkout onto main, which yanked
    the working tree out from under whoever was using it. It refused on a DIRTY tree, but a
    committed feature branch is clean, so the common case — a session mid-PR — sailed straight
    through and lost its checkout.

    The settled pattern in agent-parallel tooling is one worktree per ROLE: never develop in the
    tree you deploy to. This repo already does that for Metro and for dispatched sessions."""
    from app.routers import devtest as dt

    monkeypatch.setattr(dt, "_git_out",
                        lambda cwd, *a: "some-feature-branch" if a[:2] == ("rev-parse",
                                                                           "--abbrev-ref") else "")
    with pytest.raises(dt.DeployError, match="not main"):
        dt._assert_server_can_fast_forward(tmp_path)


def test_the_branch_guard_does_not_raise_on_main(monkeypatch, tmp_path):
    """The normal state, and it must stay cheap: refusing here would make every dispatch's
    deploy step fail."""
    from app.routers import devtest as dt

    monkeypatch.setattr(dt, "_git_out",
                        lambda cwd, *a: "main" if a[:2] == ("rev-parse", "--abbrev-ref") else "")
    monkeypatch.setattr(dt, "_git_try", lambda cwd, *a: (False, "") if a[:2] == (
        "rev-parse", "--verify") else (True, ""))
    dt._assert_server_can_fast_forward(tmp_path)     # must not raise


def test_nothing_moves_when_the_server_checkout_is_off_main(monkeypatch, tmp_path):
    """The ordering property, which the direct-call tests cannot see. An earlier round of this
    series shipped a refusal that fired only AFTER the device worktree had been advanced,
    leaving the phone on new main and the server on old — so the guard has to be proved to
    happen before anything moves, not merely to happen."""
    from app.routers import devtest as dt

    device = _device_wt(dt, tmp_path)
    ran = _fake_git(monkeypatch)
    monkeypatch.setattr(dt, "_main_root", lambda: tmp_path)
    monkeypatch.setattr(dt, "_device_worktree", lambda: device)
    monkeypatch.setattr(dt, "_fetch_main", lambda root: None)
    real_out = dt._git_out
    monkeypatch.setattr(dt, "_git_out",
                        lambda cwd, *a: ("some-feature-branch"
                                         if a[:2] == ("rev-parse", "--abbrev-ref")
                                         else real_out(cwd, *a)))
    ran.clear()
    with pytest.raises(dt.DeployError, match="not main"):
        dt.deploy()
    assert not [a for _cwd, a in ran if a[0] in ("checkout", "merge", "reset", "stash")], (
        "the refusal must happen before anything is moved")


def test_the_refusal_names_a_detached_head_as_one(monkeypatch, tmp_path):
    """`'HEAD'` is not a branch, and CLAUDE.md describes re-detaching the live checkout as a
    thing that happens; quoting it as a branch name reads as nonsense."""
    from app.routers import devtest as dt

    monkeypatch.setattr(dt, "_git_out", lambda cwd, *a: "HEAD")
    with pytest.raises(dt.DeployError, match="a detached HEAD"):
        dt._assert_server_can_fast_forward(tmp_path)

    monkeypatch.setattr(dt, "_git_out", lambda cwd, *a: "")
    with pytest.raises(dt.DeployError, match="unreadable"):
        dt._assert_server_can_fast_forward(tmp_path)


def test_the_status_route_reports_which_branch_the_server_checkout_is_on(client, monkeypatch,
                                                                         tmp_path):
    """So the banner can say "cannot deploy" instead of offering a button that always 409s."""
    from app.routers import devtest as dt

    _fake_git(monkeypatch)
    monkeypatch.setattr(dt, "_main_root", lambda: tmp_path)
    monkeypatch.setattr(dt, "_device_worktree", lambda: _device_wt(dt, tmp_path))
    monkeypatch.setattr(dt, "_fetch_main", lambda root: None)
    monkeypatch.setattr(dt.jobs, "any_active", lambda: None)
    assert client.get("/api/devtest/deploy").json()["deploy"]["server_branch"] == "main"
