"""Project management (list/create/meta, app-global) plus the per-project reading-list state.

Named `projects_api` to avoid confusion with the `app.projects` service module it drives.
`/meta` stays app-global (not on the project router) so it can read/rename a project without
binding it active via `use_project`, exactly as before the split.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from .. import committer, config, jobs, project_split, projects, sessions, store
from ..committer import CommitError
from ..project_split import SplitError
from ..projects import ProjectError
from . import make_project_router

router = APIRouter()
project_router = make_project_router()


class ProjectReq(BaseModel):
    name: str
    method: str | None = None   # optional starting reading-method; defaults to the template


class MetaPatchReq(BaseModel):
    name: str | None = None
    favorite: bool | None = None


@router.get("/api/projects")
def list_projects():
    return {"projects": projects.list_projects()}


@router.get("/api/recent-sessions")
def recent_sessions(limit: int = Query(default=20, ge=1, le=100)):
    return {"sessions": projects.recent_sessions(limit)}


@router.post("/api/projects")
def create_project(req: ProjectReq):
    try:
        meta = projects.create_project(req.name, req.method)
    except ProjectError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"project": meta}


@router.get("/api/projects/{pid}/meta")
def project_meta(pid: str):
    if not projects.exists(pid):
        raise HTTPException(status_code=404, detail=f"Unknown project: {pid}")
    return {"project": projects._read_meta(pid)}


@router.patch("/api/projects/{pid}/meta")
def update_project_meta(pid: str, req: MetaPatchReq):
    """Rename and/or (un)favorite. Fields are independent so the client can PATCH just one."""
    if req.name is None and req.favorite is None:
        raise HTTPException(status_code=400, detail="Nothing to update.")
    try:
        meta = projects._read_meta(pid) if projects.exists(pid) else None
        if req.name is not None:
            meta = projects.rename_project(pid, req.name)
        if req.favorite is not None:
            meta = projects.set_favorite(pid, req.favorite)
        if meta is None:
            raise ProjectError(f"Unknown project: {pid}")
    except ProjectError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"project": meta}


@router.delete("/api/projects/{pid}")
def delete_project(pid: str):
    try:
        projects.delete_project(pid)
    except ProjectError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"ok": True}


@project_router.delete("/papers/{slug}")
def remove_paper(pid: str, slug: str):
    """Remove a paper from this project's reading list. Product decision: its notes are KEPT
    — a marker line is appended so the retained notes say the paper left the list — and the
    corpus text / session transcript stay on disk (warm start if it is ever re-added).

    This is the one write path besides /approve and notes-save that git-commits directly:
    the client only calls it after the user's explicit in-app confirmation, so the human
    approval that invariant 4 requires has already happened. Deterministic and fast (no LLM,
    no network) ⇒ a plain request, not a background job.

    Held under the project write guard: a split/move relocating this project reserves it and
    rewrites its reading list + git index synchronously, so this removal's own commit must not
    overlap that window (see config.project_write_guard / task #75)."""
    paper = store.get_paper(slug)
    if paper is None:
        raise HTTPException(status_code=404, detail=f"Unknown paper: {slug}")
    try:
        with config.project_write_guard(pid):
            notes_kept = store.has_notes(slug)
            if notes_kept:
                store.append_removed_marker(slug)
            store.remove_entry(slug)
            # Stage and commit ONLY what this removal changed. The confirm approved removing
            # this paper — not whatever else happens to be dirty in the project tree (an
            # in-flight job's transcript write, another request's edit), so a blanket `add -A`
            # here would sweep unapproved changes into the record. The pathspec bounds it too.
            changed = ["reading-list.md"]
            if notes_kept:
                changed.append(str(store.corpus_path(slug).relative_to(config.project_dir())))
            try:
                committer._git("add", "--", *changed)
                committer._git(
                    "commit", "-q", "-m", f"Remove {paper.title} from reading list",
                    "--", *changed,
                )
            except CommitError as e:
                if "nothing to commit" not in str(e):
                    raise HTTPException(status_code=500, detail=str(e)) from e
    except config.ProjectBusyError as e:
        raise HTTPException(
            status_code=409,
            detail="This project is being moved or split — wait, then remove.",
        ) from e
    return {"removed": slug, "notes_kept": notes_kept}


class RemoveBatchReq(BaseModel):
    slugs: list[str]


@project_router.post("/papers/remove-batch")
def remove_papers(pid: str, req: RemoveBatchReq):
    """Remove several papers in ONE atomic git commit (the multi-select Delete, R9.13). A
    client-side loop of single removals could half-apply if the app disconnects partway; this
    does all of them under one write guard + one commit, so it's all-or-nothing — a fast
    deterministic op (no LLM/network), so a single request, not a background job. Same
    notes-kept + retained-files posture as the single removal. Unknown slugs are skipped
    (idempotent), so a retry of a partially-succeeded earlier attempt is safe."""
    slugs = list(dict.fromkeys(req.slugs))
    if not slugs:
        raise HTTPException(status_code=400, detail="No papers selected.")
    try:
        # EXCLUSIVE lock, not the shared write guard: the batch's snapshot→mutate→commit→
        # rollback must be atomic against every OTHER synchronous writer too, or a concurrent
        # add/remove/approve could land between the snapshot and a rollback and be silently
        # discarded when we restore. The exclusive side drains in-flight writers and blocks new
        # ones for the batch's (brief) duration. The busy-check refuses the batch while a
        # split/move has reserved the project (its exclusive lock would otherwise just make us
        # wait, then run — but a relocation means the record is being rewritten, so 409).
        with config.project_exclusive(pid):
            if config.project_is_busy(pid):
                raise config.ProjectBusyError(pid)
            # Snapshot the touched files BEFORE mutating, so a git failure (index lock,
            # read-only .git) rolls the working tree back to pre-batch — the removals must be
            # all-or-nothing, not applied-but-uncommitted (a retry would then skip them and
            # never commit). Pure-filesystem restore, independent of git.
            reading_list_before = store._reading_list().read_bytes()
            corpus_before: dict[str, bytes] = {}
            removed: list[str] = []
            changed = ["reading-list.md"]
            try:
                for slug in slugs:
                    paper = store.get_paper(slug)
                    if paper is None:
                        continue  # already gone — skip so a retry is idempotent
                    corpus = store.corpus_path(slug)
                    if store.has_notes(slug):
                        corpus_before[slug] = corpus.read_bytes()
                        store.append_removed_marker(slug)
                        changed.append(str(corpus.relative_to(config.project_dir())))
                    store.remove_entry(slug)
                    removed.append(slug)
                if removed:
                    committer._git("add", "--", *changed)
                    try:
                        committer._git(
                            "commit", "-q", "-m",
                            f"Remove {len(removed)} paper(s) from reading list", "--", *changed,
                        )
                    except CommitError as e:
                        if "nothing to commit" not in str(e):
                            raise
            except Exception as e:
                # Restore the working tree to pre-batch (files first, git cleanup best-effort).
                store._reading_list().write_bytes(reading_list_before)
                store._parse_cache.clear()
                for slug, data in corpus_before.items():
                    try:
                        store.corpus_path(slug).write_bytes(data)
                    except OSError:
                        pass
                try:
                    committer._git("reset", "-q", "--", *changed)
                except CommitError:
                    pass
                if isinstance(e, HTTPException):
                    raise
                raise HTTPException(
                    status_code=500, detail="Could not remove the papers.") from e
    except config.ProjectBusyError as e:
        raise HTTPException(
            status_code=409,
            detail="This project is being moved or split — wait, then remove.",
        ) from e
    return {"removed": removed}


class SplitReq(BaseModel):
    name: str                       # the new project's name
    slugs: list[str]                # papers to split out (must be current source entries)
    remove_from_source: bool = True  # move (default) vs. copy
    goals: str | None = None        # optional theme for the new project (seeds discovery etc.)


@project_router.post("/split")
def split_project(pid: str, req: SplitReq):
    """Split selected papers (and the work done on them) into a new project. Deterministic
    phase 1: no LLM, no network — a plain confirmed POST that git-commits both sides, like
    the removal endpoint above. The optional AI working-notes passes are separate jobs.

    Refused (409) while any background job is running for the source project: a chat turn or
    graph build mid-move would write into files being relocated. Mark the source busy FIRST,
    then sweep — so a job admitted after the sweep is refused by the busy gate
    (`jobs.start_or_join`), closing the window between the check and the move (the same
    atomic tombstone-then-sweep shape project deletion uses)."""
    # Exclusive reservation: a second concurrent split of the same project is rejected rather
    # than interleaving two mutations of one reading list / git index (and the first's
    # unmark would otherwise re-admit jobs while the second still runs).
    if not config.mark_project_busy(pid):
        raise HTTPException(status_code=409, detail="This project is already being split.")
    try:
        # Mutual exclusion with deletion: delete marks the pid deleting THEN checks busy, so
        # checking deleting here (after we reserved busy) means the two can't both proceed —
        # whichever set its flag first wins and the other is refused.
        if config.project_is_deleting(pid):
            raise HTTPException(status_code=409, detail="This project is being deleted.")
        busy = jobs.any_running_for_project(pid)
        if busy:
            raise HTTPException(
                status_code=409,
                detail=f"A background job ({busy}) is running for this project — wait, then split.",
            )
        result = project_split.split_project(
            pid, req.name, req.slugs,
            remove_from_source=req.remove_from_source, goals=req.goals,
        )
    except SplitError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except ProjectError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    finally:
        config.unmark_project_busy(pid)
    # departed_notes is server-side context for the (future) source-cleanup pass; not returned.
    return {k: v for k, v in result.items() if k != "departed_notes"}


class MoveReq(BaseModel):
    dest_pid: str                    # an EXISTING destination project
    slugs: list[str]                 # papers to move (must be current source entries)
    remove_from_source: bool = True  # move (default) vs. copy


@project_router.post("/move")
def move_papers(pid: str, req: MoveReq):
    """Move selected papers (and their work) into an EXISTING project (R9.13) — the
    deterministic sibling of /split.

    Reserves BOTH the source and the destination for the whole move: mark each busy, then sweep
    jobs on each, so a chat turn or graph build on either side can't write into files being
    relocated (the same mark-then-sweep the split route uses for the source, applied to both);
    `move_to_existing` then takes each project's exclusive write lock to drain in-flight
    synchronous writers. Distinct 409s let the client tell the user which side is busy."""
    dest = req.dest_pid
    if dest == pid:
        raise HTTPException(status_code=400, detail="Choose a different project to move into.")
    if not projects.exists(dest):
        raise HTTPException(status_code=404, detail="The destination project no longer exists.")
    if not config.mark_project_busy(pid):
        raise HTTPException(status_code=409, detail="This project is already being modified.")
    try:
        if config.project_is_deleting(pid):
            raise HTTPException(status_code=409, detail="This project is being deleted.")
        if not config.mark_project_busy(dest):
            raise HTTPException(
                status_code=409, detail="The destination project is being modified.")
        try:
            if config.project_is_deleting(dest):
                raise HTTPException(
                    status_code=409, detail="The destination project is being deleted.")
            for side, label in ((pid, "this project"), (dest, "the destination")):
                busy = jobs.any_running_for_project(side)
                if busy:
                    raise HTTPException(
                        status_code=409,
                        detail=f"A background job ({busy}) is running for {label} — "
                               "wait, then move.",
                    )
            result = project_split.move_to_existing(
                pid, dest, req.slugs, remove_from_source=req.remove_from_source,
            )
        finally:
            config.unmark_project_busy(dest)
    except SplitError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except ProjectError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    finally:
        config.unmark_project_busy(pid)
    return {k: v for k, v in result.items() if k != "departed_notes"}


@project_router.get("/state")
def get_state(pid: str):
    settings = config.load_settings()
    states = sessions.session_states()
    papers = [p.to_dict() for p in store.list_papers(states)]
    return {
        "project": projects._read_meta(pid) or {"id": pid, "name": pid},
        "has_key": bool(settings.get("openrouter_api_key")),
        "model": settings.get("model"),
        "narration_model": settings.get("narration_model"),
        "preview_model": settings.get("preview_model") or settings.get("narration_model"),
        "speech_provider": settings.get("speech_provider"),
        "has_openai_key": bool(settings.get("openai_api_key")),
        "papers": papers,
    }
