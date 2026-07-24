// CallingClaw 2.0 — RealtimeClient reliability tests (P0, §5)
//
// Covers the three realtime_client.ts robustness fixes:
//   Fix 1 — Reconnect-retry-reset bug: _reconnectRetries must NOT reset on a raw
//           onopen; only once the session is CONFIRMED HEALTHY. So an
//           open-then-immediately-die socket eventually hits RECONNECT_MAX_RETRIES
//           and fires onReconnectFailed instead of churning forever.
//   Fix 2 — Token-budget re-baseline on a FRESH reconnect (not a Gemini resume).
//   Fix 3 — Liveness watchdog (ACTING): when inbound frames go silent past
//           LIVENESS_TIMEOUT_MS while a response/audio is expected, force-close the
//           (suspected half-open) socket so the reconnect path fires. Guarded by
//           the expectation gate AND the connection generation-token so it never
//           recycles a healthy quiet socket or a superseded-then-replaced socket.
//
// Pure unit tests — no WebSocket connections. Internal (private) state is reached
// via `(client as any)` since these fixes have no public surface by design.

import { test, expect, describe, spyOn } from "bun:test";
import {
  RealtimeClient,
  getProvider,
  LIVENESS_TIMEOUT_MS,
} from "../../src/ai_gateway/realtime_client";

// Prevent scheduled reconnect timers from opening real sockets in tests.
function stubConnectInternal(client: RealtimeClient) {
  (client as any)._connectInternal = async () => {};
}

// ══════════════════════════════════════════════════════════════════
// Fix 1 — Reconnect retry-reset bug
// ══════════════════════════════════════════════════════════════════

describe("Fix 1: reconnect retry cap is only reset on confirmed health", () => {
  test("open-then-die churn (no health confirmation) hits the cap and fires onReconnectFailed", () => {
    const client = new RealtimeClient();
    stubConnectInternal(client);

    let failed = 0;
    client.onReconnectFailed(() => { failed++; });

    // Simulate three failed reconnect cycles. Each raw onopen used to reset the
    // counter to 0; now it does not, so the counter climbs. In between, feed
    // NON-positive inbound events (the kind a rejected session emits) and confirm
    // they do NOT reset the counter either.
    (client as any)._scheduleReconnect();                 // retries: 1
    (client as any)._dispatchEvent({ type: "error", error: { message: "session rejected" } });
    expect((client as any)._reconnectRetries).toBe(1);

    (client as any)._scheduleReconnect();                 // retries: 2
    (client as any)._dispatchEvent({ type: "input_audio_buffer.speech_started" });
    expect((client as any)._reconnectRetries).toBe(2);

    (client as any)._scheduleReconnect();                 // retries: 3
    expect((client as any)._reconnectRetries).toBe(3);
    expect(failed).toBe(0);

    // Cap bites on the next attempt.
    (client as any)._scheduleReconnect();                 // 3 >= RECONNECT_MAX_RETRIES
    expect(failed).toBe(1);

    client.disconnect(); // clears the pending reconnect timer
  });

  test("first session.updated confirms health and resets the retry counter", () => {
    const client = new RealtimeClient();
    (client as any)._reconnectRetries = 2;
    (client as any)._sessionConfirmedHealthy = false;

    (client as any)._dispatchEvent({ type: "session.updated" });

    expect((client as any)._reconnectRetries).toBe(0);
    expect((client as any)._sessionConfirmedHealthy).toBe(true);
    client.disconnect();
  });

  test("first inbound audio delta confirms health and resets the retry counter", () => {
    const client = new RealtimeClient();
    (client as any)._reconnectRetries = 3; // would be at cap
    (client as any)._sessionConfirmedHealthy = false;

    (client as any)._dispatchEvent({ type: "response.audio.delta", delta: "AAAA" });

    expect((client as any)._reconnectRetries).toBe(0);
    expect((client as any)._sessionConfirmedHealthy).toBe(true);
    client.disconnect();
  });

  test("an error event does NOT confirm health (rejected session must not reset the cap)", () => {
    const client = new RealtimeClient();
    (client as any)._reconnectRetries = 2;
    (client as any)._sessionConfirmedHealthy = false;

    (client as any)._dispatchEvent({ type: "error", error: { message: "invalid session" } });

    expect((client as any)._reconnectRetries).toBe(2);
    expect((client as any)._sessionConfirmedHealthy).toBe(false);
    client.disconnect();
  });

  test("stable-for-N fallback (_confirmSessionHealthy) resets the retry counter", () => {
    const client = new RealtimeClient();
    (client as any)._reconnectRetries = 2;
    (client as any)._sessionConfirmedHealthy = false;

    // Simulates the SESSION_HEALTH_CONFIRM_MS timer firing while the socket is up.
    (client as any)._confirmSessionHealthy();

    expect((client as any)._reconnectRetries).toBe(0);
    expect((client as any)._sessionConfirmedHealthy).toBe(true);
    client.disconnect();
  });

  test("confirmation is idempotent — a second positive event does not re-reset a re-incremented counter", () => {
    const client = new RealtimeClient();
    (client as any)._sessionConfirmedHealthy = false;
    (client as any)._reconnectRetries = 2;

    (client as any)._dispatchEvent({ type: "session.updated" }); // confirm → 0
    expect((client as any)._reconnectRetries).toBe(0);

    // Only a fresh socket open (which re-arms _sessionConfirmedHealthy=false) may
    // reset again. A stray later positive event must be a no-op.
    (client as any)._reconnectRetries = 5;
    (client as any)._dispatchEvent({ type: "session.updated" });
    expect((client as any)._reconnectRetries).toBe(5);
    client.disconnect();
  });
});

