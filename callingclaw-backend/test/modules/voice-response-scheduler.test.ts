// VoiceResponseScheduler — P1 STEP 1: single-owned response.create gate
//
// The scheduler collapses the former DUAL response-gate (VoiceModule
// _responseActive + _pendingResponseCreate AND RealtimeClient _isSpeaking +
// its own _pendingResponseCreate + a 500ms debounce) into ONE authority with an
// HONEST disposition. These tests pin the exact dual-gate disagreement cases
// codex flagged:
//   1. _responseActive=false but speaking  → "deferred" (NOT a false
//      "response-requested"/"sent"). The old VoiceModule gate only checked
//      _responseActive and would have SENT, while the RealtimeClient layer
//      queued behind _isSpeaking — caller told "sent" but it was only queued.
//   2. debounce drops a DISTINCT payload   → "dropped-debounced" (honest),
//      NOT silently reported as success.
//   3. multiple pending                    → EXPLICIT replace-latest +
//      coalesce-identical, the displaced payload surfaced ("dropped-superseded"),
//      never a silent overwrite; exactly one response fires (latest wins).
// Plus: a deferred payload actually fires on the next idle transition
// (response.done, or response.done+audio.done for an audio response), and it
// never fires into an audio still playing or a freshly-started response.

import { test, expect, describe } from "bun:test";

const { VoiceResponseScheduler } = await import("../../src/modules/voice");

interface Harness {
  sched: InstanceType<typeof VoiceResponseScheduler>;
  sent: any[];
  dispositions: Array<{ payload: any; disposition: string }>;
  setConnected(v: boolean): void;
  advance(ms: number): void;
}

function makeScheduler(overrides: Record<string, any> = {}): Harness {
  const sent: any[] = [];
  const dispositions: Array<{ payload: any; disposition: string }> = [];
  let connected = true;
  let clock = 1_000_000; // fixed logical clock for deterministic debounce
  const sched = new VoiceResponseScheduler({
    isConnected: () => connected,
    send: (p: any) => { sent.push(p); },
    onDisposition: (p: any, d: string) => { dispositions.push({ payload: p, disposition: d }); },
    now: () => clock,
    ...overrides,
  });
  return {
    sched,
    sent,
    dispositions,
    setConnected: (v: boolean) => { connected = v; },
    advance: (ms: number) => { clock += ms; },
  };
}

// ═══════════════════════════════════════════════════════════════════
// Acceptance basics + honest no-session
// ═══════════════════════════════════════════════════════════════════

