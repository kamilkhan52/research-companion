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

from . import agent, audio_cache, config, sessions, tts, usage
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
_registry: JobRegistry[AudioJob] = JobRegistry("audio", max_finished=50, metered=True,
                                  operation="speech_synthesis")
_jobs = _registry.jobs


def user_audio_dir() -> Path:
    """Where the active user's mp3s live: their own directory, or the flat app-global one when no
    user is bound (single-tenant `./run.sh`, which therefore keeps its existing cache).

    Every path in this module resolves through here, and so does the `/api/audio/{name}` route —
    which is the whole boundary. Two users asking for the same passage in the same voice produce
    the SAME file name, and reach different files, because the name is only ever joined to the
    caller's own directory. There is no ownership lookup to forget, and a leaked file name buys
    nothing.

    The cost is honest and was chosen (Kamil, 2026-07-26): identical narration is synthesized once
    per user instead of once. In exchange, cancellation is trivially correct (the job is the
    caller's alone) and account deletion is a directory removal.
    """
    scope = config.user_scope_dir()
    directory = AUDIO_DIR if scope is None else scope / "audio"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def claim_cached_file(name: str) -> Path | None:
    """Touch and protect one caller-scoped file for the lifetime of an HTTP response."""
    path = user_audio_dir() / name
    return path if audio_cache.claim(path) else None


def release_cached_file(path: Path) -> None:
    audio_cache.release(path)
    audio_cache.enforce(path.parent, AUDIO_DIR)


def enforce_cache_limits(directory: Path | None = None) -> None:
    audio_cache.enforce(directory or user_audio_dir(), AUDIO_DIR)


def _audio_scope() -> str | None:
    """The job-registry scope for the active user, or None (app-global) when there is none.

    This travels in the same field `JobRegistry` uses for project ids, and `start_or_join` consults
    the project deletion/busy tombstones with whatever it is handed. That is safe only because a
    `user:` prefix can never be a project id — `projects._safe_pid` rejects `:` — so the two
    namespaces provably cannot collide rather than happening not to. Asserted in
    `tests/test_audio_isolation.py`.

    The pseudonym rather than the raw id, because the registry TAGS EVERY LOG LINE with this scope:
    the id itself would put a durable Supabase account identifier, and the times that account
    listens to things, into the log drain. It is also the same value that names the user's audio
    directory, so a log line and a directory can be lined up during support without either one
    naming a person.
    """
    key = config.user_scope_key()
    return None if key is None else f"user:{key}"


def _voice_key() -> str:
    s = config.load_settings()
    return f"openai|{s.get('tts_model')}|{s.get('tts_voice')}"


def job_id_for(text: str) -> str:
    return hashlib.sha1(f"{_voice_key()}|{text}".encode()).hexdigest()


def audio_cache_path(narration: str) -> Path:
    """Cache file for a narration under the current voice settings."""
    name = hashlib.sha1(f"{_voice_key()}|{narration}".encode()).hexdigest() + ".mp3"
    return user_audio_dir() / name


def segment_cache_path(text: str) -> Path:
    name = hashlib.sha1(f"segment|{_voice_key()}|{text}".encode()).hexdigest() + ".mp3"
    return user_audio_dir() / name


def _segment_metadata(parts: list[str], *, existing_only: bool) -> list[dict]:
    out = []
    for index, part in enumerate(parts):
        path = segment_cache_path(part)
        if existing_only and not audio_cache.touch(path):
            return []
        out.append({"index": index, "text": part, "url": f"/api/audio/{path.name}"})
    return out


# Audio is app-global ACROSS PROJECTS — one user's audio is shared between their own projects,
# since the mp3 cache is keyed by content and voice, not by paper. It is NOT shared across users:
# the scope below is the caller's, so a job id names a job only for the person who started it.
def get_job(job_id: str) -> AudioJob | None:
    return _registry.get(job_id, project_id=_audio_scope())


