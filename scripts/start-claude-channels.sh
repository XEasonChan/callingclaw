#!/bin/bash
# CallingClaw — Start Claude Code with Telegram + CallingClaw event channels
#
# This starts a persistent Claude Code session that:
#   - Receives Telegram messages via the official Telegram channel plugin
#   - Receives CallingClaw events (meeting.ended, prep.ready, etc.) via custom channel
#   - Uses /callingclaw skill to interact with the backend on localhost:4000
#
# Usage: ./scripts/start-claude-channels.sh
#
# The session persists across restarts via --resume.
# For unattended use, permissions are bypassed (trust boundary: localhost + Telegram allowlist).

set -euo pipefail
cd "$(dirname "$0")/.."

# Ensure CallingClaw backend is running
if ! curl -sf http://localhost:4000/api/status >/dev/null 2>&1; then
  echo "WARNING: CallingClaw backend not running on :4000"
  echo "Start it first: ./scripts/start.sh --no-desktop"
  echo ""
fi

echo "Starting Claude Code with Telegram + CallingClaw channels..."
echo "  - Telegram: inbound/outbound user messages"
echo "  - CallingClaw: meeting events (summary, prep, voice state)"
echo ""
echo "Send a message to your Telegram bot to interact."
echo "Press Ctrl+C to stop."
echo ""

exec claude --resume callingclaw-channels \
  --channels plugin:telegram@claude-plugins-official \
  --dangerously-load-development-channels server:callingclaw-events \
  --add-dir "$HOME/.callingclaw" \
  --permission-mode bypassPermissions
