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

Stop the server first. This has no way to lock out a signed-in process that is writing the very
directories it is moving.

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

import os
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
    # `lexists`, not `exists`: the latter FOLLOWS symlinks, so a cache symlinked onto a disk that
    # is not currently mounted looks absent, drops out of the plan, and never reaches the symlink
    # refusal below — the script would then report "nothing to move" while leaving the real cache
    # unmigrated and invisible after sign-in. A link that is present but dangling is precisely the
    # case the operator most needs told about.
    return [(src, dst) for src, dst in pairs if os.path.lexists(src)]


def _describe(path: Path) -> str:
    """A size, or what is wrong with the path. Never raises.

    Called from the refusal messages, so it runs on exactly the paths that are in a bad state — a
    dangling symlink among them, which `stat()` raises on. A reporter that throws while explaining
    a refusal replaces the explanation with a traceback.
    """
    try:
        if path.is_symlink() and not path.exists():
            return f"broken symlink -> {os.readlink(path)}"
        if path.is_dir():
            files = [f for f in path.rglob("*") if f.is_file()]
            return f"{len(files)} files, {sum(f.stat().st_size for f in files) / 1e9:.2f} GB"
        return f"{path.stat().st_size / 1e6:.1f} MB"
    except OSError as e:
        return f"unreadable ({e.strerror})"


def _partial(done: list[str]) -> int:
    """Report what already moved before giving up. A half-finished migration is recoverable only if
    the operator knows which half it was; silence turns it into a hunt."""
    if done:
        print(f"NOTE: {', '.join(done)} already moved and are NOT rolled back. Re-running after\n"
              "resolving the conflict will move only what is left.", file=sys.stderr)
    return 1


def main(argv: list[str]) -> int:
    args = [a for a in argv if not a.startswith("--")]
    apply = "--apply" in argv
    if len(args) != 1:
        print(__doc__)
        print("usage: adopt_app_state.py <user-uuid> [--apply]", file=sys.stderr)
        return 2

    # Lower-cased before anything else: `is_uuid` accepts either case, and the scope hash would
    # then differ from the one the running app derives from Supabase's lowercase `sub` — the script
    # would report success and the user would open an empty cache, which is the precise failure it
    # exists to prevent. `config.user_scope_key` folds case too; both, so neither is load-bearing.
    user_id = args[0].lower()
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

    for src, _dst in _plan(scope):
        # Anything BELOW the source too, not just the source itself. The app writes this cache
        # with `atomic_write_bytes` and never creates a link inside it, so this is hardening
        # against a hand-made one rather than a case the app can produce — but a relative link
        # moved several directories deeper re-points exactly the same way, and refusing costs one
        # walk of a directory this script is about to read anyway.
        nested = next((c for c in src.rglob("*") if c.is_symlink()), None) if src.is_dir() else None
        if nested is not None:
            print(f"REFUSING: {nested} is a symlink inside {src.name}. Moving the directory would\n"
                  "re-point it. Replace it with a real file first.", file=sys.stderr)
            return 1
        if src.is_symlink():
            # Moving a relative symlink several directories deeper re-points it: the target
            # resolves somewhere else, or nowhere. A 2.8 GB cache is exactly the thing someone
            # symlinks onto another disk, so this is a real shape, and rewriting the link
            # correctly is not something to guess at on someone else's filesystem.
            print(f"REFUSING: {src} is a symlink. Move what it points at, or replace it with a\n"
                  "real directory first — relocating the link itself would re-point it.",
                  file=sys.stderr)
            return 1

    moves = _plan(scope)
    if not moves:
        print(f"nothing to move: {config.APP_STATE_DIR} has no flat audio or narration cache.")
        return 0

    for _src, dst in moves:
        # `lexists` on this side too — the source check learned this one round earlier and these
        # did not, which is how a fix closes an instance instead of a class. A DESTINATION that is
        # a dangling symlink reads as absent to `exists()`, and `os.rename` would then replace the
        # link itself, orphaning whatever the signed-in user had pointed it at.
        if os.path.lexists(dst):
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
    done: list[str] = []
    for src, dst in moves:
        # `os.rename`, NOT `shutil.move`. `shutil.move` into an existing directory NESTS the source
        # inside it — `audio/audio` — and reports success, which is the worst available outcome
        # here: the migration says it worked and the cache is invisible. `os.rename` refuses
        # (ENOTEMPTY) instead. It is also atomic within one filesystem, and both paths are under
        # APP_STATE_DIR, so a cross-device move is not a case worth handling.
        #
        # The existence check above is not a lock: a signed-in app running RIGHT NOW could create
        # the destination in between. Re-checked here to shrink the window, and the usage text says
        # to stop the server — for a one-time manual migration that is the honest instruction
        # rather than a lock this script has no way to hold.
        if os.path.lexists(dst):
            print(f"REFUSING: {dst} appeared while this ran — is the server still up?",
                  file=sys.stderr)
            return _partial(done)
        try:
            if src.is_dir():
                # `os.rename` on a directory refuses a non-empty destination (ENOTEMPTY), which is
                # the protection wanted here.
                os.rename(src, dst)
            else:
                # But `rename` on a FILE silently REPLACES an existing destination, so the check
                # above is only as good as the window after it — and a running signed-in app can
                # create this exact file in that window, which `rename` would then destroy.
                # `os.link` fails with EEXIST atomically instead, so the race is closed rather than
                # narrowed: link, then drop the old name. Same inode, no copy.
                os.link(src, dst)
                os.unlink(src)
        except OSError as e:
            # ENOTEMPTY is the refusal working: something created the destination in the window.
            # Reported rather than raised, because a traceback in the middle of a data migration
            # tells the operator nothing about what already moved.
            print(f"FAILED moving {src.name}: {e}", file=sys.stderr)
            return _partial(done)
        done.append(src.name)
        print(f"moved {src.name}")
    print("\nDone. The flat paths are recreated empty on next use by whoever is NOT signed in.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
