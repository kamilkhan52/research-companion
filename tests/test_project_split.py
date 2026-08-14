"""R8.1 — project splitting (phase 1, deterministic): the move/copy of papers and their work
between two projects, slug validation, the running-job guard, and cites hygiene. No LLM, no
network."""
from __future__ import annotations

import time

import pytest
from app import (
    config,
    graph_store,
    jobs,
    notes_jobs,
    paper_metadata,
    project_split,
    projects,
    sessions,
    store,
)
from app.routers.projects_api import SplitReq
from app.routers.projects_api import split_project as split_route

from tests.conftest import add_paper


class _AnonRequest:
    """A request with no signed-in user — the single-tenant shape these tests exercise.

    These routes now take `Request` so they can scope results to the caller. With no database
    configured, `tenancy` short-circuits before ever reading `state.user`, so this stub only has to
    exist, not carry an identity.
    """

    class state:  # noqa: N801 — mirrors Starlette's attribute name, not a class of its own
        user = None




def _bind(pid):
    return config.set_active_project(pid)


def _seed_source(pid):
    add_paper(pid, "awq", "AWQ", full_text="AWQ text")
    add_paper(pid, "smooth", "SmoothQuant", full_text="Smooth text")
    add_paper(pid, "core", "Core Paper", full_text="Core text")
    # awq cites both a moving (smooth) and a staying (core) paper.
    rl = store._reading_list()
    txt = rl.read_text().replace("<!-- slug: awq -->",
                                 "<!-- slug: awq -->\n<!-- cites: smooth, core -->")
    rl.write_text(txt)
    store._parse_cache.clear()
    # give awq a committed Paper Notes block + a session + graph caches
    store.append_notes_block("awq", "AWQ", "## Notes\n\nKey result: 4-bit works.")
    sessions.set_state("awq", "in_discussion")
    jsonl, _ = sessions.transcript_paths("awq")
    jsonl.parent.mkdir(parents=True, exist_ok=True)
    jsonl.write_text('{"role":"user","text":"hi"}\n')
    data = graph_store.load()
    graph_store.set_paper_extraction(data, "awq", {"slug": "awq", "status": "done",
                                                   "references": [], "content_hash": "x"})
    graph_store.write_retrieved_text("awq", "AWQ retrieved body")
    graph_store.save(data)
    paper_metadata.set_affiliation_record("awq", {
        "status": "done",
        "key": "awq-text",
        "authorships": [{"name": "A", "affiliation": "MIT"}],
    })
    paper_metadata.set_reference_record("awq", {
        "slug": "awq",
        "status": "done",
        "references": [{"index": 1, "title": "Canonical Reference"}],
        "content_hash": graph_store.content_hash("AWQ text"),
    })


def test_move_carries_work_and_removes_from_source(temp_project):
    _seed_source(temp_project)

    res = project_split.split_project(temp_project, "Quantization", ["awq", "smooth"],
                                      remove_from_source=True, goals="low-bit inference")
    new_pid = res["new_pid"]
    assert res["moved"] == 2 and res["removed"] is True
    assert "awq" in res["departed_notes"] and "4-bit" in res["departed_notes"]["awq"]

    # New project has the papers, the notes, the transcript, and the graph caches.
    tok = _bind(new_pid)
    try:
        slugs = {p.slug for p in store.list_papers()}
        assert slugs == {"awq", "smooth"}
        assert "4-bit works" in store.read_notes("awq")
        assert sessions.get_state("awq") == "in_discussion"
        jsonl, _ = sessions.transcript_paths("awq")
        assert jsonl.exists()
        data = graph_store.load()
        assert graph_store.get_paper_extraction(data, "awq")["status"] == "done"
        assert graph_store.read_retrieved_text("awq") == "AWQ retrieved body"
        assert paper_metadata.affiliation_record("awq")["authorships"][0]["affiliation"] == "MIT"
        assert paper_metadata.reference_record("awq")["references"][0]["title"] == (
            "Canonical Reference"
        )
        # The cite to the STAYING paper (core) was dropped; the moving one (smooth) kept.
        awq = store.entry_details("awq")
        assert awq["cites"] == ["smooth"]
        assert projects._read_meta(new_pid).get("goals") == "low-bit inference"
    finally:
        config.reset_active_project(tok)

    # Source lost the moved papers but kept 'core'; no dangling cite remains.
    remaining = {p.slug for p in store.list_papers()}
    assert remaining == {"core"}
    assert store.corpus_path("awq").exists() is False
    src_data = graph_store.load()
    assert "awq" not in src_data.get("papers", {})
    assert paper_metadata.affiliation_record("awq") is None
    assert paper_metadata.reference_record("awq") is None


