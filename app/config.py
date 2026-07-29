"""Runtime configuration.

Two scopes:
- **App-global** (one OpenRouter key, model picks, TTS settings, legacy prompt overrides,
  prompt last-valid state, audio + narration caches) live in APP_STATE_DIR, shared across every
  research project. Authoritative prompt Markdown can instead live in PROMPTS_DIR.
- **Per-project** data (reading list, method, corpus, sessions, notes, session-state index)
  lives under PROJECTS_ROOT/<project-id>/, each its own git repo.

The *active project* for the current request is held in a contextvar set by the API layer
(see app.projects.use_project). Lower layers call project_dir()/state_dir() to resolve paths,
so nothing binds a single project at import time.
"""
from __future__ import annotations

import contextlib
import contextvars
import hashlib
import json
import os
import threading
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

from .fileio import atomic_write_text

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent
# Web client directory. RC_WEB_DIR overrides. If the Vite build output (web/dist/) exists,
# serve that; otherwise fall back to the plain web/ directory for backward compatibility.
_WEB_DIST = BASE_DIR / "web" / "dist"
WEB_DIR = Path(os.environ.get("RC_WEB_DIR", str(_WEB_DIST if _WEB_DIST.exists() else (BASE_DIR / "web")))).resolve()


@dataclass(frozen=True)
class DataPaths:
    """Resolved app data locations after applying explicit-path and vault precedence."""

    vault_root: Path | None
    prompts_dir: Path | None
    projects_root: Path


def resolve_data_paths(environ: Mapping[str, str] | None = None,
                       base_dir: Path | None = None) -> DataPaths:
    """Resolve storage paths without touching the filesystem.

    Explicit per-directory variables win over ``RC_VAULT_ROOT``. With no vault or explicit
    prompt directory, ``prompts_dir`` remains ``None`` so prompt behavior stays exactly as it was
    before vault support (settings override, then bundled default).
    """
    env = os.environ if environ is None else environ
    base = (base_dir or BASE_DIR).resolve()

    def configured(name: str) -> str | None:
        value = env.get(name, "").strip()
        return value or None

    vault_value = configured("RC_VAULT_ROOT")
    vault_root = Path(vault_value).expanduser().resolve() if vault_value else None

    projects_value = configured("RC_PROJECTS_ROOT")
    if projects_value:
        projects_root = Path(projects_value).expanduser().resolve()
    elif vault_root:
        projects_root = (vault_root / "Projects").resolve()
    else:
        projects_root = (base / "projects").resolve()

    prompts_value = configured("RC_PROMPTS_DIR")
    if prompts_value:
        prompts_dir = Path(prompts_value).expanduser().resolve()
    elif vault_root:
        prompts_dir = (vault_root / "Prompts").resolve()
    else:
        prompts_dir = None

    return DataPaths(vault_root=vault_root, prompts_dir=prompts_dir,
                     projects_root=projects_root)


_DATA_PATHS = resolve_data_paths()
VAULT_ROOT = _DATA_PATHS.vault_root
PROMPTS_DIR = _DATA_PATHS.prompts_dir
# Where all projects live (each subdir is one project, its own git repo). Gitignored.
PROJECTS_ROOT = _DATA_PATHS.projects_root
# App-global state (settings, legacy prompt overrides, last-valid prompts, derived caches).
APP_STATE_DIR = Path(os.environ.get("RC_APP_STATE_DIR", str(BASE_DIR / ".app-state"))).resolve()
APP_STATE_DIR.mkdir(parents=True, exist_ok=True)
SETTINGS_FILE = APP_STATE_DIR / "settings.json"

# Default project id used when the request didn't scope one (single-project / legacy callers).
DEFAULT_PROJECT_ID = os.environ.get("RC_DEFAULT_PROJECT", "default")
# Legacy single-project dir (pre-multiproject). Used as a fallback so the app keeps working
# before/without migration. RC_PROJECT_DIR overrides; else ./project if it exists.
_LEGACY_PROJECT_DIR = os.environ.get("RC_PROJECT_DIR")

OPENROUTER_BASE = "https://openrouter.ai/api/v1"
OPENAI_BASE = "https://api.openai.com/v1"
APP_TITLE = os.environ.get("RC_APP_TITLE", "Research Reading Companion")


