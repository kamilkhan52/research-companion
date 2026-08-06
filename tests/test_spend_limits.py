"""The monthly ceiling and the pessimistic per-operation holds.

These are product numbers, so the tests assert the PROPERTIES that must hold whatever the numbers
become — the peg, the fail-safe direction of a bad config, and that no operation's hold is so low
that the ceiling it guards can be overshot in one admission.
"""
from __future__ import annotations

import pytest
from app import spend_limits


def test_the_credit_peg_is_a_tenth_of_a_cent():
    """The whole tier design rests on this: 1 credit = $0.001 of variable cost."""
    assert spend_limits.NANOUSD_PER_CREDIT == 1_000_000


def test_the_default_ceiling_matches_the_pricing_analysis_basic_tier():
    # 2,500 credits = $2.50 of variable cost against $8.40 net revenue (pricing analysis §1).
    assert spend_limits.monthly_limit_nanousd() == 2_500 * 1_000_000


def test_the_ceiling_is_operator_configurable_in_credits(monkeypatch):
    monkeypatch.setenv("RC_MONTHLY_CREDITS", "200")  # the Free allowance
    assert spend_limits.monthly_limit_nanousd() == 200 * 1_000_000


@pytest.mark.parametrize("bad", ["", "  ", "lots", "-5", "0", "2.5"])
def test_a_bad_ceiling_falls_back_to_the_default_rather_than_unlimited(monkeypatch, bad):
    """The dangerous configuration is absence: a typo must never read as 'no ceiling'."""
    monkeypatch.setenv("RC_MONTHLY_CREDITS", bad)
    assert spend_limits.monthly_limit_nanousd() == (
        spend_limits.DEFAULT_MONTHLY_CREDITS * spend_limits.NANOUSD_PER_CREDIT
    )


def test_every_hold_is_positive_because_quotas_refuses_a_non_positive_maximum():
    # `quotas.reserve` validates with `_positive_nanousd`; a zero hold would raise at admission
    # rather than reserving nothing, turning a pricing typo into an outage.
    for operation, value in spend_limits._MAX_NANOUSD.items():
        assert value > 0, operation
    assert spend_limits._DEFAULT_MAX_NANOUSD > 0


def test_an_unknown_operation_gets_the_generous_default_not_zero():
    """A new ancillary call must not be admitted for free, nor refused for being unknown."""
    assert spend_limits.max_cost_nanousd("a-brand-new-operation") == (
        spend_limits._DEFAULT_MAX_NANOUSD
    )


def test_no_single_admission_can_consume_the_whole_default_ceiling():
    """A hold larger than the ceiling would refuse every request on a fresh account.

    The expensive operation is a graph build; even that must leave room, or a reader who has spent
    nothing this month still cannot start one.
    """
    ceiling = spend_limits.monthly_limit_nanousd()
    for operation, hold in spend_limits._MAX_NANOUSD.items():
        assert hold < ceiling, f"{operation} alone would exhaust the monthly ceiling"


def test_the_analysis_hold_exceeds_the_measured_turn_cost():
    """A reservation holds a MAXIMUM and settles down; too low silently breaches the ceiling.

    Pricing analysis §2e measures an all-in turn at $0.0262 on the recommended stack.
    """
    assert spend_limits.max_cost_nanousd("analysis") > 26_200


def test_the_soft_warning_fires_before_the_hard_ceiling():
    assert 0 < spend_limits.SOFT_WARNING_AT < 1


def test_ceilings_are_disabled_without_a_database_or_a_signed_in_user(monkeypatch):
    """Local dev and the test suite must keep working exactly as before."""
    from app import config, db

    monkeypatch.setattr(db, "enabled", lambda: False)
    assert not spend_limits.enabled()

    monkeypatch.setattr(db, "enabled", lambda: True)
    token = config.set_active_user(None)
    try:
        assert not spend_limits.enabled()
    finally:
        config.reset_active_user(token)

    token = config.set_active_user("11111111-1111-4111-8111-111111111111")
    try:
        assert spend_limits.enabled()
    finally:
        config.reset_active_user(token)
