"""Grounded listening-preview jobs.

Each cue is an independent project-scoped background job: a short LLM call grounded in typed
canonical/paper/project sources, followed by one TTS call. Chat generation never waits for it.
After written analysis completes, a second background coordinator keeps publishing cue-job ids
until final narration becomes playable, then suppresses unfinished/queued late cues.
"""
from __future__ import annotations

import asyncio
import json
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field

from . import (
    assembler,
    audio_cache,
    audio_jobs,
    config,
    llm,
    logging_config,
    model_provenance,
    prompts,
    store,
    tts,
)
from .fileio import atomic_write_bytes
from .jobs import Job, JobRegistry, new_id, now_iso

#: A cue is one short spoken sentence. Named rather than inlined so `operation_limits` can be
#: asserted against the real budget instead of a copy of it — a hand-copied number is what let
#: `discovery`'s ceiling sit three times below what its caller asked for.
CUE_MAX_TOKENS = 180
MAX_CUE_CHARS = 240
TARGET_CUE_CHARS = 200
CONTINUATION_POLL_SECONDS = 0.25
# Segment completion remains the preferred synthesis cue trigger, but a single slow segment
# must not leave the listener in silence until the stitched track is ready.
SYNTHESIS_KEEPALIVE_SECONDS = 18.0
# Cues per wait, counted across BOTH producers (see `budget_exhausted`). `None` = no cap.
#
# Capped at 6 on 2026-07-29 for cost: uncapped, a long synthesis produced ~17 cues, each re-sending
# the whole grounded-source set plus both cue histories — ~11,373 prompt tokens to produce ~86,
# which is 4.4x the analysis turn's own prompt, or $0.087 per turn
# (docs/production/20-pricing-analysis.md §8).
#
# UNCAPPED AGAIN on 2026-07-30 at Kamil's explicit instruction, with the cost stated and accepted:
# "I like cues coming through all the way until the audio is ready. silence is the worst here at
# any cost." That is a product judgement about the listening experience, not an oversight — the
# wait is dead air otherwise, and dead air is what makes a long preparation feel broken. The cheaper
# lever does NOT cost silence: the source/history budget below trims each cue prompt toward ~4K
# tokens while leaving this uncapped cadence decision intact.
MAX_CUES_PER_WAIT: int | None = None
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
    #: The preparation progress this cue was given (see `last_reported_progress`).
    progress_signature: str = ""
    suppressed: bool = False
    played: bool = False
    played_at: str | None = None
    timings: dict[str, str] = field(default_factory=dict)


@dataclass
class PreviewCoordinator(Job):
    """Keeps publishing contextual cues while final narration is being prepared."""

    chat_job_id: str = ""
    audio_job_id: str = ""
    cue_job_ids: list[str] = field(default_factory=list)
    phase: str = "narration"
    progress: dict = field(default_factory=dict)


#: Retention has to outlast an UNCAPPED wait, not a typical one. Cue ids accumulate for the whole
#: wait and `cue_history` reads them back out of this registry, so once finished jobs are evicted
#: the "complete chronological history" the prompt promises quietly becomes partial — and the
#: repetition the history exists to prevent comes back. 60 was chosen when waits were capped at 6.
_registry: JobRegistry[PreviewJob] = JobRegistry("preview", max_finished=400, reserves=True,
                                                    operation="listening_preview")
