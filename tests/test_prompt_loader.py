"""Vault path precedence and the live, last-valid prompt loader."""
from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor

import pytest
from app import config, prompts
from app.routers import settings as settings_router
from fastapi import HTTPException


class _AnonRequest:
    """A request with no signed-in user — the single-tenant shape these tests exercise.

    The routes now take `Request` so they can scope results to the caller. With no database
    configured `tenancy` short-circuits before ever reading `state.user`, so this stub only has to
    exist, not carry an identity.
    """

    class state:  # noqa: N801 — mirrors Starlette's attribute, not a class in its own right
        user = None



class _FakeRequest:
    """Minimal stand-in for the Request these routes now take. The operator gate reads
    request.state.user; in a dev environment (which the suite is) it short-circuits to allow, so
    these prompt-behaviour tests stay about prompt behaviour. The gate itself is tested in
    tests/test_operator_gate.py."""

    class _State:
        user = None

    state = _State()




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
    assert prompts.REGISTRY_BY_KEY["listening_preview"].required_literals == (
        '"cue"',
        '"source_sentence_ids"',
    )
    for spec in prompts.REGISTRY:
        prompts._validate(spec, spec.bundled_default)


def test_default_research_prompts_are_self_contained_and_never_defer_visuals():
    analysis = prompts.DEFAULTS["analysis_system"]
    narration = prompts.DEFAULTS["narration_system"]
    shared = prompts.DEFAULTS["self_contained_research"]
    reading_method = prompts.REGISTRY_BY_KEY["reading_method"].bundled_default

    assert "may never separately read or open the paper" in analysis
    assert "Never turn a reference into a reminder" in narration
    assert "Never tell the researcher to inspect it\nlater" in shared
    for term in ("figure", "diagram", "table", "algorithm", "equation", "section"):
        assert term in shared
    assert "never defer the reader\nto inspect it later or invent unseen content" in reading_method


def test_shared_research_guidance_forbids_drawing_visuals_as_text_art():
    """A described figure is useful; a drawn one is not. Text art wraps into noise at a phone-width
    column and is spoken character by character in narration, so the rule belongs in the SHARED
    block rather than the analysis prompt: `test_analysis_and_narration_compose_self_contained_
    guidance` pins that both paths compose this text, so a reading-only rule would still reach the
    ear."""
    shared = prompts.DEFAULTS["self_contained_research"]

    assert "never try to draw them" in shared
    for banned in ("ASCII art", "box-drawing", "flowcharts"):
        assert banned in shared, banned


def test_default_analysis_prompts_expose_the_inline_figure_card_contract():
    analysis = prompts.DEFAULTS["analysis_system"]
    opening = prompts.DEFAULTS["opening_message"]

    assert "printed label exactly as `Figure N`" in analysis
    assert "do not embed paper figures with markdown image syntax" in analysis
    assert "Only a `Figure N` listed there as visible" in analysis
    assert "with no need for an availability announcement" in analysis
    assert "begin with a plain availability statement" in analysis
    assert "figures are not available for this paper" in analysis
    assert "one or two genuinely central figures" in opening
    assert "without calling attention to its unavailability" in opening
    assert "Do not force a figure" in opening


def test_reading_pass_follow_up_deepens_rather_than_corrects():
    """DR-163: after a reading pass the follow-up read "like self correction" — it opened with
    "The new evidence changes the earlier account" because the briefing told it to "revise" and
    "say exactly what changed". The first response is now kept to what the abstract supports, and
    the follow-up is framed as a detailed comparison that never audits its predecessor."""
    analysis = prompts.DEFAULTS["analysis_system"]
    briefing = prompts.DEFAULTS["briefing_instruction"]
    reader = prompts.DEFAULTS["paper_reader"]

    assert "Saying less and being right is the goal" in analysis
    assert "one short clause for the group" in analysis
    assert "revise your account" not in analysis

    assert "detailed comparative analysis" in briefing
    assert "not as an audit of your earlier response" in briefing
    assert "do not list what changed" in briefing
    for dropped in ("revise your", "say exactly what changed"):
        assert dropped not in briefing, dropped

    # The brief still checks the first response's claims: accuracy is why the pass exists.
    assert "the analyst must not repeat it" in reader
    assert "detailed comparison" in reader


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
    with pytest.raises(prompts.PromptManagedError, match="managed by file"):
        prompts.set_prompt("tts_instructions", "ignored override")
    with pytest.raises(prompts.PromptManagedError, match="managed by file"):
        prompts.reset("tts_instructions")


def test_prompt_inventory_reports_exact_live_status(prompt_environment):
    path = _path(prompt_environment, "graph_extraction")
    path.parent.mkdir(parents=True)
    path.write_text(prompts.DEFAULTS["graph_extraction"], encoding="utf-8")

    status = next(item for item in prompts.listing() if item["key"] == "graph_extraction")
    assert status["managed"] is True
    assert status["source"] == "vault"
    assert status["path"] == str(path)
    assert status["valid"] is True
    assert status["error"] is None
    assert status["modified_at"]
    assert len(status["effective_hash"]) == 64


def test_prompt_api_rejects_vault_managed_writes_with_conflict(prompt_environment):
    req = settings_router.PromptReq(key="tts_instructions", value="ignored override")
    with pytest.raises(HTTPException) as exc_info:
        settings_router.save_prompt(req, _FakeRequest())
    assert exc_info.value.status_code == 409
    assert str(_path(prompt_environment, "tts_instructions")) in exc_info.value.detail

    # The storage conflict takes precedence over content validation: every attempted API write
    # to an authoritative vault prompt has the same HTTP contract.
    with pytest.raises(HTTPException) as exc_info:
        settings_router.save_prompt(
            settings_router.PromptReq(key="opening_message", value=""), _FakeRequest())
    assert exc_info.value.status_code == 409

    with pytest.raises(HTTPException) as exc_info:
        settings_router.reset_prompt(
            settings_router.PromptReq(key="tts_instructions"), _FakeRequest())
    assert exc_info.value.status_code == 409


def test_project_prompt_api_is_read_only_and_never_writes_default_project(
    prompt_environment, tmp_path, monkeypatch,
):
    project_root = tmp_path / "projects"
    monkeypatch.setattr(config, "PROJECTS_ROOT", project_root)
    req = settings_router.PromptReq(key="reading_method", value="unsafe write")

    with pytest.raises(HTTPException) as exc_info:
        settings_router.save_prompt(req, _FakeRequest())
    assert exc_info.value.status_code == 409
    assert "managed by project file" in exc_info.value.detail
    assert not (project_root / config.DEFAULT_PROJECT_ID / "reading-method.md").exists()

    with pytest.raises(HTTPException) as exc_info:
        settings_router.reset_prompt(
            settings_router.PromptReq(key="reading_method"), _FakeRequest())
    assert exc_info.value.status_code == 409

    status = next(item for item in prompts.listing() if item["key"] == "reading_method")
    assert status["managed"] is True


def test_prompt_inventory_scopes_project_file_path(prompt_environment, tmp_path, monkeypatch):
    project_root = tmp_path / "projects"
    project = project_root / "three-d-dram"
    project.mkdir(parents=True)
    (project / "reading-method.md").write_text("project method")
    monkeypatch.setattr(config, "PROJECTS_ROOT", project_root)

    response = settings_router.get_prompts(_AnonRequest(), project="three-d-dram")
    status = next(item for item in response["prompts"] if item["key"] == "reading_method")
    assert status["path"] == str(project / "reading-method.md")
    assert status["value"] == "project method"
    assert config.active_project_id() is None
