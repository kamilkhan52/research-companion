"""Grounded listening-preview jobs.

Each cue is an independent project-scoped background job: a short LLM call grounded in typed
canonical/paper/project sources, followed by one TTS call. Chat generation never waits for it.
After written analysis completes, a second background coordinator keeps publishing cue-job ids
until final narration becomes playable, then suppresses unfinished/queued late cues.
"""
from __future__ import annotations

import json
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field

from . import assembler, audio_jobs, config, llm, logging_config, prompts, store, tts
from .fileio import atomic_write_bytes
from .jobs import Job, JobRegistry, new_id, now_iso

MAX_CUE_CHARS = 240
CONTINUATION_POLL_SECONDS = 0.25
log = logging_config.get("preview")

GenerateFn = Callable[[list[dict], str | None], str]
SynthFn = Callable[[str], bytes]
PublishFn = Callable[[list[str], str, dict, bool], None]


class PreviewError(Exception):
    pass


@dataclass
class PreviewJob(Job):
    chat_job_id: str = ""
    ordinal: int = 0
    stage: str = "generating"       # generating | synthesizing
    sentence_ids: list[str] = field(default_factory=list)
    source_sentence_ids: list[str] = field(default_factory=list)
    cue: str | None = None
    url: str | None = None
    model: str | None = None
    suppressed: bool = False
    timings: dict[str, str] = field(default_factory=dict)


@dataclass
class PreviewCoordinator(Job):
    """Keeps publishing contextual cues while final narration is being prepared."""

    chat_job_id: str = ""
    audio_job_id: str = ""
    cue_job_ids: list[str] = field(default_factory=list)
    phase: str = "narration"
    progress: dict = field(default_factory=dict)


_registry: JobRegistry[PreviewJob] = JobRegistry("preview", max_finished=60)
_jobs = _registry.jobs
_coordinator_registry: JobRegistry[PreviewCoordinator] = JobRegistry(
    "preview-coordinator", max_finished=20,
)
_coordinator_jobs = _coordinator_registry.jobs


def get_job(job_id: str) -> PreviewJob | None:
    return _registry.get(job_id)


def snapshot(job_id: str) -> dict | None:
    return _registry.snapshot(job_id)


def completed_sentences(text: str) -> list[str]:
    """Return only sentences whose terminal punctuation is followed by whitespace.

    Holding back the trailing fragment matters during token streaming: a period can still be
    followed by a citation/quote or more text in a later token. Sentence ids are assigned from
    this stable completed prefix by the chat job.
    """
    out: list[str] = []
    start = 0
    for match in re.finditer(r'(?<=[.!?])(?:["”’\')\]]*)\s+', text):
        sentence = text[start:match.end()].strip()
        if sentence:
            out.append(sentence)
        start = match.end()
    return out


def _source_chunks(text: str, prefix: str, kind: str, limit: int) -> list[dict]:
    """Turn grounded prose/Markdown into bounded, citable source chunks."""
    chunks: list[str] = []
    for block in re.split(r"\n\s*\n", text.strip()):
        clean = re.sub(r"\s+", " ", block).strip()
        if not clean:
            continue
        while len(clean) > 700:
            split = clean.rfind(" ", 0, 700)
            split = split if split > 300 else 700
            chunks.append(clean[:split].strip())
            clean = clean[split:].strip()
        if clean:
            chunks.append(clean)
        if len(chunks) >= limit:
            break
    return [
        {"id": f"{prefix}{index + 1:04d}", "text": chunk, "kind": kind}
        for index, chunk in enumerate(chunks[:limit])
    ]


