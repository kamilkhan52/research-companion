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

import hashlib
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
    discovery_checkpoint,
    discovery_gate,
    discovery_ledger,
    discovery_recall,
    graph,
    graph_store,
    llm,
    logging_config,
    neighbourhood,
    openalex,
    prompts,
    retriever,
    semantic_scholar,
    significance,
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
#: The part of that cap reserved for protected title DROPS (see `_cap_with_protections`): enough
#: to keep the false-negative audit measurable, small enough that drops cannot crowd out keeps.
TITLE_DROP_SHARE = 0.15
MAX_AFTER_ABSTRACTS = 60

# Grounded channels earn a bounded bonus: evidence tied to THIS project's corpus should outrank a
# generic keyword hit, but it must not swamp relevance — a paper the reader's library cites is not
# automatically worth reading. Same reasoning as the capped citation term below.
PROVENANCE_BONUS_CITES = 1.0
PROVENANCE_BONUS_GRAPH = 0.75
#: A paper that has just STARTED citing one of yours (DR-052). Ranked above the breadth chase's
#: bonus because it is both more specific (it cites you, and we know when it started) and more
#: perishable — and because these papers are new, so their citation term is ~0 and the blend
#: would otherwise bury the lane's whole point beneath well-established work.
PROVENANCE_BONUS_NEW_CITATION = 1.25
#: A new citer whose classified label says the citation is load-bearing (EXTENDS/USES/CONTRASTS,
#: see app/significance.py). Stacks on the lane bonus: "cites us significantly" is the spec's
#: whole differentiator, and the honest prior says only 5-15% of edges earn it.
SIGNIFICANT_CITER_BONUS = 1.0
#: Corpus connectivity (spec §4): a candidate whose edges reach SEVERAL reading-list papers, per
#: distinct anchor beyond the first (the first is already the cites/new_citation bonus). Capped
#: below the single-edge bonuses so breadth refines rather than dominates.
CONNECTIVITY_BONUS_STEP = 0.35
CONNECTIVITY_BONUS_CAP = 1.05
#: Momentum (spec §§3-4): a recency-adjusted citation rate so the blend stops structurally
#: favouring 2019. Applies only to papers from the last MOMENTUM_YOUNG_YEARS — an old paper's
#: velocity is already priced into the capped citation term, and double-counting it would
#: re-create exactly the bias this corrects, in the other direction.
MOMENTUM_CAP = 1.0
MOMENTUM_SCALE = 0.5
MOMENTUM_YOUNG_YEARS = 3
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
WideRecallFn = Callable[[list[dict], list[dict], dict], tuple[list[dict], dict, list[dict]]]

# v2 (DR-164): triage/scoring now read replies by content and cap keeps-first, so a v1 snapshot
# resumed at `triaged` or `scored` would re-serve the misread verdicts and year-as-score rows.
CHECKPOINT_PIPELINE = f"wide-recall-v2:{CHEAP_MODEL}"


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
            # `authors` and `reasons` were added later still and never got the same treatment —
            # a project whose discovery.json predates them loaded with the KEY MISSING, which
            # serializes as absent JSON and crashes the client's `s.authors.length` /
            # `s.reasons[0]` on render. Same upgrade-in-memory, no write.
            suggestion.setdefault("authors", [])
            suggestion.setdefault("reasons", [])
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
# and keyed by the suggestion's deterministic identities (arXiv id, DOI, OpenAlex/S2 paper id,
# normalized title) so the same work re-found through a different provider stays hidden.
#
# Matching semantics (sol review, PR #206): a strong identifier match (arxiv/doi/openalex/s2) always
# hides; the normalized title is only a FALLBACK — it never bridges two works that carry
# conflicting strong identifiers of the same kind, and degenerate normalizations ("C++" →
# "c") are ignored entirely, so hiding one paper can never hide a different one that merely
# shares a flattened title.

_STRONG_PREFIXES = ("arxiv:", "doi:", "openalex:", "s2:")
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


def _library_match(entry_keys: list[str], candidate_keys: list[str]) -> bool:
    """Like `_hidden_match`, but for a library `Paper` rather than a full provider candidate.

    `_hidden_match`'s conflicting-id veto only fires when BOTH sides carry the SAME kind of
    strong id — and a `Paper` never carries `doi:`/`openalex:`/`s2:` (only `arxiv:`/`title:`), so
    that veto can never fire for those kinds. A title-only bridge would then silently drop a
    candidate carrying a DOI/OpenAlex/S2 id the library side never had any way to confirm OR
    refute (Opus review, PR #370: a library paper with no arXiv id bridged, on title alone, to a
    candidate carrying three unrelated strong ids). Require the candidate to be equally bare —
    no strong id of any kind — before trusting a title match; a candidate that carries any real
    identifier is judged on that identifier or not at all.
    """
    entry = set(entry_keys or [])
    cand = set(candidate_keys)
    entry_strong = {k for k in entry if k.startswith(_STRONG_PREFIXES)}
    cand_strong = {k for k in cand if k.startswith(_STRONG_PREFIXES)}
    if entry_strong & cand_strong:
        return True
    if cand_strong:
        return False
    return bool(_usable_title_keys(entry) & _usable_title_keys(cand))


def filter_in_library(items: list | None, papers: list | None = None) -> list:
    """Drop suggestions that identify the same paper as something already on the reading list
    (DR-002, 2026-08-11 device pass: "I also see some papers already in the project. They
    shouldn't be included."). The wide-recall design (`~/.claude/plans/keen-finding-rabin.md`,
    Stage A) named this exclusion from the start; it was never actually wired in.

    `Paper` (`store.list_papers`) carries only `arxiv_id` and `title`, not the DOI/OpenAlex/S2
    ids a provider result might, so this only catches what those two fields identify — still the
    common case. Matching is `_library_match`, not `_hidden_match` directly — see its docstring
    for why the asymmetric id richness between a `Paper` and a real candidate needs a stricter
    rule than the reader's own explicit hides do.
    """
    return partition_in_library(items, papers)[0]


