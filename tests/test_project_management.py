"""Project management (R7.5): the favorite flag, soft delete into .trash, and the registry's
dot-dir skip that keeps trashed projects invisible."""
import pytest
from app import config, jobs, projects
from app.routers import catalogue as catalogue_router


@pytest.fixture
def root(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "PROJECTS_ROOT", tmp_path)
    return tmp_path


@pytest.fixture
def favorite_catalogue():
    """Small offline catalogue with newer specialized decoys for family-filter coverage."""
    return [
        {"id": "x-ai/grok-4.3", "created": 100},
        {"id": "x-ai/grok-4.5", "created": 200},
        {"id": "x-ai/grok-build-0.1", "created": 300},
        {"id": "moonshotai/kimi-k2.6", "created": 100},
        {"id": "moonshotai/kimi-k3", "created": 200},
        {"id": "moonshotai/kimi-k2.7-code", "created": 300},
        {"id": "openai/gpt-5.6-sol", "created": 200},
        {"id": "openai/gpt-5.6-sol-pro", "created": 300},
        {"id": "openai/gpt-5.6-terra", "created": 200},
        {"id": "openai/gpt-5.6-terra-pro", "created": 300},
        {"id": "openai/gpt-5.6-luna", "created": 200},
        {"id": "openai/gpt-5.6-luna-pro", "created": 300},
        {"id": "qwen/qwen3.6-max-preview", "created": 100},
        {"id": "qwen/qwen3.7-max", "created": 200},
        {"id": "qwen/qwen3-max-thinking", "created": 300},
        {"id": "google/gemini-3.5-flash", "created": 100},
        {"id": "google/gemini-3.6-flash", "created": 200},
        {"id": "google/gemini-3.5-flash-lite", "created": 300},
        {"id": "google/gemini-3.1-flash-image", "created": 400},
        {"id": "google/gemini-3.1-pro-preview", "created": 200},
        {"id": "google/gemini-3.1-pro-preview-customtools", "created": 300},
    ]


def test_favorite_model_families_resolve_current_chat_variants(monkeypatch, favorite_catalogue):
    monkeypatch.setattr(catalogue_router.llm, "catalogue", lambda: favorite_catalogue)

    resolved = {model["label"]: model["id"]
                for model in catalogue_router.favorite_models()["models"]}

    assert resolved == {
        "GPT 5.6 Sol": "openai/gpt-5.6-sol",
        "GPT 5.6 Terra": "openai/gpt-5.6-terra",
        "GPT 5.6 Luna": "openai/gpt-5.6-luna",
        "Gemini Pro": "google/gemini-3.1-pro-preview",
        "Gemini Flash": "google/gemini-3.6-flash",
        "Grok": "x-ai/grok-4.5",
        "Qwen Max": "qwen/qwen3.7-max",
        "Kimi K3": "moonshotai/kimi-k3",
    }


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
    assert projects.trashed_project_ids() == [pid]
    # Soft delete: the moved dir keeps its contents (and git history), so it's recoverable.
    assert (trashed[0] / "reading-list.md").exists()
    assert (trashed[0] / ".git").is_dir()


def test_trash_enumeration_ignores_malformed_entries(root):
    trash = root / ".trash"
    (trash / "project-with-hyphens-20260728-010203").mkdir(parents=True)
    (trash / "missing-timestamp").mkdir()
    (trash / ".hidden-20260728-010203").mkdir()
    (trash / "not-a-directory-20260728-010203").write_text("x")

    assert projects.trashed_project_ids() == ["project-with-hyphens"]


def test_delete_forgets_terminal_jobs_before_project_id_can_be_reused(root):
    pid = projects.create_project("Reusable")["id"]
    reg = jobs.JobRegistry("retained-proposal")
    try:
        reg.put("working", jobs.Job(id="finished", status="done"), project_id=pid)

        projects.delete_project(pid)
        recreated = projects.create_project("Reusable")

        assert recreated["id"] == pid
        assert reg.latest_for("working", project_id=pid) is None
    finally:
        jobs._ALL_REGISTRIES.remove(reg)


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


def test_tombstoned_project_admits_no_new_jobs(root):
    """The deletion tombstone closes the sweep→move window: a job that tries to register while
    the pid is marked deleting is refused instead of racing the directory move."""
    pid = projects.create_project("Going")["id"]
    reg = jobs.JobRegistry("testkind2")
    try:
        config.mark_project_deleting(pid)
        with pytest.raises(RuntimeError, match="being modified"):
            reg.start_or_join(
                "k", lambda: jobs.Job(id="j2"), lambda job: None, project_id=pid
            )
        # Cache-hit paths use put() instead of a worker. They must share the tombstone gate:
        # otherwise one can register after deletion's purge and survive into a reused pid.
        with pytest.raises(RuntimeError, match="being modified"):
            reg.put("cached", jobs.Job(id="cached", status="done"), project_id=pid)
        assert reg.jobs == {}  # nothing registered
    finally:
        config.unmark_project_deleting(pid)
        jobs._ALL_REGISTRIES.remove(reg)
    # After the tombstone clears (delete failed / finished), admission works again.
    job = reg.start_or_join("k", lambda: jobs.Job(id="j3"), lambda j: None, project_id=pid)
    assert job.id == "j3"
