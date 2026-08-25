import { test, expect, describe } from "bun:test";
import {
  ContextRetriever,
  looksLikeQuestion,
  searchCache,
} from "../../src/modules/context-retriever";
import type { RetrievedContext } from "../../src/modules/context-retriever";
import { SharedContext } from "../../src/modules/shared-context";
import { EventBus } from "../../src/modules/event-bus";

// ══════════════════════════════════════════════════════════════
// looksLikeQuestion — trigger predicate
// ══════════════════════════════════════════════════════════════

describe("looksLikeQuestion", () => {
  test("triggers on literal questions and interrogative past references", () => {
    const triggers = [
      "上次说的方案最后怎么定的？",            // literal ？
      "这个数据是哪来的？",                    // literal ？
      "还记得三月那个audio bug吗",             // 吗-final
      "为什么选Electron",                      // interrogative opener
      "上次说的方案最后怎么定的",              // STT dropped the ？ — 上次…怎么 shape
      "记不记得那个audio的bug",                // 记不记得 shape
      "这个数据是哪来的",                      // domain noun + question form (哪来)
      "do you remember the pricing decision",  // en past-reference shape
      "what did we decide about pricing?",     // literal ?
    ];
    for (const t of triggers) {
      expect(looksLikeQuestion(t), `should trigger: ${t}`).toBe(true);
    }
  });

  test("does NOT trigger on filler words or bare noun mentions", () => {
    const nonTriggers = [
      "那个我们继续吧",                        // 那个 is filler, not a past reference
      "我们设计上再想想",                      // bare 设计
      "这个方案挺好的",                        // bare 方案
      "嗯对，数据我回头发你",                  // bare 数据
      "这个bug我修了",                         // bare bug/修了 statement
      "we already fixed that bug last week",   // bare en bug statement
      "没什么问题，我们继续",                  // 没什么 is not a question form
      "数据这块不怎么好看",                    // 不怎么 is not a question form
    ];
    for (const t of nonTriggers) {
      expect(looksLikeQuestion(t), `should NOT trigger: ${t}`).toBe(false);
    }
  });
});

// ══════════════════════════════════════════════════════════════
// searchCache — CJK-aware cache matching
// ══════════════════════════════════════════════════════════════

