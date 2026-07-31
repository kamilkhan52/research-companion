"""Discovery: bootstrap a project's reading list from the researcher's goals.

The researcher describes what they want to understand, learn, or explore; this pipeline
turns that into ranked suggested readings from multiple scholarly sources:

  1. One LLM call produces 4-6 broad+narrow concepts in both arXiv-expression and plain
     scholarly-search forms.
  2. Each concept fans out to arXiv and Semantic Scholar. Reciprocal-rank fusion preserves
     source diversity before the bounded LLM context, so one provider cannot fill the cap first.
  3. The graph's Semantic Scholar citation and OpenAlex paper-authorship enrichment adds
     impact, venue, author, and institution evidence (best-effort).
  4. One LLM call scores relevance and evidence credibility together. Relevance dominates the
     final blend; credibility and globally established impact are capped tie-breakers.

The full ranked list is persisted per project under .state. run_discovery is a progress-event
generator and must be driven through discovery_jobs, never inside a request. Every network seam
is injectable so tests and fixed quality fixtures run without network access.
"""
from __future__ import annotations

import json
import math
import re
import threading
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from pathlib import Path

from . import (
    citations,
    config,
    discovery_batch,
    discovery_gate,
    discovery_ledger,
    discovery_recall,
    graph,
    graph_store,
    llm,
    logging_config,
    openalex,
    prompts,
    retriever,
    semantic_scholar,
    store,
)
from .fileio import atomic_write_text

log = logging_config.get("discovery")

MAX_QUERIES = 6
PER_QUERY_RESULTS = 25
MAX_CANDIDATES = 50
TOP_SUGGESTIONS = 5
ABSTRACT_CHARS_FOR_SCORING = 1200

# ---------- funnel (the library-grounded pipeline) ----------
# Model ids are PINNED, deliberately not resolved through `routers.catalogue.FAVORITE_FAMILIES`.
# That list auto-tracks the newest model in each family, so a new release would silently multiply
# the cost of a stage that runs over thousands of items — and would also change what a cached
# verdict means without changing its cache key. Verified 2026-07-30: v4-flash is $0.14/M in,
# $0.28/M out, passes `llm.PRIVACY_ROUTING`, and reconciles a numbered batch without index drift.
CHEAP_MODEL = "deepseek/deepseek-v4-flash"
TITLE_BATCH_SIZE = 75
ABSTRACT_BATCH_SIZE = 25
TITLE_TRIAGE_MAX_TOKENS = 8_000
ABSTRACT_SCORING_MAX_TOKENS = 8_000
ABSTRACT_CHARS_FOR_SCREENING = 1100
MAX_AFTER_TITLE_TRIAGE = 400
MAX_AFTER_ABSTRACTS = 60

# Grounded channels earn a bounded bonus: evidence tied to THIS project's corpus should outrank a
# generic keyword hit, but it must not swamp relevance — a paper the reader's library cites is not
# automatically worth reading. Same reasoning as the capped citation term below.
PROVENANCE_BONUS_CITES = 1.0
PROVENANCE_BONUS_GRAPH = 0.75
QUERIES_MAX_TOKENS = 8_000
SCORING_MAX_TOKENS = 24_000
LLM_TIMEOUT_S = 240

# Relevance (0-10) dominates. Credibility adds at most two points; the Map-style log citation
# term adds at most 1.5. A famous tangential paper cannot outrank a central reading on fame alone.
CREDIBILITY_TERM_SCALE = 0.5
CITATION_TERM_CAP = 1.5
CITATION_TERM_SCALE = 0.375
RRF_K = 10.0
MIN_PROVIDER_EXCLUSIVE = 8

SearchFn = Callable[[str, int], list[dict]]
LlmFn = Callable[[str, str, str, int], str]
CitationsFn = Callable[[list[dict], dict], None]
AuthorshipsFn = Callable[[list[dict]], None]
CheapLlmFn = Callable[[str, str, int], str]
RecallFn = Callable[[list], tuple[list[dict], dict]]


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
        result = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(result, dict):
            return None
        suggestions = result.get("suggestions")
        if not isinstance(suggestions, list):
            return result
        # Results persisted before R10.11 were arXiv-only and predate candidate_id/source
        # evidence. Upgrade the read shape in memory; the file remains untouched until a new
        # user-requested run, so merely opening Discover has no hidden write side effect.
        for suggestion in suggestions:
            if not isinstance(suggestion, dict):
                continue
            suggestion.setdefault("candidate_id", _candidate_key(suggestion))
            suggestion.setdefault(
                "sources",
                ["arxiv"] if suggestion.get("arxiv_id") else ["semantic_scholar"],
            )
            suggestion.setdefault("affiliations", [])
            suggestion.setdefault("credibility", 0.0)
        result.setdefault("source_counts", {
            provider: sum(
                1 for suggestion in suggestions
                if isinstance(suggestion, dict)
                and provider in suggestion.get("sources", [])
            )
            for provider in ("arxiv", "semantic_scholar")
        })
        return result
    except (json.JSONDecodeError, OSError):
        return None


def save_result(result: dict) -> None:
    atomic_write_text(_result_path(), json.dumps(result, indent=2, ensure_ascii=False))


# ---------- hidden recommendations (R12.3) ----------
# A reader can hide a recommended paper (already read, known under another project, simply not
# interesting) so it stops surfacing. Hidden entries are per-project, persisted under .state/,
# and keyed by the suggestion's deterministic identities (arXiv id, DOI, S2 paper id,
# normalized title) so the same work re-found through a different provider stays hidden.
#
# Matching semantics (sol review, PR #206): a strong identifier match (arxiv/doi/s2) always
# hides; the normalized title is only a FALLBACK — it never bridges two works that carry
# conflicting strong identifiers of the same kind, and degenerate normalizations ("C++" →
# "c") are ignored entirely, so hiding one paper can never hide a different one that merely
# shares a flattened title.

_STRONG_PREFIXES = ("arxiv:", "doi:", "s2:")
_TITLE_KEY_MIN_CHARS = 4

