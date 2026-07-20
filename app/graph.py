"""Reference graph: builds a citation graph for a project's papers.

Pipeline (with independent provider and full-text caches):
  1. Semantic Scholar resolves paper identity and supplies a fast outbound-reference skeleton.
     These provider calls run inside the background graph job and are cached separately.
  2. One OpenRouter call (DeepSeek V4 Pro by default — see resolve_model) reads the paper's
     cached full text and returns its bibliography as structured references, each with a
     few short verbatim body excerpts ("contexts") showing where/how it's cited, and a
     significance verdict: does the paper substantially use, extend, compare against, or
     depend on that work, as opposed to a passing bibliography mention. This is the one
     expensive step.
  3. Deterministic Python (no LLM, fully unit-testable) merges provider evidence without
     allowing it to assign local significance, then normalizes + dedupes references
     across every paper in the project and matches them against the project's own papers
     by fuzzy title matching, producing the graph's nodes and edges.
  4. Lightweight graph analysis scores each external node for recommendation: how many
     project papers cite it (and how many *significantly*), plus a simple bridge-ness proxy
     (does it connect citing papers that don't otherwise overlap much).

This is a reusable app feature — any project can (re)build its graph from the UI — not a
one-off manual analysis. Re-running after adding one new paper only spends tokens on that
paper; everything else is served from the cache.
"""
from __future__ import annotations

import concurrent.futures
import json
import math
import os
import re
import uuid
from collections import deque
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from difflib import SequenceMatcher

from . import (
    affiliations,
    citations,
    config,
    figures,
    graph_layout,
    graph_store,
    llm,
    openalex,
    prompts,
    retriever,
    semantic_scholar,
    store,
)
from .models import Paper

# ---------- model resolution ----------

DEFAULT_GRAPH_MODEL = "deepseek/deepseek-v4-pro"
_GRAPH_MODEL_INC = ["deepseek", "v4"]
# Same spirit as main.py's FAVORITE_GLOBAL_EXC: keep the match on a real chat/instruct model.
_GRAPH_MODEL_EXC = ["image", "audio", "tts", "embedding", "embed", "vision", "ocr", "search",
                    "guard", "moderation", "rerank", ":free", "distill", "chat", "lite"]

MAX_FULL_TEXT_CHARS = 120_000  # ~30-40k tokens; comfortably covers this corpus's paper sizes
# DeepSeek V4 Pro is a reasoning model: OpenRouter's response carries a separate
# message.reasoning field, and usage.completion_tokens_details.reasoning_tokens confirms
# those tokens count against max_tokens right alongside the visible content. On a large,
# complex paper this can consume the ENTIRE budget on hidden reasoning with zero content
# emitted (finish_reason="length", empty content) — observed live on a 90KB paper at the
# original 8k cap. Two defenses: cap reasoning effort (extraction is a retrieval/formatting
# task, not one that benefits from deep chain-of-thought) via REASONING_EFFORT, and keep a
# generous max_tokens as a safety net regardless. _salvage_references is the last-resort net
# for a response that's still truncated or malformed despite both.
EXTRACTION_MAX_TOKENS = 48_000
REASONING_EFFORT = "low"

# httpx's `timeout=N` is a PER-PHASE budget (connect/read/write/pool each up to N seconds), not
# a total wall-clock cap — and it's measured per socket read, not cumulatively. Observed live:
# a real extraction call ran past its 300s httpx timeout without erroring (some LLM API
# gateways send sparse keep-alive bytes on long-running completions specifically to avoid
# tripping a client's per-read timeout, which resets that clock indefinitely). A single stuck
# paper would otherwise stall an entire project's build. EXTRACTION_HARD_DEADLINE enforces a
# real wall-clock cap via a background thread: if the call hasn't returned by the deadline, we
# give up on it and move on — the abandoned request keeps running in its own thread until it
# finishes (Python can't force-kill a thread) but nothing waits on its result, so it can't
# block the pipeline. max_workers > 1 so one stuck paper's orphaned thread doesn't also block
# submitting the NEXT paper's request while it's still occupying a worker slot.
EXTRACTION_HARD_DEADLINE = 480  # seconds; generous — real successful calls have taken minutes


def extraction_concurrency() -> int:
    """How many papers extract at once during a build (R7.11). Bounded 1–8; the deadline
    executor above has 8 workers, so at 8 every fan worker can still get a deadline slot."""
    try:
        n = int(os.environ.get("RC_GRAPH_EXTRACT_CONCURRENCY", "4"))
    except ValueError:
        n = 4
    return max(1, min(8, n))
_EXTRACT_EXECUTOR = concurrent.futures.ThreadPoolExecutor(
    max_workers=8, thread_name_prefix="graph-extract")


def _call_with_deadline(fn: Callable[[], object], deadline: float):
    """Run fn() in a background thread, bounded by a real wall-clock deadline regardless of
    what any timeout inside fn itself does. Raises concurrent.futures.TimeoutError past the
    deadline; fn keeps running in its thread until it naturally finishes, but nothing waits
    on it. A plain callable (not hardcoded to httpx.post) so this is unit-testable with a
    simple slow/fast function, no network mocking needed."""
    future = _EXTRACT_EXECUTOR.submit(fn)
    return future.result(timeout=deadline)


class GraphError(Exception):
    pass


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def resolve_model() -> str:
    """The extraction model: RC_GRAPH_LLM_MODEL env override, else the newest OpenRouter
    catalogue id matching "DeepSeek V4 Pro" (same family-matching approach as the app's
    favorite-model picker in main.py), else the literal default id. Never raises — a
    catalogue fetch failure just falls back to the default, since extraction can still
    proceed (OpenRouter will 404 at call time if the id is genuinely gone, surfaced per-paper)."""
    override = os.environ.get("RC_GRAPH_LLM_MODEL", "").strip()
    if override:
        return override
    try:
        best = llm.newest_matching(_GRAPH_MODEL_INC, _GRAPH_MODEL_EXC)
    except llm.LLMError:
        return DEFAULT_GRAPH_MODEL
    return best["id"] if best else DEFAULT_GRAPH_MODEL


# ---------- extraction (the one LLM-calling step) ----------


def _extract_json(content: str) -> dict:
    content = content.strip()
    content = re.sub(r"^```(?:json)?\s*", "", content)
    content = re.sub(r"\s*```$", "", content)
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        pass
    m = re.search(r"\{.*\}", content, re.S)  # last resort: outermost {...} if there's chatter
    if m:
        return json.loads(m.group(0))
    raise GraphError("The extraction model did not return valid JSON.")


def _salvage_references(content: str) -> list[dict]:
    """Best-effort recovery when the model's JSON is truncated (hit max_tokens mid-array) or
    has one malformed entry: scan for top-level objects inside the "references" array and
    json.loads each independently, keeping whatever parses and dropping only the broken
    tail/entry. Turns a would-be total loss of an already-paid-for response into a partial
    but usable result. String/escape-aware brace matching, same technique as elsewhere in
    this repo's tooling for scanning code without a real parser."""
    m = re.search(r'"references"\s*:\s*\[', content)
    if not m:
        return []
    i, n = m.end(), len(content)
    out: list[dict] = []
    while i < n:
        while i < n and content[i] not in "{]":
            i += 1
        if i >= n or content[i] == "]":
            break
        start = i
        depth = 0
        in_string = False
        escape = False
        closed = False
        while i < n:
            c = content[i]
            if in_string:
                if escape:
                    escape = False
                elif c == "\\":
                    escape = True
                elif c == '"':
                    in_string = False
            elif c == '"':
                in_string = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    i += 1
                    closed = True
                    break
            i += 1
        if not closed:
            break  # ran off the end mid-object: genuinely truncated, nothing more to salvage
        try:
            obj = json.loads(content[start:i])
            if isinstance(obj, dict):
                out.append(obj)
        except json.JSONDecodeError:
            pass  # one malformed entry shouldn't sink the rest
    return out


