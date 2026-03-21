/**
 * Prompt Structure Tests — Verifies the 5-layer context engineering architecture.
 *
 * These tests verify structural properties of prompts WITHOUT calling any LLM API.
 * They ensure the context engineering strategy (CONTEXT-ENGINEERING.md) is followed.
 *
 * Run: bun test test/prompts/prompt-structure.test.ts
 */

import { describe, test, expect } from "bun:test";
import {
  CORE_IDENTITY,
  CORE_IDENTITY_TOKEN_BUDGET,
  LANGUAGE_RULE,
  MISSION_CONTEXT_PREFIX,
  MISSION_CONTEXT_SUFFIX,
  detectLanguage,
} from "../../src/prompt-constants";
import {
  buildVoiceInstructions,
  buildMeetingBriefContext,
} from "../../src/voice-persona";
import type { MeetingPrepBrief } from "../../src/skills/meeting-prep";

// ── Helpers ──

/** Rough token estimation: ~3.5 chars per token for mixed English/CJK */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/** Create a minimal meeting prep brief for testing */
function makeBrief(overrides: Partial<MeetingPrepBrief> = {}): MeetingPrepBrief {
  return {
    topic: "Test Meeting",
    goal: "Discuss test plan",
    summary: "A brief about testing.",
    keyPoints: ["Point 1", "Point 2"],
    architectureDecisions: [{ decision: "Use Bun", rationale: "Fast runtime" }],
    expectedQuestions: [{ question: "Why Bun?", suggestedAnswer: "Speed and DX" }],
    filePaths: [{ path: "/tmp/test.ts", description: "Test file", action: "open" }],
    browserUrls: [{ url: "https://example.com", description: "Example", action: "navigate" }],
    folderPaths: [],
    liveNotes: [],
    ...overrides,
  } as MeetingPrepBrief;
}

// ══════════════════════════════════════════════════════════════
// Layer 0: CORE_IDENTITY
// ══════════════════════════════════════════════════════════════

describe("Layer 0: CORE_IDENTITY", () => {
  test("stays under token budget", () => {
    const tokens = estimateTokens(CORE_IDENTITY);
    expect(tokens).toBeLessThanOrEqual(CORE_IDENTITY_TOKEN_BUDGET);
  });

  test("contains non-negotiable rules section", () => {
    expect(CORE_IDENTITY).toContain("non-negotiable");
  });

  test("contains the shared LANGUAGE_RULE", () => {
    expect(CORE_IDENTITY).toContain(LANGUAGE_RULE);
  });

  test("does NOT list any phantom tool names", () => {
    const phantomTools = [
      "schedule_meeting",
      "check_calendar",
      "join_meeting",
      "leave_meeting",
      "computer_action",
      "take_screenshot",
    ];
    for (const tool of phantomTools) {
      expect(CORE_IDENTITY).not.toContain(tool);
    }
  });

  test("positions background context as silent, never announced", () => {
    const lower = CORE_IDENTITY.toLowerCase();
    expect(lower).toContain("never announce");
    expect(lower).toContain("silently");
  });

  test("does NOT instruct to say 'let me check' or '让我查一下'", () => {
    expect(CORE_IDENTITY).not.toContain("让我查一下");
    expect(CORE_IDENTITY).not.toContain("Let me check");
    expect(CORE_IDENTITY).not.toContain("let me look");
  });

  test("includes facilitator role (insightful advisor, not retrieval)", () => {
    const lower = CORE_IDENTITY.toLowerCase();
    expect(lower).toContain("facilitator");
    expect(lower).toContain("insightful advisor");
  });

  test("includes decision confirmation pattern", () => {
    expect(CORE_IDENTITY).toContain("decision is X");
  });

  test("includes pushback on vague requirements", () => {
    const lower = CORE_IDENTITY.toLowerCase();
    expect(lower).toContain("push back");
    expect(lower).toContain("specifically");
  });

  test("includes depth-matching response style (not fixed length)", () => {
    const lower = CORE_IDENTITY.toLowerCase();
    expect(lower).toContain("match depth");
    expect(lower).toContain("tradeoffs");
    // Must NOT contain hard "3 sentences" cap
    expect(CORE_IDENTITY).not.toContain("Under 3 sentences");
  });

  test("explicitly bans filler phrases", () => {
    expect(CORE_IDENTITY).toContain("Never filler");
  });

  test("includes silence rule for presentations", () => {
    expect(CORE_IDENTITY.toLowerCase()).toContain("presenting");
    expect(CORE_IDENTITY.toLowerCase()).toContain("silent");
  });

  test("includes action item tracking with owner", () => {
    const lower = CORE_IDENTITY.toLowerCase();
    expect(lower).toContain("action items");
    expect(lower).toContain("owner");
  });
});