# Which deployment this process is. Everything exposure-related keys off this rather than off
# individual feature flags, because the dangerous configuration is *absence* of config, not
# presence: a deploy that simply forgets a variable must not silently land in the permissive state.
KNOWN_ENVIRONMENTS = ("dev", "staging", "prod")
_TRUTHY = {"1", "true", "yes", "on"}


def env_truthy(name: str) -> bool:
    """Whether env var `name` is set to a truthy value. The one place the truthiness rule lives —
    `auth.assert_environment_safe` must reject exactly the values `dev_mode()` would accept, and
    two copies of the rule would eventually disagree (a process refusing `RC_DEV=on` while
    `dev_mode()` honours it, or worse, the reverse)."""
    return os.environ.get(name, "").strip().lower() in _TRUTHY


def env_name() -> str:
    """`RC_ENV` normalized: dev | staging | prod. Read live. **No default** — unset returns "".

    Deliberately not defaulting to "dev": this module's whole premise is that the dangerous
    configuration is *absence*, and defaulting an unset RC_ENV to dev would short-circuit every
    guard below it. A container that lost its env would then boot fully open — exactly the failure
    the rest of this design exists to prevent. So unset behaves like any other unrecognized value:
    `is_dev_env()` is False (guards stay on) and `auth.assert_environment_safe()` refuses to boot.
    `run.sh` and `tests/conftest.py` set `RC_ENV=dev` explicitly, and the Dockerfile defaults the
    image to `prod` so a container can never accidentally be dev.
    """
    return os.environ.get("RC_ENV", "").strip().lower()


def is_dev_env() -> bool:
    """True only for the exact string `dev`. Unset or unrecognized counts as non-dev, so an
    unparseable — or absent — environment fails safe."""
    return env_name() == "dev"


def dev_mode() -> bool:
    """Whether this instance runs in developer mode (RC_DEV truthy). Gates power-user
    affordances the client should only expose to the operator — force-rebuild-from-scratch,
    in-app prompt editing — not production readers. Read live so a restart with the env set
    flips it without code changes.

    Outside a dev environment this is ALWAYS False, whatever `RC_DEV` says. Startup validation
    additionally refuses to boot a staging/prod process that sets it (see
    `auth.assert_environment_safe`), so this is defence in depth rather than the only guard: if a
    future caller reaches `dev_mode()` before validation runs, it still gets the safe answer.
    """
    if not is_dev_env():
        return False
    return env_truthy("RC_DEV")

# Author for the commits the app makes into a project's git store (committer.commit,
# notes_jobs.save, projects.create_project). The store shells out to `git commit`, which needs
# an author; relying on the host's global git identity means a fresh server/container/CI runner
# with no `git config --global` fails ("empty ident name") on note approval and silently skips a
# new project's baseline commit. We pin the author explicitly instead (see git_identity_args),
# so commits always succeed and are attributed consistently regardless of host config. Default
# matches the identity the existing project repos already use. Once projects are scoped per user
# this is the natural hook for per-user attribution (pass the authenticated user through).
DEFAULT_GIT_AUTHOR_NAME = "Research Companion"
DEFAULT_GIT_AUTHOR_EMAIL = "companion@local"


def git_author_name() -> str:
    # Resolve at call time and treat a present-but-empty/whitespace env var as unset — an
    # empty `user.name=` would re-create the very "empty ident name" failure this guards against
    # (`.env` templates routinely leave a var declared but blank).
    return os.environ.get("RC_GIT_AUTHOR_NAME", "").strip() or DEFAULT_GIT_AUTHOR_NAME


def git_author_email() -> str:
    return os.environ.get("RC_GIT_AUTHOR_EMAIL", "").strip() or DEFAULT_GIT_AUTHOR_EMAIL


def git_identity_args() -> list[str]:
    """`git -c` flags pinning the commit author/committer to the app identity. Prepended to every
    app-issued git invocation so a commit never depends on (or is broken by the absence of) the
    host's global git config. `-c` takes precedence over repo/global config, so authorship is
    deterministic."""
    return [
        "-c", f"user.name={git_author_name()}",
        "-c", f"user.email={git_author_email()}",
    ]

# ---- active project (per-request) ----

_active_project: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "active_project", default=None)

