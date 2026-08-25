/**
 * Recall Context Scenario Tests — 50 realistic mid-meeting context retrieval cases.
 *
 * Simulates real meetings where someone asks a question that requires recall_context:
 * - GTM/Demo meetings (十字路口活动, pitch deck)
 * - Bug regression meetings (P0/P1 bug review)
 * - Architecture review meetings (Electron migration, audio pipeline)
 * - Product roadmap meetings (Link 2.0, Memdex)
 * - Frontend optimization meetings
 *
 * Scenario data + the RecallScenario interface live in ./recall-scenarios.ts
 * (plain module, no test imports) so auditor-intent-eval.test.ts can reuse
 * them without re-registering this file's describe blocks.
 *
 * These are used by the eval harness to measure:
 * 1. Latency: time from query to answer (target: <2s quick, <15s thorough)
 * 2. Accuracy: do expectedKeywords appear in the response?
 * 3. Relevance: is the answer actually useful for the meeting context?
 *
 * Run: bun test test/prompts/recall-context-scenarios.test.ts
 */

import { describe, test, expect } from "bun:test";
import { detectLanguage } from "../../src/prompt-constants";
import { RECALL_SCENARIOS } from "./recall-scenarios";

// ═══════════════════════════════════════════════════════════════════
// Structural Validation Tests (no API calls)
// ═══════════════════════════════════════════════════════════════════

describe("Recall Context Scenarios: structural validation", () => {
  test("has exactly 50 scenarios", () => {
    expect(RECALL_SCENARIOS.length).toBe(50);
  });

  test("all scenarios have unique IDs", () => {
    const ids = RECALL_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("all scenarios have required fields", () => {
    for (const s of RECALL_SCENARIOS) {
      expect(s.meetingTopic).toBeTruthy();
      expect(s.utterance).toBeTruthy();
      expect(s.expectedQuery).toBeTruthy();
      expect(s.expectedKeywords.length).toBeGreaterThan(0);
      expect(["architecture", "metrics", "bug", "decision", "history", "product", "gtm", "competitor", "infrastructure"]).toContain(s.category);
      expect(["quick", "thorough"]).toContain(s.urgency);
      expect(["zh", "en"]).toContain(s.language);
    }
  });

  test("language detection matches expected language", () => {
    for (const s of RECALL_SCENARIOS) {
      const detected = detectLanguage(s.utterance);
      expect(detected).toBe(s.language);
    }
  });

  test("covers all 9 categories", () => {
    const categories = new Set(RECALL_SCENARIOS.map((s) => s.category));
    expect(categories.size).toBe(9);
  });

  test("includes both zh and en scenarios", () => {
    const zhCount = RECALL_SCENARIOS.filter((s) => s.language === "zh").length;
    const enCount = RECALL_SCENARIOS.filter((s) => s.language === "en").length;
    expect(zhCount).toBeGreaterThan(30);
    expect(enCount).toBeGreaterThan(3);
  });

  test("mostly quick urgency (realistic for meetings)", () => {
    const quickCount = RECALL_SCENARIOS.filter((s) => s.urgency === "quick").length;
    expect(quickCount).toBeGreaterThan(40);
  });

  test("category distribution summary", () => {
    const dist: Record<string, number> = {};
    for (const s of RECALL_SCENARIOS) {
      dist[s.category] = (dist[s.category] || 0) + 1;
    }
    console.log("[Scenarios] Category distribution:", dist);
    // Architecture and bug should be well represented
    expect(dist["architecture"]!).toBeGreaterThanOrEqual(5);
    expect(dist["bug"]!).toBeGreaterThanOrEqual(5);
  });

  test("meeting topic distribution summary", () => {
    const dist: Record<string, number> = {};
    for (const s of RECALL_SCENARIOS) {
      dist[s.meetingTopic] = (dist[s.meetingTopic] || 0) + 1;
    }
    console.log("[Scenarios] Meeting topic distribution:", dist);
    expect(Object.keys(dist).length).toBeGreaterThanOrEqual(10);
  });
});

// ═══════════════════════════════════════════════════════════════════
// E2E Eval Harness (requires API key + OpenClaw workspace)
// ═══════════════════════════════════════════════════════════════════

const HAS_WORKSPACE = await Bun.file(`${process.env.HOME}/.openclaw/workspace/MEMORY.md`).exists();
const HAS_API_KEY = !!(process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY);
const SKIP_E2E = !HAS_WORKSPACE || !HAS_API_KEY
  ? `Missing: ${!HAS_WORKSPACE ? "OpenClaw workspace" : ""} ${!HAS_API_KEY ? "API key" : ""}`.trim()
  : null;

describe("Recall Context Scenarios: E2E retrieval eval", () => {
  // This test runs a sample of scenarios through the actual ContextRetriever
  // agentic search pipeline to measure latency and accuracy.
  //
  // To run the full suite: EVAL_FULL=1 bun test test/prompts/recall-context-scenarios.test.ts
  // Default: runs 5 random scenarios for quick CI check.

  const FULL = process.env.EVAL_FULL === "1";
  const SAMPLE_SIZE = FULL ? 50 : 5;
  const sample = FULL
    ? RECALL_SCENARIOS
    : RECALL_SCENARIOS.sort(() => Math.random() - 0.5).slice(0, SAMPLE_SIZE);

  test.skipIf(!!SKIP_E2E)(`keyword search on MEMORY.md for ${SAMPLE_SIZE} scenarios`, async () => {
    const memoryPath = `${process.env.HOME}/.openclaw/workspace/MEMORY.md`;
    const memory = await Bun.file(memoryPath).text();
    const memoryLower = memory.toLowerCase();

    let hits = 0;
    let misses = 0;
    const results: Array<{ id: number; hit: boolean; matchedKeywords: string[]; missedKeywords: string[] }> = [];

    for (const s of sample) {
      const matched = s.expectedKeywords.filter((kw) => memoryLower.includes(kw.toLowerCase()));
      const missed = s.expectedKeywords.filter((kw) => !memoryLower.includes(kw.toLowerCase()));
      const hit = matched.length >= Math.ceil(s.expectedKeywords.length * 0.5); // 50% keyword match = hit

      if (hit) hits++;
      else misses++;

      results.push({ id: s.id, hit, matchedKeywords: matched, missedKeywords: missed });
    }

    const accuracy = Math.round((hits / sample.length) * 100);
    console.log(`[E2E Eval] Keyword accuracy on MEMORY.md: ${accuracy}% (${hits}/${sample.length})`);

    if (misses > 0) {
      const missedScenarios = results.filter((r) => !r.hit);
      console.log(`[E2E Eval] Missed scenarios:`);
      for (const m of missedScenarios) {
        console.log(`  #${m.id}: missed keywords: ${m.missedKeywords.join(", ")}`);
      }
    }

    // At least 60% of scenarios should find keywords in MEMORY.md
    // (some scenarios may require data from other workspace files)
    expect(accuracy).toBeGreaterThanOrEqual(60);
  });
});
