// TranscriptAuditor — explicit agent-address fast lane (unit tests)
//
// Covers:
//   1. Pattern matching (positive + negative) for matchAgentResearchAddress
//   2. Deterministic query extraction (incl. trigger-prefix fallback + filler strip)
//   3. Routing: explicit agent address → agentAdapter.executeTask immediately,
//      with NO debounce timer scheduled and NO LLM (callModel) invocation.
//
// NOTE: the live eval harness (test/prompts/*) calls real models — this file
// deliberately mocks the LLM client so no network call can ever happen.

import { test, expect, mock } from "bun:test";

// ── Mock the LLM client BEFORE importing the auditor ──
// Any call to callModel in this test file is a bug (the fast lane must be
// LLM-free), so record calls and return an inert classification.
const callModelCalls: any[] = [];
const DEFAULT_CALL_MODEL_RESPONSE = '{"action":null,"params":{},"confidence":0,"reasoning":"mock"}';
let callModelResponse = DEFAULT_CALL_MODEL_RESPONSE;
mock.module("../../src/ai_gateway/llm-client", () => ({
  callModel: async (...args: any[]) => {
    callModelCalls.push(args);
    return callModelResponse;
  },
  parseJSON: <T,>(text: string): T | null => {
    try { return JSON.parse(text) as T; } catch { return null; }
  },
}));

const { TranscriptAuditor, matchAgentResearchAddress, AGENT_ADDRESS_PATTERNS } = await import(
  "../../src/modules/transcript-auditor"
);
const { SharedContext } = await import("../../src/modules/shared-context");

// ═══════════════════════════════════════════════════════════════════
// 1. Pattern matching — positives
// ═══════════════════════════════════════════════════════════════════

const POSITIVE_CASES: Array<[utterance: string, expectedQuery: string]> = [
  // zh imperative: 让/叫/请/麻烦 + agent/AI/助手 + verb
  ["让agent查一下竞品定价", "竞品定价"],
  ["让 agent 查一下 CallingClaw 的竞品", "CallingClaw 的竞品"],
  ["请AI搜索最新的行业报告", "最新的行业报告"],
  // NOTE: bare 助手/助理 was dropped from the imperative form (human-assistant
  // ambiguity: "麻烦助理查一下会议室安排"). Compound AI tokens still work.
  ["叫智能助手研究一下特斯拉财报", "特斯拉财报"],
  ["让agent研究一下OpenAI的新模型", "OpenAI的新模型"],
  ["麻烦agent调研一下海外市场", "海外市场"],
  ["让AI帮我查一下明天的行业峰会", "明天的行业峰会"],
  ["我让agent查一下用户反馈吧", "用户反馈"],
  ["让那个智能体搜一下开源方案", "开源方案"],
  ["让agent找一下Granola的最新融资消息", "Granola的最新融资消息"],
  // zh direct address (punctuation after token)
  ["agent，查一下英伟达股价", "英伟达股价"],
  ["助手：搜索一下竞品的新功能", "竞品的新功能"],
  // en imperative
  ["ask the agent to look up the latest Bun release", "the latest Bun release"],
  ["ask the agent to look up NVIDIA earnings", "NVIDIA earnings"],
  ["Ask the AI to research competitor pricing", "competitor pricing"],
  ["have the agent search for reviews of Granola", "reviews of Granola"],
  ["tell the agent to find out about the EU AI Act", "the EU AI Act"],
  ["get the agent to investigate the outage reports", "the outage reports"],
  // en direct address
  ["Agent, look up NVIDIA earnings", "NVIDIA earnings"],
  ["agent, look up the Q3 numbers", "the Q3 numbers"],
  ["hey agent, research the latest Bun release", "the latest Bun release"],
  ["hey agent search for reactions to the keynote", "reactions to the keynote"],
];

for (const [utterance, expected] of POSITIVE_CASES) {
  test(`match: "${utterance}" → "${expected}"`, () => {
    const m = matchAgentResearchAddress(utterance);
    expect(m).not.toBeNull();
    expect(m!.query).toBe(expected);
  });
}

