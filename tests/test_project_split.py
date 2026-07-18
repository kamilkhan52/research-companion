"""R8.1 — project splitting (phase 1, deterministic): the move/copy of papers and their work
between two projects, slug validation, the running-job guard, and cites hygiene. No LLM, no
network."""
from __future__ import annotations

import pytest
from app import config, graph_store, jobs, project_split, projects, sessions, store

from tests.conftest import add_paper


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
    # give awq a committed Notes block + a session + graph caches
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


def test_copy_leaves_source_intact_and_does_not_migrate_sessions(temp_project):
    _seed_source(temp_project)
    # give the copied paper a session so we can prove it does NOT travel on copy
    sessions.set_state("smooth", "in_discussion")
    res = project_split.split_project(temp_project, "Reading B", ["smooth", "awq"],
                                      remove_from_source=False)
    assert res["removed"] is False
    assert {p.slug for p in store.list_papers()} == {"awq", "smooth", "core"}  # source whole
    assert sessions.get_state("awq") == "in_discussion"  # source session untouched
    tok = _bind(res["new_pid"])
    try:
        assert {p.slug for p in store.list_papers()} == {"smooth", "awq"}
        # Copy semantics: the discussion stays in the source, so the copy has no session.
        assert sessions.get_state("awq") is None
        assert sessions.transcript_paths("awq")[0].exists() is False
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


# --- R9.13: move to an EXISTING project ------------------------------------------------------

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


def test_move_to_existing_appends_and_removes_from_source(temp_project):
    _seed_source(temp_project)
    dest = _make_dest()

    res = project_split.move_to_existing(temp_project, dest, ["awq", "smooth"],
                                         remove_from_source=True)
    assert res["new_pid"] == dest and res["moved"] == 2 and res["removed"] is True
    assert "awq" in res["departed_notes"]

    tok = _bind(dest)
    try:
        # Destination now has its original paper PLUS the moved ones and their work.
        assert {p.slug for p in store.list_papers()} == {"base", "awq", "smooth"}
        assert "4-bit works" in store.read_notes("awq")
        assert sessions.get_state("awq") == "in_discussion"
        assert graph_store.read_retrieved_text("awq") == "AWQ retrieved body"
    finally:
        config.reset_active_project(tok)

    # Source lost the moved papers, kept 'core', no dangling cite.
    assert {p.slug for p in store.list_papers()} == {"core"}


def test_move_to_existing_keeps_a_cite_to_a_destination_paper(temp_project):
    """awq cites 'smooth' (moving) and 'core' (staying). Moving awq+smooth into a dest that
    already contains a paper slugged 'core' should keep BOTH cites — the cross-ref to the
    destination's existing paper stays a live edge (the split would have dropped it)."""
    _seed_source(temp_project)
    dest = _make_dest(papers=(("core", "Core In Dest"),))

    project_split.move_to_existing(temp_project, dest, ["awq", "smooth"],
                                   remove_from_source=True)
    tok = _bind(dest)
    try:
        assert store.entry_details("awq")["cites"] == ["smooth", "core"]
    finally:
        config.reset_active_project(tok)


def test_move_to_existing_refuses_a_slug_collision(temp_project):
    _seed_source(temp_project)
    dest = _make_dest(papers=(("awq", "AWQ already here"),))
    with pytest.raises(project_split.SplitError, match="already have data"):
        project_split.move_to_existing(temp_project, dest, ["awq", "smooth"])
    # Nothing moved: the source still has all three.
    assert {p.slug for p in store.list_papers()} == {"awq", "smooth", "core"}


def test_move_to_existing_rejects_self_and_unknown_dest(temp_project):
    _seed_source(temp_project)
    with pytest.raises(project_split.SplitError, match="different project"):
        project_split.move_to_existing(temp_project, temp_project, ["awq"])
    with pytest.raises(project_split.SplitError, match="no longer exists"):
        project_split.move_to_existing(temp_project, "ghost-pid", ["awq"])


def test_move_to_existing_leaves_dest_repo_clean(temp_project):
    """The destination commit stages exactly the paths the move wrote (pathspec, not add -A),
    so no committed record file is left uncommitted afterward."""
    import subprocess

    _seed_source(temp_project)
    dest = _make_dest()
    project_split.move_to_existing(temp_project, dest, ["awq"], remove_from_source=True)

    status = subprocess.run(["git", "status", "--porcelain"],
                            cwd=str(projects.project_path(dest)),
                            capture_output=True, text=True).stdout.splitlines()
    dirty = [ln for ln in status if ".state/" not in ln]
    assert dirty == [], f"destination repo dirty after move: {dirty!r}"


