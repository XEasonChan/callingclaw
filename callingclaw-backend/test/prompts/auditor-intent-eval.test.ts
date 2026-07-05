/**
 * TranscriptAuditor Intent Classification Eval — tests the REAL medium-lane
 * Haiku classification (`classifyIntent`) against a labeled utterance set.
 *
 * Three intent families, matching the meeting-time routing decision:
 *   - act:      auditor should execute (open/share/click/scroll/research)
 *   - recall:   knowledge question → belongs to recall_context / ContextRetriever,
 *               auditor must NOT act (action=null or confidence < 0.6).
 *               Reuses the existing 50-scenario RECALL_SCENARIOS test set.
 *   - no_act:   discussion / opinion / acknowledgment → auditor must NOT act
 *
 * Measures per case: predicted action, confidence band (auto ≥0.85 / suggest
 * ≥0.6 / ignore), latency. Prints a confusion report.
 *
 * Key failure modes this catches:
 *   1. research_task misfire on internal-memory questions (recall → web search)
 *   2. action misfire on discussion ("我觉得要改一下设计" → click/open)
 *   3. missed actions ("打开PRD" classified as null)
 *
 * Requires OPENROUTER_API_KEY (or ANTHROPIC_API_KEY). Skipped otherwise.
 *
 * Run:  bun test test/prompts/auditor-intent-eval.test.ts
 * Full: EVAL_FULL=1 bun test test/prompts/auditor-intent-eval.test.ts  (all 50 recall scenarios)
 */

import { describe, test, expect } from "bun:test";
import { TranscriptAuditor, type AuditResult } from "../../src/modules/transcript-auditor";
import type { TranscriptEntry } from "../../src/modules/shared-context";
import { RECALL_SCENARIOS } from "./recall-scenarios";
import { CONFIG } from "../../src/config";

const HAS_API_KEY = !!(CONFIG.openrouter.apiKey || process.env.ANTHROPIC_API_KEY);
const SKIP_REASON = HAS_API_KEY ? null : "No OPENROUTER_API_KEY / ANTHROPIC_API_KEY";
const FULL = process.env.EVAL_FULL === "1";

// ── Thresholds mirrored from TranscriptAuditor tuning knobs ──
const CONFIDENCE_AUTO = 0.85;
const CONFIDENCE_SUGGEST = 0.6;

// ── Minimal-mock auditor (only what classifyIntent touches) ──

const FAKE_BRIEF = {
  topic: "CallingClaw 十字路口活动 PPT 评审",
  goal: "过一遍 pitch deck 和 use case，确定定价页话术",
  generatedAt: Date.now(),
  summary: "评审 pitch deck 结构与定价策略",
  keyPoints: ["定价 $19.99 买断", "GTM 三步走"],
  architectureDecisions: [],
  expectedQuestions: [],
  filePaths: [
    { path: "/Users/admin/docs/callingclaw-v2.5-PRD.md", description: "产品 PRD 需求文档" },
    { path: "/Users/admin/docs/pitch-deck.html", description: "十字路口活动 pitch deck" },
  ],
  browserUrls: [
    { url: "https://callingclaw.com", description: "CallingClaw 官网" },
  ],
  folderPaths: [],
  liveNotes: [],
  scenes: [],
  sttAliases: [],
};

function makeAuditor(opts: { presenting?: boolean } = {}): TranscriptAuditor {
  const noop = () => {};
  const sceneUrl = "http://localhost:4000/pitch-deck.html";
  return new TranscriptAuditor({
    context: {
      screen: opts.presenting
        ? { description: "Pitch deck page showing pricing section", url: sceneUrl }
        : { description: "", url: "" },
      currentScene: opts.presenting ? { index: 0, total: 3, url: sceneUrl, scrollTarget: "" } : null,
      browserContext: opts.presenting ? { title: "CallingClaw Pitch Deck", url: sceneUrl } : null,
      getRecentTranscript: () => [],
      on: noop, off: noop, addStageDocument: noop,
    } as any,
    eventBus: { emit: noop, on: noop, off: noop } as any,
    automationRouter: { classify: () => ({ confidence: 0 }), fileIndex: { build: async () => {}, clear: noop } } as any,
    computerUse: { isConfigured: false } as any,
    meetingPrepSkill: { currentBrief: FAKE_BRIEF, addLiveNote: noop } as any,
    meetJoiner: {} as any,
  });
}

