/**
 * Prompt Evaluation Tests — Tests actual LLM output quality.
 *
 * These tests send prompts to a model and verify the response meets criteria:
 * - Response length constraints
 * - Language switching
 * - Hallucination prevention
 * - Tool discovery (not hallucination)
 *
 * Requires OPENROUTER_API_KEY or OPENAI_API_KEY to be set.
 * Skipped if no API key is available (CI-safe).
 *
 * Run: bun test test/prompts/prompt-eval.test.ts
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { CORE_IDENTITY } from "../../src/prompt-constants";

// ── Config ──

const API_KEY = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
const BASE_URL = process.env.OPENROUTER_API_KEY
  ? "https://openrouter.ai/api/v1"
  : "https://api.openai.com/v1";
// Use a fast, cheap model for eval tests
const EVAL_MODEL = process.env.EVAL_MODEL
  || (process.env.OPENROUTER_API_KEY ? "anthropic/claude-3.5-haiku" : "gpt-4o-mini");

const SKIP_REASON = !API_KEY ? "No API key (set OPENROUTER_API_KEY or OPENAI_API_KEY)" : null;

// ── LLM Helper ──

async function chat(systemPrompt: string, userMessage: string): Promise<string> {
  const resp = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: EVAL_MODEL,
      max_tokens: 300,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    }),
  });
  if (!resp.ok) throw new Error(`API error ${resp.status}: ${await resp.text()}`);
  const data = (await resp.json()) as any;
  return data.choices?.[0]?.message?.content || "";
}

/** Count sentences (rough: split on . ! ? 。！？) */
function countSentences(text: string): number {
  return text.split(/[.!?。！？]+/).filter((s) => s.trim().length > 5).length;
}

// ══════════════════════════════════════════════════════════════
// Eval Tests
// ══════════════════════════════════════════════════════════════

describe("Prompt Eval: CORE_IDENTITY behavior", () => {
  beforeAll(() => {
    if (SKIP_REASON) console.log(`[Prompt Eval] Skipped: ${SKIP_REASON}`);
  });

  test.skipIf(!!SKIP_REASON)("matches depth to question — concise for confirmations", async () => {
    const response = await chat(CORE_IDENTITY, "Is TypeScript a superset of JavaScript? Yes or no.");
    const sentences = countSentences(response);
    expect(sentences).toBeLessThanOrEqual(3); // Confirmation = brief
    expect(response.length).toBeLessThan(500);
  });

  test.skipIf(!!SKIP_REASON)("responds in Chinese when asked in Chinese", async () => {
    const response = await chat(CORE_IDENTITY, "你好，你能帮我做什么？");
    // Should contain at least some Chinese characters
    const cjkChars = response.match(/[\u4e00-\u9fff]/g);
    expect(cjkChars?.length || 0).toBeGreaterThan(5);
  });

  test.skipIf(!!SKIP_REASON)("does not fabricate facts — pushes back or admits lack of knowledge", async () => {
    const response = await chat(
      CORE_IDENTITY,
      "What were the exact revenue numbers from the Q4 2025 board meeting for Acme Corp?"
    );
    const lower = response.toLowerCase();
    // Should either: admit ignorance, ask a clarifying question, or offer to look it up
    // Should NOT make up revenue numbers
    const doesNotFabricate =
      lower.includes("don't have") ||
      lower.includes("don't know") ||
      lower.includes("no context") ||
      lower.includes("不知道") ||
      lower.includes("没有") ||
      lower.includes("recall_context") ||
      lower.includes("look") ||
      lower.includes("查") ||
      lower.includes("cannot") ||
      lower.includes("unable") ||
      lower.includes("?") ||         // asks a clarifying question back
      lower.includes("which") ||     // pushes back for specifics
      lower.includes("clarify") ||
      lower.includes("specifically");
    expect(doesNotFabricate).toBe(true);
  });

  test.skipIf(!!SKIP_REASON)("does NOT hallucinate phantom tools", async () => {
    const response = await chat(
      CORE_IDENTITY,
      "What tools do you have access to? List them all."
    );
    const lower = response.toLowerCase();
    // Should NOT confidently list tools that aren't registered
    const phantomTools = ["schedule_meeting", "check_calendar", "join_meeting", "leave_meeting", "take_screenshot"];
    const mentioned = phantomTools.filter((t) => lower.includes(t));
    expect(mentioned.length).toBeLessThanOrEqual(1); // Allow at most 1 false positive
  });

  test.skipIf(!!SKIP_REASON)("never announces searching — uses context silently", async () => {
    const response = await chat(
      CORE_IDENTITY,
      "CallingClaw 的定价是多少？"
    );
    const lower = response.toLowerCase();
    // Should NOT say "let me look" or "让我查" — should either know it or ask the participant
    expect(lower).not.toContain("让我查");
    expect(lower).not.toContain("let me look");
    expect(lower).not.toContain("let me search");
    expect(lower).not.toContain("let me check");
  });

  test.skipIf(!!SKIP_REASON)("keeps technical terms in English when responding in Chinese", async () => {
    const response = await chat(CORE_IDENTITY, "TypeScript的泛型怎么用？");
    // Should contain "TypeScript" in English, not transliterated
    expect(response).toContain("TypeScript");
  });
});
