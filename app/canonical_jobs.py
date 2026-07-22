"""Thin first-read coordinator for independent per-paper enrichment jobs.

The coordinator owns no derived data and performs no LLM work. It launches the existing
affiliation/figure jobs plus canonical reference extraction, then exposes one concise aggregate
step through the retrieval job snapshot clients already poll.
"""
from __future__ import annotations

import time
from dataclasses import dataclass

from . import affiliation_jobs, figures, graph_store, logging_config, reference_jobs, store
from .jobs import Job, JobRegistry, new_id

log = logging_config.get("canonical-paper")


@dataclass
class CanonicalJob(Job):
    slug: str = ""
    step: str = "Preparing paper context…"


_registry: JobRegistry[CanonicalJob] = JobRegistry("canonical-paper", max_finished=30)
_jobs = _registry.jobs

_LABELS = (
    ("affiliations", "Reading first page…"),
    ("references", "Mapping references…"),
    ("figures", "Finding figures…"),
)


def snapshot(job_id: str) -> dict | None:
    return _registry.snapshot(job_id)


def _step(active: set[str]) -> str:
    labels = [label for key, label in _LABELS if key in active]
    return " · ".join(labels) if labels else "Paper context ready."


def warm_async(slug: str) -> CanonicalJob | None:
    """Launch or join one aggregate warm for the paper's current full-text fingerprint."""
    full_text = store.read_full_text(slug) if store.corpus_path(slug).exists() else ""
    if not full_text:
        return None
    content_hash = graph_store.content_hash(full_text)

    def work(job: CanonicalJob) -> None:
        children = {}
        for name, start in (
            ("affiliations", affiliation_jobs.warm_async),
            ("references", reference_jobs.warm_async),
            ("figures", figures.warm_async),
        ):
            try:
                children[name] = start(slug)
            except Exception as exc:  # noqa: BLE001 — one best-effort warm must not block peers
                children[name] = None
                log.warning("%s warm failed to start for %s: %s", name, slug, str(exc)[:160])
        while True:
            active = {
                name for name, child in children.items()
                if child is not None and child.status == "running"
            }
            with _registry.lock:
                job.step = _step(active)
            if not active:
                return
            time.sleep(0.1)

    try:
        return _registry.start_or_join(
            f"{slug}:{content_hash}",
            lambda: CanonicalJob(id=new_id(), slug=slug),
            work,
        )
    except RuntimeError:
        return None
