#!/usr/bin/env bun
/**
 * E2E Model Eval — Tests through CallingClaw's REAL backend pipeline
 *
 * Unlike model-ab-eval.ts (direct API calls), this sends text via /api/voice/text
 * and checks what actually happens: tool calls, file opens, context injected back
 * to the Realtime model, and voice response quality.
 *
 * Flow per test:
 *   1. Join a meeting (or use existing voice session)
 *   2. Send text via /api/voice/text (simulates user speech post-STT)
 *   3. Wait for processing (TranscriptAuditor + ContextRetriever + tools)
 *   4. Check transcript for tool calls, file opens, context injections
 *   5. Check AI response quality (specific content, no hallucination)
 *   6. Score: tool_correct + file_found + context_quality + response_quality
 *
 * Usage:
 *   bun test/experiments/e2e-model-eval.ts                    # run all
 *   bun test/experiments/e2e-model-eval.ts --category=file    # file search only
 *   bun test/experiments/e2e-model-eval.ts --id=FS-01         # single test
 */

const BASE = "http://localhost:4000";
const WAIT_MS = 15000; // wait for full pipeline (auditor + retriever + tool + response)

// ═══════════════════════════════════════════════════════════════════
// Test cases: voice text → expected real-world outcome
// ═══════════════════════════════════════════════════════════════════

interface E2ETestCase {
  id: string;
  category: "file_search" | "browser_nav" | "context_recall" | "presentation" | "multi_step";
  voice: string; // text sent via /api/voice/text (post-STT)
  expect: {
    toolCalled?: string | string[];  // expected tool name(s) in transcript
    fileOpened?: string | string[];  // expected substring in opened file path
    urlNavigated?: string;           // expected URL navigated to
    contextInjected?: string[];      // keywords expected in [CONTEXT] injection
    aiResponseContains?: string[];   // keywords in AI voice response
    aiResponseNotContains?: string[];// hallucination check
  };
  timeoutMs?: number;
}