def research_sources(slug: str) -> list[dict]:
    """Ground preview cues in the paper opening and the project's prior-reading context.

    The opening slice normally covers the abstract/introduction. The assembled context supplies
    committed notes, related works, the reading list, and the current entry. Both are bounded so
    repeated short preview calls cannot accidentally carry the entire paper/project corpus.
    """
    paper = store.read_full_text(slug)[:12_000]
    context_parts = assembler.build_context(slug).split("\n\n---\n\n")
    # The general assembler starts with the reading method. Cues need different priorities:
    # committed notes/relationships first, then the running synthesis and reading-list metadata.
    headings = (
        "# Prior Notes",
        "# Per-paper Notes",
        "# Significant related works",
        "# Working notes",
        "# This paper's reading-list entry",
        "# The full reading list",
    )
    selected = [
        part for heading in headings for part in context_parts
        if part.lstrip().startswith(heading)
    ]
    project = "\n\n---\n\n".join(selected)[:18_000]
    return (
        _source_chunks(paper, "paper", "paper_background", 24)
        + _source_chunks(project, "project", "prior_project_context", 32)
    )


# One bounded web lookup per paper per process (polish plan I.3): context EXTERNAL to the
# paper that makes the waiting time genuinely informative — the authors and their other
# work, publication/version status, public discussion. Fetched in the coordinator's thread
# (never on the analysis path), cached so repeat listens cost nothing, and typed as
# untrusted web content for the cue prompt.
_external_cache: dict[str, list[dict]] = {}
_EXTERNAL_CACHE_MAX = 64


def external_sources(slug: str) -> list[dict]:
    if slug in _external_cache:
        return _external_cache[slug]
    paper = store.get_paper(slug)
    if not paper:
        return []
    title = paper.title
    try:
        from . import research_tools  # late import: keeps preview module import-light
        result = research_tools.web_search(
            f"Context around the research paper \"{title}\": the authors and their "
            "affiliations, other notable work by the same authors, whether a newer version "
            "or a publication venue exists for this paper, and any public discussion of it.",
            [f"{title} authors affiliation", f"{title} published venue discussion"],
        )
    except Exception as exc:
        log.warning("external context lookup failed slug=%s: %s", slug, str(exc)[:200])
        return []
    chunks = _source_chunks(str(result or ""), "web", "external_web_context", 12)
    if len(_external_cache) >= _EXTERNAL_CACHE_MAX:
        _external_cache.clear()
    _external_cache[slug] = chunks
    return chunks


def response_sources(text: str) -> list[dict]:
    sentences = completed_sentences(text.rstrip() + " ")
    return [
        {"id": f"s{index + 1:04d}", "text": sentence, "kind": "live_response"}
        for index, sentence in enumerate(sentences[:48])
    ]


def _progress_source(progress: dict) -> dict | None:
    phase = progress.get("phase")
    if phase == "analysis":
        text = ("The written analysis is still in progress; the amount remaining is not yet "
                "known.")
    elif phase == "narration_adaptation":
        text = ("The written response is complete. Its spoken adaptation is still being "
                "prepared, and the amount remaining is not yet known.")
    elif phase == "audio_synthesis":
        # Playback starts only when the COMPLETE stitched track exists (polish plan I.1), so
        # this must never claim the response "is ready" — that phrasing, repeated across the
        # cues generated during synthesis, was exactly the on-device "several announcements,
        # then nothing plays yet" bug (I.2). The response speaks for itself when it starts.
        done = progress.get("segments_done")
        total = progress.get("segments_total")
        counted = f" ({done} of {total} parts synthesized)" if total else ""
        text = ("The written response is complete and its audio is being synthesized"
                f"{counted}; it will begin playing automatically once assembled.")
    else:
        return None
    return {"id": "progress0001", "text": text, "kind": "preparation_progress"}


def _number_tokens(text: str) -> set[str]:
    values = re.findall(r"(?<!\w)[+-]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+|%)?", text)
    return {value.lower().replace(",", "") for value in values}


