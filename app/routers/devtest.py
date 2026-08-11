"""The in-app device-test companion (DR-060): the dev-only feedback loop between Kamil's phone
and the coding agent.

Device passes were a copy-paste affair — test on the phone, type findings into chat later, lose
the screen context. This router lets the app itself show the device-review ledger's items (what
to test and how), record pass/fail/remark verdicts with optional comments and screenshots at the
moment of testing, and open new items — all persisted where the coding agent works.

**Dev-only, by the same flag the client gates on.** Every route 404s unless `config.dev_mode()`
(RC_DEV): the feature reads the repo's own ledger and writes to the repo checkout, which only
exists on the dev machine. Production never has these routes in any discoverable form — 404, not
403, because outside dev the surface does not exist.

**Storage is the agent's inbox, not the record.** Feedback appends to
`.dev-feedback/feedback.jsonl` (screenshots beside it), gitignored: it is WORKING INPUT for the
`/device-feedback` skill, which triages entries into the device-review ledger — the one durable
record — and advances a cursor. The app never writes the ledger itself: the same "agent proposes
into the record, deliberately" boundary as everywhere else, so a mis-tap on the phone cannot
rewrite history.

The ledger parser here is deliberately tolerant and read-only: one row per `| DR-xxx | ... |`
line. If the ledger's shape drifts, items drop out of the app rather than erroring — the
authoritative file wins.
"""
from __future__ import annotations

import base64
import binascii
import json
import re
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import config, logging_config
from ..fileio import atomic_write_text

log = logging_config.get("devtest")

router = APIRouter()

#: Repo root — this file is app/routers/devtest.py. The dev server runs from a checkout, which
#: is the whole premise of the feature (RC_DEVTEST_DIR overrides for tests).
_REPO_ROOT = Path(__file__).resolve().parents[2]
_LEDGER = _REPO_ROOT / "docs" / "device-review-ledger.md"

#: A screenshot is one phone screen; 8 MB of base64 is already generous.
MAX_SCREENSHOT_B64 = 8_000_000

_ROW_RE = re.compile(
    r"^\|\s*(DR-\d+)\s*\|\s*([0-9-]+)\s*\|\s*(.+?)\s*\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|\s*$"
)

#: States the tester acts on, in the order the app should surface them.
OPEN_STATES = ("open", "partial", "planned")
VERIFY_STATE = "implemented — verify"


def _dir() -> Path:
    import os

    override = os.environ.get("RC_DEVTEST_DIR")
    d = Path(override) if override else _REPO_ROOT / ".dev-feedback"
    d.mkdir(parents=True, exist_ok=True)
    (d / "screenshots").mkdir(exist_ok=True)
    return d


def _require_dev() -> None:
    if not config.dev_mode():
        raise HTTPException(status_code=404, detail="Not found")


def parse_ledger(text: str) -> list[dict]:
    items = []
    for line in text.splitlines():
        m = _ROW_RE.match(line)
        if not m:
            continue
        item_id, raised, feedback, state, evidence = m.groups()
        items.append({
            "id": item_id,
            "raised": raised,
            "title": feedback,
            "state": state,
            # The evidence column is where "what to test and how" lives — verify steps are
            # written there by convention (the ledger's own workflow section says so).
            "how_to_test": evidence,
        })
    return items


def _feedback_path() -> Path:
    return _dir() / "feedback.jsonl"


def _read_feedback() -> list[dict]:
    p = _feedback_path()
    if not p.exists():
        return []
    out = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue  # a torn write loses one entry, never the file
    return out


def _append_feedback(entry: dict) -> dict:
    entry = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), **entry}
    p = _feedback_path()
    with p.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return entry


@router.get("/api/devtest/items")
def list_items():
    """Every ledger row plus app-created items not yet triaged into the ledger, with the
    tester-facing ordering hint (open → verify → the rest) left to the client."""
    _require_dev()
    try:
        items = parse_ledger(_LEDGER.read_text(encoding="utf-8"))
    except OSError:
        items = []
    known = {i["id"] for i in items}
    for entry in _read_feedback():
        if entry.get("kind") == "new_item" and entry.get("id") not in known:
            items.append({
                "id": entry["id"], "raised": entry["ts"][:10],
                "title": entry.get("title") or "(untitled)",
                "state": "new — untriaged",
                "how_to_test": entry.get("description") or "",
            })
            known.add(entry["id"])
    counts: dict[str, int] = {}
    for entry in _read_feedback():
        if entry.get("kind") == "feedback" and entry.get("item_id"):
            counts[entry["item_id"]] = counts.get(entry["item_id"], 0) + 1
    for item in items:
        item["feedback_count"] = counts.get(item["id"], 0)
    return {"items": items}