def test_move_leaves_source_repo_clean(temp_project):
    """A committed corpus/transcript that the split deletes must be staged+committed, or the
    source repo is left dirty and a later approval commits the deletion by accident."""
    import subprocess

    from app import projects

    _seed_source(temp_project)
    # Commit awq's corpus + transcript so their deletion is a tracked change.
    projects._git(temp_project, "add", "-A")
    projects._git(temp_project, "commit", "-q", "-m", "seed committed work")

    project_split.split_project(temp_project, "Q", ["awq"], remove_from_source=True)

    status = subprocess.run(["git", "status", "--porcelain"],
                            cwd=str(projects.project_path(temp_project)),
                            capture_output=True, text=True).stdout.splitlines()
    # `.state/` is gitignored in real projects (create_project writes .gitignore); the bare
    # test fixture has no gitignore, so filter those out — the point is that no COMMITTED
    # record file (reading list, corpus, transcript) is left uncommitted.
    dirty = [ln for ln in status if ".state/" not in ln]
    assert dirty == [], f"source repo dirty after split: {dirty!r}"


def test_copy_leaves_source_intact_and_copies_session_history(temp_project):
    _seed_source(temp_project)
    # Copy is an independent duplicate of the paper plus its work, including discussion.
    sessions.set_state("smooth", "in_discussion")
    res = project_split.split_project(temp_project, "Reading B", ["smooth", "awq"],
                                      remove_from_source=False)
    assert res["removed"] is False
    assert {p.slug for p in store.list_papers()} == {"awq", "smooth", "core"}  # source whole
    assert sessions.get_state("awq") == "in_discussion"  # source session untouched
    tok = _bind(res["new_pid"])
    try:
        assert {p.slug for p in store.list_papers()} == {"smooth", "awq"}
        assert sessions.get_state("awq") == "in_discussion"
        assert sessions.transcript_paths("awq")[0].read_text() == \
            '{"role":"user","text":"hi"}\n'
    finally:
        config.reset_active_project(tok)


def test_split_copies_confirmed_title_decision_with_entry_block(temp_project):
    _seed_source(temp_project)
    assert store.confirm_entry_title("awq") is True

    res = project_split.split_project(
        temp_project, "Confirmed Titles", ["awq"], remove_from_source=False,
    )
    tok = _bind(res["new_pid"])
    try:
        assert store.get_paper("awq").title_confirmed is True
        assert "<!-- title-confirmed -->" in store.entry_details("awq")["block"]
    finally:
        config.reset_active_project(tok)


def test_unknown_slug_is_rejected_before_any_write(temp_project):
    _seed_source(temp_project)
    before = {p["id"] for p in projects.list_projects()}
    with pytest.raises(project_split.SplitError):
        project_split.split_project(temp_project, "Nope", ["awq", "../evil"])
    # No new project scaffolded (validation happens before create_project).
    assert {p["id"] for p in projects.list_projects()} == before


def test_empty_selection_and_blank_name_rejected(temp_project):
    _seed_source(temp_project)
    with pytest.raises(project_split.SplitError):
        project_split.split_project(temp_project, "X", [])
    with pytest.raises(project_split.SplitError):
        project_split.split_project(temp_project, "  ", ["awq"])


