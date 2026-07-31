"""Stage A: the free, deterministic gate between wide recall and paid screening.

Recall channels are deliberately over-inclusive — that is the point of them. This stage removes
everything that can be rejected without asking a model, so the cheap screen pays only for
candidates whose relevance is genuinely a judgement call. It is pure functions over dicts: no
network, no LLM, no clock beyond an injected `today_year`. That makes it the highest-value test
surface in the pipeline and the one place a regression is cheap to catch.

Two rules encode judgements that are easy to get backwards:

**A citation floor must scale with age.** A 2015 paper with three citations is noise; a 2026 paper
with three citations may be exactly the frontier work the reader wants. A flat floor systematically
deletes recent work, which is the opposite of what a discovery feature is for.

**Corpus-grounded candidates bypass the floor entirely.** A paper reached by forward-citation from
the reader's own library, or ranked by the project's reference graph, already carries evidence
specific to *this* project. A generic popularity threshold knows nothing about that and would
discard the most personal results the pipeline produces.

Every drop is counted by reason. A gate that silently removes 90% of its input is indistinguishable
from a broken recall channel unless the counts say which rule fired.
"""
from __future__ import annotations

import re

from . import discovery_ledger

#: Channels whose candidates carry project-specific evidence and therefore skip the citation floor.
GROUNDED_CHANNELS = frozenset({"cites", "graph"})

#: Publication types that are never a reading suggestion, whatever they cite.
EXCLUDED_TYPES = frozenset({
    "Editorial", "News", "LettersAndComments", "Dataset", "Review",
})

#: Above this age-scaled ceiling the floor stops rising — a 30-year-old paper does not need 60
#: citations to be worth surfacing, and demanding it would delete the foundational literature.
CITATION_FLOOR_CAP = 40
CITATION_FLOOR_PER_YEAR = 2


def _norm_title(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


def known_identity_index(papers: list) -> tuple[set[str], list[str]]:
    """Identities of papers already in the reading list: exact keys, plus titles for fuzzy match.

    Returned as a prepared index rather than re-derived per candidate — this runs against every
    one of thousands of candidates, and `list_papers()` re-parses the reading list.
    """
    exact: set[str] = set()
    titles: list[str] = []
    for paper in papers or []:
        arxiv_id = getattr(paper, "arxiv_id", None) or (
            paper.get("arxiv_id") if isinstance(paper, dict) else None)
        if arxiv_id:
            base = re.sub(r"v\d+$", "", str(arxiv_id).strip(), flags=re.IGNORECASE)
            exact.add(f"arxiv:{base.lower()}")
        doi = getattr(paper, "doi", None) or (
            paper.get("doi") if isinstance(paper, dict) else None)
        if doi:
            exact.add(f"doi:{str(doi).strip().lower()}")
        title = getattr(paper, "title", None) or (
            paper.get("title") if isinstance(paper, dict) else None)
        if title:
            titles.append(_norm_title(title))
    return exact, [t for t in titles if t]


def _already_known(candidate: dict, keys: list[str], exact: set[str],
                   known_titles: list[str], titles_match) -> bool:
    if any(key in exact for key in keys):
        return True
    title = _norm_title(candidate.get("title"))
    if not title:
        return False
    return any(titles_match(title, known) for known in known_titles)


def _passes_citation_floor(candidate: dict, today_year: int) -> bool:
    year = candidate.get("year")
    if not isinstance(year, int) or year <= 0:
        return True                      # unknown age is uncertainty, not grounds for deletion
    if year >= today_year - 1:
        return True                      # too new to have accrued citations at all
    citations = candidate.get("citation_count")
    if not isinstance(citations, int):
        return True                      # unknown impact is uncertainty; the cheap screen decides
    floor = min(CITATION_FLOOR_CAP, CITATION_FLOOR_PER_YEAR * (today_year - year))
    return citations >= floor


def _has_substance(candidate: dict) -> bool:
    if str(candidate.get("abstract") or "").strip():
        return True
    return isinstance(candidate.get("citation_count"), int)


def apply_gate(
    candidates: list[dict],
    *,
    known_papers: list,
    hidden_filter,
    titles_match,
    ledger: dict | None = None,
    cheap_model: str = "",
    profile: str = "",
    today_year: int,
    identity_keys,
) -> tuple[list[dict], dict]:
    """Filter `candidates`, returning survivors and a `{reason: count}` audit block.

    `hidden_filter`, `titles_match` and `identity_keys` are injected rather than imported so this
    module stays free of the pipeline's heavier dependencies and the tests stay pure.
    """
    counts = {"in": len(candidates), "already_known": 0, "hidden": 0, "ledger_dropped": 0,
              "excluded_type": 0, "no_substance": 0, "citation_floor": 0, "out": 0}

    exact, known_titles = known_identity_index(known_papers)

    # Hides are applied through the existing helper so the reader-facing behaviour cannot drift
    # from the Discover screen's own notion of what is hidden.
    visible = hidden_filter(candidates) if hidden_filter else list(candidates)
    counts["hidden"] = len(candidates) - len(visible)

    survivors: list[dict] = []
    for candidate in visible:
        keys = identity_keys(candidate)
        grounded = bool(GROUNDED_CHANNELS & set(candidate.get("channels") or []))

        if _already_known(candidate, keys, exact, known_titles, titles_match):
            counts["already_known"] += 1
            continue

        if ledger is not None and cheap_model:
            entry = next((discovery_ledger.get(ledger, key) for key in keys
                          if discovery_ledger.get(ledger, key)), None)
            if discovery_ledger.cached_cheap_drop(entry, model=cheap_model, profile=profile):
                counts["ledger_dropped"] += 1
                continue

        types = {str(t) for t in (candidate.get("publication_types") or [])}
        if types & EXCLUDED_TYPES:
            counts["excluded_type"] += 1
            continue

        if not grounded and not _has_substance(candidate):
            counts["no_substance"] += 1
            continue

        if not grounded and not _passes_citation_floor(candidate, today_year):
            counts["citation_floor"] += 1
            continue

        survivors.append(candidate)

    counts["out"] = len(survivors)
    return survivors, counts
