// ClaudeCodeAdapter warm-worker tests — uses a fake `claude` binary (via
// CLAUDE_BIN, same override pattern as CODEX_BIN in codex-adapter.test.ts)
// that speaks BOTH protocols:
//   cold:  `claude -p ... --output-format json <prompt>`  → {"result":"COLD[model]:..."}
//   warm:  `claude -p --input-format stream-json ...`     → NDJSON events per stdin turn,
//          ending each turn with {"type":"result","result":"WARM[model][n]:...|seen=..."}
// Special prompt markers drive failure modes: SLEEP:<ms>, DIE_NOW, NO_RESULT,
// IS_ERROR (result with is_error:true). MARK:<id> accumulates in the fake
// process across turns and is echoed back in `seen=` — it simulates the real
// CLI's in-process conversation context, so tests can PROVE a recycled worker
// cannot leak one meeting's context into the next.

import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binDir = mkdtempSync(join(tmpdir(), "claude-fake-"));
const argsFile = join(binDir, "last-args.txt");
const fakeBin = join(binDir, "claude");
const fakeBinNoStream = join(binDir, "claude-nostream");

const FAKE_CLI = `#!/usr/bin/env bun
// Fake claude CLI for adapter tests. NOSTREAM_MARKER
const args = process.argv.slice(2);
try { await Bun.write(${JSON.stringify(argsFile)}, args.join("\\n")); } catch {}

if (args.includes("--version")) { console.log("0.0.0-fake"); process.exit(0); }
if (args.includes("--help")) {
  console.log('--input-format <format>   "text" (default), or "stream-json"');
  console.log('--output-format <format>  "text", "json", or "stream-json"');
  process.exit(0);
}
const model = args[args.indexOf("--model") + 1] || "unknown";

if (args.includes("--input-format")) {
  // Warm streaming mode: one NDJSON user message per line on stdin.
  const emit = (o) => console.log(JSON.stringify(o));
  emit({ type: "system", subtype: "init" });
  let n = 0;
  const seen = []; // MARK:<id> markers persist across turns — simulates in-process conversation context
  for await (const line of console) {
    let text = "";
    try { text = JSON.parse(line).message.content[0].text; } catch { continue; }
    n++;
    const mark = text.match(/MARK:([A-Za-z0-9_]+)/);
    if (mark) seen.push(mark[1]);
    const sleep = text.match(/SLEEP:(\\d+)/);
    if (sleep) await Bun.sleep(Number(sleep[1]));
    if (text.includes("DIE_NOW")) process.exit(1);
    emit({ type: "system", subtype: "thinking_tokens" });
    emit({ type: "rate_limit_event" });
    console.log("NOT-JSON-NOISE the parser must skip this line");
    if (text.includes("NO_RESULT")) continue;
    if (text.includes("IS_ERROR")) {
      emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom (this is not an answer)" });
      continue;
    }
    emit({ type: "assistant" });
    emit({ type: "result", subtype: "success", is_error: false, result: "WARM[" + model + "][" + n + "]:" + text.slice(0, 60) + "|seen=" + seen.join(",") });
  }
} else {
  // Cold mode: prompt is the last positional arg.
  const prompt = args[args.length - 1];
  console.log(JSON.stringify({ result: "COLD[" + model + "]:" + prompt.slice(0, 60) }));
}
`;

const adaptersToCool: any[] = [];

beforeAll(() => {
  writeFileSync(fakeBin, FAKE_CLI);
  chmodSync(fakeBin, 0o755);
  // Variant whose --help does NOT mention stream-json (capability check must fail).
  writeFileSync(fakeBinNoStream, FAKE_CLI
    .replace("// Fake claude CLI for adapter tests. NOSTREAM_MARKER", "// no-stream variant")
    .replace(`console.log('--input-format <format>   "text" (default), or "stream-json"');`,
      `console.log('--input-format <format>   "text" only');`)
    .replace(`console.log('--output-format <format>  "text", "json", or "stream-json"');`,
      `console.log('--output-format <format>  "text" or "json"');`));
  chmodSync(fakeBinNoStream, 0o755);
  process.env.CLAUDE_BIN = fakeBin;
  delete process.env.CLAUDE_WARM_WORKER;
});