def test_split_route_refuses_while_a_job_runs(temp_project):
    _seed_source(temp_project)
    reg = jobs.JobRegistry("splitkind")
    try:
        job = jobs.Job(id="j1")
        setattr(job, jobs._PID_ATTR, temp_project)
        reg.jobs["j1"] = job
        assert jobs.any_running_for_project(temp_project) == "splitkind"
    finally:
        jobs._ALL_REGISTRIES.remove(reg)


def test_split_of_an_uncommitted_only_paper_succeeds(temp_project):
    """A paper that exists only as an uncommitted reading-list add: removing it restores the
    file to HEAD, so the source commit is a no-op — the completed move must still succeed."""
    _seed_source(temp_project)  # awq/smooth/core are uncommitted adds in the bare fixture
    res = project_split.split_project(temp_project, "Fresh", ["smooth"],
                                      remove_from_source=True)
    assert res["removed"] is True and res["new_pid"]
    assert {p.slug for p in store.list_papers()} == {"awq", "core"}


def test_split_route_starts_project_scoped_notes_proposals_after_relocation(
    temp_project, monkeypatch,
):
    """R8.3: both LLM passes are real background jobs, admitted after deterministic phase 1
    but before its reservations release; each worker sees the correct project's Project Notes."""
    _seed_source(temp_project)
    store.write_synthesis("# Project Notes\n\nAWQ supports four-bit inference. Core remains.")
    monkeypatch.setattr(config, "has_api_key", lambda: True)

    def fake_events(target, prompt):
        if "CURRENT DESTINATION" in prompt:
            yield {"type": "final", "text": "# Project Notes\n\nDestination synthesis."}
        else:
            yield {"type": "final", "text": "# Project Notes\n\nCore remains."}

    monkeypatch.setattr(notes_jobs, "_default_events", fake_events)
    admitted_while_reserved = set()
    original_destination = notes_jobs.start_split_destination
    original_cleanup = notes_jobs.start_split_source_cleanup

    def checked_destination(*args, **kwargs):
        active = config.active_project_id()
        assert active and config.project_is_busy(active)
        admitted_while_reserved.add(("destination", active))
        return original_destination(*args, **kwargs)

    def checked_cleanup(*args, **kwargs):
        active = config.active_project_id()
        assert active and config.project_is_busy(active)
        admitted_while_reserved.add(("source", active))
        return original_cleanup(*args, **kwargs)

    monkeypatch.setattr(notes_jobs, "start_split_destination", checked_destination)
    monkeypatch.setattr(notes_jobs, "start_split_source_cleanup", checked_cleanup)
    notes_jobs._jobs.clear()
    try:
        result = split_route(
            temp_project,
            SplitReq(
                name="Quantization",
                slugs=["awq"],
                remove_from_source=True,
                draft_destination_notes=True,
                cleanup_source_notes=True,
            ),
            _AnonRequest(),
        )
        dest_job_id = result["notes_jobs"]["destination"]["id"]
        source_job_id = result["notes_jobs"]["source_cleanup"]["id"]

        deadline = time.time() + 5
        while time.time() < deadline:
            source = notes_jobs.get_job(source_job_id)
            tok = _bind(result["new_pid"])
            try:
                dest = notes_jobs.get_job(dest_job_id)
            finally:
                config.reset_active_project(tok)
            if source and dest and source.status != "running" and dest.status != "running":
                break
            time.sleep(0.02)

        assert source and source.status == "done"
        assert source.kind == "split_source_cleanup"
        assert admitted_while_reserved == {
            ("destination", result["new_pid"]),
            ("source", temp_project),
        }
        tok = _bind(result["new_pid"])
        try:
            dest = notes_jobs.get_job(dest_job_id)
            assert dest and dest.status == "done"
            assert dest.kind == "split_destination"
            # create_project scaffolds a starter document; the job must not replace it until
            # approval.
            assert "Destination synthesis" not in notes_jobs.read(notes_jobs.WORKING)
        finally:
            config.reset_active_project(tok)
        assert "AWQ supports" in notes_jobs.read(notes_jobs.WORKING)
    finally:
        notes_jobs._jobs.clear()