/** Call the real private classifyIntent with a synthetic transcript window */
async function classify(auditor: TranscriptAuditor, utterance: string, priorTurns: string[] = []): Promise<{ result: AuditResult; ms: number }> {
  const now = Date.now();
  const entries: TranscriptEntry[] = [
    ...priorTurns.map((t, i) => ({ role: "assistant" as const, text: t, ts: now - (priorTurns.length - i) * 5000 })),
    { role: "user", text: utterance, ts: now },
  ];
  const start = performance.now();
  const result = await (auditor as any).classifyIntent(entries);
  return { result, ms: Math.round(performance.now() - start) };
}

// ── Labeled eval set ──

interface EvalCase {
  utterance: string;
  expected: "act" | "no_act";
  /** For act cases: acceptable action names (families overlap, e.g. open vs share) */
  acceptActions?: string[];
  priorTurns?: string[];
  tag: string;
}

const ACTION_CASES: EvalCase[] = [
  { utterance: "帮我打开那个PRD文档", expected: "act", acceptActions: ["search_and_open", "open_file", "share_file"], tag: "open-file-zh" },
  { utterance: "把官网 share 到会议里给大家看一下", expected: "act", acceptActions: ["share_url", "share_screen", "open_url"], tag: "share-url-zh" },
  // NOTE: click/scroll with NO presenting page correctly classify as null
  // (nothing to operate on) — they are tested in PRESENTING_CASES instead.
  { utterance: "打开 https://callingclaw.com 看一下", expected: "act", acceptActions: ["open_url", "share_url"], tag: "open-url" },
  { utterance: "共享一下屏幕吧", expected: "act", acceptActions: ["share_screen"], tag: "share-screen-zh" },
  { utterance: "停止共享", expected: "act", acceptActions: ["stop_sharing"], tag: "stop-sharing-zh" },
  { utterance: "Can you pull up the pitch deck?", expected: "act", acceptActions: ["search_and_open", "share_file", "open_file"], tag: "open-file-en" },
  { utterance: "search Twitter for what people are saying about CallingClaw", expected: "act", acceptActions: ["research_task"], tag: "research-en" },
  { utterance: "帮我查一下最近有什么关于 voice AI 定价的新闻", expected: "act", acceptActions: ["research_task"], tag: "research-zh" },
  {
    utterance: "好，你调出来看看",
    priorTurns: ["我可以把 pitch deck 调出来给大家过一遍"],
    expected: "act", acceptActions: ["search_and_open", "share_file", "open_file"],
    tag: "act-after-ai-cue",
  },
];

// Cases that require an active presentation (currentScene set) — click/scroll
// operate on the presenting page, so classifying them as null with no page is
// correct behavior, and acting on them WITH a page is what we assert here.
const PRESENTING_CASES: EvalCase[] = [
  { utterance: "点击那个登录按钮", expected: "act", acceptActions: ["click"], tag: "click-zh-presenting" },
  { utterance: "往下滚动一点，看看下面的内容", expected: "act", acceptActions: ["scroll"], tag: "scroll-zh-presenting" },
  { utterance: "翻到下一页看看架构图", expected: "act", acceptActions: ["scroll", "navigate", "click"], tag: "next-section-presenting" },
];

const NO_ACTION_CASES: EvalCase[] = [
  { utterance: "我觉得这个设计需要改一下，间距太挤了", expected: "no_act", tag: "opinion-design" },
  { utterance: "下次开会的时候我们再讨论一下定价", expected: "no_act", tag: "defer-discussion" },
  { utterance: "好的，没问题", priorTurns: ["需要我把定价页打开吗？"], expected: "no_act", tag: "ack-to-ai" },
  { utterance: "嗯，是的，就是这个意思", expected: "no_act", tag: "ack-plain" },
  { utterance: "这个方案挺好的，就是成本有点高，我们内部再对一下", expected: "no_act", tag: "opinion-cost" },
  { utterance: "比如之前那个 landing page，当时也是改了三版才定稿", expected: "no_act", tag: "passing-example" },
];

// Recall scenarios: knowledge questions → auditor must NOT act (they belong to
// recall_context / ContextRetriever). research_task here = misfire (web search
// for internal memory). Sample 10 by default, all 50 with EVAL_FULL=1.
const RECALL_SAMPLE_IDS = [1, 3, 6, 11, 14, 22, 27, 32, 34, 43];
const recallCases: EvalCase[] = (FULL ? RECALL_SCENARIOS : RECALL_SCENARIOS.filter((s) => RECALL_SAMPLE_IDS.includes(s.id)))
  .map((s) => ({ utterance: s.utterance, expected: "no_act" as const, tag: `recall-#${s.id}-${s.category}` }));

// ── Runner ──