# hide/unhide are read-modify-write over one JSON file; atomic_write_text prevents torn
# files but not lost updates, so the whole transaction serializes per project.
_hidden_locks: dict[str, threading.Lock] = {}
_hidden_locks_guard = threading.Lock()


def _hidden_lock() -> threading.Lock:
    pid = config.active_project_id() or "__default__"
    with _hidden_locks_guard:
        return _hidden_locks.setdefault(pid, threading.Lock())


def _hidden_path() -> Path:
    return config.state_dir() / "discovery-hidden.json"


def _usable_title_keys(keys: set[str]) -> set[str]:
    return {
        k for k in keys
        if k.startswith("title:") and len(k) - len("title:") >= _TITLE_KEY_MIN_CHARS
    }


def _hidden_match(entry_keys: list[str] | None, candidate_keys: list[str]) -> bool:
    """Whether a hidden entry covers a candidate. Strong-id match wins outright; a title
    match only counts when no same-kind strong ids conflict between the two."""
    entry = set(entry_keys or [])
    cand = set(candidate_keys)
    entry_strong = {k for k in entry if k.startswith(_STRONG_PREFIXES)}
    cand_strong = {k for k in cand if k.startswith(_STRONG_PREFIXES)}
    if entry_strong & cand_strong:
        return True
    for prefix in _STRONG_PREFIXES:
        entry_kind = {k for k in entry_strong if k.startswith(prefix)}
        cand_kind = {k for k in cand_strong if k.startswith(prefix)}
        if entry_kind and cand_kind and not (entry_kind & cand_kind):
            return False  # both sides carry this identifier and they disagree
    return bool(_usable_title_keys(entry) & _usable_title_keys(cand))


