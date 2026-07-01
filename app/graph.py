"""Reference graph: builds a citation graph for a project's papers.

Pipeline (per paper, cached by content hash so rebuilds never re-spend tokens on
unchanged papers):
  1. One OpenRouter call (DeepSeek V4 Pro by default — see resolve_model) reads the paper's
     cached full text and returns its bibliography as structured references, each with a
     few short verbatim body excerpts ("contexts") showing where/how it's cited, and a
     significance verdict: does the paper substantially use, extend, compare against, or
     depend on that work, as opposed to a passing bibliography mention. This is the one
     expensive step, and the only one that touches the network — everything below is free.
  2. Deterministic Python (no LLM, fully unit-testable) normalizes + dedupes references
     across every paper in the project and matches them against the project's own papers
     by fuzzy title matching, producing the graph's nodes and edges.
  3. Lightweight graph analysis scores each external node for recommendation: how many
     project papers cite it (and how many *significantly*), plus a simple bridge-ness proxy
     (does it connect citing papers that don't otherwise overlap much).

This is a reusable app feature — any project can (re)build its graph from the UI — not a
one-off manual analysis. Re-running after adding one new paper only spends tokens on that
paper; everything else is served from the cache.
"""
from __future__ import annotations

import concurrent.futures
import json
import os
import re
from datetime import datetime, timezone
from collections import deque
from difflib import SequenceMatcher
from typing import Callable, Iterator

import httpx

from . import config, graph_layout, graph_store, store
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
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


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
        r = httpx.get(f"{config.OPENROUTER_BASE}/models", timeout=15)
        r.raise_for_status()
        data = r.json().get("data", [])
    except (httpx.HTTPError, ValueError):
        return DEFAULT_GRAPH_MODEL
    matches = [m for m in data if m.get("id") and m["id"][:1].isalnum()
               and all(s in m["id"].lower() for s in _GRAPH_MODEL_INC)
               and not any(s in m["id"].lower() for s in _GRAPH_MODEL_EXC)]
    if not matches:
        return DEFAULT_GRAPH_MODEL
    return max(matches, key=lambda m: m.get("created", 0))["id"]


# ---------- extraction (the one LLM-calling step) ----------

_EXTRACTION_SYSTEM = """You are a meticulous research-paper bibliography analyst. You will be \
given the full text of one academic paper. Extract its reference list and assess how each \
reference is actually used in the paper's body.

Respond with ONLY a single JSON object (no markdown fences, no commentary), matching exactly \
this shape:

{
  "references": [
    {
      "index": <int, 1-based, matching the paper's own numbering if it uses numbered citations>,
      "raw_text": "<the bibliography entry's text, verbatim or near-verbatim>",
      "title": "<paper title, cleaned>",
      "authors": ["<author name>", "..."],
      "venue": "<conference/journal/arXiv, e.g. 'OSDI 2024' or 'arXiv preprint'>",
      "year": <int or null>,
      "arxiv_id": "<e.g. '2401.09670', or null>",
      "doi": "<or null>",
      "url": "<or null>",
      "confidence": <0.0-1.0, your confidence in this extraction's accuracy>,
      "contexts": ["<verbatim short excerpt from the BODY text (not the bibliography) where \
this reference is cited or discussed, 1-3 sentences>", "...up to 4 contexts..."],
      "significant": <true/false>,
      "significance_reason": "<one sentence: why significant (e.g. 'used as the primary \
baseline in all evaluations') or why not (e.g. 'listed only in a related-work enumeration')>"
    }
  ]
}

A reference is SIGNIFICANT if the paper's body substantially uses, compares against, extends, \
builds on, or depends on it — e.g. a baseline, a method the paper adopts or modifies, a system \
it is evaluated against, or a foundational result its argument depends on. A reference is NOT \
significant if it appears only in a bibliography or in a one-clause "prior work includes X, Y, \
Z" enumeration with no further engagement. Include every reference you can find, even \
insignificant ones — the significant flag captures that distinction, don't just omit them. If \
the paper's full text looks truncated, still extract every reference visible in whatever \
bibliography text is present. If you cannot find a bibliography at all, return \
{"references": []}."""


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

    headers = {"Authorization": f"Bearer {key}", "HTTP-Referer": "http://localhost",
               "X-Title": config.APP_TITLE}
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": _EXTRACTION_SYSTEM},
            {"role": "user", "content": f"Paper title: {title}\n\nFull text:\n\n{text[:MAX_FULL_TEXT_CHARS]}"},
        ],
        "temperature": 0.1,
        "max_tokens": EXTRACTION_MAX_TOKENS,
        "reasoning": {"effort": REASONING_EFFORT},
    }
    try:
        r = _call_with_deadline(
            lambda: httpx.post(f"{config.OPENROUTER_BASE}/chat/completions",
                               headers=headers, json=body, timeout=300),
            deadline=EXTRACTION_HARD_DEADLINE)
    except concurrent.futures.TimeoutError:
        return _result("error", [],
                       f"No response after {EXTRACTION_HARD_DEADLINE}s (hard deadline) — the "
                       "request may still be running upstream but this paper is being skipped "
                       "for now; retry later or on the next rebuild.")
    except httpx.HTTPError as e:
        return _result("error", [], f"OpenRouter request failed: {e}"[:400])
    if r.status_code != 200:
        return _result("error", [], f"OpenRouter error {r.status_code}: {r.text[:300]}")

    try:
        data = r.json()
        choice = data["choices"][0]
        content = (choice.get("message") or {}).get("content")
        if isinstance(content, list):
            content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
        if not content or not str(content).strip():
            reasoning_tokens = ((data.get("usage") or {}).get("completion_tokens_details") or {}).get(
                "reasoning_tokens")
            hint = (f" (spent {reasoning_tokens} tokens on reasoning before running out — "
                    "try raising EXTRACTION_MAX_TOKENS or lowering REASONING_EFFORT further)"
                    if reasoning_tokens else "")
            raise GraphError(f"Empty response (finish_reason={choice.get('finish_reason')}){hint}.")

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


