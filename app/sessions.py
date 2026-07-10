"""Session state, transcript logs, and clean pause/resume (Section 9). One logical session
per paper: turns are appended to sessions/<slug>.jsonl, and a small index in
.state/sessions.json tracks the transient working state so a paper can sit in discussion for
days across many short sessions and resume server-side without losing context.

The giant opening message (paper full text) is NOT stored in the transcript — it is
regenerated from the cached corpus text when reconstructing history, keeping logs compact.
"""
from __future__ import annotations

import hashlib
import json
import threading
from datetime import UTC, datetime

from . import config, prompts, store
from .fileio import atomic_write_text
from .models import COMMITTED, IN_DISCUSSION, NOTES_DRAFTED, REVIEW_SLUG, Turn

# sessions.json is a read/modify/write index shared by chat-job threads and request handlers.
# A single-process lock matches the deployment model documented in CLAUDE.md and prevents one
# project/session update from silently overwriting another update based on a stale read.
_index_lock = threading.RLock()


def _sessions_dir():
    return config.project_dir() / "sessions"


def _index_file():
    return config.state_dir() / "sessions.json"


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _load_index_unlocked() -> dict:
    idx_file = _index_file()
    if idx_file.exists():
        try:
            return json.loads(idx_file.read_text())
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def _load_index() -> dict:
    with _index_lock:
        return _load_index_unlocked()


def _save_index_unlocked(idx: dict) -> None:
    atomic_write_text(_index_file(), json.dumps(idx, indent=2))


def session_index() -> dict[str, dict]:
    """A snapshot of the active project's session metadata."""
    return _load_index()


def session_states() -> dict[str, str]:
    return {slug: meta.get("state") for slug, meta in _load_index().items()}


def get_state(slug: str) -> str | None:
    return _load_index().get(slug, {}).get("state")


def set_state(slug: str, state: str) -> None:
    with _index_lock:
        idx = _load_index_unlocked()
        meta = idx.get(slug, {})
        meta["state"] = state
        meta["updated_at"] = _now()
        idx[slug] = meta
        _save_index_unlocked(idx)


# Reading modes (polish plan H.3): a per-session preset layered onto the analyst's system
# prompt — how much background vs. technical depth the explanation carries. "balanced" is
# the default and adds no layer. Stored in the session index so it survives restarts and
# applies to every subsequent turn until switched.
READING_MODES = ("balanced", "background", "technical", "detailed")


def get_reading_mode(slug: str) -> str:
    return _load_index().get(slug, {}).get("reading_mode") or "balanced"


def set_reading_mode(slug: str, mode: str) -> None:
    if mode not in READING_MODES:
        raise ValueError(f"Unknown reading mode: {mode}")
    with _index_lock:
        idx = _load_index_unlocked()
        meta = idx.get(slug, {})
        meta["reading_mode"] = mode
        meta["updated_at"] = _now()
        idx[slug] = meta
        _save_index_unlocked(idx)


def _touch_session(slug: str, timestamp: str) -> None:
    with _index_lock:
        idx = _load_index_unlocked()
        meta = idx.get(slug, {})
        meta["updated_at"] = timestamp
        idx[slug] = meta
        _save_index_unlocked(idx)


def _jsonl(slug: str):
    return _sessions_dir() / f"{slug}.jsonl"


def _append_record(slug: str, record: dict) -> dict:
    _sessions_dir().mkdir(parents=True, exist_ok=True)
    record["ts"] = _now()
    with _jsonl(slug).open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
    _touch_session(slug, record["ts"])
    return record


def read_records(slug: str) -> list[dict]:
    p = _jsonl(slug)
    if not p.exists():
        return []
    out = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            out.append(json.loads(line))
    return out


def start_session(slug: str, title: str, kind: str = "paper", opening: str | None = None) -> None:
    """Begin (or restart) a discussion. For a paper, corpus full text must already be cached;
    kind="review" is the cross-paper working-notes review chat. `opening` is the (possibly
    user-edited) first-prompt template for this session; None falls back to the default."""
    with _index_lock:
        idx = _load_index_unlocked()
        now = _now()
        meta = {"state": IN_DISCUSSION, "title": title, "kind": kind,
                "started_at": now, "updated_at": now}
        if opening:
            meta["opening"] = opening
        idx[slug] = meta
        _save_index_unlocked(idx)
    # fresh transcript for a fresh session start
    if _jsonl(slug).exists():
        _jsonl(slug).unlink()


