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
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from pathlib import Path

from . import citations, config, graph, llm, openalex, prompts, retriever, semantic_scholar
from .fileio import atomic_write_text

MAX_QUERIES = 6
PER_QUERY_RESULTS = 25
MAX_CANDIDATES = 50
TOP_SUGGESTIONS = 5
ABSTRACT_CHARS_FOR_SCORING = 1200
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
# and keyed by EVERY deterministic identity of the suggestion (arXiv id, DOI, S2 paper id,
# normalized title) so the same work re-found through a different provider stays hidden.

def _hidden_path() -> Path:
    return config.state_dir() / "discovery-hidden.json"


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
    already covered by an overlapping identity returns the existing entry."""
    keys = _identity_keys(candidate)
    if not keys:
        raise DiscoveryError("This paper has no usable identity to hide it by.")
    entries = load_hidden()
    for entry in entries:
        if set(entry.get("keys") or []) & set(keys):
            return entry
    entry = {
        "keys": keys,
        "title": str(candidate.get("title") or "").strip()[:300],
        "hidden_at": datetime.now(UTC).isoformat(),
    }
    _save_hidden([*entries, entry])
    return entry


def unhide(keys: list[str]) -> bool:
    """Remove every hidden entry sharing an identity with `keys` (the undo path)."""
    entries = load_hidden()
    kept = [e for e in entries if not (set(e.get("keys") or []) & set(keys))]
    if len(kept) == len(entries):
        return False
    _save_hidden(kept)
    return True


def filter_hidden(items: list | None) -> list:
    """Drop entries the reader has hidden; safe on any provider's dict shape (identity keys
    fall back to the normalized title). Non-dict entries pass through untouched."""
    items = items or []
    hidden = {k for e in load_hidden() for k in e.get("keys") or []}
    if not hidden:
        return items
    return [
        item for item in items
        if not isinstance(item, dict) or not (set(_identity_keys(item)) & hidden)
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

    focus, queries = generate_queries(goals, model, llm_fn)
    yield {"type": "queries", "focus": focus, "queries": queries}

    candidates: list[dict] = []
    for event in collect_candidates(queries, search_fn, semantic_search_fn):
        if event["type"] == "candidates":
            candidates = event["candidates"]
        else:
            yield event

    yield {"type": "citations", "count": len(candidates)}
    add_citation_counts(candidates, citations_fn)

    yield {"type": "evidence", "count": len(candidates)}
    authorships_fn(candidates)

    yield {"type": "scoring", "count": len(candidates)}
    ranked = score_candidates(goals, candidates, model, llm_fn)

    yield {"type": "done", "result": {
        "goals": goals,
        "focus": focus,
        "model": model,
        "queries": queries,
        "candidate_count": len(ranked),
        "source_counts": {
            provider: sum(
                1 for candidate in ranked if provider in candidate.get("sources", [])
            )
            for provider in ("arxiv", "semantic_scholar")
        },
        "top_n": TOP_SUGGESTIONS,
        "suggestions": ranked,
        "generated_at": _now(),
    }}
