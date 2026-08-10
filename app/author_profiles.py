"""One-paragraph LLM author profiles for the Authors board (R7.6).

An LLM call means a background job + polling (invariant 1): the client POSTs a job for one
author and polls its snapshot. Profiles are cached per author in the project's
`.state/author_profiles.json`, keyed by the author-name key with a fingerprint of the inputs
(the author's papers + the project goals) so a materially changed project regenerates while
an unchanged one serves the cache instantly.

Context in is deliberately generous (project brief, goals, the author's in-project papers
with abstracts, their referenced works, affiliation, co-authors — models have the window);
output is one brief grounded paragraph (see the `author_profile` prompt).
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass

from . import config, graph, graph_store, llm, projects, prompts, store
from .fileio import atomic_write_text
from .jobs import Job, JobRegistry, new_id, now_iso

MAX_REFERENCED_WORKS = 30
MAX_ABSTRACT_CHARS = 900


@dataclass
class ProfileJob(Job):
    author: str = ""
    profile: str = ""
    cached: bool = False
    #: "context" while the corpus context is assembled, "writing" once the model call is in
    #: flight — so the client can show staged progress instead of a spinner that moves only at
    #: the end (DR-047).
    stage: str = ""


#: A short grounded profile. Named so `operation_limits` binds to it.
PROFILE_MAX_TOKENS = 600

_registry: JobRegistry[ProfileJob] = JobRegistry("author-profile", max_finished=30, metered=True,
                                          operation="author_profile")
_jobs = _registry.jobs


def snapshot(job_id: str) -> dict | None:
    return _registry.snapshot(job_id)


def _cache_path():
    return config.state_dir() / "author_profiles.json"


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


def profiles_for_board(board: list[dict]) -> dict[str, str]:
    """CURRENT cached profile text per author key, for the board's read-time merge. A record
    whose fingerprint no longer matches the entry's inputs (papers/affiliation/goals changed)
    is withheld — the client then shows Generate again instead of a stale paragraph, and
    start_profile regenerates on the same mismatch."""
    cache = load_cache()
    _pname, goals = _project_brief()
    out: dict[str, str] = {}
    for entry in board:
        key = graph._author_key(entry["name"])
        rec = cache.get(key)
        if (isinstance(rec, dict) and rec.get("profile")
                and rec.get("fingerprint") == _fingerprint(entry, goals)):
            out[key] = rec["profile"]
    return out


def _board_entry(name: str) -> dict | None:
    data = graph_store.load()
    g = graph.overlay_membership(data.get("graph"), store.list_papers())
    board = graph.author_board(g, data.get("openalex"), data.get("llm_affiliations"))
    key = graph._author_key(name)
    return next((e for e in board if graph._author_key(e["name"]) == key), None)


def _fingerprint(entry: dict, goals: str) -> str:
    basis = json.dumps({
        "papers": sorted(p.get("title") or "" for p in entry.get("papers") or []),
        "affiliation": entry.get("affiliation") or "",
        "goals": goals,
    }, sort_keys=True)
    return hashlib.sha1(basis.encode()).hexdigest()[:16]


def _project_brief() -> tuple[str, str]:
    pid = config.active_project_id()
    meta = projects._read_meta(pid) if pid else {}
    return meta.get("name") or (pid or "this project"), (meta.get("goals") or "").strip()


def _build_context(entry: dict, project_name: str, goals: str) -> str:
    papers = store.list_papers()
    lines: list[str] = [f"# Project: {project_name}"]
    if goals:
        lines += ["", "## Research goals", goals]
    lines += ["", "## Reading list (title · group · status)"]
    lines += [f"- {p.title} · {p.group} · {p.list_status}" for p in papers[:60]]

    lines += ["", f"## Author: {entry['name']}"]
    if entry.get("affiliation"):
        lines.append(f"Affiliation (from paper metadata): {entry['affiliation']}")
    years = entry.get("active_years")
    if years:
        lines.append(f"Active years in this corpus: {years[0]}–{years[1]}")

    def paper_line(p: dict) -> str:
        year = p.get("year")
        return f"- {p.get('title')} ({year})" if year else f"- {p.get('title')}"

    lines += ["", "### Their papers IN the project"]
    for p in entry.get("papers") or []:
        if p.get("kind") != "project":
            continue
        lines.append(paper_line(p))
        abstract = (store.abstract_for(p.get("slug") or "") or "").strip()
        if abstract:
            lines.append(f"  Abstract: {abstract[:MAX_ABSTRACT_CHARS]}")

    referenced = [p for p in entry.get("papers") or [] if p.get("kind") == "external"]
    if referenced:
        lines += ["", "### Their works the project's papers CITE"]
        lines += [paper_line(p) for p in referenced[:MAX_REFERENCED_WORKS]]
    return "\n".join(lines)


def start_profile(name: str) -> ProfileJob:
    """Start (or join) profile generation for one board author; serves the cache instantly
    when the inputs haven't changed."""
    entry = _board_entry(name)
    if entry is None:
        raise ValueError(f"Unknown board author: {name}")
    key = graph._author_key(name)
    _pname, goals = _project_brief()
    fp = _fingerprint(entry, goals)
    cached = load_cache().get(key)
    if isinstance(cached, dict) and cached.get("fingerprint") == fp and cached.get("profile"):
        return _registry.put(key, ProfileJob(
            id=new_id(), author=entry["name"], profile=cached["profile"], cached=True,
            status="done", finished_at=now_iso(),
        ))

    def work(job: ProfileJob) -> None:
        with _registry.lock:
            job.stage = "context"
        project_name, goals_now = _project_brief()
        context = _build_context(entry, project_name, goals_now)
        model = graph.resolve_model()
        with _registry.lock:
            job.stage = "writing"
        # Reasoning OFF: a profile is a short grounded rewrite of context we hand the model, not
        # a problem to think about — and the default graph model is a reasoning model that spent
        # the whole 600-token budget on hidden reasoning and emitted nothing (DR-047, the same
        # failure narration hit on 2026-07-30). `complete()` drops the hint and retries once if
        # the chosen model cannot accept it.
        text = llm.complete(
            [
                {"role": "system", "content": prompts.get("author_profile")},
                {"role": "user", "content": context},
            ],
            model=model,
            max_tokens=PROFILE_MAX_TOKENS,
            reasoning=llm.no_reasoning_payload(),
            operation="author_profile",
        ).strip()
        if not text:
            raise llm.LLMError("The model returned an empty profile.")
        cache = load_cache()
        cache[key] = {
            "profile": text, "fingerprint": fp, "model": model,
            "generated_at": now_iso(), "name": entry["name"],
        }
        _save_cache(cache)
        with _registry.lock:
            job.profile = text

    return _registry.start_or_join(key, lambda: ProfileJob(id=new_id(), author=entry["name"]), work)