def _clean_reference(ref: dict, fallback_index: int) -> dict | None:
    if not isinstance(ref, dict):
        return None
    year = ref.get("year")
    return {
        "index": ref.get("index", fallback_index),
        "raw_text": str(ref.get("raw_text") or "")[:2000],
        "title": str(ref.get("title") or "").strip(),
        "authors": [str(a).strip() for a in (ref.get("authors") or []) if str(a).strip()],
        "venue": str(ref.get("venue") or "").strip(),
        "year": year if isinstance(year, int) else None,
        "arxiv_id": (str(ref["arxiv_id"]).strip() if ref.get("arxiv_id") else None),
        "doi": (str(ref["doi"]).strip() if ref.get("doi") else None),
        "url": (str(ref["url"]).strip() if ref.get("url") else None),
        "confidence": max(0.0, min(1.0, float(ref.get("confidence") or 0.5))),
        "contexts": [str(c).strip() for c in (ref.get("contexts") or []) if str(c).strip()][:4],
        "significant": bool(ref.get("significant")),
        "significance_reason": str(ref.get("significance_reason") or "").strip(),
    }


def extract_references_for_paper(slug: str, title: str, full_text: str, model: str) -> dict:
    """One OpenRouter call: bibliography + contexts + significance for one paper. Returns a
    PaperExtraction dict (graph_store schema). Never raises for LLM/network-shaped failures —
    callers check status/error — so one paper's failure doesn't abort a whole project rebuild."""
    chash = graph_store.content_hash(full_text)

    def _result(status: str, references: list[dict], error: str = "") -> dict:
        return {"slug": slug, "content_hash": chash, "extracted_at": _now(), "model": model,
                "status": status, "references": references, "error": error}

    settings = config.load_settings()
    key = settings.get("openrouter_api_key")
    if not key:
        return _result("error", [], "No OpenRouter API key set.")
    text = (full_text or "").strip()
    if not text:
        return _result("error", [], "No cached full text for this paper.")

    messages = [
        {"role": "system", "content": prompts.get("graph_extraction")},
        {"role": "user", "content": f"Paper title: {title}\n\nFull text:\n\n{text[:MAX_FULL_TEXT_CHARS]}"},
    ]
    # One retry (tries=2) for a transient blip; the hard deadline below bounds total wall-clock
    # regardless, so a stuck call can't consume more than EXTRACTION_HARD_DEADLINE. The llm
    # client raises LLMError on an empty completion, with the reasoning-token exhaustion hint
    # baked in — caught here and turned into this paper's error record (one paper's failure
    # never aborts the whole rebuild).
    # The call runs in _EXTRACT_EXECUTOR (a separate pool), whose threads don't inherit the job's
    # active-project contextvar — so rebind it inside the worker (invariant 2) so llm's usage
    # accounting attributes this paper's spend to the right project.
    pid = config.active_project_id()

    def _do_extract():
        token = config.set_active_project(pid)
        try:
            return llm.complete(messages, model=model, temperature=0.1,
                                max_tokens=EXTRACTION_MAX_TOKENS,
                                reasoning={"effort": REASONING_EFFORT}, timeout=300, tries=2,
                                operation="graph_extraction")
        finally:
            config.reset_active_project(token)

    try:
        content = _call_with_deadline(_do_extract, deadline=EXTRACTION_HARD_DEADLINE)
    except concurrent.futures.TimeoutError:
        return _result("error", [],
                       f"No response after {EXTRACTION_HARD_DEADLINE}s (hard deadline) — the "
                       "request may still be running upstream but this paper is being skipped "
                       "for now; retry later or on the next rebuild.")
    except llm.LLMError as e:
        return _result("error", [], str(e)[:400])

    try:
        note = ""
        try:
            parsed = _extract_json(content)
            refs = parsed.get("references", [])
            if not isinstance(refs, list):
                raise GraphError("'references' was not a list.")
        except (GraphError, json.JSONDecodeError) as parse_err:
            # A bibliography can run to 60+ references with several body-text contexts each,
            # occasionally overrunning even a generous token budget mid-object. Salvage
            # whichever leading references parsed cleanly rather than losing the whole call.
            refs = _salvage_references(content)
            if not refs:
                # Both strict parsing and salvage failed — a genuine data-quality edge case
                # (observed live: some responses are malformed in ways neither handles, e.g.
                # a structural issue before any complete reference object). Attach a content
                # snippet around the reported failure position so this is debuggable from the
                # stored error alone, without needing to re-spend tokens reproducing it.
                pos = getattr(parse_err, "pos", None)
                snippet = (f" | near char {pos}: ...{content[max(0, pos - 80):pos + 80]!r}..."
                          if isinstance(pos, int) else f" | content starts: {content[:200]!r}")
                raise GraphError(f"{parse_err}{snippet}") from parse_err
            note = f"Response was malformed/truncated; recovered {len(refs)} reference(s) via salvage."

        cleaned = [c for i, r0 in enumerate(refs, 1)
                   if (c := _clean_reference(r0, i)) is not None]
        if not cleaned:
            raise GraphError("No parseable references in the model's response.")
        return _result("done", cleaned, note)
    except (GraphError, KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError) as e:
        return _result("error", [], str(e)[:400])


# ---------- normalization + matching (no LLM; deterministic + unit-testable) ----------