def cancel_job(job_id: str) -> AudioJob | None:
    """Cooperatively cancel a running preparation (see JobRegistry.cancel). The worker stops at
    its next checkpoint — before the narration call and between TTS segments — so at most one
    in-flight upstream call completes after this returns. Segments already synthesized stay in the
    cache, so a re-request resumes rather than restarting from zero.

    Dedup joins only within one user's scope, so cancelling can no longer stop a preparation
    somebody else is waiting on. That used to be documented as acceptable for a single-household
    deployment; with strangers on the instance it is an unauthenticated denial of service, and it
    is what made per-user scoping the right answer rather than an ACL over a shared job."""
    return _registry.cancel(job_id, project_id=_audio_scope())


def start_job(text: str, billing_project: str | None = None,
              narrate_fn: NarrateFn | None = None,
              synth_fn: SynthFn | None = None,
              metered: bool = True) -> AudioJob:
    """Start preparing audio for `text` in a background thread, join the identical job if one
    is already running, or answer instantly from the caches if the result already exists.
    Returns the job snapshot either way — callers just poll get_job(id) until it settles.

    The job is scoped to the active USER (`_audio_scope`), not to a project, so the mp3/narration
    caches and dedup are shared across that person's projects but never across people. The worker
    thread resolves the same scope because `JobRegistry` rebinds the active user alongside the
    active project — without that rebind the worker would write into the flat app-global directory
    while the route read from the user's, and every preparation would appear to fail.

    The narration LLM call is billed to `billing_project` — the
    project that initiated this uncached narration. A cache hit does no LLM work and so costs
    nothing (no one is billed), matching the intended policy. `billing_project` must already be
    validated by the caller. narrate_fn/synth_fn are injectable for tests."""
    narrate_fn = narrate_fn or agent.narrate
    synth_fn = synth_fn or tts.openai_speech
    jid = job_id_for(text)

    existing = _registry.active_for(jid, project_id=_audio_scope())
    if existing:
        return existing

    # Fully cached (narration text + synthesized mp3): register a done job, no thread.
    narration = sessions.get_cached_narration(text)
    cached_path = audio_cache_path(narration) if narration is not None else None
    if narration is not None and cached_path is not None and audio_cache.touch(cached_path):
        parts = tts.split_for_tts(narration)
        segments = _segment_metadata(parts, existing_only=True)
        return _registry.put(jid, AudioJob(
            id=new_id(), status="done", stage="synthesizing", narration=narration,
            url=f"/api/audio/{cached_path.name}",
            segments=segments, segments_done=len(segments), segments_total=len(parts),
            finished_at=now_iso()),
            project_id=_audio_scope())

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

        segment_paths = [segment_cache_path(part) for part in parts]
        try:
            with audio_cache.protected([path, *segment_paths]):
                # The audio registry is keyed by a user pseudonym rather than a project. Rebind
                # the initiating billing project around every TTS dispatch just as narration does
                # above; otherwise usage.record tries to bill `user:<hash>` and spend disappears.
                token = config.set_active_project(billing_project or usage.UNATTRIBUTED)
                try:
                    # A legacy combined cache may not have segment files. Keep the zero-cost cache
                    # hit and let clients use the final URL instead of re-synthesizing to backfill.
                    if audio_cache.touch(path) and not _segment_metadata(parts, existing_only=True):
                        with _registry.lock:
                            job.segments_done = len(parts)
                    else:
                        chunks: list[bytes] = []
                        for index, (part, segment_path) in enumerate(
                            zip(parts, segment_paths, strict=True)
                        ):
                            if cancelled():
                                return
                            if not audio_cache.touch(segment_path):
                                atomic_write_bytes(segment_path, synth_fn(part))
                            audio_cache.touch(segment_path)
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
                        if not audio_cache.touch(path):
                            atomic_write_bytes(path, b"".join(chunks))
                        audio_cache.touch(path)
                finally:
                    config.reset_active_project(token)
        finally:
            # Partial segments from a cancelled/failed job are useful resume points but cannot be
            # allowed to bypass the volume bound. Active paths stay protected until this point.
            enforce_cache_limits(path.parent)

        with _registry.lock:
            job.url = f"/api/audio/{path.name}"

    return _registry.start_or_join(jid, lambda: AudioJob(id=new_id()), work,
                                   project_id=_audio_scope(), metered=metered,
                                   reserves=True)
