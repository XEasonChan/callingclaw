// Unit tests for the pure, Playwright-free logic extracted from ChromeLauncher:
//   - classifyJoinFailure  (terminal vs retryable join failures)
//   - joinBackoffMs         (exponential backoff schedule)
//   - computeAudioHealth    (live audio-health derivation + shape/transitions)
//
// chrome-launcher.ts is Playwright-heavy and hard to E2E-test; these cover the
// decision logic that governs whole-join retries and the audio-health getter.

import { test, expect, describe } from "bun:test";
import {
  classifyJoinFailure,
  joinBackoffMs,
  computeAudioHealth,
  MAX_JOIN_ATTEMPTS,
  JOIN_BACKOFF_SCHEDULE_MS,
  JOIN_BACKOFF_CAP_MS,
  AUDIO_FLOW_WINDOW_MS,
  type AudioHealth,
  type AudioHealthRaw,
} from "../src/chrome-launcher";

// ── classifyJoinFailure ──────────────────────────────────────────
describe("classifyJoinFailure", () => {
  // Terminal: the meeting actively rejected us or is gone — retry is pointless.
  const terminal = [
    "Request to join was rejected",
    "Your request to join was denied",
    // Exact summary emitted by _joinAttempt's verify loop on host denial/ejection.
    "Join request was denied by the host",
    "The host declined your request",
    "You were removed from the meeting",
    "You've been removed from the waiting room",
    "You were kicked from the call",
    "Meeting has ended",
    "The meeting has ended for everyone",
    "Your meeting code has expired",
    "Cannot access meeting",
    "Access denied",
    "not allowed",
    "No page — call launch() first",
    "Error: you were removed from the meeting",
  ];
  for (const s of terminal) {
    test(`terminal: "${s}"`, () => {
      expect(classifyJoinFailure(s)).toBe("terminal");
    });
  }

  // Retryable: transient — reload / re-navigate can recover.
  const retryable = [
    "Join button not found (hardcoded + agentic)",
    "Join button disappeared",
    "Could not confirm join state",
    "Zoom web client did not load (name/Join controls never appeared)",
    "Error: net::ERR_CONNECTION_RESET",
    "Error: Navigation timeout of 30000ms exceeded",
    "Error: 503 Service Unavailable",
    "Error: net::ERR_NAME_NOT_RESOLVED",
    "join not attempted",
    "",
  ];
  for (const s of retryable) {
    test(`retryable: "${s}"`, () => {
      expect(classifyJoinFailure(s)).toBe("retryable");
    });
  }

  test("is case-insensitive", () => {
    expect(classifyJoinFailure("MEETING HAS ENDED")).toBe("terminal");
    expect(classifyJoinFailure("ReJeCtEd")).toBe("terminal");
  });

  test("handles null/undefined-ish input safely", () => {
    // @ts-expect-error — exercising defensive path
    expect(classifyJoinFailure(undefined)).toBe("retryable");
    // @ts-expect-error
    expect(classifyJoinFailure(null)).toBe("retryable");
  });
});

// ── joinBackoffMs ────────────────────────────────────────────────
describe("joinBackoffMs", () => {
  test("first attempt (index 0) has no delay", () => {
    expect(joinBackoffMs(0)).toBe(0);
  });

  test("follows 2s → 6s → 15s schedule", () => {
    expect(joinBackoffMs(1)).toBe(2000);
    expect(joinBackoffMs(2)).toBe(6000);
    expect(joinBackoffMs(3)).toBe(15000);
  });

  test("caps at JOIN_BACKOFF_CAP_MS beyond the schedule", () => {
    expect(joinBackoffMs(4)).toBe(JOIN_BACKOFF_CAP_MS);
    expect(joinBackoffMs(10)).toBe(JOIN_BACKOFF_CAP_MS);
    expect(joinBackoffMs(999)).toBe(JOIN_BACKOFF_CAP_MS);
  });

  test("negative / NaN → 0 (no delay)", () => {
    expect(joinBackoffMs(-1)).toBe(0);
    expect(joinBackoffMs(-100)).toBe(0);
    expect(joinBackoffMs(NaN)).toBe(0);
  });

  test("floors fractional indices", () => {
    expect(joinBackoffMs(1.9)).toBe(2000); // floor(1.9)=1
    expect(joinBackoffMs(2.1)).toBe(6000); // floor(2.1)=2
  });

  test("schedule is monotonic non-decreasing and never exceeds cap", () => {
    let prev = -1;
    for (let i = 0; i <= 8; i++) {
      const d = joinBackoffMs(i);
      expect(d).toBeGreaterThanOrEqual(prev);
      expect(d).toBeLessThanOrEqual(JOIN_BACKOFF_CAP_MS);
      prev = d;
    }
  });

  test("only 2 retries are used with MAX_JOIN_ATTEMPTS=3", () => {
    expect(MAX_JOIN_ATTEMPTS).toBe(3);
    // Applied inter-attempt delays for a 3-attempt run: index 1 and 2.
    expect(joinBackoffMs(1)).toBe(2000);
    expect(joinBackoffMs(2)).toBe(6000);
  });

  test("exported schedule matches expectations", () => {
    expect(JOIN_BACKOFF_SCHEDULE_MS).toEqual([0, 2000, 6000, 15000]);
  });
});

