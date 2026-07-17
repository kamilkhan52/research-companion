"""Connection-independent paper retrieval jobs.

Retrieval can spend minutes pacing arXiv, downloading a PDF, extracting it, and optionally
running the agentic PDF hunt. The work therefore lives in the shared background JobRegistry;
clients start a job and poll snapshots instead of holding one HTTP request open.
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field

from . import config, cover_jobs, retrieval_agent, retriever, store
from .jobs import Job, JobRegistry, new_id, now_iso
from .retriever import RetrievalError

RetrieveFn = Callable[[str, str | None, str | None], dict]
HuntFn = Callable[[str], AsyncIterator[dict]]


@dataclass
class RetrievalJob(Job):
    slug: str = ""
    phase: str = "resolving"  # resolving | hunting | confirmation | done
    detail: str = ""
    items: list = field(default_factory=list)
    candidates: list = field(default_factory=list)
    retrieved: bool = False
    # Auto-analysis chain (R7.8): when the caller asked for a first analysis, the chat job it
    # spawned after successful retrieval — pollers follow this id to know when the opening
    # response (and audio) is ready. Best-effort: a failure here never fails the retrieval.
    analysis_job_id: str | None = None
    analysis_error: str | None = None


_registry: JobRegistry[RetrievalJob] = JobRegistry("retrieval", max_finished=30)
_jobs = _registry.jobs


def snapshot(job_id: str) -> dict | None:
    return _registry.snapshot(job_id)


def latest_for(slug: str) -> RetrievalJob | None:
    return _registry.latest_for(slug)


def set_analysis_job(job: RetrievalJob, chat_job_id: str) -> None:
    with _registry.lock:
        job.analysis_job_id = chat_job_id


def set_analysis_error(job: RetrievalJob, message: str) -> None:
    with _registry.lock:
        job.analysis_error = message[:400]


def start_retrieval(
    slug: str,
    arxiv_id: str | None = None,
    pdf_url: str | None = None,
    *,
    retrieve_fn: RetrieveFn = retriever.retrieve,
    hunt_fn: HuntFn = retrieval_agent.stream_hunt,
    after_retrieved: Callable[[RetrievalJob], None] | None = None,
) -> RetrievalJob:
    paper = store.get_paper(slug)
    if not paper:
        raise RetrievalError("Unknown paper")

    if paper.retrieved and not arxiv_id and not pdf_url:
        return _registry.put(
            slug,
            RetrievalJob(
                id=new_id(), slug=slug, status="done", phase="done", retrieved=True,
                finished_at=now_iso(),
            ),
        )

    def work(job: RetrievalJob) -> None:
        first_error: str | None = None
        with _registry.lock:
            job.detail = arxiv_id or pdf_url or paper.title[:80]
        try:
            result = retrieve_fn(paper.title, arxiv_id, pdf_url)
        except RetrievalError as exc:
            result = None
            first_error = str(exc)

        if result and result.get("needs_confirmation"):
            with _registry.lock:
                job.phase = "confirmation"
                job.candidates = result.get("candidates") or []
            return

        if result:
            _persist(slug, paper.title, result["full_text"], result.get("arxiv_id"),
                     result.get("source"), match_score=result.get("score"))
            # An id the user explicitly supplied corrects any machine-resolved one on the
            # entry (a wrong title-search match must not outlive the correction). Only when
            # the result IS that id: a failed explicit download falls back to title search,
            # whose machine-selected id must not masquerade as the user's.
            if (arxiv_id and result.get("arxiv_id")
                    and store.arxiv_base_id(result["arxiv_id"]) == store.arxiv_base_id(arxiv_id)):
                store.annotate_entry(slug, arxiv_id=result["arxiv_id"], authoritative=True)
            # Reuse the PDF retrieval just downloaded to render the cover — no second download.
            cover_jobs.render_from_pdf(slug, result.get("pdf_bytes"))
            with _registry.lock:
                job.phase = "done"
                job.retrieved = True
            return

        if not config.has_api_key():
            raise RetrievalError(first_error or "Paper retrieval failed.")

        with _registry.lock:
            job.phase = "hunting"
        asyncio.run(_consume_hunt(job, paper.title, first_error, hunt_fn))

    def work_then_analyze(job: RetrievalJob) -> None:
        work(job)
        if after_retrieved is None or not job.retrieved:
            return
        try:
            after_retrieved(job)
        except Exception as exc:  # noqa: BLE001 — the analysis chain is best-effort;
            # a failure here must never turn a successful retrieval into an error.
            with _registry.lock:
                job.analysis_error = str(exc)[:400]

    return _registry.start_or_join(
        slug,
        lambda: RetrievalJob(id=new_id(), slug=slug),
        work_then_analyze if after_retrieved else work,
    )


async def _consume_hunt(
    job: RetrievalJob, title: str, first_error: str | None, hunt_fn: HuntFn,
) -> None:
    async for event in hunt_fn(title):
        if event["type"] == "tool":
            with _registry.lock:
                job.items.append({
                    "kind": "tool",
                    "name": event["name"],
                    "detail": event.get("detail", ""),
                })
            continue
        if event["type"] != "result":
            continue
        if event.get("ok") and event.get("full_text"):
            _persist(job.slug, title, event["full_text"], None, event.get("source"))
            with _registry.lock:
                job.phase = "done"
                job.retrieved = True
            return
        detail = event.get("summary") or "The PDF hunt came up empty."
        raise RetrievalError(f"{first_error or 'Retrieval failed.'} {detail}".strip())
    raise RetrievalError(first_error or "The PDF hunt ended without a result.")


def _persist(slug: str, title: str, full_text: str, arxiv_id: str | None,
             source: str | None, match_score: float | None = None) -> None:
    store.write_full_text(slug, title, full_text, {
        "slug": slug,
        "arxiv_id": arxiv_id,
        "source": source,
        "match_score": match_score,
    })