# The signed-in user, bound by the auth middleware and rebound by every job worker (invariant 2),
# so `load_settings()` returns the caller's effective settings without 24 call sites having to
# thread a user through. Threading it explicitly is how one gets missed — and a missed one does
# not fail loudly, it silently applies somebody else's preference.
#
# None on a single-tenant instance, in open auth mode, and in any background work that has no
# originating user. All three mean "the instance document", which is the pre-split behaviour.
_active_user: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "active_user", default=None)

# Account deletion closes request and background-job admission before it touches any data. The
# request counter covers synchronous handlers that were already admitted when deletion won the
# gate; the coordinator waits for them to leave. Both live here with the project gate because
# main.py (request writer), jobs.py (background admission), and account_deletion.py (coordinator)
# all need the same atomic in-process state without importing one another.
_deleting_users: set[str] = set()
_active_user_requests: dict[str, int] = {}
_global_job_drains = 0
_user_admission_lock = threading.Lock()


def admit_user_request(user_id: str) -> bool:
    """Atomically admit one authenticated request unless account deletion has started."""
    with _user_admission_lock:
        if user_id in _deleting_users:
            return False
        _active_user_requests[user_id] = _active_user_requests.get(user_id, 0) + 1
        return True


def track_user_request(user_id: str) -> None:
    """Count an already-authorized deletion start/status request without reopening admission."""
    with _user_admission_lock:
        _active_user_requests[user_id] = _active_user_requests.get(user_id, 0) + 1


def release_user_request(user_id: str) -> None:
    with _user_admission_lock:
        remaining = _active_user_requests.get(user_id, 0) - 1
        if remaining > 0:
            _active_user_requests[user_id] = remaining
        else:
            _active_user_requests.pop(user_id, None)


def mark_user_deleting(user_id: str) -> None:
    """Close admission for ``user_id``. Idempotent for retries and status requests."""
    with _user_admission_lock:
        _deleting_users.add(user_id)


def unmark_user_deleting(user_id: str) -> None:
    """Reopen admission only when persisting the deletion request itself failed."""
    with _user_admission_lock:
        _deleting_users.discard(user_id)


def user_is_deleting(user_id: str | None) -> bool:
    if not user_id:
        return False
    with _user_admission_lock:
        return user_id in _deleting_users


def begin_global_job_drain() -> None:
    """Pause new app-global jobs while a deletion drains workers that can touch every project."""
    global _global_job_drains
    with _user_admission_lock:
        _global_job_drains += 1


def end_global_job_drain() -> None:
    global _global_job_drains
    with _user_admission_lock:
        _global_job_drains = max(0, _global_job_drains - 1)


def global_job_drain_active() -> bool:
    with _user_admission_lock:
        return _global_job_drains > 0


def active_request_count(user_id: str) -> int:
    with _user_admission_lock:
        return _active_user_requests.get(user_id, 0)


# Projects mid-deletion. projects.delete_project holds the pid here across its running-job
# sweep and the directory move; jobs.start_or_join/put and projects.use_project consult it, so
# no new work is admitted for a project whose directory is about to disappear (a worker
# admitted mid-move would recreate projects/<pid> as a partial store on its next write). Lives
# in config because projects.py (writer) and jobs.py (checker) both already import it — no
# import cycle.
_deleting_projects: set[str] = set()
_deleting_lock = threading.Lock()


def mark_project_deleting(pid: str) -> bool:
    """Claim `pid` for deletion. True if this caller claimed it, False if a deletion is already in
    progress.

    Test-and-set, not a plain add: two concurrent DELETEs both used to enter, and then one moved
    the directory while the other's move failed and RESTORED the ownership row it had just
    released — leaving a row for a project that no longer exists. Only one caller may run the
    release/move/compensate sequence.
    """
    with _deleting_lock:
        if pid in _deleting_projects:
            return False
        _deleting_projects.add(pid)
        return True


def unmark_project_deleting(pid: str) -> None:
    with _deleting_lock:
        _deleting_projects.discard(pid)


def project_is_deleting(pid: str) -> bool:
    with _deleting_lock:
        return pid in _deleting_projects


# Projects mid-mutation by a synchronous request that relocates/deletes their files (a split's
# source side). Same job-admission-gate purpose as the deletion tombstone, but reads stay
# allowed (the operation is quick and doesn't invalidate a read) — only new background jobs
# are refused, so a worker can't write into files being moved out.
_busy_projects: set[str] = set()
_busy_lock = threading.Lock()


