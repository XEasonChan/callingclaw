/**
 * ai-tools.ts — recall_context Chinese matching
 *
 * Regression coverage for the `query.toLowerCase().split(/\s+/)` bug: Chinese has
 * no whitespace, so the whole query collapsed into one token that could only ever
 * substring-match an exact verbatim repeat. recall_context now uses
 * extractMatchTokens()/countTokenHits()/keywordOverlapScore() (src/utils/text-match.ts)
 * for both the prep-brief matcher (Path -1) and the ContextRetriever cache
 * check (Path 0).
 *
 * Run: bun test test/modules/ai-tools-recall-context.test.ts
 */

import { test, expect, describe } from "bun:test";
import { aiTools, type AIToolDeps } from "../../src/tool-definitions/ai-tools";

function makeDeps(overrides: Partial<AIToolDeps> = {}): AIToolDeps {
  const base: AIToolDeps = {
    contextSync: { searchMemory: () => "" } as any,
    contextRetriever: undefined,
    openclawBridge: { connected: false, sendTask: async () => "" } as any,
    dispatcher: undefined,
    eventBus: { emit: () => {} } as any,
    meetingPrepSkill: undefined,
  };
  return { ...base, ...overrides };
}

describe("recall_context — Path -1 prep brief (Chinese + English)", () => {
  test("Chinese query hits the right section via bigram overlap (not verbatim substring)", async () => {
    // Note: "定价策略是什么" is NOT a literal substring of the decision text below —
    // under the old whitespace-split code this would have been zero hits.
    const brief = {
      architectureDecisions: [
        { decision: "采用定价策略：一次性买断", rationale: "简化决策流程，单价 $19.99" },
      ],
      expectedQuestions: [],
      previousContext: "",
      keyPoints: [],
      filePaths: [],
      browserUrls: [],
    };
    const deps = makeDeps({ meetingPrepSkill: { currentBrief: brief } as any });
    const result = await aiTools(deps).handler("recall_context", { query: "定价策略是什么", urgency: "quick" });
    expect(result).toContain("[Prep brief — decisions]");
    expect(result).toContain("定价策略");
  });

  test("English query still matches English prep-brief content", async () => {
    const brief = {
      architectureDecisions: [],
      expectedQuestions: [
        { question: "What is the pricing model?", suggestedAnswer: "One-time purchase at $19.99" },
      ],
      previousContext: "",
      keyPoints: [],
      filePaths: [],
      browserUrls: [],
    };
    const deps = makeDeps({ meetingPrepSkill: { currentBrief: brief } as any });
    const result = await aiTools(deps).handler("recall_context", { query: "pricing model question", urgency: "quick" });
    expect(result).toContain("[Prep brief — questions]");
  });

  test("no section clears the min(2, tokens) bar -> falls through, does not fabricate a hit", async () => {
    const brief = {
      architectureDecisions: [{ decision: "团队人数", rationale: "五个人" }],
      expectedQuestions: [],
      previousContext: "",
      keyPoints: [],
      filePaths: [],
      browserUrls: [],
    };
    const deps = makeDeps({ meetingPrepSkill: { currentBrief: brief } as any });
    const result = await aiTools(deps).handler("recall_context", { query: "定价策略是什么", urgency: "quick" });
    expect(result).not.toContain("[Prep brief");
  });

  test("zero-token query (pure interrogative) skips Path -1 instead of returning the first section", async () => {
    // "是什么" tokenizes to nothing — `hits >= min(2, 0)` would be trivially
    // true and return the decisions section for ANY such query
    const brief = {
      architectureDecisions: [{ decision: "采用定价策略：一次性买断", rationale: "简化决策流程" }],
      expectedQuestions: [],
      previousContext: "",
      keyPoints: [],
      filePaths: [],
      browserUrls: [],
    };
    const deps = makeDeps({ meetingPrepSkill: { currentBrief: brief } as any });
    const result = await aiTools(deps).handler("recall_context", { query: "是什么", urgency: "quick" });
    expect(result).not.toContain("[Prep brief");
  });
});

describe("recall_context — Path 0 ContextRetriever cache", () => {
  test("a single coincidental token hit is rejected (false-positive guard)", async () => {
    const contextRetriever = {
      active: true,
      retrievedContexts: [
        // Shares only "方案" by coincidence with query "定价策略方案文档"; unrelated topic.
        { query: "会议纪要", content: "这个方案大家回头再对一下细节" },
      ],
    } as any;
    const deps = makeDeps({ contextRetriever });
    const result = await aiTools(deps).handler("recall_context", { query: "定价策略方案文档", urgency: "quick" });
    expect(result).not.toContain("[Retrieved context]");
  });

  test("short query (<3 tokens) cannot match via the score branch alone", async () => {
    // "竞品是什么情况" → 2 tokens (竞品/情况). A single 情况 hit scores 0.5 —
    // the score branch must not fire below 3 query tokens.
    const contextRetriever = {
      active: true,
      retrievedContexts: [
        { query: "近期情况汇总", content: "大概的情况一切正常" },
      ],
    } as any;
    const deps = makeDeps({ contextRetriever });
    const result = await aiTools(deps).handler("recall_context", { query: "竞品是什么情况", urgency: "quick" });
    expect(result).not.toContain("[Retrieved context]");
  });

  test("passes with >=2 hits and picks the best-scoring context, not the first .find() match", async () => {
    const contextRetriever = {
      active: true,
      retrievedContexts: [
        // Weaker match first (2/3 tokens) — old `.find()` behavior would stop here.
        { query: "策略讨论", content: "定价方面我们还在策略讨论中" },
        // Stronger match second (3/3 tokens) — should win on score.
        { query: "定价策略", content: "定价策略是 $19.99 一次性买断" },
      ],
    } as any;
    const deps = makeDeps({ contextRetriever });
    const result = await aiTools(deps).handler("recall_context", { query: "定价策略是什么", urgency: "quick" });
    expect(result).toContain("[Retrieved context]");
    expect(result).toContain("一次性买断");
  });

  test("no cached context matches -> falls through to local memory / no-info message", async () => {
    const contextRetriever = { active: true, retrievedContexts: [] } as any;
    const deps = makeDeps({ contextRetriever });
    const result = await aiTools(deps).handler("recall_context", { query: "completely unrelated gibberish", urgency: "quick" });
    expect(result).not.toContain("[Retrieved context]");
    expect(result).toMatch(/couldn't find|not currently available/i);
  });
});
