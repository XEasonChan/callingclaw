---
name: hermes-setup-pyyaml-fallback-clobbers-config
description: scripts/setup-hermes.sh destructively overwrites ~/.hermes/config.yaml when PyYAML is missing
metadata:
  type: project
---

`scripts/setup-hermes.sh` registers the callingclaw-events MCP server by running a `python3` block that uses PyYAML to merge into `~/.hermes/config.yaml`. If PyYAML is absent it falls into a fallback branch that **writes a fresh ~15-line minimal config**, clobbering the full ~60KB config (model defaults, terminal, memory, agent personalities, etc.).

**Why:** The user's system `python3` is Homebrew (externally-managed, PEP 668) with no PyYAML, and `pip install pyyaml` is blocked. Hermes ships its own venv python WITH PyYAML at `~/.hermes/hermes-agent/venv/bin/python`, but you can't expose it as `python3` via a PATH symlink — venv detection breaks (it needs the adjacent `pyvenv.cfg`), so it silently runs base python without yaml → fallback fires anyway.

**How to apply:** Before running setup-hermes.sh, back up `~/.hermes/config.yaml`. The only thing genuinely missing in a working Hermes config is the `mcp_servers:` block — the OpenRouter wiring already exists via `model.base_url: https://openrouter.ai/api/v1` + `OPENROUTER_API_KEY` env. Safest fix is to append just the `mcp_servers.callingclaw-events` block (command `bun`, args = abs path to `plugins/callingclaw-events/index.ts`, env CALLINGCLAW_HTTP/CALLINGCLAW_URL → localhost:4000) rather than running the script. Verify with `hermes mcp test callingclaw-events`. The script's `inference:`/`providers:` keys are a different schema and unnecessary.