def partition_in_library(items: list | None, papers: list | None = None) -> tuple[list, list]:
    """(kept, matched): `filter_in_library`'s split, keeping what it drops. DR-066's remainder
    (Kamil: "we could have an option to reveal them, but not by default") wants the excluded
    suggestions visible on demand, so each matched item gains `library_match` — the title of
    the reading-list entry it identified with, which is the WHY a reader expanding the row is
    looking for."""
    items = items or []
    papers = list(store.list_papers()) if papers is None else papers
    if not papers:
        return items, []
    keyed = [(p, _identity_keys({"arxiv_id": p.arxiv_id, "title": p.title})) for p in papers]
    kept, matched = [], []
    for item in items:
        if not isinstance(item, dict):
            kept.append(item)
            continue
        cand_keys = _identity_keys(item)
        hit = next((p for p, keys in keyed if _library_match(keys, cand_keys)), None)
        if hit is None:
            kept.append(item)
        else:
            matched.append({**item, "library_match": hit.title})
    return kept, matched


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


#: How many reading-list titles ground the query plan. One call per run (unlike the per-batch
#: profile), so this can afford to be wider than _profile_text's 10.
QUERY_PLAN_LIBRARY_TITLES = 30


def generate_queries(goals: str, model: str, llm_fn: LlmFn,
                     papers: list | None = None) -> tuple[str, list[dict]]:
    """Goals + library -> (focus, [{query, search_terms, phase, rationale}, ...]), capped.

    DR-096 (Kamil, 2026-08-22): the plan used to see ONLY the goals text, so a terse or meta
    request ("find new works related to my library") produced queries from those words alone —
    generic results unrelated to the corpus. The reading-list titles now ride along as
    grounding, and the prompt derives its concepts from the library whenever the request
    itself names none. Passing titles in the USER content (not the prompt) keeps every
    operator prompt override working unchanged.
    """
    titles = [t for t in (getattr(p, "title", "") for p in (papers or [])) if t]
    user_content = goals
    if titles:
        library = "\n".join(f"- {t[:120]}" for t in titles[:QUERY_PLAN_LIBRARY_TITLES])
        user_content = (
            f"RESEARCHER'S REQUEST:\n{goals}\n\n"
            f"PROJECT LIBRARY (papers they already read; ground your concepts here):\n{library}"
        )
    parsed = _parse_json(
        llm_fn(model, prompts.get("discover_queries"), user_content, QUERIES_MAX_TOKENS)
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
        bulk_query = (
            str(q.get("bulk_query") or "").strip() if isinstance(q, dict) else ""
        ) or search_terms
        queries.append({
            "query": text,
            "search_terms": search_terms,
            "bulk_query": bulk_query,
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
    openalex_id = str(candidate.get("openalex_id") or "").strip().rsplit("/", 1)[-1]
    if openalex_id:
        keys.append(f"openalex:{openalex_id.lower()}")
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
    # Momentum's input: only the OpenAlex lanes carry it, so when the merge target came from
    # another lane (or the reservoir), the fresh row's table must survive the merge — otherwise
    # the accurate velocity fires only on a candidate's first-ever sighting.
    if incoming.get("counts_by_year") and not existing.get("counts_by_year"):
        existing["counts_by_year"] = incoming["counts_by_year"]
    # The snippet lane's passage: the gate counts it as substance and the blend quotes it, so
    # it must survive when another lane's row wins the merge (the provenance copy is for the
    # reason line; this top-level field is what the gate reads).
    if incoming.get("snippet") and not existing.get("snippet"):
        existing["snippet"] = incoming["snippet"]


def collect_candidates(
    queries: list[dict],
    search_fn: SearchFn,
    semantic_search_fn: SearchFn | None = None,
    should_skip: Callable[[], bool] | None = None,
) -> Iterator[dict]:
    """Fan each concept out across providers, merge identities, then source-balance the cap."""
    skip = should_skip or (lambda: False)
    seen: dict[str, dict] = {}
    identity_owner: dict[str, str] = {}
    errors: set[str] = set()
    issued_request = False
    for i, q in enumerate(queries):
        # A request armed during query planning means "skip the remaining search", not "never
        # search". Guarantee one provider call so a fresh project does not fail with an empty,
        # unexplained lane after already paying to plan it.
        if issued_request and skip():
            break
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
            if issued_request and skip():
                break
            try:
                issued_request = True
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
                #
                # DR-126: this bridge has the DR-114 hazard too — two DIFFERENT papers sharing a
                # title, one from arXiv and one from Semantic Scholar, blend into a card holding
                # one paper's DOI beside the other's arXiv id and PDF. It is NOT fixed the way
                # `merge_candidates` is, deliberately, and the reason is a TRADE rather than an
                # impossibility. Refusing the bridge for two rows that EACH ALREADY CARRY A
                # STRONG ID — which is this hazard's case — does NOT swallow a row: their
                # `identities[0]` differ, so the loop falls through to `key = identities[0]`
                # below and stores a second row, and both papers survive. (An earlier version of
                # this comment claimed a swallow; measured, refusing yields two clean rows in
                # either provider order. The scoping matters and was itself a review finding:
                # two TITLE-ONLY rows share `identities[0]`, so refusing does not rescue THEM
                # either — with the bridge they blend into the FIRST row, without it the second
                # overwrites it; one card either way. Same provider, it is an overwrite even
                # with the bridge running, which is a pre-existing collapse noted on DR-126 and
                # one that contradicts the "do not collapse distinct same-provider hits" line
                # just above.) What it
                # costs is a DUPLICATE card whenever a preprint and its published record are
                # only title-linked — exactly the duplicate DR-113 was raised about — and it
                # breaks `test_collect_candidates_uses_normalized_title_as_a_cross_provider_alias`,
                # which pins that alias as the documented point of this lane.
                #
                # So it is the same trade `merge_candidates` already took one module over: a rare
                # wrong-PDF card versus a common duplicate card. The answer may still differ
                # here, because this is the PRIMARY recall path and the alias is its purpose
                # rather than an incidental join. That is a recall-versus-correctness call for
                # Kamil, filed as DR-126 rather than taken here.
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
        if skip():
            break
    if not seen:
        if skip():
            yield {"type": "candidates", "candidates": []}
            return
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


def _title_protections(candidates: list[dict], profile: str) -> dict[int, int]:
    """Candidates a cheap title DROP may not remove, with deterministic priority.

    Title-only screening is the irreversible-risk stage: cross-domain work often looks wrong
    before its abstract is read. Protect project-grounded evidence, source diversity, concepts,
    eras, and a stable 2% sample of everything else so the false-negative rate is measurable.
    """
    protected: dict[int, int] = {}

    def mark(candidate: dict, priority: int) -> None:
        protected[id(candidate)] = max(priority, protected.get(id(candidate), 0))

    ranked = sorted(candidates, key=lambda candidate: (
        candidate.get("citation_count") or 0,
        candidate.get("recall_score") or 0.0,
        str(candidate.get("title") or "").lower(),
    ), reverse=True)

    lanes: dict[str, list[dict]] = {}
    concepts: dict[str, list[dict]] = {}
    strata: dict[str, list[dict]] = {}
    for candidate in ranked:
        channels = set(candidate.get("channels") or ["lexical"])
        if discovery_gate.GROUNDED_CHANNELS & channels:
            mark(candidate, 100)
        for lane in channels:
            lanes.setdefault(str(lane), []).append(candidate)

        values = [str(value).strip().lower()
                  for value in (candidate.get("fields_of_study") or [])[:3] if str(value).strip()]
        for provenance in candidate.get("provenance") or []:
            if not isinstance(provenance, dict):
                continue
            value = provenance.get("topic_id") or provenance.get("topic")
            if not value and provenance.get("channel") == "bulk":
                value = provenance.get("query")
            if value:
                values.append(str(value).strip().lower()[:120])
        for concept in dict.fromkeys(values):
            concepts.setdefault(concept, []).append(candidate)

        year = candidate.get("year")
        if isinstance(year, int):
            stratum = ("pre-2000" if year < 2000 else "2000s" if year < 2010
                       else "2010s" if year < 2020 else "2020s")
            strata.setdefault(stratum, []).append(candidate)

        digest = hashlib.sha256(
            f"{profile}:{_candidate_key(candidate)}".encode()).digest()
        if int.from_bytes(digest[:4], "big") % 100 < 2:
            mark(candidate, 10)

    for rows in lanes.values():
        for candidate in rows[:2]:
            mark(candidate, 60)
    for rows in concepts.values():
        for candidate in rows[:5]:
            mark(candidate, 40)
    for rows in strata.values():
        for candidate in rows[:10]:
            mark(candidate, 30)
    return protected


def _cap_with_protections(candidates: list[dict], limit: int,
                          protected: dict[int, int]) -> list[dict]:
    """Cap the title survivors: what the title stage KEPT first, protected drops in a reserved share.

    Protection exists to stop a title DROP from being final. It was never meant to rank a dropped
    paper above a kept one, but ordering the cap purely by protection priority did exactly that —
    DR-164's replay of a real run: 296 of 400 slots went to title-dropped papers while 66 of the
    78 on-topic keeps (hybrid-bonded DRAM, for a hybrid-bonded-DRAM goal) never reached scoring.
    Drops still get `TITLE_DROP_SHARE` of the cap, highest protection first, plus any capacity
    the keeps leave unused. That keeps the false-negative audit fed with the drops that matter most
    (grounded, well-cited). It does not guarantee slots to the priority-10 random sample, which
    only reaches scoring when fewer higher-priority drops compete.
    """
    dropped = [candidate for candidate in candidates if candidate.get("screen_protected")]
    kept = [candidate for candidate in candidates if not candidate.get("screen_protected")]
    reserve = min(len(dropped), math.ceil(limit * TITLE_DROP_SHARE))
    selected = _select_by_protection(kept, limit - reserve, protected)
    selected.extend(_select_by_protection(dropped, limit - len(selected), protected))
    if len(selected) < limit:
        chosen = {id(candidate) for candidate in selected}
        selected.extend(_select_by_protection(
            [candidate for candidate in kept if id(candidate) not in chosen],
            limit - len(selected), protected))
    return selected


def _select_by_protection(candidates: list[dict], limit: int,
                          protected: dict[int, int]) -> list[dict]:
    if limit <= 0:
        return []
    input_order = {id(candidate): index for index, candidate in enumerate(candidates)}
    protected_rows = [candidate for candidate in candidates if id(candidate) in protected]
    protected_rows.sort(key=lambda candidate: (
        -protected[id(candidate)], -(candidate.get("citation_count") or 0),
        -(candidate.get("recall_score") or 0.0), input_order[id(candidate)],
    ))
    # Protected does not mean one source may consume the whole cap. Provenance independence is
    # itself a false-negative protection, so round-robin the protected pool across its lanes.
    selected = _interleave_by_lane(protected_rows, limit)
    selected_ids = {id(candidate) for candidate in selected}
    if len(selected) < limit:
        remainder = [candidate for candidate in candidates if id(candidate) not in selected_ids]
        selected.extend(_interleave_by_lane(remainder, limit - len(selected)))
    return selected


#: The role vocabulary both screening prompts ask for. Also the test for "this field IS the answer".
SCREEN_ROLES = frozenset({"FOUNDATION", "METHOD", "SURVEY", "APPLICATION", "BENCHMARK",
                          "ADJACENT", "OFF-TOPIC"})


def _screen_role(value: str) -> str:
    """A role field in canonical form, or "" when it is not one of `SCREEN_ROLES`."""
    role = re.sub(r"[\s_]+", "-", str(value or "").strip().upper())
    return role if role in SCREEN_ROLES else ""


def _title_answer(fields: list[str]) -> list[str] | None:
    """`[verdict, tag]` from a title-triage row, found by CONTENT rather than position.

    DR-164: the cheap model echoes input columns ahead of its answer (`7|2015|D|OFF-TOPIC`), and
    reading `fields[0]` took the year's first digit as the verdict. The verdict is the first field
    that is K or D (or spelled out as KEEP/DROP); an echoed year or title never is. No such field
    means no answer.
    """
    for index, field in enumerate(fields):
        verdict = {"KEEP": "K", "DROP": "D"}.get(field.strip().upper(), field.strip().upper())
        if verdict in {"K", "D"}:
            tag = _screen_role(fields[index + 1]) if index + 1 < len(fields) else ""
            return [verdict, tag]
    return None


def _abstract_answer(fields: list[str]) -> list[str] | None:
    """`[relevance, role, note]` from an abstract-scoring row, found by CONTENT, or None.

    Anchored on the ROLE, the one field whose vocabulary is closed: the score is the field just
    before it and the note the one just after, so echoed year/title/venue/cites columns in front
    are skipped (DR-164). A score outside 0-10 is not a score — the year that became 10/10 was
    exactly that — so the row is rejected rather than clamped.

    A row with no recognisable role still answers if its FIRST field is an in-range score: a
    sloppy role word must not discard a good score and re-buy it every run, and an echoed year
    can never pass that range test.
    """
    for index, field in enumerate(fields):
        role = _screen_role(field)
        if not role or index == 0:
            continue
        try:
            relevance = float(fields[index - 1].strip())
        except ValueError:
            continue
        if not 0.0 <= relevance <= 10.0:
            continue
        note = fields[index + 1] if index + 1 < len(fields) else ""
        return [fields[index - 1].strip(), role, note]
    try:
        relevance = float(fields[0].strip())
    except ValueError:
        return None
    if not 0.0 <= relevance <= 10.0:
        return None
    return [fields[0].strip(), "", fields[2] if len(fields) > 2 else ""]


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
        min_fields=1, stage="title_triage", normalise=_title_answer)
    audit["reused"] = len(cached_keep)

    verdicts = {id(c): (values.get(i), True) for i, c in enumerate(to_judge, 1)}
    protected = _title_protections(candidates, profile_hash or profile)
    kept: list[dict] = []
    for candidate in candidates:
        if id(candidate) in cached_keep:
            candidate["triage_tag"] = cached_keep[id(candidate)]
            candidate["triage_verdict"] = "K"
            kept.append(candidate)
            continue
        fields, _ = verdicts.get(id(candidate), (None, False))
        # No answer means KEEP: an unjudged paper is uncertainty, and the whole point of the
        # instruction "when uncertain, reply K" is that this stage must not delete on silence.
        verdict = fields[0] if fields else "K"
        tag = fields[1] if fields and len(fields) > 1 else ""
        candidate["triage_verdict"] = verdict
        # A default KEEP is not a verdict either: cached, it would be reused as one forever.
        candidate["triage_unjudged"] = not fields
        if verdict == "D":
            if tag in {"FOUNDATION", "SURVEY"}:
                protected[id(candidate)] = max(50, protected.get(id(candidate), 0))
            if id(candidate) not in protected:
                continue
            candidate["screen_protected"] = True
        candidate["triage_tag"] = tag
        kept.append(candidate)

    capped = _cap_with_protections(kept, MAX_AFTER_TITLE_TRIAGE, protected)
    audit["kept"] = len(capped)          # what actually goes forward, not the pre-cap count
    audit["dropped_by_cap"] = len(kept) - len(capped)
    audit["protected"] = sum(1 for candidate in capped if id(candidate) in protected)
    audit["audit_sample"] = sum(
        1 for candidate in capped if protected.get(id(candidate)) == 10)
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
        # The role check also retires DR-164's poisoned entries: a misparsed row cached the year
        # as relevance 10 and the paper's TITLE as its role, and reusing those would carry the
        # bug past its fix for as long as the profile stays unchanged.
        if (isinstance(cached, dict) and cached.get("model") == cheap_model
                and cached.get("profile_hash") == profile_hash
                and isinstance(cached.get("relevance"), int)
                and 0 <= cached["relevance"] <= 10
                and _screen_role(cached.get("role") or "")):
            candidate["relevance"] = float(cached["relevance"])
            candidate["role"] = _screen_role(cached.get("role") or "")
            candidate["screen_note"] = str(cached.get("note") or "")[:160]
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
        min_fields=2, stage="abstract_scoring", normalise=_abstract_answer)
    audit["reused"] = reused

    for index, candidate in enumerate(candidates_to_score, 1):
        fields = values.get(index) or []
        candidate["relevance"] = _clamped_score(fields[0] if fields else None)
        candidate["role"] = fields[1] if len(fields) > 1 else ""
        note = fields[2].strip() if len(fields) > 2 else ""
        candidate["screen_note"] = note[:160]
        # The neutral 5.0 an unanswered paper ranks on is a placeholder, not a judgement, and must
        # not be cached as one: the ledger would replay it on every rerun instead of asking again.
        candidate["screen_unjudged"] = not fields
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
    # Out of range is a parse slip, not an emphatic score: clamping turned an echoed publication
    # year into 10/10 and put ResNet at the top of a DRAM run (DR-164).
    if not 0.0 <= value <= 10.0:
        return 5.0
    return value


def _momentum_term(candidate: dict, cites: int) -> float:
    """Momentum (spec §§3-4): citations per year, log-scaled and capped, for YOUNG papers only.

    The capped log citation term structurally favours old work — a 2019 paper with 600 citations
    maxes it while a six-week-old paper with 40 sits near zero, though the young one is
    accumulating faster. Where the OpenAlex lanes fetched `counts_by_year` (a free select field),
    the velocity is the last two calendar years' actual counts; S2-sourced candidates fall back
    to lifetime count over age. Old papers get nothing here on purpose: their velocity is already
    priced into the citation term, and rewarding it twice would recreate the bias inverted.
    """
    year = candidate.get("year")
    if not isinstance(year, int):
        return 0.0
    now = datetime.now(UTC).year
    # A future year is a provider mis-date (a "forthcoming" journal version): with the age clamp
    # it would turn LIFETIME citations into near-maximum momentum, so it gets nothing instead.
    if year > now or now - year >= MOMENTUM_YOUNG_YEARS:
        return 0.0
    age = max(0.5, now - year + 0.5)      # a paper published this year is ~half a year old
    counts = candidate.get("counts_by_year")
    recent = sum(int(row.get("cited_by_count") or 0)
                 for row in (counts if isinstance(counts, list) else [])
                 if isinstance(row, dict) and isinstance(row.get("year"), int)
                 and row["year"] >= now - 1)
    # counts_by_year rows can lag the count itself; an empty or stale window falls back to the
    # lifetime rate rather than zero, so the same paper scores alike whichever lane found it.
    velocity = recent / min(age, 2.0) if recent > 0 else (cites or 0) / age
    if velocity <= 0:
        return 0.0
    return min(MOMENTUM_CAP, MOMENTUM_SCALE * math.log10(1 + velocity))


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
        # Named `sig`, NOT `significance`: that would shadow the imported module for the whole
        # function body and make `significance.SIGNIFICANT_VERBS` below an UnboundLocalError.
        sig = candidate.get("significance") or {}
        # `.get`, never a subscript: a label added in significance.py must degrade this line to
        # the plain lane wording, not kill a multi-minute run after its LLM money is spent.
        verb = significance.SIGNIFICANT_VERBS.get(sig.get("label", ""))
        if "new_citation" in channels:
            provenance_term += PROVENANCE_BONUS_NEW_CITATION
            if sig.get("significant") and verb:
                # The lane's evidence line (spec §4's output rule): what the citer DID with the
                # reader's paper, in its own words, never just "new relevant paper". The anchor
                # and count come from the significance block — the EDGE that earned the label —
                # not from whichever provenance entry happens to sit first. Inserted at the
                # FRONT: clients render reasons[0], and this line is the one the stage paid for.
                provenance_term += SIGNIFICANT_CITER_BONUS
                anchor = str(sig.get("anchor_title") or "")
                mentions = sig.get("mentions") or 0
                times = f" {mentions}×" if mentions > 1 else ""
                note = str(sig.get("note") or "").rstrip(".")
                line = f"Significant: {verb} “{anchor[:70]}”{times}" if anchor else \
                    f"Significant: {verb} a paper on your reading list{times}"
                reasons.insert(0, f"{line} — {note}" if note else line)
            else:
                anchor = next((p.get("anchor_title") for p in candidate.get("provenance") or []
                               if p.get("channel") == "new_citation" and p.get("anchor_title")),
                              "")
                reasons.append(f"New: has started citing “{anchor[:70]}” from your list" if anchor
                               else "New: has started citing a paper on your reading list")
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
        if "snippet" in channels:
            # The passage IS the evidence (spec §3 lane 3): quote it, never say "relevant".
            passage = next((str(p.get("passage") or "") for p in candidate.get("provenance") or []
                            if p.get("channel") == "snippet" and p.get("passage")), "")
            if passage:
                reasons.append(f"Its full text says: “{passage[:120].rstrip()}…”")
        if "s2_recommendations" in channels:
            reasons.append("Recommended from your reading list’s citation patterns"
                           + (" (steered away from papers you dismissed)"
                              if any(p.get("negatives") for p in candidate.get("provenance") or []
                                     if p.get("channel") == "s2_recommendations") else ""))
        # Corpus connectivity (spec §4): distinct reading-list papers this candidate's edges
        # reach. Deterministic and explainable — Litmaps surfaces the same number as "Map
        # Connectivity" but never scores on it.
        anchors = {p.get("anchor_slug") for p in candidate.get("provenance") or []
                   if p.get("channel") in ("cites", "new_citation") and p.get("anchor_slug")}
        connectivity_term = 0.0
        if len(anchors) > 1:
            connectivity_term = min(CONNECTIVITY_BONUS_CAP,
                                    CONNECTIVITY_BONUS_STEP * (len(anchors) - 1))
            reasons.append(f"Connects to {len(anchors)} papers on your reading list")

        momentum_term = _momentum_term(candidate, cites)
        if cites >= 100:
            reasons.append(f"~{cites:,} citations overall — a well-established work")

        relevance = float(candidate.get("relevance") or 0.0)
        out.append({
            **candidate,
            "relevance": relevance,
            "credibility": 0.0,
            "score": round(relevance + citation_term + provenance_term
                           + connectivity_term + momentum_term, 3),
            # 5, up from 4: the connectivity line lands on exactly the multi-channel candidates
            # that already carry a screen note plus one reason per channel, where a cap of 4
            # cut the very line that distinguishes them.
            "reasons": list(dict.fromkeys(r for r in reasons if r))[:5],
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
    wide_recall_fn: WideRecallFn | None = None,
    should_cancel: Callable[[], bool] | None = None,
    should_skip: Callable[[], bool] | None = None,
) -> Iterator[dict]:
    """Run the multi-source pipeline, resuming the last complete stage after a process restart."""
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
    default_citations = citations_fn is None or citations_fn is citations.annotate_nodes
    citations_fn = citations_fn or citations.annotate_nodes
    default_authorships = (
        authorships_fn is openalex.annotate_discovery_authorships
        or (authorships_fn is None and not injected_search)
    )
    if authorships_fn is None:
        authorships_fn = (
            (lambda _candidates: None)
            if injected_search
            else openalex.annotate_discovery_authorships
        )

    cheap_llm = cheap_llm_fn or _cheap_llm
    papers = _reading_list(library_fn)
    cancelled = should_cancel or (lambda: False)
    skip_requested = should_skip or (lambda: False)

    def stage_skip() -> Callable[[], bool]:
        """Latch a one-shot registry request for the lifetime of one skippable stage.

        Provider workers may ask concurrently. Once one call observes the request, every later
        boundary in this stage sees True without consuming a future skip.
        """
        observed = False
        lock = threading.Lock()

        def check() -> bool:
            nonlocal observed
            with lock:
                if not observed:
                    observed = skip_requested()
                return observed

        return check
    checkpoint_key = discovery_checkpoint.fingerprint(
        goals, papers, pipeline=CHECKPOINT_PIPELINE)
    checkpoint = discovery_checkpoint.load(checkpoint_key)
    state = dict(checkpoint.get("state") or {}) if checkpoint else {}
    stage = checkpoint.get("stage") if checkpoint else ""

    # Bound before the resume branch: a run that resumes from a checkpoint skips recall entirely,
    # and the commit below must still have something to read. A resumed run legitimately has
    # nothing to commit — its recall already happened in the attempt that checkpointed, which
    # deliberately did not record the sweep either (see `forward_delta`), so those citers stay
    # reportable until a run actually finishes.
    pending_forward: dict = {}
    if checkpoint:
        focus = str(state["focus"])
        queries = list(state["queries"])
        plan_error = str(state.get("plan_error") or "")
        lexical_error = str(state.get("lexical_error") or "")
        ledger = state["ledger"]
        candidates = list(state["candidates"])
        recall_audit = state["recall_audit"]
        frontier_updates = list(state.get("frontier_updates") or [])
        yield {"type": "queries", "focus": focus, "queries": queries, "resumed": True}
        if cancelled():
            return
        yield {"type": "library", "papers": len(papers), "resumed": True}
        if cancelled():
            return
        yield {"type": "gathered", "count": len(candidates), "resumed": True}
        if cancelled():
            return
    else:
        plan_error = ""
        try:
            focus, queries = generate_queries(goals, model, llm_fn, papers=papers)
        except DiscoveryError as e:
            # Query planning is a convenience. The reader's own words are a usable fallback and
            # neither grounded nor topic recall depends on a valid JSON plan.
            plan_error = str(e)
            focus = goals[:120]
            queries = [{"query": goals, "search_terms": goals, "phase": "broad",
                        "rationale": "Searching your words directly"}]
            log.warning("query planning failed (%s); searching the goals verbatim", plan_error)
        yield {"type": "queries", "focus": focus, "queries": queries}
        if cancelled():
            return

        lexical: list[dict] = []
        lexical_error = ""
        skip_search = stage_skip()
        try:
            for event in collect_candidates(
                    queries, search_fn, semantic_search_fn, should_skip=skip_search):
                if event["type"] == "candidates":
                    lexical = event["candidates"]
                else:
                    yield event
                    if cancelled():
                        return
        except Exception as e:  # noqa: BLE001 — one lane must not kill the run
            lexical_error = str(e) if isinstance(e, DiscoveryError) else (
                f"{type(e).__name__}: {str(e)[:120]}")
            log.info("lexical lane failed (%s); continuing on other channels", lexical_error)

        if lexical:
            yield {"type": "finds", "stage": "searching",
                   "items": _preview(lexical, focus=f"{focus} {goals}", provisional=True)}
            if cancelled():
                return

        yield {"type": "library", "papers": len(papers)}
        if cancelled():
            return
        ledger = discovery_ledger.load()
        grounded, recall_audit = _grounded_candidates(
            papers, recall_fn=recall_fn, should_cancel=cancelled)
        anchors = list(recall_audit.pop("_anchors", []))
        pending_forward = recall_audit.pop("_pending_forward", {})
        wide, wide_audit, frontier_updates = _wide_candidates(
            anchors, queries, ledger, wide_recall_fn=wide_recall_fn,
            allow_network=not injected_search, should_cancel=cancelled)
        # Provider lanes check cancellation between pages and may return a useful partial batch.
        # It is NOT a completed recall stage: checkpointing it would make the next explicit run
        # resume past the pages whose frontiers were deliberately left unadvanced.
        if cancelled():
            return
        recall_audit["wide"] = wide_audit
        recall_audit["degraded"] = [
            *recall_audit.get("degraded", []), *wide_audit.get("degraded", [])]

        # The durable reservoir participates in every incremental run. Without it, advancing a
        # topic frontier would make yesterday's candidates impossible to reconstruct today.
        candidates = discovery_recall.merge_candidates(
            [discovery_ledger.reservoir(ledger), grounded, lexical, wide],
            identity_keys=_identity_keys, merge_fn=_merge_candidate)
        if not candidates:
            raise DiscoveryError(lexical_error or (
                "No papers found. Try rephrasing the goals with more specific terms."))
        today = _now()[:10]
        for candidate in candidates:
            discovery_ledger.observe(
                ledger, _candidate_key(candidate), candidate,
                (candidate.get("channels") or ["lexical"])[0], today)
        state.update({
            "focus": focus, "queries": queries, "plan_error": plan_error,
            "lexical_error": lexical_error, "ledger": ledger, "candidates": candidates,
            "recall_audit": recall_audit, "frontier_updates": frontier_updates,
        })
        discovery_checkpoint.save(checkpoint_key, "recall", state)
        stage = "recall"
        yield {"type": "gathered", "count": len(candidates)}
        if cancelled():
            return

    profile_hash = discovery_ledger.profile_hash(goals, CHEAP_MODEL)
    today = _now()[:10]
    if discovery_checkpoint.STAGES.index(stage) < discovery_checkpoint.STAGES.index("gated"):
        survivors, gate_counts = discovery_gate.apply_gate(
            candidates, known_papers=papers, hidden_filter=filter_hidden,
            titles_match=graph.titles_match, ledger=ledger, cheap_model=CHEAP_MODEL,
            profile=profile_hash, today_year=datetime.now(UTC).year, identity_keys=_identity_keys)
        state.update({"survivors": survivors, "gate_counts": gate_counts})
        discovery_checkpoint.save(checkpoint_key, "gated", state)
        stage = "gated"
    else:
        survivors = list(state["survivors"])
        gate_counts = state["gate_counts"]
    yield {"type": "gated", "kept": len(survivors), "counts": gate_counts}
    if cancelled():
        return

    # Early finds. These come from the grounded channels, so they need no model to be worth
    # showing: a paper reached by forward-citation from the reader's own library, or already
    # ranked by their reference graph, is interesting on provenance alone. Surfacing them here —
    # seconds in, rather than after the whole funnel — is what makes a multi-minute run feel like
    # it is finding things rather than hanging.
    yield {"type": "finds", "stage": "grounded",
           "items": _preview(survivors, focus=f"{focus} {goals}", provisional=True)}
    if cancelled():
        return

    profile = _profile_text(goals, papers)
    yield {"type": "triage", "count": len(survivors)}
    if cancelled():
        return
    gated = survivors
    if discovery_checkpoint.STAGES.index(stage) < discovery_checkpoint.STAGES.index("triaged"):
        triaged, triage_audit = triage_titles(
            gated, profile, cheap_llm, ledger=ledger,
            cheap_model=CHEAP_MODEL, profile_hash=profile_hash)
        _record_verdicts(ledger, triaged, gated, kind="cheap", model=CHEAP_MODEL,
                         profile=profile_hash, today=today)
        state.update({"ledger": ledger, "triaged": triaged, "triage_audit": triage_audit})
        discovery_checkpoint.save(checkpoint_key, "triaged", state)
        stage = "triaged"
    else:
        triaged = list(state["triaged"])
        triage_audit = state["triage_audit"]

    yield {"type": "finds", "stage": "screened",
           "items": _preview(triaged, focus=f"{focus} {goals}", provisional=True)}
    if cancelled():
        return

    yield {"type": "citations", "count": len(triaged)}
    if cancelled():
        return
    skip_citations = stage_skip()
    if not skip_citations():
        if default_citations:
            add_citation_counts(
                triaged,
                lambda nodes, cache: citations_fn(
                    nodes, cache, should_stop=skip_citations),
            )
        else:
            # Injected functions are intentionally kept on their established two-argument
            # contract. They are one opaque provider boundary in tests/extensions.
            add_citation_counts(triaged, citations_fn)
        skip_citations()  # consume a request that arrived during the final in-flight call

    yield {"type": "scoring", "count": len(triaged)}
    if cancelled():
        return
    if discovery_checkpoint.STAGES.index(stage) < discovery_checkpoint.STAGES.index("scored"):
        all_scored, abstract_audit = score_abstracts(
            triaged, profile, cheap_llm, ledger=ledger,
            cheap_model=CHEAP_MODEL, profile_hash=profile_hash)
        all_scored.sort(key=lambda c: float(c.get("relevance") or 0.0), reverse=True)
        # The false-negative denominator is every protected title DROP we paid to abstract-score,
        # not merely the final 60. Computing after the final cap made the audit look healthier by
        # silently excluding reviewed drops that ranked below the display boundary.
        # An unanswered drop sits at the neutral 5.0 and can never count as a false negative, so
        # including it would only dilute the rate.
        audited_drops = [candidate for candidate in all_scored
                         if candidate.get("screen_protected")
                         and candidate.get("triage_verdict") == "D"
                         and not candidate.get("screen_unjudged")]
        false_negatives = [candidate for candidate in audited_drops
                           if float(candidate.get("relevance") or 0) >= 7]
        abstract_audit["title_drop_audit"] = {
            "reviewed": len(audited_drops),
            "false_negatives": len(false_negatives),
            "rate": (round(len(false_negatives) / len(audited_drops), 4)
                     if audited_drops else None),
        }
        # Cache every score we bought, including candidates below the final display cap. Otherwise
        # an unchanged run re-pays to score up to 340 rows the ledger deliberately forgot.
        _record_verdicts(ledger, all_scored, triaged, kind="abstract", model=CHEAP_MODEL,
                         profile=profile_hash, today=today)
        scored = all_scored[:MAX_AFTER_ABSTRACTS]
        state.update({"ledger": ledger, "scored": scored,
                      "abstract_audit": abstract_audit})
        discovery_checkpoint.save(checkpoint_key, "scored", state)
        stage = "scored"
    else:
        scored = list(state["scored"])
        abstract_audit = state["abstract_audit"]

    # The ranked reel first, BEFORE the significance batches: this preview used to appear the
    # moment scoring finished, and a new paid stage must not put a silent multi-batch gap in
    # front of it. The final list below re-ranks with the significance evidence folded in.
    ranked_so_far = blend_and_rank(scored)
    yield {"type": "finds", "stage": "ranked", "items": _preview(ranked_so_far, focus=focus)}
    if cancelled():
        return

    # Lane-1 significance (DR-052 PR 3): classify HOW the new citers cite, on the survivors
    # only. Runs on both checkpoint branches — a resumed run skipped the paid scoring above,
    # and this stage's ledger cache (keyed on the context sentences, not the profile) plus the
    # checkpoint re-save below make a repeat classification free.
    def _record_significance(candidate: dict, *, label: str, note: str, model: str,
                             contexts_hash: str) -> None:
        entry = discovery_ledger.get(ledger, _candidate_key(candidate))
        if entry is not None:
            discovery_ledger.record_citation_significance(
                entry, label=label, note=note, model=model,
                contexts_hash=contexts_hash, today=today)

    significance_audit = significance.classify(
        scored, cheap_llm, ledger=ledger, cheap_model=CHEAP_MODEL,
        get_entry=discovery_ledger.get, record_entry=_record_significance)
    # Re-save the scored checkpoint with the classified candidates and their ledger records:
    # the classification was PAID for, and a Stop/crash between here and the final persist
    # would otherwise resume from a ledger that never saw it and buy it all again — the exact
    # gap checkpoints exist for, and what triage/scoring both do at their own boundaries.
    state.update({"ledger": ledger, "scored": scored})
    discovery_checkpoint.save(checkpoint_key, "scored", state)
    if cancelled():
        return

    yield {"type": "evidence", "count": len(scored)}
    if cancelled():
        return
    skip_evidence = stage_skip()
    if not skip_evidence():
        if default_authorships:
            authorships_fn(scored, should_stop=skip_evidence)
        else:
            authorships_fn(scored)
        skip_evidence()  # do not accidentally carry a late request into a future run/stage

    ranked = blend_and_rank(scored)
    discovery_ledger.apply_frontier_updates(ledger, frontier_updates)
    ledger_saved = _persist_ledger(ledger)
    # Only now are this run's finds durable, so only now is it safe to remember which citers we
    # swept. Earlier and a stopped run would suppress them forever; later is fine, because a
    # repeat report merges harmlessly into the ledger reservoir.
    _commit_forward_delta(pending_forward)

    funnel = {"gathered": len(candidates), **gate_counts,
              "after_triage": triage_audit.get("kept", 0), "surfaced": len(ranked)}
    degraded = [*triage_audit.get("degraded", []), *abstract_audit.get("degraded", []),
                *recall_audit.get("degraded", []),
                # A dead significance stage must not read as "nothing significant cited you
                # this week" — same reasoning as the lexical_error entry below.
                *significance_audit.get("degraded", [])]
    if plan_error:
        degraded.append(f"Query planning failed ({plan_error}); searched your words directly")
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
                  "title_triage": triage_audit, "abstract_scoring": abstract_audit,
                  "citation_significance": significance_audit},
        "degraded": degraded,
        "top_n": TOP_SUGGESTIONS,
        "suggestions": ranked,
        "generated_at": _now(),
    }}
    if ledger_saved:
        # The driver persists the yielded result before it asks the generator for another event.
        # Reaching this line therefore proves result + ledger are both durable.
        discovery_checkpoint.clear()