def get_kind(slug: str) -> str:
    return _load_index().get(slug, {}).get("kind", "paper")


def get_opening(slug: str) -> str | None:
    return _load_index().get(slug, {}).get("opening")


def record_user(slug: str, text: str, kind: str = "reply", *, authored_text: str | None = None) -> None:
    record = {"role": "user", "kind": kind, "text": text}
    if authored_text is not None:
        record["authored_text"] = authored_text
    _append_record(slug, record)


def record_assistant(slug: str, turn: Turn, *, delivery_mode: str = "reading",
                     chat_job_id: str | None = None,
                     audio_job_id: str | None = None,
                     audio_error: str | None = None) -> tuple[str, int]:
    assistant_index = sum(r.get("role") == "assistant" for r in read_records(slug))
    record = _append_record(slug, {
        "role": "assistant",
        **turn.to_dict(),
        "delivery_mode": delivery_mode,
        "chat_job_id": chat_job_id,
        "audio_job_id": audio_job_id,
        "audio_error": audio_error,
    })
    if turn.proposed_commit:
        set_state(slug, NOTES_DRAFTED)
    return record["ts"], assistant_index


def update_assistant_audio(slug: str, timestamp: str, *, audio_job_id: str | None,
                           audio_error: str | None) -> None:
    """Update only the listening handoff on one already-recorded assistant turn."""
    records = read_records(slug)
    for record in reversed(records):
        if record.get("role") == "assistant" and record.get("ts") == timestamp:
            record["audio_job_id"] = audio_job_id
            record["audio_error"] = audio_error
            _rewrite(slug, records)
            return


def build_history(slug: str) -> list[dict]:
    """Reconstruct the model-facing message history: regenerated opening message (paper
    text) followed by every recorded turn."""
    opening = get_opening(slug)  # per-session edited template, or None
    if slug == REVIEW_SLUG:
        content = opening or prompts.get("review_opening")
    else:
        full_text = store.read_full_text(slug)
        template = opening or prompts.get("opening_message")
        content = template.replace("{title}", store.title_for(slug)).replace("{full_text}", full_text)
        if full_text and full_text not in content:  # user dropped {full_text}; ensure paper is sent
            content += "\n\n[BEGIN PAPER FULL TEXT]\n" + full_text + "\n[END PAPER FULL TEXT]"
    history = [{"role": "user", "content": content}]
    for rec in read_records(slug):
        if rec["role"] == "user":
            history.append({"role": "user", "content": rec["text"]})
        else:
            history.append({"role": "assistant", "content": rec.get("canonical", "")})
    return history


def transcript(slug: str) -> list[dict]:
    """UI-facing transcript (excludes the regenerated opening message)."""
    out = []
    assistant_index = -1
    for rec in read_records(slug):
        if rec["role"] == "user":
            if rec.get("kind") == "reply":  # hide internal finish/revision prompts
                out.append({"role": "user", "text": rec["text"]})
        else:
            assistant_index += 1
            out.append({
                "role": "assistant",
                "assistant_index": assistant_index,
                "canonical": rec.get("canonical", ""),
                "narration": rec.get("narration", ""),
                "state_signal": rec.get("state_signal", ""),
                "proposed_commit": rec.get("proposed_commit"),
                "delivery_mode": rec.get("delivery_mode", "reading"),
                "chat_job_id": rec.get("chat_job_id"),
                "audio_job_id": rec.get("audio_job_id"),
                "audio_error": rec.get("audio_error"),
            })
    return out


