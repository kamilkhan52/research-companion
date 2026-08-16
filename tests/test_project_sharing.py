"""Sharing a project between instances as a git bundle.

The shape of this feature comes from two measured facts. A project's `.gitignore` excludes
`.state/`, and `.state/` is nearly all of it on disk — 207 MB of one 214 MB project — so a bundle
of the same project is 1.1 MB and takes 0.17 s. That is why export is a plain request rather than
a background job, and why the record travels as history rather than as a directory copy.
"""
from __future__ import annotations

import json
import subprocess

import pytest
from app import config, projects
from app.projects import ProjectError


@pytest.fixture
def tmp_projects(tmp_path, monkeypatch):
    """An empty PROJECTS_ROOT. These tests exercise whole-project lifecycle — create, export,
    import — so they need a root they can add projects to, not a single pre-made project.

    A SUBDIRECTORY of tmp_path, not tmp_path itself: tests that build a hostile source repo need
    somewhere to put it that is not inside PROJECTS_ROOT, or `list_projects()` picks the scratch
    repo up as a project and the assertions measure the wrong thing."""
    root = tmp_path / "projects"
    root.mkdir()
    monkeypatch.setattr(config, "PROJECTS_ROOT", root)
    return root


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


# --- the import path is a trust boundary; these are the attacks it must refuse -------------------
#
# `git bundle verify` checks INTEGRITY, not safety, and git's own path rules only stop `..` and
# absolute paths. Everything below survives verification and a naive clone.

def _hostile_bundle(tmp_path, build) -> bytes:
    """A syntactically perfect project bundle whose tree `build` gets to poison first."""
    repo = tmp_path / "hostile"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", "-b", "main", str(repo)], check=True)
    (repo / "reading-list.md").write_text("# Reading list\n", encoding="utf-8")
    build(repo)
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(["git", "-c", "user.name=a", "-c", "user.email=a@b", "commit", "-q", "-m", "x"],
                   cwd=repo, check=True)
    bundle = tmp_path / "hostile.bundle"
    subprocess.run(["git", "bundle", "create", str(bundle), "HEAD"], cwd=repo, check=True,
                   capture_output=True)
    return bundle.read_bytes()


def test_a_symlink_in_the_bundle_is_refused(tmp_projects, tmp_path):
    """The attack that made this a trust boundary rather than a file copy.

    A bundle can track `.state/covers/x.png` as a symlink to `/etc/passwd`. Git creates it happily
    — no `..`, no absolute path in the tree entry — and `GET .../papers/x/cover.png` then serves
    the host's file straight back through FileResponse.
    """
    def build(repo):
        (repo / "corpus").mkdir()
        (repo / "corpus" / "leak.md").symlink_to("/etc/passwd")

    with pytest.raises(ProjectError, match="symlink"):
        projects.import_bundle(_hostile_bundle(tmp_path, build), "Sneaky")
    assert not projects.list_projects()


def test_a_directory_symlink_is_refused(tmp_projects, tmp_path):
    """The write half of the same attack: a symlinked directory redirects everything this app
    later writes into the project — notes, sessions — somewhere outside it."""
    def build(repo):
        (repo / "sessions").symlink_to("/tmp")

    with pytest.raises(ProjectError, match="symlink"):
        projects.import_bundle(_hostile_bundle(tmp_path, build), "Redirect")
    assert not projects.list_projects()


def test_a_bundle_that_tracks_working_state_is_refused(tmp_projects, tmp_path):
    """`.state/` is git-ignored, so a bundle that *tracks* it did not come from this app.
    Recreating `.state` after checkout would not help — those paths are already on disk by then."""
    def build(repo):
        (repo / ".state").mkdir()
        (repo / ".state" / "usage.json").write_text('{"planted": true}', encoding="utf-8")

    with pytest.raises(ProjectError, match="working state"):
        projects.import_bundle(_hostile_bundle(tmp_path, build), "Planted State")
    assert not projects.list_projects()


