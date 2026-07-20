"""Project splitting (U.24 / R8.1): move a selection of papers — and the work done on them —
out of one project into a fresh one.

Phase 1 only (this module): the deterministic, LLM-free, network-free move/copy. The two
optional LLM working-notes passes (draft the new project's notes; clean the source's notes)
are separate `notes_jobs`-shaped background jobs layered on top.

What travels per selected slug (see docs/project-forking-design.md for the full table):
reading-list block (verbatim, dangling cites dropped), corpus file incl. committed Notes,
session transcript + retry branches, and the per-paper graph caches (extraction record,
retrieved text, cover, provider record, retrieval record, first-page affiliations) — the caches are copied EITHER
way because re-extraction is a paid call. Session history now follows the same rule: Copy
duplicates it into an independent destination history; Move duplicates it and then removes
the source. With `remove_from_source` the source loses the papers through the same
committed-removal posture as the by-hand removal endpoint.

Discipline: like `recent_sessions`, this rebinds the active-project contextvar as it crosses
between the two projects, so `store`/`sessions`/`graph_store` stay pure single-project
modules (invariant 3) and every file write lands in the right project (invariant 2). It is a
human-confirmed action, so its two git commits are the same invariant-4 posture as
`DELETE /papers/{slug}`.
"""
from __future__ import annotations

import contextlib
import copy
import re

from . import config, graph_store, logging_config, paper_metadata, projects, sessions, store

log = logging_config.get("project_split")

_CITES_RE = re.compile(r"<!--\s*cites:\s*(?P<cites>[a-z0-9,\s-]+?)\s*-->", re.I)


class SplitError(Exception):
    pass


def _session_paths(slug: str) -> list:
    return [path for pair in sessions.thread_storage_paths(slug) for path in pair]


def _transcript_paths(slug: str) -> list:
    return [pair[0] for pair in sessions.thread_storage_paths(slug)]


def _enter_session_locks(stack: contextlib.ExitStack, slugs: list[str]) -> None:
    """Freeze thread admission + every current transcript while relocating selected papers."""
    for slug in sorted(slugs):
        stack.enter_context(sessions.paper_lock(slug))
        thread_ids = sorted(row["id"] for row in sessions.list_threads(slug))
        for thread_id in thread_ids:
            with sessions.thread_scope(thread_id):
                stack.enter_context(sessions.mutation_lock(slug))


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
            "thread_storage": sessions.export_thread_storage(slug),
            "cover_bytes": cover.read_bytes() if cover.exists() else None,
            "gcorpus_bytes": gcorpus.read_bytes() if gcorpus.exists() else None,
            "session_meta": sessions.index_entry(slug),
            "notes": store.read_notes(slug),   # snapshot for the source-cleanup LLM pass
            "extraction": graph_store.get_paper_extraction(data, slug),
            "provider": graph_store.get_provider_paper(data, "semantic_scholar", slug),
            "retrieval": graph_store.get_retrieval(data, slug),
            "paper_affiliations": paper_metadata.affiliation_record(slug),
        }
    return bundle


def _cover_path(slug: str):
    # Imported lazily: cover_jobs pulls in the PDF/render stack we don't otherwise need here.
    from . import cover_jobs
    return cover_jobs.cover_path(slug)


def _write_new_project(new_pid: str, bundle: dict, keep: set[str]) -> None:
    """Materialize the bundle into the NEW project (contextvar already bound to it).

    A copy means "paper plus the work done on it", not a blank duplicate: transcript, retry
    branches, and session metadata travel for both Move and Copy. On Copy the source simply
    retains its own independent copy of that history.
    """
    data = graph_store.load()
    for slug, b in bundle.items():
        block = _rewrite_block_cites(b["entry"]["block"], keep)
        store.append_entry_block(b["entry"]["group"], block)
        if b["corpus_bytes"] is not None:
            store.corpus_path(slug).write_bytes(b["corpus_bytes"])
        if (any(item.get("jsonl_bytes") is not None or item.get("branches_bytes") is not None
                for item in b.get("thread_storage") or [])
                or b["session_meta"] is not None):
            sessions.import_thread_storage(
                slug,
                b.get("thread_storage") or [{
                    "thread_id": sessions.MAIN_THREAD,
                    "jsonl_bytes": b["jsonl_bytes"],
                    "branches_bytes": b["branches_bytes"],
                }],
            )
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
        if b["paper_affiliations"] is not None:
            paper_metadata.set_affiliation_record(slug, b["paper_affiliations"])
    graph_store.save(data)


