#!/bin/bash
# CallingClaw — Start an interactive Hermes session wired to CallingClaw.
#
# Hermes can then converse with CallingClaw and launch meetings via the
# callingclaw-events MCP tools (registered by ./scripts/setup-hermes.sh):
#   "what's CallingClaw's status?"        → callingclaw_status
#   "join https://meet.google.com/xyz"    → callingclaw_join_meeting (拉起会议)
#   "prepare an agenda for the Q3 review" → callingclaw_prepare_meeting (会议议程)
#   "any new meeting summaries?"          → callingclaw_recent_events
#
# Usage: ./scripts/start-hermes.sh          # interactive
#        ./scripts/start-hermes.sh -z "..." # one-shot, pass through to hermes -z

set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd)"

HERMES_CMD=""
if command -v hermes &>/dev/null; then HERMES_CMD="hermes";
elif [ -x "$HOME/.local/bin/hermes" ]; then HERMES_CMD="$HOME/.local/bin/hermes"; fi
[ -n "$HERMES_CMD" ] || { echo "Hermes not found — run ./scripts/setup-hermes.sh first."; exit 1; }

# Export OpenRouter key so Hermes inference works.
if [ -f "$PROJECT_DIR/.env" ]; then
  KEY=$(grep "^OPENROUTER_API_KEY=" "$PROJECT_DIR/.env" 2>/dev/null | cut -d= -f2- || true)
  [ -n "$KEY" ] && export OPENROUTER_API_KEY="$KEY"
fi

# Warn if the backend isn't up (tools will fail without it).
if ! curl -sf http://localhost:4000/api/status >/dev/null 2>&1; then
  echo "WARNING: CallingClaw backend not running on :4000"
  echo "Start it first: ./scripts/start.sh --no-desktop"
  echo ""
fi

if [ "$#" -gt 0 ]; then
  exec "$HERMES_CMD" "$@"
else
  echo "Starting Hermes (CallingClaw MCP tools available). Ctrl+C to exit."
  exec "$HERMES_CMD"
fi