def accepted_drafts(slug: str) -> list[dict]:
    """Human-authored discussion inputs accepted into the server transcript.

    Revision records contain a rendered model instruction, so preserve and expose only their
    original feedback. Internal finish prompts are deliberately excluded.
    """
    out = []
    for record in read_records(slug):
        if record.get("role") != "user":
            continue
        kind = record.get("kind")
        if kind == "reply":
            out.append({"kind": kind, "text": record.get("text", "")})
        elif kind == "revision" and record.get("authored_text") is not None:
            out.append({"kind": kind, "text": record["authored_text"]})
    return out


def latest_proposed_commit(slug: str) -> dict | None:
    for rec in reversed(read_records(slug)):
        if rec["role"] == "assistant" and rec.get("proposed_commit"):
            return rec["proposed_commit"]
    return None


def mark_committed(slug: str) -> None:
    set_state(slug, COMMITTED)


def _rewrite(slug: str, records: list[dict]) -> None:
    body = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records)
    atomic_write_text(_jsonl(slug), body)


def truncate_before_assistant(slug: str, n: int) -> None:
    """Drop the n-th assistant turn (0-based) and everything after it, so it can be
    regenerated from the preceding user message. Resets state to in_discussion."""
    records = read_records(slug)
    count, pos = -1, None
    for i, r in enumerate(records):
        if r["role"] == "assistant":
            count += 1
            if count == n:
                pos = i
                break
    if pos is None:
        return
    _rewrite(slug, records[:pos])
    set_state(slug, IN_DISCUSSION)


def edit_reply(slug: str, reply_index: int, new_text: str) -> bool:
    """Replace the text of the reply_index-th user *reply* (0-based, matching the UI transcript
    which only surfaces kind=="reply" user turns) and drop every turn after it, so a fresh
    assistant response can be regenerated from the edited message. This is a destructive edit:
    the old response and any turns that followed are discarded (no branch is kept). Returns
    False if there is no such reply. Resets state to in_discussion."""
    records = read_records(slug)
    count, pos = -1, None
    for i, r in enumerate(records):
        if r["role"] == "user" and r.get("kind") == "reply":
            count += 1
            if count == reply_index:
                pos = i
                break
    if pos is None:
        return False
    records[pos]["text"] = new_text
    _rewrite(slug, records[: pos + 1])  # keep the edited reply, drop everything after it
    set_state(slug, IN_DISCUSSION)
    return True


def continue_discussion(slug: str) -> None:
    """Committed -> InDiscussion (polish plan H.2): NOTHING is dropped — the committed notes
    stay committed and the transcript stands; the composer simply comes back so the reading
    can go on. A later finish proposes a fresh draft through the normal propose/approve flow.
    Contrast with reopen_discussion below, which discards a rejected (uncommitted) draft."""
    set_state(slug, IN_DISCUSSION)


def reopen_discussion(slug: str) -> None:
    """Return a NotesDrafted session to InDiscussion: drop the rejected draft turns (the
    finish/revision prompt and the assistant draft it produced) so a redo is clean, then
    reset the state."""
    records = read_records(slug)
    while records and (
        (records[-1]["role"] == "assistant" and records[-1].get("proposed_commit"))
        or (records[-1]["role"] == "user" and records[-1].get("kind") in ("finish", "revision"))
    ):
        records.pop()
    _rewrite(slug, records)
    set_state(slug, IN_DISCUSSION)


# ---- narration cache (keyed by canonical-text hash, so re-listens never re-synthesize) ----
# App-global: identical canonical text narrates identically regardless of project, so the
# cache is shared (and lives outside any project's git repo).

def _narration_cache_file():
    return config.APP_STATE_DIR / "narration-cache.json"


def _ncache_key(text: str) -> str:
    return hashlib.sha1(text.strip().encode("utf-8")).hexdigest()


def _load_ncache() -> dict:
    f = _narration_cache_file()
    if f.exists():
        try:
            return json.loads(f.read_text())
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def get_cached_narration(text: str) -> str | None:
    return _load_ncache().get(_ncache_key(text))


def cache_narration(text: str, narration: str) -> None:
    cache = _load_ncache()
    cache[_ncache_key(text)] = narration
    atomic_write_text(_narration_cache_file(), json.dumps(cache, ensure_ascii=False, indent=0))
