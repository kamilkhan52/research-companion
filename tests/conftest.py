"""Shared pytest fixtures. The graph pipeline is tested against a real temp project dir
(not mocks of the store layer) so tests exercise the actual file formats, but with
config.PROJECTS_ROOT monkeypatched to a tmp_path and no network calls ever made — extraction
is always driven through an injected fake in tests (see graph.build_graph's extract_fn param).
"""
from __future__ import annotations

import os
import subprocess

import pytest

# The app requires an explicit RC_ENV — unset is treated as unsafe rather than defaulting to dev,
# so that a container which lost its environment fails closed instead of booting unauthenticated.
# Set it before importing app modules so anything reading it at import time sees a dev process:
# tests/test_system.py and tests/test_web_serve.py import app.main, which calls
# assert_environment_safe() at import and would refuse to start otherwise.
# Overwritten rather than setdefault, deliberately — an RC_ENV exported in the developer's shell
# would otherwise make the suite refuse to import app.main, and hermetic beats configurable here
# (the gating tests pass the environment explicitly, so nothing needs the ambient value).
os.environ["RC_ENV"] = "dev"

from app import config, projects  # noqa: E402 — must follow the RC_ENV default above


@pytest.fixture(autouse=True)
def _app_state_is_never_the_real_one(tmp_path_factory, monkeypatch):
    """Point every app-global path at a tmp directory, for the whole suite.

    `PROJECTS_ROOT` has always been redirected per-test, but `APP_STATE_DIR` was not — so a test
    that touched settings, the audio cache or the narration cache wrote into the DEVELOPER'S
    `.app-state/`, i.e. into their live instance. Nothing structural prevented it; the tests that
    do touch those paths happened to patch them individually, which is a property of the tests
    rather than of the harness.

    Found when per-user scoping (M2 slice 5) started creating `.app-state/users/<hash>/` and one
    appeared in the real directory during development. The blast radius before that was smaller but
    the hole was the same size.

    `audio_jobs.AUDIO_DIR` is derived at import, so it is redirected too — a module-level constant
    does not follow a monkeypatched `APP_STATE_DIR`.
    """
    root = tmp_path_factory.mktemp("app-state")
    monkeypatch.setattr(config, "APP_STATE_DIR", root)
    # The devtest inbox resolves the git COMMON root, which no path monkeypatch reaches — a
    # test that forgets RC_DEVTEST_DIR would write .dev-feedback/ into the real checkout.
    monkeypatch.setenv("RC_DEVTEST_DIR", str(root / "dev-feedback"))
    # Same reasoning one level along: preparing the dispatch worktree runs `git fetch` against
    # the REAL checkout's remote, and this suite makes no external network calls.
    monkeypatch.setenv("RC_DISPATCH_WORKTREE", "0")
    monkeypatch.setattr(config, "SETTINGS_FILE", root / "settings.json")
    from app import audio_jobs
    monkeypatch.setattr(audio_jobs, "AUDIO_DIR", root / "audio")
    # PROJECTS_ROOT gets the same treatment, and for the same reason. `temp_project` redirects it
    # per-test, but a test that touches per-PROJECT state without that fixture resolves
    # `config.state_dir()` to `<repo>/project/.state` — the developer's own tree. That was
    # harmless while per-project state was only ever written behind `temp_project`; discovery's
    # candidate ledger made it visible by persisting a file there on an ordinary unit test.
    # Redirecting by default makes the isolation a property of the harness, not of remembering.
    projects_root = tmp_path_factory.mktemp("projects")
    monkeypatch.setattr(config, "PROJECTS_ROOT", projects_root)
    # Redirecting PROJECTS_ROOT alone is NOT enough. With no project scoped, `config.project_dir`
    # falls back to `BASE_DIR / "project"` — the developer's own working tree — whenever that
    # legacy directory exists, which it does in this repo. So a test that resolves per-project
    # state without `temp_project` wrote there and, worse, READ state accumulated by earlier runs:
    # a stale discovery ledger silently satisfied a screening stage and made the pipeline skip it.
    monkeypatch.setattr(config, "_LEGACY_PROJECT_DIR", str(projects_root / "legacy"))


