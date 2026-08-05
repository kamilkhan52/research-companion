"""Per-project usage/cost accounting (app/usage.py): exact integer nano-USD accumulation,
presentation, reconcilable pending records for billed-but-unknown streams, the unattributed
ledger, and that llm.complete/stream feed it."""
import json

import httpx
import pytest
from app import config, llm, usage

# ---- usage.record / load ----

def test_load_blank_when_absent(temp_project):
    data = usage.load()
    assert data["total"]["calls"] == 0
    assert data["by_model"] == {} and data["by_operation"] == {}
    assert data["pending"] == [] and data["dropped_pending"] == 0


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
    assert data["total"]["cost_nanousd"] == 2_300_000  # 0.0023 USD, exact
    assert data["first_at"] and data["updated_at"]


def test_record_forwards_the_composite_scope_and_generation_to_event_ledger(
    temp_project, monkeypatch
):
    seen = []
    monkeypatch.setattr(usage.usage_events, "append_usage", lambda **event: seen.append(event))
    user_token = config.set_active_user("a3f0c8de-4b21-4d77-9f0e-2b6c5d1a7e44")
    try:
        usage.record(
            "analysis",
            "openai/gpt",
            {"prompt_tokens": 7, "completion_tokens": 3, "cost": 0.002},
            generation_id="gen-7",
        )
    finally:
        config.reset_active_user(user_token)

    assert len(seen) == 1
    assert seen[0]["user_id"] == "a3f0c8de-4b21-4d77-9f0e-2b6c5d1a7e44"
    assert seen[0]["project_id"] == temp_project
    assert seen[0]["generation_id"] == "gen-7"
    assert seen[0]["provider_usage"]["cost"] == 0.002


def test_pending_forwards_the_same_composite_scope_to_event_ledger(temp_project, monkeypatch):
    seen = []
    monkeypatch.setattr(usage.usage_events, "append_pending", lambda **event: seen.append(event))
    user_token = config.set_active_user("a3f0c8de-4b21-4d77-9f0e-2b6c5d1a7e44")
    try:
        usage.record_pending("analysis", "openai/gpt", "gen-pending")
    finally:
        config.reset_active_user(user_token)

    assert seen == [{
        "user_id": "a3f0c8de-4b21-4d77-9f0e-2b6c5d1a7e44",
        "project_id": temp_project,
        "operation": "analysis",
        "model": "openai/gpt",
        "generation_id": "gen-pending",
    }]


def test_event_ledger_failure_cannot_fail_or_suppress_the_project_aggregate(
    temp_project, monkeypatch
):
    def fail(**_event):
        raise RuntimeError("analytics unavailable")

    monkeypatch.setattr(usage.usage_events, "append_usage", fail)
    usage.record("analysis", "m", {"cost": 0.001})
    assert usage.load()["total"]["cost_nanousd"] == 1_000_000


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
    assert data["total"]["cost_nanousd"] == 0


def test_record_is_noop_without_active_project(tmp_path, monkeypatch):
    f = tmp_path / "usage.json"
    monkeypatch.setattr(usage, "_usage_file", lambda: f)
    monkeypatch.setattr(config, "active_project_id", lambda: None)
    usage.record("analysis", "m", {"prompt_tokens": 10, "cost": 0.5})
    assert not f.exists()  # nothing to attribute to -> nothing written


def test_load_survives_a_corrupt_file(temp_project):
    (config.state_dir() / "usage.json").write_text("{ not json", encoding="utf-8")
    assert usage.load()["total"]["calls"] == 0


# ---- exact cost accumulation (credits-ledger precision) ----

def test_sub_micro_costs_accumulate_exactly(temp_project):
    # 1,000 calls at 4e-7 USD each = 4e-4 USD. Rounding each float addition to 6 decimals would
    # record 0.0; integer nano-USD accumulation keeps it exact.
    for _ in range(1000):
        usage.record("analysis", "m", {"cost": 0.0000004})
    data = usage.load()
    assert data["total"]["cost_nanousd"] == 1000 * 400            # 400,000 nano-USD
    assert data["by_operation"]["analysis"]["cost_nanousd"] == 400_000
    assert data["by_model"]["m"]["cost_nanousd"] == 400_000
    assert abs(usage.summary()["total"]["cost_usd"] - 0.0004) < 1e-12  # presented as real USD, not 0


