"""The per-project discovery ledger: what we have seen, what we judged, and how far we swept.

Discovery used to persist only its latest *output*, so every run re-paid for the same reasoning
over the same papers. The ledger is the memory that makes a second run cheap and a long horizon
affordable: one entry per candidate identity, carrying the cheap-model verdicts and the
provenance that produced them.

Two properties are load-bearing:

**A cached verdict is only reusable when the thing that produced it is unchanged.** Every stored
judgement records the model id AND a hash of the project profile it was judged against. A model
swap or a goals edit must invalidate judgements rather than silently reuse them — an auto-moving
model alias re-pricing or re-deciding cached rows is exactly the failure this guards
(see `app/routers/catalogue.py` on why a family alias must never be the cache key).

**A corrupt ledger costs money, not correctness.** Losing it means re-screening, which is
recoverable; silently trusting half of it is not. A file that will not parse is renamed aside and
replaced, and the run records that it happened.

The frontier block records how far each recall channel has swept, so an incremental run asks for
`from_publication_date` instead of re-walking a decade.

Hides are NOT stored here. `discovery.load_hidden` remains the source of truth for what a reader
dismissed; this module reads it. That feature works, and migrating it would risk a regression for
no gain.
"""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from typing import Any

from . import config, logging_config
from .fileio import atomic_write_text

log = logging_config.get("discovery.ledger")

LEDGER_VERSION = 1

#: A candidate we have never judged. Distinguishes "no entry" from "entry with a null verdict".
_MISSING = object()


def ledger_path() -> Path:
    return config.state_dir() / "discovery-ledger.json"


def profile_hash(goals: str, extra: str = "") -> str:
    """Identity of the judging context. Two runs may share cached verdicts only when this matches.

    Deliberately short: it is stored on every entry, and 12 hex chars is ~48 bits — far past
    collision risk for one project's run history, while keeping the file readable.
    """
    payload = f"{(goals or '').strip()}\x00{(extra or '').strip()}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]


def _empty() -> dict:
    return {"version": LEDGER_VERSION, "entries": {}, "frontier": {}}


def load() -> dict:
    """The ledger, or a fresh empty one. Never raises, never returns a partially-trusted file."""
    path = ledger_path()
    if not path.exists():
        return _empty()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError, UnicodeDecodeError) as e:
        return _quarantine(path, f"{type(e).__name__}: {e}")
    if not isinstance(data, dict) or data.get("version") != LEDGER_VERSION:
        # A version we do not understand is not corruption — drop it quietly and re-earn it.
        return _empty()
    entries = data.get("entries")
    frontier = data.get("frontier")
    return {
        "version": LEDGER_VERSION,
        "entries": entries if isinstance(entries, dict) else {},
        "frontier": frontier if isinstance(frontier, dict) else {},
    }


def _quarantine(path: Path, why: str) -> dict:
    """Rename a corrupt ledger aside and start fresh, loudly.

    Renaming rather than overwriting matters: the file is the only record of what we already paid
    to judge, so if the corruption turns out to be recoverable by hand, the bytes still exist.
    """
    fresh = _empty()
    try:
        backup = path.with_suffix(f".bak-{int(time.time())}")
        path.rename(backup)
        log.warning("discovery ledger unreadable (%s); moved to %s and starting fresh",
                    why, backup.name)
        fresh["degraded"] = f"ledger unreadable ({why}); moved to {backup.name}"
    except OSError as e:
        log.warning("discovery ledger unreadable (%s) and could not be moved aside (%s)", why, e)
        fresh["degraded"] = f"ledger unreadable ({why}); could not preserve it ({e})"
    return fresh


def save(ledger: dict) -> None:
    """Persist atomically. A crash mid-write must not produce the corrupt file `load` guards."""
    payload = {
        "version": LEDGER_VERSION,
        "entries": ledger.get("entries") or {},
        "frontier": ledger.get("frontier") or {},
    }
    atomic_write_text(ledger_path(), json.dumps(payload, indent=2, ensure_ascii=False))


# ---------- entries ----------

def get(ledger: dict, key: str) -> dict | None:
    entry = (ledger.get("entries") or {}).get(key)
    return entry if isinstance(entry, dict) else None


def observe(ledger: dict, key: str, candidate: dict, channel: str, today: str) -> dict:
    """Record that `key` was seen again, from `channel`. Returns the (possibly new) entry."""
    entries = ledger.setdefault("entries", {})
    entry = entries.get(key)
    if not isinstance(entry, dict):
        entry = {"title": str(candidate.get("title") or "")[:300],
                 "first_seen": today, "times_seen": 0, "channels": [], "status": "new"}
        entries[key] = entry
    entry["last_seen"] = today
    entry["times_seen"] = int(entry.get("times_seen") or 0) + 1
    if channel and channel not in entry.get("channels", []):
        entry.setdefault("channels", []).append(channel)
    if not entry.get("title") and candidate.get("title"):
        entry["title"] = str(candidate["title"])[:300]
    return entry


def record_cheap_verdict(entry: dict, *, verdict: str, tag: str, model: str,
                         profile: str, today: str) -> None:
    entry["cheap"] = {"verdict": verdict, "tag": tag, "model": model,
                      "profile_hash": profile, "at": today}


def record_abstract_score(entry: dict, *, relevance: int, role: str, model: str,
                          profile: str, today: str) -> None:
    entry["abstract"] = {"relevance": relevance, "role": role, "model": model,
                         "profile_hash": profile, "at": today}


def cached_cheap_drop(entry: dict | None, *, model: str, profile: str) -> bool:
    """Whether this candidate was already rejected by an equivalent cheap screen.

    Requires BOTH the model and the profile to match. A cheaper check (verdict alone) would make
    a model upgrade or a goals rewrite invisible, permanently burying papers that the new
    configuration would have kept — and the user would have no way to tell.
    """
    if not entry:
        return False
    cheap = entry.get("cheap")
    if not isinstance(cheap, dict):
        return False
    return (cheap.get("verdict") == "D"
            and cheap.get("model") == model
            and cheap.get("profile_hash") == profile)


def mark_surfaced(entry: dict, when: str) -> None:
    surfaced = entry.setdefault("surfaced_in", [])
    if isinstance(surfaced, list):
        surfaced.append(when)
        del surfaced[:-10]   # the last 10 are enough to spot a paper we keep re-showing


def set_status(ledger: dict, key: str, status: str) -> None:
    entry = get(ledger, key)
    if entry is not None:
        entry["status"] = status


# ---------- frontier ----------

def swept_to(ledger: dict, channel_key: str) -> str | None:
    """The last date this channel was swept to, or None if it never has been."""
    row = (ledger.get("frontier") or {}).get(channel_key)
    if isinstance(row, dict):
        value = row.get("swept_to")
        return value if isinstance(value, str) and value else None
    return None


def record_sweep(ledger: dict, channel_key: str, *, swept_to: str, **extra: Any) -> None:
    frontier = ledger.setdefault("frontier", {})
    row = frontier.setdefault(channel_key, {})
    row["swept_to"] = swept_to
    row.update(extra)
