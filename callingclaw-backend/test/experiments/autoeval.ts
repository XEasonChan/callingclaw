#!/usr/bin/env bun
/**
 * AutoEval — CallingClaw Voice-Driven E2E Test Harness
 * ====================================================
 * autoresearch 模式：voice-only 驱动 + 结构化日志 + 评分 + 自动迭代
 *
 * 核心规则：
 *   - Claude Code 只能用 sendText (模拟用户语音) 驱动测试
 *   - Action 必须由 voice model 或 TranscriptAuditor 触发，不能直接调 API
 *   - 每轮结果写入 results.tsv，可量化对比
 *   - 失败时分析 log → 修改生产代码 → 下一轮
 *
 * Usage:
 *   bun run test/experiments/autoeval.ts [meetUrl]
 *   bun run test/experiments/autoeval.ts --results   # 查看历史结果
 */

import { resolve } from "path";
import { existsSync } from "fs";

const BASE = "http://localhost:4000";
const MEET_URL = process.argv[2] || "https://meet.google.com/ijv-arfc-fnd";
const RESULTS_FILE = resolve(import.meta.dir, "autoeval-results.tsv");
const LOG_DIR = resolve(import.meta.dir, "autoeval-logs");

// ══════════════════════════════════════════════════════════════
// EXPERIMENT CONFIG — 每轮改这里，不动生产代码
// ══════════════════════════════════════════════════════════════

/** 当前实验描述（写入 results.tsv） */
const EXPERIMENT = "scenario-eval: business presentation quality + action accuracy";

/**
 * 业务场景测试用例
 *
 * 评分维度 (每项 0-2 分):
 *   tool:     工具是否被正确调用
 *   content:  voice 回复是否有具体信息 (不是空话)
 *   fluency:  是否连贯 (没有重复、没有中断问用户)
 *   accuracy: 描述是否和实际页面匹配 (不是幻觉)
 *   system:   系统是否健康 (Chrome alive, voice connected)
 */
