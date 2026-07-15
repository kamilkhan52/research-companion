"""Per-project committed-notes routes (view / edit / agent-assisted edit), the commit review +
approve flow, and adding an unread reading-list entry. `target` is a paper slug or "working"
for the cross-paper working notes; reads and saves are quick plain requests while the agent
edit is a job + poll whose result is a PROPOSAL the client applies via the save endpoint. The
/notes/jobs routes are declared before /notes/{target} so "jobs" is never captured as a target.
See CLAUDE.md invariant 4 (agent proposes, human commits)."""
from __future__ import annotations

from fastapi import HTTPException
from pydantic import BaseModel

from .. import committer, config, notes_jobs, sessions, store
from ..committer import CommitError
from . import make_project_router

project_router = make_project_router()


class ApproveReq(BaseModel):
    slug: str
    notes_block: str | None = None
    synthesis: str | None = None
    summary: str | None = None


class AddPaperReq(BaseModel):
    title: str
    group: str | None = None
    arxiv_id: str | None = None   # recorded as a comment; the paper is not auto-retrieved
    abstract: str | None = None   # pass it when the caller has one (Discover does)


class NotesSaveReq(BaseModel):
    markdown: str
    summary: str | None = None   # optional commit message override


class NotesAgentReq(BaseModel):
    instruction: str


def _paper_dict(slug: str) -> dict:
    p = store.get_paper(slug, sessions.session_states())
    return p.to_dict() if p else {"slug": slug}


@project_router.get("/notes/jobs/active/{target}")
def notes_job_active(target: str):
    """The running notes-edit job for a target, if any — lets a client that navigated away
    reattach instead of finding a silent screen."""
    job = notes_jobs.active_for(target)
    return {"job": notes_jobs.snapshot(job.id) if job else None}


@project_router.get("/notes/jobs/latest/{target}")
def notes_job_latest(target: str):
    """Most recent retained proposal, whether it is still running or ready to apply."""
    job = notes_jobs.latest_for(target)
    return {"job": notes_jobs.snapshot(job.id) if job else None}


@project_router.get("/notes/jobs/{job_id}")
def notes_job_status(job_id: str):
    snap = notes_jobs.snapshot(job_id)
    if not snap:
        raise HTTPException(status_code=404, detail="Unknown notes job")
    return {"job": snap}


@project_router.get("/notes/{target}")
def get_notes(target: str):
    try:
        markdown = notes_jobs.read(target)
    except notes_jobs.NotesError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    return {"target": target, "title": notes_jobs.title_for(target), "markdown": markdown}


@project_router.post("/notes/{target}")
def save_notes(target: str, req: NotesSaveReq):
    """Persist a human-approved notes document (a manual edit, or an applied agent proposal)
    and git-commit it."""
    try:
        result = notes_jobs.save(target, req.markdown, req.summary or "")
    except notes_jobs.NotesError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {**result, "target": target}


@project_router.post("/notes/{target}/agent_job")
def notes_agent_job(target: str, req: NotesAgentReq):
    """Start (or join) a background agent revision of the target's notes from a natural-
    language instruction. Poll /notes/jobs/{id}; the result is applied via POST /notes/{target}."""
    if not config.has_api_key():
        raise HTTPException(status_code=400, detail="No OpenRouter API key set. Open Settings.")
    try:
        job = notes_jobs.start_edit(target, req.instruction)
    except notes_jobs.NotesError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"job": notes_jobs.snapshot(job.id)}


@project_router.get("/review/{slug}")
def get_review(slug: str):
    return committer.review(slug)


@project_router.post("/approve")
def approve(req: ApproveReq):
    # Proposal read + commit are one atomic unit under the session's mutation lock: a branch
    # switch between them could commit branch A's notes over branch B's transcript.
    with sessions.mutation_lock(req.slug):
        proposed = sessions.latest_proposed_commit(req.slug) or {}
        notes = req.notes_block if req.notes_block is not None else proposed.get("notes_block", "")
        synth = req.synthesis if req.synthesis is not None else proposed.get("synthesis", "")
        summary = req.summary or proposed.get("summary", "")
        try:
            result = committer.commit(req.slug, notes, synth, summary)
        except CommitError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
    return {"result": result, "paper": _paper_dict(req.slug)}


@project_router.post("/papers")
def add_paper(pid: str, req: AddPaperReq):
    """Add a new *unread* entry to this project's reading list — e.g. accepting a reference-
    graph recommendation. Metadata only: full text stays lazily retrieved (first time it's
    opened, like every other paper) and nothing is git-committed (like every other change to
    the record, that stays an explicit human action via /approve)."""
    try:
        slug = store.add_entry(req.title, req.group or "Unsorted", arxiv_id=req.arxiv_id,
                               abstract=req.abstract)
    except store.DuplicatePaperError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"paper": _paper_dict(slug)}
