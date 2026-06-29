#!/usr/bin/env bash
# Generate TypeScript types from the backend's OpenAPI schema so the web/mobile clients stay
# in sync with the API (no hand-written, drift-prone types). Runs offline — it dumps the
# schema straight from the FastAPI app, no server needed.
#
# Usage:  scripts/gen-api-types.sh [output.ts]
#   default output: shared/api-types.ts
# Requires: the project venv (.venv) and Node (npx fetches openapi-typescript on demand).
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${1:-shared/api-types.ts}"
PY="./.venv/bin/python"
[ -x "$PY" ] || PY="python3"

SCHEMA="$(mktemp -t rc-openapi).json"
trap 'rm -f "$SCHEMA"' EXIT

echo "Dumping OpenAPI schema from app.main:app ..."
"$PY" -c "import json; from app.main import app; print(json.dumps(app.openapi()))" > "$SCHEMA"

mkdir -p "$(dirname "$OUT")"
echo "Generating $OUT ..."
npx --yes openapi-typescript "$SCHEMA" -o "$OUT"
echo "Done -> $OUT"
