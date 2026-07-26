"""Multi-project registry over config.PROJECTS_ROOT.

Each project is a subdirectory (its own git repo) holding reading-list.md, reading-method.md,
working-notes.md, corpus/, sessions/, .state/, and a project.json meta file. App-global
settings (API keys, model/TTS picks, prompts) live outside any project — see config.

The active project for a request is set by the use_project() dependency, which binds
config's active-project contextvar so the store/sessions layers resolve the right paths.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from fastapi import HTTPException

from . import config, jobs, prompts, store
from .fileio import atomic_write_text

META = "project.json"
_SLUG_RE = re.compile(r"[^a-z0-9]+")


class ProjectError(Exception):
    pass


_STARTER_READING_LIST = """# Reading list

Papers are grouped by topic. Each entry carries the title and an italic status marker.

> Machine-readable note: status per entry is the italic `*unread*` / `*read*` marker right
> after the title. When a paper is read, a short Notes block is appended to its corpus file.
> Optional citation links may be added per entry as an HTML comment, e.g.
> `<!-- cites: some-slug, other-slug -->`, which the context assembler uses to pull the right
> prior Notes blocks. An optional `<!-- slug: my-slug -->` pins a stable slug.

## Unsorted

"""

_STARTER_WORKING_NOTES = """# Working notes — running cross-paper context

*This file holds the live cross-paper threads, recurring groups and authors, open questions
carried forward, and corrections made during discussion. It starts empty and accumulates as
papers are read.*
"""


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def slugify(name: str) -> str:
    s = _SLUG_RE.sub("-", name.strip().lower()).strip("-")
    return s or "project"


# A project id is a single path segment: slugify() output (`[a-z0-9-]`) plus optional `-N`
# uniqueness suffixes (underscores tolerated for env-configured ids). No separators, no `.`
# (so no `..`), never absolute — so `PROJECTS_ROOT / pid` can never escape the root. This is the
# trust boundary for EVERY caller that turns an untrusted id into a path: `use_project` (the
# route pid) and the audio billing `project` both flow through here.
_PID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")


def _safe_pid(pid: str) -> str:
    if not isinstance(pid, str) or not _PID_RE.match(pid):
        raise ProjectError(f"Invalid project id: {pid!r}")
    return pid


def project_path(pid: str) -> Path:
    """The directory for `pid`, guaranteed to be inside PROJECTS_ROOT. Raises ProjectError for
    any id that isn't a plain contained segment (traversal, absolute, separators)."""
    safe = _safe_pid(pid)
    root = config.PROJECTS_ROOT
    p = root / safe
    # Defense in depth: even if the charset check ever drifts, the path must stay under the root.
    # abspath (not resolve) so this is a pure lexical check — no symlink chasing, no FS access.
    if os.path.commonpath((os.path.abspath(p), os.path.abspath(root))) != os.path.abspath(root):
        raise ProjectError(f"Invalid project id: {pid!r}")
    return p


def exists(pid: str) -> bool:
    try:
        return project_path(pid).is_dir()
    except ProjectError:
        return False


