"""Settings persistence: the absent / explicit-empty / value distinction, and that a patch
only touches the keys it names (no clobbering unrelated keys)."""
from __future__ import annotations

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
