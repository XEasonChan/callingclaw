import { test, expect, describe } from "bun:test";
import { buildSystemContent } from "../../src/ai_gateway/llm-client";

// Pure-function tests for the opt-in prompt-cache system shaping.
// Existing callers (no cacheSystem flag) must keep plain-string system.

describe("buildSystemContent", () => {
  test("no cacheSystem flag → plain string (existing callers unchanged)", () => {
    expect(buildSystemContent("You are a helper", undefined, true)).toBe("You are a helper");
    expect(buildSystemContent("You are a helper", false, true)).toBe("You are a helper");
  });

  test("cacheSystem on a non-anthropic model → plain string (flag inert)", () => {
    expect(buildSystemContent("You are a helper", true, false)).toBe("You are a helper");
  });

  test("cacheSystem + anthropic → content array with ephemeral cache_control", () => {
    const result = buildSystemContent("You are a helper", true, true);
    expect(result).toEqual([
      { type: "text", text: "You are a helper", cache_control: { type: "ephemeral" } },
    ]);
  });
});
