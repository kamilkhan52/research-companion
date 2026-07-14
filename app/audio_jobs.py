"""In-process background jobs for the narrate→synthesize audio pipeline.

Preparing audio for one assistant message means a narration-model LLM call followed by one
OpenAI TTS call per ~3800-char segment — routinely minutes for a long analysis. The original
design ran all of that inside a single blocking POST (/api/narrate then /api/speak), which any
proxy with an origin timeout kills mid-flight: the Cloudflare quick tunnel returns 524 after
~100s while the server keeps synthesizing and caches the mp3 it will never get to serve for
that request. The client saw "Request failed (524)" for audio that actually succeeded.

Same fix as app/graph_jobs.py (see its docstring for the war story): run the pipeline in a
background thread decoupled from any connection, and let clients POLL a cheap status endpoint.
Each poll is an independent short request, robust to tunnels, network blips, and the app being
backgrounded. Progress is real — the narrating stage, then synthesized-segments done/total —
so the UI can show an honest progress bar.

Jobs are DEDUPED by a hash of (voice settings + canonical text): re-requesting the same message
joins the in-flight job instead of starting a duplicate, and a finished result is answered
instantly from the narration/mp3 caches without a thread. Each attempt's job id is unique,
so a cancel aimed at one attempt can never hit the fresh attempt a retry created under the
same dedup key (job_id_for stays the deterministic pre-start handle; chat_jobs reconciles the
recorded id with the started attempt's real id).
"""
from __future__ import annotations

import hashlib
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from . import agent, config, sessions, tts, usage
from .fileio import atomic_write_bytes
from .jobs import Job, JobRegistry, new_id, now_iso

AUDIO_DIR = config.APP_STATE_DIR / "audio"  # app-global (shared with the /api/audio route)
AUDIO_DIR.mkdir(parents=True, exist_ok=True)

NarrateFn = Callable[[str], str]
SynthFn = Callable[[str], bytes]


@dataclass
class AudioJob(Job):
    stage: str = "narrating"         # narrating | synthesizing
    segments_done: int = 0
    segments_total: int = 0
    narration: str | None = None     # available once the narrating stage finishes
    url: str | None = None           # /api/audio/<hash>.mp3, once done
    segments: list[dict] = field(default_factory=list)  # published incrementally
    timings: dict[str, str] = field(default_factory=dict)


# Keyed by content hash (voice settings + text); `_jobs` aliases the registry dict so tests can
# clear() it to reset. Higher finished cap than the others — audio jobs are small and re-listened.
_registry: JobRegistry[AudioJob] = JobRegistry("audio", max_finished=50)
_jobs = _registry.jobs


def _voice_key() -> str:
    s = config.load_settings()
    return f"openai|{s.get('tts_model')}|{s.get('tts_voice')}"


def job_id_for(text: str) -> str:
    return hashlib.sha1(f"{_voice_key()}|{text}".encode()).hexdigest()


def audio_cache_path(narration: str) -> Path:
    """Cache file for a narration under the current voice settings. Same key scheme
    /api/speak has always used, so both entry points share one cache."""
    name = hashlib.sha1(f"{_voice_key()}|{narration}".encode()).hexdigest() + ".mp3"
    return AUDIO_DIR / name


def segment_cache_path(text: str) -> Path:
    name = hashlib.sha1(f"segment|{_voice_key()}|{text}".encode()).hexdigest() + ".mp3"
    return AUDIO_DIR / name


def _segment_metadata(parts: list[str], *, existing_only: bool) -> list[dict]:
    out = []
    for index, part in enumerate(parts):
        path = segment_cache_path(part)
        if existing_only and not path.exists():
            return []
        out.append({"index": index, "text": part, "url": f"/api/audio/{path.name}"})
    return out


# Audio is app-global (the mp3 cache is shared across projects), so its jobs live under the
# None project scope explicitly — identical audio requested from any project shares one job.
def get_job(job_id: str) -> AudioJob | None:
    return _registry.get(job_id, project_id=None)


