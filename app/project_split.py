"""Project splitting (U.24 / R8.1): move a selection of papers — and the work done on them —
out of one project into a fresh one.

Phase 1 only (this module): the deterministic, LLM-free, network-free move/copy. The two
optional LLM working-notes passes (draft the new project's notes; clean the source's notes)
are separate `notes_jobs`-shaped background jobs layered on top.

What travels per selected slug (see docs/project-forking-design.md for the full table):
reading-list block (verbatim, dangling cites dropped), corpus file incl. committed Notes,
session transcript + retry branches, and the per-paper graph caches (extraction record,
retrieved text, cover, provider record, retrieval record) — the caches are copied EITHER
way because re-extraction is a paid call. With `remove_from_source` the source loses the
papers through the same committed-removal posture as the by-hand removal endpoint.

Discipline: like `recent_sessions`, this rebinds the active-project contextvar as it crosses
between the two projects, so `store`/`sessions`/`graph_store` stay pure single-project
modules (invariant 3) and every file write lands in the right project (invariant 2). It is a
human-confirmed action, so its two git commits are the same invariant-4 posture as
`DELETE /papers/{slug}`.
"""
from __future__ import annotations

import re

from . import config, graph_store, projects, sessions, store

_CITES_RE = re.compile(r"<!--\s*cites:\s*(?P<cites>[a-z0-9,\s-]+?)\s*-->", re.I)


class SplitError(Exception):
    pass


def _rewrite_block_cites(block: str, keep: set[str]) -> str:
    """Drop from a copied block's `<!-- cites -->` any slug not also moving (it would dangle
    in the new project). An emptied comment is removed entirely."""
    def _sub(m: re.Match) -> str:
        kept = [c.strip() for c in m.group("cites").split(",")
                if c.strip() and c.strip() in keep]
        return f"<!-- cites: {', '.join(kept)} -->" if kept else ""
    return _CITES_RE.sub(_sub, block)


def _gather_source(slugs: list[str]) -> dict:
    """Read everything the selected slugs need, with the SOURCE project bound. Returns a plain
    data bundle so the write phase can run with the NEW project bound."""
    data = graph_store.load()
    bundle: dict[str, dict] = {}
    for slug in slugs:
        entry = store.entry_details(slug)
        if entry is None:
            raise SplitError(f"Paper not in this project: {slug}")
        corpus = store.corpus_path(slug)
        jsonl, branches = sessions.transcript_paths(slug)
        cover = _cover_path(slug)
        gcorpus = graph_store._retrieved_text_file(slug)
        bundle[slug] = {
            "entry": entry,
            "corpus_bytes": corpus.read_bytes() if corpus.exists() else None,
            "jsonl_bytes": jsonl.read_bytes() if jsonl.exists() else None,
            "branches_bytes": branches.read_bytes() if branches.exists() else None,
            "cover_bytes": cover.read_bytes() if cover.exists() else None,
            "gcorpus_bytes": gcorpus.read_bytes() if gcorpus.exists() else None,
            "session_meta": sessions.index_entry(slug),
            "notes": store.read_notes(slug),   # snapshot for the source-cleanup LLM pass
            "extraction": graph_store.get_paper_extraction(data, slug),
            "provider": graph_store.get_provider_paper(data, "semantic_scholar", slug),
            "retrieval": graph_store.get_retrieval(data, slug),
        }
    return bundle


def _cover_path(slug: str):
    # Imported lazily: cover_jobs pulls in the PDF/render stack we don't otherwise need here.
    from . import cover_jobs
    return cover_jobs.cover_path(slug)