def test_mark_project_busy_is_exclusive(temp_project):
    """mark_project_busy reserves the pid; a second reservation fails so the route can reject
    a concurrent split of the same project."""
    assert config.mark_project_busy(temp_project) is True
    try:
        assert config.mark_project_busy(temp_project) is False  # already reserved
    finally:
        config.unmark_project_busy(temp_project)
    assert config.mark_project_busy(temp_project) is True  # reservation freed
    config.unmark_project_busy(temp_project)


def test_delete_refuses_while_a_split_reserves_the_project(temp_project):
    """A split reserves the pid via mark_project_busy; deletion must refuse while it's held so
    the dir isn't moved out from under a split mid-copy."""
    _seed_source(temp_project)
    config.mark_project_busy(temp_project)
    try:
        with pytest.raises(projects.ProjectError, match="being moved or split"):
            projects.delete_project(temp_project)
        assert projects.exists(temp_project) is True
    finally:
        config.unmark_project_busy(temp_project)


def test_busy_source_admits_no_new_jobs(temp_project):
    """The split marks the source busy across its sweep+migration; a job that tries to start
    meanwhile is refused, closing the check-then-move race."""
    _seed_source(temp_project)
    reg = jobs.JobRegistry("splitkind2")
    try:
        config.mark_project_busy(temp_project)
        with pytest.raises(RuntimeError, match="being modified"):
            reg.start_or_join("k", lambda: jobs.Job(id="jx"), lambda j: None,
                              project_id=temp_project)
        assert reg.jobs == {}
    finally:
        config.unmark_project_busy(temp_project)
        jobs._ALL_REGISTRIES.remove(reg)


def test_synchronous_committing_writers_refuse_while_reserved(temp_project):
    """Task #75: the fast git-committing writers (add/remove/approve/notes-save) hold the
    project write guard, which refuses while a split/move reserves the project — so none can
    START a commit that would overlap the relocation's index writes."""
    from app.routers.notes import (
        AddPaperReq,
        ApproveReq,
        NotesSaveReq,
        add_paper,
        approve,
        save_notes,
    )
    from app.routers.projects_api import remove_paper
    from fastapi import HTTPException
    _seed_source(temp_project)
    config.mark_project_busy(temp_project)
    try:
        for call in (
            lambda: add_paper(temp_project, AddPaperReq(title="New"), _AnonRequest()),
            lambda: remove_paper(temp_project, "awq"),
            lambda: approve(ApproveReq(slug="awq")),
            lambda: save_notes("Project Notes", NotesSaveReq(markdown="x", summary="y")),
        ):
            with pytest.raises(HTTPException) as exc:
                call()
            assert exc.value.status_code == 409
    finally:
        config.unmark_project_busy(temp_project)
    # Reservation freed: the source is intact (no refused call mutated it).
    assert {p.slug for p in store.list_papers()} == {"awq", "smooth", "core"}


def test_split_drains_an_in_flight_writer_before_relocating(temp_project):
    """The split acquires the project's exclusive lock, which waits for a synchronous writer
    already holding the read guard — so a commit in flight when the split starts completes
    first rather than overlapping the relocation."""
    import threading

    _seed_source(temp_project)
    reader_holding = threading.Event()
    release_reader = threading.Event()

    def in_flight_writer():
        with config.project_write_guard(temp_project):
            reader_holding.set()
            release_reader.wait(5)

    r = threading.Thread(target=in_flight_writer)
    r.start()
    assert reader_holding.wait(5)

    split_done = threading.Event()

    def run_split():
        config.set_active_project(temp_project)
        project_split.split_project(temp_project, "Drained", ["smooth"],
                                    remove_from_source=True)
        split_done.set()

    s = threading.Thread(target=run_split)
    s.start()
    assert not split_done.wait(0.3)  # split blocked draining the in-flight writer

    release_reader.set()
    assert split_done.wait(10)  # writer drained ⇒ split proceeds
    r.join(5)
    s.join(10)
    assert {p.slug for p in store.list_papers()} == {"awq", "core"}


# --- R9.13: move into an EXISTING project ----------------------------------------------------