def test_mixed_costs_are_exact_across_buckets(temp_project):
    usage.record("analysis", "m1", {"cost": 0.0000004})   # 400 nano-USD
    usage.record("graph_extraction", "m2", {"cost": 1.5})  # 1.5e9 nano-USD
    data = usage.load()
    assert data["total"]["cost_nanousd"] == 400 + 1_500_000_000
    assert data["by_operation"]["graph_extraction"]["cost_nanousd"] == 1_500_000_000
    assert data["by_model"]["m1"]["cost_nanousd"] == 400


# ---- presentation + pending/reconcile ----

def test_summary_surfaces_cost_usd_and_not_estimated_when_complete(temp_project):
    usage.record("analysis", "m", {"cost": 0.01})
    s = usage.summary()
    assert abs(s["total"]["cost_usd"] - 0.01) < 1e-12
    assert s["by_operation"]["analysis"]["cost_usd"] == 0.01
    assert s["estimated"] is False and s["pending_count"] == 0
    assert "pending" not in s  # summary reduces the raw list to a count


def test_record_pending_flags_estimate(temp_project):
    usage.record("analysis", "m", {"cost": 0.01})
    usage.record_pending("analysis", "m", "gen-123")
    s = usage.summary()
    assert s["pending_count"] == 1
    assert s["estimated"] is True  # totals are estimates while a billed stream is unreconciled


def test_pending_records_are_bounded_and_evictions_are_tombstoned(temp_project, monkeypatch):
    monkeypatch.setattr(usage, "_PENDING_CAP", 5)
    for i in range(8):
        usage.record_pending("analysis", "m", f"gen-{i}")
    data = usage.load()
    assert len(data["pending"]) == 5                      # capped
    assert data["pending"][-1]["generation_id"] == "gen-7"  # newest kept
    assert data["dropped_pending"] == 3                   # oldest 3 tombstoned, not forgotten


def test_dropped_pending_keeps_estimated_true_even_after_reconciling_retained(temp_project, monkeypatch):
    monkeypatch.setattr(usage, "_PENDING_CAP", 5)
    for i in range(8):
        usage.record_pending("analysis", "m", f"gen-{i}")
    for p in list(usage.load()["pending"]):               # resolve every RETAINED record
        assert usage.reconcile(p["generation_id"], {"cost": 0.0}) is True
    s = usage.summary()
    assert s["pending_count"] == 0
    assert s["dropped_pending"] == 3
    assert s["estimated"] is True   # evicted billed generations can never round up to 'exact'
    usage.resolve_dropped()         # explicit administrative acknowledgement
    assert usage.summary()["estimated"] is False


def test_reconcile_clears_pending_and_folds_in_cost(temp_project):
    usage.record_pending("analysis", "gpt", "gen-xyz")
    ok = usage.reconcile("gen-xyz", {"prompt_tokens": 5, "completion_tokens": 3, "cost": 0.004})
    assert ok is True
    s = usage.summary()
    assert s["pending_count"] == 0 and s["estimated"] is False
    assert s["total"]["cost_nanousd"] == 4_000_000          # folded in
    assert s["by_operation"]["analysis"]["calls"] == 1      # attributed to the pending op/model
    assert s["by_model"]["gpt"]["calls"] == 1


def test_reconcile_unknown_generation_is_a_noop(temp_project):
    usage.record_pending("analysis", "m", "gen-1")
    assert usage.reconcile("does-not-exist", {"cost": 0.01}) is False
    assert usage.summary()["pending_count"] == 1