#: How many live finds ride on the job snapshot. The client shows only two at a time and scrolls
#: through them, so this is the length of the reel rather than the number on screen — too few and
#: the loop visibly repeats. Still bounded: it is polled repeatedly for the length of a run, and
#: each entry is trimmed to the handful of fields the row renders.
PREVIEW_FINDS = 12


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
                1 if "new_citation" in channels else 0,
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
    entries = [e for e in (candidate.get("provenance") or []) if isinstance(e, dict)]
    # By channel STRENGTH, not by position. `merge_candidates` concatenates provenance in group
    # order and the ledger reservoir is group 0, so a candidate already known from a `cites` run
    # carries that entry first — first-entry-wins would then show the weaker line for a paper
    # whose news is that it just started citing you, contradicting the preview's own tiebreak.
    for entry in entries:
        if entry.get("channel") == "new_citation":
            title = str(entry.get("anchor_title") or "").strip()
            return (f"New: has started citing “{title[:60]}” from your list" if title
                    else "New: has started citing a paper on your reading list")
    for entry in entries:
        if entry.get("channel") == "cites":
            title = str(entry.get("anchor_title") or "").strip()
            return (f"Cites “{title[:60]}” from your list" if title
                    else "Cites a paper on your reading list")
        if entry.get("channel") == "graph":
            reasons = [str(r) for r in (entry.get("reasons") or []) if r]
            return reasons[0] if reasons else "Ranked by your reference graph"
    channels = set(candidate.get("channels") or [])
    if "new_citation" in channels:
        return "New: has started citing a paper on your reading list"
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