def _norm_title(title: str) -> str:
    t = (title or "").lower().strip()
    t = re.sub(r"[^a-z0-9 ]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def titles_match(a: str, b: str, threshold: float = 0.86) -> bool:
    na, nb = _norm_title(a), _norm_title(b)
    if not na or not nb:
        return False
    if na == nb:
        return True
    return SequenceMatcher(None, na, nb).ratio() >= threshold


def external_ref_key(ref: dict) -> str:
    """Stable dedupe key for an external reference: prefer arxiv_id/doi (unambiguous), else
    fall back to a normalized title. Two references with slightly different bibliography
    formatting but the same arXiv id or title collapse to one external node."""
    if ref.get("arxiv_id"):
        return f"arxiv:{ref['arxiv_id'].strip().lower()}"
    if ref.get("doi"):
        return f"doi:{ref['doi'].strip().lower()}"
    nt = _norm_title(ref.get("title") or "")
    if nt:
        return f"title:{nt}"
    return f"raw:{_norm_title(ref.get('raw_text') or '')[:80]}"


def external_ref_keys(ref: dict) -> list[str]:
    """Every usable identity alias, strongest first, for cross-source deduplication."""
    keys: list[str] = []
    if ref.get("arxiv_id"):
        arxiv = re.sub(
            r"v\d+$", "", str(ref["arxiv_id"]).strip().lower(), flags=re.IGNORECASE
        )
        keys.append(f"arxiv:{arxiv}")
    if ref.get("doi"):
        keys.append(f"doi:{str(ref['doi']).strip().lower()}")
    title = _norm_title(ref.get("title") or "")
    if title:
        keys.append(f"title:{title}")
    return list(dict.fromkeys(keys)) or [external_ref_key(ref)]


def _identifiers_conflict(ref: dict, node: dict) -> bool:
    for field in ("arxiv_id", "doi"):
        left = str(ref.get(field) or "").strip().lower()
        right = str(node.get(field) or "").strip().lower()
        if field == "arxiv_id":
            left = re.sub(r"v\d+$", "", left, flags=re.IGNORECASE)
            right = re.sub(r"v\d+$", "", right, flags=re.IGNORECASE)
        if left and right and left != right:
            return True
    return False


def match_project_paper(ref: dict, papers: list[Paper]) -> str | None:
    """The slug of the in-project paper this reference points to, if any."""
    title = ref.get("title") or ""
    for p in papers:
        if ref.get("arxiv_id") and p.arxiv_id:
            ref_arxiv = re.sub(r"v\d+$", "", str(ref["arxiv_id"]), flags=re.IGNORECASE)
            paper_arxiv = re.sub(r"v\d+$", "", p.arxiv_id, flags=re.IGNORECASE)
            if ref_arxiv.lower() == paper_arxiv.lower():
                return p.slug
            # Conflicting strong identity is authoritative for this candidate: an identical
            # or fuzzy-matching title must not turn a different paper into an in-project edge.
            continue
        if titles_match(title, p.title):
            return p.slug
    return None


def semantic_scholar_source_key(paper: Paper) -> str:
    identifier = semantic_scholar.paper_identifier(arxiv_id=paper.arxiv_id)
    return identifier or f"TITLE:{_norm_title(paper.title)}"


def _graph_retrieved_text(data: dict, paper: Paper) -> str:
    record = graph_store.get_retrieval(data, paper.slug) or {}
    if (
        record.get("status") != "done"
        or record.get("source_key") != semantic_scholar_source_key(paper)
    ):
        return ""
    return graph_store.read_retrieved_text(paper.slug)


def fetch_semantic_scholar_metadata(paper: Paper) -> dict:
    """Resolve one source paper and fetch its outbound references.

    This is called only from the project-bound graph background job. It deliberately returns
    provider evidence without assigning the project's full-text significance verdict.
    """
    source_key = semantic_scholar_source_key(paper)
    identifier = semantic_scholar.paper_identifier(arxiv_id=paper.arxiv_id)
    resolved: dict = {
        "paper_id": identifier,
        "title": paper.title,
        "external_ids": {"ArXiv": paper.arxiv_id} if paper.arxiv_id else {},
    }
    if not identifier:
        match = semantic_scholar.resolve_paper(paper.title)
        if not match or not titles_match(str(match.get("title") or ""), paper.title):
            return {
                "status": "not_found", "source_key": source_key, "fetched_at": _now(),
                "paper": None, "references": [], "error": "",
            }
        identifier = str(match.get("paperId") or "").strip()
        if not identifier:
            return {
                "status": "not_found", "source_key": source_key, "fetched_at": _now(),
                "paper": None, "references": [], "error": "",
            }
        resolved = {
            "paper_id": identifier,
            "title": str(match.get("title") or paper.title),
            "external_ids": match.get("externalIds") if isinstance(match.get("externalIds"), dict) else {},
        }
    return {
        "status": "done", "source_key": source_key, "fetched_at": _now(),
        "paper": resolved, "references": semantic_scholar.references(identifier), "error": "",
    }


def _references_match(local: dict, provider: dict) -> bool:
    for field in ("arxiv_id", "doi"):
        left = str(local.get(field) or "").strip().lower()
        right = str(provider.get(field) or "").strip().lower()
        if left and right:
            if field == "arxiv_id":
                left = re.sub(r"v\d+$", "", left, flags=re.IGNORECASE)
                right = re.sub(r"v\d+$", "", right, flags=re.IGNORECASE)
            return left == right
    return titles_match(str(local.get("title") or ""), str(provider.get("title") or ""))


def _provider_evidence(ref: dict) -> dict:
    return {
        "paper_id": ref.get("paper_id"),
        "contexts": list(ref.get("contexts") or []),
        "intents": list(ref.get("intents") or []),
        "is_influential": bool(ref.get("is_influential")),
    }


def merge_reference_sources(
    papers: list[Paper],
    extractions: dict[str, dict],
    provider_metadata: dict[str, dict],
) -> dict[str, dict]:
    """Merge provider identity/evidence into copies of cached full-text extractions.

    Provider-only references become graph edges, but only a full-text reference can carry the
    project-specific `significant` verdict. Neither source cache is mutated.
    """
    combined: dict[str, dict] = {}
    for paper in papers:
        local_extraction = extractions.get(paper.slug) or {}
        local_done = local_extraction.get("status") == "done"
        refs: list[dict] = []
        if local_done:
            for original in local_extraction.get("references") or []:
                if isinstance(original, dict):
                    refs.append({
                        **original,
                        "authors": list(original.get("authors") or []),
                        "contexts": list(original.get("contexts") or []),
                        "_provenance": ["full_text"],
                    })

        provider_record = provider_metadata.get(paper.slug) or {}
        provider_refs = (
            provider_record.get("references") or []
            if provider_record.get("status") == "done"
            else []
        )
        used_provider: set[int] = set()
        for local_ref in refs:
            for index, provider_ref in enumerate(provider_refs):
                if index in used_provider or not isinstance(provider_ref, dict):
                    continue
                if not _references_match(local_ref, provider_ref):
                    continue
                used_provider.add(index)
                local_ref["_provenance"].append("semantic_scholar")
                local_ref["_provider_evidence"] = {
                    "semantic_scholar": _provider_evidence(provider_ref)
                }
                for field in ("arxiv_id", "doi", "url", "venue", "year"):
                    if not local_ref.get(field) and provider_ref.get(field):
                        local_ref[field] = provider_ref[field]
                if not local_ref.get("authors") and provider_ref.get("authors"):
                    local_ref["authors"] = list(provider_ref["authors"])
                for context in provider_ref.get("contexts") or []:
                    local_ref.setdefault("contexts", [])
                    if context not in local_ref["contexts"]:
                        local_ref["contexts"].append(context)
                local_ref["contexts"] = local_ref.get("contexts", [])[:4]
                break

        for index, provider_ref in enumerate(provider_refs):
            if index in used_provider or not isinstance(provider_ref, dict):
                continue
            refs.append({
                **provider_ref,
                "significant": False,
                "significance_reason": "",
                "confidence": 0.5,
                "raw_text": "",
                "_provenance": ["semantic_scholar"],
                "_provider_evidence": {
                    "semantic_scholar": _provider_evidence(provider_ref)
                },
            })

        if refs or local_done:
            combined[paper.slug] = {"status": "done", "references": refs}
    return combined


# ---------- graph construction (pure function of cached extractions; no LLM) ----------

def build_nodes_and_edges(papers: list[Paper], extractions: dict[str, dict]) -> tuple[list[dict], list[dict]]:
    """papers: the project's papers. extractions: slug -> PaperExtraction dict (graph_store
    schema, status='done' entries only meaningfully contribute edges). Recomputable for free
    whenever matching/analysis logic changes, without spending any tokens."""
    project_slugs = {p.slug for p in papers}

    nodes: dict[str, dict] = {}
    for p in papers:
        nodes[p.slug] = {
            "id": p.slug, "kind": "project", "slug": p.slug, "title": p.title,
            # The reading-list arXiv id rides along so citations.annotate_nodes can batch-fetch
            # this paper's citation count (the semantic Y axis) and _year_of can date it; the
            # entry's own year (U.17/U.18) dates non-arXiv papers on the timeline X axis too.
            "authors": [], "venue": "", "year": p.year, "arxiv_id": p.arxiv_id or None,
            "doi": None, "url": None,
            "provenance": ["reading_list"],
            "group": p.group, "list_status": p.list_status,
            "cited_by_project_count": 0, "significant_cited_by_count": 0, "cites_count": 0,
        }

    # Keyed by (source, target): a paper occasionally cites the same work via two separate
    # bibliography entries (e.g. an arXiv preprint listed alongside its conference version,
    # or just noisy extraction) that both resolve to the same target via fuzzy matching. Two
    # raw references shouldn't become two edges in the graph — merge them into one citation
    # relationship, OR-ing significance and unioning contexts, so the visualization doesn't
    # show a paper "citing itself twice" and the citation counts reflect distinct relationships.
    edge_by_pair: dict[tuple[str, str], dict] = {}
    external_key_to_id: dict[str, str] = {}

    for slug, extraction in extractions.items():
        if slug not in project_slugs or extraction.get("status") != "done":
            continue
        for ref in extraction.get("references", []):
            provenance = list(dict.fromkeys(ref.get("_provenance") or ["full_text"]))
            full_text_verified = "full_text" in provenance
            target_slug = match_project_paper(ref, papers)
            if target_slug and target_slug != slug:
                target_id = target_slug
                # A project paper the reading list can't date (no arXiv id, no year comment)
                # is often dated by the bibliographies that cite it — fill the gap so the
                # timeline X axis can place it (first mention wins, like external nodes).
                ref_year = ref.get("year")
                if nodes[target_slug].get("year") is None and isinstance(ref_year, int):
                    nodes[target_slug]["year"] = ref_year
            else:
                keys = external_ref_keys(ref)
                key = keys[0]
                # An exact strong alias wins even if another provider identifier is noisy.
                # Only title-only reuse needs the conflict veto.
                target_id = next((
                    external_key_to_id[alias]
                    for alias in keys
                    if not alias.startswith("title:") and alias in external_key_to_id
                ), None)
                if target_id is None:
                    target_id = next((
                        candidate
                        for alias in keys
                        if alias.startswith("title:")
                        and (candidate := external_key_to_id.get(alias)) is not None
                        and not _identifiers_conflict(ref, nodes[candidate])
                    ), None)
                if not target_id:
                    target_id = f"ext:{key}"
                    nodes[target_id] = {
                        "id": target_id, "kind": "external", "slug": None,
                        "title": ref.get("title") or (ref.get("raw_text", "")[:120] or "Untitled reference"),
                        "authors": ref.get("authors", []), "venue": ref.get("venue", ""),
                        "year": ref.get("year"), "arxiv_id": ref.get("arxiv_id"),
                        "doi": ref.get("doi"), "url": ref.get("url"),
                        "provenance": list(provenance),
                        "group": None, "list_status": None,
                        "cited_by_project_count": 0, "significant_cited_by_count": 0, "cites_count": 0,
                    }
                else:
                    ext_node = nodes[target_id]  # fill gaps opportunistically from a richer mention
                    for f in ("venue", "year", "arxiv_id", "doi", "url"):
                        if not ext_node.get(f) and ref.get(f):
                            ext_node[f] = ref.get(f)
                    if not ext_node.get("authors") and ref.get("authors"):
                        ext_node["authors"] = ref.get("authors")
                    for source in provenance:
                        if source not in ext_node["provenance"]:
                            ext_node["provenance"].append(source)
                for alias in keys:
                    external_key_to_id.setdefault(alias, target_id)

            if target_id == slug:
                continue  # a paper "citing itself" via a fuzzy-matched title glitch — skip

            pair = (slug, target_id)
            significant = full_text_verified and bool(ref.get("significant"))
            reason = ref.get("significance_reason", "") if full_text_verified else ""
            contexts = ref.get("contexts", [])
            provider_evidence = ref.get("_provider_evidence") or {}
            existing = edge_by_pair.get(pair)
            if existing is None:
                edge_by_pair[pair] = {
                    "source": slug, "target": target_id,
                    "significant": significant,
                    "reason": reason,
                    "contexts": list(contexts),
                    "confidence": ref.get("confidence", 0.5),
                    "raw_text": ref.get("raw_text", ""),
                    "provenance": provenance,
                    "full_text_verified": full_text_verified,
                    "provider_evidence": provider_evidence,
                }
            else:
                # Prefer the significant verdict/reason if either mention was significant;
                # union contexts (deduped, capped) rather than picking one arbitrarily.
                if significant and not existing["significant"]:
                    existing["reason"] = reason
                existing["significant"] = existing["significant"] or significant
                existing["confidence"] = max(existing["confidence"], ref.get("confidence", 0.5))
                existing["full_text_verified"] = (
                    existing["full_text_verified"] or full_text_verified
                )
                for source in provenance:
                    if source not in existing["provenance"]:
                        existing["provenance"].append(source)
                for provider, evidence in provider_evidence.items():
                    current = existing["provider_evidence"].get(provider)
                    if not current:
                        existing["provider_evidence"][provider] = evidence
                    else:
                        current["is_influential"] = (
                            current.get("is_influential") or evidence.get("is_influential")
                        )
                        for field in ("contexts", "intents"):
                            for value in evidence.get(field) or []:
                                if value not in current.setdefault(field, []):
                                    current[field].append(value)
                for c in contexts:
                    if c not in existing["contexts"]:
                        existing["contexts"].append(c)
                existing["contexts"] = existing["contexts"][:4]

    edges = list(edge_by_pair.values())
    for e in edges:
        nodes[e["source"]]["cites_count"] += 1
        nodes[e["target"]]["cited_by_project_count"] += 1
        if e["significant"]:
            nodes[e["target"]]["significant_cited_by_count"] += 1

    return list(nodes.values()), edges


# The U.9 sign-off (2026-07-15): in-project authors only in v1; activity weighting 3/2/1;
# a small hidden-by-default explainer states the FACTORS, not the formula's internals.
AUTHOR_EXPLAINERS = {
    "activity": ("Activity blends three signals: papers in this project (weight 3), "
                 "significant citations of those papers by other project papers (weight 2), "
                 "and appearances in the reference lists this project has read (weight 1)."),
    "significant": ("A citation is marked significant when the citing paper engages with the "
                    "work substantively — building on it or comparing against it — rather "
                    "than citing it in passing."),
}


def _author_key(name: str) -> str:
    """Dedup key for an author name across sources: casefolded, initials/periods and extra
    whitespace collapsed. Deliberately conservative — 'J. Smith' vs 'John Smith' stay
    separate people; merging them safely needs provider author ids (a v2 concern)."""
    return re.sub(r"\s+", " ", name.replace(".", " ").strip()).casefold()


def _display_name(raw: str) -> str:
    """Tidy a name for display: collapse whitespace runs and drop the space that bibliography
    extraction leaks in front of an initial's period ('Quoc V . Le' → 'Quoc V. Le'). The dedup
    key (_author_key) already ignores this, so ranking is unaffected."""
    cleaned = re.sub(r"\s+", " ", (raw or "").strip())
    return re.sub(r"\s+([.,])", r"\1", cleaned)


# Bibliography extraction sometimes emits the trailing "et al." (and kin) of an author list as
# if it were a person; without this it ranks as an author on the board.
_NON_AUTHOR_KEYS = {"et al", "et al.", "et. al", "and others", "others", ""}


def _is_real_author(name: str) -> bool:
    cleaned = re.sub(r"\s+", " ", (name or "").strip())
    return cleaned.casefold() not in _NON_AUTHOR_KEYS and any(c.isalpha() for c in cleaned)


def author_board(graph: dict | None, openalex_cache: dict | None,
                 llm_affiliations: dict | None = None) -> list[dict]:
    """The ranked in-project author board (U.9 v1), computed from a stored graph snapshot at
    read time — pure, no network, no LLM.

    Only authors with >= 1 project paper appear (the sign-off's call: this view ranks *this
    project's* people, not the field's). activity = 3·in-project papers + 2·significant
    citations of those papers + 1·external reference-list appearances. Affiliation comes from
    the OpenAlex authorship cache when known, then from the LLM first-page extraction cache
    (R6.4 — provider record wins on conflict); absent otherwise (never 'Unknown')."""
    if not graph or not graph.get("nodes"):
        return []
    nodes = graph["nodes"]
    affiliation_by_key: dict[str, str] = {}
    # setdefault ordering = precedence: provider (OpenAlex) first, LLM extraction second.
    for cache in (openalex_cache, llm_affiliations):
        for record in (cache or {}).values():
            for ship in (record.get("authorships") or []) if isinstance(record, dict) else []:
                if ship.get("name") and ship.get("affiliation"):
                    affiliation_by_key.setdefault(_author_key(ship["name"]), ship["affiliation"])

    board: dict[str, dict] = {}
    for node in nodes:
        if node.get("kind") != "project":
            continue
        for name in node.get("authors") or []:
            if not _is_real_author(name):
                continue
            key = _author_key(name)
            entry = board.setdefault(key, {
                "name": _display_name(name), "affiliation": affiliation_by_key.get(key, ""),
                "in_project_count": 0, "significant_count": 0, "external_count": 0,
                "years": [], "papers": [],
            })
            entry["in_project_count"] += 1
            entry["significant_count"] += node.get("significant_cited_by_count") or 0
            if isinstance(node.get("year"), int):
                entry["years"].append(node["year"])
            entry["papers"].append({
                "id": node["id"], "slug": node.get("slug"), "title": node.get("title"),
                "kind": "project", "year": node.get("year"),
            })

    for node in nodes:
        if node.get("kind") == "project":
            continue
        for name in node.get("authors") or []:
            entry = board.get(_author_key(name))
            if entry is None:
                continue  # external-only authors are out of scope in v1
            entry["external_count"] += 1
            entry["papers"].append({
                "id": node["id"], "slug": None, "title": node.get("title"),
                "kind": "external", "year": node.get("year"),
                # Identifiers so the client can open/add the work like any external
                # reference in a chat (R7.6).
                "arxiv_id": node.get("arxiv_id"), "doi": node.get("doi"),
                "url": node.get("url"),
            })

    out = []
    for entry in board.values():
        years = entry.pop("years")
        entry["active_years"] = [min(years), max(years)] if years else None
        entry["activity"] = (3 * entry["in_project_count"]
                             + 2 * entry["significant_count"]
                             + entry["external_count"])
        out.append(entry)
    out.sort(key=lambda e: (-e["activity"], e["name"].casefold()))
    return out


def overlay_membership(graph: dict | None, papers: list[Paper]) -> dict | None:
    """Re-derive node membership from the CURRENT reading list on a stored graph snapshot.

    Membership (project vs external) is baked into the graph JSON at build time, but papers
    are added and removed between builds constantly — a recommendation accepted from this
    very map should color as in-project immediately, not after the next rebuild (U.19).
    Re-tags kind/slug/group/list_status on copies at read time; citation counts, edges, and
    layout genuinely require a rebuild and are left untouched. Pure function, no I/O — the
    stored snapshot is never mutated or persisted with the overlay applied.
    """
    if not graph or not graph.get("nodes"):
        return graph
    by_slug = {p.slug: p for p in papers}
    nodes = []
    for stored in graph["nodes"]:
        node = dict(stored)
        if node.get("kind") == "project":
            p = by_slug.get(node.get("slug") or "")
            if p:
                node["group"], node["list_status"] = p.group, p.list_status
                # An entry's arXiv id can be CORRECTED after a build (retrieval resolving a
                # misidentified paper). The snapshot's authors/year belong to the old
                # identity, so drop them until a rebuild refetches — a stale author board is
                # worse than an empty one. Membership styling is unaffected.
                if p.arxiv_id and store.arxiv_base_id(p.arxiv_id) != store.arxiv_base_id(node.get("arxiv_id") or ""):
                    node["arxiv_id"] = p.arxiv_id
                    node["authors"] = []
            else:
                # Removed from the reading list since the build. The id (its old slug) stays,
                # so edges keep resolving; only the membership styling flips.
                node["kind"], node["slug"] = "external", None
                node["group"], node["list_status"] = None, None
        else:
            slug = match_project_paper(node, papers)
            if slug:
                p = by_slug[slug]
                node.update({"kind": "project", "slug": slug,
                             "group": p.group, "list_status": p.list_status})
        nodes.append(node)
    return {**graph, "nodes": nodes}


def betweenness_centrality(node_ids: list[str], edges: list[tuple[str, str]]) -> dict[str, float]:
    """Brandes' algorithm (2001) for betweenness centrality: for every node, how often it lies
    on the shortest path between two OTHER nodes, summed over all pairs. Treats the citation
    graph as unweighted and undirected — citation direction doesn't matter for "does this paper
    sit between two otherwise-distant parts of this project's citation network," which is what
    "high-centrality bridge" means here. O(V*E), which is comfortably fast at this app's scale
    (tens to a few hundred nodes); a real graph library would be overkill for that size.
    Returns raw (unnormalized) scores — 0.0 for nodes with no shortest path routed through them,
    including nodes in a graph with no cycles/alternate-routes at all (e.g. every node in a
    disconnected set of triangles, since a triangle is a complete graph — no node is ever
    strictly "between" the other two)."""
    adj: dict[str, list[str]] = {n: [] for n in node_ids}
    seen_pairs = set()
    for a, b in edges:
        if a not in adj or b not in adj or a == b:
            continue
        pair = (a, b) if a < b else (b, a)
        if pair in seen_pairs:
            continue
        seen_pairs.add(pair)
        adj[a].append(b)
        adj[b].append(a)

    betweenness = dict.fromkeys(node_ids, 0.0)
    for s in node_ids:
        stack: list[str] = []
        pred: dict[str, list[str]] = {n: [] for n in node_ids}
        sigma = dict.fromkeys(node_ids, 0.0)
        sigma[s] = 1.0
        dist = dict.fromkeys(node_ids, -1)
        dist[s] = 0
        queue = deque([s])
        while queue:
            v = queue.popleft()
            stack.append(v)
            for w in adj[v]:
                if dist[w] < 0:
                    dist[w] = dist[v] + 1
                    queue.append(w)
                if dist[w] == dist[v] + 1:
                    sigma[w] += sigma[v]
                    pred[w].append(v)
        delta = dict.fromkeys(node_ids, 0.0)
        while stack:
            w = stack.pop()
            for v in pred[w]:
                delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w])
            if w != s:
                betweenness[w] += delta[w]
    # Each shortest path between a pair is discovered twice (once from each endpoint's BFS) in
    # an undirected graph; halve to get the conventional undirected betweenness value.
    return {n: v / 2.0 for n, v in betweenness.items()}


