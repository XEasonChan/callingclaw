#!/bin/bash
# CallingClaw — Claude Code Channels Setup
# One-command onboarding for Telegram integration via Claude Code.
#
# What this does:
#   1. Checks Claude Code is installed
#   2. Installs the Telegram channel plugin
#   3. Installs MCP SDK for the CallingClaw events channel
#   4. Configures Telegram bot token (reuses OpenClaw's if available)
#
# Usage: ./scripts/setup-claude-channels.sh

set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== CallingClaw — Claude Code Channels Setup ==="
echo ""

# ── 1. Check Claude Code ──
if ! command -v claude &>/dev/null; then
  echo "ERROR: Claude Code not found."
  echo "Install it from https://claude.ai/code"
  exit 1
fi
CLAUDE_VERSION=$(claude --version 2>/dev/null || echo "unknown")
echo "[OK] Claude Code found: $CLAUDE_VERSION"

# ── 2. Install Telegram plugin ──
echo ""
echo "Installing Telegram channel plugin..."
claude /plugin install telegram@claude-plugins-official 2>/dev/null || {
  echo "NOTE: Plugin may already be installed or marketplace needs refresh."
  echo "Try: claude /plugin marketplace update claude-plugins-official"
}
echo "[OK] Telegram plugin ready"

# ── 3. Install CallingClaw events channel dependencies ──
echo ""
echo "Installing CallingClaw events channel dependencies..."
cd plugins/callingclaw-events
bun install --silent
cd - >/dev/null
echo "[OK] MCP SDK installed"

# ── 4. Configure Telegram bot token ──
echo ""
EXISTING_TOKEN=""

# Try to reuse OpenClaw's bot token
if [ -f "$HOME/.openclaw/openclaw.json" ]; then
  EXISTING_TOKEN=$(jq -r '.channels.telegram.botToken // empty' "$HOME/.openclaw/openclaw.json" 2>/dev/null || true)
fi

# Try existing Claude channels config
if [ -z "$EXISTING_TOKEN" ] && [ -f "$HOME/.claude/channels/telegram/.env" ]; then
  EXISTING_TOKEN=$(grep -oP 'TELEGRAM_BOT_TOKEN=\K.*' "$HOME/.claude/channels/telegram/.env" 2>/dev/null || true)
fi

if [ -n "$EXISTING_TOKEN" ]; then
  echo "Found existing Telegram bot token."
  read -p "Use it? [Y/n] " USE_EXISTING
  if [[ "${USE_EXISTING:-Y}" =~ ^[Nn] ]]; then
    EXISTING_TOKEN=""
  fi
fi

if [ -z "$EXISTING_TOKEN" ]; then
  echo "Create a Telegram bot:"
  echo "  1. Open @BotFather in Telegram"
  echo "  2. Send /newbot"
  echo "  3. Copy the token"
  echo ""
  read -p "Telegram Bot Token: " EXISTING_TOKEN
fi

if [ -n "$EXISTING_TOKEN" ]; then
  mkdir -p "$HOME/.claude/channels/telegram"
  echo "TELEGRAM_BOT_TOKEN=$EXISTING_TOKEN" > "$HOME/.claude/channels/telegram/.env"
  echo "[OK] Bot token saved to ~/.claude/channels/telegram/.env"
else
  echo "WARNING: No bot token configured. Telegram channel won't work until configured."
  echo "Run: /telegram:configure <token> inside Claude Code"
fi

# ── Done ──
echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Start CallingClaw:  ./scripts/start.sh --no-desktop"
echo "  2. Start channels:     ./scripts/start-claude-channels.sh"
echo "  3. Pair Telegram:      Send any message to your bot, then run:"
echo "                         /telegram:access pair <code>"
echo "                         /telegram:access policy allowlist"
