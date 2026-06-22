#!/usr/bin/env bash
# Expose the local server on a public https URL so you can test on your phone
# from anywhere (cellular included). No Cloudflare account needed.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${RC_PORT:-8000}"
BIN="./.venv/cloudflared"

if [ ! -x "$BIN" ]; then
  echo "Downloading cloudflared..."
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64|amd64) CF_ARCH=amd64 ;;
    aarch64|arm64) CF_ARCH=arm64 ;;
    *) echo "Unsupported arch: $ARCH"; exit 1 ;;
  esac
  curl -fsSL -o "$BIN" \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}"
  chmod +x "$BIN"
fi

echo "Starting tunnel to http://localhost:${PORT} ..."
echo "Open the https URL it prints below on your phone."
exec "$BIN" tunnel --url "http://localhost:${PORT}"