// ══════════════════════════════════════════════════════════════════
// Fix 2 — Token-budget re-baseline on reconnect
// ══════════════════════════════════════════════════════════════════

describe("Fix 2: token budget re-baselines on a fresh reconnect only", () => {
  test("fresh (non-Gemini) reconnect resets the accumulated token budget", () => {
    const client = new RealtimeClient();
    stubConnectInternal(client);

    // Drive the budget to a stale 'critical' state (>90% of the 128K window).
    (client as any)._updateTokenBudget({ input_tokens: 60_000, output_tokens: 60_000, total_tokens: 120_000 });
    expect(client.getTokenBudget().warningLevel).toBe("critical");
    expect(client.getTokenBudget().totalTokens).toBe(120_000);

    (client as any)._scheduleReconnect(); // fresh reconnect → re-baseline

    const budget = client.getTokenBudget();
    expect(budget.totalTokens).toBe(0);
    expect(budget.inputTokens).toBe(0);
    expect(budget.outputTokens).toBe(0);
    expect(budget.usagePercent).toBe(0);
    expect(budget.responsesTracked).toBe(0);
    expect(budget.warningLevel).toBe("ok");

    client.disconnect();
  });

  test("Gemini RESUME preserves the token budget (server-side state carries over)", () => {
    const client = new RealtimeClient();
    stubConnectInternal(client);
    // Switch to Gemini and give it a resume handle so _scheduleGeminiResume runs
    // the resume path (not the reconnect fallback).
    (client as any)._provider = getProvider("gemini");
    (client as any)._geminiSessionHandle = "resume-handle-123";

    (client as any)._updateTokenBudget({ input_tokens: 60_000, output_tokens: 60_000, total_tokens: 120_000 });
    expect(client.getTokenBudget().warningLevel).toBe("critical");

    (client as any)._scheduleGeminiResume(); // resume → must NOT re-baseline

    const budget = client.getTokenBudget();
    expect(budget.totalTokens).toBe(120_000);
    expect(budget.warningLevel).toBe("critical");

    client.disconnect();
  });
});

// ══════════════════════════════════════════════════════════════════
// Fix 3 — Liveness watchdog (ACTING)
// ══════════════════════════════════════════════════════════════════

