#!/usr/bin/env bash
# Copy a project from this machine to a Fly instance, using flyctl instead of a user token.
#
#   scripts/share-to-fly.sh <project-id> [fly-app] [new name]
#   scripts/share-to-fly.sh 3d-integrated-dram research-companion-staging
#
# `share-project.sh` talks to the target's HTTP API and therefore needs a signed-in user's JWT —
# which means a browser with developer tools open. That is a poor fit for the actual task: moving
# a project between two instances you own is an OPERATOR action, and the operator's authority over
# a Fly machine is `flyctl`, which is already authenticated.
#
# So this route uses no user session at all. It reads the bundle straight from the local git repo
# (no local server needed either), pushes it over the Fly SSH tunnel, and runs the importer inside
# the container. The importer calls the same `projects.import_bundle` as the HTTP route, so the
# bundle passes exactly the same safety checks.
set -euo pipefail

PID="${1:-}"
APP="${2:-research-companion-staging}"
NAME="${3:-}"

[ -n "$PID" ] || { echo "usage: scripts/share-to-fly.sh <project-id> [fly-app] [new name]" >&2; exit 2; }
case "$PID" in *[!a-z0-9-]*|-*) echo "invalid project id: $PID" >&2; exit 2 ;; esac

ROOT="${RC_PROJECTS_ROOT:-$(cd "$(dirname "$0")/.." && pwd)/projects}"
REPO="$ROOT/$PID"
[ -d "$REPO/.git" ] || { echo "no project git repo at $REPO" >&2; exit 1; }

# Default the display name from the project's own metadata, so the copy is recognisable.
if [ -z "$NAME" ] && [ -f "$REPO/project.json" ]; then
  NAME="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('name') or sys.argv[2])" \
    "$REPO/project.json" "$PID" 2>/dev/null || echo "$PID")"
fi
NAME="${NAME:-$PID}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
bundle="$tmp/$PID.bundle"

# HEAD only, matching export_bundle: `--all` would sweep in refs/stash, which can hold working
# material that was never approved — exactly what "agent proposes, human commits" keeps out.
echo "→ bundling $PID"
git -C "$REPO" bundle create "$bundle" HEAD 2>/dev/null
git bundle verify "$bundle" >/dev/null 2>&1 || { echo "   bundle failed verification" >&2; exit 1; }
echo "   $(du -h "$bundle" | cut -f1), history intact"

remote="/data/incoming-$PID-$$.bundle"
remote_importer="/data/import_bundle-$$.py"
here="$(cd "$(dirname "$0")" && pwd)"

echo "→ uploading to $APP"
flyctl ssh sftp put -a "$APP" "$bundle" "$remote" >/dev/null
# The importer is uploaded rather than baked into the image: `.dockerignore` deliberately keeps
# `scripts/` out to stay lean, and uploading also guarantees the code that runs matches THIS
# checkout rather than whatever was deployed.
flyctl ssh sftp put -a "$APP" "$here/import_bundle.py" "$remote_importer" >/dev/null

echo "→ importing as \"$NAME\""
# The name crosses the shell BASE64-ENCODED and is decoded inside the importer. It is
# user-controlled data — editable in the app, and carried inside an imported bundle's project.json
# — and this command string is evaluated by a shell in the container, so a project named
# `$(...)` would otherwise run as a command there with the app's privileges. base64's alphabet
# cannot express shell syntax, so the value travels inert.
name_b64="$(printf '%s' "$NAME" | base64 | tr -d '\n')"
case "$name_b64" in *[!A-Za-z0-9+/=]*|"") echo "could not encode the project name" >&2; exit 1 ;; esac

# PYTHONPATH=/srv because the container's WORKDIR holds `app/`, and Python puts the *script's*
# directory on sys.path, not the working directory.
# RC_ADOPT_OWNER is read from the TARGET's environment inside the container, so the importer can
# record who the project belongs to. An import with no owner is reachable by nobody, so the
# importer refuses rather than publishing something invisible — pass RC_OWNER here to override.
owner_arg=""
[ -n "${RC_OWNER:-}" ] && owner_arg=" --owner \"$RC_OWNER\""
case "${RC_OWNER:-}" in *[!0-9a-fA-F-]*) echo "RC_OWNER must be a uuid" >&2; exit 2 ;; esac

flyctl ssh console -a "$APP" -C \
  "sh -lc 'PYTHONPATH=/srv python \"$remote_importer\" \"$remote\" --name-b64 \"$name_b64\"$owner_arg; rc=\$?; rm -f \"$remote\" \"$remote_importer\"; exit \$rc'"
