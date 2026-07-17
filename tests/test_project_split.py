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
