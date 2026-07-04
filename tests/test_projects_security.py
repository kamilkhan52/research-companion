"""projects.project_path/exists is the trust boundary that turns an untrusted project id into a
filesystem path (route pid via use_project; the audio billing `project`). It must never let a
crafted id escape PROJECTS_ROOT."""
import pytest
from app import config, projects


@pytest.fixture
def root(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "PROJECTS_ROOT", tmp_path)
    return tmp_path


BAD_IDS = ["..", "../etc", "../../etc/passwd", "/tmp", "/etc/passwd", "a/b", "foo/../..",
           ".", "", "  ", "a/../b", "projects/..", "x\\y", "-leading-dash-ok?no space"]


@pytest.mark.parametrize("bad", BAD_IDS)
def test_project_path_rejects_traversal_and_absolute(root, bad):
    with pytest.raises(projects.ProjectError):
        projects.project_path(bad)
    assert projects.exists(bad) is False  # exists() swallows the error into a clean False


@pytest.mark.parametrize("ok", ["proj-a", "llm-inference-serving", "3d-integrated-dram",
                                "default", "a_b-2", "Test-Project"])
def test_project_path_accepts_valid_ids(root, ok):
    p = projects.project_path(ok)
    assert p == root / ok
    assert p.resolve().parent == root.resolve()  # stays directly under the root


def test_absolute_id_does_not_escape_via_exists(root, tmp_path):
    # A real dir outside the root must not be reachable by passing its absolute path as the id.
    outside = tmp_path.parent / "outside-root"
    outside.mkdir(exist_ok=True)
    assert projects.exists(str(outside)) is False