def _remove_from_source(source_pid: str, slugs: list[str]) -> list[str]:
    """Delete the moved papers from the SOURCE project (contextvar bound to source): reading
    list entries, on-disk files, graph records, and any now-dangling cites in what remains.
    Returns the GIT-TRACKED paths this changed (relative to the project root) so the caller
    commits exactly those — `.state/` caches are gitignored and excluded, and unrelated dirty
    files (e.g. an unapproved transcript for an unselected paper) are never swept in."""
    data = graph_store.load()
    gone = set(slugs)
    root = config.project_dir()
    # Snapshot git-tracked paths up front: after deletion a `git add -- <path>` for a
    # never-committed (untracked) corpus file errors with "pathspec did not match", so only
    # paths git already knows about may go into the commit's pathspec.
    tracked = set(projects._git(source_pid, "ls-files").splitlines())
    committed_paths = ["reading-list.md"]  # always tracked and modified
    jsonl_by_slug = {s: _transcript_paths(s) for s in slugs}
    for slug in slugs:
        corpus = store.corpus_path(slug)
        # Both the corpus file and an approved transcript (sessions/<slug>.jsonl) are
        # git-tracked; a committed one's DELETION must ride in this commit's pathspec, or the
        # source is left dirty and a later approval commits the deletion by accident.
        for tracked_file in (corpus, *jsonl_by_slug[slug]):
            rel = str(tracked_file.relative_to(root))
            if rel in tracked:
                committed_paths.append(rel)
        store.remove_entry(slug)
        for p in (corpus, *_session_paths(slug),
                  _cover_path(slug), graph_store._retrieved_text_file(slug)):
            p.unlink(missing_ok=True)
        sessions.remove_thread_storage(slug)
        sessions.drop_session(slug)
        data.get("papers", {}).pop(slug, None)
        data.get("providers", {}).get("semantic_scholar", {}).get("papers", {}).pop(slug, None)
        data.get("retrievals", {}).pop(slug, None)
    graph_store.save(data)
    store.drop_dangling_cites(gone)
    return committed_paths


# ---------- move to an EXISTING project (R9.13) ----------

def _dest_existing_slugs(dest_pid: str) -> set[str]:
    """Slugs already in the destination's reading list (contextvar bound to it briefly)."""
    token = config.set_active_project(dest_pid)
    try:
        return {p.slug for p in store.list_papers()}
    finally:
        config.reset_active_project(token)


def _dest_occupied_slugs(dest_pid: str, slugs: list[str]) -> set[str]:
    """Of `slugs`, those the destination ALREADY has data for — a reading-list entry, retained
    on-disk records, OR retained graph records. The removal endpoint (DELETE /papers/{slug})
    deliberately keeps a removed paper's corpus + transcript + branches on disk (warm re-add),
    and a graph build can leave the slug in the stored graph data (extraction/provider/retrieval
    caches + a project node in the snapshot) even for a metadata-only paper with no files. All
    of these are collisions: writing over the files would destroy the destination's history, and
    combining fresh caches with an OLD same-slug graph node would serve stale edges with no
    rebuild signal (`graph.status` sees a matching node + fresh extraction ⇒ not stale)."""
    token = config.set_active_project(dest_pid)
    try:
        occupied = {p.slug for p in store.list_papers()}
        data = graph_store.load()
        provider_papers = ((data.get("providers") or {}).get("semantic_scholar") or {}).get(
            "papers", {})
        graph_nodes = {n.get("slug") for n in (data.get("graph") or {}).get("nodes") or []
                       if n.get("kind") == "project" and n.get("slug")}
        for slug in slugs:
            session_files = _session_paths(slug)
            if (store.corpus_path(slug).exists() or any(p.exists() for p in session_files)
                    or sessions.index_entry(slug) is not None
                    or _cover_path(slug).exists()
                    or graph_store._retrieved_text_file(slug).exists()
                    or slug in (data.get("papers") or {})
                    or slug in provider_papers
                    or slug in (data.get("retrievals") or {})
                    or slug in graph_nodes):
                occupied.add(slug)
        return occupied
    finally:
        config.reset_active_project(token)


