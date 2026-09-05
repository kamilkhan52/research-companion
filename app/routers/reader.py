"""Reading assistants for cited-but-unread project papers (DR-140): the candidate list a
response earns, the job that briefs the chosen papers, and its polling routes. The follow-up
turn the job chains is an ordinary chat job — clients watch it through `/chat/jobs/…`."""
from __future__ import annotations

from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field

from .. import config, reader_jobs, sessions
from ..reader_jobs import ReaderError
from . import make_project_router

project_router = make_project_router()


class ReaderStartReq(BaseModel):
    slug: str
    targets: list[str] = Field(min_length=1, max_length=reader_jobs.MAX_TARGETS)
    thread_id: str = sessions.MAIN_THREAD
    assistant_index: int | None = None
    delivery_mode: Literal["reading", "listening"] = "reading"


def _thread_id(value: str | None) -> str:
    try:
        return sessions.validate_thread_id(value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@project_router.get("/reader/candidates/{slug}")
def reader_candidates(slug: str, thread_id: str = sessions.MAIN_THREAD,
                      assistant_index: int | None = None):
    """The project papers a response cited without their having been read here — what the
    offer lists. Deterministic (the response's own `rc-paper:` links); no model is asked."""
    thread_id = _thread_id(thread_id)
    if thread_id != sessions.MAIN_THREAD:
        known = {thread["id"] for thread in sessions.list_threads(slug)}
        if thread_id not in known:
            raise HTTPException(status_code=404, detail="Unknown discussion thread")
    with sessions.thread_scope(thread_id):
        try:
            return reader_jobs.candidates(slug, thread_id, assistant_index)
        except ReaderError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc


@project_router.post("/reader/jobs")
def start_reader_job(req: ReaderStartReq):
    """Start (or join) the reading pass: one assistant per chosen paper, then the analyst's
    follow-up turn on the briefs. Spend and rate refusals surface as the usual 429/402."""
    thread_id = _thread_id(req.thread_id)
    with sessions.thread_scope(thread_id), sessions.paper_lock(req.slug), \
            sessions.mutation_lock(req.slug):
        if config.project_is_busy(config.active_project_id()):
            raise HTTPException(
                status_code=409,
                detail="This project is being moved or split — wait, then try again.",
            )
        try:
            job = reader_jobs.start_reading(
                req.slug, req.targets, thread_id=thread_id,
                assistant_index=req.assistant_index, delivery_mode=req.delivery_mode,
            )
        except ReaderError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"job": reader_jobs.snapshot(job.id)}


@project_router.get("/reader/jobs/active/{slug}")
def active_reader_job(slug: str, thread_id: str = sessions.MAIN_THREAD):
    job = reader_jobs.active_for(slug, _thread_id(thread_id))
    return {"job": reader_jobs.snapshot(job.id) if job else None}


@project_router.get("/reader/jobs/latest/{slug}")
def latest_reader_job(slug: str, thread_id: str = sessions.MAIN_THREAD):
    """Newest retained pass for re-entry, including one that finished while the reader was
    away (its `analysis_job_id` is how the client finds the follow-up turn)."""
    job = reader_jobs.latest_for(slug, _thread_id(thread_id))
    return {"job": reader_jobs.snapshot(job.id) if job else None}


@project_router.get("/reader/jobs/{job_id}")
def reader_job_status(job_id: str):
    snap = reader_jobs.snapshot(job_id)
    if not snap:
        raise HTTPException(status_code=404, detail="Unknown reader job")
    return {"job": snap}


@project_router.post("/reader/jobs/{job_id}/cancel")
def cancel_reader_job(job_id: str):
    snap = reader_jobs.request_cancel(job_id)
    if not snap:
        raise HTTPException(status_code=404, detail="Unknown reader job")
    return {"job": snap}
