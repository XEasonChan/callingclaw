// VoiceModule.deliverDeliberateResult — P1 STEP 2, the unified S2→S1 sink.
//
// Drives the real VoiceModule sink (with a fake RealtimeClient) over the matrix
// the contract must own in ONE place:
//   - sentinel safety FIRST: error → "error-suppressed", NO speech, neutral note
//   - injection-layer choice: replaceId → replace (removeContext+inject) vs FIFO
//   - fresh proactive → "response-requested" (idle) / "deferred" (busy)
//   - late proactive → "injected-silent" (turn-lease downgrade, no speech)
//   - very stale → "dropped-stale", decided BEFORE injecting (nothing injected)
//   - dedup by per-dispatch id → "dropped-duplicate"
//   - no session → "no-session"
//
// The VoiceModule builds its own RealtimeClient; we swap in a fake and re-run
// setupEventHandlers() (the scheduler's send/isConnected closures read
// this.client lazily so they bind to the fake).

import { test, expect, describe } from "bun:test";
import type { DeliberateResult } from "../../src/modules/deliberate-result";

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
    on(type: string, h: Function) { const l = handlers.get(type) || []; l.push(h); handlers.set(type, l); },
    emit(type: string, ev: any = {}) { for (const h of handlers.get(type) || []) h(ev); },
    sendEvent(type: string, data: any = {}) { fake.sent.push({ type, data }); return true; },
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

function makeVoice() {
  const voice = new VoiceModule({ context: { addTranscript() {}, getRecentTranscript: () => [] } as any });
  const fake = makeFakeClient();
  (voice as any).client = fake;
  (voice as any).setupEventHandlers();
  return { voice, fake };
}

const creates = (fake: any) => fake.sent.filter((e: any) => e.type === "response.create");