def _written_dest_paths(slugs: list[str]) -> list[str]:
    """Git-tracked paths a move WROTE into the destination (contextvar bound to dest), so its
    commit stages exactly those — the destination has unrelated files, so `add -A` is unsafe
    (unlike the fresh-scaffold split). Only existing files: `git add -- <missing>` errors, and
    `.state/*` (covers, graph caches, branches) is gitignored."""
    root = config.project_dir()
    paths = ["reading-list.md"]  # always modified (the appended entry blocks)
    for slug in slugs:
        candidates = [store.corpus_path(slug), *_transcript_paths(slug)]
        for f in candidates:
            if f.exists():
                paths.append(str(f.relative_to(root)))
    return paths


def _snapshot_dest(dest_pid: str) -> dict:
    """Capture the destination's pre-move state for rollback (contextvar bound to dest): its
    HEAD, the reading-list bytes, and a deep copy of the graph-store data (extraction/provider/
    retrieval caches). Enough to restore the destination to exactly its pre-move state on a
    partial failure, without a `git reset --hard` that would discard the destination's OWN
    uncommitted work."""
    return {
        "head": projects._git(dest_pid, "rev-parse", "HEAD").strip(),
        "reading_list": store._reading_list().read_bytes(),
        "graph": copy.deepcopy(graph_store.load()),
    }


def _restore_dest(dest_pid: str, slugs: list[str], snap: dict) -> None:
    """Best-effort rollback of a FAILED move's destination writes (contextvar bound to dest),
    so the destination looks untouched and a retry isn't blocked by the collision check. Does
    the DATA restoration (remove the moved-in files, restore the destination's own reading-list
    + graph caches) FIRST and independently of git, then the fallible git cleanup — so a git
    failure can't leave the destination's own record half-restored. Never raises."""
    # 1. Data restoration — pure filesystem, isolated. The moved-in files are all new in the
    #    destination (the collision check guaranteed it had none), so deleting them loses
    #    nothing of the destination's own; the reading-list + graph are restored to snapshots.
    for slug in slugs:
        try:
            for p in (store.corpus_path(slug), *_session_paths(slug),
                      _cover_path(slug), graph_store._retrieved_text_file(slug)):
                p.unlink(missing_ok=True)
            sessions.remove_thread_storage(slug)
            # A move imported the paper's session-index entry (.state/sessions.json) too; drop
            # it, or the destination keeps a phantom session for a paper it no longer has (a
            # later re-add would look resumable with no transcript).
            sessions.drop_session(slug)
        except Exception:
            log.warning("could not remove moved-in file(s) for %s from %s", slug, dest_pid,
                        exc_info=True)
    try:
        store._reading_list().write_bytes(snap["reading_list"])
        store._parse_cache.clear()
    except Exception:
        log.warning("could not restore destination reading list for %s", dest_pid,
                    exc_info=True)
    try:
        graph_store.save(snap["graph"])
    except Exception:
        log.warning("could not restore destination graph caches for %s", dest_pid,
                    exc_info=True)
    # 2. Fallible git cleanup LAST — undo the move's commit if one landed (reset --soft keeps
    #    the working tree, now restored), then unstage the paths the move could have staged.
    try:
        projects._git(dest_pid, "reset", "--soft", snap["head"])
        reset_paths = ["reading-list.md"]
        root = config.project_dir()
        for slug in slugs:
            for f in (store.corpus_path(slug), *_transcript_paths(slug)):
                reset_paths.append(str(f.relative_to(root)))
        projects._git(dest_pid, "reset", "-q", "--", *reset_paths)
    except Exception:
        log.warning("git cleanup of destination rollback %s was incomplete", dest_pid,
                    exc_info=True)