def test_malformed_project_metadata_cannot_brick_the_project_list(tmp_projects, tmp_path):
    """A `project.json` of `[]` used to reach `meta.update()` and raise AFTER the directory was
    already in place — leaving a project that every later listing tripped over. Metadata is built
    from scratch now, so the import simply succeeds with sane values."""
    def build(repo):
        (repo / "project.json").write_text("[]", encoding="utf-8")

    meta = projects.import_bundle(_hostile_bundle(tmp_path, build), "Bad Meta")
    assert meta["name"] == "Bad Meta"
    assert projects.list_projects()  # the listing still works, which is the actual property


def test_nothing_is_left_behind_when_an_import_is_refused(tmp_projects, tmp_path):
    """Staging lives inside PROJECTS_ROOT so publication can be an atomic rename. That means a
    rejected import must not leave its staging directory sitting there."""
    def build(repo):
        (repo / "corpus").mkdir()
        (repo / "corpus" / "leak.md").symlink_to("/etc/passwd")

    with pytest.raises(ProjectError):
        projects.import_bundle(_hostile_bundle(tmp_path, build), "Sneaky")
    assert list(tmp_projects.iterdir()) == []


def test_export_does_not_carry_unapproved_stash_entries(tmp_projects):
    """`--all` swept in `refs/stash`, which can hold working material that was never approved —
    precisely what "agent proposes, human commits" exists to keep out of the record."""
    source = _make_project(tmp_projects)
    (projects.project_path(source) / "working-notes.md").write_text("SECRET DRAFT\n", encoding="utf-8")
    projects._git(source, "stash", "push", "-q", "-m", "unapproved")

    imported = projects.import_bundle(projects.export_bundle(source), "No Stash")
    log = projects._git(imported["id"], "log", "--all", "--format=%s")
    assert "unapproved" not in log
    assert "SECRET DRAFT" not in (projects.project_path(imported["id"]) / "working-notes.md").read_text()


def test_a_gitattributes_file_is_refused(tmp_projects, tmp_path):
    """`.gitattributes` is not ordinary content — it can select a filter driver (`filter=lfs`)
    whose COMMAND comes from the host's git config, so checkout would run an external process and
    let the bundle drive network requests. Disabling hooks does not disable filters."""
    def build(repo):
        (repo / ".gitattributes").write_text("* filter=lfs\n", encoding="utf-8")

    with pytest.raises(ProjectError, match="git configuration"):
        projects.import_bundle(_hostile_bundle(tmp_path, build), "Filtered")
    assert not projects.list_projects()


def test_a_case_aliased_state_path_is_refused(tmp_projects, tmp_path):
    """macOS folds case, so `.STATE/sessions.json` is a different string but the same file as
    `.state/sessions.json` — and a planted session index breaks the cross-project recent view."""
    def build(repo):
        (repo / ".STATE").mkdir()
        (repo / ".STATE" / "sessions.json").write_text("[]", encoding="utf-8")

    with pytest.raises(ProjectError, match="working state"):
        projects.import_bundle(_hostile_bundle(tmp_path, build), "Case Alias")
    assert not projects.list_projects()


def test_a_directory_where_a_paper_file_belongs_is_refused(tmp_projects, tmp_path):
    """`corpus/<slug>.md` as a DIRECTORY used to import fine and then make `list_projects` raise
    IsADirectoryError — every project vanishing from the app, not just the bad one."""
    def build(repo):
        d = repo / "corpus" / "attention.md"
        d.mkdir(parents=True)
        (d / "inner.txt").write_text("x", encoding="utf-8")

    with pytest.raises(ProjectError, match="is a directory"):
        projects.import_bundle(_hostile_bundle(tmp_path, build), "Dir Paper")
    assert not projects.list_projects()


def test_a_tree_with_too_many_files_is_refused(tmp_projects, tmp_path, monkeypatch):
    """The byte cap on the bundle says nothing about what it inflates to; a small compressed
    bundle can check out into millions of paths and exhaust the volume."""
    monkeypatch.setattr(projects, "MAX_TREE_ENTRIES", 3)

    def build(repo):
        (repo / "corpus").mkdir()
        for n in range(6):
            (repo / "corpus" / f"p{n}.md").write_text("x", encoding="utf-8")

    with pytest.raises(ProjectError, match="more than 3 files"):
        projects.import_bundle(_hostile_bundle(tmp_path, build), "Too Many")
    assert not projects.list_projects()