def validate_result(raw: str, sentences: list[dict]) -> tuple[str, list[str]]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise PreviewError("Preview model returned malformed JSON.") from exc
    if not isinstance(value, dict):
        raise PreviewError("Preview model must return one JSON object.")
    cue = value.get("cue")
    source_ids = value.get("source_sentence_ids")
    if not isinstance(cue, str) or not cue.strip():
        raise PreviewError("Preview cue is empty.")
    cue = cue.strip()
    if len(cue) > MAX_CUE_CHARS:
        raise PreviewError(f"Preview cue exceeds {MAX_CUE_CHARS} characters.")
    if (not isinstance(source_ids, list) or not source_ids
            or any(not isinstance(item, str) for item in source_ids)):
        raise PreviewError("Preview source_sentence_ids must be a non-empty string list.")
    by_id = {item["id"]: item["text"] for item in sentences}
    if any(item not in by_id for item in source_ids):
        raise PreviewError("Preview cited an unknown source sentence id.")
    source_numbers = _number_tokens(" ".join(by_id[item] for item in source_ids))
    if not _number_tokens(cue).issubset(source_numbers):
        raise PreviewError("Preview introduced a numeric claim absent from its source sentences.")
    return cue, list(dict.fromkeys(source_ids))


def _default_generate(messages: list[dict], model: str | None) -> str:
    return llm.complete(
        messages,
        model=model,
        temperature=0.2,
        max_tokens=300,
        operation="listening_preview",
    )


def resolve_model(settings: dict | None = None) -> str | None:
    settings = settings or config.load_settings()
    return (settings.get("preview_model") or settings.get("narration_model")
            or settings.get("model"))


def _suppressed(job: PreviewJob) -> bool:
    with _registry.lock:
        return job.suppressed


def suppress(job_ids: list[str]) -> None:
    """Suppress only cue ids visible in the active project before final audio starts."""
    for job_id in job_ids:
        job = _registry.get(job_id)
        if job:
            with _registry.lock:
                job.suppressed = True


def start_job(chat_job_id: str, ordinal: int, sentences: list[dict], previous_cue: str = "",
              progress: dict | None = None,
              generate_fn: GenerateFn | None = None,
              synth_fn: SynthFn | None = None) -> PreviewJob:
    if not sentences:
        raise PreviewError("No completed sentences are available for a preview.")
    generate_fn = generate_fn or _default_generate
    synth_fn = synth_fn or tts.openai_speech
    progress_copy = dict(progress or {})
    sentence_copy = [
        {
            "id": str(item["id"]),
            "text": str(item["text"]),
            "kind": str(item.get("kind") or "live_response"),
        }
        for item in sentences
    ]
    progress_item = _progress_source(progress_copy)
    if progress_item:
        sentence_copy.append(progress_item)
    key = f"{chat_job_id}:{ordinal}"

    def work(job: PreviewJob) -> None:
        settings = config.load_settings()
        model = resolve_model(settings)
        with _registry.lock:
            job.model = model
        messages = [
            {"role": "system", "content": (
                prompts.get("listening_preview") + "\n\n"
                + prompts.get("listening_preview_priorities")
            )},
            {"role": "user", "content": json.dumps({
                # Kept for compatibility with existing user-edited preview prompts.
                "completed_sentences": [
                    item for item in sentence_copy if item["kind"] == "live_response"
                ],
                "grounded_sources": sentence_copy,
                "previous_cue": previous_cue,
                "preparation_progress": progress_copy,
            }, ensure_ascii=False)},
        ]
        cue, source_ids = validate_result(generate_fn(messages, model), sentence_copy)
        with _registry.lock:
            job.cue = cue
            job.source_sentence_ids = source_ids
            job.stage = "synthesizing"
            job.timings["cue_ready"] = now_iso()
        if _suppressed(job):
            return

        path = audio_jobs.audio_cache_path(cue)
        if not path.exists():
            atomic_write_bytes(path, synth_fn(cue))
        if _suppressed(job):
            return
        with _registry.lock:
            job.url = f"/api/audio/{path.name}"

    return _registry.start_or_join(
        key,
        lambda: PreviewJob(
            id=new_id(),
            chat_job_id=chat_job_id,
            ordinal=ordinal,
            sentence_ids=[item["id"] for item in sentence_copy],
        ),
        work,
    )