def _bridge_score(node_id: str, edges: list[dict]) -> float:
    """A lightweight, LOCAL complement to betweenness_centrality (which is global): reward a
    node cited by MULTIPLE project papers whose *other* citations don't otherwise overlap much
    — i.e. it connects citing papers that aren't already close neighbors, rather than one
    repeatedly cited within a single tight cluster. Cheaper to compute and easier to explain
    in a one-line reason than a raw centrality number, so both signals feed the final score."""
    citers = sorted({e["source"] for e in edges if e["target"] == node_id})
    if len(citers) < 2:
        return 0.0
    # Exclude node_id itself from each citer's target set: every citer trivially cites
    # node_id by construction, so leaving it in would inflate every pair's overlap with a
    # guaranteed shared element — we want overlap in what ELSE they cite.
    citer_targets = {c: {e["target"] for e in edges if e["source"] == c} - {node_id} for c in citers}
    overlaps = []
    for i in range(len(citers)):
        for j in range(i + 1, len(citers)):
            a, b = citer_targets[citers[i]], citer_targets[citers[j]]
            union = a | b
            overlaps.append(len(a & b) / len(union) if union else 0.0)
    avg_overlap = sum(overlaps) / len(overlaps) if overlaps else 0.0
    return round(len(citers) * (1.0 - avg_overlap), 3)


