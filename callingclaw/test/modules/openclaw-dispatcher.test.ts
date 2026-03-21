/**
 * OpenClawDispatcher — Unit Tests
 *
 * Tests three-channel dispatch: local keyword search, subprocess, and gateway fallback.
 * Subprocess tests are skipped if `claude` CLI is not available.
 *
 * Run: bun test test/modules/openclaw-dispatcher.test.ts
 */

import { describe, test, expect, beforeAll, setDefaultTimeout } from "bun:test";

// Subprocess tests need >5s (claude -p startup + model call)
setDefaultTimeout(30000);
import { OpenClawDispatcher, type DispatchResult } from "../../src/openclaw-dispatcher";

// Mock OpenClawBridge for tests
class MockGateway {
  connected = false;
  lastTask = "";
  async connect() { this.connected = true; }
  async sendTask(task: string): Promise<string> {
    this.lastTask = task;
    return `Gateway response for: ${task.slice(0, 50)}`;
  }
}

const HAS_WORKSPACE = await Bun.file(`${process.env.HOME}/.openclaw/workspace/MEMORY.md`).exists();
const HAS_CLAUDE = await Bun.$`which claude`.quiet().then(() => true).catch(() => false);

describe("OpenClawDispatcher", () => {
  let dispatcher: OpenClawDispatcher;
  let gateway: MockGateway;

  beforeAll(() => {
    gateway = new MockGateway();
    dispatcher = new OpenClawDispatcher(gateway as any);
  });

  // ── Local channel ──

  test("recall() uses local channel for known keywords", async () => {
    if (!HAS_WORKSPACE) return; // Skip if no workspace

    const result = await dispatcher.recall("CallingClaw pricing strategy");
    expect(result.channel).toBe("local");
    expect(result.durationMs).toBeLessThan(500);
    // Should find something about $19.99 or GTM
    expect(result.result.length).toBeGreaterThan(10);
  });

  test("recall() escalates when local finds nothing", async () => {
    const result = await dispatcher.dispatch("completely-unknown-gibberish-xyz-999", {
      urgency: "realtime",
      timeout: 15000,
    });
    // Local fails → dispatch chain escalates to subprocess or gateway
    // The channel should NOT be "local" since there are no matches for gibberish
    expect(["subprocess", "gateway"]).toContain(result.channel);
  });

  // ── Channel selection ──

  test("dispatch with urgency=realtime selects local", async () => {
    if (!HAS_WORKSPACE) return;
    const result = await dispatcher.dispatch("Andrew email", { urgency: "realtime" });
    expect(result.channel).toBe("local");
  });

  test("dispatch with urgency=background selects gateway", async () => {
    gateway.connected = true;
    const result = await dispatcher.dispatch("deep research task", { urgency: "background", timeout: 5000 });
    expect(result.channel).toBe("gateway");
    expect(gateway.lastTask).toContain("deep research");
  });

  // ── Convenience methods ──

  test("deepResearch() uses gateway", async () => {
    gateway.connected = true;
    const result = await dispatcher.deepResearch("analyze codebase architecture");
    expect(result.channel).toBe("gateway");
  });

  // ── Subprocess channel (only if claude CLI available) ──

  test.skipIf(!HAS_CLAUDE)("subprocess channel runs claude -p", async () => {
    const result = await dispatcher.dispatch(
      "What is 2 + 2? Reply with just the number.",
      { urgency: "fast", model: "haiku", maxTurns: 1, timeout: 15000 },
    );
    expect(result.channel).toBe("subprocess");
    expect(result.result).toContain("4");
    expect(result.durationMs).toBeLessThan(15000);
    console.log(`[Test] Subprocess latency: ${result.durationMs}ms`);
  });

  test.skipIf(!HAS_CLAUDE)("recallThorough() uses subprocess with haiku", async () => {
    if (!HAS_WORKSPACE) return;
    const result = await dispatcher.recallThorough("CallingClaw Electron migration");
    expect(result.channel).toBe("subprocess");
    expect(result.durationMs).toBeLessThan(30000);
    console.log(`[Test] Thorough recall latency: ${result.durationMs}ms`);
  });
});
