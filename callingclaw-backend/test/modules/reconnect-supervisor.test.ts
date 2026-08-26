// Reconnect supervisor — ACTING (s1s2 §5, the third authority tier).
//
// The supervisor owns the RE-INIT that happens AFTER the RealtimeClient has
// exhausted its own per-drop retries (it owns those). On `voice.reconnect_failed`
// it restarts the voice session with exponential backoff + a hard cap. The
// connection generation-token makes it collision-proof: it captures the
// generation when it schedules a restart and NO-OPs if the generation advanced by
// fire time (the client reconnected on its own → no double-connect, §14 risk 2).
//
// ReconnectSupervisor is dependency-injected, so these tests drive it directly
// with a controllable clock (setTimer/clearTimer capture pending callbacks) and
// injectable generation/connected/restart. No EventBus, no real sockets.

import { test, expect, describe } from "bun:test";
import { ReconnectSupervisor } from "../../src/modules/voice";

interface Harness {
  sup: ReconnectSupervisor;
  timers: Array<{ fn: () => void; ms: number; id: number }>;
  dead: Array<{ restarts: number }>;
  restartCalls: number[]; // generation captured at each restart() invocation
  setGeneration(g: number): void;
  getGeneration(): number;
  setConnected(c: boolean): void;
  setRestartImpl(fn: () => Promise<void>): void;
  fireNext(): { fn: () => void; ms: number; id: number } | undefined;
}

function makeSupervisor(overrides: Record<string, any> = {}): Harness {
  const timers: Array<{ fn: () => void; ms: number; id: number }> = [];
  let nextId = 1;
  let generation = 1;
  let connected = false;
  let restartImpl: () => Promise<void> = async () => {};
  const restartCalls: number[] = [];
  const dead: Array<{ restarts: number }> = [];

  const sup = new ReconnectSupervisor({
    getGeneration: () => generation,
    isConnected: () => connected,
    restart: async () => { restartCalls.push(generation); await restartImpl(); },
    onDead: (info) => { dead.push(info); },
    setTimer: (fn, ms) => { const id = nextId++; timers.push({ fn, ms, id }); return id; },
    clearTimer: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    ...overrides,
  });

  return {
    sup,
    timers,
    dead,
    restartCalls,
    setGeneration: (g) => { generation = g; },
    getGeneration: () => generation,
    setConnected: (c) => { connected = c; },
    setRestartImpl: (fn) => { restartImpl = fn; },
    fireNext: () => { const t = timers.shift(); if (t) t.fn(); return t; },
  };
}

// Flush the microtask chain kicked off by restart().then(...).
const flush = () => new Promise((r) => setTimeout(r, 5));

describe("ReconnectSupervisor — scheduling", () => {
  test("first failure schedules a supervised restart with base backoff", () => {
    const h = makeSupervisor({ baseDelayMs: 1000, backoff: 2 });
    expect(h.sup.onReconnectFailed()).toBe("scheduled");
    expect(h.timers.length).toBe(1);
    expect(h.timers[0].ms).toBe(1000); // baseDelay * backoff^0
    expect(h.sup.scheduled).toBe(true);
  });

  test("does NOT stack — a second failure while one is pending is a no-op", () => {
    const h = makeSupervisor();
    expect(h.sup.onReconnectFailed()).toBe("scheduled");
    expect(h.sup.onReconnectFailed()).toBe("already-scheduled");
    expect(h.timers.length).toBe(1);
  });
});

describe("ReconnectSupervisor — firing", () => {
  test("restarts when the generation is unchanged and still disconnected", async () => {
    const h = makeSupervisor();
    h.setConnected(false);
    h.sup.onReconnectFailed();
    h.fireNext();
    await flush();
    expect(h.restartCalls.length).toBe(1);
    expect(h.sup.restarts).toBe(1);
  });

  test("already reconnected at fire time (isConnected) → NO restart", async () => {
    const h = makeSupervisor();
    h.setConnected(false);
    h.sup.onReconnectFailed();
    h.setConnected(true); // recovered before the timer fired
    h.fireNext();
    await flush();
    expect(h.restartCalls.length).toBe(0);
    expect(h.sup.restarts).toBe(0);
  });
});

