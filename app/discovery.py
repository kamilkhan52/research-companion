"""Discovery: bootstrap a project's reading list from the researcher's goals.

The researcher describes what they want to understand, learn, or explore; this pipeline
turns that into ranked suggested readings from arXiv:

  1. One LLM call (the graph-extraction model — cheap-bulk work, see graph.resolve_model)
     turns the goals paragraph into 4-6 arXiv queries, mixing broad phases (the general
     area, so foundational/survey work surfaces) with narrow ones (specific sub-topics).
  2. Paced arXiv relevance searches (retriever.search_arxiv_raw) collect up to 50 unique
     candidate papers across those queries.
  3. One Semantic Scholar batch adds global citation counts (arXiv gives none) — the same
     enrichment the reference graph uses; best-effort, never fails the run.
  4. One LLM call scores every candidate's relevance to the goals from title + abstract,
     and a blended score (relevance-dominant, log-scaled citation term capped like
     graph.score_recommendations) ranks them.

The FULL ranked list is persisted per project (.state/discovery.json); the UI shows the top
suggestions and can expand to the rest. run_discovery is a generator of progress events —
run it through app/discovery_jobs.py, never inside a request (a run takes minutes: arXiv
pacing alone is ~3s per query). All network seams (search_fn, llm_fn, citations_fn) are
injectable so tests drive the whole pipeline with zero network calls.

TODO: add non-arXiv candidate sources (Semantic Scholar / OpenAlex search) behind the
search_fn seam — arXiv-only search misses ISCA/MICRO/OSDI-only landmark papers, which
skews the ranking for architecture/systems topics (observed on the 3D-DRAM project).
"""
from __future__ import annotations

import json
import math
import re
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from pathlib import Path

import httpx

from . import citations, config, graph, prompts, retriever

MAX_QUERIES = 6
PER_QUERY_RESULTS = 25
MAX_CANDIDATES = 50
TOP_SUGGESTIONS = 5           # how many the UI leads with; the rest sit behind "show more"
ABSTRACT_CHARS_FOR_SCORING = 1200
# Query generation emits a tiny JSON object; scoring emits ~50 small ones. Both budgets leave
# generous room for the reasoning tokens DeepSeek-class models spend before the content
# (see the EXTRACTION_MAX_TOKENS note in app/graph.py).
QUERIES_MAX_TOKENS = 8_000
SCORING_MAX_TOKENS = 24_000
LLM_TIMEOUT_S = 240

# Blend weights: LLM relevance (0-10) dominates; global citations add at most the weight of
# 4 relevance points, log-scaled so landmark status helps but raw fame can't outrank fit.
CITATION_TERM_CAP = 4.0
CITATION_TERM_SCALE = 1.0  # * log10(1 + citations)

SearchFn = Callable[[str, int], list[dict]]
LlmFn = Callable[[str, str, str, int], str]           # (model, system, user, max_tokens) -> content
CitationsFn = Callable[[list[dict], dict], None]      # annotate_nodes-compatible


class DiscoveryError(Exception):
    pass


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


# ---------- persistence (per project, survives restarts) ----------

def _result_path() -> Path:
    return config.state_dir() / "discovery.json"


def load_result() -> dict | None:
    p = _result_path()
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def save_result(result: dict) -> None:
    _result_path().write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")


# ---------- LLM plumbing ----------

