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
const EXPERIMENT = "voice-only: test intent→action pipeline via sendText";

/** 语音测试用例 — 只用 sendText 驱动，action 由 CallingClaw 自己执行 */
const VOICE_TESTS: VoiceTest[] = [
  {
    id: "V-001",
    voice: "帮我投屏 CallingClaw 官网",
    expectTool: "share_screen",
    expectLog: /ShareScreen.*Opened|share_screen/i,
    expectVoice: /官网|网站|投屏|CallingClaw/,
    timeoutMs: 20000,
  },
  {
    id: "V-002",
    voice: "向下滚动页面，介绍一下你看到的功能",
    expectTool: "interact",
    expectLog: /scroll|interact/i,
    expectVoice: /功能|模块|介绍|特色/,
    timeoutMs: 20000,
  },
  {
    id: "V-003",
    voice: "再往下滚动",
    expectTool: "interact",
    expectLog: /scroll/i,
    expectVoice: /.+/,  // any response
    timeoutMs: 15000,
  },
  {
    id: "V-004",
    voice: "点击 Features 这个链接",
    expectTool: "interact",
    expectLog: /click|Features/i,
    expectVoice: /功能|Features|点击/,
    timeoutMs: 20000,
  },
  {
    id: "V-005",
    voice: "现在帮我切换投屏到 Google，搜索 manus AI 最新新闻",
    expectTool: "share_screen",
    expectLog: /ShareScreen.*google|share_screen/i,
    expectVoice: /Google|搜索|manus/,
    timeoutMs: 20000,
  },
  {
    id: "V-006",
    voice: "好的，帮我退出会议",
    expectTool: "leave_meeting",
    expectLog: /Left meeting|leave/i,
    expectVoice: /再见|退出|谢谢/,
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
  { id: "BUG-005", status: "OPEN", desc: "BrowserCapture CDP not found → no screenshots" },
  { id: "BUG-006", status: "OPEN", desc: "Voice model won't self-drive tool calls" },
  { id: "BUG-007", status: "OPEN", desc: "VisionModule Gemini/OpenRouter connection fail" },
  { id: "BUG-008", status: "OPEN", desc: "scroll target 'Vision' not found on site" },
  { id: "BUG-009", status: "OPEN", desc: "interact can't operate on Stage iframe" },
  { id: "BUG-010", status: "OPEN", desc: "Audio playback to Meet not verified" },
  { id: "BUG-011", status: "OPEN", desc: "Stage iframe resets when share_screen switches URL" },
];

// ══════════════════════════════════════════════════════════════
// TYPES
// ══════════════════════════════════════════════════════════════

interface VoiceTest {
  id: string;
  voice: string;          // sendText input (simulated user speech)
  expectTool: string;     // expected tool call name
  expectLog: RegExp;      // expected pattern in backend log
  expectVoice: RegExp;    // expected pattern in AI voice response
  timeoutMs: number;
}

interface TestResult {
  id: string;
  // Intent → Action layer
  toolCalled: boolean;    // did the expected tool get called?
  toolName: string;       // actual tool called (or "none")
  logMatch: boolean;      // did the log pattern match?
  // Voice layer
  voiceMatch: boolean;    // did the voice response match?
  voiceText: string;      // actual voice response
  // Ground truth — real system state AFTER action
  systemOk: boolean;      // is the system healthy? (Chrome alive, voice connected, meeting active)
  groundTruth: string;    // what the system actually looks like (meeting status, sharing status, etc.)
  durationMs: number;
  error?: string;
}

// ══════════════════════════════════════════════════════════════
// GROUND TRUTH CHECKS — the eval must not lie
// ══════════════════════════════════════════════════════════════

async function checkSystemHealth(): Promise<{ ok: boolean; detail: string }> {
  try {
    const s = await api("GET", "/api/status");
    const issues: string[] = [];

    // Chrome / meeting still alive?
    if (s.meeting !== "recording" && s.meeting !== "idle") issues.push(`meeting=${s.meeting}`);

    // Voice connected?
    if (!s.voiceSession?.connected) issues.push("voice=disconnected");

    // Check Chrome process still running
    const log = await getBackendLog(10);
    if (log.includes("gracefully close") || log.includes("CDP disconnected")) issues.push("chrome=crashed");
    if (log.includes("Timeout") && log.includes("ShareScreen")) issues.push("share=timeout");

    return {
      ok: issues.length === 0,
      detail: issues.length === 0 ? `meeting=${s.meeting} voice=✅ sharing=${s.sharing}` : issues.join(", "),
    };
  } catch (e: any) {
    return { ok: false, detail: `health_check_failed: ${e.message}` };
  }
}

// ══════════════════════════════════════════════════════════════
// SCORING — weighted, ground truth is a gate (0 if system broken)
// ══════════════════════════════════════════════════════════════

function scoreResults(results: TestResult[]): { total: number; breakdown: string } {
  let score = 0;
  // Ground truth is a GATE: if system broke, the step scores 0 regardless of tool/voice
  const weights = { tool: 30, voice: 30, system: 40 };
  const maxScore = results.length * 100;

  for (const r of results) {
    if (!r.systemOk) continue; // system broken = 0 points for this step
    if (r.toolCalled) score += weights.tool;
    if (r.voiceMatch) score += weights.voice;
    score += weights.system; // system healthy = base 40 points
  }

  const pct = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
  const sysOk = results.filter(r => r.systemOk).length;
  return {
    total: pct,
    breakdown: `system:${sysOk}/${results.length} tool:${results.filter(r => r.toolCalled).length}/${results.length} voice:${results.filter(r => r.voiceMatch).length}/${results.length}`,
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
    logMatch: false, voiceMatch: false, voiceText: "",
    systemOk: false, groundTruth: "", durationMs: 0,
  };

  try {
    // Pre-check: is system healthy before we even send the command?
    const preHealth = await checkSystemHealth();
    if (!preHealth.ok) {
      result.error = `SYSTEM BROKEN before test: ${preHealth.detail}`;
      result.groundTruth = preHealth.detail;
      result.durationMs = Date.now() - start;
      return result; // Don't even try — system is already down
    }

    // Send voice command (the ONLY way to drive action)
    await api("POST", "/api/voice/text", { text: test.voice });

    // Wait for CallingClaw to process
    await sleep(test.timeoutMs);

    // Collect evidence
    const entries = await getTranscript(20);
    const newEntries = entries.filter(e => e.ts > transcriptBefore);
    const log = await getBackendLog(50);

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

    // Check: did the voice response match?
    const aiResponses = newEntries.filter(e => e.role === "assistant");
    result.voiceText = aiResponses.map(e => e.text).join(" ");
    result.voiceMatch = test.expectVoice.test(result.voiceText);

    // GROUND TRUTH: is the system actually healthy after this step?
    const postHealth = await checkSystemHealth();
    result.systemOk = postHealth.ok;
    result.groundTruth = postHealth.detail;

    // Detect specific failures even if tool "succeeded"
    if (log.includes("Timeout") && log.includes("ShareScreen")) {
      result.systemOk = false;
      result.groundTruth += " | share_timeout";
    }
    if (log.includes("gracefully close") || log.includes("Chrome.*crash")) {
      result.systemOk = false;
      result.groundTruth += " | chrome_crashed";
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
    const voiceIcon = r.voiceMatch ? "✅" : "❌";
    console.log(`[${now()}]   System: ${sysIcon}  Tool: ${toolIcon} ${r.toolName}  Voice: ${voiceIcon}`);
    console.log(`[${now()}]   Ground truth: ${r.groundTruth}`);
    if (r.voiceText) console.log(`[${now()}]   AI: "${r.voiceText.slice(0, 80)}"`);
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

  // ── Score (autoresearch's val_bpb equivalent) ──
  const { total, breakdown } = scoreResults(results);
  const duration = Math.round((Date.now() - allStart) / 1000);

  // ── Print results ──
  console.log(`═══════════════════════════════════════════`);
  console.log(`  SCORE: ${total}%  (${breakdown})`);
  console.log(`  Duration: ${duration}s`);
  console.log(`═══════════════════════════════════════════\n`);

  for (const r of results) {
    const s = r.systemOk ? "✅" : "💀";
    const t = r.toolCalled ? "✅" : "❌";
    const v = r.voiceMatch ? "✅" : "❌";
    console.log(`  ${s}${t}${v} ${r.id}: ${r.toolName}  "${r.voiceText.slice(0, 40)}"  [${r.groundTruth.slice(0, 40)}]`);
  }

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