def mark_project_busy(pid: str) -> bool:
    """Reserve `pid` for an exclusive synchronous mutation. Returns False if it is ALREADY
    reserved (a concurrent split of the same project), so the caller can reject rather than
    interleave two mutations of the same reading list / git index."""
    with _busy_lock:
        if pid in _busy_projects:
            return False
        _busy_projects.add(pid)
        return True


def unmark_project_busy(pid: str) -> None:
    with _busy_lock:
        _busy_projects.discard(pid)


def project_is_busy(pid: str) -> bool:
    with _busy_lock:
        return pid in _busy_projects


# ---- per-project synchronous-writer lock (split/move serialization) ----
#
# The busy flag above gates NEW work at entry, but a synchronous record-writer (add/remove/
# retrieve/approve/notes-save) that already passed its busy-check can still be mid-write when a
# split/move begins — its git-committing operation would then overlap the relocation's index
# writes, or recreate a source paper the relocation is removing. This readers/writer lock closes
# that: every synchronous writer holds the SHARED side across its whole operation
# (`project_write_guard`); a split/move holds the EXCLUSIVE side (`project_exclusive`), which
# drains in-flight writers and — combined with the busy flag stopping new ones — gives the
# relocation sole access to the project's record + git index. Writer-preferring so a pending
# relocation is never starved by a stream of readers.
class ProjectBusyError(Exception):
    """A synchronous writer found the project reserved by a split/move; map to HTTP 409."""


class _RWLock:
    def __init__(self) -> None:
        self._cond = threading.Condition()
        self._readers = 0
        self._writer = False
        self._writers_waiting = 0

    def acquire_read(self) -> None:
        with self._cond:
            while self._writer or self._writers_waiting > 0:
                self._cond.wait()
            self._readers += 1

    def release_read(self) -> None:
        with self._cond:
            self._readers -= 1
            if self._readers == 0:
                self._cond.notify_all()

    def acquire_write(self) -> None:
        with self._cond:
            self._writers_waiting += 1
            try:
                while self._writer or self._readers > 0:
                    self._cond.wait()
            finally:
                self._writers_waiting -= 1
            self._writer = True

    def release_write(self) -> None:
        with self._cond:
            self._writer = False
            self._cond.notify_all()


_rw_locks: dict[str, _RWLock] = {}
_rw_locks_guard = threading.Lock()
_paper_identity_locks: dict[tuple[str | None, str], threading.RLock] = {}
_paper_identity_locks_guard = threading.Lock()


def _rw_lock_for(pid: str) -> _RWLock:
    with _rw_locks_guard:
        return _rw_locks.setdefault(pid, _RWLock())


@contextlib.contextmanager
def paper_identity_guard(slug: str):
    """Serialize one paper's corpus identity with derived-metadata fingerprint publication.

    ``project_write_guard`` is intentionally shared by ordinary writers; it only drains them
    for relocation. Full-text replacement and any check+publish operation keyed to that text
    need this narrower exclusive lock so an older fingerprint can never be published after a
    newer corpus version. RLock permits store helpers to call other identity-aware helpers.
    """
    key = (active_project_id(), slug)
    with _paper_identity_locks_guard:
        lock = _paper_identity_locks.setdefault(key, threading.RLock())
    with lock:
        yield


@contextlib.contextmanager
def project_write_guard(pid: str | None):
    """Hold across a synchronous record-writer's whole git-committing operation. Raises
    ProjectBusyError (⇒ 409) if the project is reserved by a split/move: either this writer
    got the shared lock while the relocation was waiting for readers to drain (busy already
    set ⇒ bail so it can proceed), or it got the lock first and the relocation will wait for
    it to release (busy not yet set ⇒ proceed; the relocation snapshots only after)."""
    if not pid:
        yield
        return
    lock = _rw_lock_for(pid)
    lock.acquire_read()
    try:
        if project_is_busy(pid):
            raise ProjectBusyError(pid)
        yield
    finally:
        lock.release_read()


@contextlib.contextmanager
def project_exclusive(pid: str):
    """Held by a split/move across the whole relocation of `pid` (mark it busy FIRST, so new
    synchronous writers are refused at entry, then take this to drain any already in flight)."""
    lock = _rw_lock_for(pid)
    lock.acquire_write()
    try:
        yield
    finally:
        lock.release_write()


def set_active_project(project_id: str | None) -> contextvars.Token:
    return _active_project.set(project_id)


