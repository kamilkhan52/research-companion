"""Session state, transcript logs, and clean pause/resume (Section 9). A paper keeps its
backwards-compatible main discussion at sessions/<slug>.jsonl and may have independent
request-scoped threads beneath sessions/<slug>.threads/. A small index in
.state/sessions.json tracks their transient working state so discussions can sit for days
across many app sessions and resume server-side without losing context.

The giant opening message (paper full text) is NOT stored in the transcript — it is
regenerated from the cached corpus text when reconstructing history, keeping logs compact.
"""
from __future__ import annotations

import hashlib
import json
import re
import threading
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import UTC, datetime

from . import assembler, config, prompts, store
from .fileio import atomic_write_text
from .models import COMMITTED, IN_DISCUSSION, NOTES_DRAFTED, REVIEW_SLUG, Turn

# sessions.json is a read/modify/write index shared by chat-job threads and request handlers.
# A single-process lock matches the deployment model documented in CLAUDE.md and prevents one
# project/session update from silently overwriting another update based on a stale read.
_index_lock = threading.RLock()

# Independent discussion threads are request-scoped, never selected through mutable project
# state.  This matters when the same paper is open on two devices: switching a thread in one
# client must not redirect the other client's next turn.  "main" keeps every pre-R10 path and
# index field byte-for-byte compatible; additional thread ids are generated server-side and
# validated before they can influence a filesystem path.
MAIN_THREAD = "main"
_THREAD_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,47}$")
_active_thread: ContextVar[str] = ContextVar("discussion_thread", default=MAIN_THREAD)


def validate_thread_id(thread_id: str | None) -> str:
    value = thread_id or MAIN_THREAD
    if not _THREAD_ID_RE.fullmatch(value):
        raise ValueError("Invalid discussion thread id.")
    return value


def active_thread_id() -> str:
    return _active_thread.get()


@contextmanager
def thread_scope(thread_id: str | None):
    """Bind one validated conversation namespace for this request/worker only."""
    token = _active_thread.set(validate_thread_id(thread_id))
    try:
        yield
    finally:
        _active_thread.reset(token)


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
    # A library row is paper-level, so surface the state requiring the most attention across
    # its independent conversations.  Thread-local GETs still return the exact selected state.
    priority = {NOTES_DRAFTED: 3, IN_DISCUSSION: 2, COMMITTED: 1, None: 0}
    out: dict[str, str] = {}
    for slug, meta in _load_index().items():
        states = [meta.get("state")]
        states.extend(t.get("state") for t in (meta.get("threads") or {}).values())
        out[slug] = max(states, key=lambda state: priority.get(state, 0))
    return out


def _thread_meta(meta: dict, thread_id: str | None = None) -> dict:
    tid = validate_thread_id(thread_id or active_thread_id())
    if tid == MAIN_THREAD:
        return meta
    return (meta.get("threads") or {}).get(tid, {})


def _mutate_thread_meta(meta: dict, thread_id: str, update) -> dict:
    """Apply `update(dict)` to one thread's metadata and return the paper metadata."""
    if thread_id == MAIN_THREAD:
        update(meta)
        return meta
    threads = dict(meta.get("threads") or {})
    thread = dict(threads.get(thread_id) or {})
    update(thread)
    threads[thread_id] = thread
    meta["threads"] = threads
    return meta


def get_state(slug: str) -> str | None:
    return _thread_meta(_load_index().get(slug, {})).get("state")


def index_entry(slug: str) -> dict | None:
    """The raw session-index metadata for one slug in the active project (None if none). For
    project splitting, which relocates a paper's session wholesale."""
    entry = _load_index().get(slug)
    return dict(entry) if entry else None


def transcript_paths(slug: str) -> tuple:
    """(transcript jsonl, branches file) paths for a slug in the active project — the on-disk
    session state a split moves. Either may not exist."""
    return _jsonl(slug), _branches_file(slug)


