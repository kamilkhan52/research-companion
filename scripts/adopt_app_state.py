#!/usr/bin/env python3
"""Move a single-tenant instance's app-global caches under one user, so signing in keeps them.

**The problem this exists for.** Before M2, an instance had no users: the narration cache and every
synthesized mp3 lived in one flat `.app-state/` — `audio/` and `narration-cache.json`. Since M2
slice 5 those are per user, under `.app-state/users/<scope>/`, and the scope is derived from the
signed-in user id. So the first time an instance that has been running open-auth gains a signed-in
user, that user resolves to an empty directory: correct isolation, and a complete loss of the cache
in practice.

That is not a rounding error. On the dev instance it is 2.8 GB across ~1800 files, and the audit
priced the same volume of synthesis at roughly $67–72. Every re-listen of anything read before the
switch would pay for it again.

Run it once, on the machine holding the state, naming the user the existing state should belong to:

    python scripts/adopt_app_state.py <user-uuid>            # dry run, prints what would move
    python scripts/adopt_app_state.py <user-uuid> --apply

**Moves, does not copy.** These are content-addressed caches — a copy doubles 2.8 GB on a volume
that also holds the projects, for no benefit, and leaves two directories that will drift.

**Refuses rather than merges.** If the target already has audio, this instance has been used signed-
in already, and combining two caches by hand is how one ends up with a directory nobody can reason
about. Sort it out deliberately instead.

Deliberately NOT handled: the model/voice/prior-notes picks in `settings.json`. Those are per-user in
POSTGRES, not on disk, so moving them is a database write against a database this script has no
reason to hold credentials for — and the instance document keeps working as everyone's default
until the user overrides it, so the cost of leaving them is one visit to Settings. `scripts/
adopt_projects.py` is the equivalent for project ownership.
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, db  # noqa: E402


def _plan(scope: Path) -> list[tuple[Path, Path]]:
    """The (source, destination) pairs that exist and would move."""
    pairs = [
        (config.APP_STATE_DIR / "audio", scope / "audio"),
        (config.APP_STATE_DIR / "narration-cache.json", scope / "narration-cache.json"),
    ]
    return [(src, dst) for src, dst in pairs if src.exists()]


def _describe(path: Path) -> str:
    if path.is_dir():
        files = list(path.rglob("*"))
        size = sum(f.stat().st_size for f in files if f.is_file())
        return f"{len([f for f in files if f.is_file()])} files, {size / 1e9:.2f} GB"
    return f"{path.stat().st_size / 1e6:.1f} MB"


def main(argv: list[str]) -> int:
    args = [a for a in argv if not a.startswith("--")]
    apply = "--apply" in argv
    if len(args) != 1:
        print(__doc__)
        print("usage: adopt_app_state.py <user-uuid> [--apply]", file=sys.stderr)
        return 2

    user_id = args[0]
    if not db.is_uuid(user_id):
        # Checked here rather than trusted, for the same reason `_safe_pid` exists: this value
        # becomes a directory name, and the hash below would happily digest anything at all.
        print(f"not a valid user id: {user_id!r}", file=sys.stderr)
        return 2

    # Through the app's own function, never a reimplementation of the hash — a private copy of
    # that rule silently stops matching the day the real one changes, and the symptom would be an
    # empty cache again, which is exactly what this script exists to prevent.
    token = config.set_active_user(user_id)
    try:
        scope = config.user_scope_dir()
    finally:
        config.reset_active_user(token)
    assert scope is not None   # is_uuid passed, so a scope always resolves

    moves = _plan(scope)
    if not moves:
        print(f"nothing to move: {config.APP_STATE_DIR} has no flat audio or narration cache.")
        return 0

    for _src, dst in moves:
        if dst.exists():
            print(f"REFUSING: {dst} already exists ({_describe(dst)}).\n"
                  "This instance has already been used signed in. Merging two caches by hand is\n"
                  "not something this script should decide — move or remove one first.",
                  file=sys.stderr)
            return 1

    print(f"user {user_id} -> {scope}")
    for src, _dst in moves:
        print(f"  {src.name}: {_describe(src)}")
    if not apply:
        print("\ndry run. Re-run with --apply to move.")
        return 0

    scope.mkdir(parents=True, exist_ok=True)
    for src, dst in moves:
        # os.replace semantics within one filesystem: atomic, and no second copy of 2.8 GB. Both
        # paths are under APP_STATE_DIR, so a cross-device move is not a case worth handling.
        shutil.move(str(src), str(dst))
        print(f"moved {src.name}")
    print("\nDone. The flat paths are recreated empty on next use by whoever is NOT signed in.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