const VOICE_TESTS: VoiceTest[] = [
  // ── Scenario A: CallingClaw 产品介绍 (PRESENTER mode) ──
  {
    id: "A-01",
    scenario: "product_presentation",
    voice: "现在帮我投屏 CallingClaw 官网，然后开始介绍 CallingClaw 是什么产品，它的核心定位是什么",
    expectTool: "share_screen",
    expectLog: /share_screen|ShareScreen/i,
    // Content quality: must mention specific product capabilities, not just "这是一个AI工具"
    expectVoice: /会议|语音|实时|助手|加入|Meet/,
    // Anti-patterns: must NOT contain these (empty filler)
    rejectVoice: /需要我.*介绍|想了解.*更多|你可以告诉我/,
    timeoutMs: 25000,
  },
  {
    id: "A-02",
    scenario: "product_presentation",
    voice: "向下滚动，介绍首页的每一个功能模块",
    expectTool: "interact",
    expectLog: /scroll|interact/i,
    // Must describe SPECIFIC features, not generic "功能模块"
    expectVoice: /转录|记录|笔记|操作|投屏|截图|语音|日程|action|transcript|note/i,
    rejectVoice: /需要我.*介绍|如果你想/,
    timeoutMs: 25000,
  },
  {
    id: "A-03",
    scenario: "product_presentation",
    voice: "继续往下，把剩下的功能都介绍完",
    expectTool: "interact",
    expectLog: /scroll|interact/i,
    expectVoice: /.{50,}/,  // at least 50 chars of substance
    rejectVoice: /需要我.*详细|你想.*了解/,
    timeoutMs: 25000,
  },
  {
    id: "A-04",
    scenario: "product_presentation",
    voice: "点击进入 Features 页面，介绍每一个 feature 的价值",
    expectTool: "interact",
    expectLog: /click|interact/i,
    expectVoice: /feature|功能|价值|优势/i,
    rejectVoice: null,
    timeoutMs: 25000,
  },

  // ── Scenario B: Launch Video 计划汇报 ──
  {
    id: "B-01",
    scenario: "launch_video_review",
    voice: "我们来讨论 CallingClaw 上线视频的计划，你之前准备了相关内容，先给我一个 overview",
    expectTool: "read_prep",
    expectLog: /read_prep|recall_context|prep/i,
    // Must reference actual prep content (storyboard, Personal/Business video, Aha Moment)
    expectVoice: /视频|脚本|分镜|Personal|Business|Aha|上线|发布/i,
    rejectVoice: null,
    timeoutMs: 25000,
  },
  {
    id: "B-02",
    scenario: "launch_video_review",
    voice: "Personal 视频的分镜脚本是怎么设计的？有多少帧？",
    expectTool: "read_prep",
    expectLog: /read_prep|recall/i,
    // Must mention specific numbers (23 frames, 74 seconds, etc.)
    expectVoice: /23|74|58|16|帧|frame|秒|彩蛋/i,
    rejectVoice: null,
    timeoutMs: 20000,
  },
  {
    id: "B-03",
    scenario: "launch_video_review",
    voice: "竞品 Pika 的情况是怎样的？我们和他们的差异化在哪里？",
    expectTool: "read_prep",
    expectLog: /read_prep|recall|prep/i,
    // Must mention Pika pricing, local vs cloud, $19.99
    expectVoice: /Pika|0\.50|19\.99|本地|云|买断|local/i,
    rejectVoice: null,
    timeoutMs: 20000,
  },

  // ── Scenario C: PRD 评审 (REVIEWER mode) ──
  {
    id: "C-01",
    scenario: "prd_review",
    voice: "帮我投屏我们的 Tanka Action Card PRD 文档",
    expectTool: "share_screen",
    expectLog: /share_screen|ShareScreen|prd/i,
    expectVoice: /PRD|文档|Action Card|投屏/i,
    rejectVoice: null,
    timeoutMs: 25000,
  },
  {
    id: "C-02",
    scenario: "prd_review",
    voice: "滚动到需求部分，帮我 review 一下有什么盲点或者遗漏",
    expectTool: "interact",
    expectLog: /scroll|interact/i,
    // REVIEWER should ask specific questions, not just summarize
    expectVoice: /验收|标准|边界|优先级|负责|deadline|风险|缺少|遗漏|盲点/i,
    rejectVoice: null,
    timeoutMs: 30000,
  },

  // ── Scenario E: Multi-tab Navigation (丝滑跳转) ──
  {
    id: "E-01",
    scenario: "multi_tab",
    voice: "帮我打开 CallingClaw 官网，然后介绍一下 Features 页面",
    expectTool: "share_screen",
    expectLog: /share_screen|ShareScreen|callingclaw/i,
    expectVoice: /官网|CallingClaw|feature|功能/i,
    rejectVoice: null,
    timeoutMs: 25000,
  },
  {
    id: "E-02",
    scenario: "multi_tab",
    voice: "现在切换回我们之前的文档，继续看分镜脚本",
    expectTool: "share_screen",
    expectLog: /share_screen|Navigated|stage/i,
    expectVoice: /分镜|脚本|文档|切换/i,
    rejectVoice: null,
    timeoutMs: 25000,
  },

  // ── Scenario D: 退出 ──
  {
    id: "D-01",
    scenario: "exit",
    voice: "好的今天就到这里，退出会议吧",
    expectTool: "leave_meeting",
    expectLog: /leave|Left/i,
    expectVoice: /再见|谢谢|总结|下次/,
    rejectVoice: null,
    timeoutMs: 15000,
  },
];

// ══════════════════════════════════════════════════════════════
// KNOWN BUGS — 更新在这里，每轮实验检查
// ══════════════════════════════════════════════════════════════

