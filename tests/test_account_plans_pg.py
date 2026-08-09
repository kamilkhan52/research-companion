"""Per-account plans, against a real database.

`plans.for_user` took a user id and ignored it until now, so the properties worth testing are the
ones that only appear once two accounts can differ: that one account's grant does not reach
another, that a read failure does not quietly change what someone is allowed, and that the memo
which keeps this off the hot path cannot serve the wrong account.
"""
from __future__ import annotations

import os
import uuid

import pytest
from app import account_plans, config, db, plans, spend_limits, tenancy

TEST_DB = os.environ.get("RC_TEST_DATABASE_URL", "").strip()
needs_pg = pytest.mark.skipif(not TEST_DB, reason="set RC_TEST_DATABASE_URL to run this")

ALICE = ""
BOB = ""


@pytest.fixture
def database(monkeypatch):
    global ALICE, BOB
    monkeypatch.setenv("RC_DATABASE_URL", TEST_DB)
    monkeypatch.delenv("RC_MONTHLY_CREDITS", raising=False)
    db.close()
    db.migrate()
    ALICE, BOB = str(uuid.uuid4()), str(uuid.uuid4())
    for uid in (ALICE, BOB):
        tenancy.ensure_user(uid, f"{uid}@example.com")
    account_plans.forget_cache()
    yield
    account_plans.forget_cache()
    db.close()


@needs_pg
def test_two_accounts_can_be_on_different_plans(database):
    """The whole point. Before this, `for_user` returned the deployment default for everybody."""
    account_plans.set_plan(ALICE, "basic", source="operator")
    account_plans.set_plan(BOB, "free", source="operator")

    assert plans.for_user(ALICE).name == "basic"
    account_plans.forget_cache()
    assert plans.for_user(BOB).name == "free"


@needs_pg
def test_an_account_with_no_grant_gets_the_deployment_default(database):
    """A single-tenant instance and the test suite must behave exactly as before per-account plans
    existed, which is what makes this safe to land ahead of any payment integration."""
    assert account_plans.load(ALICE) is None
    assert plans.for_user(ALICE).name == plans._configured_default()


@needs_pg
def test_a_grant_changes_the_enforced_ceiling_and_not_only_the_display(database):
    """A plan that the usage screen renders but admission ignores would be decoration. The limit
    admission itself computes must move with the grant."""
    token = config.set_active_user(ALICE)
    try:
        account_plans.set_plan(ALICE, "free", source="operator")
        free_limit = spend_limits.monthly_limit_nanousd()
        account_plans.set_plan(ALICE, "basic", source="operator")
        basic_limit = spend_limits.monthly_limit_nanousd()
    finally:
        config.reset_active_user(token)

    assert free_limit == 200 * spend_limits.NANOUSD_PER_CREDIT
    assert basic_limit == 2_500 * spend_limits.NANOUSD_PER_CREDIT


@needs_pg
def test_the_memo_never_answers_for_a_different_account(database):
    """The cache exists because this read sits inline in `spend_ceiling.hold`. A memo that keyed on
    nothing, or that outlived its context, would hand one reader another's allowance."""
    account_plans.set_plan(ALICE, "basic", source="operator")
    account_plans.set_plan(BOB, "free", source="operator")

    assert account_plans.load(ALICE) == "basic"
    # No `forget_cache()` here on purpose: asking for a different account must not return the
    # entry just cached for the first one.
    assert account_plans.load(BOB) == "free"


@needs_pg
def test_a_failed_read_leaves_the_account_on_the_deployment_default(database, monkeypatch):
    """Not the least generous plan, which is what this module's docstring originally called for.
    `quotas` fails closed on every store failure, so a plan read that fails cannot become an
    overspend path — while demoting a paying reader over a transient blip is the failure the
    roadmap ranks worst."""
    account_plans.set_plan(ALICE, "basic", source="operator")
    account_plans.forget_cache()

    def explode():
        raise RuntimeError("connection reset")

    monkeypatch.setattr(account_plans.db, "pool", explode)

    assert account_plans.load(ALICE) is None
    assert plans.for_user(ALICE).name == plans._configured_default()


@needs_pg
def test_an_unknown_plan_name_cannot_be_stored(database):
    """The webhook that will write this is an EXTERNAL caller, and a plan name decides an
    allowance, so a typo must not become a stored entitlement."""
    with pytest.raises(ValueError):
        account_plans.set_plan(ALICE, "enterprise", source="revenuecat")
    with pytest.raises(ValueError):
        account_plans.set_plan(ALICE, "basic", source="whoever")


@needs_pg
def test_clearing_a_grant_returns_the_account_to_the_default(database):
    account_plans.set_plan(ALICE, "free", source="operator")
    assert plans.for_user(ALICE).name == "free"

    account_plans.clear_plan(ALICE)

    assert plans.for_user(ALICE).name == plans._configured_default()


@needs_pg
def test_only_the_operator_can_grant_a_plan(database, monkeypatch):
    """A route that hands out allowances is the one place a missing gate is most expensive, and
    `is_operator` says yes in dev — so the check has to be asserted, not assumed."""
    from fastapi import HTTPException
    from app.routers import usage as usage_routes

    monkeypatch.setattr(usage_routes.auth, "is_operator", lambda _u: False)

    class _Req:
        state = type("S", (), {"user": {"user_id": BOB}})()

    with pytest.raises(HTTPException) as raised:
        usage_routes.set_account_plan(usage_routes.PlanGrant(user_id=ALICE, plan="basic"), _Req())
    assert raised.value.status_code == 403
    assert account_plans.load(ALICE) is None, "a refused grant must not have been written"


@needs_pg
def test_the_operator_route_grants_and_clears(database, monkeypatch):
    from app.routers import usage as usage_routes

    monkeypatch.setattr(usage_routes.auth, "is_operator", lambda _u: True)

    class _Req:
        state = type("S", (), {"user": {"user_id": ALICE}})()

    granted = usage_routes.set_account_plan(
        usage_routes.PlanGrant(user_id=ALICE, plan="basic"), _Req())
    assert granted["plan"] == "basic"

    cleared = usage_routes.set_account_plan(
        usage_routes.PlanGrant(user_id=ALICE, plan=None), _Req())
    assert cleared["plan"] == plans._configured_default()
