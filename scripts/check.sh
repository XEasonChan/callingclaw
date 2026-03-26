#!/usr/bin/env bash
# Verify backend module wiring (pre-deploy check)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUN_PATH=$(command -v bun || echo "$HOME/.bun/bin/bun")
exec "$BUN_PATH" "$SCRIPT_DIR/ts/check-wiring.ts"
