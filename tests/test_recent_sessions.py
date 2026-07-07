from __future__ import annotations

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from app import config, projects, sessions
from app.models import Turn


def test_session_index_updates_are_serialized_and_preserved(temp_project, monkeypatch):
    original_save = sessions._save_index_unlocked
    active = 0
    max_active = 0
    guard = threading.Lock()

    def slow_save(index):
        nonlocal active, max_active
        with guard:
            active += 1
            max_active = max(max_active, active)
        time.sleep(0.005)
        original_save(index)
        with guard:
            active -= 1

    monkeypatch.setattr(sessions, "_save_index_unlocked", slow_save)
    def start(number: int):
        token = config.set_active_project(temp_project)
        try:
            sessions.start_session(f"paper-{number}", f"Paper {number}")
        finally:
            config.reset_active_project(token)

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(start, range(12)))

    assert max_active == 1
    assert set(sessions.session_index()) == {f"paper-{number}" for number in range(12)}


def test_every_authored_turn_advances_session_activity(temp_project, monkeypatch):
    timestamps = iter([
        "2026-07-07T10:00:00+00:00",
        "2026-07-07T10:01:00+00:00",
        "2026-07-07T10:02:00+00:00",
    ])
    monkeypatch.setattr(sessions, "_now", lambda: next(timestamps))

    sessions.start_session("paper", "A Paper")
    sessions.record_user("paper", "Question")
    assert sessions.session_index()["paper"]["updated_at"] == "2026-07-07T10:01:00+00:00"

    sessions.record_assistant("paper", Turn(role="assistant", canonical="Answer"))
    assert sessions.session_index()["paper"]["updated_at"] == "2026-07-07T10:02:00+00:00"


def test_recent_sessions_are_cross_project_and_sorted(temp_project):
    first = projects.project_path(temp_project)
    (first / "project.json").write_text(json.dumps({"id": temp_project, "name": "First"}))
    sessions.start_session("older", "Older Paper")
    index = sessions.session_index()
    index["older"]["updated_at"] = "2026-07-07T10:00:00+00:00"
    sessions._save_index_unlocked(index)

    second_pid = "second-project"
    second = projects.project_path(second_pid)
    second.mkdir()
    (second / ".state").mkdir()
    (second / "sessions").mkdir()
    (second / "corpus").mkdir()
    (second / "reading-list.md").write_text("# Reading list\n")
    (second / "project.json").write_text(json.dumps({"id": second_pid, "name": "Second"}))
    token = config.set_active_project(second_pid)
    try:
        sessions.start_session("newer", "Newer Paper")
        index = sessions.session_index()
        index["newer"]["updated_at"] = "2026-07-07T11:00:00+00:00"
        sessions._save_index_unlocked(index)
    finally:
        config.reset_active_project(token)

    recent = projects.recent_sessions()
    assert [(item["project_id"], item["slug"]) for item in recent] == [
        (second_pid, "newer"),
        (temp_project, "older"),
    ]
    assert recent[0]["project_name"] == "Second"