def _make_dest(name="Existing", papers=(("base", "Base Paper"),)):
    """Create a second, committed project to move papers into."""
    dpid = projects.create_project(name)["id"]
    tok = _bind(dpid)
    try:
        for slug, title in papers:
            add_paper(dpid, slug, title, full_text=f"{title} text")
        projects._git(dpid, "add", "-A")
        projects._git(dpid, "commit", "-q", "-m", "seed dest")
    finally:
        config.reset_active_project(tok)
    return dpid


def test_move_committed_paper_retains_the_user_facing_chat(temp_project):
    """A read paper must not fall back to Reading Modes in the destination: committed state and
    the transcript entries the mobile UI renders both travel together."""
    _seed_source(temp_project)
    jsonl, _ = sessions.transcript_paths("awq")
    jsonl.write_text(
        '{"role":"user","kind":"reply","text":"What is the key result?"}\n'
        '{"role":"assistant","canonical":"Four-bit weights work.","narration":"",'
        '"state_signal":"","proposed_commit":{"summary":"Read AWQ","notes_block":"n",'
        '"synthesis":"s"},"proposal_committed":true}\n'
    )
    sessions.set_state("awq", "committed")
    dest = _make_dest()

    project_split.move_to_existing(
        temp_project, dest, ["awq"], remove_from_source=True,
    )
    tok = _bind(dest)
    try:
        assert sessions.get_state("awq") == "committed"
        assert [entry["role"] for entry in sessions.transcript("awq")] == [
            "user", "assistant",
        ]
        assert sessions.transcript("awq")[1]["canonical"] == "Four-bit weights work."
    finally:
        config.reset_active_project(tok)


def test_move_to_existing_appends_and_removes_from_source(temp_project):
    _seed_source(temp_project)
    dest = _make_dest()
    res = project_split.move_to_existing(temp_project, dest, ["awq", "smooth"],
                                         remove_from_source=True)
    assert res["new_pid"] == dest and res["moved"] == 2 and res["removed"] is True
    assert "awq" in res["departed_notes"]

    tok = _bind(dest)
    try:
        assert {p.slug for p in store.list_papers()} == {"base", "awq", "smooth"}
        assert "4-bit works" in store.read_notes("awq")
        assert sessions.get_state("awq") == "in_discussion"
        assert graph_store.read_retrieved_text("awq") == "AWQ retrieved body"
    finally:
        config.reset_active_project(tok)
    assert {p.slug for p in store.list_papers()} == {"core"}  # source lost the moved papers


def test_move_to_existing_carries_confirmed_title_decision(temp_project):
    _seed_source(temp_project)
    assert store.confirm_entry_title("awq") is True
    dest = _make_dest()

    project_split.move_to_existing(temp_project, dest, ["awq"], remove_from_source=True)

    tok = _bind(dest)
    try:
        assert store.get_paper("awq").title_confirmed is True
        assert "<!-- title-confirmed -->" in store.entry_details("awq")["block"]
    finally:
        config.reset_active_project(tok)


def test_move_to_existing_keeps_a_cite_to_a_destination_paper(temp_project):
    _seed_source(temp_project)
    dest = _make_dest(papers=(("core", "Core In Dest"),))  # dest already has 'core'
    project_split.move_to_existing(temp_project, dest, ["awq", "smooth"],
                                   remove_from_source=True)
    tok = _bind(dest)
    try:
        # awq's cites to smooth (moved) AND core (already in dest) both survive.
        assert store.entry_details("awq")["cites"] == ["smooth", "core"]
    finally:
        config.reset_active_project(tok)


def test_move_to_existing_refuses_a_slug_collision(temp_project):
    _seed_source(temp_project)
    dest = _make_dest(papers=(("awq", "AWQ already here"),))
    with pytest.raises(project_split.SplitError, match="already have data"):
        project_split.move_to_existing(temp_project, dest, ["awq", "smooth"])
    assert {p.slug for p in store.list_papers()} == {"awq", "smooth", "core"}  # nothing moved


