"""Retrieval-triggered first-page affiliation extraction.

Affiliation extraction touches an LLM and can take minutes, so it is a durable in-process
background job rather than part of the retrieval request/job.  Results land in the independent
paper-metadata cache as soon as they are ready; a later Map build reuses the same fingerprinted
record instead of paying for the extraction again.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass, field

from . import affiliations, config, paper_metadata, store
from .jobs import Job, JobRegistry, new_id, now_iso


@dataclass
class AffiliationJob(Job):
    slug: str = ""
    paper_key: str = ""
    affiliations: list[str] = field(default_factory=list)


_registry: JobRegistry[AffiliationJob] = JobRegistry("paper-affiliations", max_finished=30, reserves=True,
                                                    operation="affiliations")
_jobs = _registry.jobs


def _save(slug: str, record: dict, *, expected_key: str | None = None) -> bool:
    """Serialize derived-metadata writes with paper-text replacement and project relocation."""
    with config.project_write_guard(config.active_project_id()), \
            config.paper_identity_guard(slug):
        return paper_metadata.set_affiliation_record(
            slug,
            record,
            expected_key=expected_key,
        )


def start(slug: str, *, complete=None) -> AffiliationJob | None:
    pid = config.active_project_id()
    admitted = threading.Event()
    pending_published = threading.Event()

    def work(job: AffiliationJob) -> None:
        admitted.wait()
        # Registration succeeded but publishing the owning fingerprint failed. The caller
        # receives that error; this worker must settle without spending tokens or remaining
        # permanently registered as running.
        if not pending_published.is_set():
            return
        try:
            if affiliations._orphan_alive():
                timed_out, ships = True, None
            else:
                timed_out, ships = affiliations._extract_with_deadline(slug, complete)
        except Exception as exc:  # noqa: BLE001 — enrichment failure must settle, not poll forever
            _save(
                slug,
                {
                    "status": "error",
                    "key": paper_key,
                    "authorships": [],
                    "error": str(exc)[:300] or "Affiliation extraction failed.",
                },
                expected_key=paper_key,
            )
            return
        if timed_out:
            _save(
                slug,
                {
                    "status": "error",
                    "key": paper_key,
                    "authorships": [],
                    "error": "Affiliation extraction timed out; it can be retried later.",
                },
                expected_key=paper_key,
            )
            return
        if ships is None:
            _save(
                slug,
                {
                    "status": "error",
                    "key": paper_key,
                    "authorships": [],
                    "error": "Affiliation extraction did not complete.",
                },
                expected_key=paper_key,
            )
            return
        _save(
            slug,
            {"status": "done", "key": paper_key, "authorships": ships, "error": None},
            expected_key=paper_key,
        )
        top = affiliations.top_affiliations(slug)
        with _registry.lock:
            job.affiliations = top

    # Fingerprint the paper, admit the owning job, and publish its pending marker under the
    # same project guard as full-text replacement. This makes the marker a CAS on the current
    # text: an older start cannot overwrite a newer retrieval's fingerprint.
    with config.project_write_guard(pid), config.paper_identity_guard(slug):
        paper = store.get_paper(slug)
        if paper is None:
            return None
        node = {
            "id": slug,
            "kind": "project",
            "slug": slug,
            "arxiv_id": paper.arxiv_id or None,
        }
        paper_key = affiliations._cache_key(node)
        if paper_key is None:
            return None

        current = paper_metadata.affiliation_record(slug)
        if current and current.get("status") == "done" and current.get("key") == paper_key:
            return _registry.put(
                f"{slug}:{paper_key}",
                AffiliationJob(
                    id=new_id(),
                    slug=slug,
                    paper_key=paper_key,
                    affiliations=affiliations.top_affiliations(slug),
                    status="done",
                    finished_at=now_iso(),
                ),
            )

        created = False

        def make_job() -> AffiliationJob:
            nonlocal created
            created = True
            return AffiliationJob(id=new_id(), slug=slug, paper_key=paper_key)

        try:
            job = _registry.start_or_join(
                f"{slug}:{paper_key}",
                make_job,
                work,
            )
            if created:
                paper_metadata.set_affiliation_record(
                    slug,
                    {
                        "status": "pending",
                        "key": paper_key,
                        "authorships": [],
                        "error": None,
                    },
                )
                pending_published.set()
            return job
        finally:
            # A write/admission failure must never strand the registered worker at its gate.
            admitted.set()


def reconcile_pending(slugs: list[str]) -> None:
    """Terminalize persisted ``pending`` records whose in-memory owner no longer exists.

    The registry is intentionally process-local. After a restart, a persisted pending marker
    therefore cannot make progress and must not make clients poll forever. A later explicit
    retrieval/first-read starts a fresh attempt for the same fingerprint.
    """
    for slug in slugs:
        record = paper_metadata.affiliation_record(slug)
        if not record or record.get("status") != "pending":
            continue
        paper_key = record.get("key")
        if not paper_key or _registry.active_for(f"{slug}:{paper_key}") is not None:
            continue
        _save(
            slug,
            {
                "status": "error",
                "key": paper_key,
                "authorships": [],
                "error": "Affiliation extraction was interrupted; it will retry on first read.",
            },
            expected_key=paper_key,
        )


def warm_async(slug: str) -> AffiliationJob | None:
    """Best-effort fire-and-forget entry point used by every full-text persistence path."""
    try:
        return start(slug)
    except RuntimeError:
        # Project relocation/deletion temporarily rejects new jobs. A later first-read or Map
        # build retries the same fingerprinted enrichment.
        return