// ══════════════════════════════════════════════════════════════
// buildVoiceInstructions() — Layer 0 only
// ══════════════════════════════════════════════════════════════

describe("buildVoiceInstructions()", () => {
  test("returns CORE_IDENTITY with no brief", () => {
    expect(buildVoiceInstructions()).toBe(CORE_IDENTITY);
  });

  test("returns CORE_IDENTITY even WITH a brief (brief goes to Layer 2)", () => {
    const brief = makeBrief();
    expect(buildVoiceInstructions(brief)).toBe(CORE_IDENTITY);
  });

  test("returns CORE_IDENTITY with null brief", () => {
    expect(buildVoiceInstructions(null)).toBe(CORE_IDENTITY);
  });
});

// ══════════════════════════════════════════════════════════════
// Layer 2: Meeting Brief Context
// ══════════════════════════════════════════════════════════════

describe("Layer 2: buildMeetingBriefContext()", () => {
  test("returns null for null/undefined brief", () => {
    expect(buildMeetingBriefContext(null)).toBeNull();
    expect(buildMeetingBriefContext(undefined)).toBeNull();
  });

  test("wraps content with MISSION_CONTEXT markers", () => {
    const brief = makeBrief();
    const result = buildMeetingBriefContext(brief)!;
    expect(result).toContain(MISSION_CONTEXT_PREFIX);
    expect(result).toContain(MISSION_CONTEXT_SUFFIX);
  });

  test("includes topic and goal", () => {
    const brief = makeBrief({ topic: "CallingClaw v3", goal: "Design review" });
    const result = buildMeetingBriefContext(brief)!;
    expect(result).toContain("CallingClaw v3");
    expect(result).toContain("Design review");
  });

  test("includes key points compressed to semicolons", () => {
    const brief = makeBrief({ keyPoints: ["Alpha", "Beta", "Gamma"] });
    const result = buildMeetingBriefContext(brief)!;
    expect(result).toContain("Alpha; Beta; Gamma");
  });

  test("includes file paths", () => {
    const brief = makeBrief({
      filePaths: [{ path: "/src/main.ts", description: "Entry point", action: "open" }],
    });
    const result = buildMeetingBriefContext(brief)!;
    expect(result).toContain("/src/main.ts");
  });

  test("includes browser URLs", () => {
    const brief = makeBrief({
      browserUrls: [{ url: "https://github.com/test", description: "Repo", action: "navigate" }],
    });
    const result = buildMeetingBriefContext(brief)!;
    expect(result).toContain("https://github.com/test");
  });

  test("does NOT contain persona/behavioral instructions", () => {
    const brief = makeBrief();
    const result = buildMeetingBriefContext(brief)!;
    expect(result).not.toContain("non-negotiable");
    expect(result).not.toContain("voice assistant");
    expect(result).not.toContain("Keep responses");
  });
});

// ══════════════════════════════════════════════════════════════
// Shared Constants
// ══════════════════════════════════════════════════════════════

describe("LANGUAGE_RULE", () => {
  test("mentions Chinese", () => {
    expect(LANGUAGE_RULE.toLowerCase()).toContain("chinese");
  });

  test("mentions technical terms in English", () => {
    expect(LANGUAGE_RULE.toLowerCase()).toContain("technical");
    expect(LANGUAGE_RULE.toLowerCase()).toContain("english");
  });
});

describe("detectLanguage()", () => {
  test("returns 'zh' for Chinese text", () => {
    expect(detectLanguage("你好世界这是一个测试")).toBe("zh");
  });

  test("returns 'en' for English text", () => {
    expect(detectLanguage("Hello world this is a test")).toBe("en");
  });

  test("returns 'en' for empty text", () => {
    expect(detectLanguage("")).toBe("en");
  });

  test("returns 'zh' for mixed text with CJK characters", () => {
    expect(detectLanguage("CallingClaw 是一个会议助手")).toBe("zh");
  });

  test("returns 'zh' for bilingual tech talk (code-switching)", () => {
    // Realistic: Chinese speaker mixing English technical terms
    expect(detectLanguage("MeetingScheduler 重复 cron 的根因是什么？")).toBe("zh");
    expect(detectLanguage("Sidecar crash 的 pattern 是什么？")).toBe("zh");
  });

  test("returns 'en' for mostly English with minimal CJK", () => {
    expect(detectLanguage("The CallingClaw meeting assistant helps users")).toBe("en");
  });
});

// ══════════════════════════════════════════════════════════════
// Cross-Cutting: No Copy-Paste Violations
// ══════════════════════════════════════════════════════════════

describe("DRY: LANGUAGE_RULE usage", () => {
  test("CORE_IDENTITY uses the constant, not a copy-pasted variant", () => {
    // The exact LANGUAGE_RULE string must appear in CORE_IDENTITY
    expect(CORE_IDENTITY).toContain(LANGUAGE_RULE);
  });
});