def test_an_oversized_blob_is_refused(tmp_projects, tmp_path, monkeypatch):
    monkeypatch.setattr(projects, "MAX_BLOB_BYTES", 128)

    def build(repo):
        (repo / "corpus").mkdir()
        (repo / "corpus" / "huge.md").write_text("x" * 400, encoding="utf-8")

    with pytest.raises(ProjectError, match="larger than"):
        projects.import_bundle(_hostile_bundle(tmp_path, build), "Fat Blob")
    assert not projects.list_projects()


def test_one_unreadable_project_does_not_hide_every_other(tmp_projects):
    """Defence in depth for the case above: even if a bad tree ever got in, the registry must
    degrade to "that project has no papers" rather than returning nothing at all."""
    good = _make_project(tmp_projects, "Healthy")
    broken = _make_project(tmp_projects, "Broken")
    corpus = projects.project_path(broken) / "corpus"
    corpus.mkdir(exist_ok=True)
    (corpus / "paper.md").mkdir()  # a directory where a paper file belongs

    ids = {p["id"] for p in projects.list_projects()}
    assert good in ids and broken in ids


def test_import_works_with_no_git_repository_in_the_working_directory(tmp_projects, tmp_path,
                                                                      monkeypatch):
    """`git bundle verify` needs a repository context and fails without one — and the container's
    working directory (`/srv`) is a COPY of the source, not a repo. Every import on staging and
    production would have been refused.

    The whole suite hid it, because pytest runs inside this repo and git walks upwards. So this
    test moves the working directory somewhere that is definitively not a repo, which is the only
    way the bug is visible from here. It was found by actually running a share against Fly.
    """
    outside = tmp_path / "not-a-repo"
    outside.mkdir()
    monkeypatch.chdir(outside)

    source_root = tmp_path / "elsewhere"
    source_root.mkdir()
    monkeypatch.setattr(config, "PROJECTS_ROOT", source_root)
    source = projects.create_project("Cwd Independent")
    data = projects.export_bundle(source["id"])

    monkeypatch.setattr(config, "PROJECTS_ROOT", tmp_projects)
    imported = projects.import_bundle(data, "Imported From Nowhere")
    assert (projects.project_path(imported["id"]) / "reading-list.md").is_file()


# --- the importer's name channel -----------------------------------------------------------
# `share-to-fly.sh` reaches the importer through `flyctl ssh console -C "sh -lc '...'"`, so the
# argument list is evaluated by a shell in the container. A project name is user-controlled data —
# editable in the app, and carried inside an imported bundle's project.json — so it must not travel
# as shell source.

