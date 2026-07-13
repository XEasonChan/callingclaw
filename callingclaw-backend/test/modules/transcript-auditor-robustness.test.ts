// TranscriptAuditor — P0 robustness (blocker fix + executor timeouts)
//
// Covers:
//   1. P0.1 blocker: research completion while the voice model is NON-idle
//      routes the trigger through the public voice.requestDeliberateResponse()
//      — no throw, no private-client access, the result is replaceContext'd,
//      and NO false "[RESEARCH] … failed" note is injected.
//   2. P0.2 medium lane: a hung classifyIntent times out → _processing is
//      cleared, auditor.error is emitted, and the lane recovers.
//   3. P0.2 fast lane: a hung router call times out → _fastLaneProcessing is
//      cleared and auditor.error is emitted.
//
// The auditor imports the LLM client at module load, so we mock it (defensive —
// these paths must never hit the network).

import { test, expect, mock } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("../../src/ai_gateway/llm-client", () => ({
  callModel: async () => '{"action":null,"params":{},"confidence":0,"reasoning":"mock"}',
  parseJSON: <T,>(text: string): T | null => {
    try { return JSON.parse(text) as T; } catch { return null; }
  },
}));

const { TranscriptAuditor } = await import("../../src/modules/transcript-auditor");

async function waitFor(pred: () => boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await Bun.sleep(10);
  }
}

function makeAuditor(opts: {
  routerExecute?: () => Promise<any>;
  agentAdapter?: any;
} = {}) {
  const events: Array<{ event: string; data: any }> = [];
  const eventBus = {
    emit: (event: string, data: any) => { events.push({ event, data }); },
    on: () => {},
    off: () => {},
  } as any;

  const context = {
    addStageDocument: () => {},
    getRecentTranscript: () => [{ role: "user", text: "hi", ts: Date.now() }],
  } as any;

  const automationRouter = {
    classify: () => ({ layer: "computer_use", confidence: 0.3, action: "generic", params: {}, reason: "t" }),
    execute: opts.routerExecute || (async () => ({ layer: "shortcuts", success: true, result: "ok", durationMs: 1 })),
    fileIndex: { build: async () => {}, clear: () => {}, ready: false },
  } as any;

  const auditor = new TranscriptAuditor({
    context,
    eventBus,
    automationRouter,
    computerUse: { isConfigured: false } as any,
    meetingPrepSkill: { currentBrief: null, addLiveNote: () => {} } as any,
    meetJoiner: {} as any,
    agentAdapter: opts.agentAdapter,
  });

  return { auditor, events, context, automationRouter };
}

// ═══════════════════════════════════════════════════════════════════
// 1. P1 STEP 2 — research completion routes through the unified sink
//    (was P0.1: replaceContext(singleton) + requestDeliberateResponse; the
//    producer now builds a DeliberateResult envelope and calls
//    voice.deliverDeliberateResult — proving the contract on the primary
//    producer). Still asserts the original P0.1 invariant: no throw, no false
//    "failed" note when the model is non-idle.
// ═══════════════════════════════════════════════════════════════════

