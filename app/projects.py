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
import subprocess
from datetime import UTC, datetime
from pathlib import Path

from fastapi import HTTPException

from . import config, prompts, store
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
        if not d.is_dir():
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
            "paper_count": len(papers),
            "read_count": sum(1 for p in papers if p.list_status == "read"),
        })
    out.sort(key=lambda p: (p.get("created_at") or "", p["name"]))
    return out


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
    if not exists(pid):
        raise HTTPException(status_code=404, detail=f"Unknown project: {pid}")
    token = config.set_active_project(pid)
    try:
        yield pid
    finally:
        config.reset_active_project(token)
