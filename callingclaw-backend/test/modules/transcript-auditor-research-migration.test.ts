// TranscriptAuditor research_task → unified contract (P1 STEP 2, P1.3)
//
// Proves the migration of the PRIMARY deliberate producer:
//   1. On success the producer builds a DeliberateResult envelope and hands it
//      to the ONE sink (voice.deliverDeliberateResult) — kind/speak/replaceId/
//      sourceUtterance/sourceTurnId all stamped; NO hand-rolled replaceContext +
//      response.create, NO reach into a private client.
//   2. Two CONCURRENT researches use DISTINCT per-task replaceIds — the fix for
//      the "ctx_research_result" singleton that made a 2nd research clobber the
//      1st in Layer 3.
//   3. A FAILURE (reject OR a short error-shaped result) routes through the
//      envelope with `error` set → the sink suppresses it. The producer no
//      longer injects a false "[RESEARCH] … failed" note that the model could
//      speak as if it were the answer.

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

function makeStubVoice() {
  return {
    connected: true,
    audioState: "listening",
    userTurnId: 3,
    injectContextCalls: [] as string[],
    deliverCalls: [] as any[],
    injectContext(t: string) { this.injectContextCalls.push(t); return "id"; },
    deliverDeliberateResult(env: any) { this.deliverCalls.push(env); return "response-requested"; },
  };
}

function makeAuditor(executeTask: (prompt: string) => Promise<string>) {
  const events: Array<{ event: string; data: any }> = [];
  const eventBus = {
    emit: (event: string, data: any) => { events.push({ event, data }); },
    on: () => {}, off: () => {},
  } as any;
  const context = {
    addStageDocument: () => {},
    getRecentTranscript: () => [{ role: "user", text: "hi", ts: Date.now() }],
  } as any;
  const automationRouter = {
    classify: () => ({ layer: "computer_use", confidence: 0.3, action: "generic", params: {}, reason: "t" }),
    execute: async () => ({ layer: "shortcuts", success: true, result: "ok", durationMs: 1 }),
    fileIndex: { build: async () => {}, clear: () => {}, ready: false },
  } as any;
  const auditor = new TranscriptAuditor({
    context, eventBus, automationRouter,
    computerUse: { isConfigured: false } as any,
    meetingPrepSkill: { currentBrief: null, addLiveNote: () => {} } as any,
    meetJoiner: {} as any,
    agentAdapter: { connected: true, executeTask },
  });
  return { auditor, events };
}

function withTmpHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "cc-research-mig-"));
  mkdirSync(join(home, ".callingclaw", "shared"), { recursive: true });
  const prev = process.env.HOME;
  process.env.HOME = home;
  return fn().finally(() => {
    process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });
}

// ═══════════════════════════════════════════════════════════════════
// 1. Success → envelope → sink
// ═══════════════════════════════════════════════════════════════════

test("success: builds a research envelope and calls the ONE sink (no client access)", async () => {
  const RESULT = "Finding: the market grew 12% in Q2. ".repeat(20);
  const { auditor, events } = makeAuditor(async () => RESULT);
  const voice = makeStubVoice();
  (auditor as any)._active = true;
  (auditor as any).voice = voice;

  await withTmpHome(async () => {
    const r = await (auditor as any).dispatchResearchTask("market growth Q2");
    expect(r.started).toBe(true);
    await waitFor(() => events.some((e) => e.event === "research.completed"));
  });

  expect(voice.deliverCalls.length).toBe(1);
  const env = voice.deliverCalls[0];
  expect(env.kind).toBe("research");
  expect(env.speak).toBe("proactive");
  expect(env.error).toBeUndefined();
  expect(env.sourceUtterance).toBe("market growth Q2");
  expect(env.sourceTurnId).toBe(3);              // stamped from voice.userTurnId
  expect(env.detail).toContain("market grew 12%");
  expect(env.replaceId).toMatch(/^ctx_research_\d+_\d+$/);
});

// ═══════════════════════════════════════════════════════════════════
// 2. Concurrent researches → distinct replaceIds (no clobber)
// ═══════════════════════════════════════════════════════════════════

test("concurrent: two researches use DISTINCT per-task replaceIds (fixes ctx_research_result clobber)", async () => {
  const { auditor, events } = makeAuditor(async (prompt: string) =>
    `Result for ${prompt.slice(0, 40)} — ` + "x".repeat(250),
  );
  const voice = makeStubVoice();
  (auditor as any)._active = true;
  (auditor as any).voice = voice;

  await withTmpHome(async () => {
    // Two DIFFERENT queries dispatched together (distinct normalized → both run).
    await Promise.all([
      (auditor as any).dispatchResearchTask("competitor pricing"),
      (auditor as any).dispatchResearchTask("market size"),
    ]);
    await waitFor(() => voice.deliverCalls.length === 2);
  });

  expect(voice.deliverCalls.length).toBe(2);
  const [a, b] = voice.deliverCalls;
  // The exact bug this fixes: both used the SINGLE "ctx_research_result".
  expect(a.replaceId).not.toBe(b.replaceId);
  expect(a.replaceId).not.toBe("ctx_research_result");
  expect(b.replaceId).not.toBe("ctx_research_result");
  expect(a.replaceId).toMatch(/^ctx_research_/);
  expect(b.replaceId).toMatch(/^ctx_research_/);
  // Two distinct completion events (both real, neither an error).
  const completed = events.filter((e) => e.event === "research.completed");
  expect(completed.length).toBe(2);
  expect(completed.every((e) => e.data.error === undefined)).toBe(true);
});

// ═══════════════════════════════════════════════════════════════════
// 3. Failure → error envelope → sink (never a false spoken "failed")
// ═══════════════════════════════════════════════════════════════════

test("rejection: envelope carries `error`, producer injects NO false failure note", async () => {
  const { auditor, events } = makeAuditor(async () => { throw new Error("agent exploded"); });
  const voice = makeStubVoice();
  (auditor as any)._active = true;
  (auditor as any).voice = voice;

  await withTmpHome(async () => {
    await (auditor as any).dispatchResearchTask("volatile topic");
    await waitFor(() => events.some((e) => e.event === "research.completed"));
  });

  expect(voice.deliverCalls.length).toBe(1);
  const env = voice.deliverCalls[0];
  expect(env.kind).toBe("research");
  expect(env.error).toBe("agent exploded");
  // The producer no longer hand-injects a spoken "[RESEARCH] … failed" note.
  const falseFailure = voice.injectContextCalls.find((t: string) => /failed|returned an error/i.test(t));
  expect(falseFailure).toBeUndefined();
  // completion event still records the error for the S2 panel.
  const completed = events.find((e) => e.event === "research.completed")!;
  expect(completed.data.error).toBe("agent exploded");
});

test("short error-shaped result → envelope with `error` set (sentinel), not spoken as fact", async () => {
  const { auditor, events } = makeAuditor(async () => "Search failed: upstream unavailable");
  const voice = makeStubVoice();
  (auditor as any)._active = true;
  (auditor as any).voice = voice;

  await withTmpHome(async () => {
    await (auditor as any).dispatchResearchTask("flaky query");
    await waitFor(() => events.some((e) => e.event === "research.completed"));
  });

  expect(voice.deliverCalls.length).toBe(1);
  expect(voice.deliverCalls[0].error).toContain("Search failed");
  const completed = events.find((e) => e.event === "research.completed")!;
  expect(completed.data.error).toContain("Search failed");
});