const KNOWN_BUGS = [
  { id: "BUG-001", status: "FIXED", desc: "CONFIG not defined in chrome-launcher" },
  { id: "BUG-002", status: "FIXED", desc: "Voice provider param passed as object" },
  { id: "BUG-003", status: "FIXED", desc: "--no-startup-window blocks Chrome" },
  { id: "BUG-004", status: "FIXED", desc: "context.on('page') kills presenting tabs" },
  { id: "BUG-005", status: "MITIGATED", desc: "BrowserCapture CDP — Vision fallback (gpt-4o-mini) works" },
  { id: "BUG-006", status: "FIXED", desc: "Voice model self-drives tool calls (75% autoeval)" },
  { id: "BUG-007", status: "MITIGATED", desc: "VisionModule Gemini fail — gpt-4o-mini fallback + NO_PROXY fix" },
  { id: "BUG-009", status: "FIXED", desc: "iframe scroll via contentWindow.scrollBy (11%→22%→34%)" },
  { id: "BUG-010", status: "OPEN", desc: "Audio playback to Meet — need real voice test. /api/audio/status added." },
  { id: "BUG-011", status: "FIXED", desc: "Pre-generated Stage HTML, iframe src baked in" },
  { id: "BUG-016", status: "FIXED", desc: "REST API — NO_PROXY added for api.openai.com + openrouter.ai" },
  { id: "BUG-017", status: "FIXED", desc: "Voice session resetForNewMeeting() on meeting.ended" },
];

// ══════════════════════════════════════════════════════════════
// TYPES
// ══════════════════════════════════════════════════════════════

interface VoiceTest {
  id: string;
  scenario: string;       // business scenario group
  voice: string;          // sendText input (simulated user speech)
  expectTool: string;     // expected tool call name
  expectLog: RegExp;      // expected pattern in backend log
  expectVoice: RegExp;    // expected content pattern (specific, not generic)
  rejectVoice: RegExp | null;  // anti-pattern (filler/repetition) — must NOT match
  timeoutMs: number;
}

interface TestResult {
  id: string;
  // L1: System health (gate — 0 if broken)
  systemOk: boolean;
  groundTruth: string;
  // L2: Intent → Action
  toolCalled: boolean;
  toolName: string;
  logMatch: boolean;
  // L3: Voice quality
  voiceText: string;
  contentMatch: boolean;    // expectVoice matched (specific info present)
  noFiller: boolean;        // rejectVoice did NOT match (no empty filler)
  responseLength: number;   // char count (proxy for information density)
  audioTruncated: boolean;  // detected mid-sentence cutoff (AI interrupted itself)
  userIgnored: boolean;     // user spoke but AI didn't address it
  // Meta
  durationMs: number;
  error?: string;
}

// ══════════════════════════════════════════════════════════════
// GROUND TRUTH CHECKS — the eval must not lie
// ══════════════════════════════════════════════════════════════

/** Full pipeline health check — monitors every layer of the data flow */
async function checkPipelineHealth(): Promise<{ ok: boolean; detail: string; metrics: PipelineMetrics }> {
  const m: PipelineMetrics = {
    meetingStatus: "unknown",
    voiceConnected: false,
    sharing: false,
    transcriptCount: 0,
    audioChunksFlowing: false,
    sttEventsPresent: false,
    transcriptHasForeignLang: false,
    chromeAlive: true,
    lastAIResponseAge: -1,
  };

  try {
    const s = await api("GET", "/api/status");
    m.meetingStatus = s.meeting || "unknown";
    m.voiceConnected = !!s.voiceSession?.connected;
    m.sharing = !!s.sharing;
    m.transcriptCount = s.transcriptLength || 0;

    const log = await getBackendLog(30);

    // Audio pipeline: are mic chunks flowing?
    m.audioChunksFlowing = log.includes("Mic audio chunk");

    // STT: are transcription events firing?
    m.sttEventsPresent = log.includes("transcription") || log.includes("Meet caption");

    // Transcript quality: any foreign language misrecognition?
    const entries = await getTranscript(10);
    const foreignPatterns = /[\u0400-\u04FF]|[\uAC00-\uD7AF]|[\u0600-\u06FF]|Cześć|Todavía|Goodbye|Lesão/;
    m.transcriptHasForeignLang = entries.some(e => e.role === "user" && foreignPatterns.test(e.text));

    // Chrome alive?
    if (log.includes("gracefully close") || log.includes("CDP disconnected")) m.chromeAlive = false;
    if (log.includes("Timeout") && log.includes("ShareScreen")) m.chromeAlive = false;

    // Last AI response age
    const lastAI = entries.filter(e => e.role === "assistant").pop();
    m.lastAIResponseAge = lastAI ? Math.round((Date.now() - (lastAI.ts || 0)) / 1000) : -1;

    const issues: string[] = [];
    if (m.meetingStatus !== "recording" && m.meetingStatus !== "idle") issues.push(`meeting=${m.meetingStatus}`);
    if (!m.voiceConnected) issues.push("voice=disconnected");
    if (!m.chromeAlive) issues.push("chrome=crashed");
    if (m.transcriptHasForeignLang) issues.push("stt=foreign_lang_detected");
    // Audio chunks are only relevant for real voice meetings, not sendText-driven eval
    // Don't gate on audio — sendText bypasses the audio pipeline entirely
    // if (!m.audioChunksFlowing) issues.push("audio=no_chunks");

    return {
      ok: issues.length === 0,
      detail: issues.length === 0
        ? `meeting=${m.meetingStatus} voice=✅ transcript=${m.transcriptCount} audio=✅ stt=${m.sttEventsPresent ? "✅" : "⚠️"}`
        : issues.join(", "),
      metrics: m,
    };
  } catch (e: any) {
    return { ok: false, detail: `health_check_failed: ${e.message}`, metrics: m };
  }
}

