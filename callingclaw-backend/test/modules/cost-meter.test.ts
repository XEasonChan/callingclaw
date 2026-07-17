// CostMeter unit tests — accumulation, per-component breakdown, rate calc,
// unknown-model handling, reported-USD override, JSONL persistence, fail-soft,
// model normalization, and the module-level recordUsage seam.
//
// Finding 3: explicit / withAttribution() attribution + unattributed-prep bucketing.
// Finding 4: re-join after finalize → fresh non-cumulative session (no double-count).

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import {
  CostMeter,
  recordUsage,
  setActiveCostMeter,
  getActiveCostMeter,
  normalizeModelCandidates,
  COST_LOG_SCHEMA_VERSION,
  UNATTRIBUTED_PREP,
  type MeetingCostRecord,
} from "../../src/modules/cost-meter";

let logDir: string;

function newMeter(extra: Record<string, any> = {}): CostMeter {
  return new CostMeter({ logDir, ...extra });
}

/** Read every JSONL line written to the meter's log as typed records. */
function readRecords(): MeetingCostRecord[] {
  const file = resolve(logDir, "cost-log.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as MeetingCostRecord);
}

beforeEach(() => {
  logDir = mkdtempSync(resolve(tmpdir(), "cc-costmeter-"));
});

afterEach(() => {
  setActiveCostMeter(null);
  try {
    rmSync(logDir, { recursive: true, force: true });
  } catch {}
});

// ── Accumulation + per-component breakdown ──

test("accumulates tokens across multiple components and calls", () => {
  const m = newMeter();
  m.setActiveMeeting("mtg_1");
  m.record({ component: "voice", model: "gpt-realtime-2", inputTokens: 100, outputTokens: 50 });
  m.record({ component: "voice", model: "gpt-realtime-2", inputTokens: 200, outputTokens: 60 });
  m.record({ component: "context", model: "claude-haiku-4-5", inputTokens: 1000, outputTokens: 200 });
  m.record({ component: "auditor", model: "claude-haiku-4-5", inputTokens: 500, outputTokens: 100 });

  const { meeting } = m.getReport("mtg_1");
  expect(meeting).toBeTruthy();
  const c = meeting!.components;

  expect(c.voice!.calls).toBe(2);
  expect(c.voice!.inputTokens).toBe(300);
  expect(c.voice!.outputTokens).toBe(110);
  expect(c.voice!.models).toEqual(["gpt-realtime-2"]);

  expect(c.context!.inputTokens).toBe(1000);
  expect(c.auditor!.inputTokens).toBe(500);

  expect(meeting!.totals.inputTokens).toBe(1800);
  expect(meeting!.totals.outputTokens).toBe(410);
  expect(meeting!.totals.calls).toBe(4);
});

// ── Rate calc (known model → correct USD) ──

test("computes USD from the rate table for a known model", () => {
  const m = newMeter();
  // claude-haiku-4-5: $1.00 / 1M input, $5.00 / 1M output.
  m.record({ meetingId: "mtg_r", component: "context", model: "claude-haiku-4-5", inputTokens: 1_000_000, outputTokens: 0 });
  m.record({ meetingId: "mtg_r", component: "context", model: "claude-haiku-4-5", inputTokens: 0, outputTokens: 1_000_000 });

  const { meeting } = m.getReport("mtg_r");
  // 1.00 (input) + 5.00 (output) = 6.00
  expect(meeting!.components.context!.estimatedUsd).toBeCloseTo(6.0, 6);
  expect(meeting!.totals.estimatedUsd).toBeCloseTo(6.0, 6);
  expect(meeting!.components.context!.unknownModelCalls).toBe(0);
});

test("prices Sonnet correctly ($3/$15 per 1M)", () => {
  const m = newMeter();
  m.record({ meetingId: "s", component: "computer_use", model: "claude-sonnet-5", inputTokens: 2_000_000, outputTokens: 1_000_000 });
  const { meeting } = m.getReport("s");
  // 2*3 + 1*15 = 21
  expect(meeting!.components.computer_use!.estimatedUsd).toBeCloseTo(21.0, 6);
});

// ── Unknown model → tokens recorded, cost unknown ──

test("unknown model: tokens counted, cost stays 0, unknownModelCalls incremented", () => {
  const m = newMeter();
  m.record({ meetingId: "u", component: "context", model: "totally-made-up-model", inputTokens: 1234, outputTokens: 56 });
  const { meeting } = m.getReport("u");
  const c = meeting!.components.context!;
  expect(c.inputTokens).toBe(1234);
  expect(c.outputTokens).toBe(56);
  expect(c.estimatedUsd).toBe(0);
  expect(c.unknownModelCalls).toBe(1);
});

// ── Reported-USD override (the exact `agent` path) ──

test("reported costUsd overrides the rate table", () => {
  const m = newMeter();
  m.record({ meetingId: "a", component: "agent", model: "sonnet", inputTokens: 5000, outputTokens: 900, costUsd: 0.0321 });
  const { meeting } = m.getReport("a");
  const c = meeting!.components.agent!;
  expect(c.estimatedUsd).toBeCloseTo(0.0321, 6);
  expect(c.inputTokens).toBe(5000);
  expect(c.unknownModelCalls).toBe(0);
});

test("call with no tokens and no cost is counted as tokensUnknown", () => {
  const m = newMeter();
  m.record({ meetingId: "h", component: "agent", model: "hermes" });
  const { meeting } = m.getReport("h");
  const c = meeting!.components.agent!;
  expect(c.calls).toBe(1);
  expect(c.tokensUnknownCalls).toBe(1);
  expect(c.estimatedUsd).toBe(0);
});

// ── Active-meeting attribution ──

test("uses the active meeting when meetingId omitted; explicit wins", () => {
  const m = newMeter();
  m.setActiveMeeting("active-1");
  m.record({ component: "voice", model: "gpt-realtime-2", inputTokens: 10, outputTokens: 5 });
  m.record({ meetingId: "explicit-2", component: "voice", model: "gpt-realtime-2", inputTokens: 7 });

  expect(m.getReport("active-1").meeting!.components.voice!.inputTokens).toBe(10);
  expect(m.getReport("explicit-2").meeting!.components.voice!.inputTokens).toBe(7);
});

test("no active meeting and no meetingId → 'unattributed' bucket (non-agent)", () => {
  const m = newMeter();
  m.record({ component: "context", model: "claude-haiku-4-5", inputTokens: 42 });
  expect(m.getReport("unattributed").meeting!.components.context!.inputTokens).toBe(42);
});

// ── getReport() aggregate ──

test("getReport() with no id aggregates across meetings", () => {
  const m = newMeter();
  m.record({ meetingId: "m1", component: "agent", model: "sonnet", costUsd: 1.0, inputTokens: 100 });
  m.record({ meetingId: "m2", component: "agent", model: "sonnet", costUsd: 2.5, inputTokens: 200 });
  const report = m.getReport();
  expect(report.meetings!.length).toBe(2);
  expect(report.totals.estimatedUsd).toBeCloseTo(3.5, 6);
  expect(report.totals.inputTokens).toBe(300);
});

// ── JSONL persistence ──

test("finalizeMeeting writes one JSONL line per meeting with the documented schema", async () => {
  const m = newMeter();
  m.setActiveMeeting("mtg_persist");
  m.record({ component: "voice", model: "gpt-realtime-2", inputTokens: 300, outputTokens: 120 });
  m.record({ component: "agent", model: "sonnet", costUsd: 0.05, inputTokens: 8000, outputTokens: 1500 });

  const path = await m.finalizeMeeting("mtg_persist");
  expect(path).toBeTruthy();
  expect(existsSync(path!)).toBe(true);

  const lines = readFileSync(path!, "utf-8").trim().split("\n");
  expect(lines.length).toBe(1);
  const rec = JSON.parse(lines[0]!) as MeetingCostRecord;

  expect(rec.schemaVersion).toBe(COST_LOG_SCHEMA_VERSION);
  expect(rec.meetingId).toBe("mtg_persist");
  expect(rec.session).toBe(1);
  expect(typeof rec.generatedAt).toBe("string");
  expect(rec.components.voice!.inputTokens).toBe(300);
  expect(rec.components.agent!.estimatedUsd).toBeCloseTo(0.05, 6);
  expect(rec.totals.calls).toBe(2);
  expect(rec.endedAt).toBeGreaterThan(0);
});

test("finalizeMeeting is idempotent per meeting (no duplicate lines) unless forced", async () => {
  const m = newMeter();
  m.record({ meetingId: "once", component: "agent", model: "sonnet", costUsd: 1 });
  const p1 = await m.finalizeMeeting("once");
  const p2 = await m.finalizeMeeting("once"); // no-op
  expect(p1).toBeTruthy();
  expect(p2).toBeNull();

  const lines = readFileSync(p1!, "utf-8").trim().split("\n");
  expect(lines.length).toBe(1);

  await m.finalizeMeeting("once", { force: true });
  const lines2 = readFileSync(p1!, "utf-8").trim().split("\n");
  expect(lines2.length).toBe(2);
});

test("finalizeAllPending writes every un-finalized meeting", async () => {
  const m = newMeter();
  m.record({ meetingId: "p1", component: "agent", model: "sonnet", costUsd: 1 });
  m.record({ meetingId: "p2", component: "agent", model: "haiku", costUsd: 2 });
  await m.finalizeAllPending();
  const file = resolve(logDir, "cost-log.jsonl");
  const lines = readFileSync(file, "utf-8").trim().split("\n");
  expect(lines.length).toBe(2);
  const ids = lines.map((l) => (JSON.parse(l) as MeetingCostRecord).meetingId).sort();
  expect(ids).toEqual(["p1", "p2"]);
});

// ── Rate overrides ──

test("constructor rate overrides win over defaults", () => {
  const m = newMeter({ rates: { "claude-haiku-4-5": { inputPer1M: 10, outputPer1M: 20 } } });
  m.record({ meetingId: "ov", component: "context", model: "claude-haiku-4-5", inputTokens: 1_000_000, outputTokens: 0 });
  expect(m.getReport("ov").meeting!.components.context!.estimatedUsd).toBeCloseTo(10.0, 6);
});

// ── Model normalization ──

test("normalizes provider prefixes, version dots, and tier aliases", () => {
  const m = newMeter();
  // "anthropic/claude-haiku-4-5" → claude-haiku-4-5 ($1/$5)
  m.record({ meetingId: "n1", component: "context", model: "anthropic/claude-haiku-4-5", inputTokens: 1_000_000 });
  expect(m.getReport("n1").meeting!.components.context!.estimatedUsd).toBeCloseTo(1.0, 6);

  // "anthropic/claude-haiku-4.5" (dotted) → claude-haiku-4-5
  m.record({ meetingId: "n2", component: "context", model: "anthropic/claude-haiku-4.5", inputTokens: 1_000_000 });
  expect(m.getReport("n2").meeting!.components.context!.estimatedUsd).toBeCloseTo(1.0, 6);

  // CLI tier alias embedded in a slug → sonnet ($3/$15)
  m.record({ meetingId: "n3", component: "agent", model: "some-provider/claude-sonnet-4-6", inputTokens: 1_000_000 });
  expect(m.getReport("n3").meeting!.components.agent!.estimatedUsd).toBeCloseTo(3.0, 6);

  expect(normalizeModelCandidates("anthropic/Claude-Haiku-4.5")).toContain("claude-haiku-4-5");
  expect(normalizeModelCandidates("openrouter/x/claude-sonnet-5")).toContain("sonnet");
});

// ── Fail-soft ──

test("record never throws on malformed input", () => {
  const m = newMeter();
  expect(() => m.record(null as any)).not.toThrow();
  expect(() => m.record(undefined as any)).not.toThrow();
  expect(() => m.record({} as any)).not.toThrow();
  expect(() => m.record({ component: "x", inputTokens: NaN, outputTokens: -5, costUsd: NaN } as any)).not.toThrow();
  expect(() => m.record({ component: "voice", inputTokens: Infinity } as any)).not.toThrow();

  // NaN/negative tokens clamp to 0, no cost pollution.
  const { meeting } = m.getReport("unattributed");
  const c = meeting!.components.x!;
  expect(c.inputTokens).toBe(0);
  expect(c.outputTokens).toBe(0);
  expect(c.estimatedUsd).toBe(0);
});

test("disabled meter records nothing and finalizes to null", async () => {
  const m = newMeter({ enabled: false });
  m.setActiveMeeting("d");
  m.record({ component: "agent", model: "sonnet", costUsd: 5 });
  expect(m.getReport("d").meeting!.totals.calls).toBe(0);
  expect(await m.finalizeMeeting("d")).toBeNull();
});

// ── Module-level recordUsage seam ──

test("recordUsage forwards to the installed active meter; no-op when none", () => {
  // No meter installed → must not throw.
  setActiveCostMeter(null);
  expect(() => recordUsage({ component: "voice", inputTokens: 1 })).not.toThrow();

  const m = newMeter();
  m.setActiveMeeting("seam");
  setActiveCostMeter(m);
  expect(getActiveCostMeter()).toBe(m);
  recordUsage({ component: "context", model: "claude-haiku-4-5", inputTokens: 1_000_000, outputTokens: 0 });
  expect(m.getReport("seam").meeting!.components.context!.estimatedUsd).toBeCloseTo(1.0, 6);
});

test("reset clears a meeting", () => {
  const m = newMeter();
  m.record({ meetingId: "z", component: "agent", model: "sonnet", costUsd: 1 });
  expect(m.getReport("z").meeting!.totals.calls).toBe(1);
  m.reset("z");
  expect(m.getReport("z").meeting!.totals.calls).toBe(0);
});

// ════════════════════════════════════════════════════════════════════
// Finding 3 — explicit / scoped meetingId attribution + unattributed-prep
// ════════════════════════════════════════════════════════════════════

test("F3: agent work with no active meeting buckets as unattributed-prep (never the previous meeting)", () => {
  const m = newMeter();
  // A real meeting runs and bills agent cost.
  m.setActiveMeeting("prev");
  m.record({ component: "agent", model: "sonnet", costUsd: 1.0 });
  // Meeting ends → active attribution cleared (mirrors callingclaw.ts meeting.ended).
  m.endActiveMeeting("prev");
  // Pre-join PREP for the NEXT meeting runs BEFORE its meeting.started → no active id.
  m.record({ component: "agent", model: "sonnet", costUsd: 0.3 });

  // The previous meeting is NOT polluted by the next meeting's prep.
  expect(m.getReport("prev").meeting!.components.agent!.estimatedUsd).toBeCloseTo(1.0, 6);
  // Prep lands in the clearly-named idle bucket.
  const prep = m.getReport(UNATTRIBUTED_PREP).meeting!.components.agent!;
  expect(prep.estimatedUsd).toBeCloseTo(0.3, 6);
  expect(prep.calls).toBe(1);
});

test("F3: only `agent` idle work → unattributed-prep; other components stay 'unattributed'", () => {
  const m = newMeter();
  m.record({ component: "vision", model: "gemini-3.5-flash", inputTokens: 100 });
  m.record({ component: "agent", model: "sonnet", costUsd: 0.2 });
  expect(m.getReport("unattributed").meeting!.components.vision!.inputTokens).toBe(100);
  expect(m.getReport(UNATTRIBUTED_PREP).meeting!.components.agent!.estimatedUsd).toBeCloseTo(0.2, 6);
  // The two idle buckets are distinct (agent cost never leaks into 'unattributed').
  expect(m.getReport("unattributed").meeting!.components.agent).toBeUndefined();
});

test("F3: withAttribution pins agent cost to the scoped meeting even after setActiveMeeting(next)", async () => {
  const m = newMeter();
  m.setActiveMeeting("A");
  m.endActiveMeeting("A"); // A ended, active attribution cleared

  // Post-meeting work for A runs async; meanwhile a back-to-back meeting B starts.
  await m.withAttribution("A", async () => {
    m.setActiveMeeting("B"); // B becomes the active meeting mid-flight
    await Promise.resolve();  // cross an await boundary — scope must survive
    m.record({ component: "agent", model: "sonnet", costUsd: 0.5 }); // no explicit id
  });

  // A's post-meeting cost is attributed to A, NOT stolen by B.
  expect(m.getReport("A").meeting!.components.agent!.estimatedUsd).toBeCloseTo(0.5, 6);
  expect(m.getReport("B").meeting!.components.agent).toBeUndefined();
});

test("F3: withAttribution flows through the module-level recordUsage seam (real adapter path)", () => {
  // Adapters call the module-level recordUsage(); the dispatcher wraps the call
  // in meter.withAttribution(). Prove the scope reaches the seam.
  const m = newMeter();
  setActiveCostMeter(m);
  m.setActiveMeeting("live"); // a live meeting is active
  m.endActiveMeeting("live");

  m.withAttribution("live", () => {
    recordUsage({ component: "agent", model: "sonnet", costUsd: 0.9 });
  });
  expect(m.getReport("live").meeting!.components.agent!.estimatedUsd).toBeCloseTo(0.9, 6);
});

test("F3: explicit event.meetingId still wins over the withAttribution scope", () => {
  const m = newMeter();
  m.withAttribution("scope", () => {
    m.record({ meetingId: "explicit", component: "agent", model: "sonnet", costUsd: 0.7 });
  });
  expect(m.getReport("explicit").meeting!.components.agent!.estimatedUsd).toBeCloseTo(0.7, 6);
  expect(m.getReport("scope").meeting!.components.agent).toBeUndefined();
});

test("F3: withAttribution scope beats the active meeting (during a live meeting)", () => {
  const m = newMeter();
  m.setActiveMeeting("live");
  // e.g. prep for a DIFFERENT meeting scoped explicitly while one is active
  m.withAttribution("other", () => {
    m.record({ component: "agent", model: "sonnet", costUsd: 0.4 });
  });
  // Unscoped work still bills the active meeting.
  m.record({ component: "agent", model: "sonnet", costUsd: 0.1 });
  expect(m.getReport("other").meeting!.components.agent!.estimatedUsd).toBeCloseTo(0.4, 6);
  expect(m.getReport("live").meeting!.components.agent!.estimatedUsd).toBeCloseTo(0.1, 6);
});

test("F3: withAttribution(null) is a no-op scope and runs fn exactly once", () => {
  const m = newMeter();
  m.setActiveMeeting("act");
  let calls = 0;
  const r = m.withAttribution(null, () => { calls++; m.record({ component: "agent", costUsd: 0.2 }); return 42; });
  expect(r).toBe(42);
  expect(calls).toBe(1);
  // Falls through to the active meeting.
  expect(m.getReport("act").meeting!.components.agent!.estimatedUsd).toBeCloseTo(0.2, 6);
});

test("F3: withAttribution rethrows a synchronous fn error without double-invoking", () => {
  const m = newMeter();
  let calls = 0;
  expect(() => m.withAttribution("x", () => { calls++; throw new Error("boom"); })).toThrow("boom");
  expect(calls).toBe(1);
});

// ════════════════════════════════════════════════════════════════════
// Finding 4 — re-join after finalize must not double-log cumulative totals
// ════════════════════════════════════════════════════════════════════

test("F4: re-join AFTER finalize starts a fresh session → non-overlapping, summable lines", async () => {
  const m = newMeter();

  // Session 1
  m.setActiveMeeting("rj");
  m.record({ component: "agent", model: "sonnet", costUsd: 1.0 });
  await m.finalizeMeeting("rj"); // writes line 1 (session 1)

  // Re-join AFTER the finalize window: setActiveMeeting must RESET the bucket.
  m.setActiveMeeting("rj");
  m.record({ component: "agent", model: "sonnet", costUsd: 2.0 });
  await m.finalizeMeeting("rj"); // writes line 2 (session 2)

  const recs = readRecords();
  expect(recs.length).toBe(2);
  expect(recs.every((r) => r.meetingId === "rj")).toBe(true);

  // Line 2 holds ONLY session-2 cost (2.0), NOT the cumulative 3.0.
  expect(recs[0]!.totals.estimatedUsd).toBeCloseTo(1.0, 6);
  expect(recs[0]!.session).toBe(1);
  expect(recs[1]!.totals.estimatedUsd).toBeCloseTo(2.0, 6);
  expect(recs[1]!.session).toBe(2);

  // Summing lines by meetingId gives the true total without double-counting.
  const total = recs.reduce((s, r) => s + r.totals.estimatedUsd, 0);
  expect(total).toBeCloseTo(3.0, 6);
});

test("F4: re-join BEFORE finalize keeps one accumulating session (single line)", async () => {
  const m = newMeter();

  // First join
  m.setActiveMeeting("win");
  m.record({ component: "agent", model: "sonnet", costUsd: 1.0 });

  // Re-join within the window (NOT yet finalized) → same bucket keeps accumulating.
  m.setActiveMeeting("win");
  m.record({ component: "agent", model: "sonnet", costUsd: 2.0 });

  await m.finalizeMeeting("win");
  // A late duplicate finalize (e.g. the second meeting.ended timer) is a no-op.
  const dup = await m.finalizeMeeting("win");
  expect(dup).toBeNull();

  const recs = readRecords();
  expect(recs.length).toBe(1);
  expect(recs[0]!.session).toBe(1);
  expect(recs[0]!.totals.estimatedUsd).toBeCloseTo(3.0, 6); // combined single session
});

test("F4: in-memory bucket is reset on re-join after finalize (not just the log line)", async () => {
  const m = newMeter();
  m.setActiveMeeting("mem");
  m.record({ component: "agent", model: "sonnet", costUsd: 5.0, inputTokens: 1000 });
  await m.finalizeMeeting("mem");

  m.setActiveMeeting("mem"); // reset
  // Live report now reflects only the fresh session (no residual session-1 totals).
  const rep = m.getReport("mem").meeting!;
  expect(rep.totals.calls).toBe(0);
  expect(rep.totals.estimatedUsd).toBe(0);
  expect(rep.session).toBe(2);
});

test("F4: session number increments across repeated finalize→re-join cycles", async () => {
  const m = newMeter();
  for (let i = 1; i <= 3; i++) {
    m.setActiveMeeting("cyc");
    m.record({ component: "agent", model: "sonnet", costUsd: i });
    await m.finalizeMeeting("cyc");
  }
  const recs = readRecords();
  expect(recs.map((r) => r.session)).toEqual([1, 2, 3]);
  expect(recs.map((r) => r.totals.estimatedUsd)).toEqual([1, 2, 3]);
});