def score_recommendations(nodes: list[dict], edges: list[dict], project_paper_count: int) -> list[dict]:
    """Recommendation score + human-readable reasons for each EXTERNAL node, highest first.
    Weighting: a significant citation counts most (it's evidence the project actually
    depends on/engages with the work), breadth of citing papers next, then two complementary
    centrality/bridge signals — a cheap local heuristic (_bridge_score) and real betweenness
    centrality computed once over the whole graph (normalized to [0,1] by this graph's own max,
    since raw betweenness scales with graph size and isn't meaningful compared across runs)."""
    betweenness = betweenness_centrality(
        [n["id"] for n in nodes], [(e["source"], e["target"]) for e in edges])
    max_betweenness = max(betweenness.values(), default=0.0) or 1.0  # avoid dividing by zero

    out = []
    for n in nodes:
        if n["kind"] != "external":
            continue
        cited = n["cited_by_project_count"]
        if cited == 0:
            continue
        sig = n["significant_cited_by_count"]
        bridge = _bridge_score(n["id"], edges)
        centrality = betweenness.get(n["id"], 0.0) / max_betweenness
        coverage = cited / max(project_paper_count, 1)
        # Global standing (Semantic Scholar count, when known): log-scaled so a 5,000-citation
        # landmark gets a solid boost without letting raw fame swamp the in-project signals —
        # caps at 3.0 (the weight of one significant in-project citation).
        global_cites = n.get("citation_count") or 0
        global_term = min(3.0, 0.75 * math.log10(1 + global_cites))
        score = round(sig * 3.0 + cited * 1.0 + coverage * 2.0 + bridge * 1.5 + centrality * 3.0
                      + global_term, 3)
        reasons = []
        if cited >= 2:
            reasons.append(f"Cited by {cited} of {project_paper_count} papers in this project")
        else:
            reasons.append("Cited by 1 paper in this project")
        if sig > 0:
            reasons.append(
                f"Used significantly (baseline/extension/dependency) in {sig} paper{'s' if sig != 1 else ''}")
        if global_cites >= 100:
            reasons.append(f"~{global_cites:,} citations overall — a well-established work")
        if bridge >= 1.0:
            reasons.append("Bridges papers that don't otherwise overlap much — likely connects distinct sub-threads")
        if centrality >= 0.3:
            reasons.append(
                "High centrality — sits on the shortest connecting path between otherwise "
                "distant parts of this project's citation network")
        out.append({**n, "recommend_score": score, "recommend_reasons": reasons,
                   "betweenness_centrality": round(centrality, 3)})
    out.sort(key=lambda n: n["recommend_score"], reverse=True)
    return out


