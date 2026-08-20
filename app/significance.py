"""Lane-1 significance: which NEW citers actually matter, with the evidence to say why.

DR-052 PR 3 (spec §3 lane 1). The new-citation lane (neighbourhood.forward_delta) reports every
paper that has started citing the reader's corpus; this module decides which of those citations
are SIGNIFICANT — "extends our method" versus "cites us in a related-work list" — and produces
the one-line evidence a suggestion can show ("cited your Foo et al. three times, as the approach
they extend"). No mapping tool weights citation edges at all, which is why this lane exists.

Two deliberate design points, both measured live on 2026-08-14 (spec §3):

- **We classify the raw context sentences ourselves.** Semantic Scholar's ready-made `intents`
  labels collapse to ~18% coverage on 2024+ citers (their classifier runs 1-2 years behind), so
  they are useless for a monitoring lane whose whole point is NEW papers. The `contexts`
  sentences hold at 44-76% coverage on brand-new citers, and the existing cheap batch screen
  already knows how to read text at volume.

- **A deterministic pre-filter runs first, and the LLM only confirms.** "Significant" is a
  5-15% slice by every independent measure (Valenzuela 14.6% base rate, S2 isInfluential 5.4%,
  scite 6.5%+0.8%), so classifying every edge would spend ~10x the budget the honest prior
  justifies. The pre-filter is the Valenzuela feature set computable from data the delta sweep
  already carries: mention count (F1 proxy), reference scarcity 1/referenceCount (F7), and cue
  phrases ("we extend", "we build on") (F5). S2's `isInfluential` is a boost into the LLM slice,
  never a gate — it has ~11% recall on new citers.

Everything is scored and classified **per edge, never pooled across a candidate**: one citer can
cite two reading-list papers with different intent, and pooling would let a cue about paper B
push the candidate over the threshold while the model — and the evidence line — get told about
paper A. The strongest edge is the one classified, and the significance block names its anchor,
so the line the reader sees is about the edge that earned it.

The failure mode to watch (spec §6, from the scite evaluation): collapse-to-the-boring-class.
The audit therefore counts labels per class, so a run of all-BACKGROUND is visible rather than
silently plausible.
"""
from __future__ import annotations

import hashlib
import logging
import re

from . import discovery_batch, prompts

log = logging.getLogger("rc.discovery")

#: The batched screen's shape, same machinery as title triage / abstract scoring.
BATCH_SIZE = 25
MAX_TOKENS = 8_000
#: How much quoted context the model sees per edge. Contexts are single sentences; three of them
#: fit comfortably, and an edge with more mentions than that is already prescore-selected.
CONTEXTS_CHARS = 700

#: Labels the model may emit. EXTENDS / USES / CONTRASTS are the significant classes — a paper
#: that builds on, applies, or argues with the reader's work. COMPARES (benchmark tables) and
#: BACKGROUND (related-work lists) are the incidental majority.
LABELS = ("EXTENDS", "USES", "CONTRASTS", "COMPARES", "BACKGROUND")
SIGNIFICANT_LABELS = frozenset({"EXTENDS", "USES", "CONTRASTS"})
#: The evidence line's verb per significant label. Lives HERE, beside the label set, so adding a
#: label is one edit in one module — the blend looks the verb up and treats a miss as
#: not-significant rather than raising mid-run.
SIGNIFICANT_VERBS = {"EXTENDS": "extends", "USES": "uses", "CONTRASTS": "challenges"}

#: Valenzuela F5 — cue phrases that mark a citation as load-bearing in the citer's own prose.
#: Deliberately conservative: these appear IN the context sentence quoting the reader's paper.
_CUE_RE = re.compile(
    r"\bwe\s+(?:follow|extend|build\s+on|adopt|adapt|apply|use|leverage|employ)\b"
    r"|\bbuild(?:s|ing)?\s+(?:up)?on\b"
    r"|\bextend(?:s|ing)?\b"
    r"|\bbased\s+on\s+the\s+(?:method|approach|framework|architecture)\b"
    r"|\bfollowing\s+the\s+(?:method|approach|setup|protocol)\b",
    re.IGNORECASE,
)

