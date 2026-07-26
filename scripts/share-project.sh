#!/usr/bin/env bash
# Copy a project from one instance to another.
#
#   scripts/share-project.sh <project-id> <target-server-url> [new name]
#
# Example — push a local project up to staging:
#   scripts/share-project.sh llm-basics https://research-companion-staging.fly.dev
#
# The project travels as a **git bundle**, so the whole commit history goes with it: every
# approved note, every commit message. That history is the record — the agent proposes and a human
# approves, and only then does anything land in git — so a share that dropped it would be
# discarding the provenance, not just some metadata.
#
# `.state/` does not travel and should not: retry branches, caches and the usage ledger belong to
# the instance that made them. It is also nearly all of the bytes (207 MB of one 214 MB project
# here), which is why this takes about a second rather than minutes.
#
# The direction matters. This PUSHES from wherever you run it to a server it can reach. The Mac
# can reach Fly; Fly cannot reach the Mac, so pulling would not work.
set -euo pipefail

SOURCE_URL="${RC_SOURCE_URL:-http://127.0.0.1:8000}"

usage() {
  cat >&2 <<'USAGE'
usage: scripts/share-project.sh <project-id> <target-server-url> [new name]

  RC_SOURCE_URL    where to read the project from   (default http://127.0.0.1:8000)
  RC_SOURCE_TOKEN  bearer token for the source, if it requires auth
  RC_TARGET_TOKEN  bearer token for the target, if it requires auth

The target almost always needs RC_TARGET_TOKEN: staging and production refuse to boot without
Supabase auth. Get one by signing in on the web client and copying `rc_token` from localStorage.
USAGE
  exit 2
}

[ $# -ge 2 ] || usage
PID="$1"
TARGET="${2%/}"
NAME="${3:-}"

# The backend's own project-id rule. Checked HERE because $PID is interpolated into a URL and,
# below, was interpolated into Python source — a value like `x'"'"');import os;os.system(...)#`
# would have run locally during the name lookup. Percent-encoding kept the URL valid enough for
# curl to still reach a real /bundle route, so a bad id could not be relied on to fail first.
case "$PID" in
  *[!a-z0-9-]*|""|-*) echo "invalid project id: $PID" >&2; exit 2 ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
bundle="$tmp/$PID.bundle"

# `${arr[@]+"${arr[@]}"}` rather than `"${arr[@]}"`: macOS ships bash 3.2, where expanding an
# EMPTY array under `set -u` is an "unbound variable" error.
src_auth=()
[ -n "${RC_SOURCE_TOKEN:-}" ] && src_auth=(-H "Authorization: Bearer $RC_SOURCE_TOKEN")
dst_auth=()
[ -n "${RC_TARGET_TOKEN:-}" ] && dst_auth=(-H "Authorization: Bearer $RC_TARGET_TOKEN")
src_h=(${src_auth[@]+"${src_auth[@]}"})
dst_h=(${dst_auth[@]+"${dst_auth[@]}"})

echo "→ exporting $PID from $SOURCE_URL"
code="$(curl -sS -w '%{http_code}' ${src_h[@]+"${src_h[@]}"} \
  "$SOURCE_URL/api/projects/$PID/bundle" -o "$bundle")"
if [ "$code" != "200" ]; then
  echo "   failed (HTTP $code): $(head -c 300 "$bundle")" >&2
  exit 1
fi

# Verify locally before uploading. A truncated download would otherwise fail on the far side,
# where the error is someone else's problem to interpret.
git bundle verify "$bundle" >/dev/null 2>&1 || {
  echo "   the downloaded bundle is not valid — did the export return an error page?" >&2
  exit 1
}
echo "   $(du -h "$bundle" | cut -f1), history intact"

# Default the name from the source project so the copy is recognisable rather than "llm-basics".
if [ -z "$NAME" ]; then
  NAME="$(curl -sS ${src_h[@]+"${src_h[@]}"} "$SOURCE_URL/api/projects" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);ps=d['projects'] if isinstance(d,dict) else d;print(next((p['name'] for p in ps if p['id']==sys.argv[1]), sys.argv[1]))" "$PID" \
    2>/dev/null || echo "$PID")"
fi

# --form-string, not -F, for the NAME: curl treats a -F value beginning with `<` as "read this
# local file", so a project named `</etc/passwd` would upload the operator's file instead of a
# name. --form-string takes the value literally.
echo "→ importing into $TARGET as \"$NAME\""
out="$tmp/response.json"
code="$(curl -sS -w '%{http_code}' ${dst_h[@]+"${dst_h[@]}"} \
  -F "file=@$bundle" --form-string "name=$NAME" \
  "$TARGET/api/projects/import" -o "$out")"
if [ "$code" != "200" ]; then
  echo "   failed (HTTP $code): $(head -c 300 "$out")" >&2
  exit 1
fi

python3 -c "import sys,json;d=json.load(open(sys.argv[1]));print('✓ imported as', d['id'], '—', d['name'])" "$out"