def _audio_progress(audio_job) -> tuple[str, dict, bool]:
    if audio_job is None:
        return "unavailable", {"remaining_known": False}, True
    # Playback is the COMPLETE stitched file (polish plan I.1) — the client no longer plays
    # segments as they land — so cues keep flowing (and pending ones get suppressed) until
    # the job actually settles, not at the first synthesized segment. Every terminal status
    # counts as settled — a cancelled preparation must stop the cue cadence too, or the
    # coordinator would keep launching paid cue generations forever.
    ready = audio_job.status != "running"
    if audio_job.stage == "synthesizing":
        total = int(audio_job.segments_total or 0)
        done = int(audio_job.segments_done or 0)
        progress = {
            "phase": "audio_synthesis",
            "segments_done": done,
            "segments_total": total,
            "segments_remaining": max(total - done, 0) if total else None,
            "remaining_known": bool(total),
        }
        return "audio_synthesis", progress, ready
    return "narration_adaptation", {
        "phase": "narration_adaptation",
        "remaining_known": False,
        "status": "The written response is complete; its spoken adaptation is still being prepared.",
    }, ready


def start_coordinator(
    chat_job_id: str,
    audio_job_id: str,
    sources: list[dict],
    existing_job_ids: list[str],
    publish: PublishFn,
    *,
    cadence_seconds: float,
    last_started_at: float,
    slug: str | None = None,
) -> PreviewCoordinator:
    """Continue contextual cues until final narration can begin playback."""
    source_copy = [dict(item) for item in sources]
    cue_ids = list(existing_job_ids)

    def work(job: PreviewCoordinator) -> None:
        # The narration wait is exactly when the listener has attention to spare — enrich
        # the remaining cues with paper-external context (I.3). Runs here, in the
        # coordinator's own thread, so the lookup never delays analysis or the first cues.
        if slug:
            try:
                source_copy.extend(external_sources(slug))
            except Exception as exc:
                log.warning("external sources failed chat=%s: %s",
                            chat_job_id[:8], str(exc)[:200])
        previous_cues = [
            cue.cue for cue_id in cue_ids
            if (cue := get_job(cue_id)) is not None and cue.status == "done" and cue.cue
        ]
        last_started = last_started_at
        while True:
            audio_job = audio_jobs.get_job(audio_job_id)
            phase, progress, ready = _audio_progress(audio_job)
            with _coordinator_registry.lock:
                job.phase = phase
                job.progress = progress
                job.cue_job_ids = list(cue_ids)
            if ready:
                suppress(cue_ids)
                publish(cue_ids, phase, progress, True)
                return

            publish(cue_ids, phase, progress, False)
            previous = get_job(cue_ids[-1]) if cue_ids else None
            if previous and previous.status == "running":
                time.sleep(CONTINUATION_POLL_SECONDS)
                continue
            if previous and previous.status == "done" and previous.cue:
                if not previous_cues or previous_cues[-1] != previous.cue:
                    previous_cues.append(previous.cue)

            now = time.monotonic()
            if now - last_started >= cadence_seconds:
                last_started = now
                try:
                    cue = start_job(
                        chat_job_id,
                        len(cue_ids) + 1,
                        source_copy,
                        "\n".join(previous_cues[-8:]),
                        progress,
                    )
                    cue_ids.append(cue.id)
                    publish(cue_ids, phase, progress, False)
                except Exception as exc:
                    # Cues are opportunistic; retry on the next cadence without failing the
                    # coordinator or leaving the client waiting forever for completion.
                    log.warning("could not continue preview chat=%s: %s",
                                chat_job_id[:8], str(exc)[:200])
            time.sleep(CONTINUATION_POLL_SECONDS)

    return _coordinator_registry.start_or_join(
        chat_job_id,
        lambda: PreviewCoordinator(
            id=new_id(),
            chat_job_id=chat_job_id,
            audio_job_id=audio_job_id,
            cue_job_ids=list(cue_ids),
        ),
        work,
    )