def reset_active_project(token: contextvars.Token) -> None:
    _active_project.reset(token)


def active_project_id() -> str | None:
    return _active_project.get()


def set_active_user(user_id: str | None) -> contextvars.Token:
    return _active_user.set(user_id)


def reset_active_user(token: contextvars.Token) -> None:
    _active_user.reset(token)


def active_user_id() -> str | None:
    return _active_user.get()


@contextlib.contextmanager
def bound_scope(project_id: str | None, user_id: str | None):
    """Bind BOTH request-scoped contextvars for the duration of a worker thread (invariant 2).

    A thread inherits neither, and they are wrong in different ways when forgotten: a missing
    project reads and writes another project's files, a missing user quietly runs on the instance's
    model and voice instead of the caller's. Two sites rebound only the project — `affiliations`
    and `figures`, both raw `threading.Thread` workers outside the job registry — which is what this
    exists to stop being possible: capture with `active_project_id()`/`active_user_id()` on the
    calling thread, then enter this on the worker.

    `JobRegistry._run` does the same thing inline and predates it; it is not rewritten to use this
    because reindenting that method's body around a `with` is risk without benefit.
    """
    project_token = _active_project.set(project_id)
    user_token = _active_user.set(user_id)
    try:
        yield
    finally:
        _active_user.reset(user_token)
        _active_project.reset(project_token)


def user_scope_dir() -> Path | None:
    """One directory holding everything app-global that belongs to the active user — the audio
    cache and the narration cache today. `None` when no user is bound, which means the flat
    app-global paths this had before, and is what a single-tenant `./run.sh` keeps using.

    Two things this shape buys. **Isolation is a property of the path**, not of a check: one user's
    request never resolves to another's file because it never builds that path, so there is no
    lookup to forget (Kamil's 2026-07-26 decision — scope per user rather than ACL rows over shared
    blobs). And **M7 account deletion is `rmtree` of one directory** rather than a search for
    whichever content-addressed files were theirs.

    The directory is named by a hash rather than the user id. A user id reaching a path is a
    traversal question, and hashing answers it structurally instead of by validation — there is no
    input for which this returns a path outside `APP_STATE_DIR/users/`. It also keeps user ids off
    the disk of a machine whose backups are not access-controlled.
    """
    key = user_scope_key()
    return None if key is None else APP_STATE_DIR / "users" / key


def user_scope_key_for(user_id: str) -> str:
    """The stable, path-safe pseudonym for one explicit user id."""
    return hashlib.sha256(user_id.lower().encode()).hexdigest()[:32]


def user_scope_key() -> str | None:
    """A stable pseudonym for the active user, or None. The name of their directory above, and the
    scope audio jobs register under.

    The hash is not only about path safety. This value reaches **log lines** — `JobRegistry` tags
    every start/done/error line with the job's scope — so using the raw Supabase id would write a
    durable account identifier, with correlated activity timing, into whatever Fly ships logs to.
    The one place this app deliberately logs a real user id is the non-allowlisted rejection, which
    is rate-limited and exists so the operator can repair the allowlist; ordinary work should not.
    """
    user_id = _active_user.get()
    if not user_id:
        return None
    # Case-folded before hashing. A uuid is case-insensitive as an identifier but `sha256` is not,
    # so `F4A3…` and `f4a3…` are the same account and two different directories — one of them
    # empty. Supabase emits lowercase today; depending on that is the same kind of assumption as
    # depending on an env var being present, and costs nothing to remove.
    return user_scope_key_for(user_id)


def project_dir() -> Path:
    """Directory of the active project. Falls back to the legacy single-project dir when no
    project is scoped and no projects root has been populated yet."""
    pid = _active_project.get()
    if pid:
        return PROJECTS_ROOT / pid
    if _LEGACY_PROJECT_DIR:
        return Path(_LEGACY_PROJECT_DIR).resolve()
    legacy = BASE_DIR / "project"
    if legacy.exists() and not (PROJECTS_ROOT / DEFAULT_PROJECT_ID).exists():
        return legacy.resolve()
    return PROJECTS_ROOT / DEFAULT_PROJECT_ID


def state_dir() -> Path:
    """Per-project transient state (session index). Created lazily."""
    d = project_dir() / ".state"
    d.mkdir(parents=True, exist_ok=True)
    return d


