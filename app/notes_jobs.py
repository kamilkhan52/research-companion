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
import contextlib
import hashlib
import re
import threading
from collections.abc import AsyncIterator, Callable, Iterable
from dataclasses import dataclass, field

from . import agent, agent_harness, committer, config, prompts, sessions, store
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
    kind: str = "edit"               # edit | split_destination | split_source_cleanup
    summary: str = ""                # suggested human-approved commit message
    # Optimistic-concurrency token for the document the proposal was generated from. Applying
    # a proposal after the working notes changed would silently overwrite newer human work.
    base_revision: str = ""
    # Live progress as the client renders it: merged text runs + tool calls, arrival order
    # ({kind:'text', text} | {kind:'tool', name, detail}) — same shape as chat job items.
    items: list = field(default_factory=list)
    result: str | None = None        # the proposed revised markdown, once done
    # Relocation integrations are deliberately one paper at a time. These fields let the
    # review UI say "Paper 2 of 4" without exposing the remaining papers' Notes payload.
    relocation_index: int | None = None
    relocation_total: int | None = None
    relocation_title: str | None = None


# `_jobs` aliases the registry dict so tests can clear() it to reset.
_registry: JobRegistry[NotesJob] = JobRegistry("notes", max_finished=20, metered=True)
_jobs = _registry.jobs
_mutation_locks_guard = threading.Lock()
_mutation_locks: dict[tuple[str | None, str], threading.RLock] = {}
_RELOCATION_QUEUE_ATTR = "_rc_relocation_queue"


@contextlib.contextmanager
def mutation_lock(target: str):
    """Serialize capture/check/apply sequences for one project's notes document."""
    key = (config.active_project_id(), target)
    with _mutation_locks_guard:
        lock = _mutation_locks.setdefault(key, threading.RLock())
    with lock:
        yield


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


def discard(job_id: str, *, target: str | None = None) -> bool:
    """Forget a settled proposal after the user applies or explicitly discards it.

    Completed proposals live only in the in-process registry. Removing one here keeps
    ``latest_for`` useful for re-entry without making an applied/discarded proposal reappear.
    A running job cannot be discarded through this proposal-only path.
    """
    visible = _registry.get(job_id)
    if visible is None or (target is not None and visible.target != target):
        return False
    with _registry.lock:
        job = _registry.jobs.get(job_id)
        if (job is None or job.status == "running"
                or (target is not None and job.target != target)):
            return False
        _registry.jobs.pop(job_id, None)
    return True


def discard_if_applied(target: str) -> bool:
    """Resolve a retained proposal whose exact result is now the committed document.

    R8.2-era clients apply through the notes-save endpoint without sending a job id. Exact
    content matching preserves that wire contract without letting an unrelated manual save
    discard a proposal.
    """
    latest = latest_for(target)
    if (
        latest is None
        or latest.status != "done"
        or not latest.result
        or read(target).strip() != latest.result.strip()
    ):
        return False
    return discard(latest.id, target=target)


def revision(target: str) -> str:
    """Stable revision of the exact committed notes document (including the empty document)."""
    return _content_revision(read(target))


def _content_revision(markdown: str) -> str:
    return hashlib.sha256(markdown.encode("utf-8")).hexdigest()[:16]


def start_edit(target: str, instruction: str, runner: RunnerFn | None = None) -> NotesJob:
    """Start revising `target`'s notes per `instruction` in a background thread, or join the
    job already running for it. The result stays on the job as a proposal — callers poll
    get_job(id) and apply the revision explicitly via save()."""
    with mutation_lock(target):
        _require_target(target)
        current = read(target)
        if not current.strip():
            raise NotesError("No notes to edit yet for this target.")
        if not instruction.strip():
            raise NotesError("Instruction cannot be empty.")
        instruction = instruction.strip()
        prompt = _edit_prompt(target, current, instruction)
        return _start_proposal(
            target,
            instruction,
            prompt,
            base_revision=_content_revision(current),
            runner=runner,
            kind="edit",
            summary=f"Notes edit (agent): {instruction}",
            reject_running=False,
        )


#: Cap on the discussion context folded into a mid-paper notes proposal. The tail is kept —
#: the newest exchanges are the ones not yet in the notes.
DISCUSSION_CONTEXT_CHARS = 24_000


