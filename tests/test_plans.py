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


def test_free_excludes_premium_audio_because_audio_is_the_largest_variable_cost():
    assert plans.PLANS["free"].premium_audio is False
    assert plans.PLANS["basic"].premium_audio is True


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