// ═══════════════════════════════════════════════════════════════════
// 1b. Pattern matching — negatives (must NOT trigger auto-research)
// ═══════════════════════════════════════════════════════════════════

const NEGATIVE_CASES: string[] = [
  // Bare research verbs without an explicit agent token
  "查一下天气",
  "帮我查一下竞品定价",
  "搜索一下最新新闻",
  "look up the numbers before the next call",
  "let's search for a better name",
  // Agent token but no addressing verb pair
  "让他查一下天气",           // 他 is not the agent
  "请大家查一下手机",         // 大家 is not the agent
  "the agent looked up the data already", // past tense, no imperative
  "we should ask the agent about it tomorrow", // no research verb
  "AI search is getting better every year",    // no punctuation, not an address
  "叫外卖的时候查一下评分",   // 叫 + 外卖, not the agent
  // Screen viewing ≠ research (查看 must not match bare 查)
  "让agent查看一下屏幕",
  // Local files / meeting recall → Haiku lane (has context for search_and_open/recall)
  "让agent找一下那个prep文件",
  "ask the agent to look up our meeting notes",
  // Hypothetical / deferred → Haiku lane
  "如果可以的话，让agent查一下预算方案",
  "比如让agent查一下天气这种功能",
  "how do we get the AI to search for stuff on its own",
  "下次让agent查一下这个",
  // Negation — the user explicitly does NOT want research
  "别让agent搜索这个",
  "不用让agent查了，我知道答案",
  "don't ask the agent to search for it, I already know",
  // Past tense / completed aspect — a report, not a request
  "昨天我让agent查了一下竞品",
  // Reported / meta speech — describing the feature, not using it
  "在demo里你可以让agent查一下天气",
  "当用户说让agent搜索新闻的时候我们走fast lane",
  "so in the video she says ask the agent to look up NVIDIA earnings",
  // Declarative plans — no live address
  "we want to get AI search working before launch",
  "让AI搜索变得更快是我们的目标",
  // Human-assistant ambiguity — 助理/助手 dropped from the imperative form
  "麻烦助理查一下会议室安排",
  // Trigger with no extractable query
  "让agent查一下",
  "",
];

for (const utterance of NEGATIVE_CASES) {
  test(`no match: "${utterance}"`, () => {
    expect(matchAgentResearchAddress(utterance)).toBeNull();
  });
}

// ═══════════════════════════════════════════════════════════════════
// 2. Query extraction details
// ═══════════════════════════════════════════════════════════════════

test("extraction: query-before-trigger falls back to sentence minus trigger", () => {
  const m = matchAgentResearchAddress("关于竞品定价的情况，让agent查一下");
  expect(m).not.toBeNull();
  expect(m!.query).toBe("关于竞品定价的情况");
});

test("extraction: trailing politeness + punctuation stripped", () => {
  expect(matchAgentResearchAddress("让agent查一下特斯拉股价吧。")!.query).toBe("特斯拉股价");
  expect(matchAgentResearchAddress("ask the agent to research the metaverse market, thanks")!.query)
    .toBe("the metaverse market");
});

test("patterns are exported and all case-insensitive", () => {
  expect(AGENT_ADDRESS_PATTERNS.length).toBeGreaterThanOrEqual(5);
  for (const p of AGENT_ADDRESS_PATTERNS) expect(p.flags).toContain("i");
});

// ═══════════════════════════════════════════════════════════════════
// 3. Routing — fast lane dispatch (mocked adapter, no LLM)
// ═══════════════════════════════════════════════════════════════════

