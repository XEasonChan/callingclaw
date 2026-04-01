import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { callModel, parseJSON } from "../../src/ai_gateway/llm-client";

// ── parseJSON tests ──

test("parseJSON extracts JSON from clean response", () => {
  const result = parseJSON<{ action: string }>('{"action":"click"}');
  expect(result).toEqual({ action: "click" });
});

test("parseJSON extracts JSON from markdown-fenced response", () => {
  const result = parseJSON<{ topic: string }>(
    'Here is the result:\n```json\n{"topic":"CallingClaw PRD"}\n```'
  );
  expect(result).toEqual({ topic: "CallingClaw PRD" });
});

test("parseJSON extracts JSON with surrounding text", () => {
  const result = parseJSON<{ needsRetrieval: boolean }>(
    'Based on analysis, {"needsRetrieval": false, "reasoning": "already covered"} is the answer.'
  );
  expect(result).not.toBeNull();
  expect(result!.needsRetrieval).toBe(false);
});

test("parseJSON returns null for non-JSON text", () => {
  expect(parseJSON("no json here")).toBeNull();
  expect(parseJSON("")).toBeNull();
});

test("parseJSON returns null for malformed JSON", () => {
  expect(parseJSON("{broken: json}")).toBeNull();
});