def _import_bundle_script():
    import importlib.util
    from pathlib import Path

    path = Path(__file__).resolve().parent.parent / "scripts" / "import_bundle.py"
    spec = importlib.util.spec_from_file_location("rc_import_bundle", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_importer_accepts_a_base64_name(tmp_projects, tmp_path):
    """The channel the script actually uses. A name full of shell metacharacters must arrive
    intact as DATA — which is the proof it never needed shell-quoting in the first place."""
    import base64

    source = _make_project(tmp_projects)
    bundle = tmp_path / "src.bundle"
    bundle.write_bytes(projects.export_bundle(source))

    hostile = "Notes $(id) `whoami` && rm -rf /"
    encoded = base64.b64encode(hostile.encode()).decode()
    script = _import_bundle_script()

    assert script.main(["import_bundle.py", str(bundle), "--name-b64", encoded]) == 0
    assert any(p["name"] == hostile for p in projects.list_projects()), \
        "the name should round-trip verbatim, as data"


def test_importer_rejects_a_malformed_base64_name(tmp_projects, tmp_path):
    """A decode failure must be an error, not a silent fallback to treating the argument as the
    name — that fallback would put attacker-controlled text back on the very path this encoding
    exists to remove it from."""
    source = _make_project(tmp_projects)
    bundle = tmp_path / "src2.bundle"
    bundle.write_bytes(projects.export_bundle(source))

    script = _import_bundle_script()
    before = len(projects.list_projects())
    assert script.main(["import_bundle.py", str(bundle), "--name-b64", "not!valid!base64"]) == 2
    assert len(projects.list_projects()) == before


def test_share_to_fly_never_puts_the_name_in_the_remote_command():
    """The defect itself: `$NAME` was interpolated into the nested `sh -lc` program, so a project
    named `$(...)` executed as a command in the destination container with the app's privileges."""
    from pathlib import Path

    script = (Path(__file__).resolve().parent.parent / "scripts" / "share-to-fly.sh").read_text()
    remote_command = script[script.index("flyctl ssh console"):]
    assert "$NAME" not in remote_command, "the raw name must not reach the remote shell"
    assert "--name-b64" in remote_command and "$name_b64" in remote_command


# ---- what HEAD structurally cannot carry: reading progress and unapproved content ----------
#
# Both real transfers of Kamil's corpus (staging 2026-07-27, production 2026-07-29) arrived
# looking untouched, because the two things a reader would call "my work in progress" are exactly
# the two things a HEAD-only bundle omits: `.state/sessions.json`, which is gitignored and is the
# ONLY source of `Paper.session_state`; and the retrieved papers and live transcripts that
# invariant 4 deliberately leaves uncommitted until a human approves them.


def _project_with_work(tmp_projects, name="In Progress"):
    """A project shaped like one someone has actually been reading in."""
    pid = _make_project(tmp_projects, name)
    root = projects.project_path(pid)
    (root / "reading-list.md").write_text(
        "# Reading list\n\n**Attention Is All You Need** — *unread*\n", encoding="utf-8")
    projects._git(pid, "add", "-A")
    projects._git(pid, "commit", "-q", "-m", "Add a paper")
    # Uncommitted on purpose: a retrieved paper, a live transcript, and a reading-list entry added
    # but never approved.
    (root / "corpus").mkdir(exist_ok=True)
    (root / "sessions").mkdir(exist_ok=True)
    (root / "corpus" / "attention.md").write_text("Full text.", encoding="utf-8")
    (root / "sessions" / "attention.jsonl").write_text('{"role":"user"}\n', encoding="utf-8")
    (root / "reading-list.md").write_text(
        "# Reading list\n\n**Attention Is All You Need** — *unread*\n"
        "**A Second Paper** — *unread*\n", encoding="utf-8")
    state = root / ".state"
    state.mkdir(exist_ok=True)
    (state / "sessions.json").write_text('{"attention": {"state": "in_discussion"}}', encoding="utf-8")
    return pid


def test_reading_progress_and_unapproved_work_travel_with_the_project(tmp_projects):
    source = _project_with_work(tmp_projects)

    imported = projects.import_bundle(projects.export_bundle(source), "Moved")
    dest = projects.project_path(imported["id"])

    # The progress index: without this every paper reads as untouched at the destination.
    assert '"in_discussion"' in (dest / ".state" / "sessions.json").read_text()
    # The unapproved content HEAD never saw.
    assert (dest / "corpus" / "attention.md").read_text() == "Full text."
    assert (dest / "sessions" / "attention.jsonl").exists()
    assert "A Second Paper" in (dest / "reading-list.md").read_text()


def test_unapproved_work_arrives_unstaged_so_no_commit_can_sweep_it_in(tmp_projects):
    """Invariant 4: a human approves before anything joins the record. Blobs are written directly
    rather than checked out for exactly this reason — `git checkout <ref> -- .` would stage them,
    and the next commit would silently absorb papers and transcripts nobody approved."""
    source = _project_with_work(tmp_projects)

    imported = projects.import_bundle(projects.export_bundle(source), "Unstaged")
    pid = imported["id"]

    staged = projects._git(pid, "diff", "--cached", "--name-only").strip()
    assert staged == "", f"nothing may arrive staged, found: {staged}"
    # It is present as working-tree content, which is what it actually is.
    status = projects._git(pid, "status", "--porcelain")
    assert "?? corpus/" in status or "?? corpus/attention.md" in status
    assert " M reading-list.md" in status


def test_regenerable_caches_and_the_usage_ledger_still_stay_behind(tmp_projects):
    """The whitelist is the point: `.state/` is 207 MB of one 214 MB project, nearly all of it
    derived from committed content (covers, figures, graphs) and reproducible at the destination.
    `usage.json` is worse than large — it is another instance's billing record."""
    source = _project_with_work(tmp_projects)
    state = projects.project_path(source) / ".state"
    (state / "usage.json").write_text('{"cost": 999}', encoding="utf-8")
    (state / "covers").mkdir(exist_ok=True)
    (state / "covers" / "attention.png").write_bytes(b"\x89PNG-not-really")
    (state / "reference-graph.json").write_text("{}", encoding="utf-8")

    imported = projects.import_bundle(projects.export_bundle(source), "No Caches")
    dest_state = projects.project_path(imported["id"]) / ".state"

    assert not (dest_state / "usage.json").exists()
    assert not (dest_state / "covers" / "attention.png").exists()
    assert not (dest_state / "reference-graph.json").exists()
    # …while the small authored part did travel.
    assert (dest_state / "sessions.json").exists()


def test_working_state_cannot_override_the_importer_s_own_metadata(tmp_projects):
    """The sender controls this payload. `project.json` is the interesting target: the importer
    rebuilds it (id, name, owner) precisely so a bundle cannot choose them, and a working-state
    file must not smuggle it back in."""
    source = _project_with_work(tmp_projects)
    root = projects.project_path(source)
    (root / "project.json").write_text('{"id": "hijacked", "name": "Hijacked"}', encoding="utf-8")

    imported = projects.import_bundle(projects.export_bundle(source), "Legitimate Name")

    assert imported["id"] != "hijacked"
    assert imported["name"] == "Legitimate Name"
    on_disk = json.loads((projects.project_path(imported["id"]) / "project.json").read_text())
    assert on_disk["id"] == imported["id"]
    assert on_disk["name"] == "Legitimate Name"


def test_the_transport_ref_does_not_survive_into_the_imported_project(tmp_projects):
    """Left behind, the next export of the imported project would emit a stale snapshot next to
    the freshly built one."""
    source = _project_with_work(tmp_projects)
    imported = projects.import_bundle(projects.export_bundle(source), "Clean Refs")

    refs = projects._git(imported["id"], "for-each-ref", "--format=%(refname)")
    assert projects.WORKING_STATE_REF not in refs


def test_export_leaves_the_source_project_untouched(tmp_projects):
    """Export builds a commit out of the working tree. It must do that in a private index: a human
    may have staged something, and sharing a project is not a reason to disturb their staging area
    — or to leave the transport ref lying around mid-session."""
    source = _project_with_work(tmp_projects)
    projects._git(source, "add", "--", "corpus/attention.md")   # deliberately staged by "a human"
    before = projects._git(source, "status", "--porcelain")

    projects.export_bundle(source)

    assert projects._git(source, "status", "--porcelain") == before
    # And the transport ref is not left reachable: it pins a snapshot of the whole working tree,
    # so keeping one per export would grow the source repo on every share.
    assert projects.WORKING_STATE_REF not in projects._git(
        source, "for-each-ref", "--format=%(refname)")


def test_a_forged_working_state_path_cannot_write_outside_the_project(tmp_projects, tmp_path):
    """End-to-end proof that a hand-crafted traversal entry lands nothing outside the project.

    The tree is built from RAW object bytes because that is what the attack requires: `git mktree`
    and `update-index` both refuse a `..` component, so no ordinary git command produces this, but
    a bundle is only bytes.

    Note WHY this currently cannot escape, because it is not the allowlist: `git ls-tree -r` does
    list `corpus/../escaped.md`, but blobs are read as `<ref>:<path>`, and git normalises that path
    and refuses it — so the read fails before any write. That is an accident of how the blob is
    addressed, not a decision, and reading by object id instead would remove it silently. The
    allowlist and the containment check at the write are the deliberate barriers, covered directly
    by `test_working_path_allowlist_refuses_traversal_and_git_internals`.
    """
    source = _project_with_work(tmp_projects)
    root = projects.project_path(source)

    def write_object(kind: str, payload: bytes) -> str:
        # --literally: skip the sanity checks that would otherwise refuse these names.
        return subprocess.run(
            ["git", "hash-object", "-w", "-t", kind, "--stdin", "--literally"],
            cwd=str(root), input=payload, capture_output=True, check=True,
        ).stdout.decode().strip()

    blob = write_object("blob", b"owned")
    tree = write_object("tree", b"100644 escaped.md\0" + bytes.fromhex(blob))
    for _ in range(2):                       # corpus/../../escaped.md
        tree = write_object("tree", b"40000 ..\0" + bytes.fromhex(tree))
    tree = write_object("tree", b"40000 corpus\0" + bytes.fromhex(tree))
    commit = subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t",
                             "commit-tree", tree, "-m", "hostile"], cwd=str(root),
                            capture_output=True, text=True, check=True).stdout.strip()
    projects._git(source, "update-ref", projects.WORKING_STATE_REF, commit)

    bundle = tmp_path / "hostile.bundle"
    subprocess.run(["git", "bundle", "create", str(bundle), "HEAD",
                    projects.WORKING_STATE_REF], cwd=str(root), capture_output=True, check=True)

    imported = projects.import_bundle(bundle.read_bytes(), "Hostile")

    dest = projects.project_path(imported["id"])
    assert not (dest.parent / "escaped.md").exists()
    assert not (dest.parent.parent / "escaped.md").exists()
    assert not (tmp_projects / "escaped.md").exists()
    assert not (tmp_path / "escaped.md").exists()


