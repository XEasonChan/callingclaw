#!/usr/bin/env bun
/**
 * E2E Presentation Test — CallingClaw 上线前验证
 *
 * Injects a "test program" into the voice AI, then lets it execute autonomously.
 * The AI drives: share screen → scroll → narrate → click → navigate → leave.
 * We only monitor and verify — no hardcoded sendText prompts.
 *
 * Usage:
 *   bun run test/experiments/e2e-presentation-test.ts [meetUrl]
 */

const BASE = "http://localhost:4000";
const MEET_URL = process.argv[2] || "https://meet.google.com/ijv-arfc-fnd";

// ── Test Program Definition (like autoresearch's program.md) ──
// Injected into voice context as a structured autonomous mission.

const TEST_PROGRAM = `[TEST_PROGRAM — 自动执行，不要等待用户输入]

你正在进行 CallingClaw 上线前 E2E 测试。按以下步骤自主执行，每步完成后立即进入下一步。不需要等待用户说话。用中文。

## 步骤

### STEP 1: 投屏官网 (15s)
- 调用 share_screen({"url": "https://www.callingclaw.com"})
- 等投屏确认后，简单介绍："大家好，我是 CallingClaw，现在给大家展示我们的官网。"
- 描述你在屏幕上看到的首页内容

### STEP 2: 向下滚动 + 介绍功能 (30s)
- 调用 interact({"action": "scroll_down"}) 滚动页面
- 看 [PAGE] context 里的 visible content，介绍你看到的功能模块
- 再滚动一次，继续介绍新出现的内容
- 每次滚动后等 2-3 秒让观众看清

### STEP 3: 点击导航 + 介绍 Vision (20s)
- 调用 interact({"action": "click", "target": "Vision"}) 或 interact({"action": "scroll", "target": "Vision"})
- 介绍 CallingClaw 的愿景：AI 不是 copilot 而是会议参与者

### STEP 4: 打开新页面测试 (15s)
- 调用 share_screen({"url": "https://www.google.com"}) 切换到 Google
- 说："现在测试一下打开外部网页的能力"
- 描述你看到的 Google 首页

### STEP 5: 结束 (10s)
- 说："以上就是 CallingClaw 的 E2E 测试演示，所有功能验证完毕。谢谢大家。"
- 调用 leave_meeting({})

## 规则
- 使用 interact 工具进行点击和滚动（不是 scroll_page 或 click_element）
- 每一步完成后不要停顿，直接进入下一步
- 看 [PAGE] 和 [DONE] context 来了解当前页面状态
- 如果某个工具调用失败，说明情况后跳过，继续下一步
- 整个测试控制在 2 分钟内`;

// ── Helpers ──

async function api(method: string, path: string, body?: any) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function log(msg: string) {
  const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  console.log(`[${ts}] ${msg}`);
}

// ── Main ──

async function main() {
  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║  CallingClaw E2E Test (Autonomous Program Mode)  ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  // Pre-check
  const status = await api("GET", "/api/status");
  if (status.callingclaw !== "running") { console.error("❌ Backend not running!"); process.exit(1); }
  log(`✅ Backend v${status.version}`);

  // Step 1: Join meeting
  log("⏳ Joining meeting...");
  const join = await api("POST", "/api/meeting/join", {
    url: MEET_URL, provider: "openai", topic: "CallingClaw E2E Test",
  });
  if (!join.success) { console.error(`❌ Join failed: ${JSON.stringify(join)}`); process.exit(1); }
  log(`✅ Joined (voice=${join.voice}, audio=${join.audio_mode})`);
  await sleep(4000); // Let audio bridge stabilize

  // Step 2: Inject the test program
  log("⏳ Injecting test program...");
  await api("POST", "/api/voice/text", { text: TEST_PROGRAM });
  log("✅ Test program injected — AI is now driving autonomously");

  // Step 3: Monitor execution
  log("📡 Monitoring (timeout: 3min)...\n");
  const startTime = Date.now();
  const maxWait = 180000;
  let lastTranscriptLen = 0;
  const toolsSeen = new Set<string>();
  let missionComplete = false;

  while (Date.now() - startTime < maxWait) {
    await sleep(8000);

    const transcript = await api("GET", "/api/meeting/transcript?count=10");
    const entries = (transcript.entries || []) as Array<{ role: string; text: string }>;
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    // Print new entries only
    if (entries.length > lastTranscriptLen) {
      for (const e of entries.slice(Math.max(0, entries.length - 3))) {
        const icon = e.role === "assistant" ? "🗣️" : e.role === "system" ? "🔧" : "👤";
        const text = e.text.slice(0, 120);
        if (e.role === "system" && e.text.includes("Tool Call")) {
          const toolName = e.text.match(/Tool Call\] (\w+)/)?.[1] || "?";
          toolsSeen.add(toolName);
          log(`${icon} [${elapsed}s] ${toolName}(…)`);
        } else if (e.role === "assistant") {
          log(`${icon} [${elapsed}s] ${text}`);
        }
      }
      lastTranscriptLen = entries.length;
    }

    // Check completion
    const allText = entries.map(e => e.text).join(" ");
    if (allText.includes("谢谢大家") || allText.includes("验证完毕") || allText.includes("测试完成")) {
      missionComplete = true;
      log(`\n✅ Mission completed in ${elapsed}s`);
      break;
    }

    // Check if AI left the meeting
    const statusCheck = await api("GET", "/api/status");
    if (statusCheck.meeting === "idle") {
      missionComplete = true;
      log(`\n✅ AI left meeting autonomously at ${elapsed}s`);
      break;
    }
  }

  if (!missionComplete) {
    log("\n⚠️ Timeout — forcing leave");
    await api("POST", "/api/meeting/leave");
  }

  // Summary
  console.log("\n════════════════════════════════════════════════════");
  console.log(`  Duration:   ${Math.round((Date.now() - startTime) / 1000)}s`);
  console.log(`  Tools used: ${[...toolsSeen].join(", ") || "none"}`);
  console.log(`  Completed:  ${missionComplete ? "✅" : "❌ timeout"}`);
  console.log("════════════════════════════════════════════════════");

  // Verification checklist
  const checks = [
    { name: "share_screen", pass: toolsSeen.has("share_screen") },
    { name: "interact (scroll/click)", pass: toolsSeen.has("interact") },
    { name: "leave_meeting", pass: toolsSeen.has("leave_meeting") || missionComplete },
    { name: "voice narration", pass: lastTranscriptLen > 3 },
  ];
  console.log("\nVerification:");
  for (const c of checks) {
    console.log(`  ${c.pass ? "✅" : "❌"} ${c.name}`);
  }
  console.log("");
}

main().catch((err) => {
  console.error("❌ Fatal:", err);
  api("POST", "/api/meeting/leave").catch(() => {});
  process.exit(1);
});