function baseEnvelope(over: Partial<DeliberateResult> = {}): DeliberateResult {
  return {
    id: `d_${Math.random().toString(36).slice(2)}`,
    kind: "research",
    summary: "one-line answer",
    detail: "full detail body",
    sourceUtterance: "acme pricing",
    dispatchedAt: Date.now(),
    speak: "proactive",
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Sentinel safety FIRST
// ═══════════════════════════════════════════════════════════════════

describe("sentinel safety", () => {
  test("error envelope → 'error-suppressed', NO speech, a neutral note (not the error) injected", () => {
    const { voice, fake } = makeVoice();
    const disp = voice.deliverDeliberateResult(baseEnvelope({ error: "billing error secret-xyz" }));

    expect(disp).toBe("error-suppressed");
    expect(creates(fake).length).toBe(0);            // NEVER speaks the failure
    expect(fake.injects.length).toBe(1);             // a neutral note WAS injected
    expect(fake.injects[0].text.toLowerCase()).toContain("did not return a usable");
    expect(fake.injects[0].text).not.toContain("secret-xyz"); // raw error never leaks
  });

  test("error is checked BEFORE staleness/dedup (a stale error still suppresses cleanly)", () => {
    const { voice, fake } = makeVoice();
    (voice as any)._userTurnId = 50;
    const disp = voice.deliverDeliberateResult(baseEnvelope({ sourceTurnId: 1, error: "timeout" }));
    expect(disp).toBe("error-suppressed");
    expect(creates(fake).length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Injection-layer choice
// ═══════════════════════════════════════════════════════════════════

describe("injection-layer choice", () => {
  test("replaceId → in-place replace (removeContext + inject with id)", () => {
    const { voice, fake } = makeVoice();
    voice.deliverDeliberateResult(baseEnvelope({ replaceId: "ctx_research_1", sourceTurnId: 0 }));
    expect(fake.removes).toContain("ctx_research_1");
    expect(fake.injects[0].id).toBe("ctx_research_1");
  });

  test("no replaceId → FIFO inject (no removeContext, no id)", () => {
    const { voice, fake } = makeVoice();
    voice.deliverDeliberateResult(baseEnvelope({ sourceTurnId: 0 }));
    expect(fake.removes.length).toBe(0);
    expect(fake.injects[0].id).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Fresh proactive → gated speech
// ═══════════════════════════════════════════════════════════════════

describe("fresh proactive → gated response", () => {
  test("idle → 'response-requested' + exactly one response.create + injected", () => {
    const { voice, fake } = makeVoice();
    (voice as any)._userTurnId = 5;
    const disp = voice.deliverDeliberateResult(baseEnvelope({ sourceTurnId: 5 }));
    expect(disp).toBe("response-requested");
    expect(creates(fake).length).toBe(1);
    expect(fake.injects.length).toBe(1);
  });

  test("busy (a response active) → 'deferred', injected, NO immediate create", () => {
    const { voice, fake } = makeVoice();
    (voice as any)._userTurnId = 5;
    (voice as any)._responseActive = true; // scheduler.busy → defers
    const disp = voice.deliverDeliberateResult(baseEnvelope({ sourceTurnId: 5 }));
    expect(disp).toBe("deferred");
    expect(creates(fake).length).toBe(0);            // did not collide with active response
    expect(fake.injects.length).toBe(1);             // still injected into Layer 3
  });
});

// ═══════════════════════════════════════════════════════════════════
// Turn-lease downgrades + drop
// ═══════════════════════════════════════════════════════════════════

describe("turn-lease staleness", () => {
  test("late proactive (topic moved on) → 'injected-silent', injected, NO speech", () => {
    const { voice, fake } = makeVoice();
    (voice as any)._userTurnId = 8;
    const disp = voice.deliverDeliberateResult(baseEnvelope({ sourceTurnId: 5 })); // 3 turns elapsed
    expect(disp).toBe("injected-silent");
    expect(creates(fake).length).toBe(0);
    expect(fake.injects.length).toBe(1);             // still useful context, silently
  });

  test("silent producer → 'injected-silent' regardless of freshness", () => {
    const { voice, fake } = makeVoice();
    (voice as any)._userTurnId = 5;
    const disp = voice.deliverDeliberateResult(baseEnvelope({ sourceTurnId: 5, speak: "silent" }));
    expect(disp).toBe("injected-silent");
    expect(creates(fake).length).toBe(0);
    expect(fake.injects.length).toBe(1);
  });

  test("very stale → 'dropped-stale', decided BEFORE injecting (nothing injected, no speech)", () => {
    const { voice, fake } = makeVoice();
    (voice as any)._userTurnId = 20;
    const disp = voice.deliverDeliberateResult(baseEnvelope({ sourceTurnId: 1 })); // 19 elapsed → drop
    expect(disp).toBe("dropped-stale");
    expect(fake.injects.length).toBe(0);             // drop-before-inject (codex)
    expect(fake.removes.length).toBe(0);
    expect(creates(fake).length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Dedup + no-session
// ═══════════════════════════════════════════════════════════════════

describe("dedup + no-session", () => {
  test("same per-dispatch id twice → second is 'dropped-duplicate' (injected once)", () => {
    const { voice, fake } = makeVoice();
    (voice as any)._userTurnId = 5;
    const env = baseEnvelope({ id: "dup-1", sourceTurnId: 5 });
    expect(voice.deliverDeliberateResult(env)).toBe("response-requested");
    expect(voice.deliverDeliberateResult(env)).toBe("dropped-duplicate");
    expect(fake.injects.length).toBe(1);             // NOT injected twice
    expect(creates(fake).length).toBe(1);            // NOT spoken twice
  });

  test("no live session → 'no-session', nothing injected or sent", () => {
    const { voice, fake } = makeVoice();
    fake.connected = false;
    const disp = voice.deliverDeliberateResult(baseEnvelope({ sourceTurnId: 0 }));
    expect(disp).toBe("no-session");
    expect(fake.injects.length).toBe(0);
    expect(creates(fake).length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// User-turn counter increments on user speech
// ═══════════════════════════════════════════════════════════════════

describe("user-turn counter (the lease clock)", () => {
  test("increments on each completed user utterance", () => {
    const { voice, fake } = makeVoice();
    const before = voice.userTurnId;
    fake.emit("conversation.item.input_audio_transcription.completed", { transcript: "hello there" });
    fake.emit("conversation.item.input_audio_transcription.completed", { transcript: "and another" });
    expect(voice.userTurnId).toBe(before + 2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Fix #1 — a legit SHORT answer that merely READS error-shaped is SPOKEN,
// not suppressed. The sink trusts the producer's explicit `error` field ONLY;
// it never content-sniffs a SUCCESS envelope. (The old <200-char backstop
// re-created the original blocker: the AI withholds an answer it actually has.)
// ═══════════════════════════════════════════════════════════════════

describe("legit short answer not suppressed (fix #1)", () => {
  test("recall answer 'Deploy failed on the 14th' (no error field) → SPOKEN, not error-suppressed", () => {
    const { voice, fake } = makeVoice();
    (voice as any)._userTurnId = 3;
    const disp = voice.deliverDeliberateResult({
      id: "legit-1", kind: "recall",
      summary: "Deploy failed on the 14th", detail: "Deploy failed on the 14th",
      sourceUtterance: "when did the deploy fail?",
      sourceTurnId: 3, dispatchedAt: Date.now(), speak: "proactive",
    });
    expect(disp).toBe("response-requested");          // SPOKEN — NOT "error-suppressed"
    expect(creates(fake).length).toBe(1);
    // The real answer reached Layer 3 as [RECALL] content …
    expect(fake.injects.some((i: any) => i.text.includes("Deploy failed on the 14th"))).toBe(true);
    // … and the neutral error note was NOT injected (it was not treated as failure).
    expect(fake.injects.some((i: any) => i.text.includes("did not return a usable"))).toBe(false);
  });

  test("recall answer 'The server was unavailable' (no error field) → also SPOKEN", () => {
    const { voice, fake } = makeVoice();
    (voice as any)._userTurnId = 1;
    const disp = voice.deliverDeliberateResult({
      id: "legit-2", kind: "recall", summary: "The server was unavailable",
      sourceTurnId: 1, dispatchedAt: Date.now(), speak: "proactive",
    });
    expect(disp).toBe("response-requested");
    expect(creates(fake).length).toBe(1);
    expect(fake.injects.some((i: any) => i.text.includes("did not return a usable"))).toBe(false);
  });

  test("same short answer WITH an explicit error IS suppressed (producer verdict is authoritative)", () => {
    const { voice, fake } = makeVoice();
    (voice as any)._userTurnId = 3;
    const disp = voice.deliverDeliberateResult({
      id: "legit-3", kind: "recall", summary: "Deploy failed on the 14th",
      sourceTurnId: 3, dispatchedAt: Date.now(), speak: "proactive",
      error: "All channels failed",
    });
    expect(disp).toBe("error-suppressed");
    expect(creates(fake).length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Fix #5 — the ephemeral one-turn instruction rides response.create.instructions
// and is NEVER persisted to Layer 3 (so a guarded imperative can't linger / re-fire).
// ═══════════════════════════════════════════════════════════════════

describe("ephemeral instruction (fix #5)", () => {
  test("instruction → response.create.instructions, NOT an injectContext (not persisted to Layer 3)", () => {
    const { voice, fake } = makeVoice();
    (voice as any)._userTurnId = 9;
    const IMPERATIVE = "follow up NOW with the concrete answer in one or two sentences; else stay silent";
    const disp = voice.deliverDeliberateResult({
      id: "eph-1", kind: "retrieval",
      summary: "Background information is now available about: acme pricing.",
      sourceUtterance: "what's acme pricing?",
      sourceTurnId: 9, dispatchedAt: Date.now(), speak: "proactive",
      instruction: IMPERATIVE,
    });
    expect(disp).toBe("response-requested");
    // The one-turn instruction rode the gated response.create (ephemeral).
    const create = creates(fake)[0];
    expect(create).toBeDefined();
    expect(create.data?.response?.instructions).toBe(IMPERATIVE);
    // It was NEVER persisted to Layer 3 — no injectContext carries the imperative.
    expect(fake.injects.some((i: any) => i.text.includes(IMPERATIVE))).toBe(false);
    expect(fake.injects.some((i: any) => i.text.includes("follow up NOW"))).toBe(false);
    // The lean NON-imperative marker (summary) WAS injected as Layer-3 context.
    expect(fake.injects.some((i: any) => i.text.includes("acme pricing"))).toBe(true);
  });

  test("no instruction → bare response.create (no response.instructions)", () => {
    const { voice, fake } = makeVoice();
    (voice as any)._userTurnId = 2;
    voice.deliverDeliberateResult(baseEnvelope({ sourceTurnId: 2 }));
    const create = creates(fake)[0];
    expect(create).toBeDefined();
    expect(create.data?.response?.instructions).toBeUndefined();
  });

  test("late proactive with an instruction → downgraded to silent, NO response.create fires (turn-lease still gates)", () => {
    const { voice, fake } = makeVoice();
    (voice as any)._userTurnId = 8; // 3 turns elapsed → inject-silent
    const disp = voice.deliverDeliberateResult({
      id: "eph-2", kind: "retrieval", summary: "marker about roadmap",
      sourceTurnId: 5, dispatchedAt: Date.now(), speak: "proactive",
      instruction: "follow up NOW",
    });
    expect(disp).toBe("injected-silent");
    expect(creates(fake).length).toBe(0);              // instruction does NOT bypass the lease
  });
});
