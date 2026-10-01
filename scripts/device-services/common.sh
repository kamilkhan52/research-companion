# shellcheck shell=bash disable=SC2034
# Shared by the device-service wrappers. Sourced, never run. See README.md beside it.
#
# The installer writes `services.env` next to the installed copy of this file, naming the two
# checkouts. Nothing here guesses a path: a wrapper that "finds" a checkout is how a Metro once
# ended up serving a worktree ten commits behind main (docs/production/40-device-test-runbook.md).

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$HERE/services.env"

: "${RC_REPO:?services.env must set RC_REPO}"
: "${RC_DEVICE_WORKTREE:?services.env must set RC_DEVICE_WORKTREE}"

STATE_DIR="$HERE/state"
LOG_DIR="$HOME/Library/Logs/research-companion"
mkdir -p "$STATE_DIR" "$LOG_DIR"

LABEL_BACKEND="io.scholiast.rc.backend"
LABEL_METRO="io.scholiast.rc.metro"
LABEL_WATCHDOG="io.scholiast.rc.watchdog"
LABEL_AWAKE="io.scholiast.rc.awake"

BACKEND_PORT="${RC_PORT:-8000}"
METRO_PORT=8081

# launchd starts jobs with a soft open-files limit of 256. Metro's file watcher and the backend's
# git subprocesses both run past that and fail with EMFILE, long after startup, looking like a
# code bug. The plists raise it too; this is the belt to their braces.
ulimit -n 65536 2>/dev/null || true

log() { printf '%s [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "${LOG_TAG:-rc}" "$*"; }

# Free a port held by a stray copy of OUR server, so the launchd-owned one can bind it.
#   free_port PORT PATTERN
# Only processes whose command line matches PATTERN are killed. Anything else on the port is left
# alone and reported, and the caller fails — launchd retries after its throttle interval — rather
# than killing an unrelated program that happens to use the same port.
free_port() {
  local port="$1" pattern="$2" pids pid cmd parent foreign=0
  pids="$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u)"
  [ -z "$pids" ] && return 0
  for pid in $pids; do
    [ "$pid" = "$$" ] && continue
    cmd="$(ps -o command= -p "$pid" 2>/dev/null)" || continue   # exited since lsof
    # uvicorn --reload's worker shares the listening socket but its command line is a bare
    # multiprocessing stub; it is ours if its parent is. Killing the parent takes it down too.
    parent="$(ps -o command= -p "$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')" 2>/dev/null)"
    if printf '%s' "$cmd" | grep -Eq "$pattern"; then
      log "port $port held by stray pid $pid ($cmd) — stopping it"
      kill -TERM "$pid" 2>/dev/null || true
    elif printf '%s' "$parent" | grep -Eq "$pattern"; then
      log "port $port also held by pid $pid, a worker of a stray server — its parent takes it down"
    elif printf '%s' "$cmd" | grep -q 'multiprocessing' \
         && [ "$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')" = "$RC_REPO" ]; then
      # An orphaned uvicorn --reload worker (its reloader was SIGKILLed): ours by its cwd.
      log "port $port held by orphaned worker pid $pid — stopping it"
      kill -TERM "$pid" 2>/dev/null || true
    else
      log "port $port held by unrelated pid $pid ($cmd) — not touching it"
      foreign=1
    fi
  done
  [ "$foreign" = 1 ] && return 1
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    lsof -nP -t -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || return 0
    sleep 1
  done
  for pid in $(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null); do
    log "pid $pid ignored SIGTERM — SIGKILL"
    kill -KILL "$pid" 2>/dev/null || true
  done
  sleep 1
  ! lsof -nP -t -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

lock_hash() { shasum "$RC_DEVICE_WORKTREE/mobile/package-lock.json" 2>/dev/null | cut -d' ' -f1; }