# ---- app-global settings (UI-overridable) ----

# Which prior per-paper Notes go into every paper turn's context:
#   "related" = only citation-related papers (compact)
#   "all"     = every paper read so far — richer cross-paper grounding, larger context per turn
#
# `all` is the default (changed 2026-07-29, Kamil's call). Reading a corpus *as a corpus* is what
# this app is for, and the citation-graph selection only sees links the graph already knows about,
# so a paper related by topic rather than by citation was invisible to the very feature meant to
# situate it. The cost is real — every committed Notes block enters every turn — and it scales with
# the project, so this is the setting to revisit first if turn cost becomes a problem.
#
# Named rather than inlined because the same fallback was written out at FOUR call sites that must
# agree: here, the assembler that acts on it, and the two settings responses that report it. A
# default spelled out in four places is one that eventually reports one thing and does another.
DEFAULT_PRIOR_NOTES_SCOPE = "all"

_ENV_DEFAULTS = {
    "openrouter_api_key": os.environ.get("OPENROUTER_API_KEY", ""),
    # analysis model: reads the paper, writes the scholarly record
    "model": os.environ.get("RC_MODEL", "anthropic/claude-opus-4.6"),
    # narration model: faithfully adapts the canonical text for TTS (lighter/faster)
    "narration_model": os.environ.get("RC_NARRATION_MODEL", "anthropic/claude-haiku-4.5"),
    # listening-preview model: defaults dynamically to narration_model when unset
    "preview_model": os.environ.get("RC_PREVIEW_MODEL", ""),
    # speech (audio) — OpenRouter has no TTS, so OpenAI uses its own key
    "openai_api_key": os.environ.get("OPENAI_API_KEY", ""),
    "speech_provider": os.environ.get("RC_SPEECH_PROVIDER", "openai"),  # openai | browser
    "tts_model": os.environ.get("RC_TTS_MODEL", "tts-1"),
    "tts_voice": os.environ.get("RC_TTS_VOICE", "alloy"),
    # web search/fetch for the agent's research tools — a provider chain (Firecrawl -> Parallel
    # -> keyless DuckDuckGo). Keys optional; also read from env at call time (see research_tools).
    "parallel_api_key": os.environ.get("PARALLEL_API_KEY", "") or os.environ.get("PARALLEL_SEARCH_API_KEY", ""),
    "firecrawl_api_key": os.environ.get("FIRECRAWL_API_KEY", ""),
    # scholarly metadata/citation edges. The approved account limit is cumulative across
    # endpoints; app.semantic_scholar applies the shared below-1-RPS pacer.
    "semantic_scholar_api_key": (
        os.environ.get("SEMANTIC_SCHOLAR_API_KEY", "") or os.environ.get("S2_API_KEY", "")
    ),
    # see DEFAULT_PRIOR_NOTES_SCOPE above for what the two values mean and why "all" is default
    "prior_notes_scope": os.environ.get("RC_PRIOR_NOTES_SCOPE", DEFAULT_PRIOR_NOTES_SCOPE),
}


_SETTING_KEYS = ("openrouter_api_key", "model", "narration_model", "preview_model", "openai_api_key",
                 "speech_provider", "tts_model", "tts_voice", "parallel_api_key",
                 "firecrawl_api_key", "semantic_scholar_api_key", "prior_notes_scope")

# Who owns which setting.
#
# `/api/settings` was one document, and slice 2a restricted writing all of it to the operator. That
# was right for the provider keys — one deployment, one OpenRouter account, and a user who could
# overwrite that key could take the app offline for everyone — and wrong for the rest, because it
# also stopped a reader changing their own voice.
#
# So the document splits along the line of who pays for the consequence. The keys and the workflow
# prompts stay the instance's. Everything below describes how one person wants to read: which model
# answers them, which voice reads it aloud, how much prior context to carry. These are layered over
# the instance values per user, never copied — so an operator changing a default still moves
# everyone who has not expressed a preference.
#
# `USER_SETTING_KEYS` is mirrored by a CHECK constraint in `0003_user_settings.sql`; adding one
# needs a migration. The two sets must partition `_SETTING_KEYS` exactly — a key in neither would
# silently stay instance-wide, which is the wrong default for something a reader would expect to
# own. `tests/test_user_settings.py` asserts the partition.
#
# NOT closed by this split: `DeliveryReq.model` is a per-turn override that bypasses settings
# entirely (P0-17), so a per-user model preference does not by itself bound what a user can spend.
# That is a quota question and belongs with M3, not here.
USER_SETTING_KEYS = frozenset({
    "model", "narration_model", "preview_model",
    "speech_provider", "tts_model", "tts_voice", "prior_notes_scope",
})
OPERATOR_SETTING_KEYS = frozenset(set(_SETTING_KEYS) - USER_SETTING_KEYS)

