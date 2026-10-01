#!/bin/bash
# launchd entry point for Metro (io.scholiast.rc.metro). Serves the DEVICE worktree — never the
# main checkout, never a dispatch worktree (CLAUDE.md, "three checkouts, three jobs").
#
# Not CI=1: Expo's CI mode turns off file watching, and file watching is how a deploy (which
# advances this worktree with git) reaches the phone as a Fast Refresh.
set -uo pipefail
LOG_TAG=metro
. "$(dirname "$0")/common.sh"

MOBILE="$RC_DEVICE_WORKTREE/mobile"
cd "$MOBILE" || { log "device worktree $MOBILE is missing"; exit 1; }

# Same token the interactive shell exports (~/.zshenv); launchd does not read shell profiles.
if [ -r "$HOME/.config/expo/token" ]; then
  EXPO_TOKEN="$(cat "$HOME/.config/expo/token")"
  export EXPO_TOKEN
fi

# Reinstall when the lockfile has moved since the last install — a deploy can bring in a new
# dependency (`needs_npm_ci` in the deploy status), and Metro would otherwise fail to resolve
# it. The watchdog leaves Metro alone while this runs; the pid file is how it knows.
rm -f "$STATE_DIR/metro-npm-ci.pid"   # left behind if a previous run was killed mid-install
want="$(lock_hash)"
have="$(cat "$STATE_DIR/metro-lock.sha" 2>/dev/null || true)"
if [ ! -x node_modules/.bin/expo ] || [ "$want" != "$have" ]; then
  log "package-lock changed (or node_modules missing) — npm ci"
  echo $$ > "$STATE_DIR/metro-npm-ci.pid"
  if npm ci --no-audit --no-fund; then
    echo "$want" > "$STATE_DIR/metro-lock.sha"
    rm -f "$STATE_DIR/metro-npm-ci.pid"
  else
    rm -f "$STATE_DIR/metro-npm-ci.pid"
    # Back off: each attempt deletes node_modules first, and launchd would rerun it every 15s.
    log "npm ci failed — retrying in 2 minutes"
    sleep 120
    exit 1
  fi
fi

free_port "$METRO_PORT" 'expo start|metro' || exit 1

log "starting Metro from $MOBILE on :$METRO_PORT"
exec ./node_modules/.bin/expo start --lan --port "$METRO_PORT"