def test_move_to_existing_refuses_retained_on_disk_data(temp_project):
    """The removal endpoint keeps a paper's corpus/transcript on disk; a move of the same slug
    into that dest must be refused as a collision, not silently overwrite the retained data."""
    _seed_source(temp_project)
    dest = _make_dest()
    tok = _bind(dest)
    try:
        store.write_full_text("awq", "Old AWQ", "retained body", {"slug": "awq"})
        store.append_notes_block("awq", "Old AWQ", "## Notes\n\nDEST's own history.")
    finally:
        config.reset_active_project(tok)
    with pytest.raises(project_split.SplitError, match="already have data"):
        project_split.move_to_existing(temp_project, dest, ["awq"])
    tok = _bind(dest)
    try:
        assert "DEST's own history" in store.read_notes("awq")  # untouched
    finally:
        config.reset_active_project(tok)


def test_move_to_existing_refuses_retained_session_metadata(temp_project):
    """Session state can survive without a corpus or transcript. It is still destination-owned
    paper work and must not be silently overwritten by a same-slug Move or Copy."""
    _seed_source(temp_project)
    dest = _make_dest()
    tok = _bind(dest)
    try:
        sessions.set_state("awq", "committed")
        sessions.set_reading_mode("awq", "technical")
        assert sessions.transcript_paths("awq")[0].exists() is False
        assert store.corpus_path("awq").exists() is False
    finally:
        config.reset_active_project(tok)

    with pytest.raises(project_split.SplitError, match="already have data"):
        project_split.move_to_existing(
            temp_project, dest, ["awq"], remove_from_source=False,
        )

    tok = _bind(dest)
    try:
        assert sessions.get_state("awq") == "committed"
        assert sessions.get_reading_mode("awq") == "technical"
    finally:
        config.reset_active_project(tok)


def test_move_to_existing_refuses_a_retained_graph_record(temp_project):
    """A dest that graphed a same-slug metadata-only paper and removed it can retain the slug
    in reference-graph.json with no files. A move of that slug must be refused, or the fresh
    caches combine with the old graph node and the Map serves stale edges with no rebuild."""
    _seed_source(temp_project)
    dest = _make_dest()
    tok = _bind(dest)
    try:
        data = graph_store.load()
        graph_store.set_paper_extraction(data, "awq", {"slug": "awq", "status": "done",
                                                       "references": [], "content_hash": "old"})
        graph_store.save(data)  # graph record for awq, but no corpus/reading-list entry
        assert store.corpus_path("awq").exists() is False
    finally:
        config.reset_active_project(tok)
    with pytest.raises(project_split.SplitError, match="already have data"):
        project_split.move_to_existing(temp_project, dest, ["awq"])


def test_move_to_existing_rejects_traversal_and_self(temp_project):
    _seed_source(temp_project)
    dest = _make_dest()
    with pytest.raises(project_split.SplitError, match="Not current papers"):
        project_split.move_to_existing(temp_project, dest, ["awq", "../../etc/passwd"])
    with pytest.raises(project_split.SplitError, match="different project"):
        project_split.move_to_existing(temp_project, temp_project, ["awq"])
    assert {p.slug for p in store.list_papers()} == {"awq", "smooth", "core"}


def test_move_to_existing_leaves_dest_repo_clean(temp_project):
    import subprocess

    _seed_source(temp_project)
    dest = _make_dest()
    project_split.move_to_existing(temp_project, dest, ["awq"], remove_from_source=True)
    status = subprocess.run(["git", "status", "--porcelain"],
                            cwd=str(projects.project_path(dest)),
                            capture_output=True, text=True).stdout.splitlines()
    assert [ln for ln in status if ".state/" not in ln] == []