describe("Fix 3: liveness watchdog force-closes a half-open socket (generation-guarded)", () => {
  // Put the client in a "connected, response expected, inbound gone stale" state
  // whose captured liveness generation matches the current one (so the gen guard
  // passes and the watchdog is allowed to act). _connectInternal is stubbed so the
  // scheduled reconnect never opens a real socket.
  function armStaleExpected(client: RealtimeClient) {
    stubConnectInternal(client);
    (client as any)._connected = true;
    (client as any)._intentionalClose = false;
    (client as any)._responseInFlight = true;
    (client as any)._livenessWarned = false;
    (client as any)._livenessClosing = false;
    (client as any)._livenessGen = (client as any)._connectionGeneration; // gen guard passes
    (client as any)._lastInboundTs = 1_000; // ancient epoch ms → guaranteed stale vs. now
    // These tests verify the ACT (force-close/recycle) path and its guards, so arm
    // enforce explicitly — robust to the Phase-0 observe default (spec §7 Phase 0).
    (client as any)._livenessMode = "enforce";
  }

  test("under threshold → no detection, no recycle; over threshold → force-close + reconnect", () => {
    const client = new RealtimeClient();
    armStaleExpected(client);
    const base = (client as any)._lastInboundTs as number;
    const genBefore = client.connectionGeneration;

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Just UNDER threshold → nothing happens.
      expect((client as any)._runLivenessCheck(base + LIVENESS_TIMEOUT_MS)).toBe(false);
      expect((client as any)._connected).toBe(true);
      expect((client as any)._reconnectTimer).toBeNull();
      expect(client.connectionGeneration).toBe(genBefore);

      // Just OVER threshold → detect + ACT (recycle).
      expect((client as any)._runLivenessCheck(base + LIVENESS_TIMEOUT_MS + 1)).toBe(true);
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0][0])).toMatch(/LIVENESS/);
      // Acting: generation bumped (invalidates any same-gen guarded action),
      // socket torn down, reconnect scheduled.
      expect(client.connectionGeneration).toBe(genBefore + 1);
      expect((client as any)._connected).toBe(false);
      expect((client as any)._reconnectTimer).not.toBeNull();
    } finally {
      warn.mockRestore();
    }
    client.disconnect();
  });

  test("recycles only once per episode (idempotent — no double force-close)", () => {
    const client = new RealtimeClient();
    armStaleExpected(client);
    const now = (client as any)._lastInboundTs + LIVENESS_TIMEOUT_MS + 1;
    const genBefore = client.connectionGeneration;

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((client as any)._runLivenessCheck(now)).toBe(true);   // recycles
      expect(client.connectionGeneration).toBe(genBefore + 1);
      // Second call: connection already torn down (_connected=false, _livenessClosing) → no-op.
      expect((client as any)._runLivenessCheck(now)).toBe(false);
      expect(client.connectionGeneration).toBe(genBefore + 1);     // not bumped again
    } finally {
      warn.mockRestore();
    }
    client.disconnect();
  });

  test("GENERATION GUARD: a stale tick (generation already moved on) does NOT recycle", () => {
    const client = new RealtimeClient();
    armStaleExpected(client);
    // Simulate a reconnect having already advanced the generation past the one this
    // watchdog was armed for — recycling now would kill a healthy NEWER socket.
    (client as any)._connectionGeneration = (client as any)._livenessGen + 1;
    const genBefore = client.connectionGeneration;
    const now = (client as any)._lastInboundTs + LIVENESS_TIMEOUT_MS + 1;

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((client as any)._runLivenessCheck(now)).toBe(false); // NO-OP
      expect(warn).not.toHaveBeenCalled();
      expect((client as any)._connected).toBe(true);              // healthy socket untouched
      expect((client as any)._reconnectTimer).toBeNull();
      expect(client.connectionGeneration).toBe(genBefore);        // not bumped
    } finally {
      warn.mockRestore();
    }
    client.disconnect();
  });

  test("does NOT act on idle silence when no response/audio is expected (long user monologue)", () => {
    const client = new RealtimeClient();
    (client as any)._connected = true;
    (client as any)._intentionalClose = false;
    (client as any)._responseInFlight = false;
    (client as any)._isSpeaking = false;
    (client as any)._livenessGen = (client as any)._connectionGeneration;
    (client as any)._lastInboundTs = 1_000; // very stale

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((client as any)._runLivenessCheck(Date.now())).toBe(false);
      expect(warn).not.toHaveBeenCalled();
      expect((client as any)._connected).toBe(true); // never recycled during legit quiet
    } finally {
      warn.mockRestore();
    }
    client.disconnect();
  });

  test("_isSpeaking alone counts as 'response/audio expected' → acts", () => {
    const client = new RealtimeClient();
    stubConnectInternal(client);
    (client as any)._connected = true;
    (client as any)._intentionalClose = false;
    (client as any)._responseInFlight = false;
    client.setSpeaking(true);
    (client as any)._livenessWarned = false;
    (client as any)._livenessClosing = false;
    (client as any)._livenessGen = (client as any)._connectionGeneration;
    (client as any)._lastInboundTs = 1_000;
    (client as any)._livenessMode = "enforce"; // ACT path — robust to Phase-0 observe default

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((client as any)._runLivenessCheck(Date.now())).toBe(true);
      expect(warn).toHaveBeenCalled();
      expect((client as any)._connected).toBe(false); // recycled
    } finally {
      warn.mockRestore();
    }
    client.disconnect();
  });

  test("does NOT act when disconnected", () => {
    const client = new RealtimeClient();
    (client as any)._connected = false;
    (client as any)._responseInFlight = true;
    (client as any)._lastInboundTs = 1_000;

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((client as any)._runLivenessCheck(Date.now())).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    client.disconnect();
  });

  test("response.created/response.done toggle the 'response expected' flag", () => {
    const client = new RealtimeClient();
    expect((client as any)._responseInFlight).toBe(false);

    (client as any)._dispatchEvent({ type: "response.created" });
    expect((client as any)._responseInFlight).toBe(true);

    (client as any)._dispatchEvent({ type: "response.done", response: {} });
    expect((client as any)._responseInFlight).toBe(false);
    client.disconnect();
  });

  test("watchdog timer starts and stops cleanly (no dangling interval); start captures the generation", () => {
    const client = new RealtimeClient();
    (client as any)._connectionGeneration = 7;
    (client as any)._startLivenessWatchdog();
    expect((client as any)._livenessTimer).not.toBeNull();
    expect((client as any)._livenessGen).toBe(7); // armed for the current generation
    (client as any)._stopLivenessWatchdog();
    expect((client as any)._livenessTimer).toBeNull();

    // disconnect() must also stop it.
    (client as any)._startLivenessWatchdog();
    expect((client as any)._livenessTimer).not.toBeNull();
    client.disconnect();
    expect((client as any)._livenessTimer).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
// Fix #2 — barge-in cancel clears the in-flight expectation so a HEALTHY
// quiet socket is not force-closed after an interruption. After a
// `response.cancel` the server may never send `response.done`; if
// `_responseInFlight` stayed stuck true, the liveness expectation gate would
// stay open and a normal quiet gap would recycle a perfectly good socket.
// ══════════════════════════════════════════════════════════════════

describe("Fix #2: response.cancel clears the in-flight flag → no false liveness recycle", () => {
  test("outbound response.cancel clears _responseInFlight; a subsequent quiet gap does NOT recycle", () => {
    const client = new RealtimeClient();
    stubConnectInternal(client);
    // Minimal open fake socket so sendEvent() reaches its type branch.
    (client as any).ws = { readyState: WebSocket.OPEN, send() {}, close() {} };

    // A response is in flight (server owes us frames).
    (client as any)._dispatchEvent({ type: "response.created" });
    expect((client as any)._responseInFlight).toBe(true);

    // Barge-in: the user interrupts → we send response.cancel. This is the exact
    // path where the server may never send the matching response.done.
    client.sendEvent("response.cancel", {});
    expect((client as any)._responseInFlight).toBe(false);

    // The quiet gap after the barge-in: stale inbound, gen guard satisfied, not
    // speaking. With the flag cleared, the expectation gate is closed → NO recycle.
    (client as any)._connected = true;
    (client as any)._intentionalClose = false;
    (client as any)._isSpeaking = false;
    (client as any)._livenessGen = (client as any)._connectionGeneration;
    (client as any)._lastInboundTs = 1_000;
    const genBefore = client.connectionGeneration;

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((client as any)._runLivenessCheck((client as any)._lastInboundTs + LIVENESS_TIMEOUT_MS + 5_000)).toBe(false);
      expect(warn).not.toHaveBeenCalled();
      expect((client as any)._connected).toBe(true);            // healthy socket untouched
      expect(client.connectionGeneration).toBe(genBefore);      // not recycled
    } finally {
      warn.mockRestore();
    }
    client.disconnect();
  });

  test("notifyResponseResolved() clears the in-flight flag (the response-watchdog recovery signal)", () => {
    const client = new RealtimeClient();
    (client as any)._dispatchEvent({ type: "response.created" });
    expect((client as any)._responseInFlight).toBe(true);
    client.notifyResponseResolved();
    expect((client as any)._responseInFlight).toBe(false);
    // Idempotent.
    client.notifyResponseResolved();
    expect((client as any)._responseInFlight).toBe(false);
    client.disconnect();
  });
});

// ══════════════════════════════════════════════════════════════════
// Fix #3 — observe/enforce valve (liveness watchdog). Phase-0 landing default is
// observe (log-only); S1S2_WATCHDOG_MODE=enforce activates it WITHOUT a code change (§12).
// ══════════════════════════════════════════════════════════════════

describe("Fix #3: liveness watchdog observe/enforce valve", () => {
  function armStaleExpected(client: RealtimeClient) {
    stubConnectInternal(client);
    (client as any)._connected = true;
    (client as any)._intentionalClose = false;
    (client as any)._responseInFlight = true;
    (client as any)._livenessWarned = false;
    (client as any)._livenessClosing = false;
    (client as any)._livenessGen = (client as any)._connectionGeneration;
    (client as any)._lastInboundTs = 1_000;
  }

  test("default mode derives from S1S2_WATCHDOG_MODE (observe unless =enforce)", () => {
    const client = new RealtimeClient();
    // Phase-0 landing default is "observe" (spec §7 Phase 0); enforce is opt-in.
    const expected = process.env.S1S2_WATCHDOG_MODE === "enforce" ? "enforce" : "observe";
    expect((client as any)._livenessMode).toBe(expected);
    client.disconnect();
  });

  test("observe → DETECTS + logs 'WOULD recycle' but does NOT force-close", () => {
    const client = new RealtimeClient();
    armStaleExpected(client);
    (client as any)._livenessMode = "observe";
    const genBefore = client.connectionGeneration;

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const now = (client as any)._lastInboundTs + LIVENESS_TIMEOUT_MS + 1;
      expect((client as any)._runLivenessCheck(now)).toBe(true);          // detected
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0][0])).toMatch(/LIVENESS \(observe\)/);
      expect(String(warn.mock.calls[0][0])).toMatch(/WOULD recycle/);
      // NOT acted: socket alive, generation unchanged, no reconnect scheduled.
      expect((client as any)._connected).toBe(true);
      expect(client.connectionGeneration).toBe(genBefore);
      expect((client as any)._reconnectTimer).toBeNull();
    } finally {
      warn.mockRestore();
    }
    client.disconnect();
  });

  test("enforce → ACTS (force-close + reconnect)", () => {
    const client = new RealtimeClient();
    armStaleExpected(client);
    (client as any)._livenessMode = "enforce"; // explicit (robust to env)
    const genBefore = client.connectionGeneration;

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const now = (client as any)._lastInboundTs + LIVENESS_TIMEOUT_MS + 1;
      expect((client as any)._runLivenessCheck(now)).toBe(true);
      expect((client as any)._connected).toBe(false);           // recycled
      expect(client.connectionGeneration).toBe(genBefore + 1);  // generation bumped
      expect((client as any)._reconnectTimer).not.toBeNull();   // reconnect scheduled
    } finally {
      warn.mockRestore();
    }
    client.disconnect();
  });
});
