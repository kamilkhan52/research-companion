"""Per-project committed-notes routes (view / edit / agent-assisted edit), the commit review +
approve flow, and adding an unread reading-list entry. `target` is a paper slug or "working"
for the cross-paper working notes; reads and saves are quick plain requests while the agent
edit is a job + poll whose result is a PROPOSAL the client applies via the save endpoint. The
/notes/jobs routes are declared before /notes/{target} so "jobs" is never captured as a target.
See CLAUDE.md invariant 4 (agent proposes, human commits)."""
from __future__ import annotations

from fastapi import HTTPException
from pydantic import BaseModel

from .. import (
    chat_jobs,
    committer,
    config,
    notes_jobs,
    paper_identity,
    projects,
    sessions,
    store,
)
from ..committer import CommitError
from . import make_project_router

project_router = make_project_router()


class ApproveReq(BaseModel):
    slug: str
    thread_id: str = sessions.MAIN_THREAD
    notes_block: str | None = None
    synthesis: str | None = None
    summary: str | None = None
    # Required whenever notes_block/synthesis are sent explicitly (a review screen's edited
    # payload): proves the payload was reviewed against the proposal that is still live.
    proposal_revision: str | None = None


class AddPaperReq(BaseModel):
    title: str
    group: str | None = None
    arxiv_id: str | None = None   # recorded as a comment; the paper is not auto-retrieved
    abstract: str | None = None   # pass it when the caller has one (Discover does)
    year: int | None = None       # pass it when the caller has one (graph nodes do); only
                                  # recorded for papers whose arXiv id can't date them


class PaperMatchReq(BaseModel):
    title: str
    arxiv_id: str | None = None
    source_url: str | None = None


class NotesSaveReq(BaseModel):
    markdown: str
    summary: str | None = None   # optional commit message override
    # Present when applying an agent proposal. The save is rejected if the committed document
    # changed after the job captured its input; manual edits intentionally omit it.
    base_revision: str | None = None
    job_id: str | None = None


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


@project_router.post("/notes/jobs/{job_id}/discard")
def notes_job_discard(job_id: str):
    """Dismiss a settled proposal. A relocation queue advances to its next paper."""
    job = notes_jobs.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Unknown or still-running notes job")
    with notes_jobs.mutation_lock(job.target):
        resolved = notes_jobs.resolve_and_advance(job_id, target=job.target)
    if not resolved["ok"]:
        raise HTTPException(status_code=404, detail="Unknown or still-running notes job")
    return resolved


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
    and git-commit it. Held under the project write guard (task #75): notes_jobs.save stages
    with git add, which must not overlap a split/move's index writes."""
    try:
        with config.project_write_guard(config.active_project_id()), \
                notes_jobs.mutation_lock(target):
            if req.base_revision is not None and req.base_revision != notes_jobs.revision(target):
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "These notes changed after the AI proposal was prepared. Reload the "
                        "document and generate or review a fresh proposal."
                    ),
                )
            result = notes_jobs.save(target, req.markdown, req.summary or "")
            if req.job_id:
                advance = notes_jobs.resolve_and_advance(req.job_id, target=target)
            else:
                # Compatibility with pre-R8.3 clients, whose apply request has no job id.
                # Exact stored-result matching prevents their applied proposal from remaining
                # retained and blocking the next revision.
                notes_jobs.discard_if_applied(target)
                advance = {"next_job": None, "next_error": None}
    except config.ProjectBusyError as e:
        raise HTTPException(
            status_code=409,
            detail="This project is being moved or split — wait, then save notes.",
        ) from e
    except notes_jobs.NotesError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {
        **result,
        "target": target,
        "next_job": advance["next_job"],
        "next_error": advance["next_error"],
    }


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
def get_review(slug: str, thread_id: str = sessions.MAIN_THREAD):
    try:
        with sessions.thread_scope(thread_id):
            return committer.review(slug)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@project_router.post("/approve")
