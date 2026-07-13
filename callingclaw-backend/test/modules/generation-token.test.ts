// Connection generation-token — the safety foundation for the three ACTING
// watchdogs (s1s2 §5 / §14 risk 2).
//
// The generation-token is a monotonic integer bumped on EVERY connection-lifecycle
// transition (fresh connect, reconnect, Gemini resume — all via _connectInternal —
// plus a liveness force-close and an intentional disconnect). Any deferred/async
// action CAPTURES the generation when scheduled and NO-OPs if it differs at
// execution time. This file pins:
//   (A) the token API: getter, monotonic bumps, and that connect/reconnect/resume
//       all funnel through the single bump point in _connectInternal;
//   (B) the response-watchdog generation guard: a stale watchdog reset (captured
//       gen != current) is a NO-OP, while a matching-gen stuck response is reset;
//   (C) a legit long audio stream is NOT truncated by the response-watchdog.
//
// (The liveness force-close generation guard lives in
// ai_gateway/realtime-reliability.test.ts; the supervisor's no-double-connect
// generation guard lives in modules/reconnect-supervisor.test.ts.)

import { test, expect, describe, spyOn } from "bun:test";
import { RealtimeClient } from "../../src/ai_gateway/realtime_client";

const { VoiceModule } = await import("../../src/modules/voice");

// ══════════════════════════════════════════════════════════════════
// (A) The generation-token API on RealtimeClient
// ══════════════════════════════════════════════════════════════════

describe("connection generation-token API", () => {
  test("starts at 0 and _bumpGeneration increments monotonically", () => {
    const client = new RealtimeClient();
    expect(client.connectionGeneration).toBe(0);
    expect((client as any)._bumpGeneration("a")).toBe(1);
    expect((client as any)._bumpGeneration("b")).toBe(2);
    expect(client.connectionGeneration).toBe(2);
    client.disconnect();
  });

  test("_connectInternal bumps the generation (single source for connect/reconnect/resume)", () => {
    // Replace the global WebSocket with a fake that never connects, so we can call
    // _connectInternal (which bumps FIRST, synchronously) without a real socket.
    const OrigWS = (globalThis as any).WebSocket;
    class FakeWS {
      onopen: any; onmessage: any; onerror: any; onclose: any;
      readyState = 0;
      constructor(_url: string, _opts?: any) {}
      send() {}
      close() {}
    }
    (globalThis as any).WebSocket = FakeWS as any;
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const client = new RealtimeClient();
      expect(client.connectionGeneration).toBe(0);

      const p1 = (client as any)._connectInternal("instr"); p1.catch(() => {});
      expect(client.connectionGeneration).toBe(1); // fresh connect bumped
      (client as any).ws.onerror({}); // reject + clear the 15s connect timeout

      const p2 = (client as any)._connectInternal("instr"); p2.catch(() => {});
      expect(client.connectionGeneration).toBe(2); // reconnect/resume path also bumps
      (client as any).ws.onerror({});
    } finally {
      errSpy.mockRestore();
      (globalThis as any).WebSocket = OrigWS;
    }
  });

  test("disconnect() bumps the generation (so a scheduled restart NO-OPs after a stop)", () => {
    const client = new RealtimeClient();
    const before = client.connectionGeneration;
    client.disconnect();
    expect(client.connectionGeneration).toBe(before + 1);
  });

  test("a liveness force-close bumps the generation", () => {
    const client = new RealtimeClient();
    (client as any)._connectInternal = async () => {}; // no real reconnect
    (client as any)._connected = true;
    (client as any)._intentionalClose = false;
    const before = client.connectionGeneration;
    (client as any)._forceCloseForLiveness();
    expect(client.connectionGeneration).toBe(before + 1);
    client.disconnect();
  });
});

// ══════════════════════════════════════════════════════════════════
// (B)/(C) VoiceModule response-watchdog generation guard
// ══════════════════════════════════════════════════════════════════