function makeAuditor(opts: { agentConnected?: boolean } = {}) {
  const context = new SharedContext();
  const events: Array<{ event: string; data: any }> = [];
  const eventBus = {
    emit: (event: string, data: any) => { events.push({ event, data }); },
    on: () => {},
    off: () => {},
  } as any;

  const classifyCalls: string[] = [];
  const automationRouter = {
    classify: (text: string) => {
      classifyCalls.push(text);
      return { layer: "computer_use", confidence: 0.3, action: "generic", params: {}, reason: "test" };
    },
    execute: async () => ({ layer: "shortcuts", success: true, result: "ok", durationMs: 1 }),
    fileIndex: { build: async () => {}, clear: () => {}, ready: false },
  } as any;

  const executeTaskCalls: string[] = [];
  const agentAdapter = {
    connected: opts.agentConnected ?? true,
    // Never resolves → no Working-Document file writes / voice callbacks in tests
    executeTask: (prompt: string) => {
      executeTaskCalls.push(prompt);
      return new Promise<string>(() => {});
    },
  };

  const auditor = new TranscriptAuditor({
    context,
    eventBus,
    automationRouter,
    computerUse: { isConfigured: false } as any,
    meetingPrepSkill: { currentBrief: null, addLiveNote: () => {} } as any,
    meetJoiner: {} as any,
    agentAdapter,
  });
  auditor.activate({ connected: false } as any);

  return { auditor, context, events, classifyCalls, executeTaskCalls };
}

test("routing: explicit zh agent address dispatches research immediately — no debounce, no LLM", async () => {
  const { auditor, context, events, classifyCalls, executeTaskCalls } = makeAuditor();
  callModelCalls.length = 0;

  context.addTranscript({ role: "user", text: "让agent查一下竞品定价", ts: Date.now() });
  await Bun.sleep(20); // let the async dispatch settle

  // Dispatched to the agent with the extracted query
  expect(executeTaskCalls.length).toBe(1);
  expect(executeTaskCalls[0]).toContain("竞品定价");

  // No Haiku debounce scheduled, regex fast lane skipped, zero LLM calls
  expect((auditor as any)._debounceTimer).toBeNull();
  expect(classifyCalls.length).toBe(0);
  expect(callModelCalls.length).toBe(0);

  // Observability events
  const names = events.map((e) => e.event);
  expect(names).toContain("auditor.fast_lane");
  expect(names).toContain("auditor.executing");
  expect(names).toContain("research.started");
  const fastLane = events.find((e) => e.event === "auditor.fast_lane")!;
  expect(fastLane.data.layer).toBe("agent");
  expect(fastLane.data.confidence).toBe(1.0);
  const executing = events.find((e) => e.event === "auditor.executing")!;
  expect(executing.data.params.query).toBe("竞品定价");

  auditor.deactivate();
});

test("routing: english agent address dispatches with extracted query", async () => {
  const { auditor, executeTaskCalls, context } = makeAuditor();

  context.addTranscript({ role: "user", text: "ask the agent to look up the latest Bun release", ts: Date.now() });
  await Bun.sleep(20);

  expect(executeTaskCalls.length).toBe(1);
  expect(executeTaskCalls[0]).toContain("the latest Bun release");

  auditor.deactivate();
});

test("routing: duplicate utterance within cooldown dispatches once (dedup ring + cooldown)", async () => {
  const { auditor, context, executeTaskCalls } = makeAuditor();

  const now = Date.now();
  context.addTranscript({ role: "user", text: "让agent查一下竞品定价", ts: now });
  await Bun.sleep(10);
  // ts offset > 500ms so SharedContext's own dedup (BUG-031) lets it through
  context.addTranscript({ role: "user", text: "让agent查一下竞品定价", ts: now + 600 });
  await Bun.sleep(10);

  expect(executeTaskCalls.length).toBe(1);

  auditor.deactivate();
});

test("routing: COOLDOWN_MS gates rapid different-query dispatches (STT chunk protection)", async () => {
  const { auditor, context, executeTaskCalls } = makeAuditor();

  context.addTranscript({ role: "user", text: "让agent查一下A股走势", ts: Date.now() });
  await Bun.sleep(10);
  context.addTranscript({ role: "user", text: "让agent查一下美股走势", ts: Date.now() });
  await Bun.sleep(10);
  expect(executeTaskCalls.length).toBe(1); // second blocked by cooldown

  // After the cooldown window, a new explicit request goes through
  (auditor as any)._lastAgentFastLaneTs = Date.now() - 10_000;
  context.addTranscript({ role: "user", text: "让agent查一下欧股走势", ts: Date.now() });
  await Bun.sleep(10);
  expect(executeTaskCalls.length).toBe(2);

  auditor.deactivate();
});