const TESTS: E2ETestCase[] = [
  // ── File Search: fuzzy voice → find real file → open it ──
  {
    id: "FS-E2E-01",
    category: "file_search",
    voice: "帮我打开那个视频分镜脚本的文件",
    expect: {
      toolCalled: ["search_files", "open_file"],
      fileOpened: ["storyboard", "demo-video"],
      aiResponseContains: ["打开", "分镜"],
    },
  },
  {
    id: "FS-E2E-02",
    category: "file_search",
    voice: "打开我们的 PRD，就是 phase one 那个",
    expect: {
      toolCalled: ["open_file", "share_screen"],
      fileOpened: ["prd"],
      aiResponseContains: ["PRD", "打开"],
    },
  },
  {
    id: "FS-E2E-03",
    category: "file_search",
    voice: "找一下竞品分析的文档，Pika 那个",
    expect: {
      toolCalled: ["search_files", "open_file", "recall_context"],
      fileOpened: ["competitive", "pika"],
      aiResponseContains: ["Pika", "竞品"],
    },
  },
  {
    id: "FS-E2E-04",
    category: "file_search",
    voice: "open the launch video brief document",
    expect: {
      toolCalled: ["open_file", "search_files"],
      fileOpened: ["launch-video-brief", "video"],
      aiResponseContains: ["video", "brief"],
    },
  },
  {
    id: "FS-E2E-05",
    category: "file_search",
    voice: "帮我打开 go to market 的那个文档",
    expect: {
      toolCalled: ["search_files", "open_file"],
      fileOpened: ["Go To Market", "GTM"],
      aiResponseContains: ["GTM", "market"],
    },
  },
  {
    id: "FS-E2E-06",
    category: "file_search",
    voice: "show me the architecture decisions document",
    expect: {
      toolCalled: ["open_file", "search_files"],
      fileOpened: ["ARCHITECTURE-DECISIONS"],
      aiResponseContains: ["architecture", "decision"],
    },
  },

  // ── Browser Navigation: open external sites ──
  {
    id: "BN-E2E-01",
    category: "browser_nav",
    voice: "帮我投屏 CallingClaw 官网",
    expect: {
      toolCalled: ["share_screen"],
      urlNavigated: "callingclaw.com",
      aiResponseContains: ["CallingClaw", "官网"],
    },
  },
  {
    id: "BN-E2E-02",
    category: "browser_nav",
    voice: "打开 CallingClaw 的 Features 页面",
    expect: {
      toolCalled: ["share_screen", "interact"],
      urlNavigated: "callingclaw.com",
      aiResponseContains: ["Features", "功能"],
    },
  },
  {
    id: "BN-E2E-03",
    category: "browser_nav",
    voice: "帮我投屏 Tanka Action Card PRD 文档",
    expect: {
      toolCalled: ["share_screen"],
      fileOpened: ["prd"],
      aiResponseContains: ["PRD", "Action Card"],
    },
  },

  // ── Context Recall: ask questions, check retrieved context quality ──
  {
    id: "CR-E2E-01",
    category: "context_recall",
    voice: "Personal 视频的分镜脚本有多少帧？",
    expect: {
      toolCalled: ["read_prep", "recall_context"],
      contextInjected: ["23", "帧", "frame"],
      aiResponseContains: ["23", "帧"],
      aiResponseNotContains: ["不确定", "我不知道"],
    },
  },
  {
    id: "CR-E2E-02",
    category: "context_recall",
    voice: "竞品 Pika 的定价是多少？和我们有什么差异？",
    expect: {
      toolCalled: ["read_prep", "recall_context"],
      contextInjected: ["Pika", "价格"],
      aiResponseContains: ["Pika"],
      aiResponseNotContains: ["不确定"],
    },
  },
  {
    id: "CR-E2E-03",
    category: "context_recall",
    voice: "CallingClaw 的核心定位是什么？",
    expect: {
      contextInjected: ["会议", "AI", "voice"],
      aiResponseContains: ["会议", "AI"],
    },
  },

  // ── Presentation: share + narrate ──
  {
    id: "PR-E2E-01",
    category: "presentation",
    voice: "帮我投屏 CallingClaw 官网，然后介绍一下它是什么产品",
    expect: {
      toolCalled: ["share_screen"],
      urlNavigated: "callingclaw.com",
      aiResponseContains: ["CallingClaw"],
    },
    timeoutMs: 25000,
  },
  {
    id: "PR-E2E-02",
    category: "presentation",
    voice: "向下滚动，介绍首页的功能模块",
    expect: {
      toolCalled: ["interact"],
      aiResponseContains: ["功能", "模块"],
    },
    timeoutMs: 20000,
  },

  // ── Multi-step: Browser navigation chains (open → scroll → switch → click → switch back) ──
  {
    id: "MS-E2E-01",
    category: "multi_step",
    voice: "帮我打开 Pika 的官网看看他们最新的产品功能",
    expect: {
      toolCalled: ["share_screen", "open_url"],
      urlNavigated: "pika.art",
      aiResponseContains: ["Pika"],
    },
    timeoutMs: 20000,
  },
  {
    id: "MS-E2E-02",
    category: "multi_step",
    voice: "滚动到下面看看他们的定价方案",
    expect: {
      toolCalled: ["interact"],
      aiResponseContains: ["pricing", "价格"],
    },
    timeoutMs: 20000,
  },
  {
    id: "MS-E2E-03",
    category: "multi_step",
    voice: "现在切到 X 搜一下 HeyGen Avatar V5 最近的推广",
    expect: {
      toolCalled: ["share_screen", "open_url"],
      urlNavigated: "x.com",
      aiResponseContains: ["HeyGen", "Avatar"],
    },
    timeoutMs: 25000,
  },
  {
    id: "MS-E2E-04",
    category: "multi_step",
    voice: "点击第一条搜索结果看看详情",
    expect: {
      toolCalled: ["interact", "click"],
      aiResponseContains: ["click", "打开"],
    },
    timeoutMs: 20000,
  },
  {
    id: "MS-E2E-05",
    category: "multi_step",
    voice: "切回我们的 landing page 看看 hero 部分",
    expect: {
      toolCalled: ["share_screen"],
      urlNavigated: "callingclaw.com",
      aiResponseContains: ["hero", "CallingClaw"],
    },
    timeoutMs: 20000,
  },

  // ── Multi-step: Complex file queries (STT fuzzy matching) ──
  {
    id: "MS-E2E-06",
    category: "multi_step",
    voice: "帮我找那个 pneuma 相关的 landing page",
    expect: {
      toolCalled: ["search_files", "open_file"],
      fileOpened: ["pneuma"],
      aiResponseContains: ["pneuma"],
    },
    timeoutMs: 20000,
  },
  {
    id: "MS-E2E-07",
    category: "multi_step",
    voice: "打开那个 video discussion prep 的文件，就是四月四号那个",
    expect: {
      toolCalled: ["search_files", "open_file"],
      fileOpened: ["video-discussion-prep-0404"],
      aiResponseContains: ["video", "prep"],
    },
    timeoutMs: 20000,
  },
  {
    id: "MS-E2E-08",
    category: "multi_step",
    voice: "show me the meeting summary from March 26",
    expect: {
      toolCalled: ["search_files", "open_file"],
      fileOpened: ["meeting-summary-20260326"],
      aiResponseContains: ["meeting", "summary"],
    },
    timeoutMs: 20000,
  },

  // ── Multi-step: Multi-round decision making (from video demo script) ──
  {
    id: "MS-E2E-09",
    category: "multi_step",
    voice: "我们上线之前需要确认三个点：第一 Hero 要强调 memory，第二 CTA 用 Join the waitlist，第三底部 layout bug 先上线后修。帮我记下来",
    expect: {
      aiResponseContains: ["hero", "memory", "CTA", "waitlist", "layout", "bug", "记"],
    },
    timeoutMs: 20000,
  },
  {
    id: "MS-E2E-10",
    category: "multi_step",
    voice: "现在帮我打开官网，我们逐个看看需要改的地方",
    expect: {
      toolCalled: ["share_screen"],
      urlNavigated: "callingclaw.com",
      aiResponseContains: ["CallingClaw"],
    },
    timeoutMs: 25000,
  },
];

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

