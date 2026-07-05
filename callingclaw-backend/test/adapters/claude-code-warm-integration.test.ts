// Warm worker integration test against the REAL claude CLI.
// Auto-skips when `claude` is not on PATH. Makes two tiny real API calls
// (sonnet, trivial prompts) through ONE persistent streaming process, then
// verifies cooldown tears the worker down.
//
// Opt out explicitly with CLAUDE_WARM_IT=0 (e.g. offline CI).

import { test, expect } from "bun:test";

const cliPath = Bun.which("claude");
const enabled = !!cliPath && process.env.CLAUDE_WARM_IT !== "0";

test.skipIf(!enabled)(
  "warm worker end-to-end: two turns through one real claude process, then cooldown",
  async () => {
    delete process.env.CLAUDE_BIN; // real CLI, not a leftover test fake
    delete process.env.CLAUDE_WARM_WORKER;
    const { ClaudeCodeAdapter } = await import("../../src/adapters/claude-code-adapter");
    const a = new ClaudeCodeAdapter();

    await a.warmUp();
    const stats = a.warmStats();
    if (!stats.warm) {
      // Installed CLI lacks stream-json support — the feature correctly
      // stays off; nothing further to integration-test.
      console.log("[integration] stream-json unsupported by installed CLI — warm stayed off (valid)");
      return;
    }
    expect(stats.workers.task?.model).toBe("sonnet");
    expect(stats.workers.recall?.model).toBe("haiku");

    const t1 = Date.now();
    const r1 = await a.executeTask("Reply with exactly the word WARMOK and nothing else. Do not use any tools.");
    const d1 = Date.now() - t1;
    expect(r1.toUpperCase()).toContain("WARMOK");

    const t2 = Date.now();
    const r2 = await a.executeTask("Reply with exactly the word WARMTWO and nothing else. Do not use any tools.");
    const d2 = Date.now() - t2;
    expect(r2.toUpperCase()).toContain("WARMTWO");

    // Both turns served by the SAME persistent process (no per-call cold boot).
    expect(a.warmStats().workers.task?.turnsServed).toBe(2);
    console.log(`[integration] real-CLI warm turns: turn1=${d1}ms (includes worker boot wait), turn2=${d2}ms`);

    await a.cooldown();
    expect(a.warmStats().warm).toBe(false);
    expect(Object.keys(a.warmStats().workers)).toHaveLength(0);
  },
  180000,
);