class NewItemReq(BaseModel):
    title: str
    description: str | None = None


@router.post("/api/devtest/items")
def create_item(req: NewItemReq):
    """A new issue raised from the device. It gets a LOCAL id (`NEW-<epoch>`); the triage skill
    assigns the real DR number when it writes the ledger row — the app never edits the ledger."""
    _require_dev()
    title = req.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="A title is required.")
    entry = _append_feedback({
        "kind": "new_item",
        "id": f"NEW-{int(time.time())}",
        "title": title[:300],
        "description": (req.description or "").strip()[:2000],
    })
    return {"item": {"id": entry["id"], "title": entry["title"],
                     "state": "new — untriaged", "raised": entry["ts"][:10],
                     "how_to_test": entry.get("description", ""), "feedback_count": 0}}


class FeedbackReq(BaseModel):
    item_id: str
    #: 'pass' | 'fail' | 'remark' — remark is a comment with no verdict.
    verdict: str
    comment: str | None = None
    #: The app route the tester was on when the screenshot was grabbed — free context the
    #: agent otherwise has to ask for.
    route: str | None = None
    screenshot_b64: str | None = None


@router.post("/api/devtest/feedback")
def record_feedback(req: FeedbackReq):
    _require_dev()
    if req.verdict not in ("pass", "fail", "remark"):
        raise HTTPException(status_code=400, detail="verdict must be pass, fail or remark")
    comment = (req.comment or "").strip()
    if req.verdict == "remark" and not comment:
        raise HTTPException(status_code=400, detail="A remark needs a comment.")
    shot_path = None
    if req.screenshot_b64:
        if len(req.screenshot_b64) > MAX_SCREENSHOT_B64:
            raise HTTPException(status_code=400, detail="Screenshot too large.")
        try:
            raw = base64.b64decode(req.screenshot_b64, validate=True)
        except (binascii.Error, ValueError) as e:
            raise HTTPException(status_code=400, detail="Screenshot is not valid base64.") from e
        safe_item = re.sub(r"[^A-Za-z0-9-]", "_", req.item_id)[:40]
        name = f"{time.strftime('%Y%m%d-%H%M%S')}-{safe_item}.png"
        (_dir() / "screenshots" / name).write_bytes(raw)
        shot_path = f".dev-feedback/screenshots/{name}"
    entry = _append_feedback({
        "kind": "feedback",
        "item_id": req.item_id,
        "verdict": req.verdict,
        "comment": comment[:4000],
        "route": (req.route or "")[:200],
        "screenshot": shot_path,
    })
    log.info("devtest %s on %s%s", req.verdict, req.item_id,
             " +screenshot" if shot_path else "")
    return {"entry": entry}


@router.get("/api/devtest/feedback")
def list_feedback(item_id: str | None = None):
    """Prior entries — so closed items can be revisited and commented on later with their
    history visible."""
    _require_dev()
    entries = [e for e in _read_feedback() if e.get("kind") == "feedback"]
    if item_id:
        entries = [e for e in entries if e.get("item_id") == item_id]
    return {"entries": entries[-200:]}


def _cursor_path() -> Path:
    return _dir() / "processed-through"


@router.get("/api/devtest/status")
def status():
    """How much feedback awaits triage — the skill advances the cursor when it processes."""
    _require_dev()
    cursor = ""
    p = _cursor_path()
    if p.exists():
        cursor = p.read_text(encoding="utf-8").strip()
    pending = [e for e in _read_feedback() if e.get("ts", "") > cursor]
    return {"pending": len(pending), "processed_through": cursor or None}


def mark_processed_through(ts: str) -> None:
    """For the triage skill (via a tiny script), not HTTP: advance the cursor."""
    atomic_write_text(_cursor_path(), ts)