def match_project_paper(ref: dict, papers: list[Paper]) -> str | None:
    """The slug of the in-project paper this reference points to, if any."""
    title = ref.get("title") or ""
    if not title:
        return None
    for p in papers:
        if titles_match(title, p.title):
            return p.slug
    return None


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
            "authors": [], "venue": "", "year": None, "arxiv_id": None, "doi": None, "url": None,
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
            target_slug = match_project_paper(ref, papers)
            if target_slug and target_slug != slug:
                target_id = target_slug
            else:
                key = external_ref_key(ref)
                target_id = external_key_to_id.get(key)
                if not target_id:
                    target_id = f"ext:{key}"
                    external_key_to_id[key] = target_id
                    nodes[target_id] = {
                        "id": target_id, "kind": "external", "slug": None,
                        "title": ref.get("title") or (ref.get("raw_text", "")[:120] or "Untitled reference"),
                        "authors": ref.get("authors", []), "venue": ref.get("venue", ""),
                        "year": ref.get("year"), "arxiv_id": ref.get("arxiv_id"),
                        "doi": ref.get("doi"), "url": ref.get("url"),
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

            if target_id == slug:
                continue  # a paper "citing itself" via a fuzzy-matched title glitch — skip

            pair = (slug, target_id)
            significant = bool(ref.get("significant"))
            reason = ref.get("significance_reason", "")
            contexts = ref.get("contexts", [])
            existing = edge_by_pair.get(pair)
            if existing is None:
                edge_by_pair[pair] = {
                    "source": slug, "target": target_id,
                    "significant": significant,
                    "reason": reason,
                    "contexts": list(contexts),
                    "confidence": ref.get("confidence", 0.5),
                    "raw_text": ref.get("raw_text", ""),
                }
            else:
                # Prefer the significant verdict/reason if either mention was significant;
                # union contexts (deduped, capped) rather than picking one arbitrarily.
                if significant and not existing["significant"]:
                    existing["reason"] = reason
                existing["significant"] = existing["significant"] or significant
                existing["confidence"] = max(existing["confidence"], ref.get("confidence", 0.5))
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

    betweenness = {n: 0.0 for n in node_ids}
    for s in node_ids:
        stack: list[str] = []
        pred: dict[str, list[str]] = {n: [] for n in node_ids}
        sigma = {n: 0.0 for n in node_ids}
        sigma[s] = 1.0
        dist = {n: -1 for n in node_ids}
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
        delta = {n: 0.0 for n in node_ids}
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
        score = round(sig * 3.0 + cited * 1.0 + coverage * 2.0 + bridge * 1.5 + centrality * 3.0, 3)
        reasons = []
        if cited >= 2:
            reasons.append(f"Cited by {cited} of {project_paper_count} papers in this project")
        else:
            reasons.append("Cited by 1 paper in this project")
        if sig > 0:
            reasons.append(
                f"Used significantly (baseline/extension/dependency) in {sig} paper{'s' if sig != 1 else ''}")
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


# ---------- status (cheap, no LLM) ----------

def status(papers: list[Paper]) -> dict:
    """Which papers are covered by a fresh cached extraction, without calling the LLM or
    touching the stored graph. Powers a "N papers need (re)building" prompt in the UI."""
    data = graph_store.load()
    stale, missing_text = [], []
    for p in papers:
        if not store.corpus_path(p.slug).exists():
            missing_text.append(p.slug)
            continue
        chash = graph_store.content_hash(store.read_full_text(p.slug))
        cached = graph_store.get_paper_extraction(data, p.slug)
        if not cached or cached.get("content_hash") != chash or cached.get("status") == "error":
            stale.append(p.slug)
    g = data.get("graph") or {}
    return {
        "has_graph": data.get("graph") is not None,
        "built_at": g.get("built_at"),
        "model": g.get("model"),
        "total_papers": len(papers),
        "retrievable_papers": len(papers) - len(missing_text),
        "stale_papers": stale,
        "missing_text_papers": missing_text,
    }


# ---------- orchestration ----------

ExtractFn = Callable[[str, str, str, str], dict]


def build_graph(papers: list[Paper], force: bool = False,
                extract_fn: ExtractFn = extract_references_for_paper) -> Iterator[dict]:
    """Generator: yields progress dicts as papers are (re)extracted, then a final
    {"type": "done", "graph": ..., "recommendations": ...} dict. Only papers whose cached
    full text changed (or that were never extracted, or previously errored) get a fresh LLM
    call; everything else is served from the cache — incremental by construction.

    extract_fn is injectable so tests can drive the whole pipeline (matching, dedup, graph
    construction, recommendations) with fixture extraction data and zero network calls."""
    data = graph_store.load()
    model = resolve_model()
    retrievable = [p for p in papers if store.corpus_path(p.slug).exists()]
    total = len(retrievable)
    yield {"type": "start", "total": total, "model": model}

    done = 0
    for p in retrievable:
        full_text = store.read_full_text(p.slug)
        chash = graph_store.content_hash(full_text)
        cached = graph_store.get_paper_extraction(data, p.slug)
        needs_run = (force or not cached or cached.get("content_hash") != chash
                     or cached.get("status") == "error")
        if needs_run:
            yield {"type": "extracting", "slug": p.slug, "title": p.title}
            extraction = extract_fn(p.slug, p.title, full_text, model)
            graph_store.set_paper_extraction(data, p.slug, extraction)
            # Persist after EACH paper, not just once at the end: a project can have dozens
            # of papers and each extraction is a real (paid) network call taking tens of
            # seconds, so this is a genuinely long-running operation. Saving incrementally
            # means an interrupted build (client disconnect, server restart, a killed
            # request) keeps every paper completed so far — the next build only re-spends
            # tokens on whatever's left, which is the whole point of "resumable".
            graph_store.save(data)
        else:
            extraction = cached
        done += 1
        yield {"type": "progress", "done": done, "total": total, "slug": p.slug,
               "status": extraction.get("status"), "cached": not needs_run,
               "error": extraction.get("error") or None}

    extractions = {slug: ext for slug, ext in data["papers"].items()
                   if slug in {p.slug for p in papers}}
    nodes, edges = build_nodes_and_edges(papers, extractions)
    recs = score_recommendations(nodes, edges, len(papers))
    layout = graph_layout.compute_layout(nodes, edges)  # adds x/y to each node (temporal Y)
    graph_payload = {"built_at": _now(), "model": model, "nodes": nodes, "edges": edges,
                     "layout": layout}
    graph_store.set_graph(data, graph_payload)
    graph_store.set_recommendations(data, recs)
    graph_store.save(data)
    yield {"type": "done", "graph": graph_payload, "recommendations": recs}