def test_working_path_allowlist_refuses_traversal_and_git_internals():
    """The guard itself, not the end-to-end outcome. Every prefix rule below it is a `startswith`
    test, and a prefix test says nothing about where a path lands."""
    accepts = projects._accepts_working_path

    assert accepts("corpus/attention.md") is True
    assert accepts("sessions/attention.jsonl") is True
    assert accepts(".state/sessions.json") is True
    assert accepts("reading-list.md") is True

    for escape in ("corpus/../../escaped.md", "corpus/../.git/index", "sessions/../../../x.md",
                   "../escaped.md", "/etc/passwd", "corpus/./../../x.md"):
        assert accepts(escape) is False, escape
    for internal in (".git/config", ".git/hooks/pre-commit", ".gitignore", ".gitattributes",
                     "project.json"):
        assert accepts(internal) is False, internal
    assert accepts("") is False


def test_an_imported_project_ignores_state_even_if_the_bundle_said_otherwise(tmp_projects):
    """A sender-controlled `.gitignore` that omits `.state/` passes every existing check — it is
    ordinary content — and then the next approval's `git add -A` stages the `.state/` the import
    just wrote, provisional-owner marker included. Invariant 4 would break at that commit, looking
    like the reader approved it."""
    source = _project_with_work(tmp_projects)
    root = projects.project_path(source)
    (root / ".gitignore").write_text("*.tmp\n", encoding="utf-8")   # note: no .state/
    # Only the ignore file: committing everything would TRACK .state and be refused outright by
    # _reject_hostile_tree, which is a different (already-covered) protection.
    projects._git(source, "add", "--", ".gitignore")
    projects._git(source, "commit", "-q", "-m", "weaken gitignore")

    imported = projects.import_bundle(projects.export_bundle(source), "Ignored State")
    pid = imported["id"]

    assert ".state/" in (projects.project_path(pid) / ".gitignore").read_text()
    # The project's own rule is kept, not replaced.
    assert "*.tmp" in (projects.project_path(pid) / ".gitignore").read_text()
    # And the imported working state is genuinely untracked, which is the property that matters.
    projects._git(pid, "add", "-A")
    assert ".state/" not in projects._git(pid, "diff", "--cached", "--name-only")