def approve(req: ApproveReq):
    # Held under the project write guard (task #75): committer.commit git-commits, which must
    # not overlap a split/move's index writes. Inside it, proposal read + commit are one atomic
    # unit under the session's mutation lock: a branch switch between them could commit branch
    # A's notes over branch B's transcript.
    try:
        with sessions.thread_scope(req.thread_id), \
                config.project_write_guard(config.active_project_id()), \
                sessions.paper_lock(req.slug), \
                sessions.mutation_lock(req.slug), \
                notes_jobs.mutation_lock(notes_jobs.WORKING):
            # Runtime import avoids a router-module import cycle; this is the compatibility
            # guard for legacy web SSE clients (mobile turns are all chat_jobs).
            from . import session as session_routes
            if (any(chat_jobs.active_for(req.slug, row["id"])
                    for row in sessions.list_threads(req.slug))
                    or session_routes.any_sse_turn_active(req.slug)):
                raise HTTPException(
                    status_code=409,
                    detail="Wait for every discussion response to finish before approving notes.",
                )
            if req.notes_block is not None or req.synthesis is not None:
                live = sessions.proposal_revision(req.slug)
                if req.proposal_revision != live:
                    raise HTTPException(status_code=409, detail=(
                        "The proposal changed since this review was loaded (a branch switch or "
                        "regeneration) — reload the review before approving."))
            proposed = sessions.latest_proposed_commit(req.slug) or {}
            notes = (req.notes_block if req.notes_block is not None
                     else proposed.get("notes_block", ""))
            synth = req.synthesis if req.synthesis is not None else proposed.get("synthesis", "")
            summary = req.summary or proposed.get("summary", "")
            try:
                result = committer.commit(req.slug, notes, synth, summary)
            except CommitError as e:
                raise HTTPException(status_code=400, detail=str(e)) from e
    except config.ProjectBusyError as e:
        raise HTTPException(
            status_code=409,
            detail="This project is being moved or split — wait, then approve.",
        ) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"result": result, "paper": _paper_dict(req.slug)}


@project_router.post("/papers")
def add_paper(pid: str, req: AddPaperReq):
    """Add a new *unread* entry to this project's reading list — e.g. accepting a reference-
    graph recommendation. Metadata only: full text stays lazily retrieved (first time it's
    opened, like every other paper) and nothing is git-committed (like every other change to
    the record, that stays an explicit human action via /approve). Held under the project write
    guard (task #75): the reading-list append must not interleave with a split/move's."""
    # Keep the server authoritative even if an older client has no preflight UI. This is a
    # read-only cross-project scan; reuse itself remains an explicit, human-confirmed move/copy.
    try:
        with paper_identity.add_guard():
            elsewhere = paper_identity.find_locations(
                title=req.title,
                arxiv_id=req.arxiv_id,
                exclude_pid=pid,
            )
            if elsewhere:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "paper_exists_elsewhere",
                        "message": "This paper already exists in another project.",
                        "matches": elsewhere,
                    },
                )
            with config.project_write_guard(pid):
                slug = store.add_entry(
                    req.title,
                    req.group or "Unsorted",
                    arxiv_id=req.arxiv_id,
                    abstract=req.abstract,
                    year=req.year,
                )
    except config.ProjectBusyError as e:
        raise HTTPException(
            status_code=409,
            detail="This project is being moved or split — wait, then add papers.",
        ) from e
    except store.DuplicatePaperError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"paper": _paper_dict(slug)}


@project_router.post("/paper-matches")
def paper_matches(pid: str, req: PaperMatchReq):
    """Read-only preflight for every add surface.

    Strong scholarly identifiers win; exact normalized title is only a conservative fallback.
    The response says what reusable work exists so the client can explain Copy vs Move before
    calling the existing relocation endpoint.
    """
    if not projects.exists(pid):
        raise HTTPException(status_code=404, detail=f"Unknown project: {pid}")
    target = projects._read_meta(pid)
    return {
        "target_project": {"id": pid, "name": target.get("name") or pid},
        "can_update_notes": config.has_api_key(),
        "matches": paper_identity.find_locations(
            title=req.title,
            arxiv_id=req.arxiv_id,
            source_url=req.source_url,
            exclude_pid=pid,
        ),
    }