def related_works_for(
    slug: str,
    limit: int = 10,
    *,
    graph_data: dict | None = None,
) -> list[dict]:
    """The most significant related works for one paper, from the stored graph: works it
    builds on / compares against (its significant outgoing citations) and project papers that
    build on it (significant incoming). Ranked by how load-bearing the work is (in-project
    citation breadth, then global citation count), capped small — this backs the reading
    session's 'Related works' menu and the matching context section the analyst sees.
    Cheap: reads the stored graph, no LLM."""
    g = (graph_data if graph_data is not None else graph_store.load()).get("graph")
    if not g:
        return []
    nodes = {n["id"]: n for n in g["nodes"]}
    items: list[dict] = []
    for e in g["edges"]:
        if not e.get("significant"):
            continue
        if e["source"] == slug and e["target"] in nodes:
            other, direction = nodes[e["target"]], "builds_on"
        elif e["target"] == slug and e["source"] in nodes:
            other, direction = nodes[e["source"]], "built_on_by"
        else:
            continue
        items.append({
            "id": other["id"], "kind": other["kind"], "slug": other.get("slug"),
            "title": other["title"], "year": other.get("year"), "venue": other.get("venue", ""),
            "arxiv_id": other.get("arxiv_id"), "url": other.get("url"),
            "list_status": other.get("list_status"),
            "citation_count": other.get("citation_count"),
            "direction": direction, "reason": e.get("reason", ""),
        })
    # "Builds on" first (the prior work the paper stands on), then citers; within each group
    # the most load-bearing works first.
    def rank(r: dict):
        return (r["direction"] != "builds_on",
                -(nodes[r["id"]].get("cited_by_project_count", 0)),
                -(r.get("citation_count") or 0))

    items.sort(key=rank)
    top = items[:limit]
    # Off-list works must stay represented (polish plan H.4): project papers dominate the
    # ranking via cited_by_project_count, and a cap that squeezes externals out turns this
    # menu into a Library index — the researcher opens it precisely to find works they
    # DON'T have yet. Swap the lowest-ranked project entries for the best externals.
    want = min(3, sum(1 for r in items if r["kind"] != "project"))
    have = sum(1 for r in top if r["kind"] != "project")
    if have < want:
        spare = [r for r in items[limit:] if r["kind"] != "project"]
        for _ in range(want - have):
            drop = max((i for i, r in enumerate(top) if r["kind"] == "project"), default=None)
            if drop is None or not spare:
                break
            top[drop] = spare.pop(0)
        top.sort(key=rank)
    return top


def project_citers_for(
    slug: str,
    limit: int = 8,
    *,
    graph_data: dict | None = None,
) -> list[dict]:
    """Project papers that cite ``slug``, with the graph's actual relationship evidence.

    This is deliberately broader than ``related_works_for``: an incoming citation still helps
    place a paper in the project's intellectual timeline even when the extraction judged it
    background rather than significant. Cheap, read-only, and empty before Map has been built.
    """
    stored = (graph_data if graph_data is not None else graph_store.load()).get("graph")
    if not isinstance(stored, dict):
        return []
    nodes = {
        node.get("id"): node
        for node in stored.get("nodes") or []
        if isinstance(node, dict) and node.get("id")
    }
    target = nodes.get(slug)
    if not target or target.get("kind") != "project":
        return []
    target_year = target.get("year")
    out = []
    for edge in stored.get("edges") or []:
        if not isinstance(edge, dict) or edge.get("target") != slug:
            continue
        source = nodes.get(edge.get("source"))
        if not source or source.get("kind") != "project":
            continue
        source_year = source.get("year")
        later = (
            isinstance(source_year, int)
            and isinstance(target_year, int)
            and source_year > target_year
        )
        out.append({
            "slug": source.get("slug") or source.get("id"),
            "title": source.get("title") or source.get("id"),
            "year": source_year,
            "later": later,
            "significant": bool(edge.get("significant")),
            "reason": str(edge.get("reason") or "").strip(),
            "contexts": [
                str(context).strip()
                for context in (edge.get("contexts") or [])
                if str(context).strip()
            ][:2],
            "full_text_verified": bool(edge.get("full_text_verified")),
        })
    out.sort(key=lambda row: (
        not row["later"],
        row["year"] if isinstance(row["year"], int) else 9999,
        row["title"].casefold(),
    ))
    return out[:max(0, limit)]


# ---------- status (cheap, no LLM) ----------

def status(papers: list[Paper]) -> dict:
    """Which papers are covered by a fresh cached extraction, without calling the LLM or
    touching the stored graph. Powers a "N papers need (re)building" prompt in the UI."""
    data = graph_store.load()
    stale, missing_text = [], []
    for p in papers:
        cached_text = _graph_retrieved_text(data, p)
        if not store.corpus_path(p.slug).exists() and not cached_text:
            missing_text.append(p.slug)
            continue
        full_text = store.read_full_text(p.slug) or cached_text
        chash = graph_store.content_hash(full_text)
        cached = graph_store.get_paper_extraction(data, p.slug)
        if not cached or cached.get("content_hash") != chash or cached.get("status") == "error":
            stale.append(p.slug)
    g = data.get("graph") or {}
    # A stored graph can also be stale in the OTHER direction: a project node whose paper has
    # since been REMOVED from the reading list. Surface those as stale too, so the rebuild
    # affordance lights up instead of the Map serving nodes that 404 when opened.
    current = {p.slug for p in papers}
    removed = sorted({
        n["slug"] for n in (g.get("nodes") or [])
        if n.get("kind") == "project" and n.get("slug") and n["slug"] not in current
    })
    stale.extend(removed)
    # Forward direction: a current project paper with NO node in an existing built graph.
    # The extraction checks above miss this when the paper arrived with a FRESH extraction
    # cache but was never graphed — a project move (R9.13) copies the extraction, so the
    # moved paper looks up to date yet isn't in the destination's stored snapshot. Light up
    # the rebuild affordance so GET /graph isn't silently missing it. Guard on a stored graph
    # EXISTING (not on it having nodes): a degenerate empty-node graph still reports
    # has_graph=true, so its papers must still surface for rebuild.
    if data.get("graph") is not None:
        graphed = {
            n["slug"] for n in (g.get("nodes") or [])
            if n.get("kind") == "project" and n.get("slug")
        }
        for p in papers:
            if p.slug not in graphed and p.slug not in stale:
                stale.append(p.slug)
    provider_enabled = bool(semantic_scholar.api_key())
    provider_records = {
        p.slug: graph_store.get_provider_paper(data, "semantic_scholar", p.slug) for p in papers
    }
    provider_stale = []
    if provider_enabled:
        for paper in papers:
            record = provider_records[paper.slug]
            if (
                not record
                or record.get("source_key") != semantic_scholar_source_key(paper)
                or record.get("status") == "error"
            ):
                provider_stale.append(paper.slug)
                if paper.slug not in stale:
                    stale.append(paper.slug)
    retrievals = {p.slug: graph_store.get_retrieval(data, p.slug) or {} for p in papers}
    # Retrieval failures are intentionally retryable on the next build. Include them in the
    # existing rebuild-needed contract so clients cannot strand a missing paper after a partial
    # graph succeeds; the dedicated error map supplies the user-facing reason.
    for slug, record in retrievals.items():
        if record.get("status") == "error" and slug not in stale:
            stale.append(slug)
    return {
        "has_graph": data.get("graph") is not None,
        "built_at": g.get("built_at"),
        "model": g.get("model"),
        "graph_revision": g.get("revision"),
        "graph_stage": g.get("stage") or ("enriched" if g else None),
        "graph_completeness": g.get("completeness"),
        "graph_needs_enrichment": g.get("stage") == "skeleton",
        "total_papers": len(papers),
        "retrievable_papers": len(papers) - len(missing_text),
        "stale_papers": stale,
        "removed_papers": removed,
        "missing_text_papers": missing_text,
        "semantic_scholar_enabled": provider_enabled,
        "semantic_scholar_papers": sum(
            1 for record in provider_records.values()
            if record and record.get("status") == "done"
        ),
        "semantic_scholar_stale_papers": provider_stale,
        "retrieval_candidates": {
            slug: record.get("candidates") or [] for slug, record in retrievals.items()
            if record.get("status") == "needs_confirmation"
        },
        "retrieval_errors": {
            slug: record.get("error") for slug, record in retrievals.items()
            if record.get("status") == "error" and record.get("error")
        },
    }


