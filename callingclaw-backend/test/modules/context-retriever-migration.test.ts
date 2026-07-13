// ContextRetriever → unified contract (P1 STEP 3, P1.5)
//
// Proves the migration of the ContextRetriever deliberate producer onto the ONE
// sink (voice.deliverDeliberateResult):
//   1. answered pending question → { kind:"retrieval", speak:"proactive" }. The
//      old speakWithInstruction soft-guard is now the sink's deterministic
//      turn-lease (sourceTurnId stamped at dispatch).
//   2. background hint → { kind:"retrieval", speak:"silent" } (inject only).
//   3. SIDE EFFECTS PRESERVED: the content still lands as Layer-2 liveNotes
//      (addLiveNote + pushContextUpdate → voice.injectContext), and file paths
//      in the content are still registered as Stage documents (addStageDocument).
//      Only the voice-DELIVERY path moved to the sink.

import { test, expect, describe } from "bun:test";
import { ContextRetriever } from "../../src/modules/context-retriever";

function makeHarness() {
  const liveNotes: string[] = [];
  const addLiveNoteCalls: string[] = [];
  const brief: any = { topic: "t", liveNotes };
  const meetingPrepSkill: any = {
    currentBrief: brief,
    addLiveNote(n: string) { addLiveNoteCalls.push(n); liveNotes.push(n); },
  };

  const envelopes: any[] = [];
  const injectCalls: string[] = [];
  const voice: any = {
    connected: true,
    userTurnId: 7,
    injectContext(t: string) { injectCalls.push(t); return "id"; },
    deliverDeliberateResult(env: any) { envelopes.push(env); return "response-requested"; },
  };

  const stageDocs: string[] = [];
  const context: any = {
    on() {}, off() {},
    getRecentTranscript() { return []; },
    addStageDocument(p: string) { stageDocs.push(p); },
  };
  const eventBus: any = { emit() {} };

  const r = new ContextRetriever({ context, eventBus, meetingPrepSkill });
  (r as any).voice = voice;

  return { r, envelopes, addLiveNoteCalls, injectCalls, stageDocs };
}

describe("ContextRetriever injectIntoVoice → sink", () => {
  test("answered pending question → proactive retrieval envelope via the sink", () => {
    const { r, envelopes } = makeHarness();
    (r as any).injectIntoVoice(
      [{ query: "acme pricing", content: "Acme is $99/mo enterprise.", retrievedAt: Date.now() }],
      { answeredQuestion: true, dispatchedAt: 1000, sourceTurnId: 7, sourceUtterance: "what's acme pricing?" },
    );

    expect(envelopes.length).toBe(1);
    const env = envelopes[0];
    expect(env.kind).toBe("retrieval");
    expect(env.speak).toBe("proactive");
    expect(env.sourceUtterance).toBe("what's acme pricing?");
    expect(env.sourceTurnId).toBe(7);            // turn-lease clock stamped at dispatch
    expect(env.dispatchedAt).toBe(1000);
    expect(env.id).toMatch(/^retrieval_1000_\d+$/);
    // Lean marker (not the body — body is in liveNotes; no double-inject).
    expect(env.detail).toBeUndefined();
    expect(env.summary).toContain("acme pricing");
    // Fix #5: the "follow up NOW … else stay silent" imperative is now an
    // EPHEMERAL one-turn `instruction` (the sink passes it as
    // response.create.instructions, NOT persisted to Layer 3) — NOT the summary.
    expect(env.instruction).toBeDefined();
    expect(env.instruction.toLowerCase()).toContain("follow up now");
    expect(env.instruction.toLowerCase()).toContain("stay silent"); // the guard
    // The persisted summary must NOT carry the imperative (that was the bug).
    expect(env.summary.toLowerCase()).not.toContain("follow up now");
  });

  test("background hint (no answered question) → silent retrieval envelope", () => {
    const { r, envelopes } = makeHarness();
    (r as any).injectIntoVoice(
      [{ query: "roadmap themes", content: "Q3 focuses on latency.", retrievedAt: Date.now() }],
      { answeredQuestion: false, dispatchedAt: 2000, sourceTurnId: 7 },
    );

    expect(envelopes.length).toBe(1);
    expect(envelopes[0].kind).toBe("retrieval");
    expect(envelopes[0].speak).toBe("silent");
    // Falls back to topicSummary for the label when no explicit sourceUtterance.
    expect(envelopes[0].sourceUtterance).toBe("roadmap themes");
    // Silent hint carries NO ephemeral instruction (it never triggers a response,
    // so there is no imperative to make one-turn; fix #5 scope is the answered path).
    expect(envelopes[0].instruction).toBeUndefined();
  });

  test("SIDE EFFECTS preserved: liveNote added + injected, file path → Stage document", () => {
    const { r, addLiveNoteCalls, injectCalls, stageDocs } = makeHarness();
    (r as any).injectIntoVoice(
      [{ query: "design doc", content: "See the spec at /Users/x/.callingclaw/shared/design.md for details.", retrievedAt: Date.now() }],
      { answeredQuestion: true, dispatchedAt: 3000, sourceTurnId: 7, sourceUtterance: "where's the design doc?" },
    );

    // addLiveNote called with the [CONTEXT] content block (Layer-2 mission memory).
    expect(addLiveNoteCalls.some((n) => n.startsWith("[CONTEXT] design doc:"))).toBe(true);
    // pushContextUpdate injected that liveNote into the voice session (content path).
    expect(injectCalls.some((t) => t.startsWith("[CONTEXT] design doc:"))).toBe(true);
    // The file path in the content was registered as a Stage document.
    expect(stageDocs).toContain("/Users/x/.callingclaw/shared/design.md");
  });
});
