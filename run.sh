#!/usr/bin/env bash
# Start the Research Reading Companion backend (and web client, same origin).
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "Creating virtualenv..."
  # Some distros ship python3 without ensurepip; create venv without pip and bootstrap it.
  if ! python3 -m venv .venv 2>/dev/null; then
    python3 -m venv --without-pip .venv
  fi
  if ! ./.venv/bin/python3 -m pip --version >/dev/null 2>&1; then
    echo "Bootstrapping pip..."
    curl -fsSL https://bootstrap.pypa.io/get-pip.py -o /tmp/get-pip.py
    ./.venv/bin/python3 /tmp/get-pip.py >/dev/null
  fi
  ./.venv/bin/python3 -m pip install --upgrade pip >/dev/null
  ./.venv/bin/python3 -m pip install -r requirements.txt
fi

# Load .env if present. Parse manually (don't `source` it) so values with spaces or special
# characters can't be executed as shell. The app also loads .env via python-dotenv.
if [ -f .env ]; then
  while IFS='=' read -r k v; do
    case "$k" in ''|\#*) continue ;; esac
    v="${v%\"}"; v="${v#\"}"          # strip one layer of surrounding double quotes
    export "$k=$v"
  done < .env
fi

HOST="${RC_HOST:-0.0.0.0}"
PORT="${RC_PORT:-8000}"

# The app refuses to start without an explicit RC_ENV — unset is treated as unsafe rather than
# defaulting to dev, so that a deployed container which lost its environment fails closed instead
# of booting with authentication disabled. Local runs are dev unless told otherwise.
export RC_ENV="${RC_ENV:-dev}"

# Opt-in dev auto-reload. Default off (production/tunnel deployment stays a single long-lived
# process). RC_RELOAD=1 restarts the worker when files under app/ change so new routes don't 405
# on a stale server. The watch is scoped to --reload-dir app on purpose: uvicorn's reloader
# watches the CWD by default, and this repo writes to projects/ and .app-state/ constantly
# (session index, audio cache, git commits), which would otherwise trigger an endless reload
# loop. A reload is a full process restart, so it drops in-memory job registries and kills any
# in-flight background job (chat/audio/graph/preview) — fine for iterating on code, but avoid
# saving while a long job you care about is running. Still one worker (invariant 6 holds).
if [ "${RC_RELOAD:-}" = "1" ]; then
  echo "Serving on http://${HOST}:${PORT} with app auto-reload"
  exec ./.venv/bin/uvicorn app.main:app --host "$HOST" --port "$PORT" --reload --reload-dir app "$@"
fi

echo "Serving on http://${HOST}:${PORT}  (open http://localhost:${PORT} on this machine)"
exec ./.venv/bin/uvicorn app.main:app --host "$HOST" --port "$PORT" "$@"
