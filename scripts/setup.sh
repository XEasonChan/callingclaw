#!/usr/bin/env bash
# CallingClaw — One-Command Setup
# Installs everything a new user needs: OpenClaw, Bun, dependencies, config.
#
# Usage:
#   ./scripts/setup.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CALLINGCLAW_DIR="$HOME/.callingclaw"

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; exit 1; }
info() { echo -e "${BLUE}→${NC} $1"; }

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║       CallingClaw — Setup                ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ═══════════════════════════════════════════════
# 1. Check & Install Prerequisites
# ═══════════════════════════════════════════════

info "Checking prerequisites..."

# macOS
if [[ "$(uname)" != "Darwin" ]]; then
  fail "CallingClaw requires macOS (uses osascript, BlackHole, Electron)"
fi
ok "macOS detected"

# Node.js (needed for Electron + OpenClaw)
if ! command -v node &>/dev/null; then
  fail "Node.js not found. Install with: brew install node"
fi
NODE_VERSION=$(node --version | sed 's/v//' | cut -d. -f1)
if [[ "$NODE_VERSION" -lt 18 ]]; then
  fail "Node.js 18+ required (found v$NODE_VERSION). Run: brew install node"
fi
ok "Node.js $(node --version)"

# Bun (for CallingClaw backend)
if ! command -v bun &>/dev/null; then
  info "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi
ok "Bun $(bun --version)"

# OpenClaw (AI reasoning engine)
if ! command -v openclaw &>/dev/null; then
  info "Installing OpenClaw..."
  npm install -g openclaw 2>/dev/null
fi
if command -v openclaw &>/dev/null; then
  OPENCLAW_VERSION=$(openclaw --version 2>/dev/null || echo "unknown")
  ok "OpenClaw $OPENCLAW_VERSION"
else
  warn "OpenClaw install failed. Install manually: npm install -g openclaw"
  warn "CallingClaw will work without it (voice, notes, screen — all work)"
  warn "OpenClaw adds: meeting prep, deep reasoning, Telegram delivery"
fi

# cliclick (for screen automation)
if command -v cliclick &>/dev/null; then
  ok "cliclick installed"
else
  warn "cliclick not found (needed for Computer Use screen control)"
  warn "Install with: brew install cliclick"
fi

# BlackHole (optional, for meeting audio)
if system_profiler SPAudioDataType 2>/dev/null | grep -qi blackhole; then
  ok "BlackHole audio driver detected"
else
  warn "BlackHole not found (needed for Google Meet/Zoom audio bridging)"
  warn "Install with: brew install blackhole-2ch blackhole-16ch switchaudio-osx"
  warn "Then restart your Mac"
fi

echo ""

# ═══════════════════════════════════════════════
# 2. Create Directories
# ═══════════════════════════════════════════════

info "Creating directories..."
mkdir -p "$CALLINGCLAW_DIR/shared/prep"
mkdir -p "$CALLINGCLAW_DIR/shared/notes"
mkdir -p "$CALLINGCLAW_DIR/shared/logs"
ok "~/.callingclaw/ ready"

# ═══════════════════════════════════════════════
# 3. Configure .env
# ═══════════════════════════════════════════════

BACKEND_DIR="$PROJECT_DIR/callingclaw-backend"
ENV_FILE="$PROJECT_DIR/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$PROJECT_DIR/.env.example" "$ENV_FILE"
  warn "Created .env — edit it to add your API keys (at minimum: OPENAI_API_KEY)"
else
  ok ".env exists"
fi

# Symlink backend .env → root .env (single source of truth)
if [[ -L "$BACKEND_DIR/.env" ]]; then
  ok "callingclaw-backend/.env → ../.env (symlink)"
elif [[ -f "$BACKEND_DIR/.env" ]]; then
  rm "$BACKEND_DIR/.env"
  ln -s ../.env "$BACKEND_DIR/.env"
  ok "callingclaw-backend/.env → ../.env (replaced with symlink)"
else
  ln -s ../.env "$BACKEND_DIR/.env"
  ok "callingclaw-backend/.env → ../.env (symlink created)"
fi

# ═══════════════════════════════════════════════
# 4. Setup OpenClaw (if installed)
# ═══════════════════════════════════════════════

if command -v openclaw &>/dev/null; then
  if [[ ! -f "$HOME/.openclaw/openclaw.json" ]]; then
    info "Running OpenClaw onboarding (first time setup)..."
    echo ""
    echo "  OpenClaw will ask for your API keys and configure the gateway."
    echo "  You can skip channels (Telegram, etc.) — they're optional."
    echo ""
    openclaw onboard --mode local --no-install-daemon || true
    echo ""
  else
    ok "OpenClaw already configured (~/.openclaw/openclaw.json)"
  fi

  # Read gateway token for .env
  if [[ -f "$HOME/.openclaw/openclaw.json" ]]; then
    TOKEN=$(python3 -c "
import json
try:
    c = json.load(open('$HOME/.openclaw/openclaw.json'))
    print(c.get('gateway',{}).get('auth',{}).get('token',''))
except: pass
" 2>/dev/null || echo "")
    if [[ -n "$TOKEN" && "$TOKEN" != "change-me-to-a-long-random-token" ]]; then
      # Update .env with token (if not already set)
      if grep -q "^# OPENCLAW_GATEWAY_TOKEN" "$ENV_FILE" || ! grep -q "OPENCLAW_GATEWAY_TOKEN" "$ENV_FILE"; then
        sed -i '' "s|^# OPENCLAW_GATEWAY_TOKEN=.*|OPENCLAW_GATEWAY_TOKEN=$TOKEN|" "$ENV_FILE" 2>/dev/null || true
      fi
      ok "OpenClaw gateway token configured in .env"
    fi
  fi
fi

# ═══════════════════════════════════════════════
# 5. Install Dependencies
# ═══════════════════════════════════════════════

info "Installing backend dependencies..."
cd "$BACKEND_DIR" && bun install --silent
ok "Backend dependencies installed"

DESKTOP_DIR="$PROJECT_DIR/callingclaw-desktop"
info "Installing desktop dependencies..."
cd "$DESKTOP_DIR" && npm install --silent 2>/dev/null
ok "Desktop dependencies installed"

# ═══════════════════════════════════════════════
# Done
# ═══════════════════════════════════════════════

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║       Setup Complete!                    ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo ""
echo "  1. Add your API keys to .env:"
echo "     OPENAI_API_KEY=sk-xxx   (required — voice)"
echo "     OPENROUTER_API_KEY=...  (recommended — analysis, vision)"
echo ""
echo "  2. Start everything:"
echo "     ./scripts/start.sh"
echo ""
