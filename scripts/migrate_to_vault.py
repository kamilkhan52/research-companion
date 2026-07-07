#!/usr/bin/env python3
"""Dry-run-first migration of projects and prompts into a dedicated Obsidian vault."""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_venv_py = os.path.join(HERE, ".venv", "bin", "python")
if os.path.exists(_venv_py) and os.path.realpath(sys.executable) != os.path.realpath(_venv_py):
    os.execv(_venv_py, [_venv_py, *sys.argv])
sys.path.insert(0, HERE)

from app import config  # noqa: E402
from app.vault_migration import (  # noqa: E402
    VaultMigrationError,
    migrate_to_vault,
    prompt_destination,
    seed_prompt_files,
)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--vault",
        type=Path,
        default=config.VAULT_ROOT,
        help="Dedicated Obsidian vault root (defaults to RC_VAULT_ROOT).",
    )
    parser.add_argument(
        "--source-projects",
        type=Path,
        default=config.PROJECTS_ROOT,
        help="Existing Projects root to copy (defaults to the current effective root).",
    )
    parser.add_argument(
        "--prompts-dir",
        type=Path,
        help="Prompt destination override (defaults to <vault>/Prompts).",
    )
    parser.add_argument(
        "--prompts-only",
        action="store_true",
        help="Seed only missing prompt files; safe when vault Projects already exist.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Perform the copy. Without this flag the command is read-only.",
    )
    return parser


def main() -> int:
    args = _parser().parse_args()
    if args.vault is None:
        print("error: --vault or RC_VAULT_ROOT is required", file=sys.stderr)
        return 2
    try:
        if args.prompts_only:
            destination = prompt_destination(args.vault, args.prompts_dir)
            prompt_result = seed_prompt_files(destination, apply=args.apply)
            mode = "APPLIED" if args.apply else "DRY RUN — no files changed"
            print(mode)
            print(f"Prompt directory: {prompt_result.destination_prompts}")
            print(f"Prompt files to seed: {len(prompt_result.prompt_files)}")
            if not args.apply:
                print("Run again with --prompts-only --apply after reviewing this path.")
            else:
                print("Existing prompt files were preserved. Restart is not required.")
            return 0
        result = migrate_to_vault(
            args.vault,
            source_projects=args.source_projects,
            prompts_dir=args.prompts_dir,
            apply=args.apply,
        )
    except VaultMigrationError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    mode = "APPLIED" if args.apply else "DRY RUN — no files changed"
    print(mode)
    print(f"Projects: {result.source_projects} -> {result.destination_projects}")
    print(f"Validated project repositories: {result.project_count}")
    print(f"Prompt directory: {result.destination_prompts}")
    print(f"Prompt files to seed: {len(result.prompt_files)}")
    if not args.apply:
        print("Run again with --apply after reviewing these paths.")
    else:
        print("Source projects were preserved. Set RC_VAULT_ROOT and restart the backend.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
