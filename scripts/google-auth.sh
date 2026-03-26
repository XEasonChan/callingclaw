#!/usr/bin/env bash
# Generate Google OAuth refresh token for Calendar integration
# Opens browser → authorize → writes GOOGLE_REFRESH_TOKEN to .env
#
# Prerequisites: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUN_PATH=$(command -v bun || echo "$HOME/.bun/bin/bun")
exec "$BUN_PATH" "$SCRIPT_DIR/ts/google-auth.ts"