def load_hidden() -> list[dict]:
    """[{keys, title, hidden_at}] — title retained so a future manage/unhide UI can label
    entries without re-resolving them."""
    try:
        data = json.loads(_hidden_path().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    return [e for e in data if isinstance(e, dict)] if isinstance(data, list) else []


def _save_hidden(entries: list[dict]) -> None:
    atomic_write_text(_hidden_path(), json.dumps(entries, indent=2, ensure_ascii=False))


def hide_candidate(candidate: dict) -> dict:
    """Persist the candidate as hidden and return its entry. Idempotent: re-hiding a work
    already covered by a matching identity returns the existing entry."""
    keys = _identity_keys(candidate)
    if not keys:
        raise DiscoveryError("This paper has no usable identity to hide it by.")
    with _hidden_lock():
        entries = load_hidden()
        for entry in entries:
            if _hidden_match(entry.get("keys"), keys):
                return entry
        entry = {
            "keys": keys,
            "title": str(candidate.get("title") or "").strip()[:300],
            "hidden_at": datetime.now(UTC).isoformat(),
        }
        _save_hidden([*entries, entry])
        return entry


def unhide(keys: list[str]) -> bool:
    """Remove every hidden entry matching an identity in `keys` (the undo path)."""
    with _hidden_lock():
        entries = load_hidden()
        kept = [e for e in entries if not _hidden_match(e.get("keys"), keys)]
        if len(kept) == len(entries):
            return False
        _save_hidden(kept)
        return True


def filter_hidden(items: list | None) -> list:
    """Drop entries the reader has hidden; safe on any provider's dict shape (identity keys
    fall back to the normalized title). Non-dict entries pass through untouched."""
    items = items or []
    hidden = load_hidden()
    if not hidden:
        return items
    entry_keys = [e.get("keys") for e in hidden]
    return [
        item for item in items
        if not isinstance(item, dict)
        or not any(_hidden_match(keys, _identity_keys(item)) for keys in entry_keys)
    ]


# ---------- LLM plumbing ----------

def _default_llm(model: str, system: str, user: str, max_tokens: int) -> str:
    messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    try:
        return llm.complete(
            messages,
            model=model,
            temperature=0.1,
            max_tokens=max_tokens,
            reasoning={"effort": "low"},
            timeout=LLM_TIMEOUT_S,
            operation="discovery",
        )
    except llm.LLMError as e:
        raise DiscoveryError(str(e)) from e


def _cheap_llm(system: str, user: str, max_tokens: int) -> str:
    """One batched screening call on the pinned cheap model.

    Tagged with its own `operation` so `usage.py` can show what the funnel's volume stages cost
    separately from the reasoning calls — the whole cost claim for this feature rests on the
    volume stages being cheap, and an untagged spend is an unfalsifiable claim.
    """
    return llm.complete(
        [{"role": "system", "content": system}, {"role": "user", "content": user}],
        model=CHEAP_MODEL,
        temperature=0.0,
        max_tokens=max_tokens,
        timeout=LLM_TIMEOUT_S,
        operation="discovery_screen",
    )


def _parse_json(content: str) -> dict:
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


# ---------- query plan ----------

def _plain_search_terms(arxiv_query: str) -> str:
    text = re.sub(r"\b(?:ti|abs|all):", "", arxiv_query, flags=re.IGNORECASE)
    text = re.sub(r"\bcat:[\w.-]+", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"\b(?:ANDNOT|AND|OR)\b", " ", text, flags=re.IGNORECASE)
    return " ".join(text.replace('"', " ").split())


def generate_queries(goals: str, model: str, llm_fn: LlmFn) -> tuple[str, list[dict]]:
    """Goals -> (focus, [{query, search_terms, phase, rationale}, ...]), capped."""
    parsed = _parse_json(
        llm_fn(model, prompts.get("discover_queries"), goals, QUERIES_MAX_TOKENS)
    )
    raw = parsed.get("queries")
    if not isinstance(raw, list):
        raise DiscoveryError("The model's query plan had no 'queries' list.")
    queries = []
    for q in raw:
        text = (
            str((q or {}).get("query") or "").strip()
            if isinstance(q, dict)
            else str(q).strip()
        )
        if not text:
            continue
        phase = (q.get("phase") if isinstance(q, dict) else "") or ""
        rationale = (q.get("rationale") if isinstance(q, dict) else "") or ""
        search_terms = (
            str(q.get("search_terms") or "").strip() if isinstance(q, dict) else ""
        ) or _plain_search_terms(text)
        queries.append({
            "query": text,
            "search_terms": search_terms,
            "phase": str(phase).strip() or "narrow",
            "rationale": str(rationale).strip(),
        })
        if len(queries) >= MAX_QUERIES:
            break
    if not queries:
        raise DiscoveryError("The model produced no usable search queries.")
    return str(parsed.get("focus") or "").strip(), queries


# ---------- source-balanced candidate recall ----------

def _clean_doi(value: object) -> str:
    doi = str(value or "").strip().lower()
    return re.sub(r"^https?://(?:dx\.)?doi\.org/", "", doi, flags=re.IGNORECASE)


def _identity_keys(candidate: dict) -> list[str]:
    """All deterministic identities for a result, strongest first.

    Providers do not expose the same identifier consistently: an arXiv result may only carry
    its arXiv id while the matching Semantic Scholar row carries a DOI and paper id. Keeping
    title as an alias lets those rows coalesce without discarding the stronger identifiers that
    become available after the first hit.
    """
    keys: list[str] = []
    arxiv_id = re.sub(
        r"v\d+$",
        "",
        str(candidate.get("arxiv_id") or "").strip(),
        flags=re.IGNORECASE,
    )
    if arxiv_id:
        keys.append(f"arxiv:{arxiv_id.lower()}")
    doi = _clean_doi(candidate.get("doi"))
    if doi:
        keys.append(f"doi:{doi}")
    paper_id = str(candidate.get("paper_id") or "").strip()
    if paper_id:
        keys.append(f"s2:{paper_id}")
    title = re.sub(
        r"[^a-z0-9]+", " ", str(candidate.get("title") or "").lower()
    ).strip()
    if title:
        keys.append(f"title:{title}")
    return list(dict.fromkeys(keys))


def _candidate_key(candidate: dict) -> str:
    keys = _identity_keys(candidate)
    return keys[0] if keys else "title:"


def _merge_candidate(existing: dict, incoming: dict) -> None:
    for field in ("abstract", "venue"):
        if len(str(incoming.get(field) or "")) > len(str(existing.get(field) or "")):
            existing[field] = incoming.get(field)
    for field in (
        "paper_id",
        "arxiv_id",
        "doi",
        "url",
        "provider_url",
        "pdf_url",
        "year",
        "category",
        "publication_date",
    ):
        if not existing.get(field) and incoming.get(field):
            existing[field] = incoming[field]
    for field in ("authors", "author_ids", "fields_of_study", "publication_types"):
        values = [*existing.get(field, []), *incoming.get(field, [])]
        existing[field] = list(dict.fromkeys(value for value in values if value))
    for field in ("citation_count", "influential_citation_count"):
        values = [
            value
            for value in (existing.get(field), incoming.get(field))
            if isinstance(value, int)
        ]
        existing[field] = max(values) if values else None


def collect_candidates(
    queries: list[dict],
    search_fn: SearchFn,
    semantic_search_fn: SearchFn | None = None,
) -> Iterator[dict]:
    """Fan each concept out across providers, merge identities, then source-balance the cap."""
    seen: dict[str, dict] = {}
    identity_owner: dict[str, str] = {}
    errors: set[str] = set()
    for i, q in enumerate(queries):
        providers: list[tuple[str, str, SearchFn]] = [
            ("arxiv", q["query"], search_fn),
        ]
        if semantic_search_fn is not None:
            providers.append((
                "semantic_scholar",
                q.get("search_terms") or _plain_search_terms(q["query"]),
                semantic_search_fn,
            ))
        for provider, provider_query, provider_search in providers:
            try:
                results = provider_search(provider_query, PER_QUERY_RESULTS)
            except (retriever.RetrievalError, semantic_scholar.SemanticScholarError):
                errors.add(provider)
                continue
            for rank, raw in enumerate(results, 1):
                cand = dict(raw)
                if not cand.get("title"):
                    continue
                cand.setdefault("provider", provider)
                identities = _identity_keys(cand)
                if not identities:
                    continue
                strong_identities = [
                    identity for identity in identities
                    if not identity.startswith("title:")
                ]
                owners = {
                    identity_owner[identity]
                    for identity in strong_identities
                    if identity in identity_owner
                }
                title_identity = next(
                    (
                        identity for identity in identities
                        if identity.startswith("title:")
                    ),
                    None,
                )
                title_owner = (
                    identity_owner.get(title_identity) if title_identity else None
                )
                # Titles bridge providers when one side lacks the other's external id. Do not
                # collapse distinct same-provider search hits that happen to share a title.
                if (
                    not owners
                    and title_owner
                    and provider not in seen[title_owner]["sources"]
                ):
                    owners.add(title_owner)
                if owners:
                    # A row should resolve to one existing paper. If two prior rows only become
                    # linked by this result, fold both into the first-seen owner and repoint all
                    # aliases so future hits remain deterministic.
                    key = next(key for key in seen if key in owners)
                    for duplicate_key in owners - {key}:
                        duplicate = seen.pop(duplicate_key)
                        _merge_candidate(seen[key], duplicate)
                        seen[key]["sources"] = list(dict.fromkeys([
                            *seen[key]["sources"], *duplicate["sources"],
                        ]))
                        seen[key]["matched_queries"] = [
                            *seen[key]["matched_queries"],
                            *(
                                match for match in duplicate["matched_queries"]
                                if match not in seen[key]["matched_queries"]
                            ),
                        ]
                        seen[key]["recall_score"] += duplicate["recall_score"]
                        for identity, owner in list(identity_owner.items()):
                            if owner == duplicate_key:
                                identity_owner[identity] = key
                    _merge_candidate(seen[key], cand)
                else:
                    key = identities[0]
                    seen[key] = cand
                    seen[key]["candidate_id"] = key
                    seen[key]["sources"] = []
                    seen[key]["matched_queries"] = []
                    seen[key]["recall_score"] = 0.0
                    seen[key].setdefault("affiliations", [])
                merged = seen[key]
                for identity in _identity_keys(merged):
                    if identity.startswith("title:"):
                        identity_owner.setdefault(identity, key)
                    else:
                        identity_owner[identity] = key
                if provider not in merged["sources"]:
                    merged["sources"].append(provider)
                match = {"provider": provider, "query": q["query"], "rank": rank}
                if match not in merged["matched_queries"]:
                    merged["matched_queries"].append(match)
                    merged["recall_score"] += 1.0 / (RRF_K + rank)
        yield {
            "type": "search",
            "query": q["query"],
            "index": i + 1,
            "total": len(queries),
            "found": min(len(seen), MAX_CANDIDATES),
            "providers": [provider for provider, *_ in providers],
        }
    if not seen:
        raise DiscoveryError(
            "No scholarly results for any query."
            + (
                " One or more providers were unavailable — wait a minute and try again."
                if errors
                else " Try rephrasing the goals with more specific terms."
            )
        )
    ranked_recall = sorted(
        seen.values(),
        key=lambda candidate: (
            candidate["recall_score"],
            len(candidate["sources"]),
            candidate.get("citation_count") or 0,
        ),
        reverse=True,
    )
    selected_ids: set[str] = set()
    for provider in ("arxiv", "semantic_scholar"):
        exclusive = [
            candidate for candidate in ranked_recall
            if set(candidate.get("sources") or []) == {provider}
        ]
        selected_ids.update(
            candidate["candidate_id"]
            for candidate in exclusive[:MIN_PROVIDER_EXCLUSIVE]
        )
    for candidate in ranked_recall:
        if len(selected_ids) >= MAX_CANDIDATES:
            break
        selected_ids.add(candidate["candidate_id"])
    source_balanced = [
        candidate for candidate in ranked_recall
        if candidate["candidate_id"] in selected_ids
    ][:MAX_CANDIDATES]
    yield {"type": "candidates", "candidates": source_balanced}


# ---------- evidence enrichment + final rank ----------

def add_citation_counts(candidates: list[dict], citations_fn: CitationsFn) -> None:
    """Best-effort Map-style counts for arXiv, DOI, and title-only works."""
    for candidate in candidates:
        candidate.setdefault("candidate_id", _candidate_key(candidate))
    nodes = [{
        "id": candidate["candidate_id"],
        "arxiv_id": candidate.get("arxiv_id"),
        "doi": candidate.get("doi"),
        "kind": "external",
        "title": candidate.get("title", ""),
    } for candidate in candidates]
    cache = {
        candidate["candidate_id"]: candidate["citation_count"]
        for candidate in candidates
        if isinstance(candidate.get("citation_count"), int)
    }
    citations_fn(nodes, cache)
    counts = {node["id"]: node.get("citation_count") for node in nodes}
    for candidate in candidates:
        candidate["citation_count"] = counts.get(candidate["candidate_id"])


def _candidate_scoring_text(index: int, candidate: dict) -> str:
    cites = candidate.get("citation_count")
    influential = candidate.get("influential_citation_count")
    return (
        f"{index}. {candidate['title']}\n"
        f"Authors: {', '.join(candidate.get('authors') or []) or 'not available'}\n"
        f"Affiliations: {', '.join(candidate.get('affiliations') or []) or 'not available'}\n"
        f"Venue/year: {candidate.get('venue') or 'not available'} / "
        f"{candidate.get('year') or 'not available'}\n"
        f"Total citations: {cites if cites is not None else 'not available'}; "
        f"influential citations: {influential if influential is not None else 'not available'}\n"
        f"Publication types: "
        f"{', '.join(candidate.get('publication_types') or []) or 'not available'}\n"
        f"Found via: {', '.join(candidate.get('sources') or [])}\n"
        f"Abstract: {(candidate.get('abstract') or '')[:ABSTRACT_CHARS_FOR_SCORING]}"
    )


def score_candidates(
    goals: str,
    candidates: list[dict],
    model: str,
    llm_fn: LlmFn,
) -> list[dict]:
    """Score every candidate for fit and evidence credibility, then apply a capped blend."""
    numbered = "\n\n".join(
        _candidate_scoring_text(i, candidate)
        for i, candidate in enumerate(candidates, 1)
    )
    user = (
        f"Researcher's goals for the project:\n\n{goals}\n\n"
        f"Candidate papers ({len(candidates)}):\n\n{numbered}"
    )
    parsed = _parse_json(
        llm_fn(model, prompts.get("discover_scoring"), user, SCORING_MAX_TOKENS)
    )
    rows = parsed.get("scores")
    if not isinstance(rows, list) or not rows:
        raise DiscoveryError("The model's scoring response had no 'scores' list.")
    by_index: dict[int, dict] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        try:
            idx = int(row.get("index"))
            relevance = max(0.0, min(10.0, float(row.get("relevance"))))
            credibility = max(0.0, min(4.0, float(row.get("credibility", 0))))
        except (TypeError, ValueError):
            continue
        by_index[idx] = {
            "relevance": relevance,
            "credibility": credibility,
            "reason": str(row.get("reason") or "").strip(),
        }

    out = []
    for i, candidate in enumerate(candidates, 1):
        score_row = by_index.get(
            i, {"relevance": 0.0, "credibility": 0.0, "reason": ""}
        )
        cites = candidate.get("citation_count") or 0
        citation_term = min(
            CITATION_TERM_CAP, CITATION_TERM_SCALE * math.log10(1 + cites)
        )
        reasons = [score_row["reason"]] if score_row["reason"] else []
        if cites >= 100:
            reasons.append(f"~{cites:,} citations overall — a well-established work")
        out.append({
            **candidate,
            "relevance": score_row["relevance"],
            "credibility": score_row["credibility"],
            "score": round(
                score_row["relevance"]
                + CREDIBILITY_TERM_SCALE * score_row["credibility"]
                + citation_term,
                3,
            ),
            "reasons": reasons,
        })
    out.sort(
        key=lambda candidate: (
            candidate["score"],
            candidate["relevance"],
            candidate["credibility"],
            candidate.get("citation_count") or 0,
        ),
        reverse=True,
    )
    return out


# ---------- the funnel: cheap batched screening between wide recall and the ranked list ----------

def _profile_text(goals: str, papers: list) -> str:
    """The compact project profile every screening batch is judged against.

    Deliberately small (~250 tokens): it is repeated in every batch, so its size multiplies across
    the whole stage. Reading-list titles are included because they say what this researcher
    actually reads far more precisely than a prose goal does.
    """
    titles = [getattr(p, "title", "") for p in (papers or [])[:10]]
    titles = [t for t in titles if t]
    lines = [f"FOCUS: {goals.strip()}"]
    if titles:
        lines.append("ALREADY READING: " + "; ".join(t[:90] for t in titles))
    return "\n".join(lines)


def _interleave_by_lane(candidates: list[dict], limit: int) -> list[dict]:
    """Take `limit` candidates round-robin across recall lanes, so no lane can starve the others.

    Order alone is not a safe way to apply a cap here. Grounded candidates are merged first and a
    single well-cited anchor can contribute hundreds of forward citations, so a plain `[:limit]`
    would fill the whole budget from one lane and silently delete the lexical results — which are
    the only lane a project with no library has at all.
    """
    if len(candidates) <= limit:
        return candidates
    lanes: dict[str, list[dict]] = {}
    for candidate in candidates:
        lane = (candidate.get("channels") or ["lexical"])[0]
        lanes.setdefault(lane, []).append(candidate)

    out: list[dict] = []
    queues = list(lanes.values())
    position = 0
    while len(out) < limit and any(position < len(q) for q in queues):
        for queue in queues:
            if position < len(queue):
                out.append(queue[position])
                if len(out) >= limit:
                    break
        position += 1
    return out


def triage_titles(candidates: list[dict], profile: str, cheap_llm, *, ledger: dict | None = None,
                  cheap_model: str = "", profile_hash: str = "") -> tuple[list[dict], dict]:
    """Stage B — drop the obviously irrelevant on titles alone, biased hard toward keeping."""
    if not candidates:
        return [], {"stage": "title_triage", "items": 0}

    # A candidate this exact model+profile already KEPT does not need re-judging. Reusing it is
    # the ledger's whole purpose: without this a rerun re-buys every batch it already paid for.
    cached_keep: dict[int, str] = {}
    to_judge: list[dict] = []
    for candidate in candidates:
        entry = discovery_ledger.get(ledger or {}, _candidate_key(candidate))
        cheap = (entry or {}).get("cheap") if entry else None
        if (isinstance(cheap, dict) and cheap.get("verdict") == "K"
                and cheap.get("model") == cheap_model
                and cheap.get("profile_hash") == profile_hash):
            cached_keep[id(candidate)] = str(cheap.get("tag") or "")
        else:
            to_judge.append(candidate)

    system = prompts.render("discover_title_triage") + "\n\n" + profile

    def render(index: int, candidate: dict) -> str:
        year = candidate.get("year") or ""
        return f"{index}|{year}|{str(candidate.get('title') or '')[:220]}"

    values, audit = discovery_batch.run_batches(
        to_judge, batch_size=TITLE_BATCH_SIZE, system=system, render_item=render,
        llm_fn=lambda s, u: cheap_llm(s, u, TITLE_TRIAGE_MAX_TOKENS),
        min_fields=1, stage="title_triage")
    audit["reused"] = len(cached_keep)

    verdicts = {id(c): (values.get(i), True) for i, c in enumerate(to_judge, 1)}
    kept: list[dict] = []
    for candidate in candidates:
        if id(candidate) in cached_keep:
            candidate["triage_tag"] = cached_keep[id(candidate)]
            kept.append(candidate)
            continue
        fields, _ = verdicts.get(id(candidate), (None, False))
        # No answer means KEEP: an unjudged paper is uncertainty, and the whole point of the
        # instruction "when uncertain, reply K" is that this stage must not delete on silence.
        verdict = (fields[0].upper() if fields else "K")[:1]
        tag = fields[1].upper() if fields and len(fields) > 1 else ""
        if verdict == "D" and not (discovery_gate.GROUNDED_CHANNELS
                                   & set(candidate.get("channels") or [])):
            continue
        candidate["triage_tag"] = tag
        kept.append(candidate)

    capped = _interleave_by_lane(kept, MAX_AFTER_TITLE_TRIAGE)
    audit["kept"] = len(capped)          # what actually goes forward, not the pre-cap count
    audit["dropped_by_cap"] = len(kept) - len(capped)
    return capped, audit


def score_abstracts(candidates: list[dict], profile: str, cheap_llm, *,
                    ledger: dict | None = None, cheap_model: str = "",
                    profile_hash: str = "") -> tuple[list[dict], dict]:
    """Stage C — a 0-10 relevance score and a role tag from the abstract."""
    if not candidates:
        return [], {"stage": "abstract_scoring", "items": 0}

    # Same reuse as the title stage, and it matters more here: this is the larger of the two
    # per-item prompts, so an unchanged rerun would otherwise re-buy the most expensive screen.
    to_judge: list[dict] = []
    reused = 0
    for candidate in candidates:
        entry = discovery_ledger.get(ledger or {}, _candidate_key(candidate))
        cached = (entry or {}).get("abstract") if entry else None
        if (isinstance(cached, dict) and cached.get("model") == cheap_model
                and cached.get("profile_hash") == profile_hash
                and isinstance(cached.get("relevance"), int)):
            candidate["relevance"] = float(cached["relevance"])
            candidate["role"] = str(cached.get("role") or "")
            candidate.setdefault("screen_note", "")
            reused += 1
        else:
            to_judge.append(candidate)
    candidates_to_score = to_judge

    system = prompts.render("discover_abstract_scoring") + "\n\n" + profile

    def render(index: int, candidate: dict) -> str:
        cites = candidate.get("citation_count")
        # Venue rides along because it is already on the candidate — it costs ~5 tokens and is
        # real credibility evidence. Affiliations deliberately do NOT: they need an OpenAlex
        # authorship call, which this design defers until after screening so it runs over ~60
        # papers instead of thousands. That is a genuine trade, not an oversight.
        return (f"{index}|{candidate.get('year') or ''}|"
                f"{str(candidate.get('title') or '')[:220]}|"
                f"{str(candidate.get('venue') or '')[:60]}|"
                f"cites={cites if isinstance(cites, int) else '?'}|"
                f"{str(candidate.get('abstract') or '')[:ABSTRACT_CHARS_FOR_SCREENING]}")

    values, audit = discovery_batch.run_batches(
        candidates_to_score, batch_size=ABSTRACT_BATCH_SIZE, system=system, render_item=render,
        llm_fn=lambda s, u: cheap_llm(s, u, ABSTRACT_SCORING_MAX_TOKENS),
        min_fields=2, stage="abstract_scoring")
    audit["reused"] = reused

    for index, candidate in enumerate(candidates_to_score, 1):
        fields = values.get(index) or []
        candidate["relevance"] = _clamped_score(fields[0] if fields else None)
        candidate["role"] = (fields[1].upper() if len(fields) > 1 else "") or ""
        note = fields[2].strip() if len(fields) > 2 else ""
        candidate["screen_note"] = note[:160]
    audit["scored"] = sum(1 for c in candidates if c.get("relevance"))
    return candidates, audit


def _clamped_score(raw: object) -> float:
    """A relevance score we can rank on, whatever the model emitted.

    An unparseable score becomes the neutral 5.0 rather than 0: this stage's job is ordering, and
    a parse slip must not read as 'the model judged this irrelevant'.
    """
    try:
        value = float(str(raw).strip())
    except (TypeError, ValueError):
        return 5.0
    return max(0.0, min(10.0, value))


def blend_and_rank(candidates: list[dict]) -> list[dict]:
    """Deterministic final ordering, reusing the constants the old pipeline was tuned with."""
    out = []
    for candidate in candidates:
        cites = candidate.get("citation_count") or 0
        citation_term = min(CITATION_TERM_CAP, CITATION_TERM_SCALE * math.log10(1 + cites))
        channels = set(candidate.get("channels") or [])
        provenance_term = 0.0
        reasons: list[str] = []
        if candidate.get("screen_note"):
            reasons.append(candidate["screen_note"])
        if "cites" in channels:
            provenance_term += PROVENANCE_BONUS_CITES
            anchor = next((p.get("anchor_title") for p in candidate.get("provenance") or []
                           if p.get("channel") == "cites" and p.get("anchor_title")), "")
            reasons.append(f"Cites “{anchor[:70]}” from your reading list" if anchor
                           else "Cites a paper on your reading list")
        if "graph" in channels:
            provenance_term += PROVENANCE_BONUS_GRAPH
            graph_reasons = next((p.get("reasons") or [] for p in candidate.get("provenance") or []
                                  if p.get("channel") == "graph"), [])
            reasons.extend(str(r) for r in graph_reasons[:2])
        if cites >= 100:
            reasons.append(f"~{cites:,} citations overall — a well-established work")

        relevance = float(candidate.get("relevance") or 0.0)
        out.append({
            **candidate,
            "relevance": relevance,
            "credibility": 0.0,
            "score": round(relevance + citation_term + provenance_term, 3),
            "reasons": list(dict.fromkeys(r for r in reasons if r))[:4],
        })
    out.sort(key=lambda c: (c["score"], c["relevance"], c.get("citation_count") or 0),
             reverse=True)
    return out


# ---------- the full run (generator of progress events; drive via discovery_jobs) ----------

def run_discovery(
    goals: str,
    *,
    model: str | None = None,
    search_fn: SearchFn | None = None,
    semantic_search_fn: SearchFn | None = None,
    llm_fn: LlmFn | None = None,
    citations_fn: CitationsFn | None = None,
    authorships_fn: AuthorshipsFn | None = None,
    cheap_llm_fn: CheapLlmFn | None = None,
    library_fn: Callable[[], list] | None = None,
    recall_fn: RecallFn | None = None,
) -> Iterator[dict]:
    """Run the multi-source pipeline and yield cheap snapshots for the background job."""
    goals = (goals or "").strip()
    if not goals:
        raise DiscoveryError("Describe the project's goals first.")
    model = model or graph.resolve_model()
    injected_search = search_fn is not None or semantic_search_fn is not None
    injected_arxiv = search_fn is not None
    search_fn = search_fn or retriever.search_arxiv_raw
    if semantic_search_fn is None and not injected_arxiv:
        semantic_search_fn = semantic_scholar.search_papers
    llm_fn = llm_fn or _default_llm
    citations_fn = citations_fn or citations.annotate_nodes
    if authorships_fn is None:
        authorships_fn = (
            (lambda _candidates: None)
            if injected_search
            else openalex.annotate_discovery_authorships
        )

    cheap_llm = cheap_llm_fn or _cheap_llm
    papers = _reading_list(library_fn)

    focus, queries = generate_queries(goals, model, llm_fn)
    yield {"type": "queries", "focus": focus, "queries": queries}

    lexical: list[dict] = []
    lexical_error = ""
    try:
        for event in collect_candidates(queries, search_fn, semantic_search_fn):
            if event["type"] == "candidates":
                lexical = event["candidates"]
            else:
                yield event
    except Exception as e:  # noqa: BLE001 — one lane must not be able to kill the run
        # Keyword search is no longer the pipeline, so neither an empty result NOR a provider
        # outage is fatal: the library-grounded channels can carry a run on their own. Catching
        # only DiscoveryError left a transport failure killing a run that had good grounded
        # results in hand. It still fails below if every channel came back empty, and the failure
        # is recorded in `degraded` rather than swallowed — a run that searched half its sources
        # and reports success presents an incomplete result as a complete one.
        lexical_error = str(e) if isinstance(e, DiscoveryError) else (
            f"{type(e).__name__}: {str(e)[:120]}")
        log.info("lexical lane failed (%s); continuing on the grounded channels", lexical_error)

    # The library-grounded channels. They are additive: a brand-new project has no papers and no
    # graph, so they contribute nothing and Discovery still works off the lexical lane alone —
    # which is the case the feature was originally built for and must not regress.
    yield {"type": "library", "papers": len(papers)}
    grounded, recall_audit = _grounded_candidates(papers, recall_fn=recall_fn)

    candidates = discovery_recall.merge_candidates(
        [grounded, lexical], identity_keys=_identity_keys, merge_fn=_merge_candidate)
    if not candidates:
        raise DiscoveryError(lexical_error or (
            "No papers found. Try rephrasing the goals with more specific terms."))
    yield {"type": "gathered", "count": len(candidates)}

    ledger = discovery_ledger.load()
    profile_hash = discovery_ledger.profile_hash(goals, CHEAP_MODEL)
    today = _now()[:10]
    for candidate in candidates:
        entry = discovery_ledger.observe(ledger, _candidate_key(candidate), candidate,
                                         (candidate.get("channels") or ["lexical"])[0], today)
        del entry

    survivors, gate_counts = discovery_gate.apply_gate(
        candidates, known_papers=papers, hidden_filter=filter_hidden,
        titles_match=graph.titles_match, ledger=ledger, cheap_model=CHEAP_MODEL,
        profile=profile_hash, today_year=datetime.now(UTC).year, identity_keys=_identity_keys)
    yield {"type": "gated", "kept": len(survivors), "counts": gate_counts}

    # Early finds. These come from the grounded channels, so they need no model to be worth
    # showing: a paper reached by forward-citation from the reader's own library, or already
    # ranked by their reference graph, is interesting on provenance alone. Surfacing them here —
    # seconds in, rather than after the whole funnel — is what makes a multi-minute run feel like
    # it is finding things rather than hanging.
    yield {"type": "finds", "stage": "grounded",
           "items": _preview(survivors, focus=f"{focus} {goals}", provisional=True)}

    profile = _profile_text(goals, papers)
    yield {"type": "triage", "count": len(survivors)}
    gated = survivors                       # the population the cheap screen actually judged
    triaged, triage_audit = triage_titles(gated, profile, cheap_llm, ledger=ledger,
                                          cheap_model=CHEAP_MODEL, profile_hash=profile_hash)
    # ONLY over `gated`. Passing the pre-gate list here recorded a fabricated model rejection for
    # every candidate the deterministic gate had removed — including hidden ones — and the gate
    # then honoured that rejection on later runs, so un-hiding a paper could never bring it back.
    _record_verdicts(ledger, triaged, gated, kind="cheap", model=CHEAP_MODEL,
                     profile=profile_hash, today=today)

    yield {"type": "citations", "count": len(triaged)}
    add_citation_counts(triaged, citations_fn)

    yield {"type": "scoring", "count": len(triaged)}
    scored, abstract_audit = score_abstracts(triaged, profile, cheap_llm, ledger=ledger,
                                             cheap_model=CHEAP_MODEL, profile_hash=profile_hash)
    scored.sort(key=lambda c: float(c.get("relevance") or 0.0), reverse=True)
    scored = scored[:MAX_AFTER_ABSTRACTS]

    ranked_so_far = blend_and_rank(scored)
    yield {"type": "finds", "stage": "ranked", "items": _preview(ranked_so_far, focus=focus)}

    yield {"type": "evidence", "count": len(scored)}
    authorships_fn(scored)

    ranked = blend_and_rank(scored)
    _record_verdicts(ledger, ranked, triaged, kind="abstract", model=CHEAP_MODEL,
                     profile=profile_hash, today=today)
    _persist_ledger(ledger)

    funnel = {"gathered": len(candidates), **gate_counts,
              "after_triage": triage_audit.get("kept", 0), "surfaced": len(ranked)}
    degraded = [*triage_audit.get("degraded", []), *abstract_audit.get("degraded", []),
                *recall_audit.get("degraded", [])]
    if lexical_error:
        # Recorded, not swallowed. Continuing on the grounded channels is right, but a run that
        # searched only half its sources and says nothing presents an incomplete result as a
        # complete one — and the reader has no way to tell why their topic looks thin.
        degraded.append(f"Keyword search returned nothing: {lexical_error}")

    yield {"type": "done", "result": {
        "goals": goals,
        "focus": focus,
        "model": model,
        "cheap_model": CHEAP_MODEL,
        "queries": queries,
        "candidate_count": len(ranked),
        "source_counts": {
            provider: sum(
                1 for candidate in ranked if provider in candidate.get("sources", [])
            )
            for provider in ("arxiv", "semantic_scholar", "openalex", "graph")
        },
        "funnel": funnel,
        "audit": {"recall": recall_audit, "gate": gate_counts,
                  "title_triage": triage_audit, "abstract_scoring": abstract_audit},
        "degraded": degraded,
        "top_n": TOP_SUGGESTIONS,
        "suggestions": ranked,
        "generated_at": _now(),
    }}


#: How many live finds the client shows while a run is in flight. Small on purpose: this is a
#: reassurance signal, not the result list, and every item is polled repeatedly.
PREVIEW_FINDS = 5


_PREVIEW_STOPWORDS = frozenset({
    "the", "and", "for", "with", "from", "that", "this", "how", "why", "what", "into", "using",
    "understand", "understanding", "learn", "learning", "about", "study", "based", "towards",
    "paper", "papers", "research", "work", "approach", "method", "methods", "explore",
})


def _topic_words(text: str) -> set[str]:
    """Content words, stemmed crudely.

    Three characters, not four: a four-character floor drops LLM, RAG, NLP, PIM and DNN — exactly
    the terms a reader is most likely to type — which emptied the set and disabled the filter
    entirely, admitting the high-citation noise it exists to stop.

    The trailing-s strip is what lets "representation learning" match "Learning disentangled
    representations". It is deliberately not a real stemmer: this decides whether to show a
    reassurance line mid-run, and a wrong call in either direction costs one row on a card.
    """
    words = set()
    for raw in re.findall(r"[a-z0-9]+", (text or "").lower()):
        if len(raw) < 3 or raw in _PREVIEW_STOPWORDS:
            continue
        words.add(raw[:-1] if len(raw) > 4 and raw.endswith("s") else raw)
    return words


def _preview(candidates: list[dict], *, focus: str = "",
             provisional: bool = False) -> list[dict]:
    """A few finds worth showing mid-run, trimmed to what the card actually renders.

    Deliberately NOT the full candidate dicts: this rides on every poll, and a run can hold
    hundreds of candidates carrying abstracts and authorship lists.

    `provisional` marks finds chosen on provenance alone, before any model has judged them — the
    client says so, because a paper shown early and then absent from the results would otherwise
    look like a bug rather than the screen doing its job.

    Provisional finds are additionally required to SHARE VOCABULARY with what the reader asked
    for. Provenance alone is not enough to put a title on screen: a live run for "3D-stacked DRAM"
    offered "The AI gambit: leveraging AI to combat climate change" — a real paper citing the
    reader's library, ranked up by its citation count, and completely off-topic. An early find
    that looks irrelevant makes the search look worse than showing nothing, so when nothing
    overlaps this returns nothing and the panel simply keeps its progress line.
    """
    wanted = _topic_words(focus)

    def overlap(candidate: dict) -> int:
        return len(wanted & _topic_words(candidate.get("title", ""))) if wanted else 0

    pool = candidates
    if provisional and wanted:
        pool = [c for c in candidates if overlap(c)]

    def rank(candidate: dict) -> tuple:
        channels = set(candidate.get("channels") or [])
        return (float(candidate.get("score") or candidate.get("relevance") or 0.0),
                overlap(candidate),
                1 if "cites" in channels else 0,
                1 if "graph" in channels else 0,
                candidate.get("citation_count") or 0)

    out = []
    for candidate in sorted(pool, key=rank, reverse=True)[:PREVIEW_FINDS]:
        reasons = [r for r in (candidate.get("reasons") or []) if r]
        if not reasons:
            reasons = [_provenance_line(candidate)] if _provenance_line(candidate) else []
        out.append({
            "title": str(candidate.get("title") or "")[:200],
            "year": candidate.get("year"),
            "citation_count": candidate.get("citation_count"),
            "channels": list(candidate.get("channels") or []),
            "reason": (reasons[0] if reasons else "")[:120],
            "provisional": provisional,
        })
    return out


def _provenance_line(candidate: dict) -> str:
    """Why this find is on screen, in the reader's terms. Never empty for a grounded candidate:
    a titled row with no explanation is the thing that makes a suggestion feel arbitrary."""
    for entry in candidate.get("provenance") or []:
        if entry.get("channel") == "cites":
            title = str(entry.get("anchor_title") or "").strip()
            return (f"Cites “{title[:60]}” from your list" if title
                    else "Cites a paper on your reading list")
        if entry.get("channel") == "graph":
            reasons = [str(r) for r in (entry.get("reasons") or []) if r]
            return reasons[0] if reasons else "Ranked by your reference graph"
    channels = set(candidate.get("channels") or [])
    if "cites" in channels:
        return "Cites a paper on your reading list"
    if "graph" in channels:
        return "Ranked by your reference graph"
    return ""


def _reading_list(library_fn) -> list:
    """The project's papers, or an empty list. Never fails a run — a project that cannot be read
    simply has no grounded channels, and the lexical lane still produces suggestions."""
    try:
        return list((library_fn or store.list_papers)())
    except Exception as e:  # noqa: BLE001 — recall is best-effort by design
        log.info("could not read the reading list for discovery (%s)", type(e).__name__)
        return []


def _grounded_candidates(papers: list, *, recall_fn) -> tuple[list[dict], dict]:
    """R1+R2+R5. Injectable as one seam so the suite stays network-free."""
    if recall_fn is not None:
        return recall_fn(papers)
    audit: dict = {"anchors": 0, "cites": 0, "graph": 0, "degraded": []}
    if not papers:
        return [], audit

    graph_data = graph_store.load()
    from_graph = discovery_recall.graph_recommendations(graph_data)
    audit["graph"] = len(from_graph)

    anchor_cache = graph_data.setdefault("openalex_anchors", {})
    before = len(anchor_cache)
    client = openalex.make_client(timeout=discovery_recall.TIMEOUT_S)
    try:
        anchors = discovery_recall.resolve_anchors(papers, client=client, cache=anchor_cache)
        audit["anchors"] = len(anchors)
        from_cites = discovery_recall.chase_citations(anchors, client=client)
        audit["cites"] = len(from_cites)
    except Exception as e:  # noqa: BLE001 — an outage must not fail the run
        log.warning("grounded recall stopped early (%s)", type(e).__name__)
        audit["degraded"].append(f"citation chase stopped early ({type(e).__name__})")
        from_cites = []
    finally:
        client.close()

    if len(anchor_cache) != before:
        try:
            graph_store.save(graph_data)   # anchor ids are free but slow; pay for them once ever
        except Exception:  # noqa: BLE001
            pass
    return [*from_cites, *from_graph], audit


def _record_verdicts(ledger: dict, judged: list[dict], all_candidates: list[dict], *,
                     kind: str, model: str, profile: str, today: str) -> None:
    """Write this run's screening judgements back to the ledger so a rerun does not re-buy them."""
    kept_keys = {_candidate_key(c) for c in judged}
    for candidate in all_candidates:
        key = _candidate_key(candidate)
        entry = discovery_ledger.get(ledger, key)
        if entry is None:
            continue
        if kind == "cheap":
            discovery_ledger.record_cheap_verdict(
                entry, verdict=("K" if key in kept_keys else "D"),
                tag=str(candidate.get("triage_tag") or ""), model=model,
                profile=profile, today=today)
        elif key in kept_keys and isinstance(candidate.get("relevance"), (int, float)):
            discovery_ledger.record_abstract_score(
                entry, relevance=int(candidate["relevance"]),
                role=str(candidate.get("role") or ""), model=model,
                profile=profile, today=today)


def _persist_ledger(ledger: dict) -> None:
    try:
        discovery_ledger.save(ledger)
    except Exception as e:  # noqa: BLE001 — losing the ledger costs money, never correctness
        log.warning("could not persist the discovery ledger (%s)", type(e).__name__)
