#!/bin/bash
# CallingClaw — Raven Agent Setup
# One-command onboarding so you can talk to CallingClaw and launch meetings
# from inside Raven (EverMind-AI's agent CLI).
#
# What this does:
#   1. Locates Raven (RAVEN_BIN → PATH → ~/.local/bin → pipx venv → homebrew)
#   2. Installs the CallingClaw MCP plugin deps (bun install)
#   3. Registers the CallingClaw MCP server in ~/.raven/config.json
#      (non-destructive NODE merge under tools.mcp_servers)
#   4. Seeds an OpenRouter provider + default model + direct executor (no
#      sandbox) into ~/.raven/config.json — only if not already configured
#   5. Sets AGENT_PLATFORM=raven in .env (so the backend uses RavenAdapter)
#
# Usage: ./scripts/setup-raven.sh
#
# CONFIG SCHEMA (empirically confirmed against the installed raven v0.1.1 —
# raven/config/schema.py + config/update.py):
#   • MCP servers live at  tools.mcp_servers.<name>  (NOT top-level — the root
#     Config uses extra="forbid", so a top-level "mcp_servers" key fails schema
#     validation on the next load). Each entry is an MCPServerConfig:
#     { command, args, env, type? (auto-detected → stdio from command) }.
#     There is NO "enabled" field on MCPServerConfig.
#   • Model  → agents.defaults.model      Provider → agents.defaults.provider
#   • Key    → providers.openrouter.apiKey (camelCase; raven onboard reads
#             p.get("apiKey"), and set_provider_fields writes by_alias=True)
#   • Sandbox → tools.sandbox.backend = "none"  (DirectExecutor; boxlite would
#             strip the provider key from the env and break LiteLLM auth, and
#             does not support stdio MCP process spawning).

set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd)"

GREEN='\033[0;32m'; YELLOW='\033[0;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }

echo "=== CallingClaw — Raven Agent Setup ==="
echo ""

# ── 1. Locate Raven ──
# RAVEN_BIN override → PATH → curl/pip install dir → pipx venv → homebrew.
RAVEN_CMD=""
if [ -n "${RAVEN_BIN:-}" ] && [ -x "$RAVEN_BIN" ]; then RAVEN_CMD="$RAVEN_BIN";
elif command -v raven &>/dev/null; then RAVEN_CMD="raven";
elif [ -x "$HOME/.local/bin/raven" ]; then RAVEN_CMD="$HOME/.local/bin/raven";
elif [ -x "$HOME/.local/pipx/venvs/raven/bin/raven" ]; then RAVEN_CMD="$HOME/.local/pipx/venvs/raven/bin/raven";
elif [ -x "/opt/homebrew/bin/raven" ]; then RAVEN_CMD="/opt/homebrew/bin/raven";
elif [ -x "/usr/local/bin/raven" ]; then RAVEN_CMD="/usr/local/bin/raven"; fi

if [ -z "$RAVEN_CMD" ]; then
  warn "Raven not found."
  warn "Install it first, then re-run this script:"
  warn "  • pipx:  pipx install raven-agent          # PyPI"
  warn "    or a pinned git commit:"
  warn "    pipx install 'git+https://github.com/EverMind-AI/Raven.git'"
  warn "  • curl:  curl -fsSL https://raw.githubusercontent.com/EverMind-AI/Raven/main/install.sh | bash"
  warn "  (then set RAVEN_BIN=/path/to/raven if it is not on your PATH)"
  exit 1
fi
ok "Raven found: $("$RAVEN_CMD" --version 2>/dev/null | tr -d '\n' || echo unknown)"

# ── 2. Install the MCP plugin deps ──
MCP_INDEX="$PROJECT_DIR/plugins/callingclaw-events/index.ts"
BUN_PATH="$(command -v bun || echo "$HOME/.bun/bin/bun")"
( cd "$PROJECT_DIR/plugins/callingclaw-events" && "$BUN_PATH" install --silent ) \
  || warn "bun install for MCP plugin failed"

# Prefer a node for the JSON merge (universally available); fall back to bun,
# which is guaranteed present as the backend runtime.
JS_RUNTIME="$(command -v node || echo "$BUN_PATH")"

