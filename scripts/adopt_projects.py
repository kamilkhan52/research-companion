#!/usr/bin/env python3
"""Adopt this instance's existing projects and explicitly attribute legacy trash.

    RC_DATABASE_URL=... RC_ADOPT_OWNER=<uuid> python scripts/adopt_projects.py [--dry-run] \
        [--trash-owner <trash-directory>=<owner-uuid>]...

Every live project that predates ownership belongs to the explicit `RC_ADOPT_OWNER`. Legacy trash
is different: after multi-user ownership shipped, assigning every unattributed directory to that
one user could make account deletion remove somebody else's repository. Each ambiguous concrete
directory therefore needs an explicit `--trash-owner` mapping. A retired row whose owner was
preserved by the rolling-migration trigger is inferred only when exactly one matching directory
exists.

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


def _explicit_trash_owners(argv: list[str]) -> dict[str, str]:
    """Parse repeated `--trash-owner entry=uuid` arguments without guessing ownership."""
    values: list[str] = []
    args = iter(argv[1:])
    for arg in args:
        if arg == "--trash-owner":
            try:
                values.append(next(args))
            except StopIteration as e:
                raise ValueError("--trash-owner needs <trash-directory>=<owner-uuid>") from e
        elif arg.startswith("--trash-owner="):
            values.append(arg.removeprefix("--trash-owner="))

    result: dict[str, str] = {}
    for value in values:
        trash_name, separator, owner = value.rpartition("=")
        if not separator or not trash_name or not db.is_uuid(owner):
            raise ValueError(
                f"invalid trash owner mapping {value!r}; expected <trash-directory>=<owner-uuid>")
        projects.project_id_from_trash_name(trash_name)
        if trash_name in result and result[trash_name] != owner:
            raise ValueError(f"conflicting owners supplied for {trash_name!r}")
        result[trash_name] = owner
    return result


def _trash_assignments(
        entries: list[str], explicit: dict[str, str],
) -> tuple[dict[str, str], list[str]]:
    """Return safe explicit/transition-derived assignments and unresolved concrete entries."""
    unknown = sorted(set(explicit) - set(entries))
    if unknown:
        raise ValueError(f"trash entry does not exist: {unknown[0]!r}")

    existing = {name: tenancy.trash_owner_of(name) for name in entries}
    for name, supplied_owner in explicit.items():
        if existing[name] and existing[name] != supplied_owner:
            raise ValueError(f"{name!r} is already attributed to another owner")
    unattributed = [name for name in entries if existing[name] is None]
    by_pid: dict[str, list[str]] = {}
    for name in unattributed:
        by_pid.setdefault(projects.project_id_from_trash_name(name), []).append(name)

    assignments = {name: owner for name, owner in explicit.items() if name in unattributed}
    for pid, names in by_pid.items():
        transition_owner = tenancy.deleted_owner_of(pid)
        if len(names) == 1 and transition_owner:
            supplied = assignments.get(names[0])
            if supplied and supplied != transition_owner:
                raise ValueError(
                    f"{names[0]!r} conflicts with its preserved transition owner")
            assignments[names[0]] = transition_owner

    unresolved = sorted(set(unattributed) - set(assignments))
    return assignments, unresolved


def main(argv: list[str]) -> int:
    dry_run = "--dry-run" in argv[1:]
    try:
        explicit_trash = _explicit_trash_owners(argv)
    except (ValueError, projects.ProjectError) as e:
        print(f"refused: {e}", file=sys.stderr)
        return 2
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
    trashed = projects.trashed_project_entries()
    try:
        trash_assignments, unresolved = _trash_assignments(trashed, explicit_trash)
    except ValueError as e:
        print(f"refused: {e}", file=sys.stderr)
        return 2
    if dry_run:
        unowned = [pid for pid in pids if tenancy.owner_of(pid) is None]
        print(f"would adopt {len(unowned)} of {len(pids)} project(s) under {owner}")
        for pid in unowned:
            print(f"  + {pid}")
        print(f"would attribute {len(trash_assignments)} concrete trash entries")
        for trash_name, trash_owner in sorted(trash_assignments.items()):
            print(f"  + trash:{trash_name} -> {trash_owner}")
        for trash_name in unresolved:
            print(
                f"  ! trash:{trash_name} needs --trash-owner "
                f"'{trash_name}=<owner-uuid>'",
                file=sys.stderr,
            )
        return 1 if unresolved else 0

    try:
        result = tenancy.backfill(owner, pids)
        trash_results = []
        owners = sorted(set(trash_assignments.values()))
        for trash_owner in owners:
            names = [
                name for name, assigned_owner in trash_assignments.items()
                if assigned_owner == trash_owner
            ]
            trash_results.append(tenancy.backfill_trashed(trash_owner, names))
    except tenancy.TenancyError as e:
        print(f"refused: {e}", file=sys.stderr)
        return 1
    print(f"owner {result['owner']}: adopted {len(result['adopted'])}, "
          f"already owned {len(result['already_owned'])}")
    for pid in result["adopted"]:
        print(f"  + {pid}")
    conflicts = 0
    for trash_result in trash_results:
        conflicts += len(trash_result["attributed_elsewhere"])
        print(
            f"trash owner {trash_result['owner']}: "
            f"attributed {len(trash_result['adopted'])}, "
            f"already attributed {len(trash_result['already_attributed'])}, "
            f"conflicts {len(trash_result['attributed_elsewhere'])}")
        for trash_name in trash_result["adopted"]:
            print(f"  + trash:{trash_name}")
        for trash_name in trash_result["attributed_elsewhere"]:
            print(
                f"  ! trash:{trash_name} is attributed to another owner",
                file=sys.stderr,
            )
    for trash_name in unresolved:
        print(
            f"  ! trash:{trash_name} remains unattributed; rerun with --trash-owner "
            f"'{trash_name}=<owner-uuid>'",
            file=sys.stderr,
        )
    return 1 if conflicts or unresolved else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