def test_reconcile_requires_authoritative_cost(temp_project):
    usage.record_pending("analysis", "m", "gen-1")
    # Non-authoritative cost values must NOT clear the pending as a zero-cost completed call —
    # not a missing key, and not a present-but-junk value (null/empty/bool/NaN/Inf/neg/string).
    for bad in [None, {}, {"prompt_tokens": 5}, {"cost": None}, {"cost": ""}, {"cost": "0.01"},
                {"cost": True}, {"cost": float("nan")}, {"cost": float("inf")}, {"cost": -0.5}]:
        assert usage.reconcile("gen-1", bad) is False
    s = usage.summary()
    assert s["pending_count"] == 1 and s["estimated"] is True   # untouched by every bad input
    # Genuine finite non-negative numbers ARE authoritative, including an explicit 0.
    assert usage.reconcile("gen-1", {"cost": 0}) is True
    assert usage.summary()["pending_count"] == 0


# ---- unattributed ledger (app-global) ----

def test_unattributed_ledger_is_app_global(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "APP_STATE_DIR", tmp_path)
    token = config.set_active_project(usage.UNATTRIBUTED)
    try:
        usage.record("narration", "m", {"cost": 0.02})
    finally:
        config.reset_active_project(token)
    assert (tmp_path / "usage-unattributed.json").exists()  # written to app-global, not a project
    s = usage.unattributed_summary()
    assert s["by_operation"]["narration"]["cost_nanousd"] == 20_000_000


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
    assert data["total"]["cost_nanousd"] == 10_000_000  # 0.01 USD
    assert data["by_operation"]["analysis"]["calls"] == 1


def test_complete_passes_provider_generation_id_to_usage(temp_project, monkeypatch):
    monkeypatch.setattr(config, "load_settings", lambda: {"openrouter_api_key": "k", "model": "m"})
    payload = {
        "id": "gen-complete",
        "choices": [{"message": {"content": "hi"}, "finish_reason": "stop"}],
        "usage": {"cost": 0.01},
    }
    monkeypatch.setattr(httpx, "post", lambda *a, **k: _Resp(200, payload))
    seen = []
    monkeypatch.setattr(
        usage,
        "record",
        lambda op, model, data, **kwargs: seen.append((op, model, data, kwargs)),
    )

    llm.complete([{"role": "user", "content": "x"}], operation="analysis")

    assert seen[0][3]["generation_id"] == "gen-complete"


class _FakeStream:
    def __init__(self, lines, raise_at_end=False, headers=None):
        self._lines = lines
        self._raise_at_end = raise_at_end
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    status_code = 200

    def iter_lines(self):
        yield from self._lines
        if self._raise_at_end:
            raise httpx.ReadError("connection dropped")


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
    assert data["total"]["cost_nanousd"] == 3_000_000  # 0.003 USD
    assert data["pending"] == []


def test_stream_clean_eof_without_usage_is_pending(temp_project, monkeypatch):
    # Emits content then a clean [DONE], but NO final usage chunk (proxy/provider truncation):
    # the content was billed, so it's pending — not a silent zero-cost completed call.
    monkeypatch.setattr(config, "load_settings", lambda: {"openrouter_api_key": "k", "model": "m"})
    lines = ["data: " + json.dumps({"id": "gen-eof", "choices": [{"delta": {"content": "hi"}}]}),
             "data: [DONE]"]
    monkeypatch.setattr(httpx, "stream", lambda *a, **k: _FakeStream(lines))
    assert list(llm.stream([{"role": "user", "content": "x"}], operation="analysis")) == ["hi"]
    data = usage.load()
    assert data["total"]["calls"] == 0                       # not costed as complete
    assert len(data["pending"]) == 1
    assert data["pending"][0]["generation_id"] == "gen-eof"  # captured for reconciliation
    assert usage.summary()["estimated"] is True


def test_stream_mid_drop_marks_pending_not_costed(temp_project, monkeypatch):
    monkeypatch.setattr(config, "load_settings", lambda: {"openrouter_api_key": "k", "model": "m"})
    monkeypatch.setattr(llm.time, "sleep", lambda *_: None)
    lines = ["data: " + json.dumps({"id": "gen-drop", "choices": [{"delta": {"content": "part"}}]})]
    monkeypatch.setattr(httpx, "stream", lambda *a, **k: _FakeStream(lines, raise_at_end=True))
    with pytest.raises(llm.LLMError):
        list(llm.stream([{"role": "user", "content": "x"}], operation="analysis"))
    data = usage.load()
    assert len(data["pending"]) == 1
    assert data["pending"][0]["generation_id"] == "gen-drop"
    assert data["total"]["cost_nanousd"] == 0
    assert usage.summary()["estimated"] is True