def start_discussion_update(target: str, thread_id: str | None = None,
                            runner: RunnerFn | None = None) -> NotesJob:
    """Propose a notes update from the discussion so far (DR-043) — any time, not only at
    paper finish. Reached from the client's Update-notes button and from the analyst's
    `propose_notes_update` tool (which passes no thread: inside a chat worker the ambient
    thread contextvar names the conversation the tool was called from).

    Unlike `start_edit`, the target may have no committed notes yet — mid-paper is exactly when
    they usually don't exist — so the model drafts or integrates. Invariant 4 is untouched:
    the result is a proposal on the job, applied only by an explicit human `save()`.
    """
    with mutation_lock(target):
        _require_target(target)
        if target == WORKING:
            raise NotesError("Discussion updates target a paper's notes, not the working notes.")
        current = read(target)
        parts: list[str] = []
        for record in sessions.read_records(target, thread_id):
            role = record.get("role")
            text = (record.get("text") or "").strip()
            if role in ("user", "assistant") and text:
                parts.append(f"[{role}] {text}")
        discussion = "\n\n".join(parts)[-DISCUSSION_CONTEXT_CHARS:]
        if not discussion.strip():
            raise NotesError("There is no discussion to fold into the notes yet.")
        title = title_for(target)
        action = "Integrate the discussion into" if current.strip() else "Draft"
        instruction = f"Fold the discussion so far into the notes for {title}."
        prompt = (
            "=== CURRENT COMMITTED NOTES ===\n"
            f"{current.strip() or '(none yet)'}\n"
            "=== END CURRENT NOTES ===\n\n"
            "=== DISCUSSION SO FAR (newest last) ===\n"
            f"{discussion}\n"
            "=== END DISCUSSION ===\n\n"
            f"Instruction: {action} this paper's notes and return the COMPLETE document. "
            "Capture the findings, methods, quantitative results, quoted evidence, and open "
            "questions the discussion has established that the current notes do not yet hold. "
            "Use ONLY the supplied discussion and current notes — no external research, no "
            "invented material. Preserve existing content unless the integration requires "
            "reorganizing it; keep the paper's own terminology and any markdown links intact."
        )
        return _start_proposal(
            target,
            instruction,
            prompt,
            base_revision=_content_revision(current),
            runner=runner,
            kind="discussion_update",
            summary=f"Notes from the discussion: {title}",
            reject_running=False,
        )


def start_split_destination(
    papers: list[dict],
    *,
    source_name: str,
    runner: RunnerFn | None = None,
    allow_busy: bool = False,
) -> NotesJob:
    """Propose working notes for the destination after papers were split/moved into it.

    Unlike a normal edit, the destination may not have working notes yet. Only committed
    per-paper Notes captured before the relocation are supplied; the model is explicitly
    forbidden from inventing or researching beyond that material.
    """
    with mutation_lock(WORKING):
        usable = _usable_papers(papers)
        if not usable:
            raise NotesError("The selected papers do not have committed Notes to synthesize.")
        current = read(WORKING)
        action = "integrate into" if current.strip() else "draft"
        instruction = (
            f"{action.capitalize()} the destination project's working notes from "
            f"{len(usable)} paper{'s' if len(usable) != 1 else ''} moved from {source_name}."
        )
        prompt = (
            "=== CURRENT DESTINATION WORKING NOTES ===\n"
            f"{current.strip() or '(none yet)'}\n"
            "=== END CURRENT WORKING NOTES ===\n\n"
            "=== MIGRATED PAPER CONTEXT ===\n"
            f"{_paper_notes_context(usable, include_research_context=True)}\n"
            "=== END MIGRATED PAPER CONTEXT ===\n\n"
            "Instruction: Produce the COMPLETE destination working-notes document. Integrate "
            "the migrated papers' established findings, methods, relationships, tensions, and "
            "open questions into the current document; if it is empty, create a concise, "
            "well-structured first synthesis. Use ONLY the supplied committed Notes, paper "
            "text, discussion context, and current document. Do not add external research, "
            "invent facts, or imply unsupported relationships. Preserve current content unless "
            "integration requires reorganization."
        )
        return _start_proposal(
            WORKING,
            instruction,
            prompt,
            base_revision=_content_revision(current),
            runner=runner,
            kind="split_destination",
            summary=f"Integrate {len(usable)} moved paper(s) into working notes",
            reject_running=True,
            allow_busy=allow_busy,
        )