def _commit_forward_delta(pending: dict) -> None:
    """Persist the delta lane's swept citer ids, once the run's results are durable.

    Reloads the substrate rather than reusing the copy recall held: minutes of provider work
    have happened since, and the merge-on-save path only protects sections this writer marked
    — a stale whole document would be the wrong thing to hold. Best-effort by contract: failing
    to remember a sweep costs a repeated report next run, which the ledger reservoir absorbs."""
    if not pending:
        return
    try:
        data = graph_store.load()
        neighbourhood.commit_forward_delta(data, pending)
        if graph_store.pending_changes(data):
            graph_store.save(data)
    except Exception as e:  # noqa: BLE001
        log.warning("could not record the new-citation sweep (%s)", type(e).__name__)


def _grounded_candidates(papers: list, *, recall_fn,
                         should_cancel: Callable[[], bool] | None = None,
                         ) -> tuple[list[dict], dict]:
    """R1+R2+R5, plus the new-citation delta. Injectable as one seam so the suite stays
    network-free."""
    if recall_fn is not None:
        return recall_fn(papers)
    audit: dict = {"anchors": 0, "cites": 0, "graph": 0, "new_citations": 0,
                   "degraded": [], "_anchors": []}
    if not papers:
        return [], audit

    graph_data = graph_store.load()
    from_graph = discovery_recall.graph_recommendations(graph_data)
    audit["graph"] = len(from_graph)

    client = openalex.make_client(timeout=discovery_recall.TIMEOUT_S)
    anchors: list[dict] = []   # bound before the guard: the delta lane below reads it either way
    try:
        anchors = neighbourhood.ensure_anchors(papers, graph_data, client=client)
        audit["_anchors"] = anchors
        audit["anchors"] = len(anchors)
        from_cites = discovery_recall.chase_citations(anchors, client=client)
        audit["cites"] = len(from_cites)
    except Exception as e:  # noqa: BLE001 — an outage must not fail the run
        log.warning("grounded recall stopped early (%s)", type(e).__name__)
        audit["degraded"].append(f"citation chase stopped early ({type(e).__name__})")
        from_cites = []
    finally:
        client.close()

    # Feed the substrate's per-anchor known-citer sets (DR-052 PR 1) — what turns the next
    # forward sweep into a delta instead of a re-query. Deliberately OUTSIDE the guard above:
    # bookkeeping is not worth discarding a successful chase's candidates over, and inside it
    # a corrupt stored entry would have emptied `from_cites` while `audit["cites"]` still
    # claimed a full haul.
    try:
        neighbourhood.record_forward_sweep(graph_data, from_cites)
    except Exception as e:  # noqa: BLE001
        log.warning("could not record the forward sweep (%s)", type(e).__name__)

    # The new-citation lane: newest-first per anchor, minus what the substrate already knows.
    # Distinct from the chase above, which is breadth-first by citation count and re-fetches the
    # same well-cited citers every run — this one answers "what has started citing me since?",
    # and carries the context sentences that say how. Its own guard: an S2 outage costs this
    # lane only, and the OpenAlex-derived candidates still stand.
    #
    # Its swept ids are NOT committed here. They travel with the audit and are written where the
    # ledger is (see `_commit_forward_delta`), because marking a citer known before the run's
    # results are durable would lose it permanently if the reader stops the run.
    try:
        fresh, delta_audit, pending = neighbourhood.forward_delta(
            anchors, papers, graph_data, should_cancel=should_cancel)
        audit["new_citations"] = len(fresh)
        audit["_pending_forward"] = pending
        audit["degraded"].extend(delta_audit.get("degraded") or [])
    except Exception as e:  # noqa: BLE001
        log.warning("the new-citation lane stopped early (%s)", type(e).__name__)
        audit["degraded"].append(
            "Could not check for new citations this run; the next run retries")
        fresh = []

    if graph_store.pending_changes(graph_data):
        try:
            graph_store.save(graph_data)   # anchor ids are free but slow; pay for them once ever
        except Exception:  # noqa: BLE001
            pass

    # Lane 3's seed-based recommendations (DR-052 PR 3b): the reading list as positives, the
    # reader's hides as negatives — the one curated rejection signal the pipeline holds, used
    # to steer recall rather than merely filter it. One POST; its own guard, same as the lanes
    # above: an S2 outage costs this lane only.
    try:
        recommended, rec_audit = discovery_recall.s2_recommendations(papers, load_hidden())
        audit["s2_recommendations"] = len(recommended)
        audit["degraded"].extend(rec_audit.get("degraded") or [])
    except Exception as e:  # noqa: BLE001
        log.warning("library recommendations stopped early (%s)", type(e).__name__)
        recommended = []

    # Delta candidates lead: they are the most specific thing the pipeline knows (a named paper
    # of the reader's, newly cited). `_merge_candidate` dedupes by identity downstream, so a
    # paper both lanes found keeps this lane's provenance and its contexts.
    return [*fresh, *from_cites, *from_graph, *recommended], audit


