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
from collections.abc import AsyncIterator, Callable, Iterable
from dataclasses import dataclass, field

from . import agent, agent_harness, committer, prompts, store
from .jobs import Job, JobRegistry, new_id

# The pseudo-target for the cross-paper working notes; anything else is a paper slug.
WORKING = "working"

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
class NotesJob(Job):
    target: str = ""                 # notes document being edited (also the registry dedup key)
    instruction: str = ""
    # Live progress as the client renders it: merged text runs + tool calls, arrival order
    # ({kind:'text', text} | {kind:'tool', name, detail}) — same shape as chat job items.
    items: list = field(default_factory=list)
    result: str | None = None        # the proposed revised markdown, once done


# `_jobs` aliases the registry dict so tests can clear() it to reset.
_registry: JobRegistry[NotesJob] = JobRegistry("notes", max_finished=20)
_jobs = _registry.jobs


def get_job(job_id: str) -> NotesJob | None:
    return _registry.get(job_id)


def snapshot(job_id: str) -> dict | None:
    return _registry.snapshot(job_id)


def active_for(target: str) -> NotesJob | None:
    return _registry.active_for(target)


def latest_for(target: str) -> NotesJob | None:
    """Return the most recent proposal for re-entry, including a settled one.

    The generated markdown intentionally lives only on its job until a person applies it.
    Looking up only a running job would therefore discard a completed proposal whenever the
    editor navigated away before the final poll.
    """
    return _registry.latest_for(target)


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
    instruction = instruction.strip()
    runner = runner or _default_events
    prompt = _edit_prompt(target, current, instruction)

    def work(job: NotesJob) -> None:
        events = runner(job.target, prompt)
        if hasattr(events, "__aiter__"):
            final_text = asyncio.run(_consume_async(job, events))
        else:
            final_text = _consume_sync(job, events)
        result = _strip_fences(final_text)
        if not result:
            raise agent.AgentError("The model returned an empty revision. Try again, or "
                                   "switch the analysis model in Settings.")
        with _registry.lock:
            job.result = result

    return _registry.start_or_join(
        target, lambda: NotesJob(id=new_id(), target=target, instruction=instruction), work)


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
        for piece in agent.stream_messages(messages, max_tokens=16000, operation="notes"):
            pieces.append(piece)
            yield {"type": "text", "text": piece}
        yield {"type": "final", "text": "".join(pieces)}
    return _single_shot()


_FENCE_RE = re.compile(r"^```[a-zA-Z]*\n(.*)\n```\s*$", re.S)


def _strip_fences(text: str) -> str:
    """Models occasionally wrap the whole document in a code fence despite instructions."""
    m = _FENCE_RE.match(text.strip())
    return m.group(1).strip() if m else text.strip()


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
        with _registry.lock:
            if job.items and job.items[-1]["kind"] == "text":
                job.items[-1] = {"kind": "text", "text": job.items[-1]["text"] + ev["text"]}
            else:
                job.items.append({"kind": "text", "text": ev["text"]})
    elif ev["type"] == "tool":
        with _registry.lock:
            job.items.append({"kind": "tool", "name": ev["name"], "detail": ev.get("detail", "")})
