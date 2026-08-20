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
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import config, logging_config
from ..fileio import atomic_write_text

log = logging_config.get("devtest")

router = APIRouter()

#: This file is app/routers/devtest.py; its checkout root is two levels up. The LEDGER is read
#: from this checkout (the running server's code and its ledger travel together), but the
#: feedback INBOX must not be checkout-relative: the dev server runs from the main checkout
#: while the agent triages from a PR worktree, and a worktree-relative inbox means the agent
#: reads an empty directory and writes a cursor the server never sees — silent in both
#: directions. `_main_root()` resolves the git COMMON directory's parent, which is the same
#: main checkout from every worktree. RC_DEVTEST_DIR overrides for tests.
_REPO_ROOT = Path(__file__).resolve().parents[2]
_LEDGER = _REPO_ROOT / "docs" / "device-review-ledger.md"


def _main_root() -> Path:
    import subprocess

    try:
        out = subprocess.run(
            ["git", "-C", str(_REPO_ROOT), "rev-parse", "--path-format=absolute",
             "--git-common-dir"],
            capture_output=True, text=True, timeout=5,
        )
        if out.returncode == 0 and out.stdout.strip():
            return Path(out.stdout.strip()).parent
    except (OSError, subprocess.SubprocessError):
        pass
    return _REPO_ROOT

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
    d = Path(override) if override else _main_root() / ".dev-feedback"
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
    from datetime import UTC, datetime

    # UTC with microseconds: a naive local timestamp made two same-second entries share a ts
    # (the strict-> cursor then skipped the second) and let a DST step-back hide an hour of
    # feedback behind an already-advanced cursor.
    entry = {"ts": datetime.now(UTC).isoformat(), **entry}
    p = _feedback_path()
    # A torn append ends mid-line WITHOUT a newline; blindly appending welds the next entry
    # onto the fragment and loses both. Check the last byte first (append handles are not
    # readable) and heal with a leading newline.
    needs_newline = False
    if p.exists() and p.stat().st_size:
        with p.open("rb") as r:
            r.seek(-1, 2)
            needs_newline = r.read(1) != b"\n"
    with p.open("ab") as f:
        if needs_newline:
            f.write(b"\n")
        # ensure_ascii: U+2028/U+2029/NEL are line separators to str.splitlines(); left raw
        # they split one entry into unreadable fragments — a 200 that silently lost the input.
        f.write((json.dumps(entry, ensure_ascii=True) + "\n").encode("utf-8"))
    return entry


@router.get("/api/devtest/items")
def list_items():
    """Every ledger row plus app-created items not yet triaged into the ledger, with the
    tester-facing ordering hint (open → verify → the rest) left to the client."""
    _require_dev()
    try:
        items = parse_ledger(_LEDGER.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError):
        items = []
    known = {i["id"] for i in items}
    inbox = _read_feedback()
    for entry in inbox:
        if entry.get("kind") == "new_item" and entry.get("id") not in known:
            items.append({
                "id": entry["id"], "raised": entry["ts"][:10],
                "title": entry.get("title") or "(untitled)",
                "state": "new — untriaged",
                "how_to_test": entry.get("description") or "",
            })
            known.add(entry["id"])
    counts: dict[str, int] = {}
    response_counts: dict[str, int] = {}
    for entry in inbox:
        if entry.get("kind") == "feedback" and entry.get("item_id"):
            counts[entry["item_id"]] = counts.get(entry["item_id"], 0) + 1
        elif entry.get("kind") == "response" and entry.get("item_id"):
            response_counts[entry["item_id"]] = response_counts.get(entry["item_id"], 0) + 1
    for item in items:
        item["feedback_count"] = counts.get(item["id"], 0)
        # DR-080: an agent reply is the signal the tester can decide pass/close from — the
        # card surfaces its presence without having to open the history first.
        item["response_count"] = response_counts.get(item["id"], 0)
    return {"items": items}


def _save_screenshot(b64: str, item_id: str) -> tuple[str | None, str | None]:
    """Decode, validate and persist one screenshot. Returns (repo-relative path, error) —
    exactly one of the two is set. A bad image is an error string, never an exception: the
    tester's words must be recorded regardless of the pixels (both callers rely on that)."""
    raw = b""
    if len(b64) > MAX_SCREENSHOT_B64:
        return None, "screenshot too large"
    try:
        raw = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError):
        return None, "screenshot not valid base64"
    # Image magic only (PNG/JPEG/WebP): this is an open-auth dev server reachable over the
    # tunnel, and an arbitrary-bytes sink named .png is a write primitive nobody needs.
    if not (raw[:8] == b"\x89PNG\r\n\x1a\n" or raw[:3] == b"\xff\xd8\xff"
            or raw[:4] == b"RIFF"):
        return None, "screenshot is not an image"
    if raw[:4] == b"RIFF" and raw[8:12] != b"WEBP":
        # RIFF alone admits WAV/AVI/anything in a RIFF envelope, not just WebP.
        return None, "screenshot is not an image"
    safe_item = re.sub(r"[^A-Za-z0-9-]", "_", item_id)[:40]
    # A uuid suffix: one capture attached to several remarks in the same second must
    # not overwrite — a screenshot field pointing at someone else's pixels is worse
    # for triage than none.
    name = (f"{time.strftime('%Y%m%d-%H%M%S')}-{safe_item}-"
            f"{uuid.uuid4().hex[:6]}.png")
    try:
        (_dir() / "screenshots" / name).write_bytes(raw)
    except OSError as e:
        # Disk full / permissions: the caller records the entry with this in place — a 500
        # here would discard the tester's words, the one thing this helper must never do.
        return None, f"screenshot write failed: {e}"
    return f".dev-feedback/screenshots/{name}", None


