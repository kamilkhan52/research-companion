"""Paid work that reached neither the ledger nor the ceiling.

Three paths recorded token counts with no cost, or nothing at all, while holding budget — so they
settled at exactly zero however much they really spent. The failure is silent by construction: a
job that charges nothing looks identical to a job that was cheap.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from app import usage


class _Usage(SimpleNamespace):
    """Stands in for Pydantic AI's RunUsage."""


def test_an_authoritative_cost_is_recorded_exactly(monkeypatch):
    """When the provider told us what it charged, use that and do not mark it estimated."""
    seen: list[dict] = []
    monkeypatch.setattr(usage, "record",
                        lambda op, model, data, **kw: seen.append({**data, **kw}))
    usage.record_agentic("lab_research", "m",
                         _Usage(input_tokens=100, output_tokens=50, details={"cost": 0.0042}))
    assert seen[0]["cost"] == 0.0042
    assert not seen[0].get("estimated"), "an authoritative figure is not an estimate"


def test_tokens_are_priced_from_the_catalogue_when_no_cost_is_returned(monkeypatch):
    """The case that was settling at zero. An estimate marked as one beats a silent free ride."""
    seen: list[dict] = []
    monkeypatch.setattr(usage, "record",
                        lambda op, model, data, **kw: seen.append({**data, **kw}))
    monkeypatch.setattr(usage, "record_pending", lambda *a, **k: None)
    monkeypatch.setattr(
        "app.llm.catalogue",
        lambda *a, **k: [{"id": "m", "pricing": {"prompt": "0.000001", "completion": "0.000002"}}],
    )
    usage.record_agentic("lab_research", "m",
                         _Usage(input_tokens=1_000, output_tokens=500, details={}))
    assert seen[0]["cost"] == pytest.approx(1_000 * 0.000001 + 500 * 0.000002)
    assert seen[0]["estimated"] is True, "a local calculation is not what the provider billed"


def test_an_unpriceable_model_records_a_gap_rather_than_a_made_up_number(monkeypatch):
    """A model with no published price gets no invented figure — an acknowledged gap is honest
    where a guess is not. The pending marker is what flags the total as incomplete."""
    seen: list[dict] = []
    pending: list = []
    monkeypatch.setattr(usage, "record",
                        lambda op, model, data, **kw: seen.append({**data, **kw}))
    monkeypatch.setattr(usage, "record_pending", lambda *a, **k: pending.append(a))
    monkeypatch.setattr("app.llm.catalogue", lambda *a, **k: [])
    usage.record_agentic("lab_research", "unknown-model",
                         _Usage(input_tokens=10, output_tokens=5, details={}))
    assert "cost" not in seen[0]
    assert pending, "an unpriced call must be flagged, not silently counted as free"


def test_pricing_never_raises_even_when_the_catalogue_is_unreachable(monkeypatch):
    """It is a network call behind a display-quality number. It must not be able to fail a paid
    turn that has already happened."""
    def boom(*a, **k):
        raise RuntimeError("openrouter unreachable")

    monkeypatch.setattr("app.llm.catalogue", boom)
    assert usage._priced_estimate("m", 10, 5) is None


def test_the_three_previously_silent_paths_now_record(monkeypatch):
    """Pin the call sites, not just the helper — the helper can be perfect while nothing calls it.

    `retrieval_agent`'s PDF hunt builds its own Pydantic AI agent and reached neither the ledger
    nor the ceiling; `lab_research` and the preview research call recorded tokens with no cost.
    """
    import ast
    import inspect

    from app import lab_research, preview_jobs, retrieval_agent

    for module in (lab_research, preview_jobs, retrieval_agent):
        tree = ast.parse(inspect.getsource(module))
        calls = [
            n for n in ast.walk(tree)
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
            and n.func.attr == "record_agentic"
        ]
        assert calls, f"{module.__name__} must price its agentic run rather than settle at zero"
