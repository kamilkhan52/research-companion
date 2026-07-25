"""Environment gating: a non-dev process must refuse to start in a permissive configuration.

The failure this guards against is *omission*, not misconfiguration. `auth.mode()` falls back to
`open` when no auth variable is set, and an unset `RC_ALLOWED_USERS` would mean "everyone" — so a
deploy that forgets one line silently produces the most permissive instance rather than an error.
Each test below therefore asserts a REFUSAL, and the negative cases assert that the guard does not
fire when it shouldn't (a guard that always raises would pass a naive test suite).
"""
from __future__ import annotations

import pytest
from app import auth, config


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    """Start every test from an unset environment so nothing leaks in from the developer's shell
    or from .env (which config loads at import)."""
    for var in ("RC_ENV", "RC_DEV", "RC_AUTH_TOKEN", "RC_ALLOWED_USERS"):
        monkeypatch.delenv(var, raising=False)
    # auth reads these at import; monkeypatch the module attributes so tests can shape mode().
    monkeypatch.setattr(auth, "SUPABASE_URL", "", raising=False)
    monkeypatch.setattr(auth, "LEGACY_TOKEN", "", raising=False)


def _supabase(monkeypatch):
    monkeypatch.setattr(auth, "SUPABASE_URL", "https://example.supabase.co", raising=False)


# ---- env_name / dev_mode ----

def test_env_defaults_to_dev(monkeypatch):
    assert config.env_name() == "dev"
    assert config.is_dev_env() is True


@pytest.mark.parametrize("value", ["prod", "staging", "PROD", "  prod  "])
def test_env_is_normalized(monkeypatch, value):
    monkeypatch.setenv("RC_ENV", value)
    assert config.env_name() == value.strip().lower()


def test_unrecognized_env_is_not_dev(monkeypatch):
    """A typo like RC_ENV=production must not fall back to dev — that would silently disable every
    production guard. It stays non-dev, and startup validation rejects it outright."""
    monkeypatch.setenv("RC_ENV", "production")
    assert config.is_dev_env() is False
    with pytest.raises(auth.ConfigurationError, match="not one of"):
        auth.assert_environment_safe(config.env_name())


def test_dev_mode_honored_in_dev(monkeypatch):
    monkeypatch.setenv("RC_DEV", "1")
    assert config.dev_mode() is True


@pytest.mark.parametrize("env", ["staging", "prod"])
def test_dev_mode_forced_off_outside_dev(monkeypatch, env):
    """Defence in depth: even if validation were bypassed, dev_mode() itself must not report True
    outside a dev environment."""
    monkeypatch.setenv("RC_ENV", env)
    monkeypatch.setenv("RC_DEV", "1")
    assert config.dev_mode() is False


# ---- startup refusals ----

def test_dev_allows_anything(monkeypatch):
    """The permissive combination is fine in dev — otherwise local work would be impossible."""
    monkeypatch.setenv("RC_DEV", "1")
    monkeypatch.setenv("RC_AUTH_TOKEN", "shared-secret")
    monkeypatch.setattr(auth, "LEGACY_TOKEN", "shared-secret", raising=False)
    auth.assert_environment_safe("dev")  # must not raise


@pytest.mark.parametrize("env", ["staging", "prod"])
def test_refuses_to_start_without_supabase(monkeypatch, env):
    """P0-12: with no auth variables set, mode() is 'open' and the whole API would be public."""
    monkeypatch.setenv("RC_ENV", env)
    monkeypatch.setenv("RC_ALLOWED_USERS", "u1")
    assert auth.mode() == "open"
    with pytest.raises(auth.ConfigurationError, match="requires Supabase auth"):
        auth.assert_environment_safe(env)


@pytest.mark.parametrize("env", ["staging", "prod"])
def test_refuses_legacy_shared_token(monkeypatch, env):
    monkeypatch.setenv("RC_ENV", env)
    monkeypatch.setenv("RC_ALLOWED_USERS", "u1")
    _supabase(monkeypatch)
    monkeypatch.setattr(auth, "LEGACY_TOKEN", "shared-secret", raising=False)
    with pytest.raises(auth.ConfigurationError, match="RC_AUTH_TOKEN"):
        auth.assert_environment_safe(env)


@pytest.mark.parametrize("env", ["staging", "prod"])
def test_refuses_dev_mode(monkeypatch, env):
    monkeypatch.setenv("RC_ENV", env)
    monkeypatch.setenv("RC_ALLOWED_USERS", "u1")
    monkeypatch.setenv("RC_DEV", "1")
    _supabase(monkeypatch)
    with pytest.raises(auth.ConfigurationError, match="RC_DEV"):
        auth.assert_environment_safe(env)


@pytest.mark.parametrize("env", ["staging", "prod"])
def test_refuses_empty_allowlist(monkeypatch, env):
    """Sign-up is self-service, so no allowlist means the first stranger to register gets the
    instance. This is the check that must not be relaxed before per-user ownership (M2)."""
    monkeypatch.setenv("RC_ENV", env)
    _supabase(monkeypatch)
    with pytest.raises(auth.ConfigurationError, match="RC_ALLOWED_USERS"):
        auth.assert_environment_safe(env)


@pytest.mark.parametrize("env", ["staging", "prod"])
def test_accepts_a_correct_configuration(monkeypatch, env):
    """The guard must pass on a properly configured deploy — otherwise the tests above prove
    nothing (a function that always raised would satisfy them)."""
    monkeypatch.setenv("RC_ENV", env)
    monkeypatch.setenv("RC_ALLOWED_USERS", "b8f19707-4b13-4cbb-834a-93cd6d06f489")
    _supabase(monkeypatch)
    auth.assert_environment_safe(env)  # must not raise


# ---- allowlist parsing + enforcement ----

def test_allowlist_parsing(monkeypatch):
    monkeypatch.setenv("RC_ALLOWED_USERS", " a , b ,, c ")
    assert auth.allowed_users() == frozenset({"a", "b", "c"})


def test_allowlist_empty_when_unset():
    assert auth.allowed_users() == frozenset()


def test_check_rejects_non_allowlisted_user(monkeypatch):
    """A valid token for the wrong person raises NotAllowlisted (403), NOT AuthError (401) — a 401
    would send the client back through login in a loop."""
    _supabase(monkeypatch)
    monkeypatch.setenv("RC_ALLOWED_USERS", "allowed-uuid")
    monkeypatch.setattr(auth, "verify", lambda _t: {"sub": "stranger-uuid", "email": "x@y.z"})
    with pytest.raises(auth.NotAllowlisted):
        auth.check("any-token")
    assert not issubclass(auth.NotAllowlisted, auth.AuthError)


def test_check_admits_allowlisted_user(monkeypatch):
    _supabase(monkeypatch)
    monkeypatch.setenv("RC_ALLOWED_USERS", "allowed-uuid,other-uuid")
    monkeypatch.setattr(auth, "verify", lambda _t: {"sub": "allowed-uuid", "email": "k@example.com"})
    user = auth.check("any-token")
    assert user["user_id"] == "allowed-uuid"
    assert user["email"] == "k@example.com"


def test_check_admits_anyone_when_no_allowlist(monkeypatch):
    """Dev behaviour: an unset allowlist means "any authenticated user". Non-dev environments
    cannot reach this state — assert_environment_safe refuses to start."""
    _supabase(monkeypatch)
    monkeypatch.setattr(auth, "verify", lambda _t: {"sub": "anyone", "email": "a@b.c"})
    assert auth.check("any-token")["user_id"] == "anyone"
