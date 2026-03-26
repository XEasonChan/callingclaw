#!/usr/bin/env bash
# CallingClaw — Stop all services

set -euo pipefail

GREEN='\033[0;32m'
NC='\033[0m'

ok() { echo -e "${GREEN}✓${NC} $1"; }

# ── Stop CallingClaw Backend ──

if [[ -f /tmp/callingclaw-backend.pid ]]; then
  PID=$(cat /tmp/callingclaw-backend.pid)
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    ok "CallingClaw backend stopped (PID: $PID)"
  fi
  rm -f /tmp/callingclaw-backend.pid
elif lsof -ti :4000 &>/dev/null; then
  kill $(lsof -ti :4000) 2>/dev/null || true
  ok "CallingClaw backend stopped (port 4000)"
else
  ok "CallingClaw backend not running"
fi

# ── Stop OpenClaw Gateway ──

if [[ -f /tmp/openclaw-gateway.pid ]]; then
  PID=$(cat /tmp/openclaw-gateway.pid)
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    ok "OpenClaw gateway stopped (PID: $PID)"
  fi
  rm -f /tmp/openclaw-gateway.pid
elif lsof -ti :18789 &>/dev/null; then
  kill $(lsof -ti :18789) 2>/dev/null || true
  ok "OpenClaw gateway stopped (port 18789)"
else
  ok "OpenClaw gateway not running"
fi

echo ""
echo "All services stopped."
