#!/usr/bin/env bash
# Mirror the `projects/` directory (the git-repo-per-project reading data — papers, discussions,
# notes, working state) between this machine and the production Fly volume, so a local
# dev-testing session can use Kamil's actual current reading progress instead of a stale/empty
# local copy, and so progress made locally during a testing session isn't stranded there after.
#
# Why this exists: the DevTest bubble (DR-060) only renders when the SERVER it talks to is in dev
# mode, which `./run.sh` is and production deliberately can never be (`assert_environment_safe`
# refuses to start staging/prod with RC_DEV on — that is a real auth-safety invariant, not
# incidental). So seeing the bubble means pointing the phone at the local server, and the local
# server's project store (`RC_PROJECTS_ROOT`) is a separate, non-synced directory from Fly's
# persistent volume. Without this script that switch strands whatever reading you do locally.
#
# Deliberately a RAW COPY (tar over `flyctl ssh console -C`), not app/projects.py's
# export_bundle/import_bundle: that mechanism is for moving a project to a NEW instance under a
# NEW id ("never overwrites: always a fresh id" — see its docstring), which is wrong here. This
# script updates the SAME project ids in place, repeatedly, which is exactly what a raw directory
# copy does and a fresh-id importer cannot.
#
# Usage:
#   scripts/sync-projects.sh down   # production (Fly volume) -> here, before a local test session
#   scripts/sync-projects.sh up     # here -> production (Fly volume), after a local test session
#
# Never run the local server and point your phone at production while a sync is in flight, and
# never run `up` while a background job might be touching /data/projects on production — check
# `flyctl logs -a research-companion` first for anything still running. Run one direction at a
# time; this script does not detect concurrent use.
set -euo pipefail

APP=research-companion
LOCAL_PROJECTS="/Users/kamil/research-companion/projects"
# Outside the repo entirely, not a sibling dir like `projects.bak-*`: `.gitignore` only covers
# `projects/` exactly, so a backup left next to it is one `git add -A` away from committing
# Kamil's real reading data into history.
BACKUP_ROOT="$HOME/.research-companion-backups"
TS="$(date +%Y%m%dT%H%M%S)"
# `flyctl ssh console` connects as root; the app runs as uid/gid 10001 (Dockerfile `USER rc`).
# A tar extracted as root restores ownership from the local archive — Kamil's macOS uid, which
# does not exist in the container — so anything written there afterward (every notes save, every
# git commit committer.py makes) fails EACCES until this is corrected.
REMOTE_UID=10001

# Counts project directories one level deep (each is `<pid>/.git`), excluding dot-directories
# (`.trash`, an in-progress `.importing-*`) the same way `projects.list_projects()` does — so a
# top-level `projects/` that exists but is empty, or mid-write, is caught rather than treated as
# "some data present," and the local/remote counts are comparing the same thing. The two `find`
# expressions below are kept textually identical on purpose (`! -name ".*"` etc.) so they can't
# silently drift apart.
local_project_count() {
  find "$LOCAL_PROJECTS" -mindepth 1 -maxdepth 1 -type d ! -name '.*' 2>/dev/null \
    | wc -l | tr -d '[:space:]'
}
remote_project_count() {
  flyctl ssh console -a "$APP" -C \
    "sh -c 'find /data/projects -mindepth 1 -maxdepth 1 -type d ! -name \".*\" 2>/dev/null | wc -l'" \
    2>/dev/null | tr -d '[:space:]'
}

direction="${1:-}"
if [[ "$direction" != "down" && "$direction" != "up" ]]; then
  echo "Usage: $0 down|up" >&2
  echo "  down: production -> local, before a local testing session" >&2
  echo "  up:   local -> production, after a local testing session" >&2
  exit 1
fi

