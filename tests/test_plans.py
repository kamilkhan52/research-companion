"""Named plans, and the surface that renders one.

The point of a plan existing before RevenueCat is that the quota UI and the entitlement work both
have something concrete to build against — and that M4's job becomes *choosing* a plan for an
account rather than inventing the concept under time pressure.
"""
from __future__ import annotations

import pytest
from app import plans, spend_limits


def test_the_default_plan_is_the_tester_one():
    """Deliberately not one of the real tiers: someone exercising the app should not spend the
    session fighting a ceiling, and a tester hitting a wall is a bug report about the wall."""
    assert plans._configured_default() == "tester"
    assert plans.for_user(None).name == "tester"


def test_the_real_tiers_match_the_measured_pricing_analysis():
    """These numbers are checkable against §1 of `20-pricing-analysis.md`; drifting them silently
    would decouple the product promise from the measured unit economics it rests on."""
    assert plans.PLANS["free"].monthly_credits == 200
    assert plans.PLANS["basic"].monthly_credits == 2_500


def test_audio_quality_is_not_a_plan_dimension():
    """DR-042 (Kamil, 2026-08-10): plans differ in allowance, never in audio quality — the
    credit ceiling bounds what any plan can spend on narration. The field must stay gone."""
    for plan in plans.PLANS.values():
        assert not hasattr(plan, "premium_audio")


def test_the_ceiling_comes_from_the_plan():
    expected = plans.PLANS["tester"].monthly_credits * spend_limits.NANOUSD_PER_CREDIT
    assert spend_limits.monthly_limit_nanousd() == expected


def test_an_operator_can_move_the_deployment_to_a_real_tier(monkeypatch):
    monkeypatch.setenv("RC_DEFAULT_PLAN", "free")
    assert plans.for_user(None).name == "free"
    assert spend_limits.monthly_limit_nanousd() == 200 * spend_limits.NANOUSD_PER_CREDIT


@pytest.mark.parametrize("bad", ["", "  ", "premium", "bassic", "tester-plus", "Free!"])
def test_an_unknown_plan_name_falls_back_rather_than_being_honoured(monkeypatch, bad):
    """A typo must not grant an allowance nobody chose — in either direction."""
    monkeypatch.setenv("RC_DEFAULT_PLAN", bad)
    assert plans.for_user(None).name == plans.DEFAULT_PLAN


@pytest.mark.parametrize("written", ["BASIC", " basic ", "Basic"])
def test_case_and_whitespace_are_normalised_rather_than_rejected(monkeypatch, written):
    """An operator typing `BASIC` means basic. Rejecting that would fall back to the TESTER
    allowance — quietly granting more than they asked for, which is the wrong direction to fail
    for a value whose whole job is to be a ceiling."""
    monkeypatch.setenv("RC_DEFAULT_PLAN", written)
    assert plans.for_user(None).name == "basic"


def test_every_plan_is_self_consistent():
    for name, plan in plans.PLANS.items():
        assert plan.name == name, "the key and the plan must agree"
        assert plan.monthly_credits > 0
        assert plan.summary.strip(), "a plan the reader cannot be told about is not a plan"


def test_the_explicit_override_still_wins_over_the_plan(monkeypatch):
    """The escape hatch stays, for a deployment that needs a number no plan expresses."""
    monkeypatch.setenv("RC_MONTHLY_CREDITS", "12345")
    assert spend_limits.monthly_limit_nanousd() == 12_345 * spend_limits.NANOUSD_PER_CREDIT

def test_the_plan_response_carries_no_audio_tier(temp_project):
    """The wire half of DR-042 — re-adding `premium_audio` to the response dict would leave the
    dataclass test green while the client regrew an audio row. Served without a database: the
    ledger falls back to zero usage, which is all this test needs."""
    from app.main import app
    from starlette.testclient import TestClient

    body = TestClient(app).get("/api/plan").json()
    assert "premium_audio" not in body["plan"]
    assert body["plan"]["summary"] == plans.PLANS[plans.DEFAULT_PLAN].summary


def test_speech_holds_scale_with_the_text():
    """DR-042's enforcement half: the flat speech hold ($0.60) exceeded the whole Free ceiling
    ($0.20), so every narration on Free was refused regardless of length — a de-facto quality
    tier. Sized from the text, a short piece admits on the smallest plan while a full-paper
    narration still cannot outrun the old bound."""
    from app import spend_limits

    free_ceiling = plans.PLANS["free"].monthly_credits * 1_000_000
    # A short summary (~5k chars) must fit inside an untouched Free month.
    assert spend_limits.speech_hold_nanousd(5_000) < free_ceiling
    # The mean full-paper narration (10,702 chars — pricing §2c) must NOT fit: ~160 credits of
    # TTS plus margin and the rewrite lease is more than the month, and the refusal sheet's
    # "won't fit your plan / use device voice" is the honest answer.
    assert spend_limits.speech_hold_nanousd(10_702) > free_ceiling
    # A pathological length clamps to the old flat bound rather than reserving beyond it.
    assert spend_limits.speech_hold_nanousd(10_000_000) == 600_000_000
    # No text information falls back to the flat bound — never to a free pass.
    assert spend_limits.speech_hold_nanousd(0) == 600_000_000


def test_audio_admission_holds_what_the_text_costs(temp_project, monkeypatch):
    """The hold reaching the registry is the sized one, not the flat table entry."""
    from app import audio_jobs, spend_limits

    seen = {}
    real = audio_jobs._registry.start_or_join

    def capture(*args, **kwargs):
        seen["hold"] = kwargs.get("hold_max_nanousd")
        return real(*args, **kwargs)

    monkeypatch.setattr(audio_jobs._registry, "start_or_join", capture)
    monkeypatch.setattr(audio_jobs, "_synthesize", lambda *a, **k: b"mp3", raising=False)
    text = "x" * 5_000
    try:
        audio_jobs.start_job(text)
    except Exception:
        pass  # synthesis internals are not under test; the admission kwargs are
    assert seen["hold"] == spend_limits.speech_hold_nanousd(5_000)