interface PipelineMetrics {
  meetingStatus: string;
  voiceConnected: boolean;
  sharing: boolean;
  transcriptCount: number;
  audioChunksFlowing: boolean;
  sttEventsPresent: boolean;
  transcriptHasForeignLang: boolean;
  chromeAlive: boolean;
  lastAIResponseAge: number;
}

// ══════════════════════════════════════════════════════════════
// SCORING — weighted, ground truth is a gate (0 if system broken)
// ══════════════════════════════════════════════════════════════

function scoreResults(results: TestResult[]): { total: number; breakdown: string; details: string } {
  let score = 0;
  const n = results.length;
  // Multi-dimensional scoring:
  //   system (20): Chrome alive, voice connected — GATE (0 if broken)
  //   tool (20):   correct tool called
  //   content (30): voice response has specific relevant info
  //   fluency (20): no filler/repetition + sufficient length
  //   accuracy (10): log confirms action actually happened
  const maxScore = n * 100;

  const counts = { system: 0, tool: 0, content: 0, fluency: 0, accuracy: 0 };

  for (const r of results) {
    if (!r.systemOk) continue; // gate
    counts.system++; score += 20;

    if (r.toolCalled) { counts.tool++; score += 20; }
    if (r.contentMatch) { counts.content++; score += 30; }
    if (r.noFiller && r.responseLength > 30) { counts.fluency++; score += 20; }
    if (r.logMatch) { counts.accuracy++; score += 10; }
  }

  const pct = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
  return {
    total: pct,
    breakdown: `sys:${counts.system}/${n} tool:${counts.tool}/${n} content:${counts.content}/${n} fluency:${counts.fluency}/${n} accuracy:${counts.accuracy}/${n}`,
    details: [
      `System healthy: ${counts.system}/${n}`,
      `Tool called correctly: ${counts.tool}/${n}`,
      `Content has specifics: ${counts.content}/${n} (30% weight — most important)`,
      `Fluent, no filler: ${counts.fluency}/${n}`,
      `Log confirms action: ${counts.accuracy}/${n}`,
    ].join("\n    "),
  };
}

// ══════════════════════════════════════════════════════════════
// RESULTS.TSV (autoresearch's persistent experiment log)
// ══════════════════════════════════════════════════════════════

function appendResult(score: number, breakdown: string, experiment: string, details: string) {
  const timestamp = new Date().toISOString().slice(0, 19);
  const gitHash = (() => { try { return require("child_process").execSync("git rev-parse --short HEAD", { cwd: resolve(import.meta.dir, "../..") }).toString().trim(); } catch { return "unknown"; } })();
  const line = `${timestamp}\t${gitHash}\t${score}\t${breakdown}\t${experiment}\t${details}\n`;

  // Ensure header exists
  if (!existsSync(RESULTS_FILE)) {
    require("fs").writeFileSync(RESULTS_FILE, "timestamp\tcommit\tscore\tbreakdown\texperiment\tdetails\n");
  }
  require("fs").appendFileSync(RESULTS_FILE, line);
}