describe("acceptance", () => {
  test("idle + connected → 'response-requested', sends exactly once", () => {
    const h = makeScheduler();
    expect(h.sched.request({ a: 1 })).toBe("response-requested");
    expect(h.sent).toEqual([{ a: 1 }]);
  });

  test("no live session → 'no-session', sends nothing, queues nothing", () => {
    const h = makeScheduler();
    h.setConnected(false);
    expect(h.sched.request({ a: 1 })).toBe("no-session");
    expect(h.sent.length).toBe(0);
    expect(h.sched.pending).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// codex case #1 — reconciliation: speaking alone defers (no false "sent")
// ═══════════════════════════════════════════════════════════════════

describe("dual-gate reconciliation: _active=false but speaking", () => {
  test("response done but audio still playing → busy via 'speaking' → deferred, not sent", () => {
    const h = makeScheduler();
    h.sched.onResponseCreated(); // active=true
    h.sched.onAudioDelta();      // speaking=true (audio playing)
    h.sched.onResponseDone();    // active=false BUT audio.done NOT yet → speaking stays true

    // The reconciled single truth: not active, but still speaking → still busy.
    expect(h.sched.active).toBe(false);
    expect(h.sched.speaking).toBe(true);
    expect(h.sched.busy).toBe(true);

    // Old bug: the VoiceModule gate saw _responseActive=false and "sent", while
    // RealtimeClient queued behind _isSpeaking → caller told "sent" but only
    // queued. Single owner now honestly defers.
    const disp = h.sched.request({ x: 1 });
    expect(disp).toBe("deferred");
    expect(h.sent.length).toBe(0);
    expect(h.sched.pending).toEqual({ x: 1 });
  });
});

// ═══════════════════════════════════════════════════════════════════
// codex case #2 — debounce drops a DISTINCT payload, reported honestly
// ═══════════════════════════════════════════════════════════════════

describe("debounce is honest (one place)", () => {
  test("distinct payload within the debounce window → 'dropped-debounced', not success", () => {
    const h = makeScheduler(); // debounceMs=500
    expect(h.sched.request({ r: 1 })).toBe("response-requested");
    expect(h.sent.length).toBe(1);

    h.advance(200); // 200ms < 500ms
    const disp = h.sched.request({ r: 2 }); // DISTINCT payload
    expect(disp).toBe("dropped-debounced");  // honest: NOT reported as success
    expect(h.sent.length).toBe(1);            // the distinct payload was NOT sent
    expect(h.dispositions).toContainEqual({ payload: { r: 2 }, disposition: "dropped-debounced" });

    // Past the window → accepted again.
    h.advance(400); // total 600ms > 500ms
    expect(h.sched.request({ r: 3 })).toBe("response-requested");
    expect(h.sent.length).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// codex case #3 — multiple pending: explicit policy, no silent overwrite
// ═══════════════════════════════════════════════════════════════════

describe("pending-replacement policy (single slot, explicit)", () => {
  test("coalesce-identical: same payload queued twice stays one, nothing dropped", () => {
    const h = makeScheduler();
    h.sched.onResponseCreated(); // busy
    expect(h.sched.request({ q: "A" })).toBe("deferred");
    expect(h.sched.request({ q: "A" })).toBe("deferred"); // identical → coalesced
    expect(h.sched.pending).toEqual({ q: "A" });
    expect(h.dispositions.length).toBe(0); // nothing superseded
  });

  test("replace-latest: newer distinct payload wins; displaced one is SURFACED (not silent); only one fires", async () => {
    const h = makeScheduler();
    h.sched.onResponseCreated(); // busy (active)

    expect(h.sched.request({ q: "A" })).toBe("deferred");
    expect(h.sched.pending).toEqual({ q: "A" });

    // Distinct newer payload displaces A (latest wins — matches historical
    // overwrite) but the displaced A is reported, never silently dropped.
    expect(h.sched.request({ q: "B" })).toBe("deferred");
    expect(h.sched.pending).toEqual({ q: "B" });
    expect(h.dispositions).toContainEqual({ payload: { q: "A" }, disposition: "dropped-superseded" });

    // Flush on idle → EXACTLY ONE send, carrying B (A did not also fire).
    h.sched.onResponseDone();            // active=false, not speaking → flush (50ms)
    expect(h.sched.pending).toBeNull();   // cleared synchronously
    await Bun.sleep(90);
    expect(h.sent).toEqual([{ q: "B" }]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Deferred actually fires on the next idle transition
// ═══════════════════════════════════════════════════════════════════

describe("deferred fires on next idle (never silently lost)", () => {
  test("text-only response: deferred flushes ~after response.done", async () => {
    const h = makeScheduler();
    h.sched.onResponseCreated();
    expect(h.sched.request({ go: 1 })).toBe("deferred");
    expect(h.sent.length).toBe(0);

    h.sched.onResponseDone();            // no audio → idle immediately → flush (50ms)
    expect(h.sched.pending).toBeNull();   // cleared synchronously
    await Bun.sleep(90);
    expect(h.sent).toEqual([{ go: 1 }]);
  });

  test("audio response: deferred waits for BOTH response.done AND audio.done (no truncation)", async () => {
    const h = makeScheduler({ flushDelayWithAudioMs: 30 });
    h.sched.onResponseCreated();
    h.sched.onAudioDelta();              // speaking + hadAudio
    expect(h.sched.request({ go: 1 })).toBe("deferred");

    h.sched.onResponseDone();            // active=false but STILL speaking → must NOT flush
    await Bun.sleep(20);
    expect(h.sent.length).toBe(0);        // did not fire into still-playing audio

    h.sched.onAudioDone();               // speaking=false → now idle → flush after settle
    expect(h.sent.length).toBe(0);        // not yet (settle window)
    await Bun.sleep(60);
    expect(h.sent).toEqual([{ go: 1 }]);
  });

  test("re-defers if a new response starts during the settle window (never fires into an active response)", async () => {
    const h = makeScheduler({ flushDelayMs: 40 });
    h.sched.onResponseCreated();
    expect(h.sched.request({ go: 1 })).toBe("deferred");

    h.sched.onResponseDone();            // schedule flush at 40ms, pending cleared
    h.sched.onResponseCreated();         // a NEW response starts before the timer fires → busy again
    await Bun.sleep(70);

    expect(h.sent.length).toBe(0);        // did NOT fire into the active response
    expect(h.sched.pending).toEqual({ go: 1 }); // safely re-deferred
  });

  test("no session at flush time → deferred payload is dropped, nothing sent", async () => {
    const h = makeScheduler({ flushDelayMs: 30 });
    h.sched.onResponseCreated();
    h.sched.request({ go: 1 });
    h.sched.onResponseDone();            // schedule flush
    h.setConnected(false);               // session dies during settle
    await Bun.sleep(60);
    expect(h.sent.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// reset() clears everything (new meeting / stop)
// ═══════════════════════════════════════════════════════════════════

describe("reset", () => {
  test("clears active/speaking/pending and cancels any settle timer", async () => {
    const h = makeScheduler({ flushDelayMs: 30 });
    h.sched.onResponseCreated();
    h.sched.request({ go: 1 });
    h.sched.onResponseDone(); // schedules flush
    h.sched.reset();
    expect(h.sched.active).toBe(false);
    expect(h.sched.speaking).toBe(false);
    expect(h.sched.pending).toBeNull();
    await Bun.sleep(50);
    expect(h.sent.length).toBe(0); // the settle timer was cancelled by reset()
  });
});