# ---------- orchestration ----------

ExtractFn = Callable[[str, str, str, str], dict]
MetadataFn = Callable[[Paper], dict]
RetrievalFn = Callable[[Paper, dict | None], dict]


def retrieve_missing_graph_paper(paper: Paper, provider_record: dict | None) -> dict:
    """Deterministically retrieve a high-confidence source into the graph-only cache."""
    arxiv_id = paper.arxiv_id or ""
    provider_paper = (provider_record or {}).get("paper") or {}
    external_ids = provider_paper.get("external_ids") or {}
    if not arxiv_id and isinstance(external_ids, dict):
        arxiv_id = str(external_ids.get("ArXiv") or external_ids.get("ARXIV") or "")
    return retriever.retrieve(
        paper.title, arxiv_id=arxiv_id or None, min_score=0.86
    )


def _fresh_cached_extractions(
    papers: list[Paper], data: dict
) -> dict[str, dict]:
    """Return only full-text extractions that still match the paper text available now."""
    fresh: dict[str, dict] = {}
    for paper in papers:
        full_text = (
            store.read_full_text(paper.slug)
            if store.corpus_path(paper.slug).exists()
            else _graph_retrieved_text(data, paper)
        )
        cached = graph_store.get_paper_extraction(data, paper.slug)
        if (
            full_text
            and cached
            and cached.get("status") == "done"
            and cached.get("content_hash") == graph_store.content_hash(full_text)
        ):
            fresh[paper.slug] = cached
    return fresh


def _provider_metadata(papers: list[Paper], data: dict) -> dict[str, dict]:
    return {
        paper.slug: record for paper in papers
        if (record := graph_store.get_provider_paper(
            data, "semantic_scholar", paper.slug
        )) is not None
    }


def _persist_graph_snapshot(
    papers: list[Paper],
    data: dict,
    model: str,
    extractions: dict[str, dict],
    provider_metadata: dict[str, dict],
    *,
    stage: str,
    ready: int,
    annotate_citations: bool,
    force: bool = False,
) -> tuple[dict, list[dict]]:
    """Assemble and atomically persist one visible graph lifecycle snapshot."""
    combined = merge_reference_sources(papers, extractions, provider_metadata)
    nodes, edges = build_nodes_and_edges(papers, combined)
    if annotate_citations:
        citations.annotate_nodes(nodes, data["citations"])  # best-effort, cached
        # Project-node authors + affiliations (U.9), same enrichment contract: cached,
        # best-effort, network only on this full path. A force rebuild re-fetches every node
        # so affiliations OpenAlex has since gained get picked up.
        openalex.annotate_project_authors(nodes, data.setdefault("openalex", {}), force=force)
        # Provider-first then LLM (R6.4): papers OpenAlex left without any institution get
        # their affiliations read off their own first page. Cached the same way; skipped
        # entirely for provider-covered papers. Each paid extraction is persisted as it
        # lands, so a mid-pass restart never re-bills completed papers.
        affiliations.annotate_project_affiliations(
            nodes, data.get("openalex", {}), data.setdefault("llm_affiliations", {}),
            force=force, persist=lambda: graph_store.save(data))
        # Paper-figure manifests (R.10): derive/refresh each paper's arXiv-HTML figure cache
        # in the same enrichment phase. Best-effort, deterministic (no LLM), per-paper
        # persist (manifest+assets are their own files under .state/figures/), first stall
        # aborts the pass. Retrieval already warms new papers; this backfills the corpus.
        figures.derive_project_figures(papers, force=force)
    else:
        # Skeleton snapshots must stay fast (no network), but the semantic layout's Y axis
        # needs citation counts — apply whatever the cache already knows for free. Without
        # this, every skeleton publish laid the WHOLE map out in the unranked band and
        # stamped it semantic.
        cache = data.get("citations") or {}
        for node in nodes:
            node["citation_count"] = cache.get(node["id"])
        # Same free-from-cache treatment for authors: no network on skeleton publishes.
        openalex.annotate_project_authors(nodes, data.setdefault("openalex", {}), fetch=False)
        # And for LLM-extracted authors (R6.4) — a paper whose names came only from the
        # first-page pass must not vanish from /graph/authors for the whole build.
        affiliations.apply_cached(nodes, data.get("llm_affiliations") or {})
    recs = score_recommendations(nodes, edges, len(papers))
    layout = graph_layout.compute_layout(nodes, edges)
    metadata_papers = sum(
        1 for record in provider_metadata.values() if record.get("status") == "done"
    )
    analyzed_papers = sum(
        1 for extraction in extractions.values() if extraction.get("status") == "done"
    )
    graph_payload = {
        "built_at": _now(),
        "revision": uuid.uuid4().hex,
        "model": model,
        "stage": stage,
        "completeness": {
            "total_papers": len(papers),
            "metadata_papers": metadata_papers,
            "ready_papers": ready,
            "analyzed_papers": analyzed_papers,
            "metadata_only_edges": sum(
                1 for edge in edges
                if "semantic_scholar" in (edge.get("provenance") or [])
                and not edge.get("full_text_verified")
            ),
            "full_text_edges": sum(
                1 for edge in edges if edge.get("full_text_verified")
            ),
        },
        "nodes": nodes,
        "edges": edges,
        "layout": layout,
    }
    graph_store.set_graph(data, graph_payload)
    graph_store.set_recommendations(data, recs)
    graph_store.save(data)
    return graph_payload, recs


