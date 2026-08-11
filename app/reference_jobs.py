"""First-read bibliography/context extraction jobs.

The extraction is the expensive, LLM-backed part of a Map build. Running it as soon as full
text lands makes incoming-citation contexts available to every later surface, while the
canonical paper-metadata record lets Map assembly join/reuse the same fingerprinted work.
"""
from __future__ import annotations

import threading
from collections.abc import Callable
from dataclasses import dataclass

from . import config, graph_store, paper_metadata, store
from .jobs import Job, JobRegistry, new_id, now_iso

ExtractFn = Callable[[str, str, str, str], dict]


@dataclass
class ReferenceJob(Job):
    slug: str = ""
    content_hash: str = ""


_registry: JobRegistry[ReferenceJob] = JobRegistry("paper-references", max_finished=30, reserves=True,
                                                  operation="graph_extraction")
_jobs = _registry.jobs


def snapshot(job_id: str) -> dict | None:
    return _registry.snapshot(job_id)


def _current_text(slug: str) -> str:
    if store.corpus_path(slug).exists():
        return store.read_full_text(slug)
    return graph_store.read_retrieved_text(slug)


def _save(slug: str, record: dict, *, expected_key: str) -> bool:
    """Reject a result if this paper's available text changed while extraction ran."""
    with config.project_write_guard(config.active_project_id()), \
            config.paper_identity_guard(slug):
        if graph_store.content_hash(_current_text(slug)) != expected_key:
            return False
        return paper_metadata.set_reference_record(
            slug,
            record,
            expected_key=expected_key,
        )


def start_for_text(
    slug: str,
    title: str,
    full_text: str,
    *,
    model: str | None = None,
    extract_fn: ExtractFn | None = None,
) -> ReferenceJob:
    """Start or join the canonical extraction for one captured paper-text fingerprint."""
    pid = config.active_project_id()
    content_hash = graph_store.content_hash(full_text)
    admitted = threading.Event()
    pending_published = threading.Event()

    def work(job: ReferenceJob) -> None:
        admitted.wait()
        if not pending_published.is_set():
            return
        try:
            # Import lazily to avoid graph.py <-> reference_jobs module initialization cycles.
            from . import graph

            chosen_model = model or graph.resolve_model()
            extractor = extract_fn or graph.extract_references_for_paper
            result = extractor(slug, title, full_text, chosen_model)
            if not isinstance(result, dict):
                raise TypeError("reference extraction returned a non-object result")
            if result.get("content_hash") != content_hash:
                raise ValueError("reference extraction returned the wrong content fingerprint")
            _save(slug, result, expected_key=content_hash)
        except Exception as exc:
            _save(
                slug,
                {
                    "slug": slug,
                    "content_hash": content_hash,
                    "extracted_at": now_iso(),
                    "model": model or "",
                    "status": "error",
                    "references": [],
                    "error": str(exc)[:400] or "Reference extraction failed.",
                },
                expected_key=content_hash,
            )
            raise

    created = False

    def make_job() -> ReferenceJob:
        nonlocal created
        created = True
        return ReferenceJob(id=new_id(), slug=slug, content_hash=content_hash)

    # Publish the owning fingerprint under the same guards as full-text replacement. An older
    # result then loses its expected_key comparison after a newer retrieval publishes its hash.
    with config.project_write_guard(pid), config.paper_identity_guard(slug):
        if graph_store.content_hash(_current_text(slug)) != content_hash:
            raise RuntimeError("Paper text changed before reference extraction could start.")
        # Import a matching pre-R12.9 graph extraction under the same identity guard, so an
        # older caller cannot backfill over a newer retrieval's pending fingerprint.
        cached = paper_metadata.fresh_reference_record(slug, full_text)
        if cached is not None:
            return _registry.put(
                f"{slug}:{content_hash}",
                ReferenceJob(
                    id=new_id(), slug=slug, content_hash=content_hash,
                    status="done", finished_at=now_iso(),
                ),
            )
        try:
            job = _registry.start_or_join(
                f"{slug}:{content_hash}",
                make_job,
                work,
            )
            if created:
                paper_metadata.set_reference_record(
                    slug,
                    {
                        "slug": slug,
                        "content_hash": content_hash,
                        "extracted_at": None,
                        "model": model or "",
                        "status": "pending",
                        "references": [],
                        "error": "",
                    },
                )
                pending_published.set()
            return job
        finally:
            admitted.set()


def start(
    slug: str,
    *,
    model: str | None = None,
    extract_fn: ExtractFn | None = None,
) -> ReferenceJob | None:
    """Start against the paper text currently available in the active project."""
    paper = store.get_paper(slug)
    if paper is None:
        return None
    full_text = _current_text(slug)
    if not full_text:
        return None
    return start_for_text(
        slug,
        paper.title,
        full_text,
        model=model,
        extract_fn=extract_fn,
    )


def ensure_for_text(
    slug: str,
    title: str,
    full_text: str,
    *,
    model: str,
    extract_fn: ExtractFn,
) -> dict:
    """Join/start an extraction and wait for its canonical result.

    This blocking helper is only used inside the already-backgrounded Map build workers. HTTP
    requests use ``warm_async`` and return immediately.
    """
    job = start_for_text(
        slug,
        title,
        full_text,
        model=model,
        extract_fn=extract_fn,
    )
    if job.status == "running":
        settled = threading.Event()
        if _registry.add_settle_callback(job, lambda _job: settled.set()):
            settled.wait()
    final = _registry.get(job.id)
    if final is None or final.status == "error":
        # NOTE(DR-049): this converts a child job's failure into a plain RuntimeError, so a
        # structured refusal raised INSIDE the child worker would lose its payload here. Not
        # reachable today — the child's only refusal (its admission hold) is taken on the
        # caller's thread and propagates untouched — but re-raise the refusal type if that
        # changes.
        raise RuntimeError((final.error if final else None) or "Reference extraction failed.")
    record = paper_metadata.reference_record(slug)
    if record is None or record.get("content_hash") != graph_store.content_hash(full_text):
        raise RuntimeError("Reference extraction did not produce a fresh canonical record.")
    return record


def warm_async(slug: str) -> ReferenceJob | None:
    """Fire-and-forget first-read entry point used by the canonical warm coordinator."""
    try:
        return start(slug)
    except RuntimeError:
        # Relocation/deletion or a concurrent text replacement: a later first read/Map build
        # retries the same fingerprinted work.
        return None