def test_move_refuses_a_slug_with_retained_data_in_dest(temp_project):
    """The removal endpoint keeps a paper's corpus/transcript on disk after dropping its
    reading-list entry. A move of the same slug into that dest must be refused as a collision,
    or _write_new_project would overwrite the destination's retained notes/discussion."""
    _seed_source(temp_project)
    dest = _make_dest()
    # Simulate a paper previously removed from the dest: its reading-list entry is gone but its
    # corpus (with notes) and transcript remain on disk under the SAME slug we now move.
    tok = _bind(dest)
    try:
        store.write_full_text("awq", "Old AWQ", "retained body", {"slug": "awq"})
        store.append_notes_block("awq", "Old AWQ", "## Notes\n\nDESTINATION's own history.")
        jsonl, _ = sessions.transcript_paths("awq")
        jsonl.parent.mkdir(parents=True, exist_ok=True)
        jsonl.write_text('{"role":"user","text":"dest history"}\n')
    finally:
        config.reset_active_project(tok)

    with pytest.raises(project_split.SplitError, match="already have data"):
        project_split.move_to_existing(temp_project, dest, ["awq"])
    # The destination's retained history is untouched, and the source still has awq.
    tok = _bind(dest)
    try:
        assert "DESTINATION's own history" in store.read_notes("awq")
    finally:
        config.reset_active_project(tok)
    assert store.corpus_path("awq").exists()  # source (contextvar reset to source) intact


def test_add_and_remove_routes_refuse_while_a_reservation_is_held(temp_project):
    """Split/move rewrite the reading list + git index outside the job system; the synchronous
    add/remove routes must refuse while the busy reservation is held (P1 serialization)."""
    from app.routers.notes import AddPaperReq, add_paper
    from app.routers.projects_api import remove_paper
    from fastapi import HTTPException
    _seed_source(temp_project)
    config.mark_project_busy(temp_project)
    try:
        with pytest.raises(HTTPException) as add_exc:
            add_paper(temp_project, AddPaperReq(title="New Paper"))
        assert add_exc.value.status_code == 409
        with pytest.raises(HTTPException) as rm_exc:
            remove_paper(temp_project, "awq")
        assert rm_exc.value.status_code == 409
    finally:
        config.unmark_project_busy(temp_project)
    # Freed: the routes work again (awq still present, unremoved by the refused call).
    assert "awq" in {p.slug for p in store.list_papers()}


def test_move_rejects_a_traversal_slug_before_touching_the_destination(temp_project):
    """`slugs` is client-controlled; a non-entry value (incl. a traversal attempt) must be
    rejected before any corpus/transcript path is built from it."""
    _seed_source(temp_project)
    dest = _make_dest()
    with pytest.raises(project_split.SplitError, match="Not current papers"):
        project_split.move_to_existing(temp_project, dest, ["awq", "../../etc/passwd"])
    # Nothing moved — the source still has all three.
    assert {p.slug for p in store.list_papers()} == {"awq", "smooth", "core"}


def test_synchronous_retrieval_refuses_while_relocating(temp_project):
    """The /start and /start_stream retrieval writers must refuse while a split/move owns the
    project — they write corpus/identity outside the job system."""
    from app.routers.session import StartReq, start_paper
    from fastapi import HTTPException
    _seed_source(temp_project)
    config.mark_project_busy(temp_project)
    try:
        with pytest.raises(HTTPException) as exc:
            start_paper(StartReq(slug="awq"))
        assert exc.value.status_code == 409
    finally:
        config.unmark_project_busy(temp_project)


def test_move_route_refuses_when_the_destination_is_busy(temp_project):
    """The /move route reserves BOTH sides; if the destination is already reserved (a split/
    move touching it) the request 409s rather than interleaving two mutations."""
    from app.routers.projects_api import MoveReq, move_papers
    from fastapi import HTTPException
    _seed_source(temp_project)
    dest = _make_dest()
    config.mark_project_busy(dest)  # someone else is already modifying the destination
    try:
        with pytest.raises(HTTPException) as exc:
            move_papers(temp_project, MoveReq(dest_pid=dest, slugs=["awq"]))
        assert exc.value.status_code == 409
    finally:
        config.unmark_project_busy(dest)
    # The reservation is fully released — source not left marked busy by the failed call.
    assert config.project_is_busy(temp_project) is False


def test_copy_to_existing_leaves_source_whole_and_no_session_travels(temp_project):
    _seed_source(temp_project)
    dest = _make_dest()
    res = project_split.move_to_existing(temp_project, dest, ["awq"],
                                         remove_from_source=False)
    assert res["removed"] is False
    assert {p.slug for p in store.list_papers()} == {"awq", "smooth", "core"}  # source whole
    tok = _bind(dest)
    try:
        assert {p.slug for p in store.list_papers()} == {"base", "awq"}
        assert sessions.get_state("awq") is None  # discussion stays in the source on copy
    finally:
        config.reset_active_project(tok)