def start_split_destination_queue(
    papers: list[dict],
    *,
    source_name: str,
    runner: RunnerFn | None = None,
    allow_busy: bool = False,
) -> NotesJob:
    """Start a destination integration queue, one migrated paper per human review.

    The queue is kept as private in-process job metadata, matching the existing proposal
    lifecycle: completed notes proposals themselves live in the single-worker registry until
    applied or discarded. Only the current paper's title and position serialize to clients;
    the remaining Notes never leak through a job snapshot.
    """
    usable = _usable_papers(papers)
    if not usable:
        raise NotesError("The selected papers do not have committed Notes to synthesize.")
    queue = {
        "papers": usable,
        "source_name": source_name,
        "runner": runner,
        "index": 0,
    }
    return _start_relocation_queue_item(queue, allow_busy=allow_busy)


def resolve_and_advance(job_id: str, *, target: str | None = None) -> dict:
    """Discard a settled proposal and, when it belongs to a relocation queue, start the next
    paper's proposal against the now-current working notes.

    Call this only after an Apply has committed the current result, or when the person explicitly
    discards it. A scheduling failure does not undo the already-committed Apply; it is returned
    beside the successful resolution so the client can explain and recover.
    """
    job = get_job(job_id)
    if job is None or (target is not None and job.target != target):
        return {"ok": False, "next_job": None, "next_error": None}
    queue = getattr(job, _RELOCATION_QUEUE_ATTR, None)
    if not discard(job_id, target=target):
        return {"ok": False, "next_job": None, "next_error": None}
    if not queue:
        return {"ok": True, "next_job": None, "next_error": None}

    queue["index"] += 1
    if queue["index"] >= len(queue["papers"]):
        return {"ok": True, "next_job": None, "next_error": None}
    try:
        next_job = _start_relocation_queue_item(queue)
    except (NotesError, RuntimeError) as e:
        return {"ok": True, "next_job": None, "next_error": str(e)}
    return {"ok": True, "next_job": snapshot(next_job.id), "next_error": None}


def _start_relocation_queue_item(queue: dict, *, allow_busy: bool = False) -> NotesJob:
    index = int(queue["index"])
    paper = queue["papers"][index]
    job = start_split_destination(
        [paper],
        source_name=str(queue["source_name"]),
        runner=queue.get("runner"),
        allow_busy=allow_busy,
    )
    job.relocation_index = index + 1
    job.relocation_total = len(queue["papers"])
    job.relocation_title = str(
        paper.get("title") or paper.get("slug") or "Untitled paper"
    ).strip()
    setattr(job, _RELOCATION_QUEUE_ATTR, queue)
    return job


def start_split_source_cleanup(
    papers: list[dict],
    *,
    destination_name: str,
    runner: RunnerFn | None = None,
    allow_busy: bool = False,
) -> NotesJob:
    """Propose removing departed papers' contributions from the source working notes."""
    with mutation_lock(WORKING):
        current = read(WORKING)
        if not current.strip():
            raise NotesError("This project has no working notes to clean up.")
        usable = _usable_papers(papers)
        if not usable:
            raise NotesError("The moved papers did not have committed Notes to identify.")
        instruction = (
            f"Remove contributions attributable to {len(usable)} paper"
            f"{'s' if len(usable) != 1 else ''} moved to {destination_name}."
        )
        prompt = (
            "=== CURRENT SOURCE WORKING NOTES ===\n"
            f"{current.strip()}\n"
            "=== END CURRENT WORKING NOTES ===\n\n"
            "=== DEPARTED PAPERS AND THEIR COMMITTED NOTES ===\n"
            f"{_paper_notes_context(usable)}\n"
            "=== END DEPARTED PAPER NOTES ===\n\n"
            "Instruction: Produce the COMPLETE revised source working-notes document. Remove "
            "only claims, evidence, comparisons, and framing attributable exclusively to the "
            "departed papers. Preserve material supported by papers that remain, including "
            "shared insights or cross-paper synthesis that is still valid. Reflow headings and "
            "transitions only as needed after removal. Do not add new facts, research, or "
            "interpretations. If a passage cannot be confidently tied to the departed Notes, "
            "keep it."
        )
        return _start_proposal(
            WORKING,
            instruction,
            prompt,
            base_revision=_content_revision(current),
            runner=runner,
            kind="split_source_cleanup",
            summary=f"Clean working notes after moving {len(usable)} paper(s)",
            reject_running=True,
            allow_busy=allow_busy,
        )


