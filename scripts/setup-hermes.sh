#!/bin/bash
# CallingClaw — Hermes Agent Setup
# One-command onboarding so you can talk to CallingClaw and launch meetings
# from inside Hermes Agent (NousResearch).
#
# What this does:
#   1. Installs Hermes Agent if missing (official installer)
#   2. Registers the CallingClaw MCP server in ~/.hermes/config.yaml
#   3. Wires Hermes inference to your OpenRouter key (from .env)
#   4. Sets AGENT_PLATFORM=hermes in .env (so the backend uses HermesAdapter)
#
# Usage: ./scripts/setup-hermes.sh

set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd)"

GREEN='\033[0;32m'; YELLOW='\033[0;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }

echo "=== CallingClaw — Hermes Agent Setup ==="
echo ""

# ── 1. Install Hermes if missing ──
HERMES_CMD=""
if command -v hermes &>/dev/null; then HERMES_CMD="hermes";
elif [ -x "$HOME/.local/bin/hermes" ]; then HERMES_CMD="$HOME/.local/bin/hermes"; fi

if [ -z "$HERMES_CMD" ]; then
  echo "Hermes not found. Installing via the official NousResearch installer..."
  echo "  (source: https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh)"
  curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --skip-setup
  if [ -x "$HOME/.local/bin/hermes" ]; then HERMES_CMD="$HOME/.local/bin/hermes";
  elif command -v hermes &>/dev/null; then HERMES_CMD="hermes"; fi
fi
[ -n "$HERMES_CMD" ] || { warn "Hermes install failed — install manually then re-run."; exit 1; }
ok "Hermes found: $("$HERMES_CMD" --version 2>/dev/null || echo unknown)"

# ── 2. Read OpenRouter key from .env ──
OPENROUTER_KEY=""
if [ -f "$PROJECT_DIR/.env" ]; then
  OPENROUTER_KEY=$(grep "^OPENROUTER_API_KEY=" "$PROJECT_DIR/.env" 2>/dev/null | cut -d= -f2- || true)
fi
if [ -z "$OPENROUTER_KEY" ]; then
  warn "OPENROUTER_API_KEY not found in .env — Hermes inference may not work until set."
fi

# ── 3. Register the CallingClaw MCP server in ~/.hermes/config.yaml ──
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
mkdir -p "$HERMES_HOME"
CONFIG="$HERMES_HOME/config.yaml"
MCP_INDEX="$PROJECT_DIR/plugins/callingclaw-events/index.ts"

# Ensure the MCP plugin deps are installed
( cd "$PROJECT_DIR/plugins/callingclaw-events" && bun install --silent ) || warn "bun install for MCP plugin failed"

python3 - "$CONFIG" "$MCP_INDEX" "$OPENROUTER_KEY" <<'PY'
import sys, os
config_path, mcp_index, openrouter_key = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    import yaml
except Exception:
    yaml = None

data = {}
if os.path.exists(config_path) and yaml:
    with open(config_path) as f:
        data = yaml.safe_load(f) or {}

if yaml is None:
    print("! PyYAML not available — writing a fresh minimal config (back up existing first if needed).")

servers = data.setdefault("mcp_servers", {})
servers["callingclaw-events"] = {
    "command": "bun",
    "args": [mcp_index],
    "env": {
        "CALLINGCLAW_HTTP": "http://localhost:4000",
        "CALLINGCLAW_URL": "ws://localhost:4000/ws/events",
    },
    "enabled": True,
}

# Prefer OpenRouter inference if a key is present.
if openrouter_key:
    data.setdefault("inference", {})
    data["inference"]["provider"] = "openrouter"
    prov = data.setdefault("providers", {}).setdefault("openrouter", {})
    prov["api_key"] = openrouter_key

if yaml:
    with open(config_path, "w") as f:
        yaml.safe_dump(data, f, sort_keys=False, default_flow_style=False)
    print("✓ Wrote", config_path)
else:
    # Minimal hand-written YAML fallback
    lines = ["mcp_servers:",
             "  callingclaw-events:",
             "    command: bun",
             f"    args:",
             f"      - {mcp_index}",
             "    env:",
             "      CALLINGCLAW_HTTP: http://localhost:4000",
             "      CALLINGCLAW_URL: ws://localhost:4000/ws/events",
             "    enabled: true"]
    if openrouter_key:
        lines += ["inference:", "  provider: openrouter",
                  "providers:", "  openrouter:", f"    api_key: {openrouter_key}"]
    with open(config_path, "w") as f:
        f.write("\n".join(lines) + "\n")
    print("✓ Wrote (fallback)", config_path)
PY
ok "Registered callingclaw-events MCP server in $CONFIG"

# ── 4. Set AGENT_PLATFORM=hermes in .env ──
if [ -f "$PROJECT_DIR/.env" ]; then
  if grep -q "^AGENT_PLATFORM=" "$PROJECT_DIR/.env"; then
    sed -i '' 's/^AGENT_PLATFORM=.*/AGENT_PLATFORM=hermes/' "$PROJECT_DIR/.env"
  else
    echo "AGENT_PLATFORM=hermes" >> "$PROJECT_DIR/.env"
  fi
  ok "Set AGENT_PLATFORM=hermes in .env"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Start CallingClaw:  ./scripts/start.sh --no-desktop"
echo "  2. Talk to it via Hermes: ./scripts/start-hermes.sh"
echo "     or one-shot:           hermes -z \"use callingclaw tools to report status\""