# Serializes the read-modify-write of the shared settings file. A turn persisting its model
# choice, a UI settings save, and a prompt-override edit all mutate the same file; without this
# two concurrent saves race and one silently drops the other's change (single-process app, so a
# threading.Lock is sufficient — see CLAUDE.md on the single-worker assumption).
_settings_lock = threading.Lock()


def load_settings() -> dict:
    """The effective settings for the current caller.

    Three layers, each overriding the one before: env defaults, the instance settings file (UI-set),
    then the active user's own preferences. A stored key is honored even when its value is empty —
    an explicit "" is a deliberate unset (revert to no value), distinct from a key being absent
    (use the env default).

    The third layer is skipped entirely when there is no database or no bound user, which is why
    every existing call site keeps working unchanged on a single-tenant instance.
    """
    data = dict(_ENV_DEFAULTS)
    stored = _read_settings_file()
    for key in _SETTING_KEYS:
        if key in stored:
            data[key] = stored[key]

    from . import user_settings  # function-local: user_settings -> db -> logging_config -> config
    for key, value in user_settings.load(_active_user.get()).items():
        if key in USER_SETTING_KEYS:   # the store is constrained too; this is the cheap half
            data[key] = value
    return data


def user_settings_available() -> bool:
    """Whether the active caller has somewhere of their own to store a preference.

    False on a single-tenant instance and for an unauthenticated caller. Routes use this to decide
    whether a preference write is the user's own or an edit to the shared document (which needs the
    operator), so that with no database the settings form behaves exactly as it did before.
    """
    from . import user_settings
    return user_settings.available(_active_user.get())


def save_user_settings(patch: dict) -> dict:
    """Store the active user's preferences and return their new effective settings.

    Only `USER_SETTING_KEYS` are stored; anything else in the patch is dropped rather than
    rejected, because this is fed straight from a settings form that carries both halves. The
    operator half travels to `save_settings` instead — dropping here is what stops a user's
    submitted API key from landing in their personal document and being layered over the
    instance's on their next turn.
    """
    user_id = _active_user.get()
    if not user_settings_available():
        raise ValueError("No signed-in user to store preferences for.")
    from . import user_settings
    user_settings.save(user_id, patch, USER_SETTING_KEYS)
    return load_settings()


def save_settings(patch: dict) -> dict:
    """Merge a patch into the settings file and return the merged settings. Per key:
    absent or None => leave unchanged; "" => clear the override (falls back to the env default);
    any other value => set it. Serialized under _settings_lock so concurrent saves don't clobber."""
    with _settings_lock:
        current = _read_settings_file()
        for key in _SETTING_KEYS:
            if key not in patch or patch[key] is None:
                continue
            if patch[key] == "":
                current.pop(key, None)  # explicit unset -> revert to env default / absent
            else:
                current[key] = patch[key]
        # 0o600: this file holds API keys.
        atomic_write_text(SETTINGS_FILE, json.dumps(current, indent=2), mode=0o600)
    return load_settings()


def has_api_key() -> bool:
    return bool(load_settings().get("openrouter_api_key"))


def _read_settings_file() -> dict:
    if SETTINGS_FILE.exists():
        try:
            return json.loads(SETTINGS_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def get_prompt_override(key: str) -> str | None:
    """User-edited prompt text, or None if using the built-in default."""
    return (_read_settings_file().get("prompts") or {}).get(key)


def set_prompt_override(key: str, value: str | None) -> None:
    """Persist a prompt override; value None/empty removes it (reverts to default). Shares
    _settings_lock with save_settings since both read-modify-write the same file."""
    with _settings_lock:
        data = _read_settings_file()
        overrides = data.get("prompts") or {}
        if value:
            overrides[key] = value
        else:
            overrides.pop(key, None)
        data["prompts"] = overrides
        atomic_write_text(SETTINGS_FILE, json.dumps(data, indent=2), mode=0o600)
