#!/usr/bin/env python3
"""Import a project bundle from inside the instance — no HTTP, no user token.

    python scripts/import_bundle.py <bundle-path> <project name>
    python scripts/import_bundle.py <bundle-path> --name-b64 <base64 of the name>

Why this exists alongside `POST /api/projects/import`: the HTTP route needs a signed-in user's
JWT, and getting one means a browser with developer tools. Moving a project between two instances
you own is an *operator* action, and the operator's authority over a Fly machine is `flyctl` —
so the whole transfer can be:

    flyctl ssh sftp put …            # the operator's existing machine credential
    flyctl ssh console -C "python scripts/import_bundle.py …"

No user session is minted, nothing long-lived is created, and no token has to be copied out of a
browser and carried anywhere.

It deliberately calls the SAME `projects.import_bundle` as the HTTP route, so the bundle passes
exactly the same checks — symlinks, submodules, tracked `.state/`, git-control files, expansion
limits, project shape. A second import path that skipped them would be a hole in the first.
"""
from __future__ import annotations

import base64
import sys
from pathlib import Path

# Runs both from a checkout and from wherever it is uploaded to on a server, so it locates the
# app by trying its own repo root and then the container's WORKDIR.
for candidate in (Path(__file__).resolve().parent.parent, Path("/srv")):
    if (candidate / "app" / "projects.py").is_file():
        sys.path.insert(0, str(candidate))
        break

from app import projects  # noqa: E402  — after the path insert


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__.strip().splitlines()[2].strip(), file=sys.stderr)
        return 2
    bundle = Path(argv[1])
    if argv[2] == "--name-b64":
        # The name arrives base64-encoded because the caller reaches this script through
        # `flyctl ssh console -C "sh -lc '...'"`, i.e. through a shell. A project name is
        # user-controlled data — it is editable in the app and travels inside an imported
        # bundle's project.json — so a name like `$(...)` embedded in that command string would
        # execute in the container. base64's alphabet cannot express shell syntax, so the value
        # crosses the shell inert and is decoded here, where it is only ever data.
        if len(argv) < 4:
            print("--name-b64 needs a value", file=sys.stderr)
            return 2
        try:
            name = base64.b64decode(argv[3], validate=True).decode("utf-8").strip()
        except (ValueError, UnicodeDecodeError) as e:
            print(f"could not decode the name: {e}", file=sys.stderr)
            return 2
    else:
        name = " ".join(argv[2:]).strip()
    if not name:
        print("the project needs a name", file=sys.stderr)
        return 2
    if not bundle.is_file():
        print(f"no such bundle: {bundle}", file=sys.stderr)
        return 1
    try:
        meta = projects.import_bundle(bundle.read_bytes(), name)
    except projects.ProjectError as e:
        print(f"refused: {e}", file=sys.stderr)
        return 1
    print(f"imported as {meta['id']} — {meta['name']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