@pytest.fixture(autouse=True)
def _offline_citations(monkeypatch):
    """Citation-count enrichment calls Semantic Scholar inside build_graph; tests must never
    touch the network. Stub only the fetch step — annotate_nodes still runs for real, applying
    whatever counts a test seeded into the cache. Tests of the fetch itself call _fetch_missing
    directly with a fake client (bypassing this stub)."""
    from app import (
        affiliation_jobs,
        affiliations,
        canonical_jobs,
        citations,
        figures,
        graph,
        semantic_scholar,
    )
    monkeypatch.setattr(
        citations, "_fetch_missing", lambda nodes, cache, client, sleep, **kwargs: None)
    monkeypatch.setattr(semantic_scholar, "api_key", lambda: "")
    # Figure-manifest enrichment (R.10): stub only its two network functions — the rest of
    # the pipeline runs for real; figure tests inject fetch fakes via derive_for_slug's
    # kwargs. warm_async is a fire-and-forget thread retrieval spawns — off entirely so no
    # write races a test's teardown.
    monkeypatch.setattr(
        figures, "_fetch_html", lambda base_id, skip=frozenset(): ("error", None, None))
    monkeypatch.setattr(figures, "_fetch_image", lambda url: None)
    monkeypatch.setattr(figures, "warm_async", lambda slug: None)
    monkeypatch.setattr(affiliation_jobs, "warm_async", lambda slug: None)
    monkeypatch.setattr(canonical_jobs, "warm_async", lambda slug: None)
    # Same treatment for the LLM affiliation fallback (R6.4): builds never call an LLM in
    # tests. Tests of the extraction itself call _extract_missing directly with a fake
    # completion function (bypassing this stub); _apply_cached still runs for real.
    monkeypatch.setattr(affiliations, "_extract_missing", lambda *a, **k: None)
    monkeypatch.setattr(
        graph,
        "retrieve_missing_graph_paper",
        lambda paper, provider: {"needs_confirmation": True, "candidates": []},
    )
    # Discovery's batched screening stages (slice 1) call a real model through `llm.complete`.
    # Unlike the stubs above this RAISES rather than no-ops, on purpose: the batch runner fails
    # open by design, so a silent stub would let a screening test pass while screening nothing —
    # the test would be measuring the fallback. Tests that exercise a stage inject `cheap_llm_fn`.
    from app import discovery
    monkeypatch.setattr(discovery, "_cheap_llm", _refuse_network_llm)


def _refuse_network_llm(*_args, **_kwargs):
    raise AssertionError(
        "discovery._cheap_llm reached the network in a test — inject cheap_llm_fn instead")


@pytest.fixture
def temp_project(tmp_path, monkeypatch):
    """Yields a project id with an empty reading-list, active for the duration of the test.
    Git-initialized like a real project (projects.create_project always does this), so tests
    that check working-tree state (e.g. "this write wasn't committed") reflect production."""
    monkeypatch.setattr(config, "PROJECTS_ROOT", tmp_path)
    pid = "test-project"
    root = projects.project_path(pid)
    root.mkdir(parents=True)
    (root / "corpus").mkdir()
    (root / "sessions").mkdir()
    (root / ".state").mkdir()
    (root / "reading-list.md").write_text("# Reading list\n\n## Group\n\n", encoding="utf-8")
    (root / "reading-method.md").write_text("", encoding="utf-8")
    (root / "working-notes.md").write_text("", encoding="utf-8")
    _git(root, "init", "-q", "-b", "main")
    # Repo-LOCAL identity so every commit into this repo inherits it — including the ones the
    # code under test makes (committer.commit, notes_jobs.save). Without this the suite depends
    # on the machine having a global git identity, which a fresh CI runner does not (the commit
    # paths then fail with "empty ident name"). Repo-local keeps the suite hermetic.
    _git(root, "config", "user.email", "test@test")
    _git(root, "config", "user.name", "test")
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "init")

    token = config.set_active_project(pid)
    try:
        yield pid
    finally:
        config.reset_active_project(token)


def _git(cwd, *args: str) -> None:
    subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True, check=False)


def add_paper(pid: str, slug: str, title: str, group: str = "Group", full_text: str = "full text") -> None:
    """Append a reading-list entry and write cached full text for it, using the real store
    module so parsing/slugging behavior matches production."""
    from app import store
    rl = store._reading_list()
    text = rl.read_text(encoding="utf-8")
    if f"## {group}" not in text:
        text += f"\n## {group}\n\n"
    text += f"\n**{title}** — *unread*\n<!-- slug: {slug} -->\n"
    rl.write_text(text, encoding="utf-8")
    store.write_full_text(slug, title, full_text, {"slug": slug})