def build_graph(papers: list[Paper], force: bool = False,
                extract_fn: ExtractFn = extract_references_for_paper,
                metadata_fn: MetadataFn | None = None,
                retrieval_fn: RetrievalFn | None = None,
                retrieval_sources: dict[str, str] | None = None) -> Iterator[dict]:
    """Generator: yields progress dicts, then the final graph and recommendations.

    Provider references and full-text/LLM extraction use independent incremental caches.
    Only a changed source identity (or force) refreshes provider metadata; only changed cached
    full text (or force/a previous error) re-spends an LLM extraction.

    extract_fn is injectable so tests can drive the whole pipeline (matching, dedup, graph
    construction, recommendations) with fixture extraction data and zero network calls."""
    data = graph_store.load()
    model = resolve_model()
    total = len(papers)
    ready_slugs = {
        p.slug for p in papers
        if store.corpus_path(p.slug).exists() or _graph_retrieved_text(data, p)
    }
    ready = len(ready_slugs)
    yield {"type": "start", "total": total, "ready": ready, "model": model}

    # Provider metadata is a separate, resumable cache. A missing key disables this phase
    # cleanly; tests and other callers can inject a network-free metadata function explicitly.
    metadata_fetcher = metadata_fn
    if metadata_fetcher is None and semantic_scholar.api_key():
        metadata_fetcher = fetch_semantic_scholar_metadata
    if metadata_fetcher is not None:
        for paper in papers:
            source_key = semantic_scholar_source_key(paper)
            cached_provider = graph_store.get_provider_paper(
                data, "semantic_scholar", paper.slug
            )
            needs_provider = (
                force
                or not cached_provider
                or cached_provider.get("source_key") != source_key
                or cached_provider.get("status") == "error"
            )
            if needs_provider:
                yield {"type": "metadata", "slug": paper.slug, "title": paper.title}
                try:
                    provider_record = metadata_fetcher(paper)
                    if not isinstance(provider_record, dict):
                        raise TypeError("metadata provider returned a non-object result")
                    if provider_record.get("status") not in {"done", "not_found"}:
                        raise ValueError("metadata provider returned an invalid status")
                    if (
                        provider_record.get("status") == "done"
                        and not isinstance(provider_record.get("references"), list)
                    ):
                        raise TypeError("metadata provider references were not a list")
                    provider_record = {
                        **provider_record,
                        "source_key": source_key,
                        "fetched_at": provider_record.get("fetched_at") or _now(),
                        "error": str(provider_record.get("error") or "")[:400],
                    }
                except Exception as exc:
                    provider_record = {
                        "status": "error", "source_key": source_key, "fetched_at": _now(),
                        "paper": None, "references": [], "error": str(exc)[:400],
                    }
                graph_store.set_provider_paper(
                    data, "semantic_scholar", paper.slug, provider_record
                )
                graph_store.save(data)
            else:
                provider_record = cached_provider
            yield {
                "type": "metadata_progress", "slug": paper.slug,
                "status": provider_record.get("status"), "cached": not needs_provider,
                "error": provider_record.get("error") or None,
            }

    # Publish the cheap metadata/cached-analysis map before any missing-paper downloads or LLM
    # extraction. If the remaining enrichment is interrupted, users still retain this useful,
    # explicitly incomplete snapshot and a later build resumes from the independent caches.
    provider_metadata = _provider_metadata(papers, data)
    skeleton_extractions = _fresh_cached_extractions(papers, data)
    skeleton_graph, skeleton_recommendations = _persist_graph_snapshot(
        papers,
        data,
        model,
        skeleton_extractions,
        provider_metadata,
        stage="skeleton",
        ready=ready,
        annotate_citations=False,
    )
    yield {
        "type": "skeleton",
        "graph": skeleton_graph,
        "recommendations": skeleton_recommendations,
    }

    retrieval_fetcher = retrieval_fn or retrieve_missing_graph_paper
    retrieval_sources = retrieval_sources or {}
    for paper in papers:
        if store.corpus_path(paper.slug).exists():
            continue
        source_key = semantic_scholar_source_key(paper)
        cached_retrieval = graph_store.get_retrieval(data, paper.slug)
        cached_text = graph_store.read_retrieved_text(paper.slug)
        cache_valid = bool(
            cached_retrieval
            and cached_retrieval.get("source_key") == source_key
            and cached_retrieval.get("status") in {"done", "needs_confirmation"}
            and (cached_retrieval.get("status") != "done" or cached_text)
        )
        needs_retrieval = force or paper.slug in retrieval_sources or not cache_valid
        if needs_retrieval:
            ready_slugs.discard(paper.slug)
            yield {"type": "retrieving", "slug": paper.slug, "title": paper.title}
            try:
                selected_arxiv = retrieval_sources.get(paper.slug)
                if selected_arxiv:
                    result = retriever.retrieve(
                        paper.title, arxiv_id=selected_arxiv, min_score=0.86
                    )
                else:
                    result = retrieval_fetcher(
                        paper,
                        graph_store.get_provider_paper(data, "semantic_scholar", paper.slug),
                    )
                if not isinstance(result, dict):
                    raise TypeError("retrieval returned a non-object result")
                if result.get("needs_confirmation"):
                    cached_retrieval = {
                        "status": "needs_confirmation", "source_key": source_key,
                        "fetched_at": _now(), "candidates": result.get("candidates") or [],
                        "error": "",
                    }
                elif result.get("full_text"):
                    graph_store.write_retrieved_text(paper.slug, str(result["full_text"]))
                    cached_text = str(result["full_text"])
                    cached_retrieval = {
                        "status": "done", "source_key": source_key, "fetched_at": _now(),
                        "arxiv_id": result.get("arxiv_id"), "source": result.get("source"),
                        "candidates": [], "error": "",
                    }
                    ready_slugs.add(paper.slug)
                else:
                    raise ValueError("retrieval returned neither text nor candidates")
            except Exception as exc:
                cached_retrieval = {
                    "status": "error", "source_key": source_key, "fetched_at": _now(),
                    "candidates": [], "error": str(exc)[:400],
                }
            graph_store.set_retrieval(data, paper.slug, cached_retrieval)
            graph_store.save(data)
        ready = len(ready_slugs)
        yield {
            "type": "retrieval_progress", "slug": paper.slug,
            "status": cached_retrieval.get("status"), "cached": not needs_retrieval,
            "ready": ready, "total": total,
            "candidates": cached_retrieval.get("candidates") or [],
            "error": cached_retrieval.get("error") or None,
        }

    retrievable: list[tuple[Paper, str]] = []
    for paper in papers:
        text = (
            store.read_full_text(paper.slug)
            if store.corpus_path(paper.slug).exists()
            else _graph_retrieved_text(data, paper)
        )
        if text:
            retrievable.append((paper, text))

    # Split cached from to-run, then fan the LLM extractions out over a small worker pool
    # (R7.11) — extraction dominates a fresh build's wall clock, each call is an independent
    # network-bound request, and the provider handles a few concurrent requests fine. The
    # concurrency discipline: workers run ONLY extract_fn (with the project contextvar
    # explicitly rebound — pool threads don't inherit it, invariant 2); every store mutation,
    # incremental save, and progress yield stays here on the generator thread, so graph_store
    # needs no locking and the persist-per-paper resumability contract is unchanged.
    done = 0
    to_run: list[tuple[Paper, str]] = []
    for p, full_text in retrievable:
        chash = graph_store.content_hash(full_text)
        cached = graph_store.get_paper_extraction(data, p.slug)
        needs_run = (force or not cached or cached.get("content_hash") != chash
                     or cached.get("status") == "error")
        if needs_run:
            to_run.append((p, full_text))
            continue
        done += 1
        yield {"type": "progress", "done": done, "total": total, "ready": ready, "slug": p.slug,
               "status": cached.get("status"), "cached": True,
               "error": cached.get("error") or None}

    if to_run:
        pid = config.active_project_id()

        def run_one(paper: Paper, text: str) -> dict:
            token = config.set_active_project(pid)
            try:
                return extract_fn(paper.slug, paper.title, text, model)
            finally:
                config.reset_active_project(token)

        workers = extraction_concurrency()
        pending = list(to_run)
        # No `with pool:` — its __exit__ is shutdown(wait=True), which on an interrupted
        # build would block the generator's close() until every orphaned LLM call finished.
        pool = concurrent.futures.ThreadPoolExecutor(
            max_workers=workers, thread_name_prefix="graph-extract-fan",
        )
        abandoned = False
        in_flight: dict[concurrent.futures.Future, Paper] = {}
        try:
            while pending or in_flight:
                # Sliding window: top the pool up, announcing each submission so the
                # progress UI still names papers as they enter extraction.
                while pending and len(in_flight) < workers:
                    paper, text = pending.pop(0)
                    yield {"type": "extracting", "slug": paper.slug, "title": paper.title}
                    in_flight[pool.submit(run_one, paper, text)] = paper
                ready_set, _ = concurrent.futures.wait(
                    in_flight, return_when=concurrent.futures.FIRST_COMPLETED,
                )
                for future in ready_set:
                    paper = in_flight.pop(future)
                    extraction = future.result()  # an extract_fn crash fails the build,
                    # exactly as the serial loop did
                    graph_store.set_paper_extraction(data, paper.slug, extraction)
                    # Persist after EACH paper, not just once at the end: each extraction
                    # is a real (paid) call taking tens of seconds, so an interrupted
                    # build keeps every paper completed so far and the next build only
                    # re-spends tokens on whatever's left ("resumable").
                    graph_store.save(data)
                    done += 1
                    yield {"type": "progress", "done": done, "total": total,
                           "ready": ready, "slug": paper.slug,
                           "status": extraction.get("status"), "cached": False,
                           "error": extraction.get("error") or None}
        except BaseException:
            # GeneratorExit (consumer stopped the build) or a crashed extraction. Completed-
            # but-unconsumed futures are real paid results — persist them before abandoning;
            # still-running calls are orphaned exactly like the serial loop's single
            # in-flight call was (nothing waits on them).
            abandoned = True
            finished = [
                (p, f.result()) for f, p in in_flight.items()
                if f.done() and not f.cancelled() and f.exception() is None
            ]
            for paper, extraction in finished:
                graph_store.set_paper_extraction(data, paper.slug, extraction)
            if finished:
                graph_store.save(data)
            raise
        finally:
            pool.shutdown(wait=not abandoned, cancel_futures=abandoned)

    retrievable_slugs = {paper.slug for paper, _text in retrievable}
    extractions = {
        slug: ext for slug, ext in data["papers"].items() if slug in retrievable_slugs
    }
    provider_metadata = _provider_metadata(papers, data)
    graph_payload, recs = _persist_graph_snapshot(
        papers,
        data,
        model,
        extractions,
        provider_metadata,
        stage="enriched",
        ready=ready,
        annotate_citations=True,
        force=force,
    )
    yield {"type": "done", "graph": graph_payload, "recommendations": recs}