class NewItemReq(BaseModel):
    title: str
    description: str | None = None
    #: DR-088: a screenshot belongs on the issue at creation. Making it a second step (a
    #: remark after creating) is what caused the accidental Pass verdicts.
    screenshot_b64: str | None = None
    route: str | None = None


@router.post("/api/devtest/items")
def create_item(req: NewItemReq):
    """A new issue raised from the device. It gets a LOCAL id (`NEW-<epoch>`); the triage skill
    assigns the real DR number when it writes the ledger row — the app never edits the ledger."""
    _require_dev()
    title = req.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="A title is required.")
    new_id = f"NEW-{int(time.time())}"
    shot_path = shot_error = None
    if req.screenshot_b64:
        shot_path, shot_error = _save_screenshot(req.screenshot_b64, new_id)
    entry = _append_feedback({
        "kind": "new_item",
        "id": new_id,
        "title": title[:300],
        "description": (req.description or "").strip()[:2000],
        "route": (req.route or "")[:200],
        "screenshot": shot_path,
        **({"screenshot_error": shot_error} if shot_error else {}),
    })
    # The screenshot outcome rides the response so the client's confirmation can be honest —
    # a toast claiming "with screenshot" from request intent hides a dropped image.
    return {"item": {"id": entry["id"], "title": entry["title"],
                     "state": "new — untriaged", "raised": entry["ts"][:10],
                     "how_to_test": entry.get("description", ""), "feedback_count": 0},
            "screenshot": shot_path,
            **({"screenshot_error": shot_error} if shot_error else {})}


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
    # The verdict and comment are the reader's input; a bad IMAGE must never discard them.
    # A screenshot failure records the entry anyway, with the reason in its place.
    shot_path = shot_error = None
    if req.screenshot_b64:
        shot_path, shot_error = _save_screenshot(req.screenshot_b64, req.item_id)
    # DR-088: a screenshot IS a remark — requiring words on top of it pushed the tester toward
    # whichever button didn't complain, which is how issues got accidental Pass verdicts.
    # Gated on the SAVED screenshot, not the request field: a remark whose only content failed
    # validation has no words to lose, so refusing it loses nothing — while recording it would
    # append a contentless entry and tell the tester their evidence landed when it didn't.
    if req.verdict == "remark" and not comment and not shot_path:
        detail = (f"The screenshot did not land ({shot_error}); a remark needs a comment "
                  "or a screenshot." if shot_error
                  else "A remark needs a comment or a screenshot.")
        raise HTTPException(status_code=400, detail=detail)
    entry = _append_feedback({
        "kind": "feedback",
        "item_id": req.item_id,
        "verdict": req.verdict,
        "comment": comment[:4000],
        "route": (req.route or "")[:200],
        "screenshot": shot_path,
        **({"screenshot_error": shot_error} if shot_error else {}),
    })
    log.info("devtest %s on %s%s", req.verdict, req.item_id,
             " +screenshot" if shot_path else "")
    return {"entry": entry}


@router.get("/api/devtest/feedback")
def list_feedback(item_id: str | None = None):
    """Prior entries — so closed items can be revisited and commented on later with their
    history visible. Includes the agent's `response` entries (DR-080): triage answers —
    diagnosis, "fixed in PR #N", "split into DR-0XX, this can close" — interleave with the
    tester's own notes so the pass/close decision can be made from the phone."""
    _require_dev()
    entries = [e for e in _read_feedback() if e.get("kind") in ("feedback", "response")]
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


def append_response(item_id: str, text: str) -> dict:
    """For the triage skill, not HTTP (DR-080): record the agent's answer to an item's
    feedback — diagnosis, "fixed in PR #N", "split into DR-0XX, this one can close" — so it
    shows up under the item in the phone's bubble and Kamil can decide pass/close from there.

    Deliberately filesystem-side like `mark_processed_through`: the dev server is reachable
    over an open-auth tunnel, and an HTTP write that impersonates the agent's voice is a
    forgery primitive nobody needs. The agent has the checkout; it writes where it stands.
    Markdown is expected — the client renders it formatted.
    """
    item_id = item_id.strip()
    text = text.strip()
    if not item_id or not text:
        raise ValueError("append_response needs a non-empty item_id and text")
    return _append_feedback({
        "kind": "response",
        "item_id": item_id[:40],
        "text": text[:8000],
    })