afterAll(() => {
  delete process.env.CLAUDE_BIN;
  delete process.env.CLAUDE_WARM_WORKER;
  try { rmSync(binDir, { recursive: true, force: true }); } catch {}
});

afterEach(async () => {
  // Kill any warm workers so bun test never leaks fake CLI processes.
  while (adaptersToCool.length) await adaptersToCool.pop().cooldown?.();
});

const { ClaudeCodeAdapter, WarmClaudeWorker } = await import("../../src/adapters/claude-code-adapter");

function makeAdapter(): InstanceType<typeof ClaudeCodeAdapter> {
  const a = new ClaudeCodeAdapter();
  adaptersToCool.push(a);
  return a;
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout");
    await Bun.sleep(20);
  }
}

// ── Cold path (default — byte-for-byte unchanged behavior) ──

test("without warmUp, recallContext uses the cold path with unchanged flags", async () => {
  const a = makeAdapter();
  const result = await a.recallContext("what did we decide about pricing?");
  expect(result).toStartWith("COLD[haiku]:");

  const args = readFileSync(argsFile, "utf-8").split("\n");
  expect(args[0]).toBe("-p");
  expect(args).toContain("--disable-slash-commands");
  expect(args[args.indexOf("--model") + 1]).toBe("haiku");
  expect(args[args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
  expect(args[args.indexOf("--output-format") + 1]).toBe("json");
  expect(args[args.indexOf("--max-turns") + 1]).toBe("3");
  expect(args).toContain("--no-session-persistence");
  expect(args).not.toContain("--input-format"); // no streaming on the cold path
});

test("without warmUp, executeTask uses the cold sonnet path", async () => {
  const a = makeAdapter();
  const result = await a.executeTask("open the design doc");
  expect(result).toStartWith("COLD[sonnet]:");
  const args = readFileSync(argsFile, "utf-8").split("\n");
  expect(args[args.indexOf("--max-turns") + 1]).toBe("10");
});

// ── Warm routing ──

test("after warmUp, recall routes to the haiku worker and task to the sonnet worker", async () => {
  const a = makeAdapter();
  await a.warmUp();
  expect(a.warmStats().warm).toBe(true);

  const recall = await a.recallContext("pricing");
  expect(recall).toStartWith("WARM[haiku][1]:");

  const task = await a.executeTask("draft the follow-up email");
  expect(task).toStartWith("WARM[sonnet][1]:");
});

test("warm worker is reused across turns (same process, turn counter increments)", async () => {
  const a = makeAdapter();
  await a.warmUp();
  expect(await a.recallContext("first")).toStartWith("WARM[haiku][1]:");
  expect(await a.recallContext("second")).toStartWith("WARM[haiku][2]:");
  expect(a.warmStats().workers.recall?.turnsServed).toBe(2);
});

// ── Cross-meeting isolation: meeting.started → meeting.started WITHOUT
// meeting.ended is an acknowledged path (callingclaw.ts re-join handling).
// warmUp while already warm must RECYCLE, never reuse meeting A's workers. ──

test("started→started: warmUp while warm recycles — meeting A context cannot leak into meeting B", async () => {
  const a = makeAdapter();
  await a.warmUp();
  const genA = a.warmStats().gen;

  const r1 = await a.recallContext("MARK:MEETING_A the pricing decision");
  expect(r1).toStartWith("WARM[haiku][1]:");
  expect(r1).toContain("seen=MEETING_A"); // fake CLI proves context accumulates in-process

  // Second meeting.started, no meeting.ended in between → must recycle.
  await a.warmUp();
  expect(a.warmStats().warm).toBe(true);
  expect(a.warmStats().gen).toBeGreaterThan(genA); // new warm generation

  const r2 = await a.recallContext("what do you remember about pricing");
  expect(r2).toStartWith("WARM[haiku][1]:"); // fresh PROCESS — turn counter reset
  expect(r2).not.toContain("MEETING_A");     // meeting A's marker did NOT leak
});

test("warmUp during an in-flight warm request: that request goes cold, meeting B gets fresh workers", async () => {
  const a = makeAdapter();
  await a.warmUp();
  const inFlight = a.recallContext("MARK:MEETING_A SLEEP:800 slow question");
  await Bun.sleep(100); // ensure the request is in flight on meeting A's worker
  await a.warmUp();     // meeting B starts mid-request → recycle kills A's worker
  expect(await inFlight).toStartWith("COLD[haiku]:"); // killed worker → cold fallback
  const r2 = await a.recallContext("meeting B question");
  expect(r2).toStartWith("WARM[haiku][1]:"); // fresh worker; gen guard blocked A's stale respawn
  expect(r2).not.toContain("MEETING_A");
});

test("concurrent warmUp calls serialize — adapter ends warm with one fresh worker pair", async () => {
  const a = makeAdapter();
  await Promise.all([a.warmUp(), a.warmUp(), a.warmUp()]);
  expect(a.warmStats().warm).toBe(true);
  expect(Object.keys(a.warmStats().workers).sort()).toEqual(["recall", "task"]);
  expect(await a.recallContext("hello")).toStartWith("WARM[haiku][1]:");
});

// ── Serialization: overlap → cold fallback (no queueing) ──

test("overlapping requests: second goes to cold path while worker is busy", async () => {
  const a = makeAdapter();
  await a.warmUp();
  const slow = a.executeTask("please SLEEP:400 then answer");
  await Bun.sleep(50); // ensure first request is in flight
  const fast = await a.executeTask("second task");
  expect(fast).toStartWith("COLD[sonnet]:"); // busy worker → cold, not queued
  expect(await slow).toStartWith("WARM[sonnet][1]:");
});

// ── Failure → cold fallback + respawn ──

test("worker death mid-request falls back to cold, then respawns for later requests", async () => {
  const a = makeAdapter();
  await a.warmUp();
  const result = await a.recallContext("DIE_NOW");
  expect(result).toStartWith("COLD[haiku]:"); // crash → cold fallback for that request

  // onExit respawn: a fresh worker (turn counter resets) serves the next call.
  await waitFor(() => a.warmStats().workers.recall?.alive === true);
  expect(await a.recallContext("after respawn")).toStartWith("WARM[haiku][1]:");
});

// ── Shared warm+cold deadline (no timeout stacking) ──

test("recall: warm timeout leaves the cold fallback only the remaining budget", async () => {
  const a = makeAdapter();
  a.recallBudgetMs = 1200; // warm share = min(15000, 600) = 600ms
  await a.warmUp();
  const t0 = Date.now();
  const r = await a.recallContext("SLEEP:5000 far too slow for warm");
  const elapsed = Date.now() - t0;
  expect(r).toStartWith("COLD[haiku]:");       // warm timed out at its share → cold answered
  expect(elapsed).toBeGreaterThanOrEqual(550); // warm really consumed its share first
  expect(elapsed).toBeLessThan(1200 + 600);    // ONE shared budget total — not warm-30s + cold-30s
});

test("task: warm timeout leaves the cold fallback only the remaining budget", async () => {
  const a = makeAdapter();
  a.taskBudgetMs = 1200; // warm share = 600ms
  await a.warmUp();
  const t0 = Date.now();
  const r = await a.executeTask("SLEEP:5000 far too slow for warm");
  const elapsed = Date.now() - t0;
  expect(r).toStartWith("COLD[sonnet]:");
  expect(elapsed).toBeLessThan(1200 + 600);
});

// ── Error results: {"type":"result","is_error":true} is a failure, not an answer ──

test("is_error result → worker discarded, request falls back to cold, fresh respawn after", async () => {
  const a = makeAdapter();
  await a.warmUp();
  const r = await a.recallContext("IS_ERROR pretend the turn broke");
  expect(r).toStartWith("COLD[haiku]:"); // the error payload is NOT surfaced as the answer
  // Error turn kills the worker; owner's respawn policy brings up a fresh one.
  await waitFor(() => a.warmStats().workers.recall?.alive === true);
  expect(await a.recallContext("after the error")).toStartWith("WARM[haiku][1]:");
});

// ── Lifecycle: cooldown / kill-switch / capability ──

test("cooldown kills workers and reverts to cold; workers never survive a meeting", async () => {
  const a = makeAdapter();
  await a.warmUp();
  expect(await a.recallContext("warm one")).toStartWith("WARM[haiku]");
  await a.cooldown();
  expect(a.warmStats().warm).toBe(false);
  expect(Object.keys(a.warmStats().workers)).toHaveLength(0);
  expect(await a.recallContext("cold again")).toStartWith("COLD[haiku]:");
});

test("CLAUDE_WARM_WORKER=0 kill-switch disables warm workers entirely", async () => {
  process.env.CLAUDE_WARM_WORKER = "0";
  try {
    const a = makeAdapter();
    await a.warmUp();
    expect(a.warmStats().warm).toBe(false);
    expect(await a.recallContext("anything")).toStartWith("COLD[haiku]:");
  } finally {
    delete process.env.CLAUDE_WARM_WORKER;
  }
});

test("CLI without stream-json support: warmUp silently stays cold (definitive negative is cached)", async () => {
  process.env.CLAUDE_BIN = fakeBinNoStream;
  try {
    const a = makeAdapter();
    await a.warmUp();
    expect(a.warmStats().warm).toBe(false);
    expect(await a.recallContext("anything")).toStartWith("COLD[haiku]:");
    // Help text WAS produced and lacked the flags — that negative is
    // definitive, so this adapter never re-probes (even with a capable bin).
    process.env.CLAUDE_BIN = fakeBin;
    await a.warmUp();
    expect(a.warmStats().warm).toBe(false);
  } finally {
    process.env.CLAUDE_BIN = fakeBin;
  }
});

test("transient capability-probe failure does not permanently disable warm", async () => {
  const a = makeAdapter();
  process.env.CLAUDE_BIN = join(binDir, "no-such-claude-binary");
  try {
    await a.warmUp(); // probe fails to spawn → cold for this meeting
    expect(a.warmStats().warm).toBe(false);
  } finally {
    process.env.CLAUDE_BIN = fakeBin;
  }
  // Next meeting, same adapter: the transient failure was NOT cached — re-probe succeeds.
  await a.warmUp();
  expect(a.warmStats().warm).toBe(true);
  expect(await a.recallContext("retry works")).toStartWith("WARM[haiku][1]:");
});

// ── WarmClaudeWorker unit tests (direct, small timeouts) ──

test("worker: per-request timeout kills the worker and rejects", async () => {
  const w = new WarmClaudeWorker({ bin: fakeBin, model: "haiku", maxTurns: 3, cwd: binDir });
  await expect(w.run("SLEEP:5000", 250)).rejects.toThrow(/timeout/);
  await waitFor(() => !w.alive);
});

test("worker: malformed stream (events but no result) times out and is discarded", async () => {
  const w = new WarmClaudeWorker({ bin: fakeBin, model: "haiku", maxTurns: 3, cwd: binDir });
  await expect(w.run("NO_RESULT", 300)).rejects.toThrow(/timeout/);
  await waitFor(() => !w.alive);
});

test("worker: overlap rejected immediately (one in-flight per worker)", async () => {
  const w = new WarmClaudeWorker({ bin: fakeBin, model: "haiku", maxTurns: 3, cwd: binDir });
  const first = w.run("SLEEP:200 ok", 2000);
  await expect(w.run("overlap", 2000)).rejects.toThrow(/busy/);
  expect(await first).toContain("WARM[haiku][1]");
  w.kill();
});

test("worker: self-recycles after recycleAfter turns (planned, onExit fires)", async () => {
  let exited = false;
  const w = new WarmClaudeWorker({
    bin: fakeBin, model: "haiku", maxTurns: 3, cwd: binDir,
    recycleAfter: 2, onExit: () => { exited = true; },
  });
  expect(await w.run("one", 2000)).toContain("[1]");
  expect(await w.run("two", 2000)).toContain("[2]");
  expect(w.recycled).toBe(true);
  await waitFor(() => exited && !w.alive);
});

test("worker: is_error result rejects (worker discarded) instead of resolving", async () => {
  const w = new WarmClaudeWorker({ bin: fakeBin, model: "haiku", maxTurns: 3, cwd: binDir });
  await expect(w.run("IS_ERROR", 2000)).rejects.toThrow(/error result/);
  await waitFor(() => !w.alive); // error turn → worker killed, not reused
});

test("worker: process death rejects the pending request with stderr context", async () => {
  const w = new WarmClaudeWorker({ bin: fakeBin, model: "haiku", maxTurns: 3, cwd: binDir });
  await expect(w.run("DIE_NOW", 2000)).rejects.toThrow(/exited/);
  await waitFor(() => !w.alive);
});
