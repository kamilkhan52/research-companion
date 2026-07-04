"""The app pins its own git author, so writing to a project's store never depends on the host
having a global git identity — a fresh server / container / CI runner would otherwise fail note
approval and silently skip a new project's baseline commit."""
from __future__ import annotations

import subprocess

import pytest
from app import committer, config, projects, store


@pytest.fixture
def no_ambient_git_identity(monkeypatch):
    """Make git ignore any global/system identity, exactly as on a fresh runner with no
    `git config --global user.*`. The only identity left is whatever the app passes via -c."""
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", "/dev/null")
    monkeypatch.setenv("GIT_CONFIG_SYSTEM", "/dev/null")
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")


@pytest.fixture
def projects_root(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "PROJECTS_ROOT", tmp_path)
    return tmp_path


def _log(repo, fmt: str) -> str:
    return subprocess.run(["git", "log", "-1", f"--format={fmt}"], cwd=str(repo),
                          capture_output=True, text=True).stdout.strip()


def test_create_project_commits_baseline_without_ambient_identity(projects_root, no_ambient_git_identity):
    meta = projects.create_project("My Project")
    repo = projects.project_path(meta["id"])
    # A real baseline commit exists — previously this silently no-opped (projects._git uses
    # check=False), leaving a project with no history.
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(repo), capture_output=True, text=True)
    assert head.returncode == 0, head.stderr
    assert _log(repo, "%an") == "Research Companion"
    assert _log(repo, "%ae") == "companion@local"


def test_committer_commit_succeeds_without_ambient_identity(projects_root, no_ambient_git_identity):
    meta = projects.create_project("Notes Project")
    token = config.set_active_project(meta["id"])
    try:
        store.write_full_text("p1", "Paper One", "body text", {"slug": "p1"})
        rl = store._reading_list()
        rl.write_text(rl.read_text() + "\n**Paper One** — *unread*\n<!-- slug: p1 -->\n",
                      encoding="utf-8")
        result = committer.commit("p1", "## Notes\n\nkey finding", "working notes body", "Read Paper One")
        assert result["committed"] is True
        repo = projects.project_path(meta["id"])
        assert _log(repo, "%s") == "Read Paper One"
        assert _log(repo, "%ae") == "companion@local"
    finally:
        config.reset_active_project(token)


def test_env_override_changes_commit_author(projects_root, no_ambient_git_identity, monkeypatch):
    monkeypatch.setenv("RC_GIT_AUTHOR_NAME", "Alice Researcher")
    monkeypatch.setenv("RC_GIT_AUTHOR_EMAIL", "alice@example.com")
    meta = projects.create_project("Env Project")
    repo = projects.project_path(meta["id"])
    assert _log(repo, "%an") == "Alice Researcher"
    assert _log(repo, "%ae") == "alice@example.com"


@pytest.mark.parametrize("blank", ["", "   "])
def test_blank_env_falls_back_to_default(projects_root, no_ambient_git_identity, monkeypatch, blank):
    # A present-but-empty/whitespace env var must NOT produce an empty `user.name=` — that would
    # re-create the exact "empty ident name" failure this hardening prevents.
    monkeypatch.setenv("RC_GIT_AUTHOR_NAME", blank)
    monkeypatch.setenv("RC_GIT_AUTHOR_EMAIL", blank)
    assert config.git_author_name() == "Research Companion"
    assert config.git_author_email() == "companion@local"
    meta = projects.create_project("Blank Env Project")
    repo = projects.project_path(meta["id"])
    assert _log(repo, "%ae") == "companion@local"


def test_projects_git_surfaces_failure(projects_root, no_ambient_git_identity):
    # projects._git must not swallow non-zero exits (previously check=False), so create_project /
    # adopt_existing can't "succeed" while git actually failed. A bad git subcommand exits non-zero.
    meta = projects.create_project("Fail Project")
    with pytest.raises(projects.ProjectError):
        projects._git(meta["id"], "config", "--get", "no.such.key")