def _default_llm(model: str, system: str, user: str, max_tokens: int) -> str:
    """One OpenRouter chat call, returning the raw content string. Raises DiscoveryError on
    anything unusable — unlike graph extraction there is no per-paper isolation to preserve;
    if a step fails the whole run fails and the job surfaces the error."""
    key = config.load_settings().get("openrouter_api_key")
    if not key:
        raise DiscoveryError("No OpenRouter API key set. Open Settings.")
    headers = {"Authorization": f"Bearer {key}", "HTTP-Referer": "http://localhost",
               "X-Title": config.APP_TITLE}
    body = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": 0.1,
        "max_tokens": max_tokens,
        "reasoning": {"effort": "low"},
    }
    try:
        r = httpx.post(f"{config.OPENROUTER_BASE}/chat/completions",
                       headers=headers, json=body, timeout=LLM_TIMEOUT_S)
    except httpx.HTTPError as e:
        raise DiscoveryError(f"OpenRouter request failed: {e}"[:300]) from e
    if r.status_code != 200:
        raise DiscoveryError(f"OpenRouter error {r.status_code}: {r.text[:200]}")
    try:
        choice = r.json()["choices"][0]
        content = (choice.get("message") or {}).get("content")
        if isinstance(content, list):
            content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
    except (KeyError, IndexError, TypeError, ValueError) as e:
        raise DiscoveryError(f"Malformed OpenRouter response: {e}") from e
    if not content or not str(content).strip():
        raise DiscoveryError(f"Empty model response (finish_reason="
                             f"{choice.get('finish_reason')}). Try again.")
    return str(content)


def _parse_json(content: str) -> dict:
    """Same fence/chatter tolerance as graph._extract_json, with a local error type."""
    content = content.strip()
    content = re.sub(r"^```(?:json)?\s*", "", content)
    content = re.sub(r"\s*```$", "", content)
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        pass
    m = re.search(r"\{.*\}", content, re.S)
    if m:
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            pass
    raise DiscoveryError("The model did not return valid JSON.")


# ---------- pipeline steps (each independently testable) ----------

def generate_queries(goals: str, model: str, llm_fn: LlmFn) -> tuple[str, list[dict]]:
    """Goals paragraph -> (focus line, [{query, phase, rationale}, ...]), capped."""
    parsed = _parse_json(llm_fn(model, prompts.get("discover_queries"), goals,
                                QUERIES_MAX_TOKENS))
    raw = parsed.get("queries")
    if not isinstance(raw, list):
        raise DiscoveryError("The model's query plan had no 'queries' list.")
    queries = []
    for q in raw:
        text = str((q or {}).get("query") or "").strip() if isinstance(q, dict) else str(q).strip()
        if not text:
            continue
        phase = (q.get("phase") if isinstance(q, dict) else "") or ""
        rationale = (q.get("rationale") if isinstance(q, dict) else "") or ""
        queries.append({"query": text, "phase": str(phase).strip() or "narrow",
                        "rationale": str(rationale).strip()})
        if len(queries) >= MAX_QUERIES:
            break
    if not queries:
        raise DiscoveryError("The model produced no usable search queries.")
    return str(parsed.get("focus") or "").strip(), queries


def collect_candidates(queries: list[dict], search_fn: SearchFn) -> Iterator[dict]:
    """Run each query, yielding a progress event after each; the final event carries the
    deduped candidate list (unique by versionless arXiv id, first hit wins, capped)."""
    seen: dict[str, dict] = {}
    errors = 0
    for i, q in enumerate(queries):
        try:
            results = search_fn(q["query"], PER_QUERY_RESULTS)
        except retriever.RetrievalError:
            results, errors = [], errors + 1  # one throttled query shouldn't sink the run
        for cand in results:
            aid = cand.get("arxiv_id")
            if aid and aid not in seen and len(seen) < MAX_CANDIDATES:
                seen[aid] = cand
        yield {"type": "search", "query": q["query"], "index": i + 1,
               "total": len(queries), "found": len(seen)}
        if len(seen) >= MAX_CANDIDATES:
            break
    if not seen:
        raise DiscoveryError(
            "No arXiv results for any query." + (
                " arXiv rate-limited some searches — wait a minute and try again."
                if errors else " Try rephrasing the goals with more specific terms."))
    yield {"type": "candidates", "candidates": list(seen.values())}


def add_citation_counts(candidates: list[dict], citations_fn: CitationsFn) -> None:
    """Best-effort Semantic Scholar counts. Every candidate has an arXiv id, so one batch
    POST covers them all (citations.annotate_nodes never raises)."""
    nodes = [{"id": c["arxiv_id"], "arxiv_id": c["arxiv_id"], "kind": "external",
              "title": c.get("title", "")} for c in candidates]
    cache: dict = {}
    citations_fn(nodes, cache)
    counts = {n["id"]: n.get("citation_count") for n in nodes}
    for c in candidates:
        c["citation_count"] = counts.get(c["arxiv_id"])