function makeFakeClient() {
  const handlers = new Map<string, Function[]>();
  const fake: any = {
    connected: true,
    providerName: "openai",
    capabilities: {},
    connectionGeneration: 0, // current connection generation
    sent: [] as Array<{ type: string; data: any }>,
    speaking: false,
    on(type: string, h: Function) { const l = handlers.get(type) || []; l.push(h); handlers.set(type, l); },
    emit(type: string, ev: any = {}) { for (const h of handlers.get(type) || []) h(ev); },
    sendEvent(type: string, data: any = {}) { fake.sent.push({ type, data }); return true; },
    setSpeaking(s: boolean) { fake.speaking = s; },
    responseResolvedCalls: 0,
    notifyResponseResolved() { fake.responseResolvedCalls++; },
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
  (voice as any).setupEventHandlers();
  return { voice, fake };
}

const NOW = 2_000_000_000;

/** Put the voice in a stuck-response state whose stamped response generation is
 *  `stampedGen`, with the client currently at `currentGen`. */
function armStuck(voice: any, fake: any, stampedGen: number, currentGen: number) {
  fake.connected = true;
  fake.connectionGeneration = currentGen;
  // Stamp the response generation the way response.created does.
  (voice as any)._scheduler.onResponseCreated(stampedGen);
  (voice as any)._audioState = "thinking";
  (voice as any)._audioStateTs = NOW - 31_000; // 31s > 30s threshold
  (voice as any)._lastAudioOutputTs = NOW - 31_000;
}

describe("response-watchdog generation guard", () => {
  test("matching generation → RESETS the stuck response", () => {
    const { voice, fake } = makeVoice();
    armStuck(voice, fake, /*stamped*/ 3, /*current*/ 3);

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(voice.checkResponseWatchdog(NOW)).toBe(true);
    } finally {
      warn.mockRestore();
    }
    expect((voice as any)._responseActive).toBe(false);   // reset
    expect((voice as any)._audioState).toBe("listening");  // recovered
  });

  test("STALE generation (a reconnect already superseded it) → detected but NO reset", () => {
    const { voice, fake } = makeVoice();
    armStuck(voice, fake, /*stamped*/ 3, /*current*/ 4); // connection moved on

    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...a: any[]) => { warnings.push(a.join(" ")); };
    try {
      // Detected (returns true) but the reset is a NO-OP — never truncate a
      // response that belongs to a newer generation.
      expect(voice.checkResponseWatchdog(NOW)).toBe(true);
    } finally {
      console.warn = orig;
    }
    expect(warnings.some((w) => w.includes("generation moved on"))).toBe(true);
    expect((voice as any)._responseActive).toBe(true);     // NOT reset
    expect((voice as any)._audioState).toBe("thinking");   // untouched
  });

  test("legit long audio stream (recent delta) → NOT truncated, regardless of generation", () => {
    const { voice, fake } = makeVoice();
    fake.connected = true;
    fake.connectionGeneration = 5;
    (voice as any)._scheduler.onResponseCreated(5); // active, gen matches
    (voice as any)._audioState = "speaking";
    (voice as any)._audioStateTs = NOW - 120_000;     // speaking started 2 min ago
    (voice as any)._lastAudioOutputTs = NOW - 500;    // but audio is STILL streaming

    // Not stuck (recent delta widens the activity window) → no detection, no reset.
    expect(voice.checkResponseWatchdog(NOW)).toBe(false);
    expect((voice as any)._responseActive).toBe(true); // healthy response preserved
    expect((voice as any)._audioState).toBe("speaking");
  });
});

// ══════════════════════════════════════════════════════════════════
// Fix #2 — the ACT recovery path shares its "resolved" signal with the client.
// Fix #3 — response-watchdog observe/enforce valve (§12).
// ══════════════════════════════════════════════════════════════════

describe("response-watchdog: shared resolved signal (fix #2) + observe/enforce valve (fix #3)", () => {
  test("default mode derives from S1S2_WATCHDOG_MODE (enforce unless =observe)", () => {
    const { voice } = makeVoice();
    const expected = process.env.S1S2_WATCHDOG_MODE === "observe" ? "observe" : "enforce";
    expect((voice as any)._watchdogMode).toBe(expected);
  });

  test("ENFORCE ACT path clears the client's in-flight flag via notifyResponseResolved (fix #2)", () => {
    const { voice, fake } = makeVoice();
    armStuck(voice, fake, /*stamped*/ 3, /*current*/ 3); // matching gen → ACT
    expect(fake.responseResolvedCalls).toBe(0);

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(voice.checkResponseWatchdog(NOW)).toBe(true);
    } finally {
      warn.mockRestore();
    }
    // The two watchdogs now share the resolved signal: the client's stuck
    // _responseInFlight is cleared so it can't keep the liveness gate open.
    expect(fake.responseResolvedCalls).toBe(1);
    expect((voice as any)._responseActive).toBe(false); // reset
    expect((voice as any)._audioState).toBe("listening");
  });

  test("OBSERVE → detects + logs 'WOULD reset' but does NOT act (fix #3)", () => {
    const { voice, fake } = makeVoice();
    (voice as any)._watchdogMode = "observe";
    armStuck(voice, fake, /*stamped*/ 3, /*current*/ 3);

    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...a: any[]) => { warnings.push(a.join(" ")); };
    try {
      expect(voice.checkResponseWatchdog(NOW)).toBe(true); // still DETECTED
    } finally {
      console.warn = orig;
    }
    expect(warnings.some((w) => w.includes("observe") && w.includes("WOULD reset"))).toBe(true);
    // NOT acted: response state untouched, client NOT signalled.
    expect((voice as any)._responseActive).toBe(true);
    expect((voice as any)._audioState).toBe("thinking");
    expect(fake.responseResolvedCalls).toBe(0);
  });
});
