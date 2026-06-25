#!/bin/bash
# CallingClaw — Codex Setup
# One-command onboarding so you can talk to CallingClaw and launch meetings
# from inside OpenAI Codex (CLI or desktop app).
#
# What this does:
#   1. Locates the Codex CLI (PATH, or the desktop app bundle)
#   2. Registers the CallingClaw MCP server in ~/.codex/config.toml (codex mcp add)
#      → tools available in every Codex session on this machine
#   3. Sets AGENT_PLATFORM=codex in .env (backend uses CodexAdapter)
#
# Usage: ./scripts/setup-codex.sh

set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd)"

GREEN='\033[0;32m'; YELLOW='\033[0;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }

echo "=== CallingClaw — Codex Setup ==="
echo ""

# ── 1. Locate the Codex CLI ──
# The Codex desktop app bundles the CLI but does not put it on PATH.
CODEX_APP_BIN="/Applications/Codex.app/Contents/Resources/codex"
CODEX_CMD=""
if [ -n "${CODEX_BIN:-}" ] && [ -x "$CODEX_BIN" ]; then CODEX_CMD="$CODEX_BIN";
elif command -v codex &>/dev/null; then CODEX_CMD="codex";
elif [ -x "$CODEX_APP_BIN" ]; then CODEX_CMD="$CODEX_APP_BIN"; fi

if [ -z "$CODEX_CMD" ]; then
  warn "Codex CLI not found."
  warn "Install it first:  npm install -g @openai/codex"
  warn "  or install the Codex desktop app from https://openai.com/codex"
  exit 1
fi
ok "Codex found: $("$CODEX_CMD" --version 2>/dev/null || echo unknown)"

# ── 2. Register the CallingClaw MCP server in ~/.codex/config.toml ──
MCP_INDEX="$PROJECT_DIR/plugins/callingclaw-events/index.ts"
BUN_PATH=$(command -v bun || echo "$HOME/.bun/bin/bun")

# Ensure the MCP plugin deps are installed
( cd "$PROJECT_DIR/plugins/callingclaw-events" && "$BUN_PATH" install --silent ) || warn "bun install for MCP plugin failed"

# Re-register so the path always points at this checkout
"$CODEX_CMD" mcp remove callingclaw-events &>/dev/null || true
"$CODEX_CMD" mcp add callingclaw-events \
  --env CALLINGCLAW_HTTP=http://localhost:4000 \
  --env CALLINGCLAW_URL=ws://localhost:4000/ws/events \
  -- "$BUN_PATH" "$MCP_INDEX"
ok "Registered callingclaw-events MCP server in ~/.codex/config.toml"

# ── 3. Set AGENT_PLATFORM=codex in .env ──
if [ -f "$PROJECT_DIR/.env" ]; then
  if grep -q "^AGENT_PLATFORM=" "$PROJECT_DIR/.env"; then
    sed -i '' 's/^AGENT_PLATFORM=.*/AGENT_PLATFORM=codex/' "$PROJECT_DIR/.env"
  else
    echo "AGENT_PLATFORM=codex" >> "$PROJECT_DIR/.env"
  fi
  ok "Set AGENT_PLATFORM=codex in .env"
else
  warn ".env not found — run ./scripts/setup.sh first, then re-run this script"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Start CallingClaw:   ./scripts/start.sh"
echo "  2. Talk to it from any Codex session:"
echo "     codex exec \"use the callingclaw tools to report status\""
echo "     codex exec \"join this meeting: https://meet.google.com/xxx-xxxx-xxx\""
echo ""
echo "  Codex has no live channel push — ask it to call callingclaw_recent_events"
echo "  to poll meeting events (summary ready, prep ready)."