def _usable_papers(papers: list[dict]) -> list[dict]:
    return [p for p in papers if str(p.get("notes") or "").strip()]


def _paper_discussion_context(slug: str) -> str:
    sections: list[str] = []
    for thread in sessions.list_threads(slug):
        turns: list[str] = []
        for record in sessions.read_records(slug, thread["id"]):
            if record.get("role") == "user" and record.get("kind") == "reply":
                turns.append(f"Reader: {record.get('text', '').strip()}")
            elif (record.get("role") == "user" and record.get("kind") == "revision"
                  and record.get("authored_text")):
                turns.append(f"Reader revision: {record['authored_text'].strip()}")
            elif (record.get("role") == "assistant" and not record.get("proposed_commit")
                  and record.get("canonical", "").strip()):
                turns.append(f"Analyst: {record['canonical'].strip()}")
        if turns:
            sections.append(
                f"### Discussion: {thread['title']}\n" + "\n\n".join(turns)
            )
    return "\n\n".join(sections)


def _paper_notes_context(
    papers: list[dict], *, include_research_context: bool = False
) -> str:
    sections = []
    for paper in papers:
        title = str(paper.get("title") or paper.get("slug") or "Untitled paper").strip()
        slug = str(paper.get("slug") or "").strip()
        label = f"{title} (slug: {slug})" if slug else title
        parts = [f"## {label}", "### Committed Notes", str(paper["notes"]).strip()]
        if include_research_context and slug:
            full_text = store.read_full_text(slug).strip()
            if full_text:
                parts.extend(["### Full paper text", full_text])
            discussion = _paper_discussion_context(slug)
            if discussion:
                parts.extend(["### Relevant discussion", discussion])
        sections.append("\n".join(parts))
    return "\n\n".join(sections)


def _start_proposal(
    target: str,
    instruction: str,
    prompt: str,
    *,
    base_revision: str,
    runner: RunnerFn | None,
    kind: str,
    summary: str,
    reject_running: bool,
    allow_busy: bool = False,
) -> NotesJob:
    runner = runner or _default_events

    def admit(existing: NotesJob | None) -> None:
        if existing is None or existing.status in {"error", "cancelled"}:
            return
        if existing.status == "done" and existing.result:
            raise NotesError(
                "Review, apply, or discard the existing notes proposal before starting another."
            )
        if reject_running and existing.status == "running":
            raise NotesError(
                "A notes proposal is already running for this project. "
                "Wait for it, then apply or discard it before starting another."
            )

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
        target,
        lambda: NotesJob(
            id=new_id(),
            target=target,
            instruction=instruction,
            kind=kind,
            summary=summary,
            base_revision=base_revision,
        ),
        work,
        admit=admit,
        allow_busy=allow_busy,
    )


def _edit_prompt(target: str, current: str, instruction: str) -> str:
    return (
        f"=== CURRENT NOTES DOCUMENT: {title_for(target)} ===\n"
        f"{current.strip()}\n"
        f"=== END DOCUMENT ===\n\n"
        f"Instruction: {instruction}"
    )


def _single_shot_notes_events(prompt: str):
    """Single-shot notes edit in the runner's event shape — the non-agentic path, and the
    fallback when the tool-using notes editor can't tool-call."""
    system = prompts.get("notes_editor") + "\n\n" + agent.MATH_MARKDOWN_CONTRACT
    messages = [{"role": "system", "content": system},
                {"role": "user", "content": prompt}]
    pieces: list[str] = []
    for piece in agent.stream_messages(messages, max_tokens=agent.NOTES_MAX_TOKENS, operation="notes"):
        pieces.append(piece)
        yield {"type": "text", "text": piece}
    yield {"type": "final", "text": "".join(pieces)}


def _default_events(target: str, prompt: str):
    """Production runner: the tool-using notes editor when the agentic path is enabled, else a
    single-shot completion with the same editor prompt (no tools). A tool-incompatible model
    falls back to the single-shot editor rather than failing the edit (R12.8)."""
    if agent_harness.AGENTIC_ENABLED:
        return agent_harness.stream_with_single_shot_fallback(
            lambda: agent_harness.stream_agent_events(
                agent_harness.build_notes_editor(), prompt, operation="notes"),
            lambda: _single_shot_notes_events(prompt),
        )
    return _single_shot_notes_events(prompt)


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