def thread_storage_paths(slug: str) -> tuple:
    """Every transcript/branch path belonging to a paper, including independent threads.

    Callers that move/copy/remove a paper use this instead of guessing files from index
    metadata.  Main paths remain first for stable git/path behavior.
    """
    paths = [(_jsonl(slug, MAIN_THREAD), _branches_file(slug, MAIN_THREAD))]
    meta = _load_index().get(slug, {})
    thread_ids = set((meta.get("threads") or {}).keys())
    transcript_dir = _sessions_dir() / f"{slug}.threads"
    branch_dir = config.state_dir() / "branches" / f"{slug}.threads"
    for directory, suffix in ((transcript_dir, ".jsonl"), (branch_dir, ".branches.json")):
        if directory.exists():
            for path in directory.glob(f"*{suffix}"):
                candidate = path.name.removesuffix(suffix)
                if _THREAD_ID_RE.fullmatch(candidate):
                    thread_ids.add(candidate)
    for thread_id in sorted(thread_ids):
        paths.append((_jsonl(slug, thread_id), _branches_file(slug, thread_id)))
    return tuple(paths)


def export_thread_storage(slug: str) -> list[dict]:
    """Serializable session-file bundle used by deterministic project relocation."""
    out = []
    for jsonl, branches in thread_storage_paths(slug):
        if jsonl == _jsonl(slug, MAIN_THREAD):
            thread_id = MAIN_THREAD
        else:
            thread_id = jsonl.stem
        out.append({
            "thread_id": thread_id,
            "jsonl_bytes": jsonl.read_bytes() if jsonl.exists() else None,
            "branches_bytes": branches.read_bytes() if branches.exists() else None,
        })
    return out


def import_thread_storage(slug: str, bundle: list[dict]) -> None:
    for item in bundle:
        thread_id = validate_thread_id(item.get("thread_id"))
        jsonl = _jsonl(slug, thread_id)
        branches = _branches_file(slug, thread_id)
        if item.get("jsonl_bytes") is not None:
            jsonl.parent.mkdir(parents=True, exist_ok=True)
            jsonl.write_bytes(item["jsonl_bytes"])
        if item.get("branches_bytes") is not None:
            branches.parent.mkdir(parents=True, exist_ok=True)
            branches.write_bytes(item["branches_bytes"])


def remove_thread_storage(slug: str) -> None:
    pairs = thread_storage_paths(slug)
    for jsonl, branches in pairs:
        jsonl.unlink(missing_ok=True)
        branches.unlink(missing_ok=True)
    for directory in (
        _sessions_dir() / f"{slug}.threads",
        config.state_dir() / "branches" / f"{slug}.threads",
    ):
        try:
            directory.rmdir()
        except OSError:
            pass


def import_session(slug: str, meta: dict) -> None:
    """Register a session-index entry copied from another project (project splitting). The
    caller has already placed the transcript/branches files; this records the metadata so the
    paper resumes in its new project. Overwrites any existing entry for the slug."""
    with _index_lock:
        idx = _load_index_unlocked()
        idx[slug] = dict(meta)
        _save_index_unlocked(idx)


def drop_session(slug: str) -> None:
    """Remove a slug's session-index entry (project splitting, source side after a move). The
    transcript/branches files are deleted by the caller."""
    with _index_lock:
        idx = _load_index_unlocked()
        if idx.pop(slug, None) is not None:
            _save_index_unlocked(idx)


def list_threads(slug: str) -> list[dict]:
    """Conversation switcher rows for one paper, oldest first (main is always first)."""
    meta = _load_index().get(slug)
    if not meta:
        return []
    rows = [{
        "id": MAIN_THREAD,
        "title": meta.get("thread_title") or "Main discussion",
        "state": meta.get("state"),
        "created_at": meta.get("started_at"),
        "updated_at": meta.get("updated_at"),
        "message_count": len(read_records(slug, MAIN_THREAD)),
    }]
    for thread_id, thread in (meta.get("threads") or {}).items():
        rows.append({
            "id": thread_id,
            "title": thread.get("title") or "New thread",
            "state": thread.get("state"),
            "created_at": thread.get("started_at"),
            "updated_at": thread.get("updated_at"),
            "message_count": len(read_records(slug, thread_id)),
        })
    return rows


