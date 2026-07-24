// recall_context → unified contract (P1 STEP 3, P1.4)
//
// Proves the migration of the recall_context deliberate producer onto the ONE
// sink (voice.deliverDeliberateResult):
//   1. The SLOW_TOOL RETURN path builds a { kind:"recall", speak:"proactive" }
//      envelope with a PER-CALL replaceId and hands it to the sink — instead of
//      the ad-hoc injectContext("[DONE] recall_context: …") + _requestResponse().
//      Tool-call MECHANICS (submit "ok", [WORKING] filler, async work) unchanged.
//   2. A leaked dispatcher/gateway failure sentinel ("All channels failed" /
//      "Gateway not available") sets `error` → the sink error-suppresses it:
//      a NEUTRAL note is injected, the sentinel is NEVER spoken as fact, and no
//      response.create fires. This is the audited "error-spoken-as-fact" bug.
//   3. isUnusableRecallResult is precise: it flags the known sentinels but NOT a
//      genuine recalled fact that merely contains a word like "failed".

import { test, expect, describe } from "bun:test";
import type { DeliberateResult } from "../../src/modules/deliberate-result";
import { isUnusableRecallResult } from "../../src/tool-definitions/ai-tools";

const { VoiceModule } = await import("../../src/modules/voice");

function makeFakeClient() {
  const handlers = new Map<string, Function[]>();
  const fake: any = {
    connected: true,
    providerName: "openai",
    capabilities: {},
    sent: [] as Array<{ type: string; data: any }>,
    injects: [] as Array<{ text: string; id?: string }>,
    removes: [] as string[],
    toolResults: [] as Array<{ callId: string; output: string }>,
    on(type: string, h: Function) { const l = handlers.get(type) || []; l.push(h); handlers.set(type, l); },
    emit(type: string, ev: any = {}) { for (const h of handlers.get(type) || []) h(ev); },
    sendEvent(type: string, data: any = {}) { fake.sent.push({ type, data }); return true; },
    submitToolResultBackground(callId: string, output: string) { fake.toolResults.push({ callId, output }); },
    setSpeaking() {},
    injectContext(text: string, id?: string) { fake.injects.push({ text, id }); return id || "item"; },
    removeContext(id: string) { fake.removes.push(id); return true; },
    addTool() {},
    clearContextQueue() {},
    updateInstructions() { return true; },
    updateTranscriptContext() {},
    disconnect() { fake.connected = false; },
  };
  return fake;
}

function makeVoice(onToolCall?: (name: string, args: any, callId: string) => Promise<string>) {
  const voice = new VoiceModule({
    context: { addTranscript() {}, getRecentTranscript: () => [] } as any,
    onToolCall,
  });
  const fake = makeFakeClient();
  (voice as any).client = fake;
  (voice as any).setupEventHandlers();
  return { voice, fake };
}

const creates = (fake: any) => fake.sent.filter((e: any) => e.type === "response.create");

async function fireRecall(fake: any, query: string, urgency = "thorough") {
  fake.emit("response.function_call_arguments.done", {
    call_id: `call_${Math.random().toString(36).slice(2)}`,
    name: "recall_context",
    arguments: JSON.stringify({ query, urgency }),
  });
  // Let the fire-and-forget onToolCall().then() (a microtask) settle.
  await Bun.sleep(20);
}

// ═══════════════════════════════════════════════════════════════════
// 1. Success → envelope → sink (fresh proactive speaks)
// ═══════════════════════════════════════════════════════════════════

