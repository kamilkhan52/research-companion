#!/usr/bin/env python3
"""Adopt this instance's existing and recoverably deleted projects under one owner.

    RC_DATABASE_URL=... RC_ADOPT_OWNER=<uuid> python scripts/adopt_projects.py [--dry-run]

Every project that exists today predates ownership, so somebody has to own it. That includes
repositories already under `.trash`: account deletion must be able to find them even though they
are not live projects. The owner is named explicitly with `RC_ADOPT_OWNER` rather than inferred —
"the first user in the table" would hand one person's reading to whoever happened to sign up first.

Idempotent: re-running adopts only what is new. Safe to run before the enforcement slice lands,
which is the point — ownership can be recorded and checked while every route still behaves exactly
as it does today.
"""
from __future__ import annotations

import sys
from pathlib import Path

for candidate in (Path(__file__).resolve().parent.parent, Path("/srv")):
    if (candidate / "app" / "projects.py").is_file():
        sys.path.insert(0, str(candidate))
        break

from app import db, projects, tenancy  # noqa: E402


def main(argv: list[str]) -> int:
    dry_run = "--dry-run" in argv[1:]
    owner = tenancy.adopt_owner()
    if not owner:
        print("set RC_ADOPT_OWNER to the user id that should own the existing projects",
              file=sys.stderr)
        return 2
    if not db.enabled():
        print("set RC_DATABASE_URL to the target database", file=sys.stderr)
        return 2

    try:
        db.assert_usable_url()
        applied = db.migrate()
    except db.DatabaseError as e:
        # `safe_target` deliberately: the URL is a Fly secret and must not reach a terminal or a
        # log, which is exactly where an error message goes.
        print(f"database not usable ({db.safe_target()}): {e}", file=sys.stderr)
        return 1
    if applied:
        print(f"applied migrations: {', '.join(applied)}")

    pids = [p["id"] for p in projects.list_projects()]
    trashed = projects.trashed_project_ids()
    if dry_run:
        unowned = [pid for pid in pids if tenancy.owner_of(pid) is None]
        print(f"would adopt {len(unowned)} of {len(pids)} project(s) under {owner}")
        for pid in unowned:
            print(f"  + {pid}")
        unattributed = [pid for pid in trashed if tenancy.deleted_owner_of(pid) is None]
        print(
            f"would attempt attribution for {len(unattributed)} of {len(trashed)} "
            f"trashed project(s) under {owner}; live-row conflicts are checked on apply")
        for pid in unattributed:
            print(f"  + trash:{pid}")
        return 0

    try:
        result = tenancy.backfill(owner, pids)
        trash_result = tenancy.backfill_trashed(owner, trashed)
    except tenancy.TenancyError as e:
        print(f"refused: {e}", file=sys.stderr)
        return 1
    print(f"owner {result['owner']}: adopted {len(result['adopted'])}, "
          f"already owned {len(result['already_owned'])}")
    for pid in result["adopted"]:
        print(f"  + {pid}")
    conflicts = len(trash_result["attributed_elsewhere"]) + len(
        trash_result["not_retired"])
    print(
        f"trash owner {trash_result['owner']}: attributed {len(trash_result['adopted'])}, "
        f"already attributed {len(trash_result['already_attributed'])}, "
        f"conflicts {conflicts}")
    for pid in trash_result["adopted"]:
        print(f"  + trash:{pid}")
    for pid in trash_result["attributed_elsewhere"]:
        print(f"  ! trash:{pid} is attributed to another owner", file=sys.stderr)
    for pid in trash_result["not_retired"]:
        print(f"  ! trash:{pid} conflicts with a live ownership row", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