def test_an_imported_project_lands_on_the_default_branch(tmp_projects):
    """A bundle carries `HEAD` and never `refs/heads/*` (export is deliberately not `--all`), so
    `git clone` has no branch to adopt and lands DETACHED with zero branch refs.

    Found live 2026-08-15: five of six real projects were sitting detached with no branch, every
    one traceable to a bundle import, while the only natively created project was on `main`.
    Nothing was broken by it — but `create_project` guarantees this shape and the import path was
    quietly not, and the detachment propagates to any clone of the project directory."""
    source = _make_project(tmp_projects)
    projects._git(source, "commit", "-q", "--allow-empty", "-m", "A commit")

    imported = projects.import_bundle(projects.export_bundle(source), "Branch Check")
    pid = imported["id"]

    assert projects._git(pid, "symbolic-ref", "--short", "HEAD") == projects.DEFAULT_BRANCH
    assert projects._git(
        pid, "for-each-ref", "--format=%(refname:short)", "refs/heads",
    ).split() == [projects.DEFAULT_BRANCH]


def test_attaching_the_branch_moves_neither_head_nor_the_tree(tmp_projects):
    """`branch -f` + `symbolic-ref` rather than a checkout, precisely so this cannot disturb what
    the import already materialized — including the working state written into the checkout."""
    source = _make_project(tmp_projects)
    (projects.project_path(source) / "reading-list.md").write_text(
        "# Reading list\n\n- A Paper\n", encoding="utf-8")
    projects._git(source, "add", "-A")
    projects._git(source, "commit", "-q", "-m", "Add a paper")

    imported = projects.import_bundle(projects.export_bundle(source), "Tree Check")
    pid = imported["id"]

    # HEAD resolves to the same commit the history ends on, and the file is intact.
    assert projects._git(pid, "rev-parse", "HEAD") == projects._git(pid, "rev-parse", projects.DEFAULT_BRANCH)
    assert "A Paper" in (projects.project_path(pid) / "reading-list.md").read_text()


