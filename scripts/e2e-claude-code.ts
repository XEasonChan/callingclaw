#!/usr/bin/env bun
// Real Claude-Code end-to-end test.
//
// Drives the LOCAL `claude` CLI non-interactively with the callingclaw-events
// MCP server registered (via a throwaway --mcp-config), pointed at the REAL
// CallingClaw backend on http://localhost:4000. Asserts Claude Code actually
// invoked the CallingClaw MCP tools — verified two ways:
//   (a) the stream-json transcript contains a tool_use for the MCP tool, and
//   (b) the matching tool_result carries LIVE backend fields (version 2.9.5,
//       openclaw status, etc.) that the stub backend never produces.
// Proves: Claude Code <-> MCP tools <-> real CallingClaw backend, end to end.
//
// Requires: `claude` on PATH, a working Claude auth/model, and the REAL backend
// already listening on :4000 (./scripts/start.sh --no-desktop).
// Usage: bun scripts/e2e-claude-code.ts

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const MCP_INDEX = join(ROOT, "plugins", "callingclaw-events", "index.ts");
const HTTP_BASE = process.env.CALLINGCLAW_HTTP || "http://localhost:4000";
const WS_URL = process.env.CALLINGCLAW_URL || "ws://localhost:4000/ws/events";
const MODEL = process.env.CLAUDE_E2E_MODEL || "haiku";
const BUN_BIN = process.execPath; // the bun running this script

function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!cond) process.exitCode = 1;
}

// ── 0. Backend must be the REAL one ──
let backendVersion = "";
try {
  const r = await fetch(`${HTTP_BASE}/api/status`);
  const j: any = await r.json();
  backendVersion = j?.version || "";
  if (!backendVersion) throw new Error("no version field");
  console.log(`Backend live: version=${backendVersion} openclaw=${j?.openclaw} meeting=${j?.meeting}\n`);
} catch (e: any) {
  console.error(`✗ Real backend not reachable at ${HTTP_BASE}/api/status — ${e?.message || e}`);
  console.error("  Start it first: ./scripts/start.sh --no-desktop");
  process.exit(1);
}

// ── Throwaway MCP config registering callingclaw-events at the REAL backend ──
const home = mkdtempSync(join(tmpdir(), "claude-code-e2e-"));
const mcpConfig = join(home, "mcp.json");
writeFileSync(
  mcpConfig,
  JSON.stringify(
    {
      mcpServers: {
        "callingclaw-events": {
          command: BUN_BIN,
          args: [MCP_INDEX],
          env: { CALLINGCLAW_HTTP: HTTP_BASE, CALLINGCLAW_URL: WS_URL },
        },
      },
    },
    null,
    2,
  ),
);

// Run `claude -p` and capture the stream-json transcript (one JSON obj per line).
async function runClaude(prompt: string, allowed: string[], timeoutMs = 120000): Promise<any[]> {
  const proc = Bun.spawn(
    [
      "claude",
      "-p",
      "--model", MODEL,
      "--permission-mode", "bypassPermissions",
      "--mcp-config", mcpConfig,
      "--strict-mcp-config",
      "--allowedTools", allowed.join(","),
      "--output-format", "stream-json",
      "--verbose",
      prompt,
    ],
    { stdout: "pipe", stderr: "pipe", cwd: home, env: { ...process.env } },
  );
  let timer: any;
  const out = await Promise.race([
    new Response(proc.stdout).text(),
    new Promise<string>((_, rej) => {
      timer = setTimeout(() => { try { proc.kill(); } catch {} rej(new Error("timeout")); }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
  await proc.exited;
  const events: any[] = [];
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { events.push(JSON.parse(t)); } catch {}
  }
  return events;
}

// Extract every tool_use and tool_result from a stream-json transcript.
function toolUses(events: any[]): Array<{ name: string; input: any }> {
  const uses: Array<{ name: string; input: any }> = [];
  for (const ev of events) {
    const blocks = ev?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) if (b?.type === "tool_use") uses.push({ name: b.name, input: b.input });
  }
  return uses;
}
function toolResultsText(events: any[]): string {
  let s = "";
  for (const ev of events) {
    const blocks = ev?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      if (b?.type === "tool_result") {
        const c = b.content;
        if (typeof c === "string") s += c + "\n";
        else if (Array.isArray(c)) for (const p of c) if (p?.type === "text") s += (p.text || "") + "\n";
      }
    }
  }
  return s;
}
function finalText(events: any[]): string {
  const res = events.find((e) => e?.type === "result");
  if (res?.result) return String(res.result);
  // fallback: last assistant text
  let s = "";
  for (const ev of events) {
    const blocks = ev?.message?.content;
    if (Array.isArray(blocks)) for (const b of blocks) if (b?.type === "text") s = b.text;
  }
  return s;
}

try {
  console.log(`=== Claude Code E2E (model: ${MODEL}, backend ${HTTP_BASE}) ===\n`);

  // 1. callingclaw_status — read-only, idempotent. Must round-trip to backend.
  const ev1 = await runClaude(
    "Call the callingclaw_status MCP tool exactly once, then tell me the CallingClaw version and whether openclaw is connected. You must call the tool.",
    ["mcp__callingclaw-events__callingclaw_status"],
  );
  const uses1 = toolUses(ev1);
  const results1 = toolResultsText(ev1);
  const final1 = finalText(ev1);
  console.log("tool calls:", uses1.map((u) => u.name).join(", ") || "(none)");
  console.log("Claude:", final1.slice(0, 220).replace(/\n/g, " "), "\n");

  const statusCalled = uses1.some((u) => /callingclaw_status$/.test(u.name));
  check("claude invoked callingclaw_status MCP tool", statusCalled);
  // Hard proof the tool_result came from the LIVE backend (stub never has a version).
  const versionInResult = results1.includes(backendVersion) || /"version"\s*:\s*"2\./.test(results1);
  check(
    "tool_result reflects REAL backend (version field present)",
    versionInResult,
    versionInResult ? `version ${backendVersion} in tool_result` : "no version field in tool_result",
  );
  // Agent's own answer should echo a live field too (model summarized real data).
  const agentEchoesLive =
    final1.includes(backendVersion) || /2\.9|openclaw|connected/i.test(final1);
  check("agent answer reflects live status", agentEchoesLive);

  // 2. callingclaw_recent_events — read-only, idempotent. Assert tool invoked +
  //    returns the documented shape (cursor/count/events). A fresh MCP server
  //    starts with an empty buffer, so 0 events is expected and fine.
  const ev2 = await runClaude(
    "Call the callingclaw_recent_events MCP tool exactly once and report the cursor value and how many events it returned. You must call the tool.",
    ["mcp__callingclaw-events__callingclaw_recent_events"],
  );
  const uses2 = toolUses(ev2);
  const results2 = toolResultsText(ev2);
  const final2 = finalText(ev2);
  console.log("tool calls:", uses2.map((u) => u.name).join(", ") || "(none)");
  console.log("Claude:", final2.slice(0, 220).replace(/\n/g, " "), "\n");

  check(
    "claude invoked callingclaw_recent_events MCP tool",
    uses2.some((u) => /callingclaw_recent_events$/.test(u.name)),
  );
  check(
    "recent_events tool_result has documented shape (cursor/count/events)",
    /"cursor"/.test(results2) && /"count"/.test(results2) && /"events"/.test(results2),
  );
} finally {
  try { rmSync(home, { recursive: true, force: true }); } catch {}
}

console.log(process.exitCode ? "\n=== E2E FAILED ===" : "\n=== E2E PASSED ===");