async function api(method: string, path: string, body?: any): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function getTranscript(count = 30): Promise<Array<{ role: string; text: string; ts: number }>> {
  const r = await api("GET", `/api/meeting/transcript?count=${count}`);
  return r.entries || [];
}

function getBackendLog(lines = 300): string {
  try {
    return require("child_process").execSync(
      `cat /tmp/callingclaw-backend.log | LC_ALL=C grep -a "" | tail -${lines}`,
      { maxBuffer: 2 * 1024 * 1024 }
    ).toString();
  } catch { return ""; }
}

// ═══════════════════════════════════════════════════════════════════
// Scoring
// ═══════════════════════════════════════════════════════════════════

interface E2EResult {
  id: string;
  category: string;
  score: number;
  breakdown: {
    toolCorrect: boolean;
    fileFound: boolean;
    contextQuality: number; // 0-100
    responseQuality: number; // 0-100
  };
  latencyMs: number;
  toolsCalled: string[];
  aiResponse: string;
  log: string; // relevant log lines
}

async function runTest(test: E2ETestCase, transcriptBefore: number): Promise<E2EResult> {
  const start = Date.now();
  const result: E2EResult = {
    id: test.id,
    category: test.category,
    score: 0,
    breakdown: { toolCorrect: false, fileFound: false, contextQuality: 0, responseQuality: 0 },
    latencyMs: 0,
    toolsCalled: [],
    aiResponse: "",
    log: "",
  };

  // Send voice text
  await api("POST", "/api/voice/text", { text: test.voice });

  // Wait for full pipeline
  await sleep(test.timeoutMs || WAIT_MS);

  // Collect evidence
  const entries = await getTranscript(30);
  const newEntries = entries.filter(e => e.ts > transcriptBefore);
  const log = getBackendLog(500);
  result.latencyMs = Date.now() - start;

  // Extract tool calls from transcript
  const toolCalls = newEntries
    .filter(e => e.role === "system" && (e.text.includes("Tool Call") || e.text.includes("Tool Result")))
    .map(e => {
      const match = e.text.match(/Tool (?:Call|Result)\] (\w+)/);
      return match?.[1] || "";
    })
    .filter(Boolean);

  // Also check log for auditor executions
  const auditorActions = (log.match(/Auditor.*Executed: (\w+)/g) || [])
    .map(m => m.match(/Executed: (\w+)/)?.[1] || "");

  result.toolsCalled = [...new Set([...toolCalls, ...auditorActions])];

  // AI responses
  const aiResponses = newEntries.filter(e => e.role === "assistant");
  result.aiResponse = aiResponses.map(e => e.text).join(" ");

  // Relevant log lines
  result.log = log.split("\n")
    .filter(l => /open_file|share_screen|search_files|recall_context|Loaded into|Navigated|Resolved|CONTEXT|read_prep/.test(l))
    .slice(-10)
    .join("\n");

  // ── Score ──

  // Tool correctness (25 points)
  if (test.expect.toolCalled) {
    const expected = Array.isArray(test.expect.toolCalled) ? test.expect.toolCalled : [test.expect.toolCalled];
    const matched = expected.some(t => result.toolsCalled.includes(t) || log.includes(t));
    result.breakdown.toolCorrect = matched;
  } else {
    result.breakdown.toolCorrect = true; // no tool expected
  }

  // File found (25 points)
  if (test.expect.fileOpened) {
    const expected = Array.isArray(test.expect.fileOpened) ? test.expect.fileOpened : [test.expect.fileOpened];
    result.breakdown.fileFound = expected.some(f =>
      log.toLowerCase().includes(f.toLowerCase()) ||
      result.aiResponse.toLowerCase().includes(f.toLowerCase())
    );
  } else if (test.expect.urlNavigated) {
    result.breakdown.fileFound = log.includes(test.expect.urlNavigated) ||
      result.aiResponse.toLowerCase().includes(test.expect.urlNavigated.toLowerCase());
  } else {
    result.breakdown.fileFound = true;
  }

  // Context quality (25 points)
  if (test.expect.contextInjected) {
    const contextLines = newEntries.filter(e => e.role === "system" && (e.text.includes("[CONTEXT]") || e.text.includes("[Prep")));
    const contextText = contextLines.map(e => e.text).join(" ").toLowerCase();
    const matched = test.expect.contextInjected.filter(kw => contextText.includes(kw.toLowerCase()));
    result.breakdown.contextQuality = Math.round((matched.length / test.expect.contextInjected.length) * 100);
  } else {
    result.breakdown.contextQuality = 100;
  }

  // Response quality (25 points)
  let rScore = 100;
  if (test.expect.aiResponseContains) {
    const found = test.expect.aiResponseContains.filter(kw =>
      result.aiResponse.toLowerCase().includes(kw.toLowerCase())
    );
    rScore = Math.round((found.length / test.expect.aiResponseContains.length) * 100);
  }
  if (test.expect.aiResponseNotContains) {
    const bad = test.expect.aiResponseNotContains.filter(kw =>
      result.aiResponse.toLowerCase().includes(kw.toLowerCase())
    );
    if (bad.length > 0) rScore = Math.max(0, rScore - 30);
  }
  result.breakdown.responseQuality = rScore;

  // Total score
  result.score = Math.round(
    (result.breakdown.toolCorrect ? 25 : 0) +
    (result.breakdown.fileFound ? 25 : 0) +
    (result.breakdown.contextQuality * 0.25) +
    (result.breakdown.responseQuality * 0.25)
  );

  return result;
}

