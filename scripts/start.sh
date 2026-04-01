#!/usr/bin/env bash
# CallingClaw — Start
#
# Usage:
#   ./scripts/start.sh              # start OpenClaw + backend + desktop
#   ./scripts/start.sh --no-desktop # headless (API + voice-test.html only)
#   ./scripts/start.sh --only-backend # just CallingClaw backend

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

NO_DESKTOP=false
ONLY_BACKEND=false
for arg in "$@"; do
  case "$arg" in
    --no-desktop)   NO_DESKTOP=true ;;
    --only-backend) ONLY_BACKEND=true; NO_DESKTOP=true ;;
  esac
done

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${BLUE}→${NC} $1"; }
ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }

# ── 1. Agent Platform ──

# Read AGENT_PLATFORM from .env if set
AGENT_PLATFORM=""
if [[ -f "$PROJECT_DIR/.env" ]]; then
  AGENT_PLATFORM=$(grep "^AGENT_PLATFORM=" "$PROJECT_DIR/.env" 2>/dev/null | cut -d= -f2 || echo "")
fi

# Auto-detect if not set
if [[ -z "$AGENT_PLATFORM" ]]; then
  if command -v openclaw &>/dev/null; then
    AGENT_PLATFORM="openclaw"
  elif command -v claude &>/dev/null; then
    AGENT_PLATFORM="claude-code"
  else
    AGENT_PLATFORM="standalone"
  fi
fi

if [[ "$AGENT_PLATFORM" == "openclaw" ]]; then
  if curl -sf http://localhost:18789/healthz &>/dev/null; then
    ok "OpenClaw gateway already running on :18789"
  elif command -v openclaw &>/dev/null; then
    info "Starting OpenClaw gateway..."
    nohup openclaw gateway --port 18789 > /tmp/openclaw-gateway.log 2>&1 &
    echo "$!" > /tmp/openclaw-gateway.pid

    for i in $(seq 1 30); do
      if curl -sf http://localhost:18789/healthz &>/dev/null; then
        ok "OpenClaw gateway ready on :18789"
        break
      fi
      if [[ $i -eq 30 ]]; then
        warn "OpenClaw gateway not responding. Check: tail -f /tmp/openclaw-gateway.log"
        warn "Falling back to standalone mode"
      fi
      sleep 1
    done
  fi
elif [[ "$AGENT_PLATFORM" == "claude-code" ]]; then
  if command -v claude &>/dev/null; then
    ok "Agent platform: Claude Code ($(claude --version 2>/dev/null || echo 'unknown'))"
  else
    warn "Claude Code CLI not found — falling back to standalone"
  fi
else
  ok "Agent platform: standalone (voice, notes, screen — all work without external agent)"
fi

# ── 2. CallingClaw Backend ──

if curl -sf http://localhost:4000/api/status &>/dev/null; then
  ok "CallingClaw backend already running on :4000"
else
  info "Starting CallingClaw backend..."
  cd "$PROJECT_DIR/callingclaw-backend"
  BUN_PATH=$(command -v bun || echo "$HOME/.bun/bin/bun")
  nohup "$BUN_PATH" run src/callingclaw.ts > /tmp/callingclaw-backend.log 2>&1 &
  BACKEND_PID=$!
  echo "$BACKEND_PID" > /tmp/callingclaw-backend.pid

  for i in $(seq 1 15); do
    if curl -sf http://localhost:4000/api/status &>/dev/null; then
      ok "CallingClaw backend ready on :4000 (PID: $BACKEND_PID)"
      break
    fi
    if [[ $i -eq 15 ]]; then
      warn "Backend not responding. Check: tail -f /tmp/callingclaw-backend.log"
    fi
    sleep 1
  done
fi

# ── 3. Desktop App ──

if [[ "$NO_DESKTOP" == false ]]; then
  info "Starting CallingClaw Desktop..."
  cd "$PROJECT_DIR/callingclaw-desktop"
  npm start
else
  echo ""
  ok "Stack running"
  echo "  OpenClaw:  http://localhost:18789/healthz"
  echo "  Backend:   http://localhost:4000/api/status"
  echo "  Voice UI:  http://localhost:4000/voice-test.html"
  echo ""
  echo "  Logs:  tail -f /tmp/callingclaw-backend.log"
  echo "  Stop:  ./scripts/stop.sh"
fi
