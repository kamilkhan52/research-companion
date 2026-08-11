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
TS="$(date +%Y%m%dT%H%M%S)"

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

  if [[ -d "$LOCAL_PROJECTS" ]]; then
    backup="${LOCAL_PROJECTS}.bak-${TS}"
    echo "-> backing up existing local projects/ to $backup"
    mv "$LOCAL_PROJECTS" "$backup"
  fi
  mkdir -p "$LOCAL_PROJECTS"
  echo "-> pulling from production ($APP:/data/projects)"
  flyctl ssh console -a "$APP" -C "tar czf - -C /data projects" \
    | tar xzf - -C "$(dirname "$LOCAL_PROJECTS")"
  echo "Done. Local projects/ now matches production as of this moment."
  echo "Restart the local server (./run.sh) if it was already running, so it picks up the new data."

else
  echo "This will PUSH local projects/ up and OVERWRITE production's live reading data."
  echo "Before continuing, make sure:"
  echo "  - nothing is actively writing to production right now (check: flyctl logs -a $APP)"
  echo "  - your phone is pointed at the LOCAL server, not production, until this finishes"
  read -r -p "Type 'overwrite production' to continue: " confirm
  [[ "$confirm" == "overwrite production" ]] || { echo "Aborted."; exit 1; }

  echo "-> snapshotting production's current projects/ first"
  flyctl ssh console -a "$APP" -C "tar czf /data/projects-backup-${TS}.tar.gz -C /data projects"
  echo "   saved on the Fly volume as /data/projects-backup-${TS}.tar.gz (delete manually once you trust the push)"

  echo "-> pushing local projects/ to production ($APP:/data/projects)"
  tar czf - -C "$(dirname "$LOCAL_PROJECTS")" projects \
    | flyctl ssh console -a "$APP" -C "sh -c 'rm -rf /data/projects && tar xzf - -C /data'"
  echo "Done. Production's projects/ now matches local as of this moment."
  echo "Point your phone back at https://research-companion.fly.dev when you're ready to use it live again."
fi
