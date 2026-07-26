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
from pathlib import Path, PurePosixPath

from fastapi import HTTPException, Request

from . import config, jobs, logging_config, prompts, store, tenancy
from .fileio import atomic_write_text

log = logging_config.get("projects")

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
_PID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]*")

#: A path segment cannot exceed this on any filesystem we run on, so an id longer than it could
#: never have been a real directory — and accepting one lets a value through this boundary that
#: only fails much later, at mkdir, far from the check that should have caught it.
_PID_MAX_LENGTH = 255


def _safe_pid(pid: str) -> str:
    # `fullmatch`, not `match`: Python's `$` also matches immediately BEFORE a trailing newline, so
    # `_PID_RE.match("project\n")` succeeded and `"project\n"` was accepted as a project id. It is
    # not a legitimate id by any route, and it is the kind of value that behaves differently in
    # every layer that later handles it — a filesystem name, a log line, a database CHECK (Postgres
    # regexes have no such newline rule, so the same id is valid here and invalid there).
    if not isinstance(pid, str) or len(pid) > _PID_MAX_LENGTH or not _PID_RE.fullmatch(pid):
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
            loaded = json.loads(p.read_text())
        except (json.JSONDecodeError, OSError, UnicodeDecodeError):
            return {}
        # Must be a dict. `project.json` holding `[]` — from a corrupted write, or a stray
        # directory under PROJECTS_ROOT — otherwise reaches `.get()` in `list_projects` and takes
        # down the whole project list, not just that one project.
        if isinstance(loaded, dict):
            return loaded
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
        except OSError:
            # One unreadable project must not take the whole registry with it. `store.list_papers`
            # touches per-paper files, and a path that is a DIRECTORY where a file is expected
            # raises IsADirectoryError — which, unhandled, makes every project disappear from the
            # app rather than just the broken one. Import rejects such trees now, but the registry
            # should not depend on that being airtight.
            log.warning("project %s could not be read; listing it with no papers", pid)
            papers = []
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
    """The project's approved record, as a git bundle. Working state (`.state/`) never travels.

    Exports **HEAD only**, not `--all`. `--all` sweeps in every ref the repo happens to carry —
    `refs/stash` above all, which can hold working material that was never approved, and which is
    exactly the thing this app's whole "agent proposes, human commits" rule exists to keep out of
    the record. The shareable project is the committed history of the current branch, nothing else.
    """
    if not exists(pid):
        raise ProjectError(f"Unknown project: {pid}")
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "project.bundle"
        _git(pid, "bundle", "create", str(out), "HEAD")
        return out.read_bytes()


#: Tree entry modes git will happily materialize that we must never accept from a stranger.
_SYMLINK_MODE = "120000"
_GITLINK_MODE = "160000"

#: Expansion bounds. A byte cap on the BUNDLE says nothing about what it inflates to — a small,
#: highly compressed bundle can check out into an enormous file or millions of paths and exhaust
#: the volume before anything is published. A real project here is ~30 files and ~1 MB.
MAX_TREE_ENTRIES = 20_000
MAX_BLOB_BYTES = 50 * 1024 * 1024
MAX_CHECKOUT_BYTES = 500 * 1024 * 1024
MAX_PATH_DEPTH = 24
MAX_PATH_LENGTH = 255

#: Files that change how git ITSELF behaves during checkout, rather than being ordinary content.
#: `.gitattributes` is the dangerous one: it can select a filter driver (`filter=lfs`) whose
#: command comes from the HOST's git config, so a bundle can cause an external process to run and
#: make network requests. Disabling hooks does not disable filters.
_GIT_CONTROL_FILES = {".gitattributes", ".gitconfig", ".gitmodules"}

#: git invoked so nothing on this machine can be recruited by the bundle: GIT_CONFIG_* neutralize
#: host-level filter and alias definitions, and the hooks path removes the other execution route.
_SAFE_GIT_ENV = {
    **os.environ,
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_SYSTEM": os.devnull,
    "GIT_ATTR_NOSYSTEM": "1",
    "GIT_TERMINAL_PROMPT": "0",
}


def _is_state_path(path: str) -> bool:
    """Whether `path` lands in `.state/`, including aliases a filesystem would fold together.

    Case-folded because macOS is case-insensitive: `.STATE/sessions.json` is a different string
    but the same file, and a planted session index breaks the cross-project recent-sessions view.
    """
    return path.split("/", 1)[0].casefold() == ".state"