describe("recall_context success → sink", () => {
  test("SLOW_TOOL completion routes the RESULT through the sink with kind:'recall', proactive", async () => {
    const RESULT = "[Memory recall]\nAcme's Q2 ARR was $4.2M, up 18% QoQ.";
    const { voice, fake } = makeVoice(async () => RESULT);

    // Spy on the sink to capture the envelope while still exercising real routing.
    const orig = (voice as any).deliverDeliberateResult.bind(voice);
    const envelopes: DeliberateResult[] = [];
    (voice as any).deliverDeliberateResult = (r: DeliberateResult) => { envelopes.push(r); return orig(r); };

    (voice as any)._userTurnId = 4; // stamped at dispatch; unchanged at delivery → fresh
    await fireRecall(fake, "acme Q2 ARR");

    expect(envelopes.length).toBe(1);
    const env = envelopes[0]!;
    expect(env.kind).toBe("recall");
    expect(env.speak).toBe("proactive");
    expect(env.sourceUtterance).toBe("acme Q2 ARR");
    expect(env.sourceTurnId).toBe(4);
    expect(env.detail).toContain("$4.2M");
    expect(env.error).toBeUndefined();
    // PER-CALL replaceId (not a shared singleton).
    expect(env.replaceId).toMatch(/^ctx_recall_call_/);
    expect(env.id).toMatch(/^recall_call_/);

    // Fresh proactive → injected + exactly one gated response.create.
    const recallInject = fake.injects.find((i: any) => i.text.startsWith("[RECALL]"));
    expect(recallInject).toBeDefined();
    expect(recallInject.text).toContain("$4.2M");
    expect(creates(fake).length).toBe(1);
    // Tool-call MECHANICS preserved: "ok" submitted, [WORKING] filler injected.
    expect(fake.toolResults.some((t: any) => t.output === "ok")).toBe(true);
    expect(fake.injects.some((i: any) => i.text.includes('[WORKING] Running "recall_context"'))).toBe(true);
  });

  test("two recalls use DISTINCT per-call replaceIds (no singleton clobber)", async () => {
    const { voice, fake } = makeVoice(async (_n, args) => `[Memory recall]\nfact for ${args.query}`);
    const orig = (voice as any).deliverDeliberateResult.bind(voice);
    const envelopes: DeliberateResult[] = [];
    (voice as any).deliverDeliberateResult = (r: DeliberateResult) => { envelopes.push(r); return orig(r); };

    await fireRecall(fake, "first question");
    await fireRecall(fake, "second question");

    expect(envelopes.length).toBe(2);
    expect(envelopes[0]!.replaceId).not.toBe(envelopes[1]!.replaceId);
    expect(envelopes[0]!.replaceId).toMatch(/^ctx_recall_/);
    expect(envelopes[1]!.replaceId).toMatch(/^ctx_recall_/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Failure sentinel → error-suppressed (never spoken as fact)
// ═══════════════════════════════════════════════════════════════════

describe("recall_context failure sentinel → error-suppressed", () => {
  test("'All channels failed' is NOT spoken: error set, neutral note injected, no response.create", async () => {
    const LEAK = "[Recall via gateway]\nAll channels failed: Gateway not available";
    const { voice, fake } = makeVoice(async () => LEAK);
    const orig = (voice as any).deliverDeliberateResult.bind(voice);
    const envelopes: DeliberateResult[] = [];
    (voice as any).deliverDeliberateResult = (r: DeliberateResult) => { envelopes.push(r); return orig(r); };

    await fireRecall(fake, "unstable lookup");

    expect(envelopes.length).toBe(1);
    expect(envelopes[0]!.error).toContain("All channels failed");

    // NEVER spoken.
    expect(creates(fake).length).toBe(0);
    // A neutral internal note WAS injected; the raw sentinel is NOT in it.
    const note = fake.injects.find((i: any) => i.text.includes("(internal note)"));
    expect(note).toBeDefined();
    expect(note.text.toLowerCase()).toContain("did not return a usable");
    expect(note.text).not.toContain("All channels failed");
    expect(note.text).not.toContain("Gateway not available");
    // No "[RECALL]" answer block was injected as if it were content.
    expect(fake.injects.some((i: any) => i.text.startsWith("[RECALL]") && i.text.includes("All channels failed"))).toBe(false);
  });

  test("async rejection → error-suppressed (no spoken '[ERROR] … failed')", async () => {
    const { voice, fake } = makeVoice(async () => { throw new Error("dispatcher exploded"); });
    const orig = (voice as any).deliverDeliberateResult.bind(voice);
    const envelopes: DeliberateResult[] = [];
    (voice as any).deliverDeliberateResult = (r: DeliberateResult) => { envelopes.push(r); return orig(r); };

    await fireRecall(fake, "boom query");

    expect(envelopes.length).toBe(1);
    expect(envelopes[0]!.error).toBe("dispatcher exploded");
    expect(creates(fake).length).toBe(0);
    // No hand-rolled "[ERROR] recall_context failed: …" injection.
    expect(fake.injects.some((i: any) => i.text.startsWith("[ERROR]"))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. isUnusableRecallResult precision
// ═══════════════════════════════════════════════════════════════════

describe("isUnusableRecallResult", () => {
  test("flags leaked dispatcher/gateway/openclaw sentinels + non-answer apologies + empty", () => {
    expect(isUnusableRecallResult("[Recall via gateway]\nAll channels failed: x")).toBe(true);
    expect(isUnusableRecallResult("Gateway not available")).toBe(true);
    expect(isUnusableRecallResult("Dispatch failed: timeout")).toBe(true);
    expect(isUnusableRecallResult("OpenClaw error: boom")).toBe(true);
    expect(isUnusableRecallResult("(no response)")).toBe(true);
    expect(isUnusableRecallResult("I couldn't find specific information about that in my local memory.")).toBe(true);
    expect(isUnusableRecallResult("")).toBe(true);
    expect(isUnusableRecallResult("   ")).toBe(true);
    expect(isUnusableRecallResult(undefined)).toBe(true);
  });

  test("does NOT flag a genuine recalled fact that merely contains 'failed'", () => {
    expect(isUnusableRecallResult("[Memory recall]\nThe Tuesday deploy failed and we rolled back within 10 minutes.")).toBe(false);
    expect(isUnusableRecallResult("[Prep brief — decisions]\nWe chose Postgres over Mongo for ACID guarantees.")).toBe(false);
  });
});
