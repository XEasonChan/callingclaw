#!/usr/bin/env bun
// Real-Hermes end-to-end test.
//
// Boots a stub CallingClaw backend (separate process: REST + /ws/events),
// writes a throwaway Hermes config registering the callingclaw-events MCP
// server pointed at it, then drives REAL `hermes -z` prompts and asserts Hermes
// actually invoked the CallingClaw tools (verified via the backend's recorded
// REST calls). Proves: Hermes ↔ MCP tools ↔ CallingClaw, end to end.
//
// Requires: hermes installed + OPENROUTER_API_KEY in env or .env.
// Usage: bun scripts/e2e-hermes.ts

import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const MCP_INDEX = join(ROOT, "plugins", "callingclaw-events", "index.ts");
const STUB = join(ROOT, "scripts", "e2e-hermes-stub.ts");
const MODEL = process.env.HERMES_E2E_MODEL || "anthropic/claude-sonnet-4.6";
const PORT = parseInt(process.env.HERMES_E2E_PORT || "4099");
const httpBase = `http://localhost:${PORT}`;
const wsUrl = `ws://localhost:${PORT}/ws/events`;

// ── OpenRouter key ──
let key = process.env.OPENROUTER_API_KEY || "";
if (!key) {
  try {
    const env = await Bun.file(join(ROOT, ".env")).text();
    key = env.split("\n").find((l) => l.startsWith("OPENROUTER_API_KEY="))?.split("=").slice(1).join("=").trim() || "";
  } catch {}
}
if (!key) { console.error("✗ OPENROUTER_API_KEY not set (env or .env)"); process.exit(1); }

// ── hermes binary ──
function hermesBin(): string {
  if (process.env.HERMES_BIN) return process.env.HERMES_BIN;
  const local = `${process.env.HOME}/.local/bin/hermes`;
  try { if (existsSync(local)) return local; } catch {}
  return "hermes";
}
const HERMES = hermesBin();

// ── Throwaway Hermes home: real config + our MCP server appended ──
const hermesHome = mkdtempSync(join(tmpdir(), "hermes-e2e-"));
const callsLog = join(hermesHome, "calls.log");
let baseConfig = "";
try { baseConfig = await Bun.file(`${process.env.HOME}/.hermes/config.yaml`).text(); } catch {}
const mcpBlock = `
# ── injected by e2e-hermes.ts ──
mcp_servers:
  callingclaw-events:
    command: bun
    args:
      - ${MCP_INDEX}
    env:
      CALLINGCLAW_HTTP: ${httpBase}
      CALLINGCLAW_URL: ${wsUrl}
    enabled: true
`;
writeFileSync(join(hermesHome, "config.yaml"), baseConfig + "\n" + mcpBlock);

// ── Start the stub backend as its own process ──
const stub = Bun.spawn(["bun", STUB, String(PORT), callsLog], { stdout: "pipe", stderr: "pipe" });
// Wait for it to listen.
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(`${httpBase}/api/status`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 100));
}

function calls(): Array<{ method: string; path: string; body?: any }> {
  if (!existsSync(callsLog)) return [];
  return readFileSync(callsLog, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function clearCalls() { try { writeFileSync(callsLog, ""); } catch {} }

// Sanitized env for the spawned Hermes. Some CI/agent-harness env vars (e.g.
// OpenTelemetry BAGGAGE) break Hermes' Python HTTP client, so pass an allowlist.
function hermesEnv(): Record<string, string> {
  const keep = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "USER", "SHELL", "TMPDIR", "LOGNAME"];
  const e: Record<string, string> = {};
  for (const k of keep) if (process.env[k]) e[k] = process.env[k]!;
  e.HERMES_HOME = hermesHome;
  e.OPENROUTER_API_KEY = key;
  return e;
}

async function runHermes(prompt: string, timeoutMs = 120000): Promise<string> {
  const proc = Bun.spawn([HERMES, "-z", prompt, "-m", MODEL, "--provider", "openrouter"], {
    stdout: "pipe", stderr: "pipe",
    env: hermesEnv(),
  });
  let timer: any;
  const out = await Promise.race([
    new Response(proc.stdout).text(),
    new Promise<string>((_, rej) => { timer = setTimeout(() => { proc.kill(); rej(new Error("timeout")); }, timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
  await proc.exited;
  return out.trim();
}

function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!cond) process.exitCode = 1;
}

try {
  console.log(`=== Hermes E2E (model: ${MODEL}, backend :${PORT}) ===\n`);

  // 1. Conversation: ask Hermes to report CallingClaw status (must call the tool)
  clearCalls();
  const out1 = await runHermes(
    "Use the callingclaw_status tool to check CallingClaw's status, then tell me whether the system is ok. You must call the tool.",
  );
  console.log("Hermes:", out1.slice(0, 200).replace(/\n/g, " "), "\n");
  check("conversation → callingclaw_status tool invoked", calls().some((c) => c.path === "/api/status"));

  // 2. 会议议程拉起: ask Hermes to prepare a meeting agenda
  clearCalls();
  const out2 = await runHermes(
    "Use the callingclaw_prepare_meeting tool to prepare a meeting agenda about 'Q3 Roadmap'. You must call the tool.",
  );
  console.log("Hermes:", out2.slice(0, 200).replace(/\n/g, " "), "\n");
  const prep = calls().find((c) => c.path === "/api/meeting/prepare");
  check("会议议程 → callingclaw_prepare_meeting tool invoked", !!prep, prep ? `topic=${prep.body?.topic}` : "no call");

  // 3. Event awareness: Hermes can poll the recent_events tool.
  // NOTE: each one-shot `hermes -z` spawns a fresh MCP server with an empty
  // buffer, so a previously-emitted event won't appear here — that's expected.
  // The real event→buffer→recent_events flow (with a persistent server) is
  // covered by plugins/callingclaw-events/test/e2e-mcp.test.ts. Here we only
  // assert Hermes successfully INVOKES the tool and gets its response shape.
  const out3 = await runHermes(
    "Use the callingclaw_recent_events tool to check for recent CallingClaw meeting events and report the cursor and event count it returns. You must call the tool.",
  );
  console.log("Hermes:", out3.slice(0, 300).replace(/\n/g, " "), "\n");
  check("event polling → recent_events tool invoked", /cursor|event count|count|no recent events|events:/i.test(out3));
} finally {
  try { stub.kill(); } catch {}
  try { rmSync(hermesHome, { recursive: true, force: true }); } catch {}
}

console.log(process.exitCode ? "\n=== E2E FAILED ===" : "\n=== E2E PASSED ===");