test("routing: non-agent utterance goes through the normal pipeline (regex lane + debounce)", async () => {
  const { auditor, context, classifyCalls, executeTaskCalls } = makeAuditor();

  context.addTranscript({ role: "user", text: "帮我查一下天气", ts: Date.now() });
  await Bun.sleep(10);

  expect(executeTaskCalls.length).toBe(0);        // no research dispatched
  expect(classifyCalls.length).toBe(1);           // regex fast lane still ran
  expect((auditor as any)._debounceTimer).not.toBeNull(); // Haiku audit scheduled

  auditor.deactivate(); // clears the timer — no audit ever fires in tests
});

test("routing: agent disconnected → research error events, dedup ring stays clean", async () => {
  const { auditor, context, events, executeTaskCalls } = makeAuditor({ agentConnected: false });

  context.addTranscript({ role: "user", text: "让agent查一下竞品定价", ts: Date.now() });
  await Bun.sleep(20);

  expect(executeTaskCalls.length).toBe(0);
  const completed = events.find((e) => e.event === "research.completed");
  expect(completed).toBeDefined();
  expect(completed!.data.error).toBe("No agent connected");
  // Failure must not pollute the dedup ring (a retry after reconnect must work)
  expect((auditor as any)._recentActions.length).toBe(0);

  auditor.deactivate();
});

test("routing: in-flight guard — same normalized query not re-dispatched after cooldown", async () => {
  const { auditor, context, executeTaskCalls } = makeAuditor();

  context.addTranscript({ role: "user", text: "让agent查一下竞品定价", ts: Date.now() });
  await Bun.sleep(10);
  expect(executeTaskCalls.length).toBe(1);

  // Cooldown expired + ring cleared, but research is still in flight (never resolves)
  (auditor as any)._lastAgentFastLaneTs = 0;
  (auditor as any)._recentActions = [];
  context.addTranscript({ role: "user", text: "让agent查一下竞品定价", ts: Date.now() + 600 });
  await Bun.sleep(10);

  expect(executeTaskCalls.length).toBe(1); // _activeResearch guard held

  auditor.deactivate();
});

// ── FINDING-3 regression: fast-lane consumed utterance must not be
//    re-dispatched by the NEXT utterance's Haiku audit ──
//
// Bug: tryAgentFastLane consumed "让agent查一下竞品定价" but the entry stayed
// in the 15-entry window. The next utterance's Haiku audit (whose prompt says
// to research such requests) re-dispatched it with rephrased params —
// bypassing both the byte-compare dedup ring (`research_task:{"query":…}`)
// and the _activeResearch guard (whitespace-split normalization is useless
// for Chinese).

test("routing: fast-lane consumed utterance excluded from next Haiku audit (no double dispatch)", async () => {
  const { auditor, context, events, executeTaskCalls } = makeAuditor();
  callModelCalls.length = 0;
  // Make the debounced audit fire fast and skip the post-execution cooldown
  (auditor as any).DEBOUNCE_MS = 20;
  (auditor as any).COOLDOWN_MS = 0;
  // Haiku (mocked) re-suggests the SAME request rephrased — the exact bug:
  // different bytes, same research.
  callModelResponse =
    '{"action":"research_task","params":{"query":"查一下竞品定价"},"confidence":0.95,"reasoning":"rephrased"}';

  try {
    const now = Date.now();
    context.addTranscript({ role: "user", text: "让agent查一下竞品定价", ts: now });
    await Bun.sleep(20);
    expect(executeTaskCalls.length).toBe(1); // fast lane dispatched

    // Next utterance schedules the debounced Haiku audit; the 15-entry window
    // would otherwise still contain the consumed agent-address utterance.
    context.addTranscript({ role: "user", text: "好的，我们继续聊下一个议题", ts: now + 700 });
    await Bun.sleep(200); // debounce (20ms) + audit round-trip

    // The audit ran, but its prompt no longer contains the consumed utterance
    expect(callModelCalls.length).toBe(1);
    const prompt: string = callModelCalls[0][0];
    expect(prompt).not.toContain("让agent查一下竞品定价");
    expect(prompt).toContain("好的，我们继续聊下一个议题");

    // Even though the mocked Haiku re-suggested a rephrased research_task,
    // the Chinese-aware in-flight guard blocked the duplicate dispatch.
    expect(executeTaskCalls.length).toBe(1);
    expect(events.filter((e) => e.event === "research.started").length).toBe(1);
  } finally {
    callModelResponse = DEFAULT_CALL_MODEL_RESPONSE;
    auditor.deactivate();
  }
});