def score_candidates(goals: str, candidates: list[dict], model: str, llm_fn: LlmFn) -> list[dict]:
    """One LLM call scores every candidate; blend with the citation term and rank. Returns
    the FULL ranked list — the UI leads with TOP_SUGGESTIONS and offers the rest."""
    numbered = "\n\n".join(
        f"{i}. {c['title']}\n{(c.get('abstract') or '')[:ABSTRACT_CHARS_FOR_SCORING]}"
        for i, c in enumerate(candidates, 1))
    user = (f"Researcher's goals for the project:\n\n{goals}\n\n"
            f"Candidate papers ({len(candidates)}):\n\n{numbered}")
    parsed = _parse_json(llm_fn(model, prompts.get("discover_scoring"), user,
                                SCORING_MAX_TOKENS))
    rows = parsed.get("scores")
    if not isinstance(rows, list) or not rows:
        raise DiscoveryError("The model's scoring response had no 'scores' list.")
    by_index: dict[int, dict] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        try:
            idx = int(row.get("index"))
            rel = max(0.0, min(10.0, float(row.get("relevance"))))
        except (TypeError, ValueError):
            continue
        by_index[idx] = {"relevance": rel, "reason": str(row.get("reason") or "").strip()}

    out = []
    for i, c in enumerate(candidates, 1):
        s = by_index.get(i, {"relevance": 0.0, "reason": ""})  # unscored -> ranked last
        cites = c.get("citation_count") or 0
        citation_term = min(CITATION_TERM_CAP, CITATION_TERM_SCALE * math.log10(1 + cites))
        reasons = [s["reason"]] if s["reason"] else []
        if cites >= 100:
            reasons.append(f"~{cites:,} citations overall — a well-established work")
        out.append({**c, "relevance": s["relevance"],
                    "score": round(s["relevance"] + citation_term, 3),
                    "reasons": reasons})
    out.sort(key=lambda c: (c["score"], c.get("citation_count") or 0), reverse=True)
    return out


# ---------- the full run (generator of progress events; drive via discovery_jobs) ----------

def run_discovery(goals: str, *, model: str | None = None, search_fn: SearchFn | None = None,
                  llm_fn: LlmFn | None = None,
                  citations_fn: CitationsFn | None = None) -> Iterator[dict]:
    """Yields progress events:
      {"type": "queries", "focus", "queries"}          after query generation
      {"type": "search", "query", "index", "total", "found"}   per arXiv query
      {"type": "citations", "count"}                   entering citation enrichment
      {"type": "scoring", "count"}                     entering LLM scoring
      {"type": "done", "result"}                       the persisted-shape result
    Raises DiscoveryError for anything that ends the run (the job turns it into status=error).
    Does NOT persist — the caller (the job, holding the project context) saves the result."""
    goals = (goals or "").strip()
    if not goals:
        raise DiscoveryError("Describe the project's goals first.")
    model = model or graph.resolve_model()
    search_fn = search_fn or retriever.search_arxiv_raw
    llm_fn = llm_fn or _default_llm
    citations_fn = citations_fn or citations.annotate_nodes

    focus, queries = generate_queries(goals, model, llm_fn)
    yield {"type": "queries", "focus": focus, "queries": queries}

    candidates: list[dict] = []
    for event in collect_candidates(queries, search_fn):
        if event["type"] == "candidates":
            candidates = event["candidates"]
        else:
            yield event

    yield {"type": "citations", "count": len(candidates)}
    add_citation_counts(candidates, citations_fn)

    yield {"type": "scoring", "count": len(candidates)}
    ranked = score_candidates(goals, candidates, model, llm_fn)

    yield {"type": "done", "result": {
        "goals": goals,
        "focus": focus,
        "model": model,
        "queries": queries,
        "candidate_count": len(ranked),
        "top_n": TOP_SUGGESTIONS,
        "suggestions": ranked,
        "generated_at": _now(),
    }}