def _write_new_project(new_pid: str, bundle: dict, keep: set[str]) -> None:
    """Materialize the bundle into the NEW project (contextvar already bound to it)."""
    data = graph_store.load()
    for slug, b in bundle.items():
        block = _rewrite_block_cites(b["entry"]["block"], keep)
        store.append_entry_block(b["entry"]["group"], block)
        if b["corpus_bytes"] is not None:
            store.corpus_path(slug).write_bytes(b["corpus_bytes"])
        if b["jsonl_bytes"] is not None or b["session_meta"] is not None:
            jsonl, branches = sessions.transcript_paths(slug)
            jsonl.parent.mkdir(parents=True, exist_ok=True)
            if b["jsonl_bytes"] is not None:
                jsonl.write_bytes(b["jsonl_bytes"])
            if b["branches_bytes"] is not None:
                branches.parent.mkdir(parents=True, exist_ok=True)
                branches.write_bytes(b["branches_bytes"])
            if b["session_meta"] is not None:
                sessions.import_session(slug, b["session_meta"])
        if b["cover_bytes"] is not None:
            cover = _cover_path(slug)
            cover.parent.mkdir(parents=True, exist_ok=True)
            cover.write_bytes(b["cover_bytes"])
        if b["gcorpus_bytes"] is not None:
            gpath = graph_store._retrieved_text_file(slug)
            gpath.parent.mkdir(parents=True, exist_ok=True)
            gpath.write_bytes(b["gcorpus_bytes"])
        if b["extraction"] is not None:
            graph_store.set_paper_extraction(data, slug, b["extraction"])
        if b["provider"] is not None:
            graph_store.set_provider_paper(data, "semantic_scholar", slug, b["provider"])
        if b["retrieval"] is not None:
            graph_store.set_retrieval(data, slug, b["retrieval"])
    graph_store.save(data)


def _remove_from_source(slugs: list[str]) -> None:
    """Delete the moved papers from the SOURCE project (contextvar bound to source): reading
    list entries, on-disk files, graph records, and any now-dangling cites in what remains."""
    data = graph_store.load()
    gone = set(slugs)
    for slug in slugs:
        store.remove_entry(slug)
        for p in (store.corpus_path(slug), *sessions.transcript_paths(slug),
                  _cover_path(slug), graph_store._retrieved_text_file(slug)):
            p.unlink(missing_ok=True)
        sessions.drop_session(slug)
        data.get("papers", {}).pop(slug, None)
        data.get("providers", {}).get("semantic_scholar", {}).get("papers", {}).pop(slug, None)
        data.get("retrievals", {}).pop(slug, None)
    graph_store.save(data)
    store.drop_dangling_cites(gone)


def split_project(
    source_pid: str,
    name: str,
    slugs: list[str],
    *,
    remove_from_source: bool = True,
    goals: str | None = None,
) -> dict:
    """Move/copy `slugs` from `source_pid` into a new project `name`. Returns
    {new_pid, name, moved, removed, departed_notes} — `departed_notes` (slug -> Notes text)
    feeds the optional source-cleanup pass. Phase 1 only; LLM notes passes are separate.

    The caller (the route) has already validated that a background job isn't running for the
    source (the R7.5 sweep) and that the request is human-confirmed."""
    name = (name or "").strip()
    if not name:
        raise SplitError("A name for the new project is required.")
    slugs = list(dict.fromkeys(slugs))  # de-dupe, keep order
    if not slugs:
        raise SplitError("Select at least one paper to split out.")
    keep = set(slugs)

    # 1. Read everything with the source bound.
    token = config.set_active_project(source_pid)
    try:
        bundle = _gather_source(slugs)
        departed_notes = {s: b["notes"] for s, b in bundle.items() if b["notes"].strip()}
    finally:
        config.reset_active_project(token)

    # 2. Scaffold the new project (takes a pid, not the contextvar) and populate it.
    meta = projects.create_project(name)
    new_pid = meta["id"]
    if goals:
        projects.update_meta(new_pid, goals=goals.strip())
    token = config.set_active_project(new_pid)
    try:
        _write_new_project(new_pid, bundle, keep)
    finally:
        config.reset_active_project(token)
    projects._git(new_pid, "add", "-A")
    projects._git(new_pid, "commit", "-q", "-m",
                  f"Split {len(slugs)} paper(s) from {source_pid}")

    # 3. Remove from source, if asked — one batched, committed change.
    removed = False
    if remove_from_source:
        token = config.set_active_project(source_pid)
        try:
            _remove_from_source(slugs)
        finally:
            config.reset_active_project(token)
        projects._git(source_pid, "add", "-A")
        projects._git(source_pid, "commit", "-q", "-m",
                      f"Split {len(slugs)} paper(s) to {name}")
        removed = True

    return {
        "new_pid": new_pid,
        "name": name,
        "moved": len(slugs),
        "removed": removed,
        "departed_notes": departed_notes,
    }
