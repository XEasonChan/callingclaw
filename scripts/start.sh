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

# ── 1. OpenClaw Gateway ──

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
      warn "CallingClaw will work without it (voice, notes, screen all work)"
    fi
    sleep 1
  done
else
  warn "OpenClaw not installed — skipping gateway"
  warn "Install with: npm install -g openclaw"
  warn "CallingClaw works without it (voice, notes, screen — all work)"
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
