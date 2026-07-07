"""Safe copy migration into a dedicated Obsidian vault.

Projects are staged and verified before the final rename, so the destination is never exposed as
partially copied. Source repositories are read-only throughout and are never removed.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from . import config, prompts
from .fileio import atomic_write_text


class VaultMigrationError(Exception):
    pass


@dataclass(frozen=True)
class VaultMigrationResult:
    applied: bool
    vault_root: Path
    source_projects: Path
    destination_projects: Path
    destination_prompts: Path
    project_count: int
    project_heads: dict[str, str]
    prompt_files: tuple[Path, ...]


@dataclass(frozen=True)
class PromptSeedResult:
    applied: bool
    destination_prompts: Path
    prompt_files: tuple[Path, ...]


def prompt_destination(vault_root: Path, override: Path | None = None) -> Path:
    """Effective prompt target: explicit argument, configured override, then vault default."""
    destination = override or config.PROMPTS_DIR or vault_root / "Prompts"
    return destination.expanduser().resolve()


def seed_prompt_files(destination_prompts: Path, *, apply: bool = False) -> PromptSeedResult:
    """Plan or seed missing global prompt files without touching projects or existing files."""
    destination = destination_prompts.expanduser().resolve()
    if destination.exists() and not destination.is_dir():
        raise VaultMigrationError(f"Prompt destination is not a directory: {destination}")

    global_specs = tuple(spec for spec in prompts.REGISTRY if spec.scope == "global")
    missing_specs = tuple(
        spec for spec in global_specs if not (destination / spec.relative_path).exists()
    )
    result = PromptSeedResult(
        applied=apply,
        destination_prompts=destination,
        prompt_files=tuple(destination / spec.relative_path for spec in missing_specs),
    )
    if not apply:
        return result

    # Resolve before writing so legacy overrides can be carried into the vault. When this is
    # already RC_PROMPTS_DIR, missing files correctly resolve to their fallback values.
    effective_prompts = {spec.key: prompts.get(spec.key) for spec in missing_specs}
    for spec in missing_specs:
        path = destination / spec.relative_path
        if path.exists():  # Never replace an edit created after the dry run.
            continue
        atomic_write_text(path, effective_prompts[spec.key])
    return result


def _project_dirs(root: Path) -> list[Path]:
    if not root.exists():
        raise VaultMigrationError(f"Project source does not exist: {root}")
    if not root.is_dir():
        raise VaultMigrationError(f"Project source is not a directory: {root}")
    return sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith("."))


def _git_head(repo: Path) -> str:
    if not (repo / ".git").is_dir():
        raise VaultMigrationError(f"Project is not a self-contained Git repository: {repo}")
    proc = subprocess.run(
        ["git", "rev-parse", "--verify", "HEAD"],
        cwd=repo,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        detail = proc.stderr.strip() or proc.stdout.strip() or "unknown git error"
        raise VaultMigrationError(f"Cannot read Git HEAD for {repo}: {detail}")
    return proc.stdout.strip()


def _heads(root: Path) -> dict[str, str]:
    return {project.name: _git_head(project) for project in _project_dirs(root)}


def _require_empty_destination(path: Path) -> None:
    if not path.exists():
        return
    if not path.is_dir():
        raise VaultMigrationError(f"Project destination is not a directory: {path}")
    if any(path.iterdir()):
        raise VaultMigrationError(f"Project destination must be empty: {path}")


def migrate_to_vault(vault_root: Path, *, source_projects: Path | None = None,
                     prompts_dir: Path | None = None, apply: bool = False) -> VaultMigrationResult:
    """Plan or apply a vault migration.

    Dry-run is the default. Apply copies whole project directories (including ``.git``), verifies
    counts and HEADs, atomically promotes the staged Projects directory, and seeds only missing
    global prompt files from their current effective values.
    """
    vault = vault_root.expanduser().resolve()
    source = (source_projects or config.PROJECTS_ROOT).expanduser().resolve()
    destination_projects = (vault / "Projects").resolve()
    destination_prompts = prompt_destination(vault, prompts_dir)

    if source == destination_projects:
        raise VaultMigrationError("Source and destination Projects directories are the same.")
    if vault == source or vault.is_relative_to(source):
        raise VaultMigrationError("Vault destination cannot be inside the source Projects root.")
    if destination_prompts == source or destination_prompts.is_relative_to(source):
        raise VaultMigrationError("Prompt destination cannot be inside the source Projects root.")
    if (destination_prompts == destination_projects
            or destination_prompts.is_relative_to(destination_projects)
            or destination_projects.is_relative_to(destination_prompts)):
        raise VaultMigrationError("Prompt and Projects destinations must be separate directories.")
    _require_empty_destination(destination_projects)

    source_heads = _heads(source)
    project_count = len(source_heads)
    prompt_plan = seed_prompt_files(destination_prompts)

    result = VaultMigrationResult(
        applied=apply,
        vault_root=vault,
        source_projects=source,
        destination_projects=destination_projects,
        destination_prompts=destination_prompts,
        project_count=project_count,
        project_heads=source_heads,
        prompt_files=prompt_plan.prompt_files,
    )
    if not apply:
        return result

    vault.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".Projects.migrate-", dir=vault))
    try:
        for project in _project_dirs(source):
            shutil.copytree(project, staging / project.name, symlinks=True)
        copied_heads = _heads(staging)
        if len(copied_heads) != project_count:
            raise VaultMigrationError(
                f"Project count changed during copy: expected {project_count}, got {len(copied_heads)}"
            )
        if copied_heads != source_heads:
            raise VaultMigrationError("Copied project Git HEADs do not match their sources.")

        # Re-check immediately before promotion in case another process populated the destination.
        _require_empty_destination(destination_projects)
        if destination_projects.exists():
            destination_projects.rmdir()
        os.replace(staging, destination_projects)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise

    seed_prompt_files(destination_prompts, apply=True)

    # Validate the final state once more after promotion and prompt seeding.
    final_heads = _heads(destination_projects)
    if len(final_heads) != project_count or final_heads != source_heads:
        raise VaultMigrationError("Final vault project validation failed after promotion.")
    return result
