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
    monkeypatch.setattr(citations, "_fetch_missing", lambda nodes, cache, client, sleep: None)
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
