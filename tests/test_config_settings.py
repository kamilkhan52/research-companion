"""Settings persistence: the absent / explicit-empty / value distinction, and that a patch
only touches the keys it names (no clobbering unrelated keys)."""
from __future__ import annotations

import importlib

import pytest
from app import config, preview_jobs
from app.routers import settings as settings_routes


class _OperatorRequest:
    """Stand-in for the Request write_settings now takes. The operator gate reads
    request.state.user and short-circuits to allow in a dev environment, which the suite is — so
    these tests stay about settings behaviour. The gate itself is tested in
    tests/test_operator_gate.py."""

    class _State:
        user = None

    state = _State()




@pytest.fixture
def settings_file(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "SETTINGS_FILE", tmp_path / "settings.json")
    return tmp_path / "settings.json"


def test_saved_value_roundtrips(settings_file):
    config.save_settings({"narration_model": "anthropic/claude-haiku-4.5"})
    assert config.load_settings()["narration_model"] == "anthropic/claude-haiku-4.5"


def test_preview_model_roundtrips_independently(settings_file):
    config.save_settings({"narration_model": "narration/model", "preview_model": "preview/model"})
    merged = config.load_settings()
    assert merged["narration_model"] == "narration/model"
    assert merged["preview_model"] == "preview/model"


def test_settings_api_preserves_dynamic_preview_fallback_and_clears_override(
    settings_file, monkeypatch,
):
    monkeypatch.setitem(config._ENV_DEFAULTS, "preview_model", "")
    monkeypatch.setitem(config._ENV_DEFAULTS, "narration_model", "narration/default")
    assert settings_routes.read_settings(_OperatorRequest())["preview_model"] == ""

    first = settings_routes.write_settings(
        settings_routes.SettingsReq(narration_model="narration/one"), _OperatorRequest()
    )
    assert first["preview_model"] == ""
    assert preview_jobs.resolve_model(config.load_settings()) == "narration/one"

    explicit = settings_routes.write_settings(
        settings_routes.SettingsReq(preview_model="preview/explicit"), _OperatorRequest()
    )
    assert explicit["preview_model"] == "preview/explicit"

    cleared = settings_routes.write_settings(
        settings_routes.SettingsReq(preview_model=""), _OperatorRequest())
    assert cleared["preview_model"] == ""
    assert config.load_settings()["preview_model"] == ""

    settings_routes.write_settings(
        settings_routes.SettingsReq(narration_model="narration/two"), _OperatorRequest()
    )
    assert preview_jobs.resolve_model(config.load_settings()) == "narration/two"


def test_none_leaves_key_unchanged(settings_file):
    config.save_settings({"model": "openai/gpt-5"})
    config.save_settings({"model": None, "narration_model": "x"})  # model not touched
    merged = config.load_settings()
    assert merged["model"] == "openai/gpt-5"
    assert merged["narration_model"] == "x"


def test_empty_string_clears_override_reverting_to_env_default(settings_file, monkeypatch):
    monkeypatch.setitem(config._ENV_DEFAULTS, "model", "env/default-model")
    config.save_settings({"model": "openai/gpt-5"})
    assert config.load_settings()["model"] == "openai/gpt-5"
    config.save_settings({"model": ""})  # explicit unset
    assert config.load_settings()["model"] == "env/default-model"


def test_clearing_an_api_key_makes_has_key_false(settings_file, monkeypatch):
    monkeypatch.setitem(config._ENV_DEFAULTS, "openrouter_api_key", "")
    config.save_settings({"openrouter_api_key": "sk-secret"})
    assert config.has_api_key()
    config.save_settings({"openrouter_api_key": ""})
    assert not config.has_api_key()


def test_semantic_scholar_key_roundtrips_and_api_only_returns_a_hint(settings_file, monkeypatch):
    monkeypatch.setitem(config._ENV_DEFAULTS, "semantic_scholar_api_key", "")
    written = settings_routes.write_settings(
        settings_routes.SettingsReq(semantic_scholar_api_key="s2-private-value"),
        _OperatorRequest()
    )
    assert written["has_semantic_scholar_key"] is True
    assert config.load_settings()["semantic_scholar_api_key"] == "s2-private-value"

    public = settings_routes.read_settings(_OperatorRequest())
    assert public["has_semantic_scholar_key"] is True
    assert public["semantic_scholar_key_hint"] == "s2-pri…"
    assert "s2-private-value" not in public.values()