describe("searchCache", () => {
  const now = Date.now();
  const cached: RetrievedContext[] = [
    { query: "CallingClaw pricing decision", content: "定价 $19.99 买断制，不做订阅", retrievedAt: now },
    { query: "meeting room booking", content: "Rooms are booked via the office portal", retrievedAt: now },
  ];

  test("Chinese question hits cached context sharing a concept (bigram overlap)", () => {
    const hits = searchCache(cached, "定价策略是多少钱");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.query).toBe("CallingClaw pricing decision");
  });

  test("unrelated Chinese question does not hit", () => {
    expect(searchCache(cached, "下周的发布会谁来主持")).toHaveLength(0);
  });

  test("English matching still works", () => {
    const hits = searchCache(cached, "what was the pricing decision");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.query).toBe("CallingClaw pricing decision");
  });

  test("unrelated English question does not hit", () => {
    expect(searchCache(cached, "where are the design mockups")).toHaveLength(0);
  });

  test("mixed zh-en question matches across both scripts", () => {
    const audioCache: RetrievedContext[] = [
      { query: "audio bug March", content: "三月的audio bug：AudioWorklet 跨域问题，用 Blob URL 修复", retrievedAt: now },
    ];
    expect(searchCache(audioCache, "还记得三月那个audio bug吗")).toHaveLength(1);
  });

  test("question with only stopwords/interrogatives returns empty", () => {
    expect(searchCache(cached, "是多少呢")).toHaveLength(0);
    expect(searchCache(cached, "")).toHaveLength(0);
    expect(searchCache([], "定价策略是多少钱")).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════
// runAnalysis — merged Layer 1+2 keeps event payload shapes
// ══════════════════════════════════════════════════════════════

function makeRetriever() {
  const context = new SharedContext();
  const eventBus = new EventBus();
  const prepSkill = { currentBrief: null, addLiveNote() {} } as any;
  const retriever = new ContextRetriever({ context, eventBus, meetingPrepSkill: prepSkill });

  const events: Record<string, any[]> = {};
  for (const type of ["retriever.topic", "retriever.analysis", "retriever.searching", "retriever.complete", "retriever.cache_hit"]) {
    events[type] = [];
    eventBus.on(type, (data) => events[type]!.push(data));
  }

  // Seed transcript directly (bypasses the emit path so no analysis is scheduled)
  (context as any)._transcript.push(
    { role: "user", text: "我们聊聊定价", ts: Date.now() },
    { role: "assistant", text: "好的，定价方面有几个选项", ts: Date.now() },
  );

  return { retriever, context, eventBus, events };
}

describe("runAnalysis (merged analyzeConversation)", () => {
  test("topic shift: emits retriever.topic + retriever.analysis with unchanged payloads, updates topic state", async () => {
    const { retriever, events } = makeRetriever();
    retriever.activate({ connected: false } as any);

    (retriever as any).analyzeConversation = async () => ({
      topic: "pricing strategy",
      direction: "deciding launch price",
      shifted: true,
      needsRetrieval: true,
      queries: ["CallingClaw pricing decision"],
      reasoning: "pricing history not in prep",
    });
    (retriever as any).semanticSearch = async () => ([
      { query: "CallingClaw pricing decision", content: "定价 $19.99 买断制", retrievedAt: Date.now() },
    ]);

    await (retriever as any).runAnalysis();

    // retriever.topic payload shape (UI compatibility)
    expect(events["retriever.topic"]).toHaveLength(1);
    expect(Object.keys(events["retriever.topic"]![0]).sort()).toEqual(["direction", "durationMs", "shifted", "topic"]);
    expect(events["retriever.topic"]![0].topic).toBe("pricing strategy");
    expect(events["retriever.topic"]![0].shifted).toBe(true);

    // retriever.analysis payload shape (UI compatibility)
    expect(events["retriever.analysis"]).toHaveLength(1);
    expect(Object.keys(events["retriever.analysis"]![0]).sort()).toEqual(["durationMs", "needsRetrieval", "queries", "reasoning"]);
    expect(events["retriever.analysis"]![0].needsRetrieval).toBe(true);
    expect(events["retriever.analysis"]![0].queries).toEqual(["CallingClaw pricing decision"]);

    // searching + complete still fire
    expect(events["retriever.searching"]).toHaveLength(1);
    expect(events["retriever.complete"]).toHaveLength(1);

    // Topic state + getStatus fields unchanged
    const status = retriever.getStatus();
    expect(status.currentTopic).toBe("pricing strategy");
    expect(status.currentDirection).toBe("deciding launch price");
    expect(status.topicStableSince).toBeGreaterThan(0);
    expect(status.topicCacheTopics).toEqual(["pricing strategy"]);
    expect(status.retrievedContextsCount).toBe(1);

    retriever.deactivate();
  });

  test("same topic + pending question: hits topic cache, no second retriever.analysis", async () => {
    const { retriever, context, events } = makeRetriever();
    retriever.activate({ connected: false } as any);

    // First run: shift → populates the topic cache
    (retriever as any).analyzeConversation = async () => ({
      topic: "pricing strategy", direction: "deciding launch price", shifted: true,
      needsRetrieval: true, queries: ["CallingClaw pricing decision"], reasoning: "needs pricing history",
    });
    (retriever as any).semanticSearch = async () => ([
      { query: "CallingClaw pricing decision", content: "定价 $19.99 买断制", retrievedAt: Date.now() },
    ]);
    await (retriever as any).runAnalysis();

    // Second run: same topic, user asked a follow-up question
    (retriever as any).analyzeConversation = async () => ({
      topic: "pricing strategy", direction: "", shifted: false,
      needsRetrieval: false, queries: [], reasoning: "",
    });
    (retriever as any)._pendingQuestion = true;
    (context as any)._transcript.push({ role: "user", text: "定价策略是多少钱", ts: Date.now() });
    await (retriever as any).runAnalysis();

    expect(events["retriever.cache_hit"]).toHaveLength(1);
    expect(events["retriever.cache_hit"]![0].topic).toBe("pricing strategy");
    expect(events["retriever.cache_hit"]![0].resultsCount).toBe(1);
    // retriever.analysis only emitted on topic shift (first run)
    expect(events["retriever.analysis"]).toHaveLength(1);
    expect(events["retriever.topic"]).toHaveLength(2);

    retriever.deactivate();
  });
});