_jobs = _registry.jobs
_coordinator_registry: JobRegistry[PreviewCoordinator] = JobRegistry(
    "preview-coordinator", max_finished=20, reserves=True, operation="listening_preview",
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


# One bounded web-agent run per paper per process: context EXTERNAL to the paper that makes
# waiting informative — authors and their other work, publication/version status, and
# scholarly context. It runs in the coordinator's project-bound worker (never on the analysis
# path), is cached within that project so repeat listens cost nothing, and is typed as
# untrusted web content for the cue prompt.
_external_cache: dict[str, list[dict]] = {}
_EXTERNAL_CACHE_MAX = 64
MAX_RESEARCH_AGENT_REQUESTS = 7
MAX_RESEARCH_AGENT_TOOL_CALLS = 5

# Per-cue context budget. The old 12K paper + 18K project slices were copied into EVERY cue, then
# live sentences and three overlapping cue-history fields were added. Measured result: 11,373
# prompt tokens for an 86-token answer. Six thousand grounded characters plus a two-thousand-char
# live-response share keeps the whole request near the pricing analysis's ~4K-token target while a
# rotating context window still gives an uncapped wait fresh material on later cues.
MAX_GROUNDED_SOURCE_CHARS = 6_000
MAX_LIVE_SOURCE_CHARS = 2_000


def _research_with_agent(title: str, paper_metadata: str) -> str:
    """Run a small read-only search/fetch agent and return its sourced findings."""
    # Imported lazily: pydantic_ai is heavyweight and tests inject a research function.
    from pydantic_ai import Agent
    from pydantic_ai.usage import UsageLimits

    from . import agent_harness, research_tools, usage

    def web_search(objective: str, search_queries: list[str]) -> str:
        """Search for reliable context. Use 1-3 focused queries; results include URLs."""
        return research_tools.web_search(objective, search_queries[:3])

    def web_fetch(urls: list[str], objective: str) -> str:
        """Fetch up to 3 promising primary or scholarly pages and return readable text."""
        return research_tools.web_fetch(urls[:3], objective)

    model = resolve_model()
    research_agent = Agent(
        agent_harness._openrouter_model(model),
        system_prompt=(prompts.get("listening_preview_research")
                       + "\n\n" + model_provenance.SYSTEM_POLICY),
        tools=[web_search, web_fetch],
        output_type=str,
        retries=2,
    )
    result = asyncio.run(
        research_agent.run(
            model_provenance.frame(
                "paper_metadata",
                f"Paper title: {title}\n\nKnown project metadata:\n{paper_metadata[:4_000]}",
            ),
            usage_limits=UsageLimits(
                request_limit=MAX_RESEARCH_AGENT_REQUESTS,
                tool_calls_limit=MAX_RESEARCH_AGENT_TOOL_CALLS,
            ),
        ),
    )
    run_usage = result.usage()
    # Same as lab_research: the cue coordinator holds budget, so an unpriced run settled at zero.
    usage.record_agentic("listening_preview_research", model, run_usage)
    return str(result.output or "")[:6_000]


def external_sources(
    slug: str,
    research_fn: Callable[[str, str], str] | None = None,
) -> list[dict]:
    paper = store.get_paper(slug)
    if not paper:
        return []
    cache_key = f"{config.active_project_id()}:{slug}:{paper.title}"
    if cache_key in _external_cache:
        return _external_cache[cache_key]
    title = paper.title
    research_fn = research_fn or _research_with_agent
    try:
        result = research_fn(title, store.entry_markdown(slug))
    except Exception as exc:
        log.warning("external context research agent failed slug=%s (error=%s)",
                    slug, type(exc).__name__)
        return []
    chunks = _source_chunks(str(result or ""), "web", "external_web_context", 12)
    if len(_external_cache) >= _EXTERNAL_CACHE_MAX:
        _external_cache.clear()
    _external_cache[cache_key] = chunks
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
        text = ("The final spoken response is still being adapted for listening and will play "
                "automatically after preparation and synthesis finish.")
    elif phase == "audio_synthesis":
        done = progress.get("segments_done")
        total = progress.get("segments_total")
        counted = f" ({done} of {total} parts synthesized)" if total else ""
        text = (f"The full spoken response is still being synthesized{counted} and will begin "
                "playing automatically once the complete track is assembled.")
    else:
        return None
    return {"id": "progress0001", "text": text, "kind": "preparation_progress"}


def progress_signature(progress: dict) -> str:
    """What the listener could actually notice changing between two cues.

    Only these fields drive progress language, so two cues with the same signature have nothing new
    to report about preparation — and a cue that restates it says "still synthesizing, 3 of 12" for
    the second time running, which is the repetition readers notice fastest.
    """
    return "|".join(
        str(progress.get(field)) for field in ("phase", "segments_done", "segments_total")
    )


def _fit_source(item: dict, available: int) -> dict | None:
    """Copy one source under ``available`` characters without changing its provenance id/kind."""
    text = str(item.get("text") or "").strip()
    if not text or available < 40:
        return None
    if len(text) > available:
        cut = text.rfind(" ", 0, available - 1)
        cut = cut if cut >= 40 else available - 1
        text = text[:cut].rstrip(" ,;:-") + "…"
    return {**item, "text": text}


def _bounded_sources(items: list[dict], ordinal: int) -> list[dict]:
    """Select a small, citable source window while preserving live/progress grounding.

    The newest live response gets a fixed share because a cue during analysis should react to what
    was just written. Progress is always retained when present. Remaining paper/project/web/tool
    context rotates by cue ordinal; unlimited cues therefore explore the corpus rather than paying
    to resend the same prefix forever.
    """
    progress = [item for item in items if item.get("kind") == "preparation_progress"][-1:]
    progress_copy = _fit_source(progress[0], MAX_GROUNDED_SOURCE_CHARS) if progress else None
    reserved = len(progress_copy["text"]) if progress_copy else 0
    remaining = max(0, MAX_GROUNDED_SOURCE_CHARS - reserved)

    live_selected: list[dict] = []
    live_used = 0
    live_items = [item for item in items if item.get("kind") == "live_response"]
    for item in reversed(live_items):
        allowance = min(remaining, MAX_LIVE_SOURCE_CHARS - live_used)
        fitted = _fit_source(item, allowance)
        if fitted is None:
            break
        live_selected.append(fitted)
        used = len(fitted["text"])
        live_used += used
        remaining -= used
    live_selected.reverse()

    context = [
        item for item in items
        if item.get("kind") not in ("live_response", "preparation_progress")
    ]
    if context:
        offset = ((max(ordinal, 1) - 1) * 5) % len(context)
        context = context[offset:] + context[:offset]
    context_selected: list[dict] = []
    for item in context:
        fitted = _fit_source(item, remaining)
        if fitted is None:
            break
        context_selected.append(fitted)
        remaining -= len(fitted["text"])

    return [*live_selected, *context_selected, *([progress_copy] if progress_copy else [])]


def budget_exhausted(existing_job_ids: list[str]) -> bool:
    """Whether this wait has already spent its cue allowance.

    Counts cues for the WHOLE wait, and lives here so both producers share it. Cues start from two
    places — `chat_jobs._maybe_start_preview` while analysis streams, and the coordinator once
    analysis is done — and a cap enforced in only the second is not a cap at all: a long analysis
    can spend the entire budget before the coordinator ever receives `existing_job_ids`.

    With `MAX_CUES_PER_WAIT` set to None there is no cap and cues continue until the audio is
    ready, which is the current product decision (see the constant).
    """
    if MAX_CUES_PER_WAIT is None:
        return False
    return len(existing_job_ids) >= MAX_CUES_PER_WAIT


def last_reported_progress(job_ids: list[str]) -> str | None:
    """The progress signature of the most recent cue that actually got made.

    Derived from job state rather than remembered by the caller, because `start_job` returns as
    soon as the worker thread is admitted: a cue that fails afterwards would otherwise still
    "claim" its progress, and the next cue would be told the count is stale when the listener
    never heard it announced. Cues that errored are skipped for exactly that reason.
    """
    for job_id in reversed(job_ids):
        cue_job = get_job(job_id)
        if cue_job is not None and cue_job.status == "done" and cue_job.progress_signature:
            return cue_job.progress_signature
    return None


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


def _compact_overlong_result(raw: str) -> str:
    """Deterministically salvage an otherwise valid overlong cue before TTS.

    The strict validator remains strict for callers and tests. The generation path gets one
    bounded repair so a verbose model cannot repeatedly punch holes in a long preview sequence.
    """
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return raw
    if not isinstance(value, dict) or not isinstance(value.get("cue"), str):
        return raw
    cue = re.sub(r"\s+", " ", value["cue"]).strip()
    if len(cue) <= MAX_CUE_CHARS:
        value["cue"] = cue
        return json.dumps(value, ensure_ascii=False)

    prefix = cue[:MAX_CUE_CHARS]
    sentence_ends = [m.end() for m in re.finditer(r"[.!?](?:[\"”’')\]]*)", prefix)]
    cut = max((end for end in sentence_ends if end >= 80), default=0)
    if cut:
        compact = prefix[:cut].strip()
    else:
        word_cut = prefix.rfind(" ", 80)
        compact = prefix[:word_cut if word_cut > 0 else MAX_CUE_CHARS - 1]
        compact = compact.rstrip(" ,;:-") + "…"
    value["cue"] = compact[:MAX_CUE_CHARS]
    return json.dumps(value, ensure_ascii=False)


def _default_generate(messages: list[dict], model: str | None) -> str:
    return llm.complete(
        messages,
        model=model,
        temperature=0.2,
        max_tokens=CUE_MAX_TOKENS,
        # Reasoning OFF, and this is the call where it matters most. `resolve_model` falls back to
        # the NARRATION model when no preview model is set, which is the default state — so cues
        # were being written by a reasoning model against a 180-token ceiling. It spends the
        # ceiling thinking, returns nothing, the cue fails, and the listener gets the silence the
        # cues exist to prevent. A cue is one or two grounded sentences under a latency budget;
        # there is nothing here to reason about.
        reasoning=llm.no_reasoning_payload(),
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


def acknowledge_played(job_id: str) -> dict | None:
    """Record that the active project's audio layer accepted this cue for playback."""
    job = _registry.get(job_id)
    if not job:
        return None
    with _registry.lock:
        if not job.played:
            job.played = True
            job.played_at = now_iso()
    return _registry.snapshot(job_id)


#: How many recent cues are shown to the next one. Not a cue-count cap: with
#: no cap on cue count, sending every prior cue makes each request grow with the wait. It is mainly
#: honesty. Retention can evict the oldest jobs, so "every cue so far" is a promise this cannot
#: keep, and a bounded window is a promise it can. A listener will not notice cue 30 echoing cue 2;
#: they notice cue 4 echoing cue 3, and the window covers that comfortably.
CUE_HISTORY_WINDOW = 4


def cue_history(job_ids: list[str]) -> tuple[list[str], list[str]]:
    """The recent chronological (played, generated) cue histories for a wait.

    Bounded to `CUE_HISTORY_WINDOW`. Anything older may have been pruned from the registry anyway,
    so claiming completeness would be false as well as expensive.
    """
    generated: list[str] = []
    played: list[str] = []
    for job_id in job_ids:
        cue_job = get_job(job_id)
        if cue_job is None or cue_job.status != "done" or not cue_job.cue:
            continue
        generated.append(cue_job.cue)
        if getattr(cue_job, "played", False):
            played.append(cue_job.cue)
    return played[-CUE_HISTORY_WINDOW:], generated[-CUE_HISTORY_WINDOW:]


def start_job(chat_job_id: str, ordinal: int, sentences: list[dict], previous_cue: str = "",
              progress: dict | None = None,
              *, played_cues: list[str] | None = None,
              generated_cues: list[str] | None = None,
              progress_is_new: bool = True,
              generate_fn: GenerateFn | None = None,
              synth_fn: SynthFn | None = None) -> PreviewJob:
    if not sentences:
        raise PreviewError("No completed sentences are available for a preview.")
    generate_fn = generate_fn or _default_generate
    synth_fn = synth_fn or tts.openai_speech
    progress_copy = dict(progress or {})
    # Enforce the history contract at the model boundary too. Current callers already use
    # cue_history(), but a future/direct caller must not be able to restore an unbounded prompt.
    played_copy = [str(cue)[:MAX_CUE_CHARS] for cue in (played_cues or [])][
        -CUE_HISTORY_WINDOW:
    ]
    generated_copy = [str(cue)[:MAX_CUE_CHARS] for cue in (generated_cues or [])][
        -CUE_HISTORY_WINDOW:
    ]
    previous_cue = str(previous_cue)[:MAX_CUE_CHARS]
    sentence_copy = [
        {
            "id": str(item["id"]),
            "text": str(item["text"]),
            "kind": str(item.get("kind") or "live_response"),
        }
        for item in sentences
    ]
    # Preparation progress is citable ONLY when it has moved since the last cue. Handing the model
    # an unchanged count invites it to restate it, which is how the wait came to sound like
    # "synthesis is underway, N parts remaining" three times with the same N. When it has not
    # moved there is nothing honest left to say about timing, so the cue must earn its place with
    # substance instead.
    progress_item = _progress_source(progress_copy) if progress_is_new else None
    if progress_item:
        sentence_copy.append(progress_item)
    sentence_copy = _bounded_sources(sentence_copy, ordinal)
    key = f"{chat_job_id}:{ordinal}"

    def work(job: PreviewJob) -> None:
        settings = config.load_settings()
        model = resolve_model(settings)
        with _registry.lock:
            job.model = model
        messages = [
            {"role": "system", "content": (
                prompts.get("listening_preview") + "\n\n"
                + prompts.get("listening_preview_priorities") + "\n\n"
                + "Runtime requirements: `played_cues` and `generated_cues` below are the bounded "
                  "recent chronological histories supplied for this wait. Compare against every "
                  "cue in both and "
                  "do not repeat any topic, fact, framing, transition, or progress wording. Never "
                  "tell the researcher to read the response or look at the screen; they are "
                  "waiting for automatic audio playback. Keep cue text at or below "
                  f"{MAX_CUE_CHARS} characters."
                + ("" if progress_is_new else
                   "\nPreparation has not advanced since the last cue. Do not mention progress, "
                   "timing, how much is left, or that anything is still being prepared — the "
                   "listener was told already and nothing has changed. Say something substantive "
                   "about the material instead.")
            )},
            {"role": "user", "content": json.dumps({
                # Kept for compatibility with existing user-edited preview prompts. It contains
                # only the live items that survived the same finite grounded-source budget.
                "completed_sentences": [
                    item for item in sentence_copy if item["kind"] == "live_response"
                ],
                "grounded_sources": sentence_copy,
                "previous_cue": previous_cue,
                "played_cues": played_copy,
                "generated_cues": generated_copy,
                # Withheld rather than merely forbidden when it has not moved: a model handed a
                # concrete count tends to use it whatever the instruction says.
                "preparation_progress": progress_copy if progress_is_new else {},
            }, ensure_ascii=False)},
        ]
        raw = generate_fn(messages, model)
        try:
            cue, source_ids = validate_result(raw, sentence_copy)
        except PreviewError as exc:
            if f"exceeds {MAX_CUE_CHARS}" not in str(exc):
                raise
            repaired = _compact_overlong_result(raw)
            cue, source_ids = validate_result(repaired, sentence_copy)
            log.warning(
                "compacted overlong preview cue chat=%s ordinal=%s target=%s hard_max=%s",
                chat_job_id[:8], ordinal, TARGET_CUE_CHARS, MAX_CUE_CHARS,
            )
        with _registry.lock:
            job.cue = cue
            job.source_sentence_ids = source_ids
            job.stage = "synthesizing"
            job.timings["cue_ready"] = now_iso()
        if _suppressed(job):
            return

        path = audio_jobs.audio_cache_path(cue)
        try:
            with audio_cache.protected([path]):
                if not audio_cache.touch(path):
                    atomic_write_bytes(path, synth_fn(cue))
                audio_cache.touch(path)
        finally:
            audio_jobs.enforce_cache_limits(path.parent)
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
            # Recorded even when withheld from the prompt: what matters later is which progress
            # this cue was ABOUT, and a stale-progress cue is still about the same state.
            progress_signature=progress_signature(progress_copy),
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
        "status": "The final spoken response is still being prepared for automatic playback.",
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
        last_started = last_started_at
        # During audio synthesis, segment progress is the preferred cue trigger — it keeps
        # progress language honest and avoids the old rapid "…still synthesizing" loop. But a
        # slow segment can take long enough that the previous cue ends well before the stitched
        # track is playable. A bounded keepalive therefore permits a fresh, non-repeating,
        # intellectually grounded cue even while the segment count is flat. -1 lets the first
        # synthesis cue fire immediately. Unknown-remaining phases (analysis, narration
        # adaptation) retain the normal cadence.
        last_synth_done = -1
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

            now = time.monotonic()
            synth_done = int(progress.get("segments_done") or 0)
            progressed = phase != "audio_synthesis" or synth_done > last_synth_done
            elapsed = now - last_started
            keepalive_due = (
                phase == "audio_synthesis"
                and elapsed >= max(cadence_seconds, SYNTHESIS_KEEPALIVE_SECONDS)
            )
            if (elapsed >= cadence_seconds and (progressed or keepalive_due)
                    and not budget_exhausted(cue_ids)):
                last_started = now
                if phase == "audio_synthesis":
                    last_synth_done = synth_done
                try:
                    played_cues, generated_cues = cue_history(cue_ids)
                    cue = start_job(
                        chat_job_id,
                        len(cue_ids) + 1,
                        source_copy,
                        "\n".join(played_cues or generated_cues),
                        progress,
                        played_cues=played_cues,
                        generated_cues=generated_cues,
                        progress_is_new=(
                            progress_signature(progress) != last_reported_progress(cue_ids)
                        ),
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
