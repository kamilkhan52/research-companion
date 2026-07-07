"""Grounded listening-preview jobs.

Each cue is an independent project-scoped background job: a short LLM call grounded only in
completed canonical sentences, followed by one TTS call. Chat generation never waits for it.
The chat job publishes cue-job ids for the mobile client to poll and suppresses unfinished/late
cues before final narration starts.
"""
from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field

from . import audio_jobs, config, llm, prompts, tts
from .fileio import atomic_write_bytes
from .jobs import Job, JobRegistry, new_id

MAX_CUE_CHARS = 240
MAX_CUES_PER_TURN = 3

GenerateFn = Callable[[list[dict], str | None], str]
SynthFn = Callable[[str], bytes]


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


_registry: JobRegistry[PreviewJob] = JobRegistry("preview", max_finished=60)
_jobs = _registry.jobs


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
              generate_fn: GenerateFn | None = None,
              synth_fn: SynthFn | None = None) -> PreviewJob:
    if not sentences:
        raise PreviewError("No completed sentences are available for a preview.")
    generate_fn = generate_fn or _default_generate
    synth_fn = synth_fn or tts.openai_speech
    sentence_copy = [{"id": str(item["id"]), "text": str(item["text"])} for item in sentences]
    key = f"{chat_job_id}:{ordinal}"

    def work(job: PreviewJob) -> None:
        settings = config.load_settings()
        model = (settings.get("preview_model") or settings.get("narration_model")
                 or settings.get("model"))
        with _registry.lock:
            job.model = model
        messages = [
            {"role": "system", "content": prompts.get("listening_preview")},
            {"role": "user", "content": json.dumps({
                "completed_sentences": sentence_copy,
                "previous_cue": previous_cue,
            }, ensure_ascii=False)},
        ]
        cue, source_ids = validate_result(generate_fn(messages, model), sentence_copy)
        with _registry.lock:
            job.cue = cue
            job.source_sentence_ids = source_ids
            job.stage = "synthesizing"
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
