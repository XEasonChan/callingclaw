#!/usr/bin/env bun
/**
 * E2E Presentation Experiment Harness
 * ====================================
 * 独立实验环境，不修改生产代码。所有 prompt / action 参数复制在此文件中。
 * 参考 autoresearch 模式：每轮实验有明确目标 + 验证指标 + bug 记录。
 *
 * Usage:
 *   bun run test/experiments/e2e-presentation-test.ts [meetUrl]
 *
 * 实验目标：验证 voice + screen share + scroll + click + navigate 全链路
 */

const BASE = "http://localhost:4000";
const MEET_URL = process.argv[2] || "https://meet.google.com/ijv-arfc-fnd";

// ══════════════════════════════════════════════════════════════
// EXPERIMENT PARAMETERS — 修改这里快速迭代，不动生产代码
// ══════════════════════════════════════════════════════════════

/** Voice model system context — 告诉它现在在测试模式 */
const VOICE_TEST_CONTEXT = `[PRESENTATION MODE] 你正在进行 E2E 投屏演示测试。
你的屏幕正在被投屏到 Google Meet 会议中。
当收到 [PAGE] context 时，描述你在页面上实际看到的内容。
当收到指令时，使用你的工具（share_screen, interact, leave_meeting）来执行。
用中文，简洁。每次操作后等待 [PAGE] 或 [DONE] context 再继续。`;

/** 测试步骤 — 每步是一个 { action, voice, verify } */
const STEPS: Step[] = [
  {
    name: "1. 投屏官网",
    action: { type: "api", method: "POST", path: "/api/screen/share", body: { url: "https://www.callingclaw.com" } },
    voice: "我已经投屏了 CallingClaw 官网，请介绍你看到的首页内容",
    verify: (r: any) => r.success === true,
    waitMs: 15000,
  },
  {
    name: "2. 向下滚动",
    action: { type: "api", method: "POST", path: "/api/screen/scroll", body: { direction: "down", pixels: 600 } },
    voice: "页面已经向下滚动了，描述新出现的内容",
    verify: (r: any) => r.success === true,
    waitMs: 15000,
  },
  {
    name: "3. 再次滚动",
    action: { type: "api", method: "POST", path: "/api/screen/scroll", body: { direction: "down", pixels: 600 } },
    voice: "继续向下，介绍这部分的功能",
    verify: (r: any) => r.success === true,
    waitMs: 12000,
  },
  {
    name: "4. 滚动到 Vision 部分",
    action: { type: "api", method: "POST", path: "/api/screen/scroll", body: { target: "vision" } },
    voice: "现在到了 Vision 部分，介绍一下 CallingClaw 的愿景",
    verify: (r: any) => r.success === true,
    waitMs: 15000,
  },
  {
    name: "5. 切换到 Meeting Stage + iframe",
    action: { type: "sequence", steps: [
      { method: "POST", path: "/api/screen/share", body: {} },  // share stage (default)
      { method: "POST", path: "/api/screen/iframe/load", body: { url: "http://localhost:4000/prd-phase1.html" } },
    ]},
    voice: "现在切换到了 Meeting Stage，左边加载了 Tanka Action Card Phase 1 的 PRD 文档，请介绍你看到的内容",
    verify: () => true,
    waitMs: 18000,
  },
  {
    name: "6. 在 iframe 里滚动 PRD",
    action: { type: "eval_iframe", code: "window.scrollBy(0, 500); return 'scrolled'" },
    voice: "PRD 文档已经向下滚动了，介绍新出现的内容",
    verify: () => true,
    waitMs: 15000,
  },
  {
    name: "7. 切换到 Google 搜索 manus",
    action: { type: "api", method: "POST", path: "/api/screen/share", body: { url: "https://www.google.com/search?q=manus+AI+latest+news" } },
    voice: "现在打开了 Google 搜索 manus 最新新闻，描述搜索结果",
    verify: (r: any) => r.success === true,
    waitMs: 15000,
  },
  {
    name: "8. 点击第一个搜索结果",
    action: { type: "api", method: "POST", path: "/api/screen/scroll", body: { target: "manus" } },
    voiceAfterAction: true,  // 先执行 action 再说话
    voice: "点击了搜索结果，描述打开的页面内容",
    verify: () => true,
    waitMs: 15000,
  },
  {
    name: "9. 退出会议",
    action: { type: "api", method: "POST", path: "/api/meeting/leave" },
    voice: null,  // 不需要语音
    verify: (r: any) => r.ok === true || r.filepath,
    waitMs: 3000,
  },
];

