#!/usr/bin/env bun
// Real-OpenClaw end-to-end / compatibility test.
//
// Proves CallingClaw's OpenClaw gateway bridge still works against the
// LOCALLY-RUNNING OpenClaw gateway (currently 2026.6.5). It:
//   1. Instantiates the real OpenClawBridge (src/openclaw_bridge.ts) standalone
//      — the bridge reads its token from ~/.openclaw/openclaw.json and needs no
//      other backend modules, so this is a clean, isolated signal.
//   2. Calls connect() and waits (with a ~20s outer guard) for the JSON-RPC
//      handshake (connect.challenge → connect → hello snapshot) to complete.
//      Logs the negotiated session key (proxy for protocol-4 acceptance, since
//      protocol-3 / "openclaw-tui" clients are rejected by ≥2026.6.x gateways).
//   3. Calls sendTask() with a trivial PONG prompt and a SHORT (~80s) timeout,
//      and asserts a non-error response round-trips back through the WS event
//      stream (chat → state:final).
//
// Distinguishes three outcomes:
//   - handshake fails        → protocol INCOMPATIBLE (the real regression)
//   - handshake ok, task     → "missing scope: operator.write" = BUG-009
//     scope-denied             (gateway config issue, NOT a protocol regression)
//   - handshake ok, task ok  → fully compatible
//
// Requires: OpenClaw gateway running on :18789 (curl :18789/healthz → ok).
// Usage: bun scripts/e2e-openclaw.ts

import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const BRIDGE_PATH = join(ROOT, "callingclaw-backend", "src", "openclaw_bridge.ts");
const HEALTHZ = "http://localhost:18789/healthz";
const CONNECT_GUARD_MS = 20_000;
const TASK_GUARD_MS = 80_000;
const PROMPT = "Respond with exactly the single word: PONG";

let exitCode = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!cond) exitCode = 1;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<T>((_, rej) => {
      timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer!));
}

console.log("=== OpenClaw bridge E2E / compatibility test ===\n");

// ── Preflight: gateway alive? ──
let gatewayLive = false;
try {
  const r = await fetch(HEALTHZ);
  const body = await r.json().catch(() => ({}));
  gatewayLive = r.ok && (body as any)?.ok === true;
  console.log(`[preflight] ${HEALTHZ} → ${r.status} ${JSON.stringify(body)}`);
} catch (e: any) {
  console.log(`[preflight] ${HEALTHZ} → ERROR ${e?.message}`);
}
check("OpenClaw gateway is live (:18789/healthz)", gatewayLive);
if (!gatewayLive) {
  console.log("\n=== E2E ABORTED: gateway not reachable ===");
  process.exit(1);
}

// ── Import the real bridge ──
const { OpenClawBridge } = await import(BRIDGE_PATH);
const bridge = new OpenClawBridge();

// Capture activity events for visibility (delta/done/error).
const activity: Array<{ kind: string; summary: string }> = [];
bridge.onActivity((kind: string, summary: string) => {
  activity.push({ kind, summary });
  console.log(`  [activity] ${kind}: ${String(summary).slice(0, 120)}`);
});

let connected = false;
try {
  // 1. Handshake
  console.log("\n[1] connect() — JSON-RPC handshake (challenge → connect → hello)…");
  await withTimeout(bridge.connect(), CONNECT_GUARD_MS, "connect()");
  connected = bridge.connected === true;
  // sessionKey is private; read via reflection for the report only.
  const sessionKey = (bridge as any).sessionKey ?? null;
  check("connect() handshake succeeded", connected, sessionKey ? `sessionKey=${sessionKey}` : "no sessionKey");
  console.log(
    `    → handshake snapshot: connected=${connected}, sessionKey=${JSON.stringify(sessionKey)}\n` +
      `    (a sessionKey means the gateway returned a hello snapshot, i.e. it accepted\n` +
      `     our protocol-4 / "gateway-client" connect — protocol negotiation OK)`,
  );

  if (!connected) {
    // Handshake failure = the genuine protocol-incompatibility case.
    console.log(
      "\n[verdict] connect() FAILED → protocol/handshake INCOMPATIBLE with this gateway.",
    );
  } else {
    // 2. sendTask round-trip
    console.log(`\n[2] sendTask(${JSON.stringify(PROMPT)}) — short ${TASK_GUARD_MS / 1000}s guard…`);
    let taskResult = "";
    let taskThrew: Error | null = null;
    try {
      taskResult = await withTimeout(bridge.sendTask(PROMPT), TASK_GUARD_MS, "sendTask()");
    } catch (e: any) {
      taskThrew = e;
    }

    if (taskThrew) {
      check("sendTask() round-trip", false, `threw/timeout: ${taskThrew.message}`);
    } else {
      console.log(`    → sendTask returned: ${JSON.stringify(taskResult.slice(0, 300))}`);
      // The bridge resolves (never rejects) sendTask: errors come back as
      // "OpenClaw error: …" / "OpenClaw task timed out …" strings. Classify.
      const lower = taskResult.toLowerCase();
      const isScopeError = /missing scope|operator\.write/.test(lower);
      const isOtherError =
        /^openclaw error:|^openclaw disconnected:|timed out|is not running/.test(lower);
      const isReal = taskResult.trim().length > 0 && !isScopeError && !isOtherError;

      check("sendTask() round-trip (non-error response)", isReal, isReal ? "got agent response" : "");

      if (isScopeError) {
        console.log(
          "\n[BUG-009] sendTask returned a SCOPE error: missing scope: operator.write.\n" +
            "    → This is the documented BUG-009 (BUGS.md). The PROTOCOL handshake (protocol-4 /\n" +
            "      gateway-client) is PROVEN compatible — connect() succeeded and returned a snapshot.\n" +
            "      The gateway accepted the connection but rejects chat.send because the gateway\n" +
            "      config does not grant operator.write to this operator connection.\n" +
            "    → Fix is GATEWAY-SIDE config (scope grant), not a CallingClaw bridge incompatibility.",
        );
      } else if (isOtherError) {
        console.log(`\n[note] sendTask returned a NON-scope error string: ${JSON.stringify(taskResult.slice(0, 200))}`);
      }
    }
  }
} catch (e: any) {
  check("connect()/sendTask did not throw unexpectedly", false, e?.message ?? String(e));
} finally {
  try { bridge.disconnect(); } catch {}
}

console.log(exitCode ? "\n=== E2E result: see checks above (exit 1) ===" : "\n=== E2E PASSED ===");
// Give the WS a tick to close cleanly, then exit deterministically.
await new Promise((r) => setTimeout(r, 200));
process.exit(exitCode);
