"""Shared pytest fixtures. The graph pipeline is tested against a real temp project dir
(not mocks of the store layer) so tests exercise the actual file formats, but with
config.PROJECTS_ROOT monkeypatched to a tmp_path and no network calls ever made — extraction
is always driven through an injected fake in tests (see graph.build_graph's extract_fn param).
"""
from __future__ import annotations

import subprocess

import pytest
from app import config, projects


@pytest.fixture(autouse=True)
def _offline_citations(monkeypatch):
    """Citation-count enrichment calls Semantic Scholar inside build_graph; tests must never
    touch the network. Stub only the fetch step — annotate_nodes still runs for real, applying
    whatever counts a test seeded into the cache. Tests of the fetch itself call _fetch_missing
    directly with a fake client (bypassing this stub)."""
    from app import citations
    monkeypatch.setattr(citations, "_fetch_missing", lambda nodes, cache, client, sleep: None)


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
