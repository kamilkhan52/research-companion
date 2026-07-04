"""Per-project usage/cost accounting (app/usage.py) and that llm.complete/stream feed it."""
import json

import httpx
from app import config, llm, usage

# ---- usage.record / load ----

def test_load_blank_when_absent(temp_project):
    data = usage.load()
    assert data["total"]["calls"] == 0
    assert data["by_model"] == {} and data["by_operation"] == {}


def test_record_accumulates_tokens_and_cost(temp_project):
    usage.record("analysis", "openai/gpt",
                 {"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150, "cost": 0.002})
    usage.record("analysis", "openai/gpt",
                 {"prompt_tokens": 10, "completion_tokens": 5, "cost": 0.0003})  # no total_tokens
    data = usage.load()
    assert data["total"]["calls"] == 2
    assert data["total"]["prompt_tokens"] == 110
    assert data["total"]["completion_tokens"] == 55
    assert data["total"]["total_tokens"] == 165  # 2nd call falls back to prompt+completion (15)
    assert abs(data["total"]["cost"] - 0.0023) < 1e-9
    assert data["first_at"] and data["updated_at"]


def test_record_breaks_down_by_model_and_operation(temp_project):
    usage.record("analysis", "m1", {"prompt_tokens": 10, "cost": 0.001})
    usage.record("graph_extraction", "m2", {"prompt_tokens": 20, "cost": 0.002})
    data = usage.load()
    assert set(data["by_model"]) == {"m1", "m2"}
    assert set(data["by_operation"]) == {"analysis", "graph_extraction"}
    assert data["by_model"]["m2"]["prompt_tokens"] == 20
    assert data["by_operation"]["graph_extraction"]["calls"] == 1


def test_record_tolerates_missing_cost(temp_project):
    usage.record("notes", "m", {"prompt_tokens": 5, "completion_tokens": 5, "total_tokens": 10})
    data = usage.load()
    assert data["total"]["total_tokens"] == 10
    assert data["total"]["cost"] == 0


def test_record_is_noop_without_active_project(tmp_path, monkeypatch):
    f = tmp_path / "usage.json"
    monkeypatch.setattr(usage, "_usage_file", lambda: f)
    monkeypatch.setattr(config, "active_project_id", lambda: None)
    usage.record("analysis", "m", {"prompt_tokens": 10, "cost": 0.5})
    assert not f.exists()  # nothing to attribute to -> nothing written


def test_load_survives_a_corrupt_file(temp_project):
    (config.state_dir() / "usage.json").write_text("{ not json", encoding="utf-8")
    assert usage.load()["total"]["calls"] == 0


# ---- llm.complete / stream feed usage ----

class _Resp:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload
        self.text = ""

    def json(self):
        return self._payload


def test_complete_records_usage(temp_project, monkeypatch):
    monkeypatch.setattr(config, "load_settings", lambda: {"openrouter_api_key": "k", "model": "m"})
    payload = {"choices": [{"message": {"content": "hi"}, "finish_reason": "stop"}],
               "usage": {"prompt_tokens": 7, "completion_tokens": 3, "total_tokens": 10, "cost": 0.01}}
    monkeypatch.setattr(httpx, "post", lambda *a, **k: _Resp(200, payload))
    llm.complete([{"role": "user", "content": "x"}], operation="analysis")
    data = usage.load()
    assert data["total"]["total_tokens"] == 10
    assert abs(data["total"]["cost"] - 0.01) < 1e-9
    assert data["by_operation"]["analysis"]["calls"] == 1


class _FakeStream:
    def __init__(self, lines):
        self._lines = lines

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    status_code = 200

    def iter_lines(self):
        yield from self._lines


def test_stream_records_usage_from_final_chunk(temp_project, monkeypatch):
    monkeypatch.setattr(config, "load_settings", lambda: {"openrouter_api_key": "k", "model": "m"})
    lines = [
        "data: " + json.dumps({"choices": [{"delta": {"content": "hello"}}]}),
        "data: " + json.dumps({"choices": [], "usage": {"prompt_tokens": 4, "completion_tokens": 2,
                                                        "total_tokens": 6, "cost": 0.003}}),
        "data: [DONE]",
    ]
    monkeypatch.setattr(httpx, "stream", lambda *a, **k: _FakeStream(lines))
    assert list(llm.stream([{"role": "user", "content": "x"}], operation="analysis")) == ["hello"]
    data = usage.load()
    assert data["total"]["total_tokens"] == 6
    assert abs(data["total"]["cost"] - 0.003) < 1e-9


def test_usage_endpoint_returns_aggregate(temp_project):
    from app import main
    usage.record("analysis", "m", {"prompt_tokens": 10, "cost": 0.001})
    out = main.get_usage(temp_project)
    assert out["total"]["calls"] == 1
    assert out["by_operation"]["analysis"]["prompt_tokens"] == 10