def _reject_hostile_tree(repo: Path) -> None:
    """Refuse a bundle whose tree would put something dangerous on disk.

    `git bundle verify` checks INTEGRITY, not safety, and git's own path rules only stop `..` and
    absolute paths. It will cheerfully create a **symlink** — so a bundle tracking
    `.state/covers/x.png -> /etc/passwd` survives clone, and `GET .../papers/x/cover.png` then
    serves the host's file straight back through `FileResponse`. A directory symlink under
    `corpus/` or `sessions/` redirects this app's later writes outside the project entirely.

    Inspected BEFORE checkout, and with `-z`: without it git C-quotes any path containing control
    or non-ASCII characters, which both mangles the parse and lets a crafted name slip past a
    prefix test.
    """
    listing = subprocess.run(
        ["git", "ls-tree", "-r", "-l", "-z", "--full-tree", "HEAD"],
        cwd=str(repo), capture_output=True, env=_SAFE_GIT_ENV)
    if listing.returncode != 0:
        raise ProjectError("Could not read the bundle's contents.")

    total = 0
    entries = 0
    for record in listing.stdout.split(b"\0"):
        if not record:
            continue
        entries += 1
        if entries > MAX_TREE_ENTRIES:
            raise ProjectError(f"Refusing bundle: more than {MAX_TREE_ENTRIES} files.")
        meta, _, raw_path = record.partition(b"\t")
        try:
            path = raw_path.decode("utf-8")
        except UnicodeDecodeError as e:
            raise ProjectError("Refusing bundle: it contains a non-UTF-8 path.") from e
        fields = meta.split()
        mode = fields[0].decode()
        size = fields[3].decode() if len(fields) > 3 else "-"

        if mode == _SYMLINK_MODE:
            raise ProjectError(f"Refusing bundle: it contains a symlink ({path}).")
        if mode == _GITLINK_MODE:
            raise ProjectError(f"Refusing bundle: it contains a submodule ({path}).")
        if _is_state_path(path):
            raise ProjectError(f"Refusing bundle: it tracks working state ({path}).")
        if PurePosixPath(path).name in _GIT_CONTROL_FILES:
            raise ProjectError(f"Refusing bundle: it carries git configuration ({path}).")
        if len(path) > MAX_PATH_LENGTH or path.count("/") + 1 > MAX_PATH_DEPTH:
            raise ProjectError("Refusing bundle: a path is too long or too deep.")

        if size.isdigit():
            blob = int(size)
            if blob > MAX_BLOB_BYTES:
                raise ProjectError(f"Refusing bundle: {path} is larger than "
                                   f"{MAX_BLOB_BYTES // (1024 * 1024)} MB.")
            total += blob
            if total > MAX_CHECKOUT_BYTES:
                raise ProjectError("Refusing bundle: it expands to more than "
                                   f"{MAX_CHECKOUT_BYTES // (1024 * 1024)} MB.")


def _assert_project_shape(repo: Path) -> None:
    """Every path this app later opens as a file must actually BE a file.

    A bundle can name `corpus/<slug>.md` as a DIRECTORY. Import would succeed, and then
    `list_projects` — which reads per-paper files — raises IsADirectoryError and every project
    vanishes from the app, not just this one. The listing is defended separately; this stops the
    bad tree getting in at all.
    """
    if not (repo / "reading-list.md").is_file():
        raise ProjectError("That bundle is not a Research Companion project.")
    for directory in ("corpus", "sessions"):
        d = repo / directory
        if d.exists() and not d.is_dir():
            raise ProjectError(f"Refusing bundle: {directory} is not a directory.")
        if d.is_dir():
            for child in d.rglob("*.md"):
                if child.is_dir():
                    raise ProjectError(f"Refusing bundle: {child.name} is a directory.")