# ── 2b. Inject the `mcp` Python package into Raven's OWN environment ──
# GOTCHA (empirically confirmed against raven v0.1.1): raven does NOT declare
# `mcp` as a dependency, yet raven/agent/tools/mcp.py does `from mcp import ...`
# LAZILY and SILENTLY swallows the ImportError. The failure mode is invisible —
# raven starts fine, but registers ZERO MCP tools, so the callingclaw-events
# integration this script sets up silently no-ops (no error, no tools, nothing).
# We MUST install `mcp` into raven's interpreter so its MCP client can load.
#
# The import probe is `from mcp.client.stdio import stdio_client` — the exact
# symbol raven/agent/tools/mcp.py needs for a stdio MCP server — NOT a bare
# `import mcp`. A bare `import mcp` can be a FALSE POSITIVE: a leftover empty
# `mcp` namespace dir resolves as a namespace package (import "succeeds" but
# mcp.__file__ is None and no submodules load), so probe a real submodule.
MCP_PROBE="from mcp.client.stdio import stdio_client"
#
# Find raven's python interpreter (the one that runs the console script). For a
# pipx install it's the venv python; for pip/venv it's the interpreter whose
# bin dir holds the raven script. As a fallback, derive it from the raven
# script's shebang.
RAVEN_ABS="$(command -v "$RAVEN_CMD" 2>/dev/null || echo "$RAVEN_CMD")"
RAVEN_PY=""
PIPX_TOOL=0
# 1) pipx tool? (venv dir exists, or `pipx list` names it)
if [ -x "$HOME/.local/pipx/venvs/raven/bin/python" ]; then
  RAVEN_PY="$HOME/.local/pipx/venvs/raven/bin/python"; PIPX_TOOL=1
elif command -v pipx &>/dev/null && pipx list 2>/dev/null | grep -qiE '(^|[^a-z])raven([^a-z]|$)'; then
  PIPX_TOOL=1
  # pipx venv python may live under a different root; probe common spots.
  for p in "$HOME/.local/pipx/venvs/raven/bin/python" \
           "$HOME/.local/pipx/venvs/raven-agent/bin/python"; do
    [ -x "$p" ] && { RAVEN_PY="$p"; break; }
  done
fi
# 2) venv/pip install: python next to the raven script (…/bin/raven → …/bin/python)
if [ -z "$RAVEN_PY" ] && [ -n "$RAVEN_ABS" ]; then
  RAVEN_BINDIR="$(dirname "$RAVEN_ABS")"
  for p in "$RAVEN_BINDIR/python" "$RAVEN_BINDIR/python3"; do
    [ -x "$p" ] && { RAVEN_PY="$p"; break; }
  done
fi
# 3) last resort: read the interpreter from the raven script's shebang
if [ -z "$RAVEN_PY" ] && [ -f "$RAVEN_ABS" ]; then
  SHEBANG_PY="$(head -1 "$RAVEN_ABS" 2>/dev/null | sed -n 's|^#!\(.*/python[0-9.]*\).*|\1|p')"
  [ -n "$SHEBANG_PY" ] && [ -x "$SHEBANG_PY" ] && RAVEN_PY="$SHEBANG_PY"
fi

if [ -z "$RAVEN_PY" ]; then
  warn "Could not locate Raven's Python interpreter to install the 'mcp' package."
  warn "Raven silently registers ZERO MCP tools without it, so the callingclaw"
  warn "integration would no-op. Install manually, then re-run:"
  warn "  pipx inject raven \"mcp>=1.0.0\"    # if installed via pipx"
  warn "  <raven-venv>/bin/pip install \"mcp>=1.0.0\"    # if installed via pip/venv"
  exit 1
fi

# Idempotent: skip the install if the mcp client already imports in raven's env.
if "$RAVEN_PY" -c "$MCP_PROBE" 2>/dev/null; then
  ok "Raven's 'mcp' package already present — skipping install"
else
  if [ "$PIPX_TOOL" = "1" ] && command -v pipx &>/dev/null; then
    ok "Injecting 'mcp' into Raven's pipx venv (pipx inject raven)…"
    pipx inject raven "mcp>=1.0.0" || warn "pipx inject reported an error (will verify below)"
  else
    ok "Installing 'mcp' into Raven's interpreter (pip)…"
    "$RAVEN_PY" -m pip install "mcp>=1.0.0" || warn "pip install reported an error (will verify below)"
  fi
fi