def cancel_job(job_id: str) -> AudioJob | None:
    """Cooperatively cancel a running preparation (see JobRegistry.cancel). The worker stops at
    its next checkpoint — before the narration call and between TTS segments — so at most one
    in-flight upstream call completes after this returns. Because jobs are deduped by content
    hash, cancelling also cancels for any other client joined to the same text (acceptable for
    the single-household deployment). Segments already synthesized stay in the cache, so a
    re-request resumes rather than restarting from zero."""
    return _registry.cancel(job_id, project_id=None)


def start_job(text: str, billing_project: str | None = None,
              narrate_fn: NarrateFn | None = None,
              synth_fn: SynthFn | None = None) -> AudioJob:
    """Start preparing audio for `text` in a background thread, join the identical job if one
    is already running, or answer instantly from the caches if the result already exists.
    Returns the job snapshot either way — callers just poll get_job(id) until it settles.

    The job itself is app-global (project_id=None) so the mp3/narration caches and dedup are
    shared across projects, but the narration LLM call is billed to `billing_project` — the
    project that initiated this uncached narration. A cache hit does no LLM work and so costs
    nothing (no one is billed), matching the intended policy. `billing_project` must already be
    validated by the caller. narrate_fn/synth_fn are injectable for tests."""
    narrate_fn = narrate_fn or agent.narrate
    synth_fn = synth_fn or tts.openai_speech
    jid = job_id_for(text)

    existing = _registry.active_for(jid, project_id=None)
    if existing:
        return existing

    # Fully cached (narration text + synthesized mp3): register a done job, no thread.
    narration = sessions.get_cached_narration(text)
    if narration is not None and audio_cache_path(narration).exists():
        parts = tts.split_for_tts(narration)
        segments = _segment_metadata(parts, existing_only=True)
        return _registry.put(jid, AudioJob(
            id=new_id(), status="done", stage="synthesizing", narration=narration,
            url=f"/api/audio/{audio_cache_path(narration).name}",
            segments=segments, segments_done=len(segments), segments_total=len(parts),
            finished_at=now_iso()),
            project_id=None)

    def work(job: AudioJob) -> None:
        # Cancellation checkpoints bracket every paid upstream call (narration LLM, each TTS
        # segment): a cancel lands within one call's latency, and the worker exits without
        # marking done (the registry already flipped the job to `cancelled`).
        def cancelled() -> bool:
            return _registry.is_cancelled(job)

        if cancelled():
            return
        narration = sessions.get_cached_narration(text)
        if narration is None:
            # Bind a billing scope ONLY around the narration call, so its LLM spend attributes
            # there (usage.record reads the active project) while the surrounding job — and the
            # app-global narration/mp3 caches it writes — stay project-agnostic. With no
            # initiating project, bill the explicit unattributed ledger rather than dropping it.
            token = config.set_active_project(billing_project or usage.UNATTRIBUTED)
            try:
                narration = narrate_fn(text)
            finally:
                config.reset_active_project(token)
            sessions.cache_narration(text, narration)
        if cancelled():
            return
        with _registry.lock:
            job.narration = narration
            job.stage = "synthesizing"
            job.timings["narration_complete"] = now_iso()

        path = audio_cache_path(narration)
        parts = tts.split_for_tts(narration)
        if not parts:
            raise tts.TTSError("Nothing to synthesize.")
        with _registry.lock:
            job.segments_total = len(parts)

        # A legacy combined cache may not have segment files. Keep the zero-cost cache hit and
        # let clients use the final URL instead of re-synthesizing merely to backfill segments.
        if path.exists() and not _segment_metadata(parts, existing_only=True):
            with _registry.lock:
                job.segments_done = len(parts)
        else:
            chunks: list[bytes] = []
            for index, part in enumerate(parts):
                if cancelled():
                    return
                segment_path = segment_cache_path(part)
                if not segment_path.exists():
                    atomic_write_bytes(segment_path, synth_fn(part))
                chunks.append(segment_path.read_bytes())
                with _registry.lock:
                    job.segments.append({
                        "index": index,
                        "text": part,
                        "url": f"/api/audio/{segment_path.name}",
                    })
                    job.segments_done += 1
                    if index == 0:
                        job.timings["first_segment"] = now_iso()
            if not path.exists():
                atomic_write_bytes(path, b"".join(chunks))

        with _registry.lock:
            job.url = f"/api/audio/{path.name}"

    return _registry.start_or_join(jid, lambda: AudioJob(id=new_id()), work, project_id=None)