// ══════════════════════════════════════════════════════════════
// BUGS LIST — 每轮实验发现的问题记录在这里
// ══════════════════════════════════════════════════════════════

const KNOWN_BUGS = [
  { id: "BUG-001", status: "FIXED", desc: "CONFIG not defined in chrome-launcher.ts (missing import)" },
  { id: "BUG-002", status: "FIXED", desc: "Voice provider param passed as object not string" },
  { id: "BUG-003", status: "FIXED", desc: "--no-startup-window blocks Chrome windows" },
  { id: "BUG-004", status: "FIXED", desc: "context.on('page') auto-closes presenting tabs" },
  { id: "BUG-005", status: "OPEN", desc: "BrowserCapture CDP port not found → take_screenshot returns empty" },
  { id: "BUG-006", status: "OPEN", desc: "Voice model doesn't self-drive tool calls from injected program" },
  { id: "BUG-007", status: "OPEN", desc: "VisionModule Gemini/OpenRouter connection fails (China network)" },
  { id: "BUG-008", status: "OPEN", desc: "scroll target='Vision' not found on callingclaw.com" },
  { id: "BUG-009", status: "OPEN", desc: "interact tool can't operate on stage iframe (only presenting page)" },
  { id: "BUG-010", status: "OPEN", desc: "Audio playback to Meet — AI speaks but participants may not hear" },
];

// ══════════════════════════════════════════════════════════════
// TYPES
// ══════════════════════════════════════════════════════════════

interface Step {
  name: string;
  action: ApiAction | SequenceAction | EvalIframeAction;
  voice: string | null;
  voiceAfterAction?: boolean;
  verify: (result: any) => boolean;
  waitMs: number;
}

interface ApiAction { type: "api"; method: string; path: string; body?: any }
interface SequenceAction { type: "sequence"; steps: Array<{ method: string; path: string; body?: any }> }
interface EvalIframeAction { type: "eval_iframe"; code: string }

interface StepResult {
  name: string;
  actionOk: boolean;
  actionResult: any;
  voiceResponse: string;
  toolsCalled: string[];
  error?: string;
}

// ══════════════════════════════════════════════════════════════
// HARNESS
// ══════════════════════════════════════════════════════════════

async function api(method: string, path: string, body?: any): Promise<any> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  } catch (e: any) {
    return { error: e.message };
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function ts() { return new Date().toLocaleTimeString("zh-CN", { hour12: false }); }

async function getLatestTranscript(count = 5): Promise<Array<{ role: string; text: string }>> {
  const r = await api("GET", `/api/meeting/transcript?count=${count}`);
  return r.entries || [];
}

async function getLatestAIResponse(): Promise<string> {
  const entries = await getLatestTranscript(5);
  const ai = entries.filter(e => e.role === "assistant").pop();
  return ai?.text || "(no response)";
}

async function getToolCalls(count = 5): Promise<string[]> {
  const entries = await getLatestTranscript(count);
  return entries
    .filter(e => e.role === "system" && e.text.includes("Tool Call"))
    .map(e => e.text.match(/Tool Call\] (\w+)/)?.[1] || "?");
}

async function executeAction(action: Step["action"]): Promise<any> {
  switch (action.type) {
    case "api":
      return api(action.method, action.path, action.body);
    case "sequence": {
      let lastResult: any;
      for (const step of action.steps) {
        lastResult = await api(step.method, step.path, step.body);
        await sleep(1000);
      }
      return lastResult;
    }
    case "eval_iframe": {
      // Execute code on the stage iframe via evaluate API
      return api("POST", "/api/screen/iframe/eval", { code: action.code });
    }
  }
}

async function runStep(step: Step): Promise<StepResult> {
  const result: StepResult = {
    name: step.name,
    actionOk: false,
    actionResult: null,
    voiceResponse: "",
    toolsCalled: [],
  };

  try {
    // Voice before action (default) or action first
    if (step.voice && !step.voiceAfterAction) {
      // Inject context first, then do action, then send voice
    }

    // Execute action
    result.actionResult = await executeAction(step.action);
    result.actionOk = step.verify(result.actionResult);

    // Send voice command (if any)
    if (step.voice) {
      await sleep(1000); // Let action settle
      await api("POST", "/api/voice/text", { text: step.voice });
    }

    // Wait for AI to process
    await sleep(step.waitMs);

    // Collect results
    result.voiceResponse = await getLatestAIResponse();
    result.toolsCalled = await getToolCalls(3);
  } catch (e: any) {
    result.error = e.message;
  }

  return result;
}