def test_move_rolls_the_destination_back_on_a_failed_commit(temp_project, monkeypatch):
    """If the destination commit fails partway, the move must restore the dest to its pre-move
    state (undo commit, remove written files, restore reading list) so a RETRY isn't blocked by
    the collision check and the dest isn't left half-populated."""
    _seed_source(temp_project)
    dest = _make_dest()
    dest_rl_before = (projects.project_path(dest) / "reading-list.md").read_text()

    # Fail the destination commit (the second _git commit call in the move for the dest).
    real_git = projects._git

    def flaky_git(pid, *args):
        if pid == dest and args[:1] == ("commit",):
            raise projects.ProjectError("boom: dest commit failed")
        return real_git(pid, *args)

    monkeypatch.setattr(projects, "_git", flaky_git)
    with pytest.raises(Exception):  # noqa: B017 — the injected failure propagates
        project_split.move_to_existing(temp_project, dest, ["awq"], remove_from_source=True)
    monkeypatch.setattr(projects, "_git", real_git)  # restore ONLY _git (not PROJECTS_ROOT)

    # Destination restored: reading list unchanged, no leftover corpus, retry now succeeds.
    assert (projects.project_path(dest) / "reading-list.md").read_text() == dest_rl_before
    tok = _bind(dest)
    try:
        assert {p.slug for p in store.list_papers()} == {"base"}
        assert store.corpus_path("awq").exists() is False
        # No phantom session left behind: the move imported awq's session index entry, which
        # the rollback must drop (else a re-add would look resumable with no transcript).
        assert sessions.get_state("awq") is None
    finally:
        config.reset_active_project(tok)
    # Source untouched (removal never ran), so a retry moves cleanly.
    assert {p.slug for p in store.list_papers()} == {"awq", "smooth", "core"}
    res = project_split.move_to_existing(temp_project, dest, ["awq"], remove_from_source=True)
    assert res["removed"] is True


def test_move_rolls_the_source_back_on_a_failed_source_commit(temp_project, monkeypatch):
    """If the SOURCE commit fails after removal, the source is fully restored from the captured
    bundle (files, notes, transcript, graph) — no data loss — and the dest is rolled back too."""
    _seed_source(temp_project)
    dest = _make_dest()
    real_git = projects._git

    def flaky_git(pid, *args):
        if pid == temp_project and args[:1] == ("commit",):  # fail the SOURCE commit
            raise projects.ProjectError("boom: source commit failed")
        return real_git(pid, *args)

    monkeypatch.setattr(projects, "_git", flaky_git)
    with pytest.raises(Exception):  # noqa: B017
        project_split.move_to_existing(temp_project, dest, ["awq"], remove_from_source=True)
    monkeypatch.setattr(projects, "_git", real_git)

    # Source fully restored from the bundle — the moved paper's entry, notes, and graph text
    # are all back (no data loss), even though the destination copy was rolled back.
    assert {p.slug for p in store.list_papers()} == {"awq", "smooth", "core"}
    assert "4-bit works" in store.read_notes("awq")
    assert graph_store.read_retrieved_text("awq") == "AWQ retrieved body"
    tok = _bind(dest)
    try:
        assert {p.slug for p in store.list_papers()} == {"base"}  # dest rolled back
        assert store.corpus_path("awq").exists() is False
    finally:
        config.reset_active_project(tok)


def test_source_data_survives_even_when_git_cleanup_fails(temp_project, monkeypatch):
    """The worst case (a read-only source `.git`): every source git WRITE fails, but the data
    restoration is pure filesystem and runs first, so the moved papers are never lost from
    both projects."""
    _seed_source(temp_project)
    dest = _make_dest()
    real_git = projects._git

    def flaky_git(pid, *args):
        # Source: reads (rev-parse, ls-files) work; every write-ish git op fails.
        if pid == temp_project and args[:1] in (("commit",), ("add",), ("reset",)):
            raise projects.ProjectError("read-only .git")
        return real_git(pid, *args)

    monkeypatch.setattr(projects, "_git", flaky_git)
    with pytest.raises(Exception):  # noqa: B017
        project_split.move_to_existing(temp_project, dest, ["awq"], remove_from_source=True)
    monkeypatch.setattr(projects, "_git", real_git)

    # Despite git failing throughout the source rollback, the paper's DATA is restored on disk.
    assert store.corpus_path("awq").exists()
    assert "4-bit works" in store.read_notes("awq")
    assert graph_store.read_retrieved_text("awq") == "AWQ retrieved body"