def create_thread(slug: str, title: str = "New thread") -> dict:
    """Create an empty independent conversation. No model/network work happens here."""
    with _index_lock:
        idx = _load_index_unlocked()
        meta = idx.get(slug)
        if not meta:
            raise ValueError("Start the main discussion before creating another thread.")
        thread_id = uuid.uuid4().hex[:12]
        while thread_id in (meta.get("threads") or {}):
            thread_id = uuid.uuid4().hex[:12]
        now = _now()
        threads = dict(meta.get("threads") or {})
        threads[thread_id] = {
            "state": IN_DISCUSSION,
            "title": title.strip() or "New thread",
            "kind": meta.get("kind", "paper"),
            "reading_mode": meta.get("reading_mode") or "balanced",
            "started_at": now,
            "updated_at": now,
        }
        meta["threads"] = threads
        meta["updated_at"] = now
        idx[slug] = meta
        _save_index_unlocked(idx)
    return next(row for row in list_threads(slug) if row["id"] == thread_id)


def set_state(slug: str, state: str) -> None:
    thread_id = active_thread_id()
    with _index_lock:
        idx = _load_index_unlocked()
        meta = idx.get(slug, {})
        now = _now()
        _mutate_thread_meta(meta, thread_id, lambda thread: thread.update(
            {"state": state, "updated_at": now},
        ))
        meta["updated_at"] = now
        idx[slug] = meta
        _save_index_unlocked(idx)


# Reading modes (polish plan H.3): a per-session preset layered onto the analyst's system
# prompt — how much background vs. technical depth the explanation carries. "balanced" is
# the default and adds no layer. Stored in the session index so it survives restarts and
# applies to every subsequent turn until switched.
READING_MODES = ("balanced", "background", "technical", "detailed")


def get_reading_mode(slug: str) -> str:
    return _thread_meta(_load_index().get(slug, {})).get("reading_mode") or "balanced"


def set_reading_mode(slug: str, mode: str) -> None:
    if mode not in READING_MODES:
        raise ValueError(f"Unknown reading mode: {mode}")
    thread_id = active_thread_id()
    with _index_lock:
        idx = _load_index_unlocked()
        meta = idx.get(slug, {})
        now = _now()
        _mutate_thread_meta(meta, thread_id, lambda thread: thread.update(
            {"reading_mode": mode, "updated_at": now},
        ))
        meta["updated_at"] = now
        idx[slug] = meta
        _save_index_unlocked(idx)


def _touch_session(slug: str, timestamp: str) -> None:
    thread_id = active_thread_id()
    with _index_lock:
        idx = _load_index_unlocked()
        meta = idx.get(slug, {})
        _mutate_thread_meta(meta, thread_id, lambda thread: thread.update(
            {"updated_at": timestamp},
        ))
        meta["updated_at"] = timestamp
        idx[slug] = meta
        _save_index_unlocked(idx)


def _jsonl(slug: str, thread_id: str | None = None):
    tid = validate_thread_id(thread_id or active_thread_id())
    if tid == MAIN_THREAD:
        return _sessions_dir() / f"{slug}.jsonl"
    return _sessions_dir() / f"{slug}.threads" / f"{tid}.jsonl"


def _append_record(slug: str, record: dict) -> dict:
    _jsonl(slug).parent.mkdir(parents=True, exist_ok=True)
    record["ts"] = _now()
    with _jsonl(slug).open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
    _touch_session(slug, record["ts"])
    return record


def read_records(slug: str, thread_id: str | None = None) -> list[dict]:
    p = _jsonl(slug, thread_id)
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
    thread_id = active_thread_id()
    with _index_lock:
        idx = _load_index_unlocked()
        now = _now()
        old = idx.get(slug, {})
        # Restarting/retrying main replaces only main's legacy fields; independent threads
        # remain intact.  Before threads existed the equivalent was simply an empty dict.
        meta = ({"threads": dict(old.get("threads") or {})}
                if thread_id == MAIN_THREAD else dict(old))
        thread_meta = {"state": IN_DISCUSSION, "title": title, "kind": kind,
                       "started_at": now, "updated_at": now}
        if opening:
            thread_meta["opening"] = opening
        _mutate_thread_meta(meta, thread_id, lambda thread: thread.update(thread_meta))
        meta["updated_at"] = now
        idx[slug] = meta
        _save_index_unlocked(idx)
    # fresh transcript for a fresh session start
    if _jsonl(slug).exists():
        _jsonl(slug).unlink()
    clear_branches(slug)


def get_kind(slug: str) -> str:
    return _thread_meta(_load_index().get(slug, {})).get("kind", "paper")


