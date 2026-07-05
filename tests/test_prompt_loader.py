"""Vault path precedence and the live, last-valid prompt loader."""
from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor

import pytest
from app import config, prompts


@pytest.fixture
def prompt_environment(tmp_path, monkeypatch):
    prompt_dir = tmp_path / "vault" / "Prompts"
    state_dir = tmp_path / "state"
    monkeypatch.setattr(config, "PROMPTS_DIR", prompt_dir)
    monkeypatch.setattr(config, "APP_STATE_DIR", state_dir)
    monkeypatch.setattr(config, "SETTINGS_FILE", state_dir / "settings.json")
    prompts._reset_runtime_cache()
    yield prompt_dir
    prompts._reset_runtime_cache()


def _path(root, key: str):
    return root / prompts.REGISTRY_BY_KEY[key].relative_path


def test_data_path_precedence(tmp_path):
    defaults = config.resolve_data_paths({}, tmp_path)
    assert defaults.vault_root is None
    assert defaults.prompts_dir is None
    assert defaults.projects_root == (tmp_path / "projects").resolve()

    vault = tmp_path / "vault"
    from_vault = config.resolve_data_paths({"RC_VAULT_ROOT": str(vault)}, tmp_path)
    assert from_vault.vault_root == vault.resolve()
    assert from_vault.prompts_dir == (vault / "Prompts").resolve()
    assert from_vault.projects_root == (vault / "Projects").resolve()

    explicit_prompts = tmp_path / "custom-prompts"
    explicit_projects = tmp_path / "custom-projects"
    explicit = config.resolve_data_paths(
        {
            "RC_VAULT_ROOT": str(vault),
            "RC_PROMPTS_DIR": str(explicit_prompts),
            "RC_PROJECTS_ROOT": str(explicit_projects),
        },
        tmp_path,
    )
    assert explicit.prompts_dir == explicit_prompts.resolve()
    assert explicit.projects_root == explicit_projects.resolve()


def test_registry_has_stable_file_validation_metadata():
    keys = [spec.key for spec in prompts.REGISTRY]
    paths = [spec.relative_path for spec in prompts.REGISTRY]
    assert len(keys) == len(set(keys))
    assert len(paths) == len(set(paths))
    assert all(spec.relative_path.endswith(".md") for spec in prompts.REGISTRY)
    assert all(isinstance(spec.bundled_default, str) for spec in prompts.REGISTRY)
    assert prompts.REGISTRY_BY_KEY["opening_message"].required_placeholders == (
        "title",
        "full_text",
    )
    assert "###CANONICAL###" in prompts.REGISTRY_BY_KEY["analysis_system"].required_literals
    for spec in prompts.REGISTRY:
        prompts._validate(spec, spec.bundled_default)


def test_vault_then_legacy_then_default_precedence(prompt_environment):
    config.set_prompt_override("tts_instructions", "legacy override")
    assert prompts.get("tts_instructions") == "legacy override"

    path = _path(prompt_environment, "tts_instructions")
    path.parent.mkdir(parents=True)
    path.write_text("vault prompt", encoding="utf-8")
    assert prompts.get("tts_instructions") == "vault prompt"

    path.unlink()
    assert prompts.get("tts_instructions") == "legacy override"
    config.set_prompt_override("tts_instructions", None)
    assert prompts.get("tts_instructions") == prompts.DEFAULTS["tts_instructions"]


def test_valid_edit_is_loaded_on_next_access_without_restart(prompt_environment):
    path = _path(prompt_environment, "tts_instructions")
    path.parent.mkdir(parents=True)
    path.write_text("first version", encoding="utf-8")
    assert prompts.get("tts_instructions") == "first version"

    # Same length catches loaders that key only on file size.
    path.write_text("next version!", encoding="utf-8")
    assert prompts.get("tts_instructions") == "next version!"


def test_invalid_edit_uses_persisted_last_valid_and_reports_error(prompt_environment):
    path = _path(prompt_environment, "opening_message")
    path.parent.mkdir(parents=True)
    valid = "Read {title}\n\n{full_text}"
    path.write_text(valid, encoding="utf-8")
    assert prompts.get("opening_message") == valid

    cache_file = config.APP_STATE_DIR / "prompt-last-valid.json"
    assert json.loads(cache_file.read_text())["prompts"]["opening_message"]["value"] == valid

    # Simulate a backend restart, then make the on-disk edit invalid.
    prompts._reset_runtime_cache()
    path.write_text("Read {title}", encoding="utf-8")
    assert prompts.get("opening_message") == valid

    status = next(item for item in prompts.listing() if item["key"] == "opening_message")
    assert status["valid"] is False
    assert status["effective_source"] == "last_valid"
    assert str(path) in status["error"]
    assert "{full_text}" in status["error"]
    assert status["effective_hash"]


def test_invalid_first_edit_falls_back_to_legacy_override(prompt_environment):
    config.set_prompt_override("opening_message", "Legacy {title} {full_text}")
    path = _path(prompt_environment, "opening_message")
    path.parent.mkdir(parents=True)
    path.write_text("broken", encoding="utf-8")

    result = prompts.resolve("opening_message")
    assert result.value == "Legacy {title} {full_text}"
    assert result.effective_source == "legacy_override"
    assert result.valid is False


def test_corrupt_last_valid_cache_cannot_reach_model(prompt_environment):
    spec = prompts.REGISTRY_BY_KEY["opening_message"]
    path = _path(prompt_environment, "opening_message")
    path.parent.mkdir(parents=True)
    path.write_text("broken vault prompt", encoding="utf-8")
    cache = config.APP_STATE_DIR / "prompt-last-valid.json"
    cache.parent.mkdir(parents=True)
    cache.write_text(json.dumps({
        "prompts": {
            "opening_message": {
                "value": "corrupt cached prompt",
                "effective_hash": "not-the-real-hash",
            }
        }
    }))

    result = prompts.resolve("opening_message")
    assert result.value == spec.bundled_default
    assert result.effective_source == "bundled_default"
    assert result.valid is False


def test_concurrent_reads_share_one_coherent_value(prompt_environment):
    path = _path(prompt_environment, "tts_instructions")
    path.parent.mkdir(parents=True)
    path.write_text("concurrent prompt", encoding="utf-8")

    with ThreadPoolExecutor(max_workers=12) as pool:
        values = list(pool.map(lambda _: prompts.get("tts_instructions"), range(100)))
    assert values == ["concurrent prompt"] * 100
    persisted = json.loads((config.APP_STATE_DIR / "prompt-last-valid.json").read_text())
    assert persisted["prompts"]["tts_instructions"]["value"] == "concurrent prompt"


def test_vault_managed_prompt_cannot_be_silently_overridden(prompt_environment):
    with pytest.raises(prompts.PromptError, match="managed by file"):
        prompts.set_prompt("tts_instructions", "ignored override")
    with pytest.raises(prompts.PromptError, match="managed by file"):
        prompts.reset("tts_instructions")