// ═══════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  const categoryFilter = args.find(a => a.startsWith("--category="))?.split("=")[1];
  const idFilter = args.find(a => a.startsWith("--id="))?.split("=")[1];

  let testsToRun = TESTS;
  if (categoryFilter) testsToRun = TESTS.filter(t => t.category.includes(categoryFilter));
  if (idFilter) testsToRun = TESTS.filter(t => idFilter.split(",").includes(t.id));

  // Check backend
  const status = await api("GET", "/api/status");
  if (status.callingclaw !== "running") { console.error("Backend not running"); process.exit(1); }
  if (status.realtime !== "connected") { console.error("Realtime not connected — start a voice session first"); process.exit(1); }

  // Inject prep context so read_prep tool has data (mimics meeting join flow)
  // This ensures context recall tests have access to prep materials
  try {
    await api("POST", "/api/voice/inject", {
      text: `═══ MEETING CONTEXT ═══
Topic: CallingClaw Demo 视频分镜脚本 Review
Key facts from prep:
- Personal video: 23 frames, 74 seconds total (58s main + 16s easter egg)
- 5-act structure: Aha Moment → Pain Points → Solution → Post-meeting → Easter Egg
- Pika competitor: cloud-based, $19.99/month subscription, focuses on video generation
- CallingClaw: local Mac app, $19.99 one-time purchase, real-time meeting AI
- CTA options: "Join the waitlist" vs "Request access"
USE read_prep(section) for detailed data: decisions, questions, history, all_points, scenes
═══ END MEETING CONTEXT ═══`
    });
    console.log("  ✅ Prep context injected into voice session");
  } catch { console.log("  ⚠️ Could not inject prep context (no /api/voice/inject endpoint)"); }

  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║  CallingClaw E2E Model Eval — Real Backend Pipeline           ║