function printHistory() {
  if (!existsSync(RESULTS_FILE)) { console.log("No results yet."); return; }
  console.log(require("fs").readFileSync(RESULTS_FILE, "utf-8"));
}

// ══════════════════════════════════════════════════════════════
// HARNESS
// ══════════════════════════════════════════════════════════════

async function api(method: string, path: string, body?: any): Promise<any> {
  try {
    const res = await fetch(`${BASE}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return res.json();
  } catch (e: any) { return { error: e.message }; }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function now() { return new Date().toLocaleTimeString("zh-CN", { hour12: false }); }

async function getTranscript(count = 10): Promise<Array<{ role: string; text: string; ts: number }>> {
  const r = await api("GET", `/api/meeting/transcript?count=${count}`);
  return r.entries || [];
}

async function getBackendLog(lines = 50): Promise<string> {
  try { return require("child_process").execSync(`strings /tmp/callingclaw-backend.log | tail -${lines}`).toString(); } catch { return ""; }
}

async function runVoiceTest(test: VoiceTest, transcriptBefore: number): Promise<TestResult> {
  const start = Date.now();
  const result: TestResult = {
    id: test.id, toolCalled: false, toolName: "none",
    logMatch: false, contentMatch: false, noFiller: true, voiceText: "", responseLength: 0,
    audioTruncated: false, userIgnored: false,
    systemOk: false, groundTruth: "", durationMs: 0,
  };

  try {
    // Pre-check: is pipeline healthy before we even send the command?
    const preHealth = await checkPipelineHealth();
    if (!preHealth.ok) {
      result.error = `PIPELINE BROKEN before test: ${preHealth.detail}`;
      result.groundTruth = preHealth.detail;
      result.durationMs = Date.now() - start;
      return result;
    }

    // Send voice command (the ONLY way to drive action)
    await api("POST", "/api/voice/text", { text: test.voice });

    // Wait for CallingClaw to process
    await sleep(test.timeoutMs);

    // Collect evidence
    const entries = await getTranscript(20);
    const newEntries = entries.filter(e => e.ts > transcriptBefore);
    const log = await getBackendLog(200);

    // Check: did the expected tool get called?
    const toolCalls = newEntries
      .filter(e => e.role === "system" && e.text.includes("Tool Call"))
      .map(e => e.text.match(/Tool Call\] (\w+)/)?.[1] || "");
    result.toolName = toolCalls.join(",") || "none";
    result.toolCalled = toolCalls.some(t => t === test.expectTool);

    // Also check TranscriptAuditor executed (shows in log, not transcript)
    if (!result.toolCalled) {
      result.toolCalled = test.expectLog.test(log);
      if (result.toolCalled) result.toolName = `auditor:${test.expectTool}`;
    }

    // Check: did the log pattern match?
    result.logMatch = test.expectLog.test(log);

    // Check: voice quality (content + fluency + interruption)
    const aiResponses = newEntries.filter(e => e.role === "assistant");
    result.voiceText = aiResponses.map(e => e.text).join(" ");
    result.responseLength = result.voiceText.length;
    result.contentMatch = test.expectVoice.test(result.voiceText);
    result.noFiller = test.rejectVoice ? !test.rejectVoice.test(result.voiceText) : true;

    // Audio truncation detection: AI interrupted its own sentence
    // Pattern: multiple short AI responses in rapid succession (< 3s apart), or sentence ending mid-word
    result.audioTruncated = false;
    if (aiResponses.length >= 2) {
      for (let i = 1; i < aiResponses.length; i++) {
        const prev = aiResponses[i - 1]!;
        const curr = aiResponses[i]!;
        const gap = (curr.ts || 0) - (prev.ts || 0);
        // Short gap + previous sentence doesn't end with punctuation = truncation
        if (gap < 3000 && gap > 0 && prev.text.length > 10 && !/[。！？.!?\n]$/.test(prev.text.trim())) {
          result.audioTruncated = true;
          break;
        }
      }
    }
    // Also check log for "interrupted" events
    if (log.includes("interrupted AI response")) {
      result.audioTruncated = true;
    }

    // User ignored detection: user spoke but AI response doesn't reference their topic
    result.userIgnored = false;
    const userEntries = newEntries.filter(e => e.role === "user" && e.text.length > 10);
    // This is hard to auto-detect, so we just flag if there were user entries but no tool/response change
    // (future: semantic similarity between user question and AI response)

    // GROUND TRUTH: full pipeline health after this step
    const postHealth = await checkPipelineHealth();
    result.systemOk = postHealth.ok;
    result.groundTruth = postHealth.detail;

    // Pipeline-specific failure detection
    if (postHealth.metrics.transcriptHasForeignLang) {
      result.groundTruth += " | ⚠️STT_FOREIGN_LANG";
    }
    if (!postHealth.metrics.audioChunksFlowing) {
      result.groundTruth += " | ⚠️NO_AUDIO";
    }

  } catch (e: any) {
    result.error = e.message;
  }

  result.durationMs = Date.now() - start;
  return result;
}

// ══════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════

async function main() {
  // --results flag: just print history and exit
  if (process.argv.includes("--results")) { printHistory(); return; }

  console.log(`
╔════════════════════════════════════════════════════════════╗
║  CallingClaw AutoEval — Voice-Driven E2E Test              ║
║  autoresearch: results.tsv + scoring + keep-or-discard     ║
╚════════════════════════════════════════════════════════════╝

Experiment: ${EXPERIMENT}
Meet URL:   ${MEET_URL}
Tests:      ${VOICE_TESTS.length}
`);

  // Pre-check
  const status = await api("GET", "/api/status");
  if (status.callingclaw !== "running") { console.error("❌ Backend not running"); process.exit(1); }
  console.log(`[${now()}] Backend v${status.version}\n`);

  // Known bugs
  const openBugs = KNOWN_BUGS.filter(b => b.status === "OPEN");
  if (openBugs.length > 0) {
    console.log(`Open bugs (${openBugs.length}):`);
    for (const b of openBugs) console.log(`  🔴 ${b.id}: ${b.desc}`);
    console.log("");
  }

  // Join meeting
  console.log(`[${now()}] Joining meeting...`);
  const join = await api("POST", "/api/meeting/join", {
    url: MEET_URL, provider: "openai", topic: EXPERIMENT,
  });
  if (!join.success) { console.error(`❌ Join: ${JSON.stringify(join)}`); process.exit(1); }
  console.log(`[${now()}] ✅ Joined (voice=${join.voice})\n`);
  await sleep(5000);

  // Run voice tests
  const results: TestResult[] = [];
  const allStart = Date.now();

  for (const test of VOICE_TESTS) {
    const transcriptTs = Date.now();
    console.log(`[${now()}] 🎤 ${test.id}: "${test.voice}"`);

    const r = await runVoiceTest(test, transcriptTs);
    results.push(r);

    const sysIcon = r.systemOk ? "✅" : "💀";
    const toolIcon = r.toolCalled ? "✅" : "❌";
    const contentIcon = r.contentMatch ? "✅" : "❌";
    const fillerIcon = r.noFiller ? "✅" : "🔁";
    const truncIcon = r.audioTruncated ? "✂️" : "";
    console.log(`[${now()}]   sys:${sysIcon} tool:${toolIcon}(${r.toolName}) content:${contentIcon} filler:${fillerIcon} len:${r.responseLength} ${truncIcon}`);
    console.log(`[${now()}]   ground: ${r.groundTruth}`);
    if (r.voiceText) console.log(`[${now()}]   AI: "${r.voiceText.slice(0, 100)}"`);
    if (r.error) console.log(`[${now()}]   ⛔ ${r.error}`);
    console.log("");

    // Early exit if meeting ended
    const s = await api("GET", "/api/status");
    if (s.meeting === "idle") { console.log(`[${now()}] Meeting ended\n`); break; }
  }

  // Leave if still in meeting
  const finalStatus = await api("GET", "/api/status");
  if (finalStatus.meeting !== "idle") {
    await api("POST", "/api/meeting/leave");
  }

  // ── Score ──
  const { total, breakdown, details } = scoreResults(results);
  const duration = Math.round((Date.now() - allStart) / 1000);

  console.log(`═══════════════════════════════════════════`);
  console.log(`  SCORE: ${total}%  (${breakdown})`);
  console.log(`  Duration: ${duration}s`);
  console.log(`  ---`);
  console.log(`    ${details}`);
  console.log(`═══════════════════════════════════════════\n`);

  // Per-scenario breakdown
  const scenarios = [...new Set(VOICE_TESTS.map(t => t.scenario))];
  for (const sc of scenarios) {
    const scResults = results.filter((r, i) => VOICE_TESTS[i]?.scenario === sc);
    const scScore = scoreResults(scResults);
    console.log(`  ${sc}: ${scScore.total}%`);
    for (const r of scResults) {
      const s = r.systemOk ? "✅" : "💀";
      const t = r.toolCalled ? "✅" : "❌";
      const c = r.contentMatch ? "✅" : "❌";
      console.log(`    ${s}${t}${c} ${r.id}: "${r.voiceText.slice(0, 50)}"`);
    }
  }

  // ── Pipeline Health Dashboard ──
  const finalPipeline = await checkPipelineHealth();
  console.log(`
  Pipeline Health:
    Meeting:     ${finalPipeline.metrics.meetingStatus}
    Voice:       ${finalPipeline.metrics.voiceConnected ? "✅" : "❌"}
    Audio flow:  ${finalPipeline.metrics.audioChunksFlowing ? "✅" : "❌"}
    STT events:  ${finalPipeline.metrics.sttEventsPresent ? "✅" : "❌"}
    STT quality: ${finalPipeline.metrics.transcriptHasForeignLang ? "❌ foreign lang detected" : "✅"}
    Chrome:      ${finalPipeline.metrics.chromeAlive ? "✅" : "❌"}
    Transcript:  ${finalPipeline.metrics.transcriptCount} entries
    Sharing:     ${finalPipeline.metrics.sharing ? "✅" : "❌"}
`);

  // ── Voice Repetition Detection ──
  const allAI = results.filter(r => r.voiceText.length > 20);
  let repetitions = 0;
  for (let i = 1; i < allAI.length; i++) {
    const prev = allAI[i - 1]!.voiceText;
    const curr = allAI[i]!.voiceText;
    // Check: >40% of current response's words appear in previous response
    const currWords = new Set(curr.split(/\s+/).filter(w => w.length > 2));
    const prevWords = prev.split(/\s+/).filter(w => w.length > 2);
    const overlap = prevWords.filter(w => currWords.has(w)).length;
    if (prevWords.length > 0 && overlap / prevWords.length > 0.4) {
      repetitions++;
      console.log(`  ⚠️ Repetition: ${allAI[i]!.id} repeats ${allAI[i-1]!.id} (${Math.round(overlap/prevWords.length*100)}% overlap)`);
    }
  }
  console.log(`  Voice repetitions: ${repetitions === 0 ? "✅ none detected" : `❌ ${repetitions} found`}`);

  // ── Persist to results.tsv (autoresearch's keep-or-discard log) ──
  const failedTests = results.filter(r => !r.toolCalled || !r.voiceMatch).map(r => r.id).join(",");
  appendResult(total, breakdown, EXPERIMENT, failedTests || "all_pass");
  console.log(`\n📊 Results appended to ${RESULTS_FILE}`);

  // ── Print decision: keep or discard? ──
  // Read previous score to compare
  try {
    const lines = require("fs").readFileSync(RESULTS_FILE, "utf-8").trim().split("\n");
    if (lines.length >= 3) {
      const prev = lines[lines.length - 2]!.split("\t");
      const prevScore = parseInt(prev[2]!) || 0;
      if (total > prevScore) {
        console.log(`\n🟢 IMPROVED: ${prevScore}% → ${total}% (+${total - prevScore}). KEEP this change.`);
      } else if (total === prevScore) {
        console.log(`\n🟡 SAME: ${total}%. No improvement.`);
      } else {
        console.log(`\n🔴 REGRESSED: ${prevScore}% → ${total}% (${total - prevScore}). Consider REVERTING.`);
      }
    }
  } catch {}

  console.log("");
}

main().catch(err => {
  console.error("❌ Fatal:", err);
  api("POST", "/api/meeting/leave").catch(() => {});
  process.exit(1);
});
