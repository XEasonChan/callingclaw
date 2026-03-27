/**
 * CallingClaw Demo: Present callingclaw.com with smart scrolling
 *
 * Script: join → share homepage → narrate + scroll to sections → vision page → close
 * Tests: AI narration triggers agent scroll to specific DOM sections by text content.
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
  console.log(`  🗣 ${text.substring(0, 70)}...`);
  await api("POST", "/api/voice/text", { text });
  await wait(waitMs);
}

async function scrollTo(target: string) {
  console.log(`  📜 Scrolling to: "${target}"`);
  const r = await api("POST", "/api/screen/scroll", { target });
  console.log(`     ${r.success ? "✅" : "❌"} ${r.result || r.error}`);
  await wait(2000); // Wait for smooth scroll animation
}

async function scrollDown(pixels = 500) {
  await api("POST", "/api/screen/scroll", { direction: "down", pixels });
  await wait(1500);
}

async function main() {
  console.log("╔════════════════════════════════════════════════════════╗");
  console.log("║  CallingClaw Demo: Smart Presenting with Scroll       ║");
  console.log("╚════════════════════════════════════════════════════════╝\n");

  // ── 1. Join meeting ──
  console.log("📍 Step 1: Joining meeting...");
  const join = await api("POST", "/api/meeting/join", {
    url: MEET_URL,
    instructions: "CallingClaw 产品演示 — 官网讲解 + Vision 架构",
  });
  console.log(`   ${join.status} | ${join.joinSummary || join.error}`);
  if (join.status !== "in_meeting") {
    console.error("❌ Failed to join.");
    process.exit(1);
  }
  await wait(3000);

  // ── 2. Share callingclaw.com ──
  console.log("\n📍 Step 2: Sharing callingclaw.com...");
  const share = await api("POST", "/api/screen/share", { url: "https://www.callingclaw.com" });
  console.log(`   Share: ${share.success ? "✅" : "❌"} ${share.message}`);
  await wait(5000);

  // ── 3. Hero section ──
  console.log("\n📍 Step 3: AI presents hero section...");
  await speak(
    "大家好，我来给大家介绍一下 CallingClaw。" +
    "首先看首页的 hero 区域：AI That Joins Your Meetings。" +
    "CallingClaw 的核心定位不是一个录音工具，" +
    "而是一个有自己身份、记忆和执行能力的 AI 参会者。" +
    "它带着 OpenClaw 的知识库，作为一个真正的团队成员加入你的会议。",
    12000
  );

  // ── 4. Scroll to "3 Steps" section ──
  console.log("\n📍 Step 4: Scrolling to '3 Steps' section...");
  await speak(
    "接下来让我把页面往下滚动一点，给大家看看 From Download to Meeting in 3 Steps 这个板块。" +
    "我让 agent 帮我滚到对应的位置。",
    5000
  );
  // Agent scroll: find "3 Steps" or "Download to Meeting" in the DOM
  await scrollTo("3 Steps");
  // Fallback: try alternate text
  await scrollTo("Download to Meeting");

  await speak(
    "这是我们的三步上手流程。" +
    "第一步：下载 CallingClaw Desktop 应用。" +
    "第二步：在 OpenClaw 中输入 /callingclaw，安装会议技能。" +
    "第三步：开始你的第一个 AI 会议。" +
    "整个流程不到 5 分钟就能完成，不需要配置虚拟音频驱动或者复杂的设置。",
    12000
  );

  // ── 5. Scroll to capabilities section ──
  console.log("\n📍 Step 5: Scrolling to capabilities...");
  await speak(
    "让我继续往下，给大家看看 CallingClaw 的核心能力。",
    3000
  );
  await scrollDown(600);

  await speak(
    "CallingClaw 有六大核心能力：" +
    "实时语音对话，延迟在 300 毫秒以内；" +
    "自动加入 Google Meet 和 Zoom；" +
    "实时会议笔记和 Action Items 提取；" +
    "基于 OpenClaw 的会前深度准备；" +
    "Google 日历管理和自动参会；" +
    "以及四层自动化的电脑控制能力。",
    12000
  );

  // ── 6. Scroll to architecture / tech section ──
  console.log("\n📍 Step 6: Scrolling to architecture...");
  await scrollDown(600);

  await speak(
    "技术架构方面，CallingClaw 完全本地运行，基于 Bun 后端。" +
    "音频通过 Playwright 的 addInitScript 在浏览器级别注入，" +
    "不需要 BlackHole 等虚拟音频驱动。" +
    "这意味着零安装依赖，开箱即用。",
    10000
  );

  // ── 7. Switch to Vision page ──
  console.log("\n📍 Step 7: Opening Vision page...");
  await speak(
    "接下来让我切换到我们的 Vision 页面，" +
    "给大家讲解 CallingClaw 的双系统架构。",
    4000
  );
  const visionShare = await api("POST", "/api/screen/share", {
    url: "https://www.callingclaw.com/vision.html",
  });
  console.log(`   Vision: ${visionShare.success ? "✅" : "❌"}`);
  await wait(5000);

  // ── 8. System 1 + System 2 ──
  console.log("\n📍 Step 8: AI explains dual-system architecture...");
  await speak(
    "CallingClaw 的架构分为两个系统。" +
    "System 1 是实时反应层，包括 Grok 语音 AI 和 Playwright 浏览器自动化。" +
    "在会议中，System 1 负责即时响应：听、说、投屏、点击，延迟控制在 1-2 秒内。" +
    "今天大家看到的所有操作，包括投屏和滚动页面，都是 System 1 在执行。",
    12000
  );

  await speak(
    "System 2 是 OpenClaw 深度推理层。" +
    "它负责会前准备：读取团队记忆、研究议题、生成 meeting brief。" +
    "会后负责总结、创建待办、通过 Telegram 推送给你。" +
    "两个系统协同：System 1 在会议中快速响应，System 2 在会议外深度思考。" +
    "这就是 CallingClaw 的核心愿景。",
    12000
  );

  // ── 9. Current challenges ──
  console.log("\n📍 Step 9: Discussing challenges...");
  await scrollDown(400);

  await speak(
    "当前我们面临三个主要挑战。" +
    "第一，音频转写质量：我们正在实验 SenseVoice 本地模型替代 Grok 内置 ASR，中文准确度提升预计超过 50%。" +
    "第二，会议中的自动化延迟：通过全链路 Haiku + Playwright 直接执行，已经从 15 秒降到 1.7 秒。" +
    "第三，投屏中的交互：今天演示的页面滚动和导航，就是我们刚实现的双 tab Playwright 路由。" +
    "这些都是 v2.8.0 的新能力。",
    15000
  );

  // ── 10. Stop sharing + close ──
  console.log("\n📍 Step 10: Wrapping up...");
  await api("POST", "/api/screen/stop");
  await wait(2000);

  await speak(
    "以上就是 CallingClaw 的产品演示。" +
    "总结一下：CallingClaw 是一个有会议室的 AI 助手，" +
    "不只是记录会议，而是真正参与、执行、推动会议进展。" +
    "大家有什么问题或者建议吗？我会记下来，让 OpenClaw 在会后跟进。",
    10000
  );

  console.log("\n╔════════════════════════════════════════════════════════╗");
  console.log("║  ✅ Demo complete! CallingClaw still in meeting.       ║");
  console.log("║  Press Ctrl+C or call /api/meeting/leave to exit.     ║");
  console.log("╚════════════════════════════════════════════════════════╝");

  // Keep alive
  await wait(3600000);
}

main().catch(e => { console.error("Error:", e.message); process.exit(1); });
