"""Connection-independent paper retrieval jobs.

Retrieval can spend minutes pacing arXiv, downloading a PDF, extracting it, and optionally
running the agentic PDF hunt. The work therefore lives in the shared background JobRegistry;
clients start a job and poll snapshots instead of holding one HTTP request open.
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field

from . import (
    canonical_jobs,
    config,
    cover_jobs,
    quotas,
    rate_limits,
    retrieval_agent,
    retriever,
    spend_ceiling,
    store,
)
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
    # Identity discovered by the deterministic resolver. The reading-list title is never
    # rewritten silently; clients may show this as a human-confirmed rename after retrieval.
    matched_title: str | None = None
    arxiv_id: str | None = None
    source: str | None = None
    # Auto-analysis chain (R7.8): when the caller asked for a paper summary, the chat job it
    # spawned after successful retrieval — pollers follow this id to know when the opening
    # response (and audio) is ready. Best-effort: a failure here never fails the retrieval.
    analysis_job_id: str | None = None
    analysis_error: str | None = None
    canonical_job_id: str | None = None


_registry: JobRegistry[RetrievalJob] = JobRegistry("retrieval", max_finished=30, metered=True)
_jobs = _registry.jobs


def snapshot(job_id: str) -> dict | None:
    data = _registry.snapshot(job_id)
    if data is None:
        return None
    canonical_job_id = data.pop("canonical_job_id", None)
    # Merge cross-registry progress only after the retrieval snapshot releases its lock.
    child = canonical_jobs.snapshot(canonical_job_id) if canonical_job_id else None
    data["enrichment"] = (
        {"status": child["status"], "step": child["step"]} if child else None
    )
    return data


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
        # A paper may predate canonical warming, or its earlier best-effort warm may have missed.
        # Starting a first read is another safe opportunity to prefetch derived paper context.
        # This remains a registered background job and never delays the request or analysis.
        canonical_job = canonical_jobs.warm_async(slug)
        job = _registry.put(
            slug,
            RetrievalJob(
                id=new_id(), slug=slug, status="done", phase="done", retrieved=True,
                finished_at=now_iso(),
            ),
        )
        if canonical_job is not None:
            with _registry.lock:
                job.canonical_job_id = canonical_job.id
        # Terminal short-circuit never runs a worker, so the analysis chain (if requested)
        # kicks here on the caller's thread — the project is already bound to it.
        if after_retrieved is not None:
            with _registry.lock:
                job._analysis_claimed = True
            # `put` registers an already-terminal job: no worker, and crucially no admission.
            # Retrieval itself was free (a cache hit), so the analysis turn this kicks is the
            # first paid work of this request and must be metered like any other entry point.
            _attach_hook(job, after_retrieved, admitted=False)
            # The short-circuit runs on the request thread, so a refusal can still be the response.
            _call_analysis_hook(job, after_retrieved, admitted=False, can_answer=True)
        return job

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
            with _registry.lock:
                job.matched_title = result.get("matched_title") or None
                job.arxiv_id = result.get("arxiv_id") or None
                job.source = result.get("source") or None
            _persist(slug, paper.title, result["full_text"], result.get("arxiv_id"),
                     result.get("source"), match_score=result.get("score"),
                     pdf_bytes=result.get("pdf_bytes"), authoritative_id=arxiv_id,
                     job=job)
            # An id the user explicitly supplied corrects any machine-resolved one on the
            # entry (a wrong title-search match must not outlive the correction). Only when
            # the result IS that id: a failed explicit download falls back to title search,
            # whose machine-selected id must not masquerade as the user's.
            with _registry.lock:
                job.phase = "done"
                job.retrieved = True
            return

        if not config.has_api_key():
            raise RetrievalError(first_error or "Paper retrieval failed.")

        with _registry.lock:
            job.phase = "hunting"
        # The hunt takes its OWN hold rather than riding the retrieval ticket. `retrieval` is
        # priced at $0.02 for "the fetch is free; extraction is cheap" — a deterministic path that
        # spends almost nothing. The hunt is the escalation tier: a multi-turn tool loop with web
        # search and page fetches, on the account's analysis-tier model. Billing it against the
        # cheap ticket admits a reader with two cents of headroom and then charges multiples of it,
        # which is the same under-reservation this branch just fixed for labs.
        #
        # Deliberately not folded into the `retrieval` maximum: most retrievals never hunt, and
        # sizing every one of them for the rare escalation would park budget that never becomes
        # spend — measured on the graph build as roughly ten mapped papers a month.
        # NOTE: `_persist` fans out from inside this block — affiliations, references, cover
        # render, canonical warm. Any child registry that does NOT take its own reservation
        # inherits this hold and settles microseconds later against it. That is safe today only
        # because the two children that spend (`paper-affiliations`, `paper-references`) are
        # `reserves=True`, and the rest make no LLM calls at all. A new child that spends and does
        # not reserve would bill against a hold that has already closed.
        with spend_ceiling.per_unit("retrieval_hunt", job.id):
            asyncio.run(_consume_hunt(job, paper.title, first_error, hunt_fn))

    def work_then_analyze(job: RetrievalJob) -> None:
        work(job)
        _run_analysis_hook(job)

    created = False

    def make_job() -> RetrievalJob:
        nonlocal created
        created = True
        job = RetrievalJob(id=new_id(), slug=slug)
        if after_retrieved is not None:
            # The creator: `start_or_join` runs the rate-limit check before calling this factory,
            # so reaching here means this request was admitted and its continuation is covered.
            _attach_hook(job, after_retrieved, admitted=True)
        return job

    try:
        job = _registry.start_or_join(slug, make_job, work_then_analyze)
    except (quotas.QuotaError, rate_limits.RateLimited):
        # Both subclass RuntimeError, so the tombstone catch below would swallow them and tell a
        # reader who is out of budget — or simply going too fast — that their project is being
        # moved. Re-raised so the 402/429/503 handlers in `main` see them.
        raise
    except RuntimeError as exc:
        raise RetrievalError(
            "This project is being moved or split — wait, then fetch the paper again.",
        ) from exc
    if after_retrieved is not None and not created:
        # Joined a retrieval another request started (possibly without a hook): attach the
        # continuation and register a settle callback — the registry reads callbacks in the
        # same critical section that flips the status, so either the callback fires on the
        # worker thread or add returns False and the settled job is handled inline here.
        # The claim flag dedupes against the worker's own end-of-work check.
        with _registry.lock:
            if getattr(job, "_after_retrieved", None) is None:
                # A joiner. `start_or_join` returned an existing job without admitting anything,
                # so nothing has been paid for the turn this hook will start.
                _attach_hook(job, after_retrieved, admitted=False)
        if not _registry.add_settle_callback(job, _run_analysis_hook):
            # The job had already settled, so this runs inline on THIS request's thread and a
            # refusal is still answerable. When the callback registers instead, it fires on the
            # creator's worker where nothing is listening — hence the default of False.
            _run_analysis_hook(job, can_answer=True)
    return job


#: Attribute holding whether the party that ATTACHED the analysis hook paid an admission.
#: Kept beside `_after_retrieved` and only ever written together with it (see `_attach_hook`),
#: because the two must not drift.
_HOOK_ADMITTED_ATTR = "_after_retrieved_admitted"


def _attach_hook(job: RetrievalJob, hook: Callable[..., None], *, admitted: bool) -> None:
    """Attach the analysis continuation together with who paid for it.

    Admission belongs to whoever ATTACHED the hook, not to whichever thread later runs it. That
    distinction is the whole bug this exists to prevent: `_after_retrieved` is a single slot, so a
    second request can join an in-flight retrieval for free -- joining deliberately costs no
    budget -- attach its own hook, and have the CREATOR's worker run it. Deciding admission at the
    call site ("this fires from a worker, so it must be covered") then reads the creator's payment
    as though it covered the joiner's turn, and the joiner gets a free chat turn plus, in
    listening mode, free narration.

    Callers must not set either attribute directly.
    """
    job._after_retrieved = hook
    setattr(job, _HOOK_ADMITTED_ATTR, admitted)


def _run_analysis_hook(job: RetrievalJob, *, can_answer: bool = False) -> None:
    """Claim and run the attached hook exactly once. The claim flag (mutated only under the
    registry lock) keeps a caller that attached a hook to a just-finished job from double-running
    it.

    Whether the resulting turn is metered is read from the hook's own attachment stamp, not
    passed in by the caller: every call site here runs on a thread whose relationship to the
    admission is ambiguous, and guessing from the thread is what produced two separate bypasses.

    An unstamped hook is treated as UNPAID. Absence of evidence must not grant free spend: an
    unmetered turn is money that cannot be recovered, while a wrongly metered one is at worst a
    refusal the reader can retry.
    """
    with _registry.lock:
        hook = getattr(job, "_after_retrieved", None)
        admitted = bool(getattr(job, _HOOK_ADMITTED_ATTR, False))
        eligible = hook is not None and job.retrieved and not getattr(job, "_analysis_claimed", False)
        if eligible:
            job._analysis_claimed = True
    if eligible:
        _call_analysis_hook(job, hook, admitted=admitted, can_answer=can_answer)


def _call_analysis_hook(
    job: RetrievalJob, hook: Callable[..., None], *, admitted: bool = True,
    can_answer: bool = False,
) -> None:
    try:
        hook(job, admitted=admitted)
    except (quotas.QuotaError, rate_limits.RateLimited) as exc:
        # A refusal is the answer to the request, so re-raise it where a client is still listening
        # — but ONLY there. `admitted` is a payment fact and says nothing about which thread this
        # is on: a joiner attaches with admitted=False and its hook then runs on the CREATOR's
        # worker via the settle callback, where `_fire_settle` catches and logs everything. Keying
        # the re-raise on `admitted` therefore lost the refusal entirely — the reader saw a
        # retrieved paper with no analysis job and no error, and waited forever.
        if can_answer:
            raise
        # Nobody is left to answer: the retrieval succeeded and its response went out long ago.
        # Record the refusal's OWN message — an earlier version wrote it and then immediately
        # overwrote it with a generic "usage limit reached", so a rate-limit ("you already have 4
        # tasks running") and a server-side quota outage both reached the reader as a monthly
        # limit. That is the same wait-a-month-versus-wait-seconds misdirection the transient
        # split exists to remove.
        set_analysis_error(job, str(exc) or "The analysis could not be started.")
    except Exception as exc:  # noqa: BLE001 — the analysis chain is best-effort; a failure
        # here must never turn a successful retrieval into an error.
        set_analysis_error(job, str(exc))


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
            with _registry.lock:
                job.matched_title = event.get("matched_title") or None
                job.source = event.get("source") or None
            _persist(
                job.slug, title, event["full_text"], None, event.get("source"),
                pdf_bytes=event.get("pdf_bytes"), job=job,
            )
            with _registry.lock:
                job.phase = "done"
                job.retrieved = True
            return
        detail = event.get("summary") or "The PDF hunt came up empty."
        raise RetrievalError(f"{first_error or 'Retrieval failed.'} {detail}".strip())
    raise RetrievalError(first_error or "The PDF hunt ended without a result.")


def _persist(
    slug: str,
    title: str,
    full_text: str,
    arxiv_id: str | None,
    source: str | None,
    match_score: float | None = None,
    *,
    pdf_bytes: bytes | None = None,
    authoritative_id: str | None = None,
    job: RetrievalJob | None = None,
) -> None:
    """Persist a background retrieval under the same relocation guard as synchronous writes."""
    try:
        with config.project_write_guard(config.active_project_id()):
            if store.get_paper(slug) is None:
                raise RetrievalError(
                    "This paper is no longer in the project (it may have just been moved).",
                )
            store.write_full_text(slug, title, full_text, {
                "slug": slug,
                "arxiv_id": arxiv_id,
                "source": source,
                "match_score": match_score,
            })
            if (
                authoritative_id
                and arxiv_id
                and store.arxiv_base_id(arxiv_id) == store.arxiv_base_id(authoritative_id)
            ):
                store.annotate_entry(slug, arxiv_id=arxiv_id, authoritative=True)
            # Reuse the already-downloaded/uploaded PDF. Keep it inside the guard so a move
            # cannot remove the paper between the corpus write and this derived cache write.
            cover_jobs.render_from_pdf(slug, pdf_bytes)
    except config.ProjectBusyError as exc:
        raise RetrievalError(
            "This project is being moved or split — wait, then fetch the paper again.",
        ) from exc
    # Fan out the independent first-read enrichments without delaying retrieval completion or
    # its chained analysis. The coordinator's concise step is exposed through this job snapshot.
    canonical_job = canonical_jobs.warm_async(slug)
    if job is not None and canonical_job is not None:
        with _registry.lock:
            job.canonical_job_id = canonical_job.id


def start_upload(slug: str, data: bytes, filename: str) -> RetrievalJob:
    """Extract an uploaded PDF in a registered background job and persist it like retrieval."""
    paper = store.get_paper(slug)
    if not paper:
        raise RetrievalError("Unknown paper")
    if not data:
        raise RetrievalError("Empty file.")

    def make_job() -> RetrievalJob:
        return RetrievalJob(
            id=new_id(),
            slug=slug,
            phase="resolving",
            detail=filename[:120],
            source=f"upload:{filename}",
        )

    def work(job: RetrievalJob) -> None:
        full_text = retriever.extract_pdf_bytes(data)
        if not full_text.strip():
            raise RetrievalError("Could not extract text from that PDF.")
        _persist(
            slug,
            paper.title,
            full_text,
            None,
            f"upload:{filename}",
            pdf_bytes=data,
            job=job,
        )
        with _registry.lock:
            job.phase = "done"
            job.retrieved = True

    try:
        return _registry.start_or_join(slug, make_job, work)
    except (quotas.QuotaError, rate_limits.RateLimited):
        # Both subclass RuntimeError, so the tombstone catch below would swallow them and tell a
        # reader who is out of budget — or simply going too fast — that their project is being
        # moved. Re-raised so the 402/429/503 handlers in `main` see them.
        raise
    except RuntimeError as exc:
        raise RetrievalError(
            "This project is being moved or split — wait, then upload the PDF again.",
        ) from exc
