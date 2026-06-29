#!/usr/bin/env python3
"""Migrate the legacy single-project ./project store into projects/<id>/ (preserving its git
history) so it becomes one project in the multi-project layout.

Usage:  scripts/migrate_to_projects.py ["Display Name"]

Safe to run anytime: if ./project is already gone (already migrated), it just lists projects.
Re-execs into the project venv so app imports resolve.
"""
import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_venv_py = os.path.join(HERE, ".venv", "bin", "python")
if os.path.exists(_venv_py) and os.path.realpath(sys.executable) != os.path.realpath(_venv_py):
    os.execv(_venv_py, [_venv_py, *sys.argv])
sys.path.insert(0, HERE)

from pathlib import Path  # noqa: E402

from app import config, projects  # noqa: E402


def main() -> None:
    name = sys.argv[1] if len(sys.argv) > 1 else "Default Project"
    legacy = config.BASE_DIR / "project"
    if not legacy.exists():
        print("No ./project to migrate (already migrated). Current projects:")
        for p in projects.list_projects():
            print(f"  - {p['id']}  ({p['name']}, {p['read_count']}/{p['paper_count']})")
        return
    pid = projects.adopt_existing(Path(legacy), name, move=True)
    print(f"Migrated ./project -> projects/{pid}   (name: {name})")
    print("Done. Restart the server; the project will appear in the switcher.")


if __name__ == "__main__":
    main()
