"""Lab research (R7.7): which actual research groups stand behind this project's top authors.

Papers rarely name the lab — at best the university; lab identity lives on author homepages
and group websites ("people" pages listing members). So this is an agentic web pass
(web_search + web_fetch in a Pydantic AI loop) per TOP author, on the affordable graph model
(DeepSeek family), run only on explicit user request from the Labs view — it is a paid
multi-call pass, never automatic. Results cache hard in `.state/lab_research.json`, keyed by
author with a fingerprint of (name, affiliation), so re-running only spends on new or
changed authors. "No lab found" is itself a cached, honest finding — not every topic has
concentrated lab structure, and the UI says so rather than inventing one.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
from collections.abc import Callable
from dataclasses import dataclass

from . import (
    config,
    graph,
    graph_store,
    llm,
    logging_config,
    model_provenance,
    operation_limits,
    prompts,
    quotas,
    spend_ceiling,
    store,
)
from .fileio import atomic_write_text
from .jobs import Job, JobRegistry, new_id, now_iso

log = logging_config.get("lab_research")

TOP_AUTHORS = 10
# The contract keeps the JSON flat and on one line, so match within the line — a greedy
# cross-line match would swallow a later RESULT line into invalid JSON.
_RESULT_RE = re.compile(r"RESULT:\s*(\{[^\n]*\})")

# research_fn(author_name, affiliation, paper_titles) -> parsed finding dict. Injectable for
# tests; the default runs the web agent below.
ResearchFn = Callable[[str, str, list[str]], dict]


@dataclass
class LabsJob(Job):
    total: int = 0
    done: int = 0
    current: str = ""
    found: int = 0
    skipped_cached: int = 0
    #: Set when the pass stopped early for a reason that is NOT "we looked and found nothing" —
    #: today, the account running out of budget mid-pass. Without it a refused pass reported
    #: `done` with zero labs, and the client explained that away as "not every topic concentrates
    #: in labs" — an affirmatively wrong answer to "you are out of credit". `labs_board` says the
    #: same thing in its own docstring: a pass that could not look must never read as having
    #: looked.
    stopped_reason: str = ""


# `metered=True, reserves=False`: rate-limited like any paid job, but it takes NO reservation of
# its own at admission. Every dollar this job spends is spent inside `spend_ceiling.per_unit`, one
# author at a time.
#
# The two are separate questions and were briefly answered as one. A nominal ticket plus a per-unit
# hold means a reader with $0.06 left is admitted on a $0.04 ticket and then cannot afford the
# $0.04 author — refused despite having the money for it, and told so only after the job started.
# Worse on a crash: both reservations are dispatched, neither `finally` runs, and the reconciler
# conservatively charges both, so one author costs the ledger $0.08 for one $0.04 request. An
# admission ticket that authorizes no provider dispatch should not occupy the spend ledger at all.
_registry: JobRegistry[LabsJob] = JobRegistry("lab-research", max_finished=10, metered=True,
                                        operation="lab_research", reserves=False)
_jobs = _registry.jobs


def snapshot(job_id: str) -> dict | None:
    return _registry.snapshot(job_id)


def active() -> LabsJob | None:
    return _registry.active_for("labs")


def _cache_path():
    return config.state_dir() / "lab_research.json"


def load_cache() -> dict:
    p = _cache_path()
    if p.exists():
        try:
            return json.loads(p.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def _save_cache(cache: dict) -> None:
    atomic_write_text(_cache_path(), json.dumps(cache, indent=2))


def _fingerprint(name: str, affiliation: str) -> str:
    return hashlib.sha1(f"{name}|{affiliation}".encode()).hexdigest()[:16]


def _board() -> list[dict]:
    data = graph_store.load()
    g = graph.overlay_membership(data.get("graph"), store.list_papers())
    return graph.author_board(g, data.get("openalex"), data.get("llm_affiliations"))


def parse_result(output: str) -> dict:
    """The agent's contract is a final `RESULT: {json}` line; parse it tolerantly (the model
    may narrate around it). Anything unparseable is an honest not-found."""
    parsed = None
    for m in _RESULT_RE.finditer(output or ""):
        # Keep the LAST parseable RESULT line — earlier ones may be the model thinking aloud.
        try:
            candidate = json.loads(m.group(1))
        except json.JSONDecodeError:
            continue
        parsed = candidate
    if parsed is None:
        return {"found": False}
    if not isinstance(parsed, dict) or not parsed.get("found"):
        return {"found": False}
    if not str(parsed.get("lab_name") or "").strip():
        return {"found": False}
    return {
        "found": True,
        "lab_name": str(parsed.get("lab_name"))[:120],
        "institution": str(parsed.get("institution") or "")[:120],
        "url": str(parsed.get("url") or "")[:400],
        "focus": str(parsed.get("focus") or "")[:300],
        "evidence": str(parsed.get("evidence") or "")[:300],
    }


# Hard caps per author run: the prompt budgets 3 searches + 3 fetches, but a prompt is not an
# enforcement mechanism — a model that ignores it (or follows instructions embedded in
# fetched pages) must hit a wall, not spend unboundedly. request_limit bounds model requests;
# tool_calls_limit bounds tool executions even when one response batches many calls.
MAX_AGENT_REQUESTS = 10
MAX_AGENT_TOOL_CALLS = 8

#: The output ceiling for one research run, as a NUMBER rather than a `UsageLimits` instance:
#: `pydantic_ai` is imported lazily here because it is heavyweight and tests inject a fake, so the
#: object cannot be built at module scope. The number can, which is what makes it assertable —
#: built purely inline, reverting this bound left the whole suite green, the same gap this round
#: closed one file over. Rounds and tool calls were already bounded; output size was not.
_OUTPUT_TOKENS_LIMIT = operation_limits.run_output_ceiling("lab_research", MAX_AGENT_REQUESTS)



def _research_with_agent(name: str, affiliation: str, titles: list[str]) -> dict:
    # Imported lazily: pydantic_ai is heavyweight and tests inject research_fn instead.
    from pydantic_ai import Agent, capture_run_messages
    from pydantic_ai.usage import RunUsage, UsageLimits

    from . import agent_harness, research_tools

    def web_search(objective: str, search_queries: list[str]) -> str:
        """Search the web. objective = what you're establishing; search_queries = 1-3 short
        keyword queries. Returns results with URLs."""
        return research_tools.web_search(objective, search_queries[:3])

    def web_fetch(urls: list[str], objective: str) -> str:
        """Fetch up to 3 pages (author homepage, group/people pages) and return their text."""
        return research_tools.web_fetch(urls[:3], objective)

    paper_lines = "\n".join(f"- {t}" for t in titles[:8])
    model = graph.resolve_model()
    user = model_provenance.frame(
        "author_and_paper_metadata",
        f"Author: {name}\nAffiliation (from paper metadata, may be broad): "
        f"{affiliation or 'unknown'}\nTheir papers in this project:\n{paper_lines}",
    )

    def _run_once(*, no_reasoning: bool) -> str:
        ag = Agent(
            agent_harness._openrouter_model(model, operation="lab_research",
                                            no_reasoning=no_reasoning),
            system_prompt=(prompts.get("lab_research")
                           + "\n\n" + model_provenance.SYSTEM_POLICY),
            tools=[web_search, web_fetch],
            output_type=str,
            retries=2,
        )
        # A paid multi-request run outside `app.llm`. Recorded through the harness's own recorder
        # rather than a second accounting path: it already extracts OpenRouter's authoritative
        # cost from each response's provider details, records the generations individually so an
        # interrupted one stays reconcilable, and falls back to a pending marker per response.
        #
        # `capture_run_messages` + `finally`, because the run that fails is the EXPENSIVE one. The
        # caller treats a blown request budget as an honest not-found, which concedes it is
        # ordinary — and it is reached only after ten requests have been billed. Recording from
        # `result` alone meant the cheapest authors were metered and the priciest settled at zero,
        # now against this author's own hold. Same reasoning as `stream_hunt` and the analysis
        # loop.
        run_usage = RunUsage()
        with capture_run_messages() as captured:
            try:
                result = asyncio.run(
                    ag.run(user, usage_limits=UsageLimits(
                        request_limit=MAX_AGENT_REQUESTS,
                        tool_calls_limit=MAX_AGENT_TOOL_CALLS,
                        output_tokens_limit=_OUTPUT_TOKENS_LIMIT,
                    ), usage=run_usage),
                )
                # A PROPERTY, not a method, since pydantic-ai 2.x. Calling it raised TypeError
                # INSIDE this try, which the handler below turned into "the model provider could
                # not complete lab research" — so every author in every labs pass failed after the
                # run had been paid for. That is why the Labs view had nothing to show (DR-008).
                return result.output or ""
            finally:
                agent_harness.record_agent_run(run_usage, ag.model, "lab_research", captured)

    try:
        try:
            output = _run_once(no_reasoning=True)
        except Exception as exc:  # noqa: BLE001 — classified below, then re-raised or retried
            # Mirror `llm.complete`'s contract: disabling reasoning is an optimization, never a
            # requirement, and the graph model is an operator override (`RC_GRAPH_LLM_MODEL`)
            # that could name a reasoning-mandatory model. Without this retry every author in
            # every labs pass would fail with a scrubbed message and no in-app remedy.
            chain = f"{exc} {exc.__cause__ or ''}"
            if not llm._rejected_for_reasoning(chain):
                raise
            log.info("labs run retrying without the reasoning hint (model=%s)", model)
            output = _run_once(no_reasoning=False)
    except Exception as exc:
        # A blown request budget (or any run crash) is an honest not-found for THIS run,
        # cached without a fingerprint upstream so the author retries next pass.
        raise RuntimeError(
            "The model provider could not complete lab research.") from exc
    return parse_result(output)


def start_research(research_fn: ResearchFn = _research_with_agent) -> LabsJob:
    """Start (or join) the labs pass over the project's top authors. Cached authors are
    skipped (their fingerprint still matches); the rest each get one agentic web pass."""
    board = _board()
    if not board:
        raise ValueError("No author board yet — build the map first.")
    top = board[:TOP_AUTHORS]

    def work(job: LabsJob) -> None:
        cache = load_cache()
        with _registry.lock:
            job.total = len(top)
        attempted = 0
        failed = 0
        found_this_pass = 0
        last_error = ""
        for entry in top:
            if _registry.is_cancelled(job):
                return
            name = entry["name"]
            key = graph._author_key(name)
            fp = _fingerprint(name, entry.get("affiliation") or "")
            record = cache.get(key)
            if isinstance(record, dict) and record.get("fingerprint") == fp:
                with _registry.lock:
                    job.done += 1
                    job.skipped_cached += 1
                    if record.get("found"):
                        job.found += 1
                continue
            with _registry.lock:
                job.current = name
            titles = [p.get("title") or "" for p in entry.get("papers") or []
                      if p.get("kind") == "project"]
            try:
                # Each author is its own agentic web pass, so each takes its own hold. The job's
                # admission ticket is nominal: one `lab_research` hold covering ten passes
                # under-reserved by ten, and a reader admitted with $0.05 of headroom went on to
                # spend $0.40. Gating here also means someone who can afford three authors gets
                # three, instead of being refused a pass they could partly pay for.
                with spend_ceiling.per_unit("lab_research", job.id, model=graph.resolve_model()):
                    # Counted only once the hold is granted. Counting before it meant a refused
                    # author scored as attempted-but-not-failed, diluting the `failed == attempted`
                    # check below — one real error followed by refusals reported `done`.
                    attempted += 1
                    finding = research_fn(name, entry.get("affiliation") or "", titles)
            except quotas.QuotaError as exc:
                # Out of budget, or the ledger is unreachable. Either way this pass cannot
                # continue: stop rather than grinding through the remaining authors to refuse each
                # one in turn, and leave no fingerprint so they retry once budget returns.
                #
                # Both branches of QuotaError, not just QuotaExceeded — an unreachable ledger fails
                # closed by design, and letting it fall through to the generic handler would cache
                # every remaining author as a not-found result for a lookup that never happened.
                last_error = str(exc)[:200]
                log.info("labs pass stopped at %s: %s", name, last_error)
                with _registry.lock:
                    job.stopped_reason = last_error
                    # DR-049: the stop is a refusal even when the pass keeps `done` (it found
                    # labs before the money ran out), so the structured payload rides the job
                    # regardless of final status — the registry's central stamp only covers a
                    # refusal that FAILS the worker.
                    job.refusal = exc.refusal_payload()
                    job.current = ""  # it was never researched; leaving it named implies it was
                break
            except Exception as exc:  # noqa: BLE001 — one author's failure must not kill
                # the pass; an error is cached as not-found WITHOUT a fingerprint, so the
                # next run retries this author.
                failed += 1
                last_error = str(exc)[:200]
                cache[key] = {"found": False, "error": last_error, "name": name,
                              "researched_at": now_iso()}
                _save_cache(cache)
                with _registry.lock:
                    job.done += 1
                    job.current = ""
                continue
            cache[key] = {
                **finding, "name": name, "fingerprint": fp, "researched_at": now_iso(),
            }
            _save_cache(cache)  # per-author persist: an interrupted pass keeps its findings
            with _registry.lock:
                job.done += 1
                job.current = ""
                if finding.get("found"):
                    job.found += 1
                    found_this_pass += 1
        # Per-author isolation is for PARTIAL failure. When every attempted author failed
        # (missing API key, provider down), the pass accomplished nothing — surface that as a
        # job error instead of letting the client read "researched, no labs found".
        # Refusal first: one genuine per-author failure followed by a quota refusal satisfies
        # `failed == attempted` too, and took that branch — reporting "Lab research failed for
        # every author — you have used your monthly allowance", which frames a budget limit as a
        # provider outage. The refusal is the more specific and more actionable fact.
        if job.stopped_reason and not found_this_pass:
            # Stopped before finding anything. Reported as an error rather than a quiet `done`,
            # because `done` with zero labs is the one state the client explains as "not every
            # topic concentrates in labs" — telling a reader their field has no labs when in fact
            # we never looked. A partial pass that DID find labs keeps `done` and shows them,
            # carrying `stopped_reason` so the client can say the rest is unfinished.
            #
            # `found_this_pass`, NOT `job.found`: the latter counts cache hits from EARLIER passes
            # too, so a refused pass over an already-mapped author reported `done — 1 of 2 mapped`
            # having researched nobody, and re-running produced the same cheerful nothing forever.
            with _registry.lock:
                _registry.set_outcome_locked(job, "error", error=job.stopped_reason)
        elif attempted and failed == attempted:
            with _registry.lock:
                _registry.set_outcome_locked(
                    job,
                    "error",
                    error=f"Lab research failed for every author — {last_error}",
                )

    return _registry.start_or_join("labs", lambda: LabsJob(id=new_id()), work)


def labs_board(board: list[dict]) -> dict:
    """Group the author board under researched labs. Returns {labs: [...], researched: bool,
    researched_at}: each lab card carries its member authors (board entries by name) and
    aggregate counts; authors without a finding stay on the plain affiliation grouping the
    client already renders."""
    cache = load_cache()
    labs: dict[str, dict] = {}
    covered: set[str] = set()
    researched_at = None
    for entry in board:
        key = graph._author_key(entry["name"])
        rec = cache.get(key)
        if not isinstance(rec, dict):
            continue
        researched_at = max(researched_at or "", rec.get("researched_at") or "")
        if not rec.get("found"):
            continue
        lab_key = (rec.get("lab_name") or "").casefold()
        lab = labs.setdefault(lab_key, {
            "lab_name": rec.get("lab_name"), "institution": rec.get("institution"),
            "url": rec.get("url"), "focus": rec.get("focus"),
            "members": [], "in_project_count": 0, "significant_count": 0,
        })
        lab["members"].append(entry["name"])
        lab["in_project_count"] += entry.get("in_project_count") or 0
        lab["significant_count"] += entry.get("significant_count") or 0
        covered.add(entry["name"])
    ranked = sorted(labs.values(),
                    key=lambda lab: (-lab["in_project_count"], -len(lab["members"])))
    return {
        "labs": ranked,
        "covered_authors": sorted(covered),
        # Only fingerprinted records count as research — error entries (no fingerprint) must
        # not make the client claim "researched, nothing found".
        "researched": any(
            isinstance(rec, dict) and rec.get("fingerprint") for rec in cache.values()
        ),
        "researched_at": researched_at,
    }
