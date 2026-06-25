#!/bin/bash
# CallingClaw — Claude Code Setup
# One-command onboarding so you can talk to CallingClaw and launch meetings
# from inside Claude Code (terminal, desktop app, or remote sessions).
#
# What this does:
#   1. Verifies the Claude Code CLI is installed
#   2. Registers the CallingClaw MCP server at user scope (claude mcp add)
#      → tools available in every Claude Code session on this machine
#   3. Sets AGENT_PLATFORM=claude-code in .env (backend uses ClaudeCodeAdapter)
#
# Usage: ./scripts/setup-claude-code.sh

set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd)"

GREEN='\033[0;32m'; YELLOW='\033[0;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }

echo "=== CallingClaw — Claude Code Setup ==="
echo ""

# ── 1. Verify Claude Code CLI ──
if ! command -v claude &>/dev/null; then
  warn "Claude Code CLI not found."
  warn "Install it first:  npm install -g @anthropic-ai/claude-code"
  warn "  or:              brew install claude-code"
  exit 1
fi
ok "Claude Code found: $(claude --version 2>/dev/null || echo unknown)"

# ── 2. Register the CallingClaw MCP server (user scope) ──
MCP_INDEX="$PROJECT_DIR/plugins/callingclaw-events/index.ts"
BUN_PATH=$(command -v bun || echo "$HOME/.bun/bin/bun")

# Ensure the MCP plugin deps are installed
( cd "$PROJECT_DIR/plugins/callingclaw-events" && "$BUN_PATH" install --silent ) || warn "bun install for MCP plugin failed"

# Re-register so the path always points at this checkout
claude mcp remove --scope user callingclaw-events &>/dev/null || true
claude mcp add --scope user callingclaw-events \
  -e CALLINGCLAW_HTTP=http://localhost:4000 \
  -e CALLINGCLAW_URL=ws://localhost:4000/ws/events \
  -- "$BUN_PATH" "$MCP_INDEX"
ok "Registered callingclaw-events MCP server (user scope — all Claude Code sessions)"

# ── 3. Set AGENT_PLATFORM=claude-code in .env ──
if [ -f "$PROJECT_DIR/.env" ]; then
  if grep -q "^AGENT_PLATFORM=" "$PROJECT_DIR/.env"; then
    sed -i '' 's/^AGENT_PLATFORM=.*/AGENT_PLATFORM=claude-code/' "$PROJECT_DIR/.env"
  else
    echo "AGENT_PLATFORM=claude-code" >> "$PROJECT_DIR/.env"
  fi
  ok "Set AGENT_PLATFORM=claude-code in .env"
else
  warn ".env not found — run ./scripts/setup.sh first, then re-run this script"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Start CallingClaw:   ./scripts/start.sh"
echo "  2. Talk to it from any Claude Code session:"
echo "     claude \"use the callingclaw tools to report status\""
echo "     claude \"join this meeting: https://meet.google.com/xxx-xxxx-xxx\""
echo ""
echo "  Meeting events (summary ready, prep ready) arrive as live channel"
echo "  notifications inside Claude Code — no polling needed."
