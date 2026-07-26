"""Sharing a project between instances as a git bundle.

The shape of this feature comes from two measured facts. A project's `.gitignore` excludes
`.state/`, and `.state/` is nearly all of it on disk — 207 MB of one 214 MB project — so a bundle
of the same project is 1.1 MB and takes 0.17 s. That is why export is a plain request rather than
a background job, and why the record travels as history rather than as a directory copy.
"""
from __future__ import annotations

import subprocess

import pytest
from app import config, projects
from app.projects import ProjectError


@pytest.fixture
def tmp_projects(tmp_path, monkeypatch):
    """An empty PROJECTS_ROOT. These tests exercise whole-project lifecycle — create, export,
    import — so they need a root they can add projects to, not a single pre-made project."""
    monkeypatch.setattr(config, "PROJECTS_ROOT", tmp_path)
    return tmp_path


def _make_project(tmp_projects, name="Shared Reading"):
    meta = projects.create_project(name)
    return meta["id"]


def test_a_bundle_round_trips_into_an_independent_project(tmp_projects):
    source = _make_project(tmp_projects)
    (projects.project_path(source) / "reading-list.md").write_text(
        "# Reading list\n\n- Attention Is All You Need\n", encoding="utf-8")
    projects._git(source, "add", "-A")
    projects._git(source, "commit", "-q", "-m", "Add a paper")

    imported = projects.import_bundle(projects.export_bundle(source), "Copy On Other Instance")

    assert imported["id"] != source
    text = (projects.project_path(imported["id"]) / "reading-list.md").read_text()
    assert "Attention Is All You Need" in text


def test_the_commit_history_survives_the_move(tmp_projects):
    """The point of a bundle rather than a directory copy. The git record IS the product here —
    the agent proposes and a human approves, and only then does anything land in git — so a share
    that dropped the history would be discarding the provenance, not just some metadata."""
    source = _make_project(tmp_projects)
    for n in range(3):
        (projects.project_path(source) / "working-notes.md").write_text(f"note {n}\n", encoding="utf-8")
        projects._git(source, "add", "-A")
        projects._git(source, "commit", "-q", "-m", f"Note {n}")

    before = projects._git(source, "log", "--format=%s").strip().splitlines()
    imported = projects.import_bundle(projects.export_bundle(source), "History Check")
    after = projects._git(imported["id"], "log", "--format=%s").strip().splitlines()

    assert after == before
    assert "Note 2" in after[0]


def test_working_state_is_not_shared(tmp_projects):
    """`.state/` holds retry branches, caches and the usage ledger — this instance's business, and
    the bulk of the bytes. It must not travel, and the imported project must still have the
    directory so it behaves like any other from the first request."""
    source = _make_project(tmp_projects)
    state = projects.project_path(source) / ".state"
    state.mkdir(exist_ok=True)
    (state / "usage.json").write_text('{"secret": "local only"}', encoding="utf-8")

    imported = projects.import_bundle(projects.export_bundle(source), "No State Please")
    dest_state = projects.project_path(imported["id"]) / ".state"

    assert dest_state.is_dir()
    assert not (dest_state / "usage.json").exists()


def test_import_never_overwrites_an_existing_project(tmp_projects):
    """Merging two divergent histories of one reading list is a real design question — whose
    approval wins? — so import always creates a new project rather than silently picking."""
    source = _make_project(tmp_projects, "Same Name")
    imported = projects.import_bundle(projects.export_bundle(source), "Same Name")

    assert imported["id"] != source
    assert projects.exists(source)
    assert projects.exists(imported["id"])


def test_rubbish_is_refused_before_anything_is_written(tmp_projects):
    """The upload is untrusted: it arrives over HTTP from another instance."""
    before = {p["id"] for p in projects.list_projects()}
    with pytest.raises(ProjectError, match="valid project bundle"):
        projects.import_bundle(b"this is not a git bundle", "Nope")
    assert {p["id"] for p in projects.list_projects()} == before


def test_a_valid_bundle_that_is_not_a_project_is_refused(tmp_projects, tmp_path):
    """A well-formed git bundle of some unrelated repository is still not importable, and failing
    here rather than later means no half-project is ever listed."""
    other = tmp_path / "unrelated"
    other.mkdir()
    subprocess.run(["git", "init", "-q", "-b", "main", str(other)], check=True)
    (other / "README.md").write_text("not a reading list\n", encoding="utf-8")
    for args in (["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", "x"]):
        subprocess.run(["git", *args], cwd=other, check=True)
    bundle = tmp_path / "other.bundle"
    subprocess.run(["git", "bundle", "create", str(bundle), "--all", "HEAD"], cwd=other,
                   check=True, capture_output=True)

    before = {p["id"] for p in projects.list_projects()}
    with pytest.raises(ProjectError, match="not a Research Companion project"):
        projects.import_bundle(bundle.read_bytes(), "Impostor")
    assert {p["id"] for p in projects.list_projects()} == before


def test_an_oversized_bundle_is_refused_without_being_processed(tmp_projects, monkeypatch):
    monkeypatch.setattr(projects, "MAX_BUNDLE_BYTES", 64)
    with pytest.raises(ProjectError, match="limit is"):
        projects.import_bundle(b"x" * 65, "Too Big")


def test_an_empty_upload_is_refused(tmp_projects):
    with pytest.raises(ProjectError, match="empty"):
        projects.import_bundle(b"", "Nothing")


def test_export_of_an_unknown_project_is_an_error(tmp_projects):
    with pytest.raises(ProjectError, match="Unknown project"):
        projects.export_bundle("no-such-project")


def test_import_requires_a_name(tmp_projects):
    source = _make_project(tmp_projects)
    with pytest.raises(ProjectError, match="name is required"):
        projects.import_bundle(projects.export_bundle(source), "   ")
