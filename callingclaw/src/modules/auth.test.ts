import { test, expect, describe } from "bun:test";
import { AuthModule } from "./auth";

describe("AuthModule", () => {
  test("getStatus returns masked keys", () => {
    const auth = new AuthModule();
    const status = auth.getStatus();

    expect(status.openai).toBeDefined();
    expect(status.anthropic).toBeDefined();
    expect(status.google).toBeDefined();

    // Keys should not expose full values
    if (status.openai.configured) {
      expect(status.openai.masked).toMatch(/^sk-\.\.\..{4}$/);
    }
  });

  test("getStatus reflects unconfigured state", () => {
    const auth = new AuthModule();
    const status = auth.getStatus();

    // In test env, keys are likely not set
    expect(typeof status.openai.configured).toBe("boolean");
    expect(typeof status.anthropic.configured).toBe("boolean");
    expect(typeof status.google.configured).toBe("boolean");
  });
});