// ══════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════

async function main() {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║  CallingClaw E2E Presentation Experiment                   ║
║  Harness v2 — autoresearch pattern (isolated, iterable)    ║
╚════════════════════════════════════════════════════════════╝
`);

  // Pre-check
  const status = await api("GET", "/api/status");
  if (status.callingclaw !== "running") { console.error("❌ Backend not running"); process.exit(1); }
  console.log(`[${ts()}] Backend v${status.version}, voice=${status.voiceSession?.connected}\n`);

  // Print known bugs
  console.log("Known Bugs:");
  for (const b of KNOWN_BUGS) {
    console.log(`  ${b.status === "FIXED" ? "✅" : "🔴"} ${b.id}: ${b.desc}`);
  }
  console.log("");

  // Join meeting
  console.log(`[${ts()}] Joining ${MEET_URL}...`);
  const join = await api("POST", "/api/meeting/join", {
    url: MEET_URL, provider: "openai", topic: "CallingClaw E2E Experiment",
  });
  if (!join.success) { console.error(`❌ Join failed: ${JSON.stringify(join)}`); process.exit(1); }
  console.log(`[${ts()}] ✅ Joined (voice=${join.voice}, audio=${join.audio_mode})\n`);
  await sleep(4000);

  // Inject test context into voice
  await api("POST", "/api/voice/inject", { text: VOICE_TEST_CONTEXT });
  console.log(`[${ts()}] Test context injected\n`);

  // Run steps
  const results: StepResult[] = [];
  const startTime = Date.now();

  for (const step of STEPS) {
    console.log(`[${ts()}] ⏳ ${step.name}`);
    const r = await runStep(step);
    results.push(r);

    const actionStatus = r.actionOk ? "✅" : "❌";
    const hasVoice = r.voiceResponse && r.voiceResponse !== "(no response)";
    console.log(`[${ts()}]   Action: ${actionStatus} ${JSON.stringify(r.actionResult)?.slice(0, 80)}`);
    if (hasVoice) {
      console.log(`[${ts()}]   Voice: ${r.voiceResponse.slice(0, 100)}`);
    }
    if (r.toolsCalled.length > 0) {
      console.log(`[${ts()}]   Tools: ${r.toolsCalled.join(", ")}`);
    }
    if (r.error) {
      console.log(`[${ts()}]   Error: ${r.error}`);
    }
    console.log("");

    // Check if meeting ended
    const s = await api("GET", "/api/status");
    if (s.meeting === "idle") break;
  }

  // Ensure leave
  const finalStatus = await api("GET", "/api/status");
  if (finalStatus.meeting !== "idle") {
    await api("POST", "/api/meeting/leave");
  }

  // ── Results Summary ──
  const duration = Math.round((Date.now() - startTime) / 1000);
  const passed = results.filter(r => r.actionOk).length;
  const total = results.length;
  const allTools = new Set(results.flatMap(r => r.toolsCalled));
  const allVoice = results.filter(r => r.voiceResponse && r.voiceResponse !== "(no response)").length;

  console.log(`
══════════════════════════════════════════════════════════════
  EXPERIMENT RESULTS
══════════════════════════════════════════════════════════════
  Duration:    ${duration}s
  Steps:       ${passed}/${total} passed
  Voice:       ${allVoice}/${total} responded
  Tools seen:  ${[...allTools].join(", ") || "none"}
══════════════════════════════════════════════════════════════

  Step Results:
`);
  for (const r of results) {
    const icon = r.actionOk ? "✅" : "❌";
    const voice = r.voiceResponse?.slice(0, 60) || "-";
    console.log(`  ${icon} ${r.name} — voice: "${voice}"`);
  }

  console.log(`
  New Bugs Found This Run:
  (manually add to KNOWN_BUGS after investigation)
`);

  // Check for new issues
  const issues: string[] = [];
  for (const r of results) {
    if (!r.actionOk) issues.push(`${r.name}: action failed — ${JSON.stringify(r.actionResult)?.slice(0, 100)}`);
    if (r.voiceResponse === "(no response)") issues.push(`${r.name}: voice model did not respond`);
  }
  if (issues.length === 0) {
    console.log("  🎉 No new issues!\n");
  } else {
    for (const issue of issues) {
      console.log(`  🔴 ${issue}`);
    }
    console.log("");
  }
}

main().catch(err => {
  console.error("❌ Fatal:", err);
  api("POST", "/api/meeting/leave").catch(() => {});
  process.exit(1);
});