interface CaseOutcome {
  tag: string;
  utterance: string;
  expected: string;
  action: string | null;
  confidence: number;
  band: "auto" | "suggest" | "ignore";
  pass: boolean;
  failMode?: string;
  ms: number;
}

function band(c: number): "auto" | "suggest" | "ignore" {
  return c >= CONFIDENCE_AUTO ? "auto" : c >= CONFIDENCE_SUGGEST ? "suggest" : "ignore";
}

function judge(c: EvalCase, r: AuditResult): { pass: boolean; failMode?: string } {
  const b = band(r.confidence);
  const acted = r.action !== null && b !== "ignore";
  if (c.expected === "act") {
    if (!acted) return { pass: false, failMode: "missed_action" };
    if (c.acceptActions && !c.acceptActions.includes(r.action!)) return { pass: false, failMode: `wrong_action:${r.action}` };
    return { pass: true };
  }
  // no_act: any auto/suggest action is a misfire; research_task the worst
  if (acted) return { pass: false, failMode: r.action === "research_task" ? "research_misfire" : `action_misfire:${r.action}` };
  return { pass: true };
}

async function runCases(cases: EvalCase[], concurrency = 5, auditorOpts: { presenting?: boolean } = {}): Promise<CaseOutcome[]> {
  const auditor = makeAuditor(auditorOpts);
  const outcomes: CaseOutcome[] = [];
  for (let i = 0; i < cases.length; i += concurrency) {
    const batch = cases.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(async (c) => {
      try {
        const { result, ms } = await classify(auditor, c.utterance, c.priorTurns);
        const verdict = judge(c, result);
        return {
          tag: c.tag, utterance: c.utterance, expected: c.expected,
          action: result.action, confidence: result.confidence, band: band(result.confidence),
          pass: verdict.pass, failMode: verdict.failMode, ms,
        };
      } catch (e: any) {
        return {
          tag: c.tag, utterance: c.utterance, expected: c.expected,
          action: null, confidence: 0, band: "ignore" as const,
          pass: false, failMode: `error:${e.message}`, ms: -1,
        };
      }
    }));
    outcomes.push(...results);
  }
  return outcomes;
}

function report(label: string, outcomes: CaseOutcome[]) {
  const passed = outcomes.filter((o) => o.pass);
  const latencies = outcomes.filter((o) => o.ms >= 0).map((o) => o.ms).sort((a, b) => a - b);
  const p = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))] ?? 0;
  console.log(`\n[IntentEval:${label}] ${passed.length}/${outcomes.length} pass | latency p50=${p(0.5)}ms p95=${p(0.95)}ms`);
  for (const o of outcomes) {
    const mark = o.pass ? "✅" : "❌";
    console.log(`  ${mark} [${o.tag}] "${o.utterance.slice(0, 40)}" → ${o.action ?? "null"} (${o.confidence.toFixed(2)}/${o.band})${o.failMode ? ` [${o.failMode}]` : ""} ${o.ms}ms`);
  }
  return passed.length / Math.max(1, outcomes.length);
}

// ── Tests ──

describe("TranscriptAuditor intent classification eval (live Haiku)", () => {
  test.skipIf(!!SKIP_REASON)("action intents are executed with the right tool", async () => {
    const outcomes = await runCases(ACTION_CASES);
    const acc = report("act", outcomes);
    expect(acc).toBeGreaterThanOrEqual(0.7);
  }, 120_000);

  test.skipIf(!!SKIP_REASON)("click/scroll act when a page is actively presenting", async () => {
    const outcomes = await runCases(PRESENTING_CASES, 5, { presenting: true });
    const acc = report("presenting", outcomes);
    expect(acc).toBeGreaterThanOrEqual(0.66);
  }, 120_000);

  test.skipIf(!!SKIP_REASON)("discussion/acknowledgment never triggers execution", async () => {
    const outcomes = await runCases(NO_ACTION_CASES);
    const acc = report("no_act", outcomes);
    // Misfires are worse than misses — hold a higher bar
    expect(acc).toBeGreaterThanOrEqual(0.8);
  }, 120_000);

  test.skipIf(!!SKIP_REASON)("recall/knowledge questions do not misfire as research or action", async () => {
    const outcomes = await runCases(recallCases);
    const acc = report("recall", outcomes);
    const researchMisfires = outcomes.filter((o) => o.failMode === "research_misfire");
    if (researchMisfires.length > 0) {
      console.log(`[IntentEval] ⚠️ research_task misfires (internal question → web search): ${researchMisfires.map((o) => o.tag).join(", ")}`);
    }
    expect(acc).toBeGreaterThanOrEqual(0.7);
  }, FULL ? 600_000 : 180_000);
});
