"""Project management (R7.5): the favorite flag, soft delete into .trash, and the registry's
dot-dir skip that keeps trashed projects invisible."""
import pytest
from app import config, jobs, projects


@pytest.fixture
def root(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "PROJECTS_ROOT", tmp_path)
    return tmp_path


def test_favorite_sorts_first_and_round_trips(root):
    a = projects.create_project("Alpha")
    b = projects.create_project("Beta")
    projects.set_favorite(b["id"], True)

    listed = projects.list_projects()
    assert [p["id"] for p in listed] == [b["id"], a["id"]]  # favorite first
    assert listed[0]["favorite"] is True and listed[1]["favorite"] is False

    projects.set_favorite(b["id"], False)
    listed = projects.list_projects()
    assert [p["id"] for p in listed] == [a["id"], b["id"]]  # creation order again
    assert all(p["favorite"] is False for p in listed)


def test_delete_moves_to_trash_and_hides_from_registry(root):
    pid = projects.create_project("Doomed")["id"]
    projects.delete_project(pid)

    assert projects.exists(pid) is False
    assert projects.list_projects() == []
    trashed = list((root / ".trash").iterdir())
    assert len(trashed) == 1 and trashed[0].name.startswith(f"{pid}-")
    # Soft delete: the moved dir keeps its contents (and git history), so it's recoverable.
    assert (trashed[0] / "reading-list.md").exists()
    assert (trashed[0] / ".git").is_dir()


def test_delete_unknown_project_raises(root):
    with pytest.raises(projects.ProjectError):
        projects.delete_project("nope")


def test_delete_refuses_while_a_job_runs(root):
    """A live worker resolves paths from the pid — moving the dir under it would let the next
    write recreate a partial store. Deletion must refuse until the job finishes."""
    pid = projects.create_project("Busy")["id"]
    reg = jobs.JobRegistry("testkind")
    try:
        job = jobs.Job(id="j1")
        setattr(job, jobs._PID_ATTR, pid)
        reg.jobs["j1"] = job

        with pytest.raises(projects.ProjectError, match="testkind"):
            projects.delete_project(pid)
        assert projects.exists(pid) is True

        job.status = "done"  # finished jobs must not block deletion
        projects.delete_project(pid)
        assert projects.exists(pid) is False
    finally:
        jobs._ALL_REGISTRIES.remove(reg)
