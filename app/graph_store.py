"""Persistent store for the per-project reference graph: cached LLM extraction results
keyed by paper slug + content hash (so rebuilding never re-spends tokens on unchanged
papers), plus the last computed graph (nodes/edges/recommendations), which is cheap to
recompute from the cache and safe to invalidate independently of extraction.

Lives in the per-project .state/ dir (gitignored, rebuildable — same convention as
sessions.json), not in the project's git history: this is a derived cache over the papers'
own committed text, not authored content.

Concurrent writers (DR-052 PR 1). This is a whole-document JSON file, and it has TWO live
writer classes that overlap in time: a graph build load-mutate-saves its copy many times over
minutes, while a Discovery run loads its own copy and saves resolved OpenAlex anchors into
`openalex_anchors`. A plain whole-document write from either clobbers whatever the other has
saved since it loaded — real data loss (paid extraction records, or the anchor cache) decided
by write order. The fix is dirty-tracked merge-on-save: every mutation made through the
setters below records what it touched under a non-persisted `_dirty` key, and `save()` — for
a document with any recorded changes — re-reads the file under an in-process lock and applies
only those changes onto the fresh copy, so each writer owns exactly the entries it wrote.

Two deliberate consequences:
- A document with NO recorded changes saves wholesale, exactly as before. This is what direct
  mutators rely on — project_split deletes entries by popping them and saving, and a per-key
  merge cannot express deletion. Mixing the two styles in one writer (setters plus direct
  mutation of an unmarked section) would silently drop the direct mutations on save; don't —
  call `mark_dirty(data, section)` for any section mutated in place.
- The dirty record is never cleared while the document lives. After one merged save, the
  in-memory copy does NOT contain other writers' sections (only the file does), so every later
  save must again be "fresh file + the entries this writer owns". Replaying the accumulated
  ownership is exact because a writer's own entries are the ones it wrote — which is why
  KEY-level marks matter for any section two writers can touch: a whole-section mark asserts
  "everything here is mine" and would overwrite a concurrent writer's entries in it. Prefer
  `mark_dirty(data, section, key)`; reserve the whole-section form for sections with a single
  writer class (the graph payload, the annotators' caches — one build per project).

An in-process `threading.Lock` is sufficient — the deployment is a single uvicorn worker by
invariant (CLAUDE.md #6), so there is no cross-process writer to guard against. The document
also carries a monotonically increasing `store_revision`, bumped on every save: substrate
freshness displays (DR-052 PRs 2-4) read it, and it makes "did anything change since I
loaded" a cheap integer compare rather than a document diff.
"""
from __future__ import annotations

import hashlib
import json
import re
import threading
from pathlib import Path

from . import config
from .fileio import atomic_write_text

# Bump when the stored shape changes incompatibly. A version mismatch drops the cache
# (including extractions) rather than risk feeding a new analysis stage malformed records —
# acceptable because extraction is fully rebuildable, just costs tokens to redo.
GRAPH_VERSION = 1


def _file() -> Path:
    return config.state_dir() / "reference-graph.json"


def content_hash(text: str) -> str:
    return hashlib.sha1((text or "").encode("utf-8")).hexdigest()


