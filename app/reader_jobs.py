"""Reading assistants for cited-but-unread project papers (DR-140).

Kamil, 2026-09-04: a paper summary situates the paper against the rest of the project, and it
cites project papers nobody here has read yet — for those the analyst has an abstract and the
citing sentence, and the relationship prose it writes from that is guesswork dressed as
scholarship. His design: after the summary, offer to have the agent "spawn a subagent that reads
the paper in the context of the current paper that cites it"; let the reader pick which papers
(check marks), watch each assistant's status, then feed every brief back to the main agent to
enrich the current paper's context, with the briefs viewable but collapsed by default.

That is exactly the shape here, with the app's standing rules applied:

* **Candidates are deterministic** (`candidates`): the project papers a response linked as
  `rc-paper:<slug>` that carry no Paper Notes. No model decides what it "would like" to read —
  the response already said which papers it leaned on, and a paper without notes is one the
  context could not have known beyond its abstract.
* **One job, one paper per unit** (`start_reading`): a background job (invariant 1) reads each
  chosen paper with ONE model call — the target's full text plus the analyst's account of the
  current paper — under `spend_ceiling.per_unit`, so a reader who can afford two of four papers
  gets two rather than a refusal, and the registry holds no ticket of its own (`reserves=False`,
  the `lab_research` shape). Per-paper status is what the client shows.
* **The briefs become context by becoming a turn**: when the assistants finish, the job appends
  a hidden user record (`sessions.record_briefing`) carrying the framed briefs and the
  briefing instruction, then chains the ordinary chat turn on it — the analyst revises its
  relationship claims from the briefs, and every later turn in the thread has them in history.
  The transcript hides the record like a Finish prompt and attaches the briefs to the response
  that answered it, which is where the client renders them collapsed.

Nothing here writes to the git record: briefs live in the session transcript, the same place as
the discussion they belong to (invariant 4 untouched).
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass, field

from . import (
    chat_jobs,
    llm,
    logging_config,
    model_provenance,
    operation_limits,
    prompts,
    quotas,
    rate_limits,
    sessions,
    spend_ceiling,
    store,
)
from .jobs import Job, JobRegistry, new_id
from .models import IN_DISCUSSION

log = logging_config.get("reader")

#: The link form every analysis turn is told to use for a project paper (prompts.py). Slugs
#: are `store.derive_slug` output — ASCII word characters, dots and dashes.
_RC_PAPER_LINK_RE = re.compile(r"\(rc-paper:([A-Za-z0-9._-]+)\)")

#: Bounds. The target text cap is generous on purpose — the whole point is reading the paper in
#: full rather than the 16k-char window `read_paper_text` gives a mid-turn tool call — but it is a
#: cap: a 400-page thesis is not what "a cited paper" means, and the per-unit hold is priced for a
#: paper. The account cap keeps the analyst's summary from crowding the target out.
MAX_TARGET_TEXT_CHARS = 160_000
MAX_ACCOUNT_CHARS = 24_000
MAX_BRIEF_CHARS = 12_000
MAX_TARGETS = 8

# Fixed independently of the account's Analysis model. The reservation below is $0.08 for one
# paper and must remain a real ceiling even if an operator selects an expensive model in Settings.
# At the pinned model's published $0.0938/M input and $0.1876/M output, the 184k-character input
# caps plus 12k output remain below $0.02 even if every character tokenizes separately. One
# accepted response only (`tries=1`) leaves 4x headroom for endpoint price spread while preserving
# the product contract that one assistant reads one paper with one model call.
READER_MODEL = "deepseek/deepseek-v4-flash-0731"

#: How long a finished pass will wait for a turn the reader started meanwhile (Opus review of
#: #492, P1): the composer stays open while assistants read, and a reply sent then runs an
#: agentic turn for minutes. Refusing at that point threw away every paid brief; waiting
#: delivers them after the reply is answered. The deadline is a backstop, not a budget — a
#: turn is bounded by `operation_limits` well inside it, and past it the briefs stay on the job.
WAIT_FOR_TURN_S = 30 * 60
WAIT_POLL_S = 2.0


class ReaderError(Exception):
    """A request the reader must fix — no session, a bad target, a turn already running."""


@dataclass
class ReaderJob(Job):
    slug: str = ""
    thread_id: str = sessions.MAIN_THREAD
    #: Which response the reader was answering when they asked; informational.
    assistant_index: int | None = None
    #: One row per chosen paper, in reading order:
    #: {slug, title, status: queued | reading | done | error | skipped, error}. `skipped` is a
    #: paper never attempted because the account ran out of budget first (the `refusal` says so).
    targets: list = field(default_factory=list)
    current: str | None = None
    delivery_mode: str = "reading"
    #: Every brief written so far ({slug, title, text}), on the snapshot so paid work survives
    #: whatever happens after it — a follow-up that never starts, a wait that times out.
    briefs: list = field(default_factory=list)
    #: True while the finished pass waits for a turn the reader started meanwhile (see
    #: `WAIT_FOR_TURN_S`), so the card can say so instead of looking stuck.
    waiting: bool = False
    #: Set when the spend ceiling stopped the pass part-way (DR-049 shape, like lab research).
    stopped_reason: str | None = None
    #: The chained follow-up turn, once the briefs are recorded — pollers follow this id to
    #: watch the analyst revise. Failure to START that turn lands here rather than failing the
    #: job: the briefs are recorded and the session's `pending_turn` retry re-runs the turn.
    analysis_job_id: str | None = None
    analysis_error: str | None = None
    analysis_refusal: dict | None = None


_registry: JobRegistry[ReaderJob] = JobRegistry(
    "reader", max_finished=20, metered=True, operation="paper_read", reserves=False,
)
_jobs = _registry.jobs


def get_job(job_id: str) -> ReaderJob | None:
    return _registry.get(job_id)


def snapshot(job_id: str) -> dict | None:
    return _registry.snapshot(job_id)


def _key(slug: str, thread_id: str) -> str:
    return f"{slug}::{thread_id}"


def active_for(slug: str, thread_id: str | None = None) -> ReaderJob | None:
    # Stop is cooperative. A cancelled worker can still return the already-billed paper brief,
    # so it remains the active pass until finalization publishes `finished_at`.
    return _registry.unfinished_for(_key(slug, _thread(thread_id)))


def latest_for(slug: str, thread_id: str | None = None) -> ReaderJob | None:
    return _registry.latest_for(_key(slug, _thread(thread_id)))


def request_cancel(job_id: str) -> dict | None:
    """Stop after the paper currently being read; nothing already briefed is lost, but a pass
    that produced no brief chains no turn."""
    if _registry.cancel(job_id) is None:
        return None
    return snapshot(job_id)


def _thread(thread_id: str | None) -> str:
    return sessions.validate_thread_id(
        thread_id if thread_id is not None else sessions.active_thread_id(),
    )


# ---------------------------------------------------------------------------- candidates

def candidates(slug: str, thread_id: str | None = None,
               assistant_index: int | None = None) -> dict:
    """The project papers one response cited without their having been read: every distinct
    `rc-paper:` link in that response's canonical text whose paper has no Paper Notes, minus the
    current paper and anything already briefed in this thread. `assistant_index` defaults to
    the latest response. `has_text` says whether the assistant could read it right now."""
    thread_id = _thread(thread_id)
    responses = [r for r in sessions.read_records(slug, thread_id) if r.get("role") == "assistant"]
    if not responses:
        return {"assistant_index": None, "candidates": []}
    if assistant_index is None:
        assistant_index = len(responses) - 1
    if not 0 <= assistant_index < len(responses):
        raise ReaderError("No such response in this discussion.")
    papers = {p.slug: p for p in store.list_papers()}
    briefed = sessions.briefed_slugs(slug, thread_id)
    seen: set[str] = set()
    out: list[dict] = []
    for match in _RC_PAPER_LINK_RE.finditer(responses[assistant_index].get("canonical") or ""):
        target = match.group(1)
        if target in seen or target == slug:
            continue
        seen.add(target)
        paper = papers.get(target)
        if paper is None or paper.has_notes or target in briefed:
            continue
        out.append({"slug": target, "title": paper.title, "year": paper.year,
                    "has_text": paper.retrieved})
    return {"assistant_index": assistant_index, "candidates": out}


# ---------------------------------------------------------------------------- the reading

def _account(slug: str, thread_id: str, assistant_index: int | None) -> str:
    """The analyst's own account the assistants read against: the chosen response's canonical
    text (latest by default), tail-capped because the relationships paragraph is at the end."""
    responses = [r for r in sessions.read_records(slug, thread_id) if r.get("role") == "assistant"]
    if not responses:
        return ""
    idx = len(responses) - 1 if assistant_index is None else assistant_index
    if not 0 <= idx < len(responses):
        raise ReaderError("No such response in this discussion.")
    text = (responses[idx].get("canonical") or "").strip()
    if len(text) > MAX_ACCOUNT_CHARS:
        text = "[earlier part of the account omitted]\n\n" + text[-MAX_ACCOUNT_CHARS:]
    return text


def read_with_model(target_slug: str, account: str, current_slug: str) -> str:
    """One reading assistant, one paper: the production reader. A single non-streaming call on
    the fixed bounded reader model — no tools, the whole target text is the point — metered as
    `paper_read` against whatever reservation the caller bound (the per-unit hold)."""
    target_text = store.read_full_text(target_slug)
    if not target_text.strip():
        raise ReaderError("This paper has no cached text yet.")
    if len(target_text) > MAX_TARGET_TEXT_CHARS:
        target_text = target_text[:MAX_TARGET_TEXT_CHARS] + "\n\n[...truncated...]"
    current_title = store.title_for(current_slug)
    target_title = store.title_for(target_slug)
    system = prompts.get("paper_reader") + "\n\n" + model_provenance.SYSTEM_POLICY
    # Titles travel in the frames' `source` fields, never raw in the prompt: a reading-list
    # title is reader-authored text, and the opening message frames even a lone title.
    user = (
        "The analyst's account of the CURRENT paper (it cites the target; the current paper's "
        "title is the data's source):\n"
        + model_provenance.frame("analyst_account", account or "(no account available)",
                                 source=f"{current_slug}: {current_title}")
        + "\n\nThe TARGET paper's full text (its title is the data's source):\n"
        + model_provenance.frame("project_paper_full_text", target_text,
                                 source=f"{target_slug}: {target_title}")
        + "\n\nWrite the brief now."
    )
    return llm.complete(
        [{"role": "system", "content": system}, {"role": "user", "content": user}],
        model=READER_MODEL,
        temperature=0.2,
        max_tokens=operation_limits.tokens_for("paper_read"),
        reasoning=llm.no_reasoning_payload(),
        tries=1,
        operation="paper_read",
    )


def briefing_text(briefs: list[dict]) -> str:
    """The model-facing briefing turn: the instruction plus every brief framed as untrusted
    data — the briefs are model output over paper text, and neither is a trusted channel."""
    framed = []
    for brief in briefs:
        # The slug is the link target the analyst must reuse; the title stays in the frame's
        # source (reading-list text is reader-authored, and this reaches a tool-capable turn).
        framed.append(
            f"Brief on the project paper whose link target is rc-paper:{brief['slug']} "
            "(its title is the data's source):\n"
            + model_provenance.frame("reading_assistant_brief", brief["text"],
                                     source=f"{brief['slug']}: {brief['title']}")
        )
    return prompts.render("briefing_instruction", briefs="\n\n".join(framed))


def start_reading(slug: str, targets: list[str], *, thread_id: str | None = None,
                  assistant_index: int | None = None, delivery_mode: str = "reading",
                  reader_fn=None, turn_runner=None) -> ReaderJob:
    """Start (or join) the reading pass for `slug`'s conversation: brief each of `targets` in
    order, record the briefing turn, chain the analyst's follow-up. Validation is up front so a
    bad request is a refusal, never a job that fails after admission. A second request for the
    same conversation while a pass runs JOINS it (chat's semantics), whatever targets it names.
    `reader_fn(target_slug, account, current_slug) -> brief` and `turn_runner` are the tests'
    seams."""
    thread_id = _thread(thread_id)
    if delivery_mode not in ("reading", "listening"):
        raise ReaderError(f"Unknown delivery mode: {delivery_mode}")
    state = sessions.get_state(slug)
    if not state:
        raise ReaderError("No active session for this paper.")
    # Only while the discussion is open: after Finish the last records are a proposal, and
    # appending a briefing turn plus its answer behind them would leave `reopen_discussion`
    # nothing it recognises to pop — the rejected draft would stay in the model's history.
    if state != IN_DISCUSSION:
        raise ReaderError("Reading assistants are available while the discussion is open — "
                          "review or reopen the notes first.")
    if chat_jobs.active_for(slug, thread_id):
        raise ReaderError("A response is already being generated for this paper — wait for it.")
    wanted = list(dict.fromkeys(t.strip() for t in targets if t and t.strip()))
    if not wanted:
        raise ReaderError("Pick at least one paper to read.")
    if len(wanted) > MAX_TARGETS:
        raise ReaderError(f"At most {MAX_TARGETS} papers can be read in one pass.")
    papers = {p.slug: p for p in store.list_papers()}
    rows: list[dict] = []
    for target in wanted:
        paper = papers.get(target)
        if paper is None or target == slug:
            raise ReaderError(f"'{target}' is not another paper in this project.")
        if not paper.retrieved:
            raise ReaderError(f"“{paper.title}” has no cached text yet — open it once to fetch it.")
        rows.append({"slug": target, "title": paper.title, "status": "queued", "error": None})
    account = _account(slug, thread_id, assistant_index)
    reader = reader_fn or read_with_model

    def work(job: ReaderJob) -> None:
        with sessions.thread_scope(job.thread_id):
            _run(job, account, reader, turn_runner)

    return _registry.start_or_join(
        _key(slug, thread_id),
        lambda: ReaderJob(id=new_id(), slug=slug, thread_id=thread_id,
                          assistant_index=assistant_index, targets=rows,
                          delivery_mode=delivery_mode),
        work,
        join_unfinished=True,
    )


def _set(job: ReaderJob, index: int, status: str, error: str | None = None) -> None:
    with _registry.lock:
        job.targets[index]["status"] = status
        job.targets[index]["error"] = error
        job.current = job.targets[index]["slug"] if status == "reading" else None


def _run(job: ReaderJob, account: str, reader, turn_runner) -> None:
    briefs: list[dict] = []
    last_error = ""
    refusal: Exception | None = None
    for index in range(len(job.targets)):
        if _registry.is_cancelled(job):
            break
        row = job.targets[index]
        _set(job, index, "reading")
        try:
            # Per paper, not per pass (see the module docstring): the account is checked against
            # what the NEXT paper costs, and a pass a reader can partly afford is partly done.
            with spend_ceiling.per_unit("paper_read", job.id, model=READER_MODEL):
                text = reader(row["slug"], account, job.slug)
        except quotas.QuotaError as exc:
            # Out of budget, or the ledger is unreachable (fails closed by design). Stop rather
            # than refusing each remaining paper in turn; leave them `skipped` so the client can
            # say which were never attempted, and carry the structured refusal (DR-049).
            last_error = str(exc)[:200]
            refusal = exc
            _set(job, index, "skipped", last_error)
            with _registry.lock:
                job.stopped_reason = last_error
                job.refusal = exc.refusal_payload()
                for later in job.targets[index + 1:]:
                    later["status"] = "skipped"
            log.info("reader pass stopped at %s: %s", row["slug"], last_error)
            break
        except Exception as exc:  # noqa: BLE001 — one paper's failure must not end the pass
            last_error = str(exc)[:200] or type(exc).__name__
            _set(job, index, "error", last_error)
            log.warning("reader failed for %s (chat=%s): %s", row["slug"], job.id[:8], last_error)
            continue
        text = (text or "").strip()
        if not text:
            _set(job, index, "error", "The model returned an empty brief.")
            last_error = "empty brief"
            continue
        if len(text) > MAX_BRIEF_CHARS:
            text = text[:MAX_BRIEF_CHARS].rstrip() + "\n\n[...truncated...]"
        brief = {"slug": row["slug"], "title": row["title"], "text": text}
        briefs.append(brief)
        with _registry.lock:
            job.briefs.append(dict(brief))
        _set(job, index, "done")
    if not briefs:
        if refusal is not None:
            # The registry stamps the refusal centrally when a worker fails with it — the same
            # payload the HTTP admission would have answered.
            raise refusal
        if _registry.is_cancelled(job):
            return
        raise ReaderError(
            "None of the papers could be read"
            + (f": {last_error}" if last_error else ".")
        )
    # The briefs become a turn. Same locks as every route that records a user message. If the
    # reader sent a reply while the assistants read, its turn is generating now: recording into
    # a generating conversation would interleave a user message with the response being
    # written, so WAIT for it (outside the locks) and deliver the briefs after it — never refuse
    # and discard paid work (Opus review of #492).
    deadline = time.monotonic() + WAIT_FOR_TURN_S
    while True:
        with sessions.paper_lock(job.slug), sessions.mutation_lock(job.slug):
            if not chat_jobs.active_for(job.slug, job.thread_id):
                with _registry.lock:
                    job.waiting = False
                # The same gate `start_reading` applies, re-checked now: a Finish sent while
                # the assistants read leaves a proposal as the tail, and a briefing behind it
                # would strand the draft in the model's history. The briefs stay on the job.
                if sessions.get_state(job.slug) != IN_DISCUSSION:
                    raise ReaderError("The notes were drafted while the papers were being read; "
                                      "the briefs are kept on this pass.")
                _deliver(job, briefs, turn_runner)
                return
        if time.monotonic() > deadline:
            raise ReaderError("A response kept generating for too long after the papers were "
                              "read; the briefs are kept on this pass.")
        with _registry.lock:
            job.waiting = True
        time.sleep(WAIT_POLL_S)


def _deliver(job: ReaderJob, briefs: list[dict], turn_runner) -> None:
    """Record the briefing turn and chain the analyst's follow-up. Caller holds the paper and
    mutation locks and has just confirmed no turn is generating in this conversation."""
    sessions.record_briefing(job.slug, briefing_text(briefs), briefs)
    try:
        # A continuation of the pass the reader was admitted for (`metered=False`, like the
        # auto-analysis after a retrieval); its analysis spend is still held by the turn.
        chat = chat_jobs.start_turn(
            job.slug, runner=turn_runner, delivery_mode=job.delivery_mode,
            thread_id=job.thread_id, metered=False,
        )
    except (quotas.QuotaError, rate_limits.RateLimited) as exc:
        with _registry.lock:
            job.analysis_error = str(exc)[:240]
            job.analysis_refusal = exc.refusal_payload()
        return
    except Exception as exc:  # noqa: BLE001 — the briefs are recorded; the retry exists
        with _registry.lock:
            job.analysis_error = str(exc)[:240]
        log.warning("reader briefs recorded but the follow-up turn did not start "
                    "(slug=%s): %s", job.slug, str(exc)[:200])
        return
    with _registry.lock:
        job.analysis_job_id = chat.id
