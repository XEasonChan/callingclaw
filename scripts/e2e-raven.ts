#!/usr/bin/env bun
// Real-Raven end-to-end acceptance test for the Raven ↔ CallingClaw integration.
//
// Boots a stub CallingClaw backend (separate process: REST + /ws/events),
// writes a THROWAWAY, fully isolated Raven config that registers the
// callingclaw-events MCP server pointed at the stub, then drives a REAL
// `raven agent -m` prompt with real OpenRouter inference and asserts:
//
//   (a) the stub backend RECORDED a real GET /api/status   → proves the MCP
//       tool was genuinely invoked (not hallucinated by the model), and
//   (b) the recognizable version string from the stub appears in Raven's
//       stdout → proves the full round-trip:
//         raven → MCP stdio → callingclaw-events → HTTP → back → model answer.
//
// Isolation: uses a temp dir for RAVEN_HOME + `--config <temp>/config.json` and
// a temp workspace. It NEVER touches the user's real ~/.raven or the real .env.
// The OpenRouter key is read (read-only) from the MAIN repo .env.
//
// Requires: raven installed (v0.1.1+) + `mcp` python package injected into
//   raven's venv (pipx inject raven mcp) + OPENROUTER_API_KEY in the main .env.
// Usage: bun scripts/e2e-raven.ts
//
// Real inference spends a tiny amount of OpenRouter credit. That is intended.

import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const PLUGIN_DIR = join(ROOT, "plugins", "callingclaw-events");
const MCP_INDEX = join(PLUGIN_DIR, "index.ts");
const STUB = join(ROOT, "scripts", "e2e-raven-stub.ts");
// Model lives in the config file — Raven takes NO model flag (see design doc).
const MODEL = process.env.RAVEN_E2E_MODEL || "openrouter/anthropic/claude-sonnet-4.6";
const PORT = parseInt(process.env.RAVEN_E2E_PORT || "4097");
// Recognizable version string the model must echo back to prove the round-trip.
const VERSION = `CC-RAVEN-E2E-${Date.now().toString().slice(-6)}`;
const httpBase = `http://localhost:${PORT}`;
const wsUrl = `ws://localhost:${PORT}/ws/events`;

// ── OpenRouter key (read-only, from the MAIN repo .env; never mutated) ──
// This worktree has no .env of its own; read the main checkout's .env.
const MAIN_ENV = "/Users/admin/Library/Mobile Documents/com~apple~CloudDocs/CallingClaw 2.0/.env";
let key = process.env.OPENROUTER_API_KEY || "";
if (!key) {
  for (const envPath of [MAIN_ENV, join(ROOT, ".env")]) {
    try {
      const env = readFileSync(envPath, "utf-8");
      key =
        env.split("\n").find((l) => l.startsWith("OPENROUTER_API_KEY="))
          ?.split("=").slice(1).join("=").trim() || "";
      if (key) break;
    } catch {}
  }
}
if (!key) {
  console.error("✗ OPENROUTER_API_KEY not found (env or main .env). Cannot run real inference — stopping.");
  process.exit(1);
}

// ── raven binary (RAVEN_BIN → PATH → ~/.local/bin → pipx venv → homebrew) ──
function ravenBin(): string {
  if (process.env.RAVEN_BIN) return process.env.RAVEN_BIN;
  const candidates = [
    `${process.env.HOME}/.local/bin/raven`,
    `${process.env.HOME}/.local/pipx/venvs/raven/bin/raven`,
    "/opt/homebrew/bin/raven",
    "/usr/local/bin/raven",
  ];
  for (const c of candidates) { try { if (existsSync(c)) return c; } catch {} }
  return "raven";
}
const RAVEN = ravenBin();

// ── absolute bun path (daemon-spawned raven may not have bun on PATH) ──
function bunBin(): string {
  for (const c of ["/opt/homebrew/bin/bun", `${process.env.HOME}/.bun/bin/bun`, "/usr/local/bin/bun"]) {
    try { if (existsSync(c)) return c; } catch {}
  }
  return process.execPath; // running under bun already
}
const BUN = bunBin();

// ── Ensure the MCP plugin deps are installed ──
if (!existsSync(join(PLUGIN_DIR, "node_modules"))) {
  console.log("• Installing MCP plugin deps (bun install)…");
  const inst = Bun.spawnSync([BUN, "install", "--silent"], { cwd: PLUGIN_DIR });
  if (inst.exitCode !== 0) {
    console.error("✗ bun install for the MCP plugin failed");
    process.exit(1);
  }
}

// ── Isolated throwaway Raven home + config ──
// Passing --config <dir>/config.json makes raven derive ALL runtime dirs
// (media/cron/sentinel/cache/sandbox/logs) from the config's parent dir, so
// nothing lands in the user's real ~/.raven. Workspace is a separate temp dir
// passed via -w.
const ravenHome = mkdtempSync(join(tmpdir(), "raven-e2e-home-"));
const workspace = join(ravenHome, "workspace");
mkdirSync(workspace, { recursive: true });
const configPath = join(ravenHome, "config.json");
const callsLog = join(ravenHome, "calls.log");

