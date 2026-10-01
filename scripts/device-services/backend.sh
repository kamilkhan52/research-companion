#!/bin/bash
# launchd entry point for the backend (io.scholiast.rc.backend). Runs `run.sh` from the MAIN
# checkout with RC_RELOAD=1 — the same way it was started by hand before this existed, so a
# deploy (which advances that checkout) still reloads the worker without launchd noticing.
set -uo pipefail
LOG_TAG=backend
. "$(dirname "$0")/common.sh"

cd "$RC_REPO" || { log "main checkout $RC_REPO is missing"; exit 1; }

# A hand-started server left over from before (or after) this was installed. Killing it is the
# point: two servers on one store break invariant 6. The pattern is narrow on purpose.
free_port "$BACKEND_PORT" 'uvicorn app\.main:app' || exit 1

export RC_RELOAD=1
log "starting backend from $RC_REPO on :$BACKEND_PORT"
exec ./run.sh