def move_to_existing(
    source_pid: str,
    dest_pid: str,
    slugs: list[str],
    *,
    remove_from_source: bool = True,
) -> dict:
    """Move/copy `slugs` from `source_pid` into an EXISTING project `dest_pid` (R9.13).
    Returns {new_pid, name, moved, removed, departed_notes} — `new_pid` is `dest_pid`, so the
    caller switches to it exactly as for a split. Same deterministic phase-1 contract as
    `split_project`; the differences are destination validation, slug-collision refusal, a
    cite-keep set that includes the destination's existing papers, a pathspec commit (not
    `add -A`) into the populated destination, and a rollback of the destination on failure.

    The route holds BOTH projects busy (refusing new synchronous writers) and has swept jobs on
    both. This acquires each project's EXCLUSIVE write lock (sorted, so two moves can't
    deadlock) to also drain any writer ALREADY in flight, giving the move sole access to both
    records + git indexes."""
    if dest_pid == source_pid:
        raise SplitError("Choose a different project to move into.")
    if not projects.exists(dest_pid):
        raise SplitError("The destination project no longer exists.")
    slugs = list(dict.fromkeys(slugs))  # de-dupe, keep order
    if not slugs:
        raise SplitError("Select at least one paper to move.")

    # Exclusive write lock on BOTH projects (sorted ⇒ no lock-cycle between two moves), draining
    # any synchronous writer already in flight on either side before we touch its record. ALL
    # racy reads (source-entry validation, destination occupancy, cite-keep) happen INSIDE the
    # locks: a writer that added a selected slug to the destination just before the busy flag
    # was set could otherwise finish after an unlocked collision check, and _write_new_project
    # would then append a duplicate entry.
    first, second = sorted([source_pid, dest_pid])
    token = config.set_active_project(source_pid)
    try:
        with config.project_exclusive(first), config.project_exclusive(second), \
                contextlib.ExitStack() as locks:
            _enter_session_locks(locks, slugs)

            # Validate every slug is a CURRENT source entry before any path building — a
            # non-entry value (incl. a `../x` traversal) is never a parsed reading-list slug,
            # so this rejects it before the collision check feeds it into path helpers.
            source_slugs = {p.slug for p in store.list_papers()}  # bound to source
            unknown = [s for s in slugs if s not in source_slugs]
            if unknown:
                raise SplitError("Not current papers in this project: " + ", ".join(unknown))

            occupied = _dest_occupied_slugs(dest_pid, slugs)
            collisions = [s for s in slugs if s in occupied]
            if collisions:
                raise SplitError(
                    "These papers already have data in the destination project (an entry, or "
                    "notes/discussion retained from a past removal): " + ", ".join(collisions))
            # A moved paper's cite to a paper ALREADY in the destination stays a live edge, so
            # keep is the moved set plus the destination's existing reading-list papers.
            keep = set(slugs) | _dest_existing_slugs(dest_pid)
            dest_name = projects._read_meta(dest_pid).get("name") or dest_pid

            bundle = _gather_source(slugs)
            departed_notes = {s: b["notes"] for s, b in bundle.items() if b["notes"].strip()}
            departed_titles = {
                s: b["entry"]["title"] for s, b in bundle.items() if b["notes"].strip()
            }

            dest_token = config.set_active_project(dest_pid)
            try:
                snap = _snapshot_dest(dest_pid)
                try:
                    _write_new_project(dest_pid, bundle, keep)
                    written = _written_dest_paths(slugs)
                    # Pathspec, not `add -A`: the destination has its own (possibly dirty)
                    # files, and only the paths this move wrote may enter its commit. (Same
                    # accepted reading-list-pathspec tradeoff as the shipped removal endpoint /
                    # PR #147: a pre-existing uncommitted reading-list add rides along; the busy
                    # reservation blocks a CONCURRENT add during the move window.)
                    projects._git(dest_pid, "add", "--", *written)
                    action = "Move" if remove_from_source else "Copy"
                    projects._git(dest_pid, "commit", "-q", "-m",
                                  f"{action} {len(slugs)} paper(s) from {source_pid}",
                                  "--", *written)
                    removed = _finish_source_removal(source_pid, slugs, bundle, dest_name) \
                        if remove_from_source else False
                except Exception:
                    # Roll the destination back to its pre-move state so a retry isn't blocked
                    # by the collision check. Safe because the source is only touched AFTER a
                    # successful dest commit and restores itself on its own failure (below), so
                    # the moved data is never lost.
                    _restore_dest(dest_pid, slugs, snap)
                    raise
            finally:
                config.reset_active_project(dest_token)
    finally:
        config.reset_active_project(token)

    return {
        "new_pid": dest_pid,
        "name": dest_name,
        "moved": len(slugs),
        "removed": removed,
        "departed_notes": departed_notes,
        "departed_titles": departed_titles,
    }