def test_stream_pre_token_billed_200_attempts_are_all_pending(temp_project, monkeypatch):
    # Two HTTP-200 attempts, each exposes a generation id then drops BEFORE any token/usage.
    # Both were billed (hidden reasoning), so both must be pending — not silently dropped.
    monkeypatch.setattr(config, "load_settings", lambda: {"openrouter_api_key": "k", "model": "m"})
    monkeypatch.setattr(llm.time, "sleep", lambda *_: None)
    state = {"n": 0}

    def fake_stream(*a, **k):
        state["n"] += 1
        return _FakeStream([], raise_at_end=True, headers={"x-generation-id": f"gen-{state['n']}"})

    monkeypatch.setattr(httpx, "stream", fake_stream)
    with pytest.raises(llm.LLMError):
        list(llm.stream([{"role": "user", "content": "x"}], operation="analysis", tries=2))
    data = usage.load()
    assert len(data["pending"]) == 2
    assert {p["generation_id"] for p in data["pending"]} == {"gen-1", "gen-2"}
    assert data["total"]["cost_nanousd"] == 0


def test_stream_empty_clean_eof_is_pending(temp_project, monkeypatch):
    # 200 that ends cleanly ([DONE]) with no content and no usage: still a billed generation.
    monkeypatch.setattr(config, "load_settings", lambda: {"openrouter_api_key": "k", "model": "m"})
    monkeypatch.setattr(httpx, "stream",
                        lambda *a, **k: _FakeStream(["data: [DONE]"], headers={"x-generation-id": "gen-empty"}))
    assert list(llm.stream([{"role": "user", "content": "x"}], operation="analysis")) == []
    data = usage.load()
    assert data["total"]["calls"] == 0
    assert len(data["pending"]) == 1 and data["pending"][0]["generation_id"] == "gen-empty"


def test_stream_failed_billed_attempt_then_successful_retry_records_both(temp_project, monkeypatch):
    monkeypatch.setattr(config, "load_settings", lambda: {"openrouter_api_key": "k", "model": "m"})
    monkeypatch.setattr(llm.time, "sleep", lambda *_: None)
    responses = [
        _FakeStream([], raise_at_end=True, headers={"x-generation-id": "gen-fail"}),  # pre-token drop
        _FakeStream(["data: " + json.dumps({"choices": [{"delta": {"content": "ok"}}]}),
                     "data: " + json.dumps({"choices": [], "usage": {"prompt_tokens": 3, "cost": 0.005}}),
                     "data: [DONE]"]),  # success with exact usage
    ]
    state = {"n": 0}

    def fake_stream(*a, **k):
        r = responses[min(state["n"], len(responses) - 1)]
        state["n"] += 1
        return r

    monkeypatch.setattr(httpx, "stream", fake_stream)
    assert list(llm.stream([{"role": "user", "content": "x"}], operation="analysis")) == ["ok"]
    data = usage.load()
    assert len(data["pending"]) == 1 and data["pending"][0]["generation_id"] == "gen-fail"  # 1st, billed
    assert data["total"]["cost_nanousd"] == 5_000_000       # 2nd, exact
    assert usage.summary()["estimated"] is True             # the failed generation is still unresolved


def test_usage_endpoint_returns_presentation_form(temp_project):
    from app.routers import usage as usage_routes
    usage.record("analysis", "m", {"prompt_tokens": 10, "cost": 0.001})
    out = usage_routes.get_usage(temp_project)
    assert out["total"]["calls"] == 1
    assert out["by_operation"]["analysis"]["prompt_tokens"] == 10
    assert abs(out["total"]["cost_usd"] - 0.001) < 1e-12
    assert out["estimated"] is False
