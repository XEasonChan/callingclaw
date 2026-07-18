// VoiceModule — P0.1 requestDeliberateResponse() + P0.3 response watchdog
//
// Covers:
//   1. requestDeliberateResponse(): idle → fires response.create; busy
//      (_responseActive) → defers via the existing gate and flushes on the next
//      response.done; disconnected → returns false, sends nothing.
//   2. checkResponseWatchdog() (ACTING): detects the stuck condition at/above the
//      threshold, stays quiet below it and for a healthy streaming response, and
//      when the connection generation still matches the stuck response it RESETS
//      the gate → listening (generation-guarded so a reconnect-superseded
//      response is NOT reset — that guard is exercised in generation-token.test.ts).
//
// The VoiceModule builds its own RealtimeClient internally, so we swap in a fake
// client and re-run setupEventHandlers() so the module's handlers attach to it.

import { test, expect } from "bun:test";

const { VoiceModule } = await import("../../src/modules/voice");

function makeFakeClient() {
  const handlers = new Map<string, Function[]>();
  const fake: any = {
    connected: true,
    providerName: "openai",
    capabilities: {},
    // Connection generation-token. The response-watchdog compares this to the
    // scheduler's stamped responseGeneration; equal → the stuck response still
    // belongs to this connection → safe to reset. Bump this to simulate a
    // reconnect having superseded the response.
    connectionGeneration: 0,
    sent: [] as Array<{ type: string; data: any }>,
    speaking: false,
    on(type: string, h: Function) {
      const l = handlers.get(type) || [];
      l.push(h);
      handlers.set(type, l);
    },
    emit(type: string, ev: any = {}) {
      for (const h of handlers.get(type) || []) h(ev);
    },
    sendEvent(type: string, data: any = {}) {
      fake.sent.push({ type, data });
      return true;
    },
    setSpeaking(s: boolean) { fake.speaking = s; },
    flushPendingResponse() {},
    injectContext(_t: string, id?: string) { return id || "item"; },
    removeContext() { return true; },
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
  (voice as any).setupEventHandlers(); // re-attach handlers to the fake
  return { voice, fake };
}

function createEvents(fake: any) {
  return fake.sent.filter((e: any) => e.type === "response.create");
}

// ═══════════════════════════════════════════════════════════════════
// P0.1 — requestDeliberateResponse()
// ═══════════════════════════════════════════════════════════════════

test("P0.1: idle → fires exactly one gated response.create", () => {
  const { voice, fake } = makeVoice();
  (voice as any)._responseActive = false;

  const ok = voice.requestDeliberateResponse();

  expect(ok).toBe(true);
  expect(createEvents(fake).length).toBe(1);
});

test("P0.1: busy (_responseActive) → defers, no immediate send, flushes on response.done", async () => {
  const { voice, fake } = makeVoice();
  (voice as any)._responseActive = true;
  fake.sent.length = 0;

  const ok = voice.requestDeliberateResponse();
  expect(ok).toBe(true);

  // Deferred — nothing sent yet, payload parked on the existing gate.
  expect(createEvents(fake).length).toBe(0);
  expect((voice as any)._pendingResponseCreate).not.toBeNull();

  // Model finishes → the deferred response.create flushes (50ms settle delay).
  fake.emit("response.done", {});
  expect((voice as any)._pendingResponseCreate).toBeNull(); // cleared synchronously
  await Bun.sleep(90);

  expect(createEvents(fake).length).toBe(1);
});

test("P0.1: no live session → returns false, sends nothing (no throw, no private-client access)", () => {
  const { voice, fake } = makeVoice();
  fake.connected = false;
  fake.sent.length = 0;

  const ok = voice.requestDeliberateResponse();

  expect(ok).toBe(false);
  expect(fake.sent.length).toBe(0);
});

// ═══════════════════════════════════════════════════════════════════
// P0.3 → ACTING — response watchdog
// ═══════════════════════════════════════════════════════════════════

const NOW = 1_000_000_000;

test("watchdog: thinking with no deltas past threshold + generation matches → RESETS to listening", () => {
  const { voice, fake } = makeVoice();
  fake.connected = true;
  fake.connectionGeneration = 0; // matches the scheduler's stamped gen (0)
  (voice as any)._responseActive = true;
  (voice as any)._audioState = "thinking";
  (voice as any)._audioStateTs = NOW - 31_000; // 31s > 30s threshold
  (voice as any)._lastAudioOutputTs = NOW - 31_000;

  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...a: any[]) => { warnings.push(a.join(" ")); };
  try {
    expect(voice.checkResponseWatchdog(NOW)).toBe(true);
  } finally {
    console.warn = orig;
  }

  // Observe log preserved + acting log emitted.
  expect(warnings.some((w) => w.includes("response appears stuck"))).toBe(true);
  expect(warnings.some((w) => w.includes("resetting stuck response"))).toBe(true);
  // ACTING: the gate is reset and the state machine returns to listening so the
  // next user turn is answered (mute-forever barge-in recovery).
  expect((voice as any)._responseActive).toBe(false);
  expect((voice as any)._audioState).toBe("listening");
});

test("P0.3: within threshold → no detection", () => {
  const { voice } = makeVoice();
  (voice as any)._responseActive = true;
  (voice as any)._audioState = "thinking";
  (voice as any)._audioStateTs = NOW - 10_000; // 10s < 30s
  (voice as any)._lastAudioOutputTs = NOW - 10_000;

  expect(voice.checkResponseWatchdog(NOW)).toBe(false);
});

test("P0.3: healthy long stream (recent delta) → not flagged even if state is old", () => {
  const { voice } = makeVoice();
  (voice as any)._responseActive = true;
  (voice as any)._audioState = "speaking";
  (voice as any)._audioStateTs = NOW - 60_000;      // speaking started 60s ago
  (voice as any)._lastAudioOutputTs = NOW - 1_000;  // but a delta arrived 1s ago

  expect(voice.checkResponseWatchdog(NOW)).toBe(false);
});

test("P0.3: not active (listening) → never flags, regardless of age", () => {
  const { voice } = makeVoice();
  (voice as any)._responseActive = false;
  (voice as any)._audioState = "listening";
  (voice as any)._audioStateTs = NOW - 99_000;
  (voice as any)._lastAudioOutputTs = NOW - 99_000;

  expect(voice.checkResponseWatchdog(NOW)).toBe(false);
});

test("P0.3: disconnected → never flags", () => {
  const { voice, fake } = makeVoice();
  fake.connected = false;
  (voice as any)._responseActive = true;
  (voice as any)._audioState = "thinking";
  (voice as any)._audioStateTs = NOW - 99_000;
  (voice as any)._lastAudioOutputTs = NOW - 99_000;

  expect(voice.checkResponseWatchdog(NOW)).toBe(false);
});
