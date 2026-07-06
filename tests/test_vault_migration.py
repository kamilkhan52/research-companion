"""Dry-run and apply behavior for the non-destructive Obsidian vault migration."""
from __future__ import annotations

import subprocess

import pytest
from app import config, prompts
from app.vault_migration import VaultMigrationError, migrate_to_vault, seed_prompt_files


def _git(repo, *args: str) -> str:
    proc = subprocess.run(
        [
            "git",
            "-c",
            "user.name=Vault Test",
            "-c",
            "user.email=vault@test",
            *args,
        ],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    )
    return proc.stdout.strip()


def _project(root, name: str, content: str):
    repo = root / name
    repo.mkdir(parents=True)
    (repo / "reading-list.md").write_text(content, encoding="utf-8")
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", f"initialize {name}")
    return repo


@pytest.fixture
def migration_environment(tmp_path, monkeypatch):
    source = tmp_path / "source-projects"
    source.mkdir()
    first = _project(source, "first", "first")
    second = _project(source, "second", "second")
    state = tmp_path / "state"
    monkeypatch.setattr(config, "PROMPTS_DIR", None)
    monkeypatch.setattr(config, "APP_STATE_DIR", state)
    monkeypatch.setattr(config, "SETTINGS_FILE", state / "settings.json")
    prompts._reset_runtime_cache()
    return source, first, second, tmp_path / "vault"


def test_dry_run_writes_nothing_and_reports_heads(migration_environment):
    source, first, second, vault = migration_environment
    result = migrate_to_vault(vault, source_projects=source)

    assert result.applied is False
    assert result.project_count == 2
    assert result.project_heads == {
        "first": _git(first, "rev-parse", "HEAD"),
        "second": _git(second, "rev-parse", "HEAD"),
    }
    assert len(result.prompt_files) == sum(spec.scope == "global" for spec in prompts.REGISTRY)
    assert not vault.exists()


def test_apply_copies_git_histories_seeds_prompts_and_preserves_source(migration_environment):
    source, first, second, vault = migration_environment
    config.set_prompt_override("tts_instructions", "custom spoken delivery")

    result = migrate_to_vault(vault, source_projects=source, apply=True)

    assert result.applied is True
    assert first.exists() and second.exists()
    for name, original in (("first", first), ("second", second)):
        copied = vault / "Projects" / name
        assert (copied / ".git").is_dir()
        assert _git(copied, "rev-parse", "HEAD") == _git(original, "rev-parse", "HEAD")
        assert (copied / "reading-list.md").read_text() == (original / "reading-list.md").read_text()

    tts_path = vault / "Prompts" / prompts.REGISTRY_BY_KEY["tts_instructions"].relative_path
    assert tts_path.read_text() == "custom spoken delivery"
    analysis_path = vault / "Prompts" / prompts.REGISTRY_BY_KEY["analysis_system"].relative_path
    assert analysis_path.read_text() == prompts.DEFAULTS["analysis_system"]


def test_existing_prompt_file_is_never_overwritten(migration_environment):
    source, _, _, vault = migration_environment
    path = vault / "Prompts" / prompts.REGISTRY_BY_KEY["tts_instructions"].relative_path
    path.parent.mkdir(parents=True)
    path.write_text("hand edited", encoding="utf-8")

    migrate_to_vault(vault, source_projects=source, apply=True)
    assert path.read_text() == "hand edited"


def test_prompt_only_reseed_works_with_existing_projects_and_preserves_edits(
    migration_environment,
):
    _, _, _, vault = migration_environment
    projects = vault / "Projects"
    projects.mkdir(parents=True)
    (projects / "existing-project.txt").write_text("untouched")
    prompt_root = vault / "Prompts"
    existing = prompt_root / prompts.REGISTRY_BY_KEY["analysis_system"].relative_path
    existing.parent.mkdir(parents=True)
    existing.write_text("hand edited")

    planned = seed_prompt_files(prompt_root)
    assert planned.applied is False
    assert existing not in planned.prompt_files

    applied = seed_prompt_files(prompt_root, apply=True)
    assert applied.applied is True
    assert existing.read_text() == "hand edited"
    graph = prompt_root / prompts.REGISTRY_BY_KEY["graph_extraction"].relative_path
    assert graph.read_text() == prompts.REGISTRY_BY_KEY["graph_extraction"].bundled_default
    assert (projects / "existing-project.txt").read_text() == "untouched"


def test_nonempty_projects_destination_is_refused(migration_environment):
    source, first, second, vault = migration_environment
    destination = vault / "Projects"
    destination.mkdir(parents=True)
    (destination / "do-not-touch.txt").write_text("existing")

    with pytest.raises(VaultMigrationError, match="must be empty"):
        migrate_to_vault(vault, source_projects=source, apply=True)
    assert (destination / "do-not-touch.txt").read_text() == "existing"
    assert first.exists() and second.exists()


def test_missing_source_and_unsafe_destination_layouts_are_refused(migration_environment):
    source, first, second, vault = migration_environment
    with pytest.raises(VaultMigrationError, match="does not exist"):
        migrate_to_vault(vault, source_projects=source / "missing")
    with pytest.raises(VaultMigrationError, match="inside the source"):
        migrate_to_vault(source / "vault", source_projects=source)
    with pytest.raises(VaultMigrationError, match="separate directories"):
        migrate_to_vault(vault, source_projects=source, prompts_dir=vault / "Projects")
    assert first.exists() and second.exists()
