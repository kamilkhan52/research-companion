#!/usr/bin/env bash
# Expose the local server on a public https URL so you can test on your phone
# from anywhere (cellular included). No Cloudflare account needed.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${RC_PORT:-8000}"

# Prefer a system-installed cloudflared (e.g. `brew install cloudflared`); otherwise
# download a local copy into .venv/. Works on macOS (darwin) and Linux.
if command -v cloudflared >/dev/null 2>&1; then
  BIN="$(command -v cloudflared)"
else
  BIN="./.venv/cloudflared"
  if [ ! -x "$BIN" ]; then
    echo "Downloading cloudflared..."
    OS="$(uname -s)"; ARCH="$(uname -m)"
    case "$ARCH" in
      x86_64|amd64) CF_ARCH=amd64 ;;
      aarch64|arm64) CF_ARCH=arm64 ;;
      *) echo "Unsupported arch: $ARCH"; exit 1 ;;
    esac
    case "$OS" in
      Linux)
        curl -fsSL -o "$BIN" \
          "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}"
        ;;
      Darwin)
        # macOS ships as a .tgz containing the cloudflared binary.
        TGZ="$(mktemp -t cloudflared).tgz"
        curl -fsSL -o "$TGZ" \
          "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${CF_ARCH}.tgz"
        tar -xzf "$TGZ" -C ./.venv cloudflared
        rm -f "$TGZ"
        ;;
      *) echo "Unsupported OS: $OS (install cloudflared manually)"; exit 1 ;;
    esac
    chmod +x "$BIN"
  fi
fi

echo "Starting tunnel to http://localhost:${PORT} ..."
echo "Open the https URL it prints below on your phone."
exec "$BIN" tunnel --url "http://localhost:${PORT}"
