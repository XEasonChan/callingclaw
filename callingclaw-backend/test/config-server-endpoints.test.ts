// Lane C — HTTP endpoint wiring tests.
//
// Covers the two pieces of logic Lane C adds to config_server.ts:
//   1. deriveAudioStatus() — pure mapping of a raw AudioHealth snapshot (Lane A)
//      to the UI-friendly fields (hearing/speakerDetected/healthy/status) that
//      GET /api/audio/status exposes for Lane D. Every status branch + staleness.
//   2. The CostMeter.getReport() contract (Lane B) that GET /api/cost forwards to:
//      no-arg → aggregate across meetings; meetingId → that meeting only; unknown
//      id → empty report. This is the exact data path the endpoint returns.
//
// The endpoints themselves live inside startConfigServer()/Bun.serve() and are not
// booted here (would require a full Services graph); the derived mapping is extracted
// as a pure export precisely so it can be unit-tested in isolation.

import { test, expect, describe } from "bun:test";
import { deriveAudioStatus } from "../src/config_server";
import type { AudioHealth } from "../src/chrome-launcher";
import { CostMeter } from "../src/modules/cost-meter";

const NOW = 1_000_000_000_000; // fixed clock for deterministic staleness checks

/** Build an AudioHealth snapshot, defaulting to the "inactive/never-polled" shape. */
function health(overrides: Partial<AudioHealth> = {}): AudioHealth {
  return {
    active: false,
    captureFlowing: false,
    lastMaxAmp: 0,
    lastNonzeroAudioAt: 0,
    activeReceiverIndex: -1,
    receiverCycleCount: 0,
    speakerDetected: false,
    captureChunks: 0,
    wsState: -1,
    updatedAt: 0,
    ...overrides,
  };
}

describe("deriveAudioStatus", () => {
  test("inactive: pipeline not live", () => {
    const d = deriveAudioStatus(health({ active: false, updatedAt: NOW }), NOW);
    expect(d).toEqual({
      hearing: false,
      speakerDetected: false,
      healthy: false,
      status: "inactive",
    });
  });

  test("inactive: never polled (updatedAt=0) even if active flag set", () => {
    const d = deriveAudioStatus(health({ active: true, captureFlowing: true, updatedAt: 0 }), NOW);
    expect(d.healthy).toBe(false);
    expect(d.status).toBe("inactive");
  });

  test("inactive: stale snapshot (poller stalled) flips a would-be-healthy state", () => {
    // active + flowing, but the snapshot is 20s old (> 15s stale window).
    const d = deriveAudioStatus(
      health({ active: true, captureFlowing: true, speakerDetected: true, updatedAt: NOW - 20_000 }),
      NOW,
    );
    expect(d.hearing).toBe(true); // raw captureFlowing is still surfaced verbatim
    expect(d.healthy).toBe(false); // but not healthy — snapshot is stale
    expect(d.status).toBe("inactive");
  });

  test("healthy: live, fresh, hearing non-silent audio", () => {
    const d = deriveAudioStatus(
      health({
        active: true,
        captureFlowing: true,
        speakerDetected: true,
        lastMaxAmp: 4200,
        updatedAt: NOW - 1000,
      }),
      NOW,
    );
    expect(d).toEqual({
      hearing: true,
      speakerDetected: true,
      healthy: true,
      status: "healthy",
    });
  });

  test("silent: live, speaker was heard earlier, but audio not flowing now", () => {
    const d = deriveAudioStatus(
      health({ active: true, captureFlowing: false, speakerDetected: true, updatedAt: NOW - 2000 }),
      NOW,
    );
    expect(d.hearing).toBe(false);
    expect(d.speakerDetected).toBe(true);
    expect(d.healthy).toBe(false);
    expect(d.status).toBe("silent");
  });

  test("no-speaker: live and capturing, but no speaker ever detected", () => {
    const d = deriveAudioStatus(
      health({ active: true, captureFlowing: false, speakerDetected: false, updatedAt: NOW - 2000 }),
      NOW,
    );
    expect(d.hearing).toBe(false);
    expect(d.speakerDetected).toBe(false);
    expect(d.healthy).toBe(false);
    expect(d.status).toBe("no-speaker");
  });

  test("boundary: exactly at the stale window edge is treated as stale", () => {
    const atEdge = deriveAudioStatus(
      health({ active: true, captureFlowing: true, updatedAt: NOW - 15_000 }),
      NOW,
    );
    expect(atEdge.status).toBe("inactive"); // `now - updatedAt < 15000` is strict
    const justInside = deriveAudioStatus(
      health({ active: true, captureFlowing: true, updatedAt: NOW - 14_999 }),
      NOW,
    );
    expect(justInside.status).toBe("healthy");
  });
});

describe("CostMeter.getReport contract (data path behind GET /api/cost)", () => {
  test("no meetingId → aggregate across all retained meetings", () => {
    const meter = new CostMeter({ enabled: true });
    meter.record({ component: "voice", meetingId: "m1", model: "gpt-realtime-2", inputTokens: 1000, outputTokens: 500 });
    meter.record({ component: "vision", meetingId: "m2", model: "gpt-4o-mini", inputTokens: 2000, outputTokens: 200 });

    const report = meter.getReport(); // exactly what the endpoint returns with no ?meetingId
    expect(report.meetings).toBeDefined();
    expect(report.meetings!.length).toBe(2);
    expect(report.meeting).toBeUndefined();
    expect(report.totals.calls).toBe(2);
    expect(report.totals.estimatedUsd).toBeGreaterThan(0);
  });

  test("meetingId → that meeting only, with per-component breakdown", () => {
    const meter = new CostMeter({ enabled: true });
    meter.record({ component: "voice", meetingId: "m1", model: "gpt-realtime-2", inputTokens: 1000, outputTokens: 500 });
    meter.record({ component: "vision", meetingId: "m2", model: "gpt-4o-mini", inputTokens: 2000, outputTokens: 200 });

    const report = meter.getReport("m1"); // endpoint forwards ?meetingId=m1 through verbatim
    expect(report.meeting).toBeDefined();
    expect(report.meeting!.meetingId).toBe("m1");
    expect(report.meetings).toBeUndefined();
    expect(report.meeting!.components.voice).toBeDefined();
    expect(report.meeting!.components.vision).toBeUndefined();
    expect(report.totals).toBe(report.meeting!.totals);
  });

  test("unknown meetingId → empty (zeroed) report, never throws", () => {
    const meter = new CostMeter({ enabled: true });
    const report = meter.getReport("does-not-exist");
    expect(report.meeting).toBeDefined();
    expect(report.meeting!.meetingId).toBe("does-not-exist");
    expect(report.totals.calls).toBe(0);
    expect(report.totals.estimatedUsd).toBe(0);
  });
});