def _empty() -> dict:
    return {
        "version": GRAPH_VERSION,
        "store_revision": 0,  # bumped on every save; freshness marker, never reused
        "papers": {},        # slug -> PaperExtraction dict (see graph.extract_references_for_paper)
        "graph": None,       # last computed {built_at, model, nodes, edges}
        "recommendations": None,
        "citations": {},     # node id -> global citation count (Semantic Scholar cache)
        "openalex": {},      # node id -> {status, authorships} (author/affiliation cache, U.9)
        # Provider metadata is cached independently from LLM/full-text extraction so a
        # provider refresh never invalidates or re-spends the scholarly analysis cache.
        "providers": {"semantic_scholar": {"papers": {}}},
        "retrievals": {},     # slug -> graph-only derived retrieval status/metadata
        # slug -> resolved OpenAlex anchor (id/topics); written by Discovery's recall, read by
        # both features. Formalised here in PR 1 of DR-052 — Discovery previously invented the
        # key with setdefault, which worked but left the substrate schema implicit.
        "openalex_anchors": {},
        # slug -> which papers are known to cite each project paper. The stored id SET is what
        # makes a later forward sweep a cheap graph DELTA (fetch newest, diff against known)
        # instead of a re-query — the monitoring design in docs/map-discover-merge-design.md and
        # docs/corpus-neighbourhood-spec.md §5.
        #
        # TWO NAMESPACES, deliberately kept apart, because the two forward lanes identify papers
        # differently and a `W…` work key can never equal a 40-hex S2 paperId: unioning them into
        # one list would leave each lane's memory invisible to the other while looking shared.
        #   {citers: [openalex work keys], swept_at, complete, source}   ← breadth chase
        #   {s2_citers: [semantic scholar paper ids], s2_swept_at}       ← new-citation delta
        # `complete: false` marks a set seeded from a top-cited first page rather than an
        # exhaustive walk. `s2_swept_at` advances on every sweep, including one that found
        # nothing — "we looked and there was nothing new" is a different fact from "we never
        # looked", and it is what rotates the delta lane's per-run anchor budget.
        "forward": {},
    }


# Merge granularity per section. Keyed sections merge entry-by-entry (each writer owns the
# keys it set); whole sections merge as a unit (their internal structure is opaque here, and
# each has at most one writer class). "providers" is keyed by "provider/slug".
_KEYED_SECTIONS = frozenset({
    "papers", "retrievals", "openalex_anchors", "forward",
})
_DIRTY = "_dirty"  # non-persisted bookkeeping; stripped before writing

_save_lock = threading.Lock()


def _read_document() -> tuple[dict, bool]:
    """The stored document, and whether it came from a readable file at the current version.
    A False flag means there is nothing on disk worth preserving — which is what stops a
    merged save from writing a writer's marked entries onto an empty document and dropping
    every section it did not mark (a version bump or a wiped .state/ mid-build)."""
    f = _file()
    if not f.exists():
        return _empty(), False
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return _empty(), False
    if not isinstance(data, dict) or data.get("version") != GRAPH_VERSION:
        return _empty(), False
    data.setdefault("store_revision", 0)
    data.setdefault("papers", {})
    data.setdefault("graph", None)
    data.setdefault("recommendations", None)
    data.setdefault("citations", {})  # node id -> global citation count (Semantic Scholar cache)
    data.setdefault("openalex", {})   # node id -> {status, authorships} (U.9)
    providers = data.setdefault("providers", {})
    providers.setdefault("semantic_scholar", {}).setdefault("papers", {})
    data.setdefault("retrievals", {})
    data.setdefault("openalex_anchors", {})
    data.setdefault("forward", {})
    return data, True


def load() -> dict:
    return _read_document()[0]


def mark_dirty(data: dict, section: str, key: str | None = None) -> None:
    """Record that this writer changed `section` (or one entry of it). The setters below call
    this themselves; call it directly when mutating a section in place (e.g. a cache dict
    handed to an annotator), or the change will not survive a merged save."""
    dirty = data.setdefault(_DIRTY, {})
    keyed = section in _KEYED_SECTIONS or section == "providers"
    if key is None or not keyed:
        dirty[section] = True
    elif dirty.get(section) is not True:  # a whole-section mark already covers every key
        dirty.setdefault(section, {})[key] = True


def pending_changes(data: dict) -> bool:
    """Whether this document has recorded changes a save would persist. Lets a maybe-writer
    (Discovery's recall) skip the save entirely when nothing moved."""
    return bool(data.get(_DIRTY))


def _merge_dirty(disk: dict, ours: dict, dirty: dict) -> None:
    for section, keys in dirty.items():
        if keys is True:
            disk[section] = ours.get(section)
            continue
        if section == "providers":
            for compound in keys:
                provider, _, slug = compound.partition("/")
                record = (
                    ours.get("providers", {}).get(provider, {}).get("papers", {}).get(slug)
                )
                disk.setdefault("providers", {}).setdefault(provider, {}).setdefault(
                    "papers", {}
                )[slug] = record
            continue
        src = ours.get(section) or {}
        dst = disk.setdefault(section, {})
        for key in keys:
            if key in src:
                dst[key] = src[key]