╚═══════════════════════════════════════════════════════════════╝

Tests: ${testsToRun.length}
Backend: v${status.version}
Realtime: ${status.realtime}
Meeting: ${status.meeting}
`);

  const results: E2EResult[] = [];
  const allStart = Date.now();

  for (const test of testsToRun) {
    const ts = Date.now();
    process.stdout.write(`  ${test.id.padEnd(12)} "${test.voice.slice(0, 40)}..." `);

    const r = await runTest(test, ts);
    results.push(r);

    const icon = r.score >= 70 ? "✅" : r.score >= 40 ? "⚠️" : "❌";
    console.log(`${icon} ${r.score}/100 (tool:${r.breakdown.toolCorrect ? "✅" : "❌"} file:${r.breakdown.fileFound ? "✅" : "❌"} ctx:${r.breakdown.contextQuality}% rsp:${r.breakdown.responseQuality}%) ${r.latencyMs}ms`);
    if (r.toolsCalled.length > 0) console.log(`             tools: ${r.toolsCalled.join(", ")}`);
    if (r.aiResponse) console.log(`             AI: "${r.aiResponse.slice(0, 80)}"`);
    console.log("");
  }

  // Summary
  const duration = Math.round((Date.now() - allStart) / 1000);
  const avgScore = Math.round(results.reduce((s, r) => s + r.score, 0) / results.length);

  console.log(`════════════════════════════════════════════════`);
  console.log(`  OVERALL: ${avgScore}/100 (${results.filter(r => r.score >= 70).length}/${results.length} pass)`);
  console.log(`  Duration: ${duration}s`);
  console.log(`════════════════════════════════════════════════`);

  // By category
  const categories = [...new Set(testsToRun.map(t => t.category))];
  for (const cat of categories) {
    const catResults = results.filter(r => r.category === cat);
    const catAvg = Math.round(catResults.reduce((s, r) => s + r.score, 0) / catResults.length);
    console.log(`  ${cat.padEnd(20)} ${catAvg}/100`);
  }

  // Save results
  const outDir = require("path").resolve(__dirname, "results");
  require("fs").mkdirSync(outDir, { recursive: true });
  const outPath = `${outDir}/e2e-eval-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.json`;
  require("fs").writeFileSync(outPath, JSON.stringify({ model: status.version, results, avgScore, duration }, null, 2));
  console.log(`\nResults: ${outPath}`);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
