"""In-process background jobs for chat turns (the analyst's response to a message).

An agentic turn — web searches, page fetches, then a long streamed answer — routinely runs
for minutes. The original design executed it inside a single live SSE response, so the turn's
survival was tied to one HTTP connection crossing a quick tunnel and a cellular link. When
that connection died mid-stream (confirmed live: the Cloudflare edge canceled a reply_stream
~3 minutes in), uvicorn cancelled the generator before sessions.record_assistant ran and the
entire response was silently discarded — the transcript kept the user's message and lost the
answer.

Same fix as app/audio_jobs.py / app/graph_jobs.py: run the turn in a background thread
decoupled from any connection, persist the turn server-side the moment it completes, and let
clients POLL a cheap snapshot endpoint. Each poll is an independent short request, robust to
tunnels, network blips, navigation, and the app being backgrounded — a client that comes back
mid-turn reattaches to the running job and still sees the live progression (interleaved text
and tool calls, in arrival order), and one that comes back late finds the turn already in the
transcript.

One job per session slug at a time: starting while one is running joins it (server-side twin
of the client's double-tap guard). Finished jobs are kept briefly for late polls.
"""
from __future__ import annotations

import asyncio
import threading
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import AsyncIterator, Callable, Iterable

from . import agent, agent_harness, config, sessions
from .agent import AgentError

# Finished jobs kept for late polls; pruned oldest-first past this cap.
_MAX_FINISHED = 20

# runner(slug, history) yields the same event dicts as agent_harness.stream_agentic_events:
# {'type': 'text'|'tool'|'final', ...}. Sync or async iterator; injectable for tests.
RunnerFn = Callable[[str, list], "AsyncIterator[dict] | Iterable[dict]"]


@dataclass
class ChatJob:
    id: str
    slug: str
    status: str = "running"          # running | done | error
    # The live turn as the client should render it: runs of assistant text and tool calls in
    # arrival order ({kind: 'text', text} | {kind: 'tool', name, detail}). Consecutive text is
    # merged server-side so a poll returns a handful of items, not thousands of deltas.
    items: list = field(default_factory=list)
    turn: dict | None = None         # parsed+recorded Turn.to_dict(), once done
    state: str | None = None         # session state after the turn, once done
    error: str | None = None
    started_at: str = ""
    finished_at: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


_jobs: dict[str, ChatJob] = {}
_lock = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def get_job(job_id: str) -> ChatJob | None:
    with _lock:
        return _jobs.get(job_id)


def snapshot(job_id: str) -> dict | None:
    """A poll-safe copy of the job: serialized under the lock so the runner thread can't be
    mutating `items` while the API layer reads it."""
    with _lock:
        job = _jobs.get(job_id)
        return job.to_dict() if job else None


def active_for(slug: str) -> ChatJob | None:
    """The running job for a session, if any — how a client that navigated away and returned
    finds the turn it left mid-flight."""
    with _lock:
        for job in _jobs.values():
            if job.slug == slug and job.status == "running":
                return job
    return None


def start_turn(slug: str, runner: RunnerFn | None = None) -> ChatJob:
    """Start generating the assistant turn for `slug` in a background thread, or join the job
    already running for it. The user message must already be recorded (history is rebuilt from
    the session file inside the thread). Callers poll get_job(id) until it settles; the turn is
    recorded to the session the moment it completes, whether or not anyone is polling."""
    with _lock:
        for job in _jobs.values():
            if job.slug == slug and job.status == "running":
                return job
        job = ChatJob(id=uuid.uuid4().hex, slug=slug, started_at=_now())
        _register(job)

    # The request's active project is a contextvar that won't exist in the thread; carry it.
    pid = config.active_project_id()
    thread = threading.Thread(target=_run, args=(job, pid, runner or _default_events),
                              daemon=True, name=f"chat-{job.id[:8]}")
    thread.start()
    return job


def _register(job: ChatJob) -> None:
    """Store the job (caller holds the lock) and prune the oldest finished ones."""
    _jobs[job.id] = job
    finished = [j for j in _jobs.values() if j.status != "running"]
    if len(finished) > _MAX_FINISHED:
        for stale in sorted(finished, key=lambda j: j.started_at)[:len(finished) - _MAX_FINISHED]:
            _jobs.pop(stale.id, None)


def _default_events(slug: str, history: list):
    """The production runner: the agentic tool loop when enabled, else the single-shot token
    stream wrapped in the same event shape."""
    if agent_harness.AGENTIC_ENABLED:
        return agent_harness.stream_agentic_events(slug, history)

    def _single_shot():
        pieces: list[str] = []
        for piece in agent.stream_tokens(slug, history):
            pieces.append(piece)
            yield {"type": "text", "text": piece}
        yield {"type": "final", "text": "".join(pieces)}
    return _single_shot()


def _run(job: ChatJob, pid: str | None, runner: RunnerFn) -> None:
    config.set_active_project(pid)
    try:
        history = sessions.build_history(job.slug)
        events = runner(job.slug, history)
        if hasattr(events, "__aiter__"):
            final_text = asyncio.run(_consume_async(job, events))
        else:
            final_text = _consume_sync(job, events)

        turn = agent.parse(final_text)
        if not turn.canonical.strip():
            raise AgentError("The model returned an empty response. Try again, or switch the "
                             "analysis model in Settings.")
        sessions.record_assistant(job.slug, turn)
        with _lock:
            job.turn = turn.to_dict()
            job.state = sessions.get_state(job.slug)
            job.status = "done"
            job.finished_at = _now()
    except Exception as e:
        with _lock:
            job.status = "error"
            job.error = str(e)[:400]
            job.finished_at = _now()


async def _consume_async(job: ChatJob, events: AsyncIterator[dict]) -> str:
    pieces: list[str] = []
    sent = 0
    final_text = ""
    async for ev in events:
        sent = _apply(job, ev, pieces, sent)
        if ev["type"] == "final":
            final_text = ev["text"]
    return final_text or "".join(pieces)


def _consume_sync(job: ChatJob, events: Iterable[dict]) -> str:
    pieces: list[str] = []
    sent = 0
    final_text = ""
    for ev in events:
        sent = _apply(job, ev, pieces, sent)
        if ev["type"] == "final":
            final_text = ev["text"]
    return final_text or "".join(pieces)


def _apply(job: ChatJob, ev: dict, pieces: list[str], sent: int) -> int:
    """Fold one runner event into the job's items. Text deltas surface only their CANONICAL
    prefix (same incremental extraction the SSE path used), merged into the trailing text item;
    tool calls append a tool item. Returns the updated canonical-chars-shown count."""
    if ev["type"] == "text":
        pieces.append(ev["text"])
        canon = agent.canonical_prefix("".join(pieces))
        if len(canon) > sent:
            delta = canon[sent:]
            with _lock:
                if job.items and job.items[-1]["kind"] == "text":
                    job.items[-1] = {"kind": "text", "text": job.items[-1]["text"] + delta}
                else:
                    job.items.append({"kind": "text", "text": delta})
            return len(canon)
    elif ev["type"] == "tool":
        with _lock:
            job.items.append({"kind": "tool", "name": ev["name"], "detail": ev.get("detail", "")})
    return sent