#: Pre-filter weights. The threshold admits roughly the top slice the honest prior describes:
#: one plain mention scores 0.25 and stays out; two mentions, a cue phrase, a genuinely short
#: reference list, or the isInfluential flag each push an edge over.
PRESCORE_MENTION = 0.25       # per context sentence, capped at 4
PRESCORE_CUE = 0.6            # any cue phrase in any context
PRESCORE_SCARCITY = 6.0       # x 1/referenceCount (F7): 30 refs -> 0.2, 120 refs -> 0.05
#: F7's floor, set so the scarcity term maxes at 0.2 — BELOW what a single plain mention needs
#: to cross the threshold. Two reasons: S2 reports referenceCount 1-5 for preprints whose
#: bibliography extraction failed (6.0/2 = 3.0 would admit passing mentions wholesale, turning
#: the 5-15% paid slice into most of the lane), and in Valenzuela F7 is a *feature* that
#: sharpens real signals, not a gate that admits on its own.
PRESCORE_MIN_REFERENCES = 30
PRESCORE_INFLUENTIAL = 0.5    # S2's flag: a boost into the slice, never a gate
PRESCORE_THRESHOLD = 0.5


def _edges(candidate: dict) -> list[dict]:
    return [p for p in (candidate.get("provenance") or [])
            if isinstance(p, dict) and p.get("channel") == "new_citation"]


def _score_edge(edge: dict) -> tuple[float, dict]:
    contexts = [str(c) for c in (edge.get("contexts") or []) if str(c).strip()]
    mentions = len(contexts)
    cue = any(_CUE_RE.search(c) for c in contexts)
    rc = edge.get("reference_count")
    reference_count = rc if isinstance(rc, int) and rc > 0 else None
    score = PRESCORE_MENTION * min(mentions, 4)
    if cue:
        score += PRESCORE_CUE
    if reference_count:
        score += PRESCORE_SCARCITY / max(reference_count, PRESCORE_MIN_REFERENCES)
    if edge.get("is_influential"):
        score += PRESCORE_INFLUENTIAL
    return score, {
        "mentions": mentions,
        "cue": cue,
        "reference_count": reference_count,
        "influential": bool(edge.get("is_influential")),
        "contexts": contexts,
        "anchor_slug": edge.get("anchor_slug") or "",
        "anchor_title": edge.get("anchor_title") or "",
    }


def prescore(candidate: dict) -> tuple[float, dict]:
    """The deterministic Valenzuela pre-filter, per edge, returning the STRONGEST edge.

    Per edge and never pooled: one citer can cite two reading-list papers with different
    intent, and pooling contexts would earn a bonus with evidence about one paper while
    attributing it to another. Returns (best score, best edge's features); features carry the
    edge's anchor so classification and the evidence line stay about the same paper.
    """
    best_score, best_features = 0.0, {
        "mentions": 0, "cue": False, "reference_count": None, "influential": False,
        "contexts": [], "anchor_slug": "", "anchor_title": "",
    }
    for edge in _edges(candidate):
        score, features = _score_edge(edge)
        if features["contexts"] and score > best_score:
            best_score, best_features = score, features
    return best_score, best_features


def _contexts_hash(contexts: list[str]) -> str:
    joined = "\n".join(contexts)[:4000]
    return hashlib.sha256(joined.encode("utf-8", "replace")).hexdigest()[:16]