def get_opening(slug: str) -> str | None:
    return _thread_meta(_load_index().get(slug, {})).get("opening")


def set_opening(slug: str, opening: str | None) -> None:
    """Replace the generated first-message instruction without restarting the transcript."""
    thread_id = active_thread_id()
    with _index_lock:
        idx = _load_index_unlocked()
        meta = idx.get(slug, {})
        now = _now()

        def update(thread: dict) -> None:
            if opening:
                thread["opening"] = opening
            else:
                thread.pop("opening", None)
            thread["updated_at"] = now

        _mutate_thread_meta(meta, thread_id, update)
        meta["updated_at"] = now
        idx[slug] = meta
        _save_index_unlocked(idx)


def record_user(slug: str, text: str, kind: str = "reply", *, authored_text: str | None = None) -> None:
    record = {"role": "user", "kind": kind, "text": text}
    if authored_text is not None:
        record["authored_text"] = authored_text
    _append_record(slug, record)
    # Give a newly-created thread a useful switcher label without an extra model call.
    if kind == "reply" and active_thread_id() != MAIN_THREAD:
        with _index_lock:
            idx = _load_index_unlocked()
            meta = idx.get(slug, {})
            thread_id = active_thread_id()
            thread = _thread_meta(meta, thread_id)
            if thread.get("title") == "New thread":
                label = " ".join(text.strip().split())
                if len(label) > 52:
                    label = label[:49].rstrip() + "…"
                _mutate_thread_meta(meta, thread_id, lambda item: item.update(
                    {"title": label or "New thread"},
                ))
                idx[slug] = meta
                _save_index_unlocked(idx)