def _wide_candidates(anchors: list[dict], queries: list[dict], ledger: dict, *,
                     wide_recall_fn: WideRecallFn | None,
                     allow_network: bool, should_cancel: Callable[[], bool]
                     ) -> tuple[list[dict], dict, list[dict]]:
    """R3+R4 behind one injectable seam. Tests with injected providers stay network-free."""
    if wide_recall_fn is not None:
        return wide_recall_fn(anchors, queries, ledger)
    if not allow_network:
        return [], {"topic": {}, "bulk": {}, "degraded": []}, []
    return discovery_recall.wide_recall(
        anchors, queries, frontier=ledger.get("frontier") or {},
        should_cancel=should_cancel)


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
            if candidate.get("triage_unjudged"):
                continue
            discovery_ledger.record_cheap_verdict(
                entry, verdict=(str(candidate.get("triage_verdict") or "")
                                or ("K" if key in kept_keys else "D")),
                tag=str(candidate.get("triage_tag") or ""), model=model,
                profile=profile, today=today)
        elif (key in kept_keys and isinstance(candidate.get("relevance"), (int, float))
              and not candidate.get("screen_unjudged")):
            discovery_ledger.record_abstract_score(
                entry, relevance=int(candidate["relevance"]),
                role=str(candidate.get("role") or ""),
                note=str(candidate.get("screen_note") or ""), model=model,
                profile=profile, today=today)


def _persist_ledger(ledger: dict) -> bool:
    try:
        discovery_ledger.save(ledger)
        return True
    except Exception as e:  # noqa: BLE001 — losing the ledger costs money, never correctness
        log.warning("could not persist the discovery ledger (%s)", type(e).__name__)
        return False