def classify(candidates: list[dict], cheap_llm, *, ledger: dict | None = None,
             cheap_model: str = "", get_entry=None, record_entry=None) -> dict:
    """Attach a `significance` block to the lane-1 candidates that earn one.

    Runs over the ~60 gate/triage survivors, never the raw reservoir — the spec's budget rule is
    "LLM triage runs only on gate survivors and weekly deltas". Within those, only edges past the
    deterministic pre-filter reach the model, and results are ledger-cached by context hash so a
    weekly re-run re-buys nothing that didn't change.

    `get_entry`/`record_entry` are the ledger seams (discovery_ledger.get + a recorder); injected
    so tests need no ledger on disk. Never raises for model-side problems — a failed batch leaves
    those candidates unclassified, which ranks them exactly as before this stage existed — and a
    total failure lands in `audit["degraded"]`, which the run merges into its own degraded list.
    """
    audit: dict = {"stage": "citation_significance", "lane": 0, "selected": 0, "reused": 0,
                   "labels": {}, "degraded": []}
    lane = [c for c in candidates if _edges(c)]
    audit["lane"] = len(lane)
    if not lane:
        return audit

    selected: list[tuple[dict, dict, str]] = []   # (candidate, best-edge features, ctx hash)
    for candidate in lane:
        score, features = prescore(candidate)
        if not features["contexts"]:
            continue     # nothing to classify: no sentence, no evidence line
        if score < PRESCORE_THRESHOLD:
            continue     # the incidental majority; the honest prior says most edges are
        digest = _contexts_hash(features["contexts"])
        cached = None
        if get_entry is not None:
            entry = get_entry(ledger or {}, _key(candidate))
            cached = (entry or {}).get("citation")
        if (isinstance(cached, dict) and cached.get("model") == cheap_model
                and cached.get("contexts_hash") == digest
                and cached.get("label") in LABELS):
            _attach(candidate, cached["label"], str(cached.get("note") or ""), score, features)
            audit["reused"] += 1
            audit["labels"][cached["label"]] = audit["labels"].get(cached["label"], 0) + 1
            continue
        selected.append((candidate, features, digest))
    audit["selected"] = len(selected) + audit["reused"]
    if not selected:
        return audit

    system = prompts.render("discover_citation_significance")

    def render(index: int, item: dict) -> str:
        _, features, _ = selected[index - 1]
        anchor = features["anchor_title"] or "a paper on the reading list"
        quoted = " | ".join(features["contexts"])[:CONTEXTS_CHARS]
        return (f"{index}|cited work: {str(anchor)[:120]}|"
                f"mentions={features['mentions']}|{quoted}")

    values, batch_audit = discovery_batch.run_batches(
        [c for c, _, _ in selected], batch_size=BATCH_SIZE, system=system,
        render_item=render, llm_fn=lambda s, u: cheap_llm(s, u, MAX_TOKENS),
        min_fields=1, stage="citation_significance")
    audit.update({k: batch_audit[k] for k in ("batches", "answered", "missing")})
    audit["degraded"] = batch_audit.get("degraded", [])

    for index, (candidate, features, digest) in enumerate(selected, 1):
        fields = values.get(index) or []
        label = (fields[0].strip().upper() if fields else "")
        if label not in LABELS:
            continue    # unanswered or malformed: unclassified, ranked as before
        note = fields[1].strip()[:160] if len(fields) > 1 else ""
        score, _ = prescore(candidate)
        _attach(candidate, label, note, score, features)
        audit["labels"][label] = audit["labels"].get(label, 0) + 1
        if record_entry is not None:
            record_entry(candidate, label=label, note=note, model=cheap_model,
                         contexts_hash=digest)
    return audit


def _attach(candidate: dict, label: str, note: str, score: float, features: dict) -> None:
    candidate["significance"] = {
        "label": label,
        "significant": label in SIGNIFICANT_LABELS,
        "note": note,
        # The classified EDGE's anchor and count — the evidence line must be about the paper
        # whose sentences earned the label, not whichever edge happens to sit first.
        "anchor_title": features["anchor_title"],
        "anchor_slug": features["anchor_slug"],
        "mentions": features["mentions"],
        "prescore": round(score, 3),
    }


def _key(candidate: dict) -> str:
    # Local import: discovery imports this module, and the key function lives there.
    from . import discovery
    return discovery._candidate_key(candidate)