def test_an_imported_project_can_be_cloned_onto_a_branch(tmp_projects, tmp_path):
    """The propagation this fixes: cloning a branchless repo used to hand you another branchless
    repo, spreading the state to every backup and copy."""
    source = _make_project(tmp_projects)
    projects._git(source, "commit", "-q", "--allow-empty", "-m", "A commit")
    pid = projects.import_bundle(projects.export_bundle(source), "Clone Check")["id"]

    dest = tmp_path / "cloned"
    subprocess.run(["git", "clone", "-q", str(projects.project_path(pid)), str(dest)],
                   check=True, capture_output=True)

    head = subprocess.run(["git", "symbolic-ref", "--short", "HEAD"], cwd=str(dest),
                          capture_output=True, text=True)
    assert head.returncode == 0, "clone landed detached"
    assert head.stdout.strip() == projects.DEFAULT_BRANCH


def test_a_bundle_that_already_carries_the_branch_imports_cleanly(tmp_projects, tmp_path):
    """A bundle built elsewhere with `--all` arrives already ON `main`, and `git branch -f` refuses
    to force a checked-out branch. Attaching must be a no-op there, not a failed import."""
    other = tmp_path / "elsewhere"
    other.mkdir()
    subprocess.run(["git", "init", "-q", "-b", projects.DEFAULT_BRANCH, str(other)], check=True)
    (other / "reading-list.md").write_text("# Reading list\n\n- A Paper\n", encoding="utf-8")
    (other / "working-notes.md").write_text("# Project Notes\n", encoding="utf-8")
    (other / "reading-method.md").write_text("# Method\n", encoding="utf-8")
    (other / "project.json").write_text(json.dumps({"id": "x", "name": "Elsewhere"}), encoding="utf-8")
    for args in (["add", "-A"],
                 ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", "x"]):
        subprocess.run(["git", *args], cwd=other, check=True)
    bundle = tmp_path / "all.bundle"
    subprocess.run(["git", "bundle", "create", str(bundle), "--all", "HEAD"], cwd=other,
                   check=True, capture_output=True)

    pid = projects.import_bundle(bundle.read_bytes(), "From Elsewhere")["id"]

    assert projects._git(pid, "symbolic-ref", "--short", "HEAD") == projects.DEFAULT_BRANCH
    assert "A Paper" in (projects.project_path(pid) / "reading-list.md").read_text()