def record_assistant(slug: str, turn: Turn, *, delivery_mode: str = "reading",
                     chat_job_id: str | None = None,
                     audio_job_id: str | None = None,
                     audio_error: str | None = None,
                     model: str | None = None,
                     agent_trail: list[dict] | None = None) -> tuple[str, int]:
    """`model` is recorded only when the turn ran on a non-default model (a one-shot override
    that differs from the settings default at generation time) — callers pass
    chat_jobs.override_label(...), so a default-model turn stays unlabeled in the UI.
    `agent_trail` is what the agent did before answering (tool calls + intermediate
    commentary, [{kind: 'tool'|'thought', ...}]) so the UI can attach a collapsed activity
    trail to the finished message (R6.8)."""
    assistant_index = sum(r.get("role") == "assistant" for r in read_records(slug))
    record = _append_record(slug, {
        "role": "assistant",
        **turn.to_dict(),
        "delivery_mode": delivery_mode,
        "chat_job_id": chat_job_id,
        "audio_job_id": audio_job_id,
        "audio_error": audio_error,
        **({"model": model} if model else {}),
        **({"agent_trail": agent_trail} if agent_trail else {}),
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
        content = assembler.paper_opening_message(slug, full_text, template=opening)
    history = [{"role": "user", "content": content}]
    for rec in read_records(slug):
        if rec["role"] == "user":
            history.append({"role": "user", "content": rec["text"]})
        else:
            history.append({"role": "assistant", "content": rec.get("canonical", "")})
    return history


def proposal_expected(slug: str) -> bool:
    """Whether the reader's latest durable action explicitly requested a notes proposal.

    Prompt instructions are not a sufficient approval boundary: models occasionally emit the
    proposal sections during an opening summary. Only Finish and feedback on an existing draft
    authorize those sections to become a reviewable ``proposed_commit``.
    """
    records = read_records(slug)
    return bool(
        records
        and records[-1].get("role") == "user"
        and records[-1].get("kind") in {"finish", "revision"}
    )


def transcript(slug: str) -> list[dict]:
    """UI-facing transcript (excludes the regenerated opening message)."""
    out = []
    branches = branch_map(slug)
    assistant_index = -1
    for rec in read_records(slug):
        if rec["role"] == "user":
            if rec.get("kind") == "reply":  # hide internal finish/revision prompts
                out.append({"role": "user", "text": rec["text"]})
        else:
            assistant_index += 1
            fork = branches.get(assistant_index)
            out.append({
                "role": "assistant",
                "assistant_index": assistant_index,
                "branch_count": fork["count"] if fork else None,
                "branch_active": fork["active"] if fork else None,
                "canonical": rec.get("canonical", ""),
                "narration": rec.get("narration", ""),
                "state_signal": rec.get("state_signal", ""),
                "proposed_commit": rec.get("proposed_commit"),
                "delivery_mode": rec.get("delivery_mode", "reading"),
                "chat_job_id": rec.get("chat_job_id"),
                "audio_job_id": rec.get("audio_job_id"),
                "audio_error": rec.get("audio_error"),
                "model": rec.get("model"),
                "agent_trail": rec.get("agent_trail"),
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
            out.append({
                "kind": kind,
                "text": record.get("authored_text", record.get("text", "")),
            })
        elif kind == "revision" and record.get("authored_text") is not None:
            out.append({"kind": kind, "text": record["authored_text"]})
    return out


def other_threads_context(slug: str) -> str:
    """Model-facing transcript appendix for finishing notes from the selected thread.

    The paper full text is already in the regenerated opening and is deliberately not copied.
    Internal finish/revision instructions and prior proposal payloads are excluded; what
    remains is the reader's authored discussion and the analyst's substantive responses.
    """
    selected = active_thread_id()
    sections: list[str] = []
    for row in list_threads(slug):
        thread_id = row["id"]
        if thread_id == selected:
            continue
        turns: list[str] = []
        for record in read_records(slug, thread_id):
            if record.get("role") == "user" and record.get("kind") == "reply":
                turns.append(f"Reader: {record.get('text', '')}")
            elif (record.get("role") == "user"
                  and record.get("kind") == "revision"
                  and record.get("authored_text")):
                turns.append(f"Reader revision: {record['authored_text']}")
            elif (record.get("role") == "assistant"
                  and not record.get("proposed_commit")
                  and record.get("canonical", "").strip()):
                turns.append(f"Analyst: {record['canonical']}")
        if turns:
            sections.append(
                f"[BEGIN DISCUSSION THREAD: {row['title']}]\n"
                + "\n\n".join(turns)
                + f"\n[END DISCUSSION THREAD: {row['title']}]"
            )
    if not sections:
        return ""
    return (
        "\n\nAlso incorporate durable insights from every independent discussion below. "
        "Do not mention thread mechanics in the proposed notes, and do not omit a useful "
        "insight merely because it came from another thread.\n\n"
        + "\n\n".join(sections)
    )


def latest_proposed_commit(slug: str) -> dict | None:
    for rec in reversed(read_records(slug)):
        if rec["role"] == "assistant" and rec.get("proposed_commit"):
            return rec["proposed_commit"]
    return None


def proposal_revision(slug: str) -> str | None:
    """Optimistic-concurrency token for the ACTIVE proposal: a review screen holds its loaded
    payload for minutes, and a branch switch (or regeneration) can replace the proposal
    underneath it — an approval carrying an explicit payload must prove it reviewed the
    proposal that is still live. Hash of the proposal content + its record timestamp."""
    for rec in reversed(read_records(slug)):
        if rec["role"] == "assistant" and rec.get("proposed_commit"):
            # The branch map is part of the basis: a fork/switch always changes it, so a
            # regenerated proposal that happens to carry identical content within the same
            # timestamp second still yields a fresh revision.
            basis = (json.dumps(rec["proposed_commit"], sort_keys=True)
                     + str(rec.get("ts", ""))
                     + json.dumps(branch_map(slug), sort_keys=True))
            return hashlib.sha1(basis.encode()).hexdigest()[:16]
    return None


def finalize_proposal_for_commit(slug: str) -> None:
    """Called by committer.commit BEFORE `git add -A`, so both effects land INSIDE the
    approved commit (stamping afterwards left the repo dirty and swept the change into the
    next unrelated commit):
    - clear branch bookkeeping — committing finalizes the chosen branch, so no path
      (including continue_discussion) can resurrect a sibling's stale draft;
    - stamp the proposal record with a durable committed boundary — a LATER fork can legally
      archive a tail containing this record, and its restore must never re-derive
      notes_drafted from a proposal that already reached git.
    Safe if the git commit subsequently fails: the state stays notes_drafted, Approve remains
    available, and re-approving re-runs this idempotently."""
    # Notes are paper-level and the finishing prompt incorporates every discussion. Approval
    # therefore closes every thread's pending proposal/branch state as one human-reviewed
    # boundary; otherwise switching to a sibling could re-offer a stale second proposal.
    for row in list_threads(slug):
        with thread_scope(row["id"]):
            clear_branches(slug)
            records = read_records(slug)
            for rec in reversed(records):
                if rec.get("role") == "assistant" and rec.get("proposed_commit"):
                    if not rec.get("proposal_committed"):
                        rec["proposal_committed"] = True
                        _rewrite(slug, records)
                    break


def mark_committed(slug: str) -> None:
    for row in list_threads(slug):
        with thread_scope(row["id"]):
            set_state(slug, COMMITTED)


def _rewrite(slug: str, records: list[dict]) -> None:
    body = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records)
    _jsonl(slug).parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(_jsonl(slug), body)


def _assistant_pos(records: list[dict], n: int) -> int | None:
    """Index into `records` of the n-th (0-based) assistant turn, or None."""
    count = -1
    for i, r in enumerate(records):
        if r["role"] == "assistant":
            count += 1
            if count == n:
                return i
    return None


def truncate_before_assistant(slug: str, n: int) -> None:
    """Drop the n-th assistant turn (0-based) and everything after it, so it can be
    regenerated from the preceding user message. Resets state to in_discussion."""
    records = read_records(slug)
    pos = _assistant_pos(records, n)
    if pos is None:
        return
    _rewrite(slug, records[:pos])
    set_state(slug, IN_DISCUSSION)


# ---- response branches (U.14: retry forks the conversation) ----------------------------------
#
# A retry at assistant turn n no longer discards the old response: the LIVE transcript tail
# (from turn n through the end — later turns belong to that branch of the conversation) is
# archived in <slug>.branches.json, and generation proceeds on a fresh tail. Switching branches
# swaps the live tail with a stored one. The live JSONL stays the single source of truth for
# the ACTIVE branch (generation and later replies append to it normally); the stored copy of
# the active tail is only synchronized at fork/switch time.
#
# Baseline tree semantics: branch bookkeeping is kept per fork point, keyed by assistant index.
# Forking or switching at turn n invalidates bookkeeping for deeper fork points (> n) — their
# records ride along inside whichever tail they belong to, but their selector state does not
# survive (documented limitation of the flat baseline; a full conversation tree is v2).

# Per-(project, slug, thread) mutation locks: transcript-rewriting actions (turn preps, branch
# switches, approvals) hold this across their check-then-mutate sequence so snapshot guards
# can't interleave (e.g. a switch between a reply's record_user and its job registration).
# In-process is sufficient: single worker (CLAUDE.md invariant 6).
_mutation_locks: dict[tuple[str | None, str, str], threading.Lock] = {}
_mutation_locks_guard = threading.Lock()
_paper_locks: dict[tuple[str | None, str], threading.Lock] = {}
_paper_locks_guard = threading.Lock()


def mutation_lock(slug: str) -> threading.Lock:
    key = (config.active_project_id(), slug, active_thread_id())
    with _mutation_locks_guard:
        lock = _mutation_locks.get(key)
        if lock is None:
            lock = _mutation_locks[key] = threading.Lock()
        return lock


def paper_lock(slug: str) -> threading.Lock:
    """Short admission/approval lock shared by every thread of one paper.

    Turn generation itself remains parallel across threads; only check+registration is held.
    Approval holds this lock while checking for active jobs and committing, closing the race
    where a new finish could start immediately after the approval's active-job check.
    """
    key = (config.active_project_id(), slug)
    with _paper_locks_guard:
        lock = _paper_locks.get(key)
        if lock is None:
            lock = _paper_locks[key] = threading.Lock()
        return lock


def _branches_file(slug: str, thread_id: str | None = None):
    # Under .state/ (gitignored), NOT the sessions dir: transcripts are part of the committed
    # record, but sibling branches are switchable working state — committer.commit()'s
    # `git add -A` must never immortalize unchosen tails (or their stale drafts) in git.
    tid = validate_thread_id(thread_id or active_thread_id())
    if tid == MAIN_THREAD:
        return config.state_dir() / "branches" / f"{slug}.branches.json"
    return config.state_dir() / "branches" / f"{slug}.threads" / f"{tid}.branches.json"


def _read_branches(slug: str) -> dict:
    p = _branches_file(slug)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _write_branches(slug: str, data: dict) -> None:
    p = _branches_file(slug)
    if not data:
        p.unlink(missing_ok=True)
        return
    p.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(p, json.dumps(data, ensure_ascii=False))


def _prune_branches(slug: str, *, keep_below: int) -> None:
    """Drop branch bookkeeping for fork points at or beyond `keep_below` (used when the turns
    they annotate were rewritten away: edits, reopen, deeper forks)."""
    data = _read_branches(slug)
    kept = {k: v for k, v in data.items() if int(k) < keep_below}
    if kept != data:
        _write_branches(slug, kept)


def clear_branches(slug: str) -> None:
    _branches_file(slug).unlink(missing_ok=True)


def _discussion_context(slug: str) -> dict:
    return {
        "opening": get_opening(slug),
        "reading_mode": get_reading_mode(slug),
    }


def _apply_discussion_context(slug: str, context: dict) -> None:
    set_opening(slug, context.get("opening"))
    set_reading_mode(slug, context.get("reading_mode") or "balanced")


def _branch_contexts(entry: dict, slug: str) -> list[dict]:
    """Context list parallel to tails. Old branch files predate this field; use their current
    session context as the only truthful fallback and upgrade them on the next mutation."""
    contexts = list(entry.get("contexts") or [])
    while len(contexts) < len(entry.get("tails") or []):
        contexts.append(_discussion_context(slug))
    return contexts


def fork_before_assistant(slug: str, n: int, *, context: dict | None = None) -> None:
    """Archive the live tail from the n-th assistant turn as a branch and truncate the live
    transcript, so a sibling response can be generated from the same user message. The NEW
    branch becomes active; the sibling generated next appends to the live transcript as usual.
    Resets state to in_discussion."""
    records = read_records(slug)
    pos = _assistant_pos(records, n)
    if pos is None:
        return
    data = _read_branches(slug)
    key = str(n)
    entry = data.get(key) or {"tails": [], "active": -1}
    contexts = _branch_contexts(entry, slug)
    live_context = _discussion_context(slug)
    live_tail = records[pos:]
    if 0 <= entry["active"] < len(entry["tails"]):
        entry["tails"][entry["active"]] = live_tail   # sync the branch we are leaving
        contexts[entry["active"]] = live_context
        entry["last_active"] = entry["active"]
    else:
        entry["tails"].append(live_tail)              # first fork: archive the original
        contexts.append(live_context)
        entry["last_active"] = len(entry["tails"]) - 1
    entry["tails"].append([])                          # slot for the upcoming generation
    contexts.append(context or live_context)
    entry["contexts"] = contexts
    entry["active"] = len(entry["tails"]) - 1
    entry["forked_at"] = _now()
    data[key] = entry
    # Deeper fork points annotated turns that now live inside an archived tail.
    data = {k: v for k, v in data.items() if int(k) <= n}
    _write_branches(slug, data)
    _rewrite(slug, records[:pos])
    _apply_discussion_context(slug, contexts[entry["active"]])
    set_state(slug, IN_DISCUSSION)


def switch_branch(slug: str, n: int, branch: int) -> bool:
    """Make 1-based `branch` the live conversation at fork point n: the current live tail is
    stored back into its slot, the chosen tail becomes the transcript's tail. Returns False
    for an unknown fork point / branch ordinal. State follows the restored tail (a proposed
    draft restores notes_drafted)."""
    data = _read_branches(slug)
    entry = data.get(str(n))
    if not entry or not 1 <= branch <= len(entry["tails"]):
        return False
    target = branch - 1
    records = read_records(slug)
    pos = _assistant_pos(records, n)
    head = records if pos is None else records[:pos]
    live_tail = [] if pos is None else records[pos:]
    contexts = _branch_contexts(entry, slug)
    if 0 <= entry["active"] < len(entry["tails"]):
        entry["tails"][entry["active"]] = live_tail
        contexts[entry["active"]] = _discussion_context(slug)
    entry["active"] = target
    entry["contexts"] = contexts
    data[str(n)] = entry
    data = {k: v for k, v in data.items() if int(k) <= n}
    _write_branches(slug, data)
    restored = entry["tails"][target]
    _rewrite(slug, head + restored)
    _apply_discussion_context(slug, contexts[target])
    set_state(slug, _restored_tail_state(restored))
    return True


def _restored_tail_state(restored: list[dict]) -> str:
    """State for a just-restored tail: a live (uncommitted) proposal restores the draft
    workflow; a proposal already stamped `proposal_committed` must NOT re-offer Approve."""
    last_assistant = next((r for r in reversed(restored) if r.get("role") == "assistant"), None)
    if (last_assistant and last_assistant.get("proposed_commit")
            and not last_assistant.get("proposal_committed")):
        return NOTES_DRAFTED
    return IN_DISCUSSION


def rollback_empty_fork(slug: str, *, min_age_s: float = 0.0) -> None:
    """Failed/stopped-empty retry recovery: a fork whose active tail never received an
    assistant turn would strand the conversation at the user message with NO selector to
    escape (the selector renders on assistant turns). Restore the branch the fork left,
    dropping the empty slot; with one branch left the fork point dissolves entirely.

    `min_age_s` guards the READ-path caller (session load recovers forks orphaned by a crash
    or restart — the worker's own rollback is lost with the process): a fork younger than the
    grace window is almost certainly the retry that was just prepped and whose job is about
    to register, not an orphan."""
    data = _read_branches(slug)
    if not data:
        return
    n = max(int(k) for k in data)
    entry = data[str(n)]
    if min_age_s > 0:
        forked_at = entry.get("forked_at")
        if forked_at:
            try:
                age = (datetime.now(UTC) - datetime.fromisoformat(forked_at)).total_seconds()
            except ValueError:
                age = min_age_s
            if age < min_age_s:
                return
    records = read_records(slug)
    if _assistant_pos(records, n) is not None:
        return  # the live branch has content; nothing to roll back
    tails = entry.get("tails") or []
    contexts = _branch_contexts(entry, slug)
    active = entry.get("active", -1)
    if 0 <= active < len(tails) and not tails[active]:
        tails.pop(active)
        contexts.pop(active)
    if not tails:
        del data[str(n)]
        _write_branches(slug, data)
        return
    restore = entry.get("last_active", 0)
    restore = min(max(restore, 0), len(tails) - 1)
    restored = tails[restore]
    if len(tails) == 1:
        del data[str(n)]              # a single branch is not a fork
    else:
        entry["tails"] = tails
        entry["contexts"] = contexts
        entry["active"] = restore
        data[str(n)] = entry
    _write_branches(slug, data)
    _rewrite(slug, records + restored)
    _apply_discussion_context(slug, contexts[restore])
    set_state(slug, _restored_tail_state(restored))


def branch_map(slug: str) -> dict[int, dict]:
    """fork point (assistant index) -> {"count": total branches, "active": 1-based live}."""
    out: dict[int, dict] = {}
    for key, entry in _read_branches(slug).items():
        tails = entry.get("tails") or []
        if len(tails) >= 2:
            out[int(key)] = {"count": len(tails), "active": int(entry.get("active", 0)) + 1}
    return out


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
    kept = records[: pos + 1]
    _rewrite(slug, kept)  # keep the edited reply, drop everything after it
    # Fork bookkeeping for assistant turns that no longer exist is meaningless now.
    _prune_branches(slug, keep_below=sum(r["role"] == "assistant" for r in kept))
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
    _prune_branches(slug, keep_below=sum(r["role"] == "assistant" for r in records))
    set_state(slug, IN_DISCUSSION)


# ---- narration cache (keyed by canonical-text hash, so re-listens never re-synthesize) ----
# App-global: identical canonical text narrates identically regardless of project, so the
# cache is shared (and lives outside any project's git repo).

def _narration_cache_file():
    """Per user, under `config.user_scope_dir()`; the flat app-global file when nobody is bound.

    Scoped for the same two reasons as the mp3s beside it. Sharing it would mean the second person
    to ask for a passage gets the first person's narration for free — no leak (you must already
    hold the text to ask for it) but their LLM call never bills to them, and M7 deleting the first
    account would silently take away the second's cached audio.
    """
    scope = config.user_scope_dir()
    return (scope or config.APP_STATE_DIR) / "narration-cache.json"


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
    path = _narration_cache_file()
    path.parent.mkdir(parents=True, exist_ok=True)  # a user's scope dir is created on first write
    atomic_write_text(path, json.dumps(cache, ensure_ascii=False, indent=0))