def _finish_source_removal(source_pid: str, slugs: list[str], bundle: dict,
                           dest_name: str) -> bool:
    """Remove the moved papers from the source and commit (contextvar currently bound to the
    destination — rebind to source). On ANY failure, restore the source COMPLETELY from the
    captured bundle + a pre-removal snapshot — never `git reset --hard`, which would discard
    the source's own unrelated working-tree edits and cannot restore the untracked corpus/
    transcript/.state files `_remove_from_source` deletes. Then re-raise (the caller rolls the
    destination back). Since the source is restored, the moved papers' data is never lost even
    though the destination copies are removed."""
    src_token = config.set_active_project(source_pid)
    try:
        snap = {
            "head": projects._git(source_pid, "rev-parse", "HEAD").strip(),
            "reading_list": store._reading_list().read_bytes(),
            "graph": copy.deepcopy(graph_store.load()),
        }
        try:
            changed = _remove_from_source(source_pid, slugs)
            projects._git(source_pid, "add", "--", *changed)
            staged = projects._git(source_pid, "diff", "--cached", "--name-only", "--", *changed)
            if staged.strip():
                projects._git(source_pid, "commit", "-q", "-m",
                              f"Move {len(slugs)} paper(s) to {dest_name}", "--", *changed)
            return True
        except Exception:
            _restore_source(source_pid, slugs, bundle, snap)
            raise
    finally:
        config.reset_active_project(src_token)


