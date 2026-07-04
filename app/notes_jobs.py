"""Viewing and editing committed notes — a paper's Notes block (corpus/<slug>.md) or the
project's working notes (working-notes.md) — plus the agent-assisted edit.

Reading and saving are plain store operations; a save is a human's explicit action, so it
git-commits immediately (same versioning contract as committer.py). The agent edit runs a
natural-language instruction as a background job (job + poll, like every long operation
here — a blocking request dies at the tunnel's ~100s limit): the notes-editor agent — the
same research-tool loop the analyst uses — rewrites the document and the job holds the
result as a PROPOSAL. Nothing is written until the human reviews the revision and applies
it through save(); "agent proposes, human commits" applies to notes edits too.
"""
from __future__ import annotations

import asyncio
import re
import threading
import uuid
from collections.abc import AsyncIterator, Callable, Iterable
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime

from . import agent, agent_harness, committer, config, prompts, store

# The pseudo-target for the cross-paper working notes; anything else is a paper slug.
WORKING = "working"

_MAX_FINISHED = 20

# runner(target, prompt) yields the same {'text'|'tool'|'final'} events as the agentic turn
# stream. Injectable for tests.
RunnerFn = Callable[[str, str], "AsyncIterator[dict] | Iterable[dict]"]


class NotesError(Exception):
    pass


def title_for(target: str) -> str:
    return "Working notes" if target == WORKING else store.title_for(target)


def _require_target(target: str) -> None:
    if target != WORKING and not store.get_paper(target):
        raise NotesError(f"Unknown paper: {target}")


def read(target: str) -> str:
    """The current markdown of the target document ('' when none exists yet)."""
    _require_target(target)
    if target == WORKING:
        return store.read_synthesis()
    return store.read_notes(target)


def save(target: str, markdown: str, summary: str = "") -> dict:
    """Write the (human-approved) document and git-commit it, like every change that reaches
    the record. `summary` overrides the default commit message."""
    _require_target(target)
    if not markdown.strip():
        raise NotesError("Notes cannot be saved empty.")
    if target == WORKING:
        store.write_synthesis(markdown)
        msg = summary.strip() or "Edit working notes"
    else:
        store.append_notes_block(target, store.title_for(target), markdown)
        msg = summary.strip() or f"Edit notes: {store.title_for(target)}"
    committer._git("add", "-A")
    try:
        committer._git("commit", "-q", "-m", msg)
    except committer.CommitError as e:
        if "nothing to commit" not in str(e):
            raise
    return {"ok": True, "rev": committer._git("rev-parse", "--short", "HEAD"), "message": msg}


# ---- agent-assisted edit (background job) ----

@dataclass
class NotesJob:
    id: str
    target: str
    instruction: str
    status: str = "running"          # running | done | error
    # Live progress as the client renders it: merged text runs + tool calls, arrival order
    # ({kind:'text', text} | {kind:'tool', name, detail}) — same shape as chat job items.
    items: list = field(default_factory=list)
    result: str | None = None        # the proposed revised markdown, once done
    error: str | None = None
    started_at: str = ""
    finished_at: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


_jobs: dict[str, NotesJob] = {}
_lock = threading.Lock()


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def get_job(job_id: str) -> NotesJob | None:
    with _lock:
        return _jobs.get(job_id)


def snapshot(job_id: str) -> dict | None:
    with _lock:
        job = _jobs.get(job_id)
        return job.to_dict() if job else None


def active_for(target: str) -> NotesJob | None:
    with _lock:
        for job in _jobs.values():
            if job.target == target and job.status == "running":
                return job
    return None


def start_edit(target: str, instruction: str, runner: RunnerFn | None = None) -> NotesJob:
    """Start revising `target`'s notes per `instruction` in a background thread, or join the
    job already running for it. The result stays on the job as a proposal — callers poll
    get_job(id) and apply the revision explicitly via save()."""
    _require_target(target)
    current = read(target)
    if not current.strip():
        raise NotesError("No notes to edit yet for this target.")
    if not instruction.strip():
        raise NotesError("Instruction cannot be empty.")
    with _lock:
        for job in _jobs.values():
            if job.target == target and job.status == "running":
                return job
        job = NotesJob(id=uuid.uuid4().hex, target=target,
                       instruction=instruction.strip(), started_at=_now())
        _register(job)

    prompt = _edit_prompt(target, current, instruction.strip())
    pid = config.active_project_id()
    thread = threading.Thread(target=_run, args=(job, pid, prompt, runner or _default_events),
                              daemon=True, name=f"notes-{job.id[:8]}")
    thread.start()
    return job


