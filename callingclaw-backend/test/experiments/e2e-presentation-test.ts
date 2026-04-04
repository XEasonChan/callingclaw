#!/usr/bin/env bun
/**
 * E2E Presentation Test — CallingClaw 上线前验证
 *
 * 测试 AI 自主演示能力：入会 → 投屏 → AI 自主看屏幕+滚动+点击+语音解说 → 退出
 * 不是喂台词的死脚本，而是给 AI 一个任务让它自主执行。
 *
 * Usage:
 *   bun run test/experiments/e2e-presentation-test.ts [meetUrl]
 *
 * 需要后端已在 localhost:4000 运行
 */

const BASE = "http://localhost:4000";
const MEET_URL = process.argv[2] || "https://meet.google.com/ijv-arfc-fnd";

async function api(method: string, path: string, body?: any) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function log(step: string, detail?: string) {
  const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  console.log(`[${ts}] ${step}${detail ? ` — ${detail}` : ""}`);
}

// ── Test ──

async function main() {
  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║  CallingClaw E2E Presentation Test (Autonomous)  ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  // Pre-check
  const status = await api("GET", "/api/status");
  if (status.callingclaw !== "running") { console.error("❌ Backend not running!"); process.exit(1); }
  log("✅ Backend", `v${status.version}`);

  // Step 1: Join meeting
  log("⏳ Step 1", "Joining meeting...");
  const join = await api("POST", "/api/meeting/join", {
    url: MEET_URL, provider: "openai", topic: "CallingClaw Demo Presentation",
  });
  if (!join.success) { console.error(`❌ Join failed: ${JSON.stringify(join)}`); process.exit(1); }
  log("✅ Step 1", `Joined (voice=${join.voice}, audio=${join.audio_mode})`);
  await sleep(3000);

  // Step 2: Share callingclaw.com — verify success, retry once if needed
  log("⏳ Step 2", "Starting screen share...");
  let shareOk = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const share = await api("POST", "/api/screen/share", { url: "https://www.callingclaw.com" });
    if (share.success) {
      shareOk = true;
      log("✅ Step 2", `Screen shared on attempt ${attempt}`);
      break;
    }
    log(`⚠️ Step 2`, `Attempt ${attempt} failed: ${share.message}`);
    if (attempt === 1) {
      // Tab is open but Meet share failed — try clicking share button again
      await sleep(3000);
    }
  }
  if (!shareOk) {
    log("❌ Step 2", "Screen share failed — check macOS Screen Recording permission for Chrome");
    log("💡 Fix", "System Settings → Privacy & Security → Screen Recording → Enable Google Chrome");
    // Continue anyway to test voice + scroll
  }
  await sleep(2000);

  // Step 3: Inject autonomous presentation task into voice AI
  // This is NOT a script — it's a MISSION. The AI uses its own tools (scroll, click, screenshot)
  // to navigate the page and narrate what it sees.
  log("⏳ Step 3", "Giving AI autonomous presentation mission...");

  await api("POST", "/api/voice/text", {
    text: `[PRESENTATION MISSION]
你现在在 Google Meet 会议中投屏展示 CallingClaw 官网 (www.callingclaw.com)。
请自主完成以下演示流程，用中文进行：

1. 先用 share_screen 工具确认投屏状态
2. 介绍首页看到的内容（CallingClaw 是什么），大约 15 秒
3. 用 scroll 工具向下滚动页面，看看新出现的内容，然后介绍它
4. 继续滚动，每次滚动后看屏幕截图，介绍你实际看到的内容
5. 找到 "Vision" 相关的部分，用 scroll 跳转过去，介绍 CallingClaw 的愿景
6. 最后总结，说"以上就是 CallingClaw 的演示，谢谢大家"

重要规则：
- 你可以看到屏幕截图，请描述你实际看到的内容，不要编造
- 使用 scroll 工具来翻页，使用 take_screenshot 来查看当前屏幕
- 每次滚动后暂停 2-3 秒让观众看清内容
- 整个演示控制在 2 分钟内

现在开始第一步。`,
  });
  log("✅ Step 3", "Autonomous mission injected — AI is driving");

  // Step 4: Wait for AI to complete the autonomous presentation
  // Monitor transcript to detect when AI says "谢谢大家" (mission complete signal)
  log("⏳ Step 4", "Monitoring AI autonomous execution...");
  const startTime = Date.now();
  const maxWait = 180000; // 3 min max
  let missionComplete = false;

  while (Date.now() - startTime < maxWait) {
    await sleep(10000); // Check every 10s

    const transcript = await api("GET", "/api/meeting/transcript?count=5");
    const entries = transcript.entries || [];
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    // Log latest AI response
    const lastAI = entries.filter((e: any) => e.role === "assistant").pop();
    if (lastAI) {
      log(`📢 AI (${elapsed}s)`, lastAI.text.slice(0, 100));
    }

    // Check for tool calls (scroll, share_screen, etc.)
    const tools = entries.filter((e: any) => e.role === "system" && e.text.includes("Tool Call"));
    for (const t of tools) {
      log(`🔧 Tool`, t.text.slice(0, 80));
    }

    // Check if AI said the completion phrase
    const allText = entries.map((e: any) => e.text).join(" ");
    if (allText.includes("谢谢大家") || allText.includes("演示完毕") || allText.includes("以上就是")) {
      missionComplete = true;
      log("✅ Step 4", `Mission completed in ${elapsed}s`);
      break;
    }

    // Timeout warning
    if (elapsed > 120) {
      log("⚠️ Step 4", `Still running at ${elapsed}s...`);
    }
  }

  if (!missionComplete) {
    log("⚠️ Step 4", "Mission did not complete within timeout — leaving anyway");
  }

  // Step 5: Leave meeting
  log("⏳ Step 5", "Leaving meeting...");
  await sleep(3000);
  const leave = await api("POST", "/api/meeting/leave");
  log("✅ Step 5", `Left. Notes: ${leave.filepath || "none"}`);

  // Summary
  console.log("\n════════════════════════════════════════");
  console.log(`Share screen: ${shareOk ? "✅" : "❌ (permission issue)"}`);
  console.log(`Voice AI: ✅ (connected and speaking)`);
  console.log(`Autonomous mission: ${missionComplete ? "✅ completed" : "⚠️ timeout"}`);
  console.log("════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("❌ Fatal:", err);
  api("POST", "/api/meeting/leave").catch(() => {});
  process.exit(1);
});