def _sanitized_meta(repo: Path, pid: str, name: str) -> dict:
    """Build this instance's metadata from scratch rather than trusting the bundle's.

    A `project.json` of `[]` would otherwise reach `meta.update()`, raise AttributeError *after*
    the project was already in place, and leave a directory that every subsequent project listing
    trips over — one bad import bricking the list for good.
    """
    raw: dict = {}
    meta_file = repo / META
    if meta_file.exists():
        try:
            loaded = json.loads(meta_file.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                raw = loaded
        except (json.JSONDecodeError, OSError, UnicodeDecodeError):
            raw = {}
    created = raw.get("created_at")
    return {
        "id": pid,
        "name": name,
        "created_at": created if isinstance(created, str) else _now(),
        "imported_at": _now(),
    }


def import_bundle(data: bytes, name: str) -> dict:
    """Create a new project from a git bundle. Never overwrites: always a fresh id.

    The bundle is untrusted — it arrives over HTTP from another instance — so the order matters:
    verify, clone WITHOUT checking out, inspect the tree, only then materialize it, and only then
    publish. Publication is a single atomic rename from a staging directory inside PROJECTS_ROOT,
    so a failure at any earlier point leaves nothing behind that the app would list as a project.
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

    # Staged INSIDE PROJECTS_ROOT, not in the system temp dir: the final step must be a rename on
    # one filesystem, which is atomic. Across filesystems shutil.move degrades to a copy, and a
    # crash mid-copy leaves a visible half-project. Dot-prefixed so `list_projects` skips it.
    config.PROJECTS_ROOT.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".importing-", dir=str(config.PROJECTS_ROOT)))
    try:
        bundle = staging / "incoming.bundle"
        bundle.write_bytes(data)
        # `git bundle verify` REQUIRES a repository context — with none it fails with "need a
        # repository to verify a bundle" regardless of how good the bundle is. That never showed
        # up in tests because pytest's working directory is inside this repo, and it never showed
        # up locally for the same reason. In the container the working directory is `/srv`, which
        # is a COPY of the source and not a git repo at all, so every import would have been
        # refused in production. Give it a throwaway empty repo of its own.
        scratch = staging / "verify.git"
        subprocess.run(["git", "init", "-q", "--bare", str(scratch)],
                       capture_output=True, check=True, env=_SAFE_GIT_ENV)
        verify = subprocess.run(["git", "bundle", "verify", str(bundle)],
                                cwd=str(scratch), capture_output=True, text=True,
                                env=_SAFE_GIT_ENV)
        if verify.returncode != 0:
            raise ProjectError(f"Not a valid project bundle: {verify.stderr.strip()}")

        repo = staging / "clone"
        clone = subprocess.run(
            # --no-checkout: nothing from the bundle reaches the filesystem until the tree has been
            #   inspected. core.hooksPath=/dev/null and --no-recurse-submodules remove the two
            #   other ways a clone can be talked into running or fetching something.
            ["git", *config.git_identity_args(), "-c", "core.hooksPath=/dev/null",
             "clone", "-q", "--no-checkout", "--no-recurse-submodules", str(bundle), str(repo)],
            capture_output=True, text=True, env=_SAFE_GIT_ENV)
        if clone.returncode != 0:
            raise ProjectError(f"Could not import the bundle: {clone.stderr.strip()}")

        _reject_hostile_tree(repo)

        checkout = subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "checkout", "-q"],
                                  cwd=str(repo), capture_output=True, text=True, env=_SAFE_GIT_ENV)
        if checkout.returncode != 0:
            raise ProjectError(f"Could not import the bundle: {checkout.stderr.strip()}")

        _assert_project_shape(repo)
        try:
            (repo / "reading-list.md").read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError) as e:
            raise ProjectError("That bundle's reading list is not readable text.") from e

        meta = _sanitized_meta(repo, pid, name)
        atomic_write_text(repo / META, json.dumps(meta, indent=2))
        (repo / ".state").mkdir(exist_ok=True)
        bundle.unlink(missing_ok=True)

        try:
            os.rename(str(repo), str(dest))  # atomic, and fails rather than merging into an
        except OSError as e:                 # existing directory if the id was taken meanwhile
            raise ProjectError(f"Could not place the imported project: {e}") from e
    finally:
        shutil.rmtree(staging, ignore_errors=True)
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
        # Free the id in the ownership index too. Trashing the directory makes the id available
        # again to `_unique_id`, so a surviving row would silently make the NEXT project to take
        # that id belong to this owner — its creator unable to open it, and this owner able to read
        # content that is not theirs.
        tenancy.release(pid)
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


async def use_project(pid: str, request: Request):
    """FastAPI dependency: validate the project and bind it as active for the request.

    MUST be async: a sync generator dependency runs its body in a worker thread, so a
    contextvar set there would not propagate to the (threadpooled) sync endpoint. As an async
    dependency this runs in the request task, so the value is captured into the context copied
    for the endpoint and for StreamingResponse iteration. The finally (reset) runs after the
    response is fully sent, keeping the project bound throughout streaming."""
    # Ownership FIRST, before the deleting-check and the existence-check. Both of those answer
    # differently for a real project than for an invented one — a 409 "being deleted" versus a
    # 404 — so running them first would tell a stranger that someone else's project exists, which
    # is what the 404-not-403 choice above exists to prevent.
    if not tenancy.may_access(pid, getattr(request.state, "user", None)):
        raise HTTPException(status_code=404, detail=f"Unknown project: {pid}")
    if config.project_is_deleting(pid):
        raise HTTPException(status_code=409, detail=f"Project is being deleted: {pid}")
    if not exists(pid):
        raise HTTPException(status_code=404, detail=f"Unknown project: {pid}")
    token = config.set_active_project(pid)
    try:
        yield pid
    finally:
        config.reset_active_project(token)
