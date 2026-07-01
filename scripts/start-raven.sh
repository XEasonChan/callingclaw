#!/bin/bash
# CallingClaw — Start a Raven session wired to CallingClaw.
#
# Raven can then converse with CallingClaw and launch meetings via the
# callingclaw-events MCP tools (registered by ./scripts/setup-raven.sh):
#   "what's CallingClaw's status?"        → callingclaw_status
#   "join https://meet.google.com/xyz"    → callingclaw_join_meeting (拉起会议)
#   "prepare an agenda for the Q3 review" → callingclaw_prepare_meeting (会议议程)
#   "any new meeting summaries?"          → callingclaw_recent_events
#
# Usage: ./scripts/start-raven.sh                 # interactive REPL
#        ./scripts/start-raven.sh -m "..."        # one-shot: pass through to `raven agent`
#        ./scripts/start-raven.sh agent -m "..."  # explicit passthrough to raven
#
# Model/provider come from ~/.raven/config.json (seeded by setup-raven.sh) —
# Raven takes NO model flag; do not pass one on the CLI.

set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd)"

# ── Locate Raven (RAVEN_BIN → PATH → ~/.local/bin → pipx venv → homebrew) ──
RAVEN_CMD=""
if [ -n "${RAVEN_BIN:-}" ] && [ -x "$RAVEN_BIN" ]; then RAVEN_CMD="$RAVEN_BIN";
elif command -v raven &>/dev/null; then RAVEN_CMD="raven";
elif [ -x "$HOME/.local/bin/raven" ]; then RAVEN_CMD="$HOME/.local/bin/raven";
elif [ -x "$HOME/.local/pipx/venvs/raven/bin/raven" ]; then RAVEN_CMD="$HOME/.local/pipx/venvs/raven/bin/raven";
elif [ -x "/opt/homebrew/bin/raven" ]; then RAVEN_CMD="/opt/homebrew/bin/raven";
elif [ -x "/usr/local/bin/raven" ]; then RAVEN_CMD="/usr/local/bin/raven"; fi
[ -n "$RAVEN_CMD" ] || { echo "Raven not found — run ./scripts/setup-raven.sh first."; exit 1; }

# Export OpenRouter key so Raven inference works (Raven also reads it from its
# own config, but exporting matches the sibling start scripts and covers the
# provider="auto" env-detection path).
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
  # If the caller starts with a raven subcommand (agent/onboard/...), pass
  # through verbatim; otherwise treat args as a one-shot message for `raven agent`.
  case "${1:-}" in
    agent|onboard|provider|channels|tui|cron|doctor|-*)
      # For a bare "-m ..." (message) we still need the `agent` subcommand.
      if [ "${1:0:1}" = "-" ]; then
        exec "$RAVEN_CMD" agent "$@"
      else
        exec "$RAVEN_CMD" "$@"
      fi
      ;;
    *)
      exec "$RAVEN_CMD" agent -m "$*"
      ;;
  esac
else
  echo "Starting Raven (CallingClaw MCP tools available). Ctrl+C to exit."
  exec "$RAVEN_CMD"
fi