if [[ "$direction" == "down" ]]; then
  echo "This will PULL production's projects/ down and OVERWRITE the local copy at:"
  echo "  $LOCAL_PROJECTS"
  if [[ -d "$LOCAL_PROJECTS" ]]; then
    echo "The current local copy will be kept as a backup, not deleted."
  fi
  read -r -p "Continue? [y/N] " confirm
  [[ "$confirm" == "y" || "$confirm" == "Y" ]] || { echo "Aborted."; exit 1; }

  remote_count="$(remote_project_count)"
  if [[ -z "$remote_count" || "$remote_count" == "0" ]]; then
    echo "Could not confirm production has any projects (got '$remote_count'). Refusing to" >&2
    echo "overwrite the local copy with what might be an empty or failed read. Check" >&2
    echo "'flyctl ssh console -a $APP -C \"ls /data/projects\"' by hand first." >&2
    exit 1
  fi
  echo "Production reports $remote_count project(s)."

  if [[ -d "$LOCAL_PROJECTS" ]]; then
    mkdir -p "$BACKUP_ROOT"
    backup="$BACKUP_ROOT/projects-${TS}"
    echo "-> backing up existing local projects/ to $backup"
    mv "$LOCAL_PROJECTS" "$backup"
  fi
  mkdir -p "$LOCAL_PROJECTS"
  echo "-> pulling from production ($APP:/data/projects)"
  flyctl ssh console -a "$APP" -C "tar czf - -C /data projects" \
    | tar xzf - -C "$(dirname "$LOCAL_PROJECTS")"

  got_count="$(local_project_count)"
  if [[ "$got_count" != "$remote_count" ]]; then
    echo "Extraction produced $got_count project(s), production reported $remote_count." >&2
    echo "Something went wrong mid-transfer (dropped connection, disk full). NOT overwriting" >&2
    echo "your backup — restoring it now so nothing is lost." >&2
    rm -rf "$LOCAL_PROJECTS"
    mv "${backup:-/nonexistent}" "$LOCAL_PROJECTS" 2>/dev/null || true
    exit 1
  fi
  echo "Done. Local projects/ now matches production ($got_count projects) as of this moment."
  echo "Restart the local server (./run.sh) if it was already running, so it picks up the new data."

else
  local_count="$(local_project_count)"
  if [[ -z "$local_count" || "$local_count" == "0" ]]; then
    echo "Local projects/ has no project directories (got '$local_count'). Refusing to push —" >&2
    echo "this would wipe production's real data with nothing to replace it. If this is really" >&2
    echo "intentional, that is not what this script is for; do it by hand." >&2
    exit 1
  fi
  remote_count="$(remote_project_count)"
  echo "Local has $local_count project(s); production currently reports ${remote_count:-unknown}."
  if [[ -n "$remote_count" && "$remote_count" != "0" && "$local_count" -lt "$remote_count" ]]; then
    echo "Local has FEWER projects than production. This is very likely a local copy that never" >&2
    echo "finished syncing (an interrupted 'down'), not real data loss on production. Refusing —" >&2
    echo "run 'down' again first, or investigate before pushing." >&2
    exit 1
  fi

  echo "This will PUSH local projects/ up and OVERWRITE production's live reading data."
  echo "Before continuing, make sure:"
  echo "  - nothing is actively writing to production right now (check: flyctl logs -a $APP)"
  echo "  - your phone is pointed at the LOCAL server, not production, until this finishes"
  read -r -p "Type 'overwrite production' to continue: " confirm
  [[ "$confirm" == "overwrite production" ]] || { echo "Aborted."; exit 1; }

  echo "-> snapshotting production's current projects/ first"
  flyctl ssh console -a "$APP" -C "tar czf /data/projects-backup-${TS}.tar.gz -C /data projects" \
    || echo "   (nothing to snapshot — production had no projects/ yet)"
  echo "   saved on the Fly volume as /data/projects-backup-${TS}.tar.gz (delete manually once you trust the push)"

  # Staged, not in-place: extract to a sibling directory first and verify it, so the destructive
  # delete of the live directory happens only once we know the new one is actually good — a
  # mid-stream failure here used to leave production's real projects/ already deleted with a
  # truncated replacement (or none at all).
  echo "-> uploading and staging on production (not yet live)"
  tar czf - -C "$(dirname "$LOCAL_PROJECTS")" projects | flyctl ssh console -a "$APP" -C "sh -c '
    set -e
    rm -rf /data/projects.incoming
    mkdir /data/projects.incoming
    tar xzf - -C /data/projects.incoming --strip-components=1
    chown -R ${REMOTE_UID}:${REMOTE_UID} /data/projects.incoming
  '"

  staged_count="$(flyctl ssh console -a "$APP" -C \
    "sh -c 'find /data/projects.incoming -mindepth 1 -maxdepth 1 -type d ! -name \".*\" 2>/dev/null | wc -l'" \
    2>/dev/null | tr -d '[:space:]')"
  if [[ "$staged_count" != "$local_count" ]]; then
    echo "Staged $staged_count project(s) on production but local had $local_count — the upload" >&2
    echo "didn't land cleanly. Production's LIVE projects/ has NOT been touched. Staged copy left" >&2
    echo "at /data/projects.incoming for inspection; clean it up by hand once you've looked." >&2
    exit 1
  fi

  echo "-> staged copy verified ($staged_count projects) — swapping it in"
  flyctl ssh console -a "$APP" -C "sh -c '
    set -e
    rm -rf /data/projects
    mv /data/projects.incoming /data/projects
  '"
  echo "Done. Production's projects/ now matches local ($staged_count projects) as of this moment."
  echo "Point your phone back at https://research-companion.fly.dev when you're ready to use it live again."
fi
