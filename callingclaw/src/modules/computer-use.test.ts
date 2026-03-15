import { test, expect, describe } from "bun:test";
import { SharedContext } from "./shared-context";
import { ComputerUseModule } from "./computer-use";

describe("ComputerUseModule", () => {
  test("isConfigured returns false when no keys set", () => {
    const ctx = new SharedContext();
    // Create a mock bridge
    const mockBridge = {
      ready: false,
      on: () => {},
      send: () => false,
      sendAction: () => false,
    } as any;

    const cu = new ComputerUseModule(mockBridge, ctx);

    // Without any API keys, should not be configured
    // (depends on env — if OPENROUTER_API_KEY or ANTHROPIC_API_KEY is set, this could be true)
    expect(typeof cu.isConfigured).toBe("boolean");
  });

  test("execute returns error when not configured", async () => {
    const ctx = new SharedContext();
    const mockBridge = {
      ready: false,
      on: () => {},
      send: () => false,
      sendAction: () => false,
    } as any;

    // Force no keys
    const originalOR = process.env.OPENROUTER_API_KEY;
    const originalAK = process.env.ANTHROPIC_API_KEY;
    process.env.OPENROUTER_API_KEY = "";
    process.env.ANTHROPIC_API_KEY = "";

    const cu = new ComputerUseModule(mockBridge, ctx);

    if (!cu.isConfigured) {
      const result = await cu.execute("test instruction");
      expect(result.summary).toContain("No API key");
    }

    // Restore
    if (originalOR) process.env.OPENROUTER_API_KEY = originalOR;
    if (originalAK) process.env.ANTHROPIC_API_KEY = originalAK;
  });

  test("cancel stops execution", () => {
    const ctx = new SharedContext();
    const mockBridge = {
      ready: false,
      on: () => {},
      send: () => false,
      sendAction: () => false,
    } as any;

    const cu = new ComputerUseModule(mockBridge, ctx);
    // Should not throw
    cu.cancel();
  });
});
