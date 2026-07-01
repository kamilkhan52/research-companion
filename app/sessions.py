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
from datetime import datetime, timezone

from . import config, prompts, store
from .models import IN_DISCUSSION, NOTES_DRAFTED, COMMITTED, REVIEW_SLUG, Turn

def _sessions_dir():
    return config.project_dir() / "sessions"


def _index_file():
    return config.state_dir() / "sessions.json"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _load_index() -> dict:
    idx_file = _index_file()
    if idx_file.exists():
        try:
            return json.loads(idx_file.read_text())
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def _save_index(idx: dict) -> None:
    _index_file().write_text(json.dumps(idx, indent=2))


def session_states() -> dict[str, str]:
    return {slug: meta.get("state") for slug, meta in _load_index().items()}


def get_state(slug: str) -> str | None:
    return _load_index().get(slug, {}).get("state")


def set_state(slug: str, state: str) -> None:
    idx = _load_index()
    meta = idx.get(slug, {})
    meta["state"] = state
    meta["updated_at"] = _now()
    idx[slug] = meta
    _save_index(idx)


def _jsonl(slug: str):
    return _sessions_dir() / f"{slug}.jsonl"


def _append_record(slug: str, record: dict) -> None:
    _sessions_dir().mkdir(parents=True, exist_ok=True)
    record["ts"] = _now()
    with _jsonl(slug).open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


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
    idx = _load_index()
    meta = {"state": IN_DISCUSSION, "title": title, "kind": kind,
            "started_at": _now(), "updated_at": _now()}
    if opening:
        meta["opening"] = opening
    idx[slug] = meta
    _save_index(idx)
    # fresh transcript for a fresh session start
    if _jsonl(slug).exists():
        _jsonl(slug).unlink()


def get_kind(slug: str) -> str:
    return _load_index().get(slug, {}).get("kind", "paper")


def get_opening(slug: str) -> str | None:
    return _load_index().get(slug, {}).get("opening")


def record_user(slug: str, text: str, kind: str = "reply") -> None:
    _append_record(slug, {"role": "user", "kind": kind, "text": text})


def record_assistant(slug: str, turn: Turn) -> None:
    _append_record(slug, {"role": "assistant", **turn.to_dict()})
    if turn.proposed_commit:
        set_state(slug, NOTES_DRAFTED)


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
    for rec in read_records(slug):
        if rec["role"] == "user":
            if rec.get("kind") == "reply":  # hide internal finish/revision prompts
                out.append({"role": "user", "text": rec["text"]})
        else:
            out.append({
                "role": "assistant",
                "canonical": rec.get("canonical", ""),
                "narration": rec.get("narration", ""),
                "state_signal": rec.get("state_signal", ""),
                "proposed_commit": rec.get("proposed_commit"),
            })
    return out


def latest_proposed_commit(slug: str) -> dict | None:
    for rec in reversed(read_records(slug)):
        if rec["role"] == "assistant" and rec.get("proposed_commit"):
            return rec["proposed_commit"]
    return None


def mark_committed(slug: str) -> None:
    set_state(slug, COMMITTED)


def _rewrite(slug: str, records: list[dict]) -> None:
    with _jsonl(slug).open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


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
    _narration_cache_file().write_text(json.dumps(cache, ensure_ascii=False, indent=0))