def save(data: dict) -> None:
    """Persist `data`. With recorded changes (see module docstring): re-read the file under the
    lock and apply only this writer's changes onto the fresh copy. Without any: wholesale
    write, the legacy semantics deletion-by-pop writers depend on."""
    dirty = data.get(_DIRTY) or {}
    with _save_lock:
        disk, on_disk = _read_document()
        if dirty and on_disk:
            out = disk
            _merge_dirty(out, data, dirty)
        else:
            # Nothing recorded (legacy wholesale semantics, which the deletion-by-pop writers
            # depend on), or nothing readable on disk to preserve.
            out = data
        # max() of both sides so a writer holding a stale copy can never move the file's
        # revision backwards — the counter is a freshness marker and must stay monotonic.
        revision = max(int(disk.get("store_revision") or 0),
                       int(data.get("store_revision") or 0)) + 1
        out["version"] = GRAPH_VERSION
        out["store_revision"] = revision
        # The caller's copy is deliberately NOT stamped on the merged path: after a merge it
        # lacks other writers' sections, so claiming the file's revision would make the
        # "am I current?" compare answer yes for a stale document. Its next save still moves
        # the counter forward, because the max() above reads the file too.
        payload = {k: v for k, v in out.items() if not k.startswith("_")}
        atomic_write_text(_file(), json.dumps(payload, ensure_ascii=False, indent=2))


def get_paper_extraction(data: dict, slug: str) -> dict | None:
    return data["papers"].get(slug)


def set_paper_extraction(data: dict, slug: str, extraction: dict) -> None:
    data["papers"][slug] = extraction
    mark_dirty(data, "papers", slug)


def get_provider_paper(data: dict, provider: str, slug: str) -> dict | None:
    return data.get("providers", {}).get(provider, {}).get("papers", {}).get(slug)


def set_provider_paper(data: dict, provider: str, slug: str, record: dict) -> None:
    data.setdefault("providers", {}).setdefault(provider, {}).setdefault("papers", {})[slug] = record
    mark_dirty(data, "providers", f"{provider}/{slug}")


def _retrieved_text_file(slug: str) -> Path:
    if not re.fullmatch(r"[a-z0-9-]+", slug or ""):
        raise ValueError("Invalid graph retrieval slug")
    return config.state_dir() / "graph-corpus" / f"{slug}.txt"


def get_retrieval(data: dict, slug: str) -> dict | None:
    return data.get("retrievals", {}).get(slug)


def set_retrieval(data: dict, slug: str, record: dict) -> None:
    data.setdefault("retrievals", {})[slug] = record
    mark_dirty(data, "retrievals", slug)


def write_retrieved_text(slug: str, text: str) -> None:
    atomic_write_text(_retrieved_text_file(slug), text)


def read_retrieved_text(slug: str) -> str:
    path = _retrieved_text_file(slug)
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


def forget_retrieval(slug: str) -> None:
    """Drop the graph's own cached text for a paper (DR-167, a source reset).

    Only the text file goes. The `retrievals` record stays: `graph.build` treats a `done`
    record with no text as invalid and retrieves again, so removing the file alone is enough
    to make the next build re-fetch, and it avoids a deletion-by-pop write that `save`'s
    dirty-merge would not carry. The references extracted from a paper that HAD a corpus file
    live in the graph's own sections and refresh on the next build, when the new corpus text's
    key no longer matches."""
    try:
        _retrieved_text_file(slug).unlink(missing_ok=True)
    except (OSError, ValueError):
        pass


def set_graph(data: dict, graph_payload: dict) -> None:
    data["graph"] = graph_payload
    mark_dirty(data, "graph")


def set_recommendations(data: dict, recs: list[dict]) -> None:
    data["recommendations"] = recs
    mark_dirty(data, "recommendations")


def get_forward(data: dict, slug: str) -> dict | None:
    return data.get("forward", {}).get(slug)


def set_forward_sweep(data: dict, slug: str, record: dict) -> None:
    data.setdefault("forward", {})[slug] = record
    mark_dirty(data, "forward", slug)
