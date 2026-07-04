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

Jobs are keyed by a hash of (voice settings + canonical text): re-requesting the same message
joins the in-flight job instead of starting a duplicate, and a finished result is answered
instantly from the narration/mp3 caches without a thread.
"""
from __future__ import annotations

import hashlib
import threading
from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path

from . import agent, config, sessions, tts

AUDIO_DIR = config.APP_STATE_DIR / "audio"  # app-global (shared with the /api/audio route)
AUDIO_DIR.mkdir(parents=True, exist_ok=True)

# Finished jobs kept for late polls; pruned oldest-first past this cap.
_MAX_FINISHED = 50

NarrateFn = Callable[[str], str]
SynthFn = Callable[[str], bytes]


@dataclass
class AudioJob:
    id: str
    status: str = "running"          # running | done | error
    stage: str = "narrating"         # narrating | synthesizing
    segments_done: int = 0
    segments_total: int = 0
    narration: str | None = None     # available once the narrating stage finishes
    url: str | None = None           # /api/audio/<hash>.mp3, once done
    error: str | None = None
    started_at: str = ""
    finished_at: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


_jobs: dict[str, AudioJob] = {}
_lock = threading.Lock()


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


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


def get_job(job_id: str) -> AudioJob | None:
    with _lock:
        return _jobs.get(job_id)


def start_job(text: str, narrate_fn: NarrateFn | None = None,
              synth_fn: SynthFn | None = None) -> AudioJob:
    """Start preparing audio for `text` in a background thread, join the identical job if one
    is already running, or answer instantly from the caches if the result already exists.
    Returns the job snapshot either way — callers just poll get_job(id) until it settles.
    narrate_fn/synth_fn are injectable for tests; resolved late so patching agent/tts works."""
    narrate_fn = narrate_fn or agent.narrate
    synth_fn = synth_fn or tts.openai_speech
    jid = job_id_for(text)
    with _lock:
        existing = _jobs.get(jid)
        if existing and existing.status == "running":
            return existing

        # Fully cached (narration text + synthesized mp3): done without spawning a thread.
        narration = sessions.get_cached_narration(text)
        if narration is not None and audio_cache_path(narration).exists():
            job = AudioJob(id=jid, status="done", stage="synthesizing", narration=narration,
                           url=f"/api/audio/{audio_cache_path(narration).name}",
                           started_at=_now(), finished_at=_now())
            _register(job)
            return job

        job = AudioJob(id=jid, started_at=_now())
        _register(job)

    thread = threading.Thread(target=_run, args=(job, text, narrate_fn, synth_fn),
                              daemon=True, name=f"audio-{jid[:8]}")
    thread.start()
    return job


def _register(job: AudioJob) -> None:
    """Store the job (caller holds the lock) and prune the oldest finished ones."""
    _jobs[job.id] = job
    finished = [j for j in _jobs.values() if j.status != "running"]
    if len(finished) > _MAX_FINISHED:
        for stale in sorted(finished, key=lambda j: j.started_at)[:len(finished) - _MAX_FINISHED]:
            _jobs.pop(stale.id, None)


def _run(job: AudioJob, text: str, narrate_fn: NarrateFn, synth_fn: SynthFn) -> None:
    try:
        narration = sessions.get_cached_narration(text)
        if narration is None:
            narration = narrate_fn(text)
            sessions.cache_narration(text, narration)
        with _lock:
            job.narration = narration
            job.stage = "synthesizing"

        path = audio_cache_path(narration)
        if not path.exists():
            parts = tts.split_for_tts(narration)
            if not parts:
                raise tts.TTSError("Nothing to synthesize.")
            with _lock:
                job.segments_total = len(parts)
            chunks: list[bytes] = []
            for part in parts:
                chunks.append(synth_fn(part))
                with _lock:
                    job.segments_done += 1
            path.write_bytes(b"".join(chunks))

        with _lock:
            job.status = "done"
            job.url = f"/api/audio/{path.name}"
            job.finished_at = _now()
    except Exception as e:
        with _lock:
            job.status = "error"
            job.error = str(e)[:400]
            job.finished_at = _now()