test("dedup: _activeResearch guard is Chinese-aware (containment on stripped char sequence)", async () => {
  const { auditor, context, events, executeTaskCalls } = makeAuditor();

  context.addTranscript({ role: "user", text: "让agent查一下竞品定价", ts: Date.now() });
  await Bun.sleep(10);
  expect(executeTaskCalls.length).toBe(1);

  // Bypass the ring + cooldown; research is still in flight (mock never resolves).
  (auditor as any)._recentActions = [];
  (auditor as any)._lastAgentFastLaneTs = 0;
  // Rephrased superset query — whitespace-split normalization treats
  // "那个竞品定价" and "竞品定价" as two different single "words".
  context.addTranscript({ role: "user", text: "让agent查一下那个竞品定价", ts: Date.now() + 600 });
  await Bun.sleep(10);

  expect(executeTaskCalls.length).toBe(1); // containment guard held
  expect(events.filter((e) => e.event === "research.started").length).toBe(1);

  auditor.deactivate();
});

test("routing: transcript handler is not blocked by dispatch (sync return)", () => {
  const { auditor, context } = makeAuditor();

  const start = performance.now();
  context.addTranscript({ role: "user", text: "让agent查一下竞品定价", ts: Date.now() });
  const elapsed = performance.now() - start;

  // addTranscript → _onTranscript must return without awaiting the dispatch
  expect(elapsed).toBeLessThan(50);

  auditor.deactivate();
});

// ═══════════════════════════════════════════════════════════════════
// 4. classifyIntent prompt enrichment — recent actions
//
// Regression test for a bug where the "[Recent actions: …]" enrichment
// line read from a nonexistent field (`this._dedupRing`) instead of the
// actual ring buffer (`this._recentActions`), so it was always empty at
// runtime even though the Haiku prompt template supported it.
// ═══════════════════════════════════════════════════════════════════

test("classifyIntent: prompt enrichment surfaces recent actions from the dedup ring buffer", async () => {
  const { auditor } = makeAuditor();
  callModelCalls.length = 0;

  // Simulate prior fast-lane/auto-executed actions populating the ring
  // buffer, exactly as tryFastLane()/runAudit() do at runtime.
  (auditor as any)._recentActions = [
    'open_url:{"url":"https://example.com"}',
    'click:{"selector":"Next"}',
  ];

  await (auditor as any).classifyIntent([
    { role: "user", text: "open the doc", ts: Date.now() },
  ]);

  expect(callModelCalls.length).toBe(1);
  const prompt: string = callModelCalls[0][0];
  expect(prompt).toContain("[Recent actions: open_url, click]");

  auditor.deactivate();
});

test("classifyIntent: no enrichment line when the ring buffer is empty", async () => {
  const { auditor } = makeAuditor();
  callModelCalls.length = 0;

  (auditor as any)._recentActions = [];

  await (auditor as any).classifyIntent([
    { role: "user", text: "open the doc", ts: Date.now() },
  ]);

  expect(callModelCalls.length).toBe(1);
  const prompt: string = callModelCalls[0][0];
  expect(prompt).not.toContain("[Recent actions:");

  auditor.deactivate();
});