test("P1.2/P1.3: research completion builds an envelope → the ONE sink (no throw, no false-failure note)", async () => {
  const REAL_RESULT =
    "Competitor pricing overview: Acme charges $10/mo, Globex $12/mo, Initech $8/mo. " +
    "Most bundle analytics. Prices have trended down ~5% YoY across the segment.";

  const agentAdapter = {
    connected: true,
    executeTask: async () => REAL_RESULT,
  };

  // Stub voice: NON-idle, and deliberately has NO `client` field — so any
  // reach into a private client (the old broken branch) would throw. It records
  // the envelope handed to the sink instead of the old replaceContext call.
  const stubVoice: any = {
    connected: true,
    audioState: "speaking", // non-idle → the previously-broken else branch
    userTurnId: 7,
    injectContextCalls: [] as string[],
    deliverCalls: [] as any[],
    injectContext(t: string) { this.injectContextCalls.push(t); return "id"; },
    // The unified sink — records the envelope; returns an honest disposition.
    deliverDeliberateResult(env: any) { this.deliverCalls.push(env); return "response-requested"; },
  };

  const { auditor, events } = makeAuditor({ agentAdapter });
  (auditor as any)._active = true;
  (auditor as any).voice = stubVoice;

  const home = mkdtempSync(join(tmpdir(), "cc-research-"));
  mkdirSync(join(home, ".callingclaw", "shared"), { recursive: true });
  const prevHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const r = await (auditor as any).dispatchResearchTask("competitor pricing");
    expect(r.started).toBe(true);
    await waitFor(() => events.some((e) => e.event === "research.completed"));
  } finally {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }

  // Routed through the ONE sink exactly once (NOT the phantom client method,
  // NOT a hand-rolled replaceContext + response.create).
  expect(stubVoice.deliverCalls.length).toBe(1);
  const env = stubVoice.deliverCalls[0];
  expect(env.kind).toBe("research");
  expect(env.speak).toBe("proactive");
  expect(env.error).toBeUndefined();               // success → NOT an error envelope
  expect(env.sourceUtterance).toBe("competitor pricing");
  expect(env.detail).toContain("Competitor pricing overview");
  expect(env.sourceTurnId).toBe(7);                // stamped from voice.userTurnId at dispatch

  // Per-TASK replaceId — NOT the shared singleton "ctx_research_result" that
  // caused concurrent researches to clobber each other.
  expect(env.replaceId).toMatch(/^ctx_research_\d+_\d+$/);
  expect(env.replaceId).not.toBe("ctx_research_result");

  // No FALSE failure note injected (the exact bug the P0 blocker produced).
  const failNote = stubVoice.injectContextCalls.find((t: string) => /failed|returned an error/i.test(t));
  expect(failNote).toBeUndefined();

  // research.completed carries a real result, not an error.
  const completed = events.find((e) => e.event === "research.completed")!;
  expect(completed.data.error).toBeUndefined();
  expect(completed.data.resultPreview).toContain("Competitor pricing");
});

// ═══════════════════════════════════════════════════════════════════
// 2. P0.2 medium lane — hung classifyIntent times out, lane recovers
// ═══════════════════════════════════════════════════════════════════

test("P0.2: hung classifyIntent times out → _processing cleared, auditor.error emitted, lane recovers", async () => {
  const { auditor, events, context } = makeAuditor();
  (auditor as any)._active = true;
  (auditor as any).AUDITOR_LANE_TIMEOUT_MS = 50;
  (auditor as any)._lastAuditedTs = 0;
  (auditor as any)._lastExecutionTs = 0;

  // Hang forever.
  (auditor as any).classifyIntent = () => new Promise(() => {});

  const t0 = Date.now();
  await (auditor as any).runAudit();
  const elapsed = Date.now() - t0;

  // Guard cleared (not stranded), resolved near the bound.
  expect((auditor as any)._processing).toBe(false);
  expect(elapsed).toBeLessThan(1500);

  const err = events.find((e) => e.event === "auditor.error");
  expect(err).toBeDefined();
  expect(String(err!.data.error)).toContain("timeout");

  // Lane recovered: a subsequent audit is NOT blocked by a stuck _processing flag.
  let classifyCalled = 0;
  (auditor as any).classifyIntent = async () => {
    classifyCalled++;
    return { action: null, params: {}, confidence: 0, reasoning: "" };
  };
  (auditor as any)._lastAuditedTs = 0;
  (auditor as any)._lastExecutionTs = 0;
  context.getRecentTranscript = () => [{ role: "user", text: "again", ts: Date.now() }];
  await (auditor as any).runAudit();
  expect(classifyCalled).toBe(1);
});

// ═══════════════════════════════════════════════════════════════════
// 3. P0.2 fast lane — hung router times out
// ═══════════════════════════════════════════════════════════════════

test("P0.2: hung fast-lane router times out → _fastLaneProcessing cleared, auditor.error emitted", async () => {
  const { auditor, events } = makeAuditor({
    routerExecute: () => new Promise(() => {}), // hang forever
  });
  (auditor as any)._active = true;
  (auditor as any).AUDITOR_LANE_TIMEOUT_MS = 50;

  const intent = { action: "meet_mute", layer: "meet", confidence: 0.95, params: {}, reason: "test" } as any;

  const t0 = Date.now();
  await (auditor as any).tryFastLane("mute the mic", intent);
  const elapsed = Date.now() - t0;

  expect((auditor as any)._fastLaneProcessing).toBe(false);
  expect(elapsed).toBeLessThan(1500);

  const err = events.find((e) => e.event === "auditor.error" && /timeout/.test(String(e.data.error)));
  expect(err).toBeDefined();
});
