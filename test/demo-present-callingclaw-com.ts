/**
 * CallingClaw Demo: Present callingclaw.com in a meeting
 *
 * Script: join meeting → share homepage → narrate → scroll → click Vision → explain System 1+2 → close
 *
 * Meeting Prep:
 *   Topic: CallingClaw 产品演示 — 官网 walkthrough + Vision 架构讲解
 *   Pages: callingclaw.com (homepage) → callingclaw.com/vision.html (System 1/2)
 *
 *   Key talking points:
 *   1. Homepage: "AI That Joins Your Meetings" — 不是录音工具，是有身份的 AI 参会者
 *   2. Core capabilities: voice, vision, computer control, meeting notes, calendar
 *   3. Vision page: System 1 (实时层) = Grok voice + Playwright 自动化，300ms 延迟
 *   4. Vision page: System 2 (深度层) = OpenClaw + Opus 推理，会前准备/会后执行
 *   5. 当前挑战: 音频质量优化、投屏自动化、Haiku agent 速度
 *
 * Usage:
 *   MEET_URL=https://meet.google.com/xxx bun run test/demo-present-callingclaw-com.ts
 */

const API = "http://localhost:4000";
const MEET_URL = process.env.MEET_URL || "https://meet.google.com/ouw-dudh-ynp";

async function api(method: string, path: string, body?: any) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

function wait(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function speak(text: string, waitMs = 8000) {
  console.log(`  🗣 ${text.substring(0, 60)}...`);
  await api("POST", "/api/voice/text", { text });
  await wait(waitMs);
}

async function main() {
  console.log("╔════════════════════════════════════════════════════╗");
  console.log("║  CallingClaw Demo: Present callingclaw.com        ║");
  console.log("╚════════════════════════════════════════════════════╝\n");

  // ── 1. Join meeting ──
  console.log("📍 Step 1: Joining meeting...");
  const join = await api("POST", "/api/meeting/join", {
    url: MEET_URL,
    instructions: "CallingClaw 产品演示 — 官网 walkthrough + Vision 架构讲解。讲解 System 1 实时层和 System 2 深度推理层。",
  });
  console.log(`   ${join.status} | ${join.joinSummary || join.error}`);
  if (join.status !== "in_meeting") {
    console.error("❌ Failed to join. Exiting.");
    process.exit(1);
  }
  await wait(3000);

  // ── 2. Share callingclaw.com homepage ──
  console.log("\n📍 Step 2: Sharing callingclaw.com...");
  const share = await api("POST", "/api/screen/share", { url: "https://www.callingclaw.com" });
  console.log(`   Share: ${share.success ? "✅" : "❌"} ${share.message}`);
  await wait(5000);

  // ── 3. Narrate homepage ──
  console.log("\n📍 Step 3: AI narrating homepage...");
  await speak(
    "大家好，我是 CallingClaw 会议助手。现在给大家演示一下我们的官网。" +
    "这是 CallingClaw 的首页。核心定位是 AI That Joins Your Meetings。" +
    "它不是一个录音工具，而是一个有自己身份、记忆和执行能力的 AI 参会者。" +
    "它带着 OpenClaw 的知识库加入你的 Google Meet 会议，实时发言、做笔记、控制电脑。",
    12000
  );

  // ── 4. Scroll down on homepage ──
  console.log("\n📍 Step 4: Scrolling homepage...");
  // Scroll the presenting page
  for (let i = 0; i < 3; i++) {
    await api("POST", "/api/screen/share", {}); // keep share active
    // We don't have a direct scroll API yet, so re-share won't scroll
    // TODO: add /api/screen/scroll endpoint
    await wait(1000);
  }
  await speak(
    "CallingClaw 的核心能力包括：实时语音对话、自动加入 Google Meet、" +
    "会议笔记和 Action Items 提取、会前深度准备、日历管理、以及电脑控制。" +
    "所有这些都在一个本地运行的 Bun 后端完成，不依赖云服务。",
    10000
  );

  // ── 5. Navigate to Vision page ──
  console.log("\n📍 Step 5: Opening Vision page...");
  const visionShare = await api("POST", "/api/screen/share", {
    url: "https://www.callingclaw.com/vision.html",
  });
  console.log(`   Vision: ${visionShare.success ? "✅" : "❌"}`);
  await wait(5000);

  // ── 6. Explain System 1 + System 2 ──
  console.log("\n📍 Step 6: AI explaining System 1 & System 2...");
  await speak(
    "这是我们的 Vision 页面。CallingClaw 的架构分为两个系统。" +
    "System 1 是实时反应层，延迟在 300 毫秒以内。它包括 Grok 语音 AI、" +
    "Playwright 浏览器自动化、和 Haiku 意图分类。" +
    "用户在会议中说什么，System 1 在一秒内就能理解并执行。",
    12000
  );

  await speak(
    "System 2 是 OpenClaw 深度推理层。它负责会前准备：读取记忆、研究议题、生成 brief。" +
    "会后负责总结、创建待办、通过 Telegram 推送给用户。" +
    "它使用 Opus 模型做深度分析，可以跨多个文件和数据源进行推理。" +
    "两个系统协同工作：System 1 在会议中快速响应，System 2 在会议外深度思考。",
    15000
  );

  // ── 7. Current challenges ──
  console.log("\n📍 Step 7: AI discussing current challenges...");
  await speak(
    "当前我们面临的主要挑战有三个。" +
    "第一，音频质量：我们用 Playwright 注入音频替代了 BlackHole 虚拟驱动，" +
    "但远程音频捕获的信噪比还需要优化。" +
    "第二，投屏自动化：今天刚实现了通过 Chrome flag 自动选择 tab 进行投屏，" +
    "下一步是让 Haiku agent 能在投屏内容上直接点击操作。" +
    "第三，延迟优化：会议中全链路使用 Haiku，把响应延迟从 5 秒降到了 1.7 秒，" +
    "但还需要进一步减少 debounce 和优化文件搜索速度。",
    18000
  );

  // ── 8. Stop sharing ──
  console.log("\n📍 Step 8: Stopping screen share...");
  await api("POST", "/api/screen/stop");
  await wait(2000);

  // ── 9. Closing ──
  console.log("\n📍 Step 9: AI closing...");
  await speak(
    "官网演示到这里。CallingClaw 是一个有会议室的 AI 助手，" +
    "不只是记录会议，而是真正参与会议、执行任务。" +
    "大家有什么问题吗？",
    8000
  );

  console.log("\n╔════════════════════════════════════════════════════╗");
  console.log("║  ✅ Demo complete! CallingClaw still in meeting.   ║");
  console.log("║  Use Ctrl+C or /api/meeting/leave to exit.        ║");
  console.log("╚════════════════════════════════════════════════════╝");

  // Keep alive
  await wait(3600000);
}

main().catch(e => { console.error("Error:", e.message); process.exit(1); });