describe("ReconnectSupervisor — generation guard (no double-connect, §14 risk 2)", () => {
  test("client reconnected on its own (generation advanced) → NO double-connect", async () => {
    const h = makeSupervisor();
    h.setConnected(false);
    h.sup.onReconnectFailed(); // captures generation = 1
    // The client's own _scheduleReconnect recovered → _connectInternal bumped gen.
    h.setGeneration(2);
    h.fireNext();
    await flush();
    // The supervisor must step aside — restart() is never called.
    expect(h.restartCalls.length).toBe(0);
    // Treated as recovery: the supervised-restart budget is reset.
    expect(h.sup.restarts).toBe(0);
  });

  test("generation still matches → the restart DOES fire (guard is not over-eager)", async () => {
    const h = makeSupervisor();
    h.setConnected(false);
    h.sup.onReconnectFailed(); // captures generation = 1
    // generation stays 1 (client truly gave up, nothing else reconnected)
    h.fireNext();
    await flush();
    expect(h.restartCalls.length).toBe(1);
    expect(h.restartCalls[0]).toBe(1); // restarted against the captured generation
  });
});

describe("ReconnectSupervisor — backoff schedule + hard cap", () => {
  test("restarts up to the cap with exponential backoff, then emits dead and stops", async () => {
    const h = makeSupervisor({ baseDelayMs: 1000, backoff: 2, maxDelayMs: 60_000, maxRestarts: 3 });
    h.setConnected(false);
    const delays: number[] = [];

    // attempt 1
    expect(h.sup.onReconnectFailed()).toBe("scheduled");
    delays.push(h.timers[0].ms);
    h.fireNext(); await flush();
    // attempt 2
    expect(h.sup.onReconnectFailed()).toBe("scheduled");
    delays.push(h.timers[0].ms);
    h.fireNext(); await flush();
    // attempt 3
    expect(h.sup.onReconnectFailed()).toBe("scheduled");
    delays.push(h.timers[0].ms);
    h.fireNext(); await flush();

    expect(h.restartCalls.length).toBe(3);
    expect(h.sup.restarts).toBe(3);

    // attempt 4 → own cap hit → give up (voice.dead), no further restart scheduled.
    expect(h.sup.onReconnectFailed()).toBe("dead");
    expect(h.sup.dead).toBe(true);
    expect(h.dead.length).toBe(1);
    expect(h.dead[0].restarts).toBe(3);
    expect(h.timers.length).toBe(0);

    // Exponential schedule (0-based exponent): base * backoff^attempt.
    expect(delays).toEqual([1000, 2000, 4000]);
  });

  test("backoff is capped at maxDelayMs", () => {
    const h = makeSupervisor({ baseDelayMs: 1000, backoff: 10, maxDelayMs: 5000, maxRestarts: 5 });
    h.setConnected(false);
    // attempt 1 → 1000
    h.sup.onReconnectFailed();
    expect(h.timers[0].ms).toBe(1000);
    h.fireNext();
    // attempt 2 → 1000*10^1 = 10000, capped to 5000
    h.sup.onReconnectFailed();
    expect(h.timers[0].ms).toBe(5000);
  });

  test("dead supervisor ignores further failures (no restart storm)", async () => {
    const h = makeSupervisor({ maxRestarts: 1 });
    h.setConnected(false);
    h.sup.onReconnectFailed(); h.fireNext(); await flush(); // restarts=1
    expect(h.sup.onReconnectFailed()).toBe("dead");         // cap → dead
    expect(h.sup.onReconnectFailed()).toBe("dead");         // still dead, no-op
    expect(h.dead.length).toBe(1);                          // onDead emitted once
  });
});

describe("ReconnectSupervisor — health reset & cancellation", () => {
  test("a restart that reconnects successfully resets the restart budget", async () => {
    const h = makeSupervisor();
    h.setConnected(false);
    h.setRestartImpl(async () => { h.setConnected(true); }); // restart succeeds
    h.sup.onReconnectFailed();
    h.fireNext();
    await flush();
    expect(h.restartCalls.length).toBe(1);
    expect(h.sup.restarts).toBe(0); // confirmed health → counter reset
  });

  test("notifyHealthy cancels a pending restart and resets + revives a dead supervisor", () => {
    const h = makeSupervisor({ maxRestarts: 1 });
    h.setConnected(false);
    h.sup.onReconnectFailed();
    expect(h.timers.length).toBe(1);

    h.sup.notifyHealthy();
    expect(h.timers.length).toBe(0); // pending restart cancelled
    expect(h.sup.restarts).toBe(0);

    // Drive it dead, then a manual (re)start signal revives it.
    h.sup.onReconnectFailed(); // restarts 0 < 1 → scheduled
    h.fireNext();
    h.sup.onReconnectFailed(); // cap → dead
    expect(h.sup.dead).toBe(true);
    h.sup.notifyHealthy();
    expect(h.sup.dead).toBe(false);
  });

  test("cancel() drops a pending restart so nothing fires", async () => {
    const h = makeSupervisor();
    h.setConnected(false);
    h.sup.onReconnectFailed();
    expect(h.timers.length).toBe(1);
    h.sup.cancel();
    expect(h.timers.length).toBe(0);
    await flush();
    expect(h.restartCalls.length).toBe(0);
  });
});