# VERIFY it took — fail LOUDLY if raven still cannot import the mcp client, so a
# broken integration surfaces here instead of silently registering no tools later.
if ! "$RAVEN_PY" -c "$MCP_PROBE" 2>/dev/null; then
  echo -e "${YELLOW}!${NC} FATAL: '$MCP_PROBE' still fails in Raven's environment ($RAVEN_PY)." >&2
  echo -e "${YELLOW}!${NC} Without it Raven silently registers NO MCP tools and the callingclaw" >&2
  echo -e "${YELLOW}!${NC} integration will do nothing. Install it manually and re-run:" >&2
  echo -e "${YELLOW}!${NC}   pipx inject raven \"mcp>=1.0.0\"   (or  $RAVEN_PY -m pip install \"mcp>=1.0.0\")" >&2
  exit 1
fi
ok "Verified: Raven can import 'mcp' ($RAVEN_PY)"

# ── 3. Read OpenRouter key from .env ──
# Strip surrounding quotes and whitespace: a .env written as KEY="sk-or-..." would
# otherwise seed the quotes INTO ~/.raven/config.json and fail auth at first inference.
OPENROUTER_KEY=""
if [ -f "$PROJECT_DIR/.env" ]; then
  OPENROUTER_KEY=$(grep "^OPENROUTER_API_KEY=" "$PROJECT_DIR/.env" 2>/dev/null | cut -d= -f2- \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/" || true)
fi
if [ -z "$OPENROUTER_KEY" ]; then
  warn "OPENROUTER_API_KEY not found in .env — Raven inference won't work until a"
  warn "provider key is set (run 'raven onboard' or add OPENROUTER_API_KEY to .env)."
fi

# Default model seeded into ~/.raven/config.json (overridable via RAVEN_MODEL).
RAVEN_DEFAULT_MODEL="${RAVEN_MODEL:-openrouter/anthropic/claude-sonnet-4.6}"

# ── 4. Prepare ~/.raven + back up any existing config ──
RAVEN_HOME="${RAVEN_HOME:-$HOME/.raven}"
mkdir -p "$RAVEN_HOME"
CONFIG="$RAVEN_HOME/config.json"
if [ -f "$CONFIG" ]; then
  BACKUP="$CONFIG.bak.$(date +%Y%m%d%H%M%S)"
  cp "$CONFIG" "$BACKUP"
  chmod 600 "$BACKUP" 2>/dev/null || true   # backups carry the provider key
  ok "Backed up existing config → $BACKUP"
  # Keep only the 3 most recent backups — each one contains the provider API key,
  # and re-running this script would otherwise accumulate them forever.
  ls -1t "$CONFIG".bak.* 2>/dev/null | tail -n +4 | while read -r old; do rm -f "$old"; done
fi

# ── 5. Non-destructive NODE merge: register callingclaw-events ──
"$JS_RUNTIME" - "$CONFIG" "$MCP_INDEX" "$BUN_PATH" <<'NODE'
const fs = require("fs");
const [configPath, mcpIndex, bunPath] = process.argv.slice(2);

// Read existing config. If the file is non-empty but unparseable, refuse to
// proceed so a corrupt file surfaces loudly (a backup was already made above).
let data = {};
if (fs.existsSync(configPath)) {
  const raw = fs.readFileSync(configPath, "utf8");
  if (raw.trim()) {
    try { data = JSON.parse(raw); }
    catch (e) {
      console.error("✗ Existing " + configPath + " is not valid JSON: " + e.message);
      console.error("  A .bak backup was made. Fix or remove the file, then re-run.");
      process.exit(1);
    }
  }
}

// MCP servers live under tools.mcp_servers (Config.tools.mcp_servers) — NOT at
// the root. Raven's root Config uses extra="forbid", so a top-level
// "mcp_servers" key fails schema validation on the next load.
const tools = (data.tools = data.tools || {});
const servers = (tools.mcp_servers = tools.mcp_servers || {});

// Idempotent: (re)write ONLY our entry, pointed at THIS checkout. Transport
// auto-detects to "stdio" from `command` (raven/agent/tools/mcp.py). Absolute
// bun path so a daemon-spawned raven doesn't need bun on PATH. No `enabled`
// field — MCPServerConfig has none.
servers["callingclaw-events"] = {
  command: bunPath,
  args: [mcpIndex],
  env: {
    CALLINGCLAW_HTTP: "http://localhost:4000",
    CALLINGCLAW_URL: "ws://localhost:4000/ws/events",
  },
};

fs.writeFileSync(configPath, JSON.stringify(data, null, 2) + "\n");
console.log("✓ Registered callingclaw-events under tools.mcp_servers in " + configPath);
NODE

# ── 6. Seed provider + default model + direct executor (only fill gaps) ──
# The provider key travels via the ENVIRONMENT, never argv: argv is world-readable
# through `ps` for the lifetime of the process. Only non-secret args go positionally.
CC_OPENROUTER_KEY="$OPENROUTER_KEY" \
"$JS_RUNTIME" - "$CONFIG" "$RAVEN_DEFAULT_MODEL" <<'NODE'
const fs = require("fs");
const [configPath, defaultModel] = process.argv.slice(2);
const key = process.env.CC_OPENROUTER_KEY || "";

// Read existing config. If the file is non-empty but unparseable, refuse to
// proceed (mirroring the MCP-merge heredoc above) — never clobber a corrupt
// config with a fresh {}. A .bak backup was already made before step 5.
let data = {};
if (fs.existsSync(configPath)) {
  const raw = fs.readFileSync(configPath, "utf8");
  if (raw.trim()) {
    try { data = JSON.parse(raw); }
    catch (e) {
      console.error("✗ Existing " + configPath + " is not valid JSON: " + e.message);
      console.error("  A .bak backup was made. Fix or remove the file, then re-run.");
      process.exit(1);
    }
  }
}

let touched = false;

// Provider key → providers.openrouter.apiKey (camelCase to match raven's own
// reader/writer). Only set if the user hasn't already configured one.
if (key) {
  const providers = (data.providers = data.providers || {});
  const openrouter = (providers.openrouter = providers.openrouter || {});
  if (!openrouter.apiKey) { openrouter.apiKey = key; touched = true; }
}

// Model + provider → agents.defaults.{model,provider}. Only seed if the user
// has NOT already chosen a default model (never clobber a `raven onboard`).
const defaults = ((data.agents = data.agents || {}).defaults = data.agents.defaults || {});
if (!defaults.model) {
  defaults.model = defaultModel;
  defaults.provider = "openrouter";
  touched = true;
}

// Direct executor (no sandbox) → tools.sandbox.backend = "none". Required so
// stdio MCP can spawn and the provider key reaches LiteLLM. Only seed if unset.
const tools = (data.tools = data.tools || {});
const sandbox = (tools.sandbox = tools.sandbox || {});
if (!sandbox.backend) { sandbox.backend = "none"; touched = true; }

if (touched) {
  fs.writeFileSync(configPath, JSON.stringify(data, null, 2) + "\n");
  console.log("✓ Seeded OpenRouter provider + default model + direct executor");
} else {
  console.log("• Provider/model/sandbox already configured — left as-is");
}
NODE
# The config now holds the provider API key in plaintext — keep it owner-only.
chmod 600 "$CONFIG" 2>/dev/null || true
ok "Configured $CONFIG"

# ── 7. Set AGENT_PLATFORM=raven in .env ──
if [ -f "$PROJECT_DIR/.env" ]; then
  if grep -q "^AGENT_PLATFORM=" "$PROJECT_DIR/.env"; then
    sed -i '' 's/^AGENT_PLATFORM=.*/AGENT_PLATFORM=raven/' "$PROJECT_DIR/.env"
  else
    echo "AGENT_PLATFORM=raven" >> "$PROJECT_DIR/.env"
  fi
  ok "Set AGENT_PLATFORM=raven in .env"
else
  warn ".env not found — run ./scripts/setup.sh first, then re-run this script"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Posture: direct executor (no boxlite sandbox). Full host FS, workspace-scoped"
echo "by convention. The 7 callingclaw-events tools are visible in every Raven"
echo "session on this machine (shared ~/.raven/config.json) — that's the"
echo "\"converse from Raven\" feature. Tune the model any time with 'raven onboard'."
echo ""
echo "Next steps:"
echo "  1. Start CallingClaw:  ./scripts/start.sh --no-desktop"
echo "  2. Talk to it via Raven: ./scripts/start-raven.sh"
echo "     or one-shot:          raven agent -m \"use the callingclaw tools to report status\""
echo ""
echo "  Raven has no live channel push — ask it to call callingclaw_recent_events"
echo "  to poll meeting events (summary ready, prep ready)."