// ── computeAudioHealth ───────────────────────────────────────────
describe("computeAudioHealth", () => {
  const AUDIO_HEALTH_KEYS = [
    "active",
    "captureFlowing",
    "lastMaxAmp",
    "lastNonzeroAudioAt",
    "activeReceiverIndex",
    "receiverCycleCount",
    "speakerDetected",
    "captureChunks",
    "wsState",
    "updatedAt",
  ];

  const flowingRaw: AudioHealthRaw = {
    captureActive: true,
    captureChunks: 120,
    lastChunkMaxAmp: 8000,
    peakMaxAmp: 12000,
    lastNonzeroAt: 95000,
    activeReceiverIndex: 2,
    receiverCycleCount: 1,
    speakerDetected: true,
    wsState: 1,
  };

  test("null raw → inactive defaults", () => {
    const h = computeAudioHealth(null, 12345);
    expect(h).toEqual({
      active: false,
      captureFlowing: false,
      lastMaxAmp: 0,
      lastNonzeroAudioAt: 0,
      activeReceiverIndex: -1,
      receiverCycleCount: 0,
      speakerDetected: false,
      captureChunks: 0,
      wsState: -1,
      updatedAt: 12345,
    });
  });

  test("returned object always has the full documented shape", () => {
    for (const h of [computeAudioHealth(null, 0), computeAudioHealth(flowingRaw, 100000)]) {
      expect(Object.keys(h).sort()).toEqual([...AUDIO_HEALTH_KEYS].sort());
    }
  });

  test("recent non-silent audio → captureFlowing true", () => {
    const now = 95000 + AUDIO_FLOW_WINDOW_MS - 1; // just inside the window
    const h = computeAudioHealth(flowingRaw, now);
    expect(h.active).toBe(true);
    expect(h.captureFlowing).toBe(true);
    expect(h.lastMaxAmp).toBe(8000);
    expect(h.lastNonzeroAudioAt).toBe(95000);
    expect(h.activeReceiverIndex).toBe(2);
    expect(h.receiverCycleCount).toBe(1);
    expect(h.speakerDetected).toBe(true);
    expect(h.captureChunks).toBe(120);
    expect(h.wsState).toBe(1);
    expect(h.updatedAt).toBe(now);
  });

  test("stale non-silent audio (> window) → captureFlowing false", () => {
    const now = 95000 + AUDIO_FLOW_WINDOW_MS + 1; // just past the window
    const h = computeAudioHealth(flowingRaw, now);
    expect(h.active).toBe(true);
    expect(h.captureFlowing).toBe(false);
    // speakerDetected persists — we DID hear audio earlier this session.
    expect(h.speakerDetected).toBe(true);
  });

  test("captureActive but never any nonzero audio → flowing false", () => {
    const silent: AudioHealthRaw = {
      ...flowingRaw,
      lastChunkMaxAmp: 5,
      lastNonzeroAt: 0,
      speakerDetected: false,
    };
    const h = computeAudioHealth(silent, 200000);
    expect(h.active).toBe(true);
    expect(h.captureFlowing).toBe(false);
    expect(h.speakerDetected).toBe(false);
    expect(h.lastNonzeroAudioAt).toBe(0);
  });

  test("recent audio but capture not active → flowing false", () => {
    const inactiveCapture: AudioHealthRaw = { ...flowingRaw, captureActive: false };
    const h = computeAudioHealth(inactiveCapture, 96000);
    expect(h.captureFlowing).toBe(false);
  });

  test("Zoom destination-tap receiver index (-2) is preserved", () => {
    const zoom: AudioHealthRaw = { ...flowingRaw, activeReceiverIndex: -2 };
    const h = computeAudioHealth(zoom, 96000);
    expect(h.activeReceiverIndex).toBe(-2);
    expect(h.captureFlowing).toBe(true);
  });

  test("transition sequence: idle → silent capture → speaker detected → gone silent", () => {
    // 1. Before pipeline: inactive.
    let h: AudioHealth = computeAudioHealth(null, 0);
    expect(h.active).toBe(false);
    expect(h.captureFlowing).toBe(false);

    // 2. Capture active, only silence so far.
    h = computeAudioHealth(
      { captureActive: true, captureChunks: 10, lastChunkMaxAmp: 3, peakMaxAmp: 3, lastNonzeroAt: 0, activeReceiverIndex: 0, receiverCycleCount: 0, speakerDetected: false, wsState: 1 },
      1000,
    );
    expect(h.active).toBe(true);
    expect(h.captureFlowing).toBe(false);
    expect(h.speakerDetected).toBe(false);

    // 3. Someone speaks — nonzero audio arrives now.
    h = computeAudioHealth(
      { captureActive: true, captureChunks: 60, lastChunkMaxAmp: 9000, peakMaxAmp: 9000, lastNonzeroAt: 5000, activeReceiverIndex: 0, receiverCycleCount: 0, speakerDetected: true, wsState: 1 },
      5200,
    );
    expect(h.captureFlowing).toBe(true);
    expect(h.speakerDetected).toBe(true);

    // 4. Long silence + a receiver cycle later — flowing drops, detection sticks.
    h = computeAudioHealth(
      { captureActive: true, captureChunks: 300, lastChunkMaxAmp: 1, peakMaxAmp: 9000, lastNonzeroAt: 5000, activeReceiverIndex: 3, receiverCycleCount: 2, speakerDetected: true, wsState: 1 },
      5000 + AUDIO_FLOW_WINDOW_MS + 500,
    );
    expect(h.captureFlowing).toBe(false);
    expect(h.speakerDetected).toBe(true);
    expect(h.receiverCycleCount).toBe(2);
    expect(h.activeReceiverIndex).toBe(3);
  });

  // ── Trust-signal regression: never report "healthy"/"Hearing you" while silent ──
  // captureFlowing (backed by the REAL-audio timestamp + speakerDetected) must be
  // false in the two windows that previously read the watchdog/init timestamp:
  // the post-activation warmup and every post-silence recovery cycle.

  test("(a) post-activation, capture active but no real audio yet → NOT flowing", () => {
    // Pipeline just activated: capture is on, no non-silent chunk seen. The page's
    // real-audio timestamp is 0 even though the watchdog may have stamped now.
    const justActivated: AudioHealthRaw = {
      captureActive: true,
      captureChunks: 4,
      lastChunkMaxAmp: 12,
      peakMaxAmp: 12,
      lastNonzeroAt: 0, // real-audio ts — never bumped by init/watchdog
      activeReceiverIndex: 0,
      receiverCycleCount: 0,
      speakerDetected: false,
      wsState: 1,
    };
    const h = computeAudioHealth(justActivated, 500); // 500ms after activation
    expect(h.active).toBe(true);
    expect(h.captureFlowing).toBe(false); // → status not "healthy"
    expect(h.speakerDetected).toBe(false);
    expect(h.lastNonzeroAudioAt).toBe(0);
  });

  test("(b) during recovery cycle (cycleCount>0, no fresh real audio) → NOT flowing (recovering-eligible)", () => {
    // Silence watchdog just cycled the receiver. It bumped the LEGACY watchdog
    // timestamp, NOT the real-audio one, so captureFlowing must be false so the
    // "Recovering audio" state can render. speakerDetected still true (heard earlier).
    const recovering: AudioHealthRaw = {
      captureActive: true,
      captureChunks: 900,
      lastChunkMaxAmp: 2,
      peakMaxAmp: 9000,
      // Last real audio was 40s ago (why recovery even triggered) — stale.
      lastNonzeroAt: 100000,
      activeReceiverIndex: 4,
      receiverCycleCount: 3,
      speakerDetected: true,
      wsState: 1,
    };
    const h = computeAudioHealth(recovering, 100000 + 40000);
    expect(h.captureFlowing).toBe(false); // → NOT healthy → "Recovering" can render
    expect(h.receiverCycleCount).toBe(3);
    expect(h.speakerDetected).toBe(true);

    // A recovery cycle with NO speaker ever detected is likewise not flowing.
    const recoveringNeverHeard: AudioHealthRaw = {
      ...recovering,
      lastNonzeroAt: 0,
      speakerDetected: false,
    };
    expect(computeAudioHealth(recoveringNeverHeard, 100000).captureFlowing).toBe(false);
  });

  test("(c) fresh real audio within window (even mid-recovery) → flowing/healthy", () => {
    // After a recovery cycle successfully finds an active receiver, fresh real
    // audio arrives and the real-audio timestamp advances → flowing flips true
    // again despite receiverCycleCount>0.
    const recoveredAndFlowing: AudioHealthRaw = {
      captureActive: true,
      captureChunks: 950,
      lastChunkMaxAmp: 7000,
      peakMaxAmp: 9000,
      lastNonzeroAt: 200000, // fresh real audio
      activeReceiverIndex: 5,
      receiverCycleCount: 3,
      speakerDetected: true,
      wsState: 1,
    };
    const h = computeAudioHealth(recoveredAndFlowing, 200000 + 1000); // 1s later, inside window
    expect(h.captureFlowing).toBe(true); // → "Hearing you" is truthful again
    expect(h.receiverCycleCount).toBe(3);
    expect(h.speakerDetected).toBe(true);
  });
});