def _read_meta(pid: str) -> dict:
    p = project_path(pid) / META
    if p.exists():
        try:
            return json.loads(p.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def _write_meta(pid: str, meta: dict) -> None:
    atomic_write_text(project_path(pid) / META, json.dumps(meta, indent=2))


def _git(pid: str, *args: str) -> str:
    # Pin the author (config.git_identity_args) so create_project's baseline commit succeeds even
    # on a host with no global git identity. Surface non-zero exits as ProjectError rather than
    # swallowing them (check=False), so scaffolding a project can't silently "succeed" with no
    # baseline commit — e.g. a missing git binary, no write permission, or a corrupt repo.
    proc = subprocess.run(["git", *config.git_identity_args(), *args],
                          cwd=str(project_path(pid)), capture_output=True, text=True)
    if proc.returncode != 0:
        raise ProjectError(f"git {' '.join(args)} failed: {proc.stderr.strip()}")
    return proc.stdout.strip()


def _unique_id(base: str) -> str:
    pid, n = base, 2
    while exists(pid):
        pid, n = f"{base}-{n}", n + 1
    return pid


def list_projects() -> list[dict]:
    """Every project with id, name, created_at, and paper/read counts."""
    config.PROJECTS_ROOT.mkdir(parents=True, exist_ok=True)
    out = []
    for d in sorted(config.PROJECTS_ROOT.iterdir()):
        # Dot-dirs are never projects — `.trash` in particular holds soft-deleted projects
        # (see delete_project) whose ids must not resurface in the registry.
        if not d.is_dir() or d.name.startswith("."):
            continue
        pid = d.name
        meta = _read_meta(pid)
        # Count papers by temporarily activating the project.
        token = config.set_active_project(pid)
        try:
            papers = store.list_papers()
        finally:
            config.reset_active_project(token)
        out.append({
            "id": pid,
            "name": meta.get("name", pid),
            "created_at": meta.get("created_at"),
            "favorite": bool(meta.get("favorite")),
            "paper_count": len(papers),
            "read_count": sum(1 for p in papers if p.list_status == "read"),
        })
    out.sort(key=lambda p: (not p["favorite"], p.get("created_at") or "", p["name"]))
    return out


def recent_sessions(limit: int = 20) -> list[dict]:
    """Recent session activity across projects, newest first.

    Session state is project-scoped, so every index read is performed with that project bound
    to the active contextvar. Only registry-derived ids reach the path boundary.
    """
    from . import sessions, store

    out = []
    for project in list_projects():
        pid = project["id"]
        token = config.set_active_project(pid)
        try:
            index = sessions.session_index()
            papers_by_slug = {p.slug: p for p in store.list_papers()}
            current_slugs = set(papers_by_slug)
        finally:
            config.reset_active_project(token)
        for slug, meta in index.items():
            updated_at = meta.get("updated_at")
            if not updated_at:
                continue
            # Session metadata survives a paper's removal (the transcript is kept for a warm
            # re-add), but a removed paper must not be re-advertised here — the Continue card
            # would route to a slug /session/{slug} now 404s. An in-flight job finishing after
            # removal re-touches the index, so filtering at read time is the reliable spot.
            if meta.get("kind", "paper") == "paper" and slug not in current_slugs:
                continue
            paper = papers_by_slug.get(slug)
            out.append({
                "project_id": pid,
                "project_name": project["name"],
                "slug": slug,
                "title": meta.get("title", slug),
                "kind": meta.get("kind", "paper"),
                "state": meta.get("state"),
                "started_at": meta.get("started_at"),
                "updated_at": updated_at,
                "arxiv_id": paper.arxiv_id if paper else "",
                "source_url": paper.source_url if paper else "",
            })
    out.sort(key=lambda item: item["updated_at"], reverse=True)
    return out[:limit]


def create_project(name: str, method: str | None = None) -> dict:
    """Scaffold a new project dir (git repo) with starter files. Returns its meta."""
    name = (name or "").strip()
    if not name:
        raise ProjectError("Project name is required.")
    pid = _unique_id(slugify(name))
    root = project_path(pid)
    root.mkdir(parents=True, exist_ok=False)
    (root / "corpus").mkdir()
    (root / "sessions").mkdir()
    (root / ".state").mkdir()
    (root / "reading-list.md").write_text(_STARTER_READING_LIST, encoding="utf-8")
    default_method = prompts.REGISTRY_BY_KEY["reading_method"].bundled_default
    (root / "reading-method.md").write_text(method or default_method, encoding="utf-8")
    (root / "working-notes.md").write_text(_STARTER_WORKING_NOTES, encoding="utf-8")
    (root / ".gitignore").write_text(".state/\n", encoding="utf-8")
    meta = {"id": pid, "name": name, "created_at": _now()}
    _write_meta(pid, meta)
    _git(pid, "init", "-q", "-b", "main")
    _git(pid, "add", "-A")
    _git(pid, "commit", "-q", "-m", f"Initialize project: {name}")
    return meta


# --- sharing: a project moves between instances as a git bundle ----------------------------------
#
# A bundle rather than an archive of the directory, because the git history IS the record here
# (invariant 4: the agent proposes, a human approves, and only then does anything reach git). A
# bundle carries every commit, so the approval trail survives the move intact.
#
# It is also dramatically smaller, for a reason worth stating: `.gitignore` excludes `.state/`, and
# `.state/` is nearly all of a project on disk — 207 MB of one 214 MB project here. That project
# bundles to **1.1 MB in 0.17 s**, which is why export is a plain request and not a background job
# (invariant 1 is about operations that can run for minutes).
#
# And it sidesteps a whole bug class: extracting an untrusted archive means defending against
# absolute and `..` paths yourself. Git validates its own bundle, and a bundle cannot carry hooks —
# they live in `.git/hooks`, which is not tracked.

#: Bundles above this are refused unread. A real project is ~1 MB; this is 200x that.
MAX_BUNDLE_BYTES = 200 * 1024 * 1024


def export_bundle(pid: str) -> bytes:
    """Every commit in `pid`, as a git bundle. Working state (`.state/`) is excluded by design."""
    if not exists(pid):
        raise ProjectError(f"Unknown project: {pid}")
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "project.bundle"
        # `--all` plus HEAD: --all covers every branch and tag, and HEAD makes the clone check out
        # the right branch instead of landing detached.
        _git(pid, "bundle", "create", str(out), "--all", "HEAD")
        return out.read_bytes()


def import_bundle(data: bytes, name: str) -> dict:
    """Create a new project from a git bundle. Never overwrites: always a fresh id.

    The bundle is untrusted — it arrives over HTTP from another instance — so it is verified
    before anything is cloned, and cloned into a temporary directory that is only moved into place
    once it looks like a project. A half-imported directory under PROJECTS_ROOT would otherwise be
    listed as a real project.
    """
    name = (name or "").strip()
    if not name:
        raise ProjectError("A name is required for the imported project.")
    if not data:
        raise ProjectError("The uploaded bundle is empty.")
    if len(data) > MAX_BUNDLE_BYTES:
        raise ProjectError(
            f"Bundle is {len(data) // (1024 * 1024)} MB; the limit is "
            f"{MAX_BUNDLE_BYTES // (1024 * 1024)} MB.")

    pid = _unique_id(slugify(name))
    dest = project_path(pid)  # validates the id before anything touches the filesystem

    with tempfile.TemporaryDirectory() as tmp:
        bundle = Path(tmp) / "incoming.bundle"
        bundle.write_bytes(data)
        # Verify first. `git clone` on a malformed bundle leaves a partial directory behind, and
        # the error it gives is far less legible than this one.
        verify = subprocess.run(["git", "bundle", "verify", str(bundle)],
                                capture_output=True, text=True)
        if verify.returncode != 0:
            raise ProjectError(f"Not a valid project bundle: {verify.stderr.strip()}")

        staged = Path(tmp) / "clone"
        clone = subprocess.run(
            # No --recurse-submodules: a .gitmodules in the bundle must not cause a network fetch.
            ["git", *config.git_identity_args(), "clone", "-q", str(bundle), str(staged)],
            capture_output=True, text=True)
        if clone.returncode != 0:
            raise ProjectError(f"Could not import the bundle: {clone.stderr.strip()}")
        if not (staged / "reading-list.md").exists():
            raise ProjectError("That bundle is not a Research Companion project.")

        # `.state/` is working state and is not in the bundle; recreate it so the project behaves
        # like any other from the first request.
        (staged / ".state").mkdir(exist_ok=True)
        shutil.move(str(staged), str(dest))

    meta = _read_meta(pid)
    meta.update({"id": pid, "name": name, "created_at": meta.get("created_at") or _now(),
                 "imported_at": _now()})
    _write_meta(pid, meta)
    return meta


def update_meta(pid: str, **fields) -> dict:
    """Merge non-None fields into project.json (e.g. the saved discovery goals)."""
    if not exists(pid):
        raise ProjectError(f"Unknown project: {pid}")
    meta = _read_meta(pid)
    meta.update({k: v for k, v in fields.items() if v is not None})
    meta.setdefault("id", pid)
    _write_meta(pid, meta)
    return meta


def rename_project(pid: str, name: str) -> dict:
    if not exists(pid):
        raise ProjectError(f"Unknown project: {pid}")
    name = (name or "").strip()
    if not name:
        raise ProjectError("Project name is required.")
    meta = _read_meta(pid)
    meta.update({"id": pid, "name": name})
    _write_meta(pid, meta)
    return meta


def set_favorite(pid: str, favorite: bool) -> dict:
    if not exists(pid):
        raise ProjectError(f"Unknown project: {pid}")
    meta = _read_meta(pid)
    meta.update({"id": pid, "favorite": bool(favorite)})
    _write_meta(pid, meta)
    return meta


def delete_project(pid: str) -> None:
    """Soft-delete: move the whole project dir (its git history included) into
    PROJECTS_ROOT/.trash/<pid>-<timestamp>. Deliberately not an rm -rf — a project is a
    human's reading record, so deletion stays reversible by moving the dir back. list_projects
    skips dot-dirs, and `.trash` can never be addressed as a pid (_PID_RE forbids a leading
    dot), so trashed copies are invisible to every API path."""
    if not exists(pid):
        raise ProjectError(f"Unknown project: {pid}")
    # A running worker resolves paths from this pid; moving the dir under it would make the
    # worker's next write recreate projects/<pid> as a partial store, split from the trashed
    # copy. So: tombstone first (jobs.start_or_join/put and use_project refuse tombstoned
    # pids), THEN sweep for jobs admitted before the tombstone, then move. Any job either
    # registered before the tombstone (the sweep sees it and refuses) or was admitted after
    # (the tombstone refuses it) — no window where a fresh worker can slip past the move.
    config.mark_project_deleting(pid)
    try:
        # A split or move touching this project is a synchronous mutation (not a job) that
        # relocates its files; deleting the dir under it would strand the operation mid-copy.
        # Both reserve the pid via config.mark_project_busy (a move reserves BOTH its source
        # and destination), so refuse while that reservation is held.
        if config.project_is_busy(pid):
            raise ProjectError(
                "This project is being moved or split — wait for it to finish, then delete.")
        busy = jobs.any_running_for_project(pid)
        if busy:
            raise ProjectError(
                f"A background job ({busy}) is still running for this project — "
                "wait for it to finish, then delete."
            )
        trash = config.PROJECTS_ROOT / ".trash"
        trash.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
        shutil.move(str(project_path(pid)), str(trash / f"{pid}-{stamp}"))
        # A later project with the same name can reuse this pid. Do not let terminal in-memory
        # results/proposals from the deleted project become visible in that new project.
        jobs.forget_finished_for_project(pid)
    finally:
        config.unmark_project_deleting(pid)


def adopt_existing(src: Path, name: str, move: bool = True) -> str:
    """Bring a pre-existing store dir (the legacy ./project) under PROJECTS_ROOT as a project,
    preserving its git history. Adds project.json + .gitignore(.state/) and commits them.
    move=False copies instead (useful for testing without disturbing the original)."""
    import shutil
    config.PROJECTS_ROOT.mkdir(parents=True, exist_ok=True)
    pid = _unique_id(slugify(name))
    dst = project_path(pid)
    if move:
        shutil.move(str(src), str(dst))
    else:
        shutil.copytree(src, dst)
    meta = {"id": pid, "name": name.strip(), "created_at": _now()}
    _write_meta(pid, meta)
    gi = dst / ".gitignore"
    existing = gi.read_text() if gi.exists() else ""
    if ".state/" not in existing:
        gi.write_text((existing.rstrip() + "\n" if existing else "") + ".state/\n")
    if (dst / ".git").exists():
        _git(pid, "add", "project.json", ".gitignore")
        _git(pid, "commit", "-q", "-m", f"Adopt as multiproject store: {name}")
    return pid


async def use_project(pid: str):
    """FastAPI dependency: validate the project and bind it as active for the request.

    MUST be async: a sync generator dependency runs its body in a worker thread, so a
    contextvar set there would not propagate to the (threadpooled) sync endpoint. As an async
    dependency this runs in the request task, so the value is captured into the context copied
    for the endpoint and for StreamingResponse iteration. The finally (reset) runs after the
    response is fully sent, keeping the project bound throughout streaming."""
    if config.project_is_deleting(pid):
        raise HTTPException(status_code=409, detail=f"Project is being deleted: {pid}")
    if not exists(pid):
        raise HTTPException(status_code=404, detail=f"Unknown project: {pid}")
    token = config.set_active_project(pid)
    try:
        yield pid
    finally:
        config.reset_active_project(token)