def _register(job: NotesJob) -> None:
    _jobs[job.id] = job
    finished = [j for j in _jobs.values() if j.status != "running"]
    if len(finished) > _MAX_FINISHED:
        for stale in sorted(finished, key=lambda j: j.started_at)[:len(finished) - _MAX_FINISHED]:
            _jobs.pop(stale.id, None)


def _edit_prompt(target: str, current: str, instruction: str) -> str:
    return (
        f"=== CURRENT NOTES DOCUMENT: {title_for(target)} ===\n"
        f"{current.strip()}\n"
        f"=== END DOCUMENT ===\n\n"
        f"Instruction: {instruction}"
    )


def _default_events(target: str, prompt: str):
    """Production runner: the tool-using notes editor when the agentic path is enabled, else a
    single-shot completion with the same editor prompt (no tools)."""
    if agent_harness.AGENTIC_ENABLED:
        return agent_harness.stream_agent_events(agent_harness.build_notes_editor(), prompt)

    def _single_shot():
        messages = [{"role": "system", "content": prompts.get("notes_editor")},
                    {"role": "user", "content": prompt}]
        pieces: list[str] = []
        for piece in agent._stream_openrouter(messages, max_tokens=16000):
            pieces.append(piece)
            yield {"type": "text", "text": piece}
        yield {"type": "final", "text": "".join(pieces)}
    return _single_shot()


_FENCE_RE = re.compile(r"^```[a-zA-Z]*\n(.*)\n```\s*$", re.S)


def _strip_fences(text: str) -> str:
    """Models occasionally wrap the whole document in a code fence despite instructions."""
    m = _FENCE_RE.match(text.strip())
    return m.group(1).strip() if m else text.strip()


def _run(job: NotesJob, pid: str | None, prompt: str, runner: RunnerFn) -> None:
    config.set_active_project(pid)
    try:
        events = runner(job.target, prompt)
        if hasattr(events, "__aiter__"):
            final_text = asyncio.run(_consume_async(job, events))
        else:
            final_text = _consume_sync(job, events)
        result = _strip_fences(final_text)
        if not result:
            raise agent.AgentError("The model returned an empty revision. Try again, or "
                                   "switch the analysis model in Settings.")
        with _lock:
            job.result = result
            job.status = "done"
            job.finished_at = _now()
    except Exception as e:
        with _lock:
            job.status = "error"
            job.error = str(e)[:400]
            job.finished_at = _now()


async def _consume_async(job: NotesJob, events: AsyncIterator[dict]) -> str:
    pieces: list[str] = []
    final_text = ""
    async for ev in events:
        _apply(job, ev, pieces)
        if ev["type"] == "final":
            final_text = ev["text"]
    return final_text or "".join(pieces)


def _consume_sync(job: NotesJob, events: Iterable[dict]) -> str:
    pieces: list[str] = []
    final_text = ""
    for ev in events:
        _apply(job, ev, pieces)
        if ev["type"] == "final":
            final_text = ev["text"]
    return final_text or "".join(pieces)


def _apply(job: NotesJob, ev: dict, pieces: list[str]) -> None:
    """Fold one runner event into the job's items. Unlike chat turns there is no section
    protocol to strip — the output IS the document — so text deltas append directly."""
    if ev["type"] == "text" and ev.get("text"):
        pieces.append(ev["text"])
        with _lock:
            if job.items and job.items[-1]["kind"] == "text":
                job.items[-1] = {"kind": "text", "text": job.items[-1]["text"] + ev["text"]}
            else:
                job.items.append({"kind": "text", "text": ev["text"]})
    elif ev["type"] == "tool":
        with _lock:
            job.items.append({"kind": "tool", "name": ev["name"], "detail": ev.get("detail", "")})