def _restore_source(source_pid: str, slugs: list[str], bundle: dict, snap: dict) -> None:
    """Undo a failed source removal (contextvar bound to source). Restore the DATA first —
    re-materialize the removed papers' on-disk files from the captured bundle, then the
    reading-list bytes + graph caches from the snapshot — all pure filesystem writes that do
    NOT depend on git. Only AFTER the data is safe does it run the fallible git cleanup, so a
    git failure (e.g. a read-only `.git`, the very case that failed the removal) can never skip
    restoration and lose the papers from both projects. Never raises."""
    # 1. Data restoration — independent of git, each step isolated so one failure never skips
    #    the rest. This is what actually prevents data loss.
    for slug in slugs:
        try:
            b = bundle[slug]
            if b["corpus_bytes"] is not None:
                store.corpus_path(slug).write_bytes(b["corpus_bytes"])
            sessions.import_thread_storage(
                slug,
                b.get("thread_storage") or [{
                    "thread_id": sessions.MAIN_THREAD,
                    "jsonl_bytes": b["jsonl_bytes"],
                    "branches_bytes": b["branches_bytes"],
                }],
            )
            if b["cover_bytes"] is not None:
                cover = _cover_path(slug)
                cover.parent.mkdir(parents=True, exist_ok=True)
                cover.write_bytes(b["cover_bytes"])
            if b["gcorpus_bytes"] is not None:
                gpath = graph_store._retrieved_text_file(slug)
                gpath.parent.mkdir(parents=True, exist_ok=True)
                gpath.write_bytes(b["gcorpus_bytes"])
            if b["session_meta"] is not None:
                sessions.import_session(slug, b["session_meta"])
        except Exception:
            log.warning("could not restore source file(s) for %s", slug, exc_info=True)
    try:
        store._reading_list().write_bytes(snap["reading_list"])
        store._parse_cache.clear()
    except Exception:
        log.warning("could not restore source reading list for %s", source_pid, exc_info=True)
    try:
        graph_store.save(snap["graph"])
    except Exception:
        log.warning("could not restore source graph caches for %s", source_pid, exc_info=True)
    # 2. Fallible git cleanup LAST — the working tree already holds the restored data, so this
    #    only re-aligns the index/HEAD. Undo any partial commit (reset --soft keeps the source's
    #    OWN working-tree edits), then unstage the reading-list + moved slugs' paths.
    try:
        projects._git(source_pid, "reset", "--soft", snap["head"])
        reset_paths = ["reading-list.md"]
        root = config.project_dir()
        for slug in slugs:
            for f in (store.corpus_path(slug), *_transcript_paths(slug)):
                reset_paths.append(str(f.relative_to(root)))
        projects._git(source_pid, "reset", "-q", "--", *reset_paths)
    except Exception:
        log.warning("git cleanup of source rollback %s was incomplete", source_pid,
                    exc_info=True)


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

    # Two layers of locking (task #75):
    #  1. `project_exclusive(source_pid)` — the project WRITE lock. The route already marked
    #     the source busy (refusing NEW synchronous writers at entry); acquiring this drains any
    #     writer already IN FLIGHT (an /approve, /start, notes-save mid-commit) before we
    #     relocate, so nothing's git-committing operation overlaps ours.
    #  2. Each selected paper's `mutation_lock` across BOTH snapshot and source removal, so a
    #     transcript rewrite for one of the moved papers can't commit newer state into a paper
    #     we then delete. Sorted + ExitStack so ordering is deterministic (no lock cycle).
    token = config.set_active_project(source_pid)
    try:
        with config.project_exclusive(source_pid), contextlib.ExitStack() as locks:
            _enter_session_locks(locks, slugs)
            bundle = _gather_source(slugs)
            departed_notes = {s: b["notes"] for s, b in bundle.items() if b["notes"].strip()}
            departed_titles = {
                s: b["entry"]["title"] for s, b in bundle.items() if b["notes"].strip()
            }

            # Scaffold the new project (takes a pid, not the contextvar) and populate it —
            # inside the locks so the moved snapshot can't drift before the source removal.
            meta = projects.create_project(name)
            new_pid = meta["id"]
            # The new pid is visible in the registry the moment create_project returns, so
            # mark it busy while we populate it: a client that refreshes projects and starts a
            # graph/retrieval job on it mid-population would read a half-written reading list
            # and race graph_store.load/save. Cleared once its commit lands.
            config.mark_project_busy(new_pid)
            try:
                if goals:
                    projects.update_meta(new_pid, goals=goals.strip())
                new_token = config.set_active_project(new_pid)
                try:
                    _write_new_project(new_pid, bundle, keep)
                finally:
                    config.reset_active_project(new_token)
                # Fresh scaffold — everything in it is split-owned, so `add -A` is safe here.
                projects._git(new_pid, "add", "-A")
                projects._git(new_pid, "commit", "-q", "-m",
                              f"Split {len(slugs)} paper(s) from {source_pid}")
            finally:
                config.unmark_project_busy(new_pid)

            removed = False
            if remove_from_source:
                changed = _remove_from_source(source_pid, slugs)
                projects._git(source_pid, "add", "--", *changed)
                # A paper that existed only as an uncommitted reading-list add restores the
                # file to HEAD when removed → nothing staged. Detect that from the staged diff
                # (reliable) rather than parsing git's "nothing to commit" text, and skip the
                # empty commit so a completed move still reports success.
                staged = projects._git(source_pid, "diff", "--cached", "--name-only",
                                       "--", *changed)
                if staged.strip():
                    projects._git(source_pid, "commit", "-q", "-m",
                                  f"Split {len(slugs)} paper(s) to {name}", "--", *changed)
                removed = True
    finally:
        config.reset_active_project(token)

    return {
        "new_pid": new_pid,
        "name": name,
        "moved": len(slugs),
        "removed": removed,
        "departed_notes": departed_notes,
        "departed_titles": departed_titles,
    }