// Complete, self-sufficient config so `raven agent` runs headless (no onboarding).
// Schema (empirically confirmed against raven v0.1.1):
//   - MCP servers NESTED at tools.mcp_servers.<name> (top-level bricks load: extra="forbid")
//   - sandbox.backend="none" so the stdio MCP server can be spawned as a subprocess
//   - provider key at providers.openrouter.apiKey (camelCase)
//   - model/provider at agents.defaults.{model,provider}
const config = {
  tools: {
    sandbox: { backend: "none" },
    mcp_servers: {
      "callingclaw-events": {
        command: BUN,
        args: [MCP_INDEX],
        env: {
          CALLINGCLAW_HTTP: httpBase,
          CALLINGCLAW_URL: wsUrl,
        },
      },
    },
  },
  providers: { openrouter: { apiKey: key } },
  agents: { defaults: { model: MODEL, provider: "openrouter" } },
};
writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

// ── Start the stub backend as its own process ──
const stub = Bun.spawn([BUN, STUB, String(PORT), callsLog, VERSION], { stdout: "pipe", stderr: "pipe" });
// Wait for it to listen.
let up = false;
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(`${httpBase}/api/status`)).ok) { up = true; break; } } catch {}
  await new Promise((r) => setTimeout(r, 100));
}
if (!up) {
  console.error("✗ stub backend did not come up on :" + PORT);
  try { stub.kill(); } catch {}
  process.exit(1);
}

function calls(): Array<{ method: string; path: string; body?: any }> {
  if (!existsSync(callsLog)) return [];
  return readFileSync(callsLog, "utf-8").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return { method: "", path: "" }; }
  });
}
function clearCalls() { try { writeFileSync(callsLog, ""); } catch {} }

// Sanitized env for the spawned Raven (allowlist, like e2e-hermes' hermesEnv()).
// Some agent-harness env vars (e.g. OpenTelemetry BAGGAGE) can break HTTP clients,
// so pass only what raven + the MCP stdio subprocess need. RAVEN_HOME is set for
// the one path (runtime/) that reads it; --config covers the rest.
function ravenEnv(): Record<string, string> {
  const keep = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "USER", "SHELL", "TMPDIR", "LOGNAME"];
  const e: Record<string, string> = {};
  for (const k of keep) if (process.env[k]) e[k] = process.env[k]!;
  e.RAVEN_HOME = ravenHome;
  e.OPENROUTER_API_KEY = key;
  return e;
}

async function runRaven(prompt: string, timeoutMs = 150000): Promise<string> {
  const proc = Bun.spawn(
    [RAVEN, "agent", "-m", prompt, "--config", configPath, "-w", workspace, "--no-markdown", "--no-logs"],
    { stdout: "pipe", stderr: "pipe", env: ravenEnv() },
  );
  let timer: any;
  const out = await Promise.race([
    new Response(proc.stdout).text(),
    new Promise<string>((_, rej) => {
      timer = setTimeout(() => { try { proc.kill(); } catch {} rej(new Error("timeout")); }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
  await proc.exited;
  return out.trim();
}

let failed = false;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!cond) { failed = true; process.exitCode = 1; }
}

try {
  console.log(`=== Raven E2E (model: ${MODEL}, backend :${PORT}, version: ${VERSION}) ===\n`);
  console.log(`  raven:  ${RAVEN}`);
  console.log(`  bun:    ${BUN}`);
  console.log(`  config: ${configPath}\n`);

  clearCalls();
  const out = await runRaven(
    "Use the callingclaw_status tool and tell me CallingClaw's status/version. You must call the tool and report the exact version string.",
  );
  console.log("── Raven output ─────────────────────────────────────");
  console.log(out);
  console.log("─────────────────────────────────────────────────────\n");

  const recorded = calls();
  const statusHit = recorded.some((c) => c.path === "/api/status");

  // (a) the MCP tool was genuinely invoked (stub recorded the HTTP hit)
  check(
    "(a) MCP tool invoked → stub recorded GET /api/status",
    statusHit,
    `recorded paths: [${recorded.map((c) => c.path).join(", ") || "none"}]`,
  );
  // (b) the round-trip closed: the stub's version string reached the model output
  check(
    "(b) round-trip → stub version string present in Raven output",
    out.includes(VERSION),
    `looking for "${VERSION}"`,
  );
} catch (e: any) {
  console.error("✗ E2E threw:", e?.message || e);
  failed = true;
  process.exitCode = 1;
} finally {
  try { stub.kill(); } catch {}
  try { rmSync(ravenHome, { recursive: true, force: true }); } catch {}
}

console.log(failed ? "\n=== E2E FAILED ===" : "\n=== E2E PASSED (both assertions) ===");
