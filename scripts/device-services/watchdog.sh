#!/bin/bash
# launchd entry point for the watchdog (io.scholiast.rc.watchdog), run every 60s.
#
# launchd's KeepAlive already restarts a server that EXITS. This catches the failures it cannot
# see: a process that is alive but not answering, a job that was booted out of launchd, a Metro
# serving the wrong worktree, and a lockfile a deploy moved under a running Metro.
#
# Restarts are deliberately slow to trigger. Restarting the backend kills every in-flight
# background job (DR-083), so it takes five consecutive failed minutes, not one blip.
set -uo pipefail
LOG_TAG=watchdog
. "$(dirname "$0")/common.sh"

DOMAIN="gui/$(id -u)"
AGENTS="$HOME/Library/LaunchAgents"
GRACE_S=180            # after a restart, give the server this long before judging it
BACKEND_STRIKES=5
METRO_STRIKES=3

now() { date +%s; }

strikes() { cat "$STATE_DIR/$1.strikes" 2>/dev/null || echo 0; }
set_strikes() { echo "$2" > "$STATE_DIR/$1.strikes"; }

in_grace() {
  local t; t="$(cat "$STATE_DIR/$1.restarted" 2>/dev/null || echo 0)"
  [ $(( $(now) - t )) -lt "$GRACE_S" ]
}

restart() {
  local name="$1" label="$2" why="$3"
  log "restarting $name: $why"
  launchctl kickstart -k "$DOMAIN/$label" 2>&1 | sed 's/^/  /'
  now > "$STATE_DIR/$name.restarted"
  set_strikes "$name" 0
}

# A job someone booted out (or a plist that failed to load at login) — load it again.
ensure_loaded() {
  local label="$1"
  launchctl print "$DOMAIN/$label" >/dev/null 2>&1 && return 0
  [ -f "$AGENTS/$label.plist" ] || { log "$label.plist is gone — run install.sh"; return 1; }
  log "$label was not loaded — bootstrapping it"
  launchctl bootstrap "$DOMAIN" "$AGENTS/$label.plist" 2>&1 | sed 's/^/  /'
  now > "$STATE_DIR/${label##*.}.restarted"
  return 1
}

# Keep the logs from filling the disk: past 20 MB, keep the last 5 MB. Rewritten in place, so
# launchd's open append-mode descriptor keeps working.
trim_log() {
  local f="$1" size
  [ -f "$f" ] || return 0
  size="$(stat -f %z "$f")"
  [ "$size" -gt 20971520 ] || return 0
  tail -c 5242880 "$f" > "$f.tmp" && cat "$f.tmp" > "$f" && rm -f "$f.tmp"
}

for f in "$LOG_DIR"/*.log; do trim_log "$f"; done

ensure_loaded "$LABEL_AWAKE"

# ---- backend -------------------------------------------------------------------------------
if ensure_loaded "$LABEL_BACKEND" && ! in_grace backend; then
  if curl -fsS -m 10 "http://127.0.0.1:$BACKEND_PORT/api/health" >/dev/null 2>&1; then
    set_strikes backend 0
  else
    n=$(( $(strikes backend) + 1 )); set_strikes backend "$n"
    log "backend health check failed ($n/$BACKEND_STRIKES)"
    [ "$n" -ge "$BACKEND_STRIKES" ] && restart backend "$LABEL_BACKEND" "no answer for $n minutes"
  fi
fi

# ---- metro ---------------------------------------------------------------------------------
ci_pid="$(cat "$STATE_DIR/metro-npm-ci.pid" 2>/dev/null || true)"
if [ -n "$ci_pid" ] && kill -0 "$ci_pid" 2>/dev/null; then
  :   # npm ci in progress — Metro is not up yet, and that is expected
elif ensure_loaded "$LABEL_METRO" && ! in_grace metro; then
  listener="$(lsof -nP -t -iTCP:"$METRO_PORT" -sTCP:LISTEN 2>/dev/null | head -1)"
  cwd=""
  [ -n "$listener" ] && cwd="$(lsof -a -p "$listener" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
  if [ "$(lock_hash)" != "$(cat "$STATE_DIR/metro-lock.sha" 2>/dev/null)" ]; then
    restart metro "$LABEL_METRO" "mobile/package-lock.json changed — needs npm ci"
  elif [ -n "$cwd" ] && [ "$cwd" != "$RC_DEVICE_WORKTREE/mobile" ]; then
    restart metro "$LABEL_METRO" "port $METRO_PORT is serving $cwd, not the device worktree"
  elif curl -fsS -m 10 "http://127.0.0.1:$METRO_PORT/status" 2>/dev/null | grep -q 'packager-status:running'; then
    set_strikes metro 0
  else
    n=$(( $(strikes metro) + 1 )); set_strikes metro "$n"
    log "Metro status check failed ($n/$METRO_STRIKES)"
    [ "$n" -ge "$METRO_STRIKES" ] && restart metro "$LABEL_METRO" "no answer for $n minutes"
  fi
fi
exit 0
