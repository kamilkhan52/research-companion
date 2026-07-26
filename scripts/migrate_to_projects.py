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

from app import config, db, projects, tenancy  # noqa: E402


def main() -> None:
    name = sys.argv[1] if len(sys.argv) > 1 else "Default Project"
    legacy = config.BASE_DIR / "project"
    if not legacy.exists():
        print("No ./project to migrate (already migrated). Current projects:")
        for p in projects.list_projects():
            print(f"  - {p['id']}  ({p['name']}, {p['read_count']}/{p['paper_count']})")
        return
    # Refuse before moving anything, not after. On an ownership-recording instance a migrated
    # project with no owner is reachable by nobody, so migrating without one would report success
    # and leave the legacy reading list invisible to its owner — with `./project` already gone.
    owner = tenancy.adopt_owner()
    if tenancy.enabled():
        if not owner:
            print("this instance records ownership, so migrating needs RC_ADOPT_OWNER=<uuid>. "
                  "Without one the migrated project would be invisible to everyone.",
                  file=sys.stderr)
            return
        if not db.is_uuid(owner):
            print(f"RC_ADOPT_OWNER must be a user id (uuid); got {owner!r}", file=sys.stderr)
            return

    pid = projects.adopt_existing(Path(legacy), name, move=True)
    if tenancy.enabled():
        try:
            tenancy.claim(pid, {"user_id": owner})
        except Exception as e:
            print(f"migrated to projects/{pid}, but recording the owner failed: {e}\n"
                  f"    the project is on disk and unreachable until an owner is recorded; "
                  f"run scripts/adopt_projects.py with RC_ADOPT_OWNER={owner}", file=sys.stderr)
            return
    print(f"Migrated ./project -> projects/{pid}   (name: {name})")
    print("Done. Restart the server; the project will appear in the switcher.")


if __name__ == "__main__":
    main()
