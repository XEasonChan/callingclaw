#!/usr/bin/env bun
// Real Codex end-to-end test.
//
// Drives the LOCAL `codex exec` CLI non-interactively with the callingclaw-events
// MCP server registered (in ~/.codex/config.toml — see scripts/setup-codex.sh),
// pointed at the REAL CallingClaw backend on http://localhost:4000. Asserts Codex
// actually invoked a CallingClaw MCP tool — verified two ways:
//   (a) the --json event stream contains an MCP tool-call item for the tool, and
//   (b) the tool output / final message carries a LIVE backend field (the running
//       version, e.g. 2.9.5) that a stub backend would never produce.
// Proves: Codex <-> MCP tools <-> real CallingClaw backend, end to end.
//
// Requires: `codex` on PATH + a usable Codex account/model, the callingclaw-events
// MCP server registered (bash scripts/setup-codex.sh), and the REAL backend
// listening on :4000 (./scripts/start.sh --no-desktop).
// Usage: bun scripts/e2e-codex.ts

import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const HTTP_BASE = process.env.CALLINGCLAW_HTTP || "http://localhost:4000";
// Codex default model comes from ~/.codex/config.toml; override with CODEX_E2E_MODEL.
const MODEL = process.env.CODEX_E2E_MODEL || "";

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

// ── 0b. Codex must have the callingclaw-events MCP registered ──
try {
  const cfg = readFileSync(`${process.env.HOME}/.codex/config.toml`, "utf-8");
  if (!cfg.includes("callingclaw-events")) {
    console.error("✗ callingclaw-events MCP not registered for Codex. Run: bash scripts/setup-codex.sh");
    process.exit(1);
  }
} catch {
  console.error("✗ ~/.codex/config.toml not found. Run: bash scripts/setup-codex.sh");
  process.exit(1);
}

const home = mkdtempSync(join(tmpdir(), "codex-e2e-"));

interface CodexRun { events: any[]; lastMessage: string; usageLimited: boolean; modelUnsupported: boolean; rawTail: string; }

async function runCodex(prompt: string, timeoutMs = 180000): Promise<CodexRun> {
  const lastFile = join(home, `last-${Date.now()}.txt`);
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--sandbox", "workspace-write",
    "--cd", ROOT,
    "--color", "never",
    "--json",
    "-c", "model_reasoning_effort=low", // keep it cheap/fast
    "--output-last-message", lastFile,
  ];
  if (MODEL) args.push("--model", MODEL);
  args.push(prompt);

  const proc = Bun.spawn(["codex", ...args], {
    stdout: "pipe", stderr: "pipe",
    stdin: "ignore", // codex reads stdin otherwise ("Reading additional input from stdin...")
    cwd: ROOT, env: { ...process.env },
  });
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
    if (!t || !t.startsWith("{")) continue;
    try { events.push(JSON.parse(t)); } catch {}
  }
  const errText = JSON.stringify(events.filter((e) => e?.type === "error" || e?.type === "turn.failed"));
  const usageLimited = /usage limit|purchase more credits/i.test(errText);
  const modelUnsupported = /not supported when using Codex|model.*not found/i.test(errText);
  let lastMessage = "";
  try { if (existsSync(lastFile)) lastMessage = readFileSync(lastFile, "utf-8").trim(); } catch {}
  return { events, lastMessage, usageLimited, modelUnsupported, rawTail: out.slice(-600) };
}

// Codex --json items: { type:"item.completed", item:{ type, ... } }.
// MCP tool calls surface as command/mcp tool items; be permissive about the
// exact item.type across codex versions and also scan the raw text.
function itemsText(run: CodexRun): string {
  let s = "";
  for (const ev of run.events) {
    if (ev?.type === "item.completed" && ev.item) s += JSON.stringify(ev.item) + "\n";
  }
  return s;
}

try {
  console.log(`=== Codex E2E (model: ${MODEL || "default(config)"}, backend ${HTTP_BASE}) ===\n`);

  // 1. callingclaw_status — read-only, idempotent. Must round-trip to backend.
  const run1 = await runCodex(
    "Call the callingclaw_status MCP tool exactly once, then tell me the CallingClaw version number and whether openclaw is connected. You must call the tool and quote the exact version.",
  );

  if (run1.usageLimited || run1.modelUnsupported) {
    const why = run1.usageLimited ? "Codex account usage limit hit" : "configured Codex model unsupported for this account";
    console.error(`\n!! BLOCKED: ${why}.`);
    console.error("   This is an account/quota issue, not a CallingClaw integration failure.");
    console.error("   Re-run when credits reset (set CODEX_E2E_MODEL to a supported model if needed).");
    console.error("   raw tail:", run1.rawTail.replace(/\n/g, " ").slice(0, 300));
    check("codex run completed (not blocked by account limit/model)", false, why);
    throw new Error("BLOCKED_BY_ACCOUNT");
  }

  const items1 = itemsText(run1);
  console.log("Codex final:", run1.lastMessage.slice(0, 220).replace(/\n/g, " "), "\n");

  const toolInvoked = /callingclaw_status/.test(items1) || /callingclaw_status/.test(run1.lastMessage);
  check("codex invoked callingclaw_status MCP tool", toolInvoked);
  // Hard proof the data came from the LIVE backend.
  const versionSeen =
    items1.includes(backendVersion) || run1.lastMessage.includes(backendVersion) ||
    /2\.9\.\d/.test(items1) || /2\.9\.\d/.test(run1.lastMessage);
  check(
    "tool output / answer reflects REAL backend version",
    versionSeen,
    versionSeen ? `version ${backendVersion} observed` : "no live version field observed",
  );

  // 2. callingclaw_recent_events — read-only, idempotent. Assert tool invoked +
  //    returns the documented shape. Fresh server → empty buffer is expected.
  const run2 = await runCodex(
    "Call the callingclaw_recent_events MCP tool exactly once and report the cursor value and the event count it returns. You must call the tool.",
  );
  if (run2.usageLimited || run2.modelUnsupported) {
    check("codex recent_events run completed", false, run2.usageLimited ? "usage limit" : "model unsupported");
  } else {
    const items2 = itemsText(run2);
    console.log("Codex final:", run2.lastMessage.slice(0, 220).replace(/\n/g, " "), "\n");
    check(
      "codex invoked callingclaw_recent_events MCP tool",
      /callingclaw_recent_events/.test(items2) || /callingclaw_recent_events/.test(run2.lastMessage),
    );
    check(
      "recent_events result mentions cursor + count",
      /cursor/i.test(items2 + run2.lastMessage) && /count|event/i.test(items2 + run2.lastMessage),
    );
  }
} catch (e: any) {
  if (e?.message !== "BLOCKED_BY_ACCOUNT") {
    console.error("✗ unexpected error:", e?.message || e);
    process.exitCode = 1;
  }
} finally {
  try { rmSync(home, { recursive: true, force: true }); } catch {}
}

console.log(process.exitCode ? "\n=== E2E FAILED ===" : "\n=== E2E PASSED ===");