def test_patch_does_not_clobber_other_keys(settings_file):
    config.save_settings({"model": "m", "tts_voice": "alloy"})
    config.save_settings({"tts_voice": "verse"})  # only voice in this patch
    merged = config.load_settings()
    assert merged["model"] == "m"
    assert merged["tts_voice"] == "verse"


def test_prompt_overrides_survive_a_settings_save(settings_file):
    config.set_prompt_override("analysis_system", "custom prompt")
    config.save_settings({"model": "m"})  # writes the same file
    assert config.get_prompt_override("analysis_system") == "custom prompt"


def test_default_tts_model_is_the_cheaper_tts_1(monkeypatch):
    """The code's fallback must be `tts-1`, not `tts-1-hd` (H22, revised 2026-07-25).

    Audio is the largest variable cost in the app and `-hd` is exactly twice the price for the same
    accounting model, so the old default doubled the biggest line item. Pinned in a test because the
    difference is invisible in normal use — nothing fails, the bill just doubles.

    `load_dotenv` is stubbed out for the reload on purpose. A developer's `.env` may pin
    `RC_TTS_MODEL` (Kamil's does), and `config` calls `load_dotenv()` at import, so deleting the
    variable and reloading would simply read it straight back out of `.env` and assert against the
    developer's machine instead of against the code.
    """
    import dotenv

    monkeypatch.delenv("RC_TTS_MODEL", raising=False)
    # Patch the SOURCE module, not `config.load_dotenv`: reload re-executes
    # `from dotenv import load_dotenv`, which would rebind straight past a module-attribute stub.
    monkeypatch.setattr(dotenv, "load_dotenv", lambda *a, **k: False)
    try:
        importlib.reload(config)
        assert config._ENV_DEFAULTS["tts_model"] == "tts-1"
    finally:
        monkeypatch.undo()
        importlib.reload(config)


def test_default_models_are_deepseek_not_a_frontier_model(monkeypatch):
    """A caller who has expressed no preference — every tester, every future free-tier user — must
    land on DeepSeek.

    `20-pricing-analysis.md` prices both tiers as DeepSeek-only and measures a single
    `claude-opus-4.6` call at $0.44, so ~20 turns burns a month of Basic revenue. Nothing meters or
    caps a user yet, so the default IS the cost control. Like the tts-1 default above, the
    difference is invisible in normal use: nothing fails, the bill just multiplies.

    Same `load_dotenv` stubbing as that test, and for the same reason — Kamil's `.env` pins
    `RC_MODEL`, so without this the assertion would read his machine instead of the code.
    """
    import dotenv

    for var in ("RC_MODEL", "RC_NARRATION_MODEL"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(dotenv, "load_dotenv", lambda *a, **k: False)
    try:
        importlib.reload(config)
        assert config._ENV_DEFAULTS["model"] == "deepseek/deepseek-v4-pro"
        # Narration is Flash, not Pro: it only re-voices text the analysis turn already wrote, so
        # latency beats depth, and audio prep is the slowest thing a reader waits on.
        assert config._ENV_DEFAULTS["narration_model"] == "deepseek/deepseek-v4-flash"
        assert "anthropic/" not in config._ENV_DEFAULTS["model"]
        assert "anthropic/" not in config._ENV_DEFAULTS["narration_model"]
    finally:
        monkeypatch.undo()
        importlib.reload(config)


def test_clearing_a_stored_tts_model_falls_back_to_the_default(tmp_path, monkeypatch):
    """`tts-1-hd` stays selectable, so a deliberate choice must outrank the default — which is also
    why changing the default does NOT change an instance that already stored one. `""` is the way
    back: it clears the override so the instance follows the default from then on.

    Asserts against `_ENV_DEFAULTS` rather than the literal `"tts-1"`, so this tests the *precedence
    rule* and not whatever `RC_TTS_MODEL` happens to be on the machine running it.
    """
    monkeypatch.setattr(config, "SETTINGS_FILE", tmp_path / "settings.json")
    config.save_settings({"tts_model": "tts-1-hd"})
    assert config.load_settings()["tts_model"] == "tts-1-hd"

    config.save_settings({"tts_model": ""})
    assert config.load_settings()["tts_model"] == config._ENV_DEFAULTS["tts_model"]
