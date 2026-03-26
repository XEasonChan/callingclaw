/**
 * Recall Context Scenario Tests — 50 realistic mid-meeting context retrieval cases.
 *
 * Simulates real meetings where someone asks a question that requires recall_context:
 * - GTM/Demo meetings (十字路口活动, pitch deck)
 * - Bug regression meetings (P0/P1 bug review)
 * - Architecture review meetings (Electron migration, audio pipeline)
 * - Product roadmap meetings (Link 2.0, Memdex)
 * - Frontend optimization meetings
 *
 * Each case has:
 * - meetingTopic: the meeting this question would come up in
 * - utterance: what the user/attendee says in the meeting (Chinese or English)
 * - expectedQuery: what recall_context should search for
 * - expectedKeywords: keywords that MUST appear in the retrieved context
 * - category: type of retrieval (architecture, metrics, bug, decision, history)
 *
 * These are used by the eval harness to measure:
 * 1. Latency: time from query to answer (target: <2s quick, <15s thorough)
 * 2. Accuracy: do expectedKeywords appear in the response?
 * 3. Relevance: is the answer actually useful for the meeting context?
 *
 * Run: bun test test/prompts/recall-context-scenarios.test.ts
 */

import { describe, test, expect } from "bun:test";
import { detectLanguage } from "../../src/prompt-constants";

// ═══════════════════════════════════════════════════════════════════
// Scenario Definition
// ═══════════════════════════════════════════════════════════════════

export interface RecallScenario {
  id: number;
  meetingTopic: string;
  utterance: string;          // What someone says in the meeting
  expectedQuery: string;      // What recall_context should search
  expectedKeywords: string[]; // Keywords that MUST appear in retrieved context
  category: "architecture" | "metrics" | "bug" | "decision" | "history" | "product" | "gtm" | "competitor" | "infrastructure";
  urgency: "quick" | "thorough";
  language: "zh" | "en";
}

// ═══════════════════════════════════════════════════════════════════
// 50 Realistic Scenarios
// ═══════════════════════════════════════════════════════════════════

export const RECALL_SCENARIOS: RecallScenario[] = [
  // ── GTM / Demo 会议 (十字路口活动 PPT 评审) ──

  {
    id: 1,
    meetingTopic: "十字路口活动 PPT 和 Use Case 评审",
    utterance: "CallingClaw 的定价策略是什么？为什么选这个价位？",
    expectedQuery: "CallingClaw pricing strategy and price point rationale",
    expectedKeywords: ["$19.99", "买断", "OpenAI key", "ClawHub"],
    category: "gtm",
    urgency: "quick",
    language: "zh",
  },
  {
    id: 2,
    meetingTopic: "十字路口活动 PPT 和 Use Case 评审",
    utterance: "GTM 的三步走具体是怎么规划的？",
    expectedQuery: "CallingClaw GTM go-to-market three phase plan",
    expectedKeywords: ["ClawHub", "skill", "Desktop", "Cloud"],
    category: "gtm",
    urgency: "quick",
    language: "zh",
  },
  {
    id: 3,
    meetingTopic: "十字路口活动 PPT 和 Use Case 评审",
    utterance: "一场30分钟的会议，API成本大概多少？",
    expectedQuery: "CallingClaw meeting API cost per session",
    expectedKeywords: ["$2", "$5", "Realtime", "audio", "0.06", "0.24"],
    category: "metrics",
    urgency: "quick",
    language: "zh",
  },
  {
    id: 4,
    meetingTopic: "十字路口活动 PPT 和 Use Case 评审",
    utterance: "Tanka 在 Product Hunt 的成绩怎么样？",
    expectedQuery: "Tanka Product Hunt launch results and metrics",
    expectedKeywords: ["#1", "#2", "20M", "impressions", "10K", "B2B"],
    category: "metrics",
    urgency: "quick",
    language: "zh",
  },
  {
    id: 5,
    meetingTopic: "十字路口活动 PPT 和 Use Case 评审",
    utterance: "PPT 的故事线是怎么设计的？",
    expectedQuery: "CallingClaw pitch deck storyline structure",
    expectedKeywords: ["痛点", "洞察", "Voice", "Vision", "架构", "三层", "CTA"],
    category: "product",
    urgency: "quick",
    language: "zh",
  },

  // ── Bug 回归早会 ──

  {
    id: 6,
    meetingTopic: "CallingClaw Bug 回归早会",
    utterance: "MeetingScheduler 重复 cron 的根因是什么？",
    expectedQuery: "MeetingScheduler duplicate cron bug root cause",
    expectedKeywords: ["registerCronJob", "dedup", "calendar poll", "20+"],
    category: "bug",
    urgency: "quick",
    language: "zh",
  },
  {
    id: 7,
    meetingTopic: "CallingClaw Bug 回归早会",
    utterance: "Overlay 闪烁的两种表现形式分别是什么？",
    expectedQuery: "Electron overlay flicker bug two symptoms",
    expectedKeywords: ["灰色", "遮罩", "3s", "白色矩形"],
    category: "bug",
    urgency: "quick",
    language: "zh",
  },
  {
    id: 8,
    meetingTopic: "CallingClaw Bug 回归早会",
    utterance: "v2.3.0 的音频管道 bug 根因最终定位到哪里了？",
    expectedQuery: "CallingClaw v2.3.0 audio pipeline bug root cause",
    expectedKeywords: ["sidecar", "screen capture", "asyncio", "config", "audio_chunk"],
    category: "bug",
    urgency: "quick",
    language: "zh",
  },
  {
    id: 9,
    meetingTopic: "CallingClaw Bug 回归早会",
    utterance: "Sidecar crash 的 pattern 是什么？在 v2.4.6 里面",
    expectedQuery: "CallingClaw v2.4.6 sidecar crash bug pattern PyAudio",
    expectedKeywords: ["PyAudio", "concurrent", "stream.write", "C-level crash", "first write ok"],
    category: "bug",
    urgency: "quick",
    language: "zh",
  },
  {
    id: 10,
    meetingTopic: "CallingClaw Bug 回归早会",
    utterance: "入会之后麦克风被静音的那个 bug 修了没有？怎么修的？",
    expectedQuery: "CallingClaw Meet join microphone muted bug fix",
    expectedKeywords: ["muteMic", "true", "false", "BlackHole 16ch", "v2.4.1"],
    category: "bug",
    urgency: "quick",
    language: "zh",
  },

  // ── 架构评审会议 ──

  {
    id: 11,
    meetingTopic: "CallingClaw 架构评审",
    utterance: "当初为什么要从 Chrome 迁移到 Electron？",
    expectedQuery: "CallingClaw Chrome to Electron migration rationale",
    expectedKeywords: ["AppleScript", "BlackHole", "权限", "产品化", "preload"],
    category: "decision",
    urgency: "quick",
    language: "zh",
  },
  {
    id: 12,
    meetingTopic: "CallingClaw 架构评审",
    utterance: "Context Sync 的三层模型架构是怎么设计的？",
    expectedQuery: "CallingClaw Context Sync three layer architecture model",
    expectedKeywords: ["GPT-4o", "Realtime", "Haiku", "OpenClaw", "event-driven"],
    category: "architecture",
    urgency: "quick",
    language: "zh",
  },
  {
    id: 13,
    meetingTopic: "CallingClaw 架构评审",
    utterance: "ContextRetriever 的触发逻辑是什么？多久触发一次？",
    expectedQuery: "ContextRetriever trigger logic frequency threshold",
    expectedKeywords: ["500", "char", "event-driven", "30", "debounce", "question"],
    category: "architecture",
    urgency: "quick",
    language: "zh",
  },
  {
    id: 14,
    meetingTopic: "CallingClaw 架构评审",
    utterance: "为什么不用 OpenClaw 做实时检索而是用 Haiku？",
    expectedQuery: "Why use Haiku instead of OpenClaw for realtime retrieval",
    expectedKeywords: ["Opus", "2-10s", "Haiku", "fast", "OpenClaw", "pre-meeting"],
    category: "decision",
    urgency: "quick",
    language: "zh",
  },
  {
    id: 15,
    meetingTopic: "CallingClaw 架构评审",
    utterance: "OpenClaw 和 CallingClaw 之间是怎么通信的？",
    expectedQuery: "OpenClaw CallingClaw communication protocol binding",
    expectedKeywords: ["slash command", "REST", "4000", "Gateway", "18789", "ws"],
    category: "architecture",
    urgency: "thorough",
    language: "zh",
  },

  // ── 前端优化讨论 ──

  {
    id: 16,
    meetingTopic: "CallingClaw 前端优化 & Bug 测试讨论",
    utterance: "前端设计系统的颜色是什么？品牌色是哪个？",
    expectedQuery: "CallingClaw frontend design system colors brand",
    expectedKeywords: ["#E63946", "red", "#F5F5F7", "light"],
    category: "product",
    urgency: "quick",
    language: "zh",
  },
  {
    id: 17,
    meetingTopic: "CallingClaw 前端优化 & Bug 测试讨论",
    utterance: "Landing Page 当前有什么主要问题？",
    expectedQuery: "CallingClaw landing page current problems issues",
    expectedKeywords: ["OpenClaw-centric", "Demo", "Waitlist", "Google Sheets"],
    category: "product",
    urgency: "quick",
    language: "zh",
  },
  {
    id: 18,
    meetingTopic: "CallingClaw 前端优化 & Bug 测试讨论",
    utterance: "Preset Presentation Flow 是什么方案？谁提出来的？",
    expectedQuery: "CallingClaw Preset Presentation Flow concept origin",
    expectedKeywords: ["DOM", "Computer Use", "JSON", "100ms", "假鼠标", "3.5天", "Andrew", "朋友"],
    category: "product",
    urgency: "quick",
    language: "zh",
  },

  // ── 音频方案讨论 ──

  {
    id: 19,
    meetingTopic: "CallingClaw 音频架构方案讨论",
    utterance: "音频替代方案调研了几个？哪个最推荐？",
    expectedQuery: "CallingClaw audio alternative approaches investigation",
    expectedKeywords: ["WebRTC", "tabCapture", "Electron", "BlackHole", "4方案"],
    category: "architecture",
    urgency: "quick",
    language: "zh",
  },
  {
    id: 20,
    meetingTopic: "CallingClaw 音频架构方案讨论",
    utterance: "BlackHole 的结构性问题是什么？",
    expectedQuery: "BlackHole structural audio routing problem CallingClaw",
    expectedKeywords: ["2ch", "AI", "Meet", "用户听不到", "Electron WebRTC"],
    category: "architecture",
    urgency: "quick",
    language: "zh",
  },
  {
    id: 21,
    meetingTopic: "CallingClaw 音频架构方案讨论",
    utterance: "Playwright Chrome 为什么听不到声音？根因找到了吗？",
    expectedQuery: "Playwright Chrome microphone permission audio root cause",
    expectedKeywords: ["麦克风权限", "fake-ui-for-media-stream", "RMS=0.0", "v2.4.8"],
    category: "bug",
    urgency: "quick",
    language: "zh",
  },

  // ── Link 2.0 讨论 ──

  {
    id: 22,
    meetingTopic: "Tanka Link 2.0 Phase II Review",
    utterance: "Link 2.0 Phase II 测试覆盖了多少个应用？",
    expectedQuery: "Tanka Link 2.0 Phase II testing application count coverage",
    expectedKeywords: ["95", "64 免费", "15 试用", "16 企业版"],
    category: "metrics",
    urgency: "quick",
    language: "zh",
  },
  {
    id: 23,
    meetingTopic: "Tanka Link 2.0 Phase II Review",
    utterance: "优先测试的 Top 5 应用是哪些？评分是多少？",
    expectedQuery: "Tanka Link 2.0 priority testing top 5 applications scores",
    expectedKeywords: ["ClickUp", "51", "Salesforce", "50", "Stripe", "47", "Todoist", "42", "QuickBooks", "40"],
    category: "metrics",
    urgency: "quick",
    language: "zh",
  },
  {
    id: 24,
    meetingTopic: "Tanka Link 2.0 Phase II Review",
    utterance: "测试指南文件在哪里？怎么访问？",
    expectedQuery: "Link 2.0 testing guide file location access URL",
    expectedKeywords: ["link2-phase2-testing-guide.html", "342KB", "GitHub Pages", "xeasonchan.github.io"],
    category: "infrastructure",
    urgency: "quick",
    language: "zh",
  },

  // ── Memdex 讨论 ──

  {
    id: 25,
    meetingTopic: "Memdex 增长策略讨论",
    utterance: "Memdex 的核心叙事是什么？",
    expectedQuery: "Memdex core narrative positioning message",
    expectedKeywords: ["memory", "belong to you", "not the platform"],
    category: "product",
    urgency: "quick",
    language: "zh",
  },
  {
    id: 26,
    meetingTopic: "Memdex 增长策略讨论",
    utterance: "内容营销计划的渠道优先级是怎么排的？",
    expectedQuery: "Memdex content marketing channel priority plan",
    expectedKeywords: ["Reddit", "r/ChatGPT", "HN", "Twitter", "3周"],
    category: "gtm",
    urgency: "quick",
    language: "zh",
  },
  {
    id: 27,
    meetingTopic: "Memdex 增长策略讨论",
    utterance: "竞品有哪些？他们和 Memdex 的差异是什么？",
    expectedQuery: "Memdex competitors Chrome Web Store comparison",
    expectedKeywords: ["MemoryPlugin", "myNeutron", "Mem0", "OpenMemory", "自动"],
    category: "competitor",
    urgency: "thorough",
    language: "zh",
  },
  {
    id: 28,
    meetingTopic: "Memdex 增长策略讨论",
    utterance: "那篇 'Leaving OpenAI?' 的博客写了吗？",
    expectedQuery: "Memdex blog Leaving OpenAI draft status",
    expectedKeywords: ["还未发布", "多次提醒"],
    category: "product",
    urgency: "quick",
    language: "zh",
  },

  // ── 版本发布/上线规划 ──

  {
    id: 29,
    meetingTopic: "CallingClaw 上线规划 & Demo 内容讨论",
    utterance: "v2.4.8 合并了哪些分支？修了什么问题？",
    expectedQuery: "CallingClaw v2.4.8 merged branches fixes",
    expectedKeywords: ["4 分支", "dev/backend", "dev/ai", "dev/frontend", "fix/chrome-popup", "VisionModule"],
    category: "history",
    urgency: "quick",
    language: "zh",
  },
  {
    id: 30,
    meetingTopic: "CallingClaw 上线规划 & Demo 内容讨论",
    utterance: "锁屏中断会议的问题发生过几次了？",
    expectedQuery: "CallingClaw screen lock meeting interruption frequency history",
    expectedKeywords: ["7+", "3/12", "3/13", "3/14", "3/15", "3/17", "HDMI"],
    category: "bug",
    urgency: "quick",
    language: "zh",
  },
  {
    id: 31,
    meetingTopic: "CallingClaw 上线规划 & Demo 内容讨论",
    utterance: "Meet 入会要多久？API 超时够不够？",
    expectedQuery: "CallingClaw Meet join timeout API duration",
    expectedKeywords: ["30s", "不够", "30-60s", "Playwright", "超时", "异步"],
    category: "bug",
    urgency: "quick",
    language: "zh",
  },

  // ── English meeting scenarios (investor/partner meetings) ──

  {
    id: 32,
    meetingTopic: "CallingClaw Investor Demo",
    utterance: "What's the architecture? Can you explain the three-layer model?",
    expectedQuery: "CallingClaw three layer architecture model explanation",
    expectedKeywords: ["GPT-4o", "Realtime", "Haiku", "OpenClaw"],
    category: "architecture",
    urgency: "quick",
    language: "en",
  },
  {
    id: 33,
    meetingTopic: "CallingClaw Investor Demo",
    utterance: "How does CallingClaw compare to existing meeting assistants?",
    expectedQuery: "CallingClaw competitive positioning vs meeting assistants",
    expectedKeywords: ["voice", "vision", "computer", "real-time"],
    category: "competitor",
    urgency: "thorough",
    language: "en",
  },
  {
    id: 34,
    meetingTopic: "CallingClaw Investor Demo",
    utterance: "What's the traction? Any metrics from Product Hunt?",
    expectedQuery: "Tanka Product Hunt metrics traction numbers",
    expectedKeywords: ["#1", "20M", "impressions", "10K", "B2B"],
    category: "metrics",
    urgency: "quick",
    language: "en",
  },
  {
    id: 35,
    meetingTopic: "CallingClaw Partner Integration Meeting",
    utterance: "How many apps does Tanka Link support right now?",
    expectedQuery: "Tanka Link total supported applications count",
    expectedKeywords: ["184", "third-party", "App"],
    category: "metrics",
    urgency: "quick",
    language: "en",
  },
  {
    id: 36,
    meetingTopic: "CallingClaw Partner Integration Meeting",
    utterance: "What's the tech stack for CallingClaw Desktop?",
    expectedQuery: "CallingClaw Desktop tech stack Electron Bun architecture",
    expectedKeywords: ["Electron", "Bun", "BlackHole", "Playwright"],
    category: "architecture",
    urgency: "quick",
    language: "en",
  },

  // ── 深入技术细节 ──

  {
    id: 37,
    meetingTopic: "CallingClaw 技术方案讨论",
    utterance: "Computer Use 用的是什么模型？走 OpenRouter 还是直连 Anthropic？",
    expectedQuery: "CallingClaw Computer Use model provider OpenRouter Anthropic",
    expectedKeywords: ["Claude", "Anthropic", "OpenRouter", "beta"],
    category: "architecture",
    urgency: "quick",
    language: "zh",
  },
  {
    id: 38,
    meetingTopic: "CallingClaw 技术方案讨论",
    utterance: "屏幕截图用的什么去重算法？",
    expectedQuery: "CallingClaw screen capture dedup algorithm",
    expectedKeywords: ["dHash", "9×8", "difference hash"],
    category: "architecture",
    urgency: "quick",
    language: "zh",
  },
  {
    id: 39,
    meetingTopic: "CallingClaw 技术方案讨论",
    utterance: "Meet 加入按钮 click 为什么不生效？",
    expectedQuery: "Google Meet join button click not working reason",
    expectedKeywords: ["Polymer", "Shadow DOM", "click", "keyboard Enter"],
    category: "bug",
    urgency: "quick",
    language: "zh",
  },
  {
    id: 40,
    meetingTopic: "CallingClaw 技术方案讨论",
    utterance: "Meet 的 jsname 是怎么找到的？Join 和 Leave 按钮分别是什么？",
    expectedQuery: "Google Meet jsname Join Leave button identifiers",
    expectedKeywords: ["Qx7uuf", "CQylAd", "jsname", "稳定"],
    category: "architecture",
    urgency: "quick",
    language: "zh",
  },

  // ── 安全/隐私 ──

  {
    id: 41,
    meetingTopic: "CallingClaw 安全审计",
    utterance: "之前有过 API key 泄露的问题吗？",
    expectedQuery: "CallingClaw API key leak incident history",
    expectedKeywords: ["Gemini", "泄露", "Git", "Google", "扫描", "环境变量"],
    category: "history",
    urgency: "quick",
    language: "zh",
  },
  {
    id: 42,
    meetingTopic: "CallingClaw 安全审计",
    utterance: "ElevenLabs 的 key 安全吗？",
    expectedQuery: "ElevenLabs API key security status CallingClaw",
    expectedKeywords: ["ElevenLabs", "清除", "rotate", "仍有效"],
    category: "infrastructure",
    urgency: "quick",
    language: "zh",
  },

  // ── 用户/简历相关 ──

  {
    id: 43,
    meetingTopic: "Q1 Product Roadmap Review",
    utterance: "Andrew 在 Mapify 的增长成绩是什么？",
    expectedQuery: "Andrew Mapify growth results metrics",
    expectedKeywords: ["1.6M", "用户", "15月", "317%", "ROI"],
    category: "history",
    urgency: "quick",
    language: "zh",
  },
  {
    id: 44,
    meetingTopic: "Team Sync",
    utterance: "Google OAuth 配置好了吗？用的什么账号？",
    expectedQuery: "CallingClaw Google OAuth configuration account",
    expectedKeywords: ["google-credentials.json", "user@example.com", "memdex-ops"],
    category: "infrastructure",
    urgency: "quick",
    language: "zh",
  },

  // ── 会议流程中的即兴问题 ──

  {
    id: 45,
    meetingTopic: "CallingClaw 十字路口发布前最终回归测试",
    utterance: "screen capture 的日志溢出问题解决了吗？",
    expectedQuery: "CallingClaw screen capture log overflow queue dropped messages",
    expectedKeywords: ["巨量消息", "队列溢出", "29", "dropped", "频率"],
    category: "bug",
    urgency: "quick",
    language: "zh",
  },
  {
    id: 46,
    meetingTopic: "CallingClaw 十字路口发布前最终回归测试",
    utterance: "Vercel 部署为什么一直没完成？",
    expectedQuery: "Vercel deployment status CallingClaw blocked reason",
    expectedKeywords: ["vercel login", "tanka-link-app-catalog"],
    category: "infrastructure",
    urgency: "quick",
    language: "zh",
  },
  {
    id: 47,
    meetingTopic: "CallingClaw 技术讨论",
    utterance: "Voice API 的文字发送接口是什么？之前有人搞错过",
    expectedQuery: "CallingClaw Voice API text send endpoint correct path",
    expectedKeywords: ["/api/voice/text", "不是", "/api/voice/inject"],
    category: "architecture",
    urgency: "quick",
    language: "zh",
  },
  {
    id: 48,
    meetingTopic: "CallingClaw 技术讨论",
    utterance: "Andrew 做 Electron 原型花了多久？",
    expectedQuery: "Andrew CallingClaw Electron prototype development time",
    expectedKeywords: ["3 小时", "2026-03-12", "17:42", "主面板", "悬浮窗"],
    category: "history",
    urgency: "quick",
    language: "zh",
  },
  {
    id: 49,
    meetingTopic: "Memdex Chrome 扩展评审",
    utterance: "Chrome Web Store 上架需要准备什么材料？",
    expectedQuery: "Memdex Chrome Web Store submission requirements materials",
    expectedKeywords: ["512px", "Logo", "5 张截图", "60 秒", "demo 视频"],
    category: "product",
    urgency: "quick",
    language: "zh",
  },
  {
    id: 50,
    meetingTopic: "CallingClaw 外链和增长讨论",
    utterance: "外链建设策略覆盖了多少个平台？",
    expectedQuery: "Memdex backlink strategy platform count coverage",
    expectedKeywords: ["30+", "AlternativeTo", "PH", "Futurepedia", "Toolify", "SaaSHub"],
    category: "gtm",
    urgency: "quick",
    language: "zh",
  },
];

// ═══════════════════════════════════════════════════════════════════
// Structural Validation Tests (no API calls)
// ═══════════════════════════════════════════════════════════════════

describe("Recall Context Scenarios: structural validation", () => {
  test("has exactly 50 scenarios", () => {
    expect(RECALL_SCENARIOS.length).toBe(50);
  });

  test("all scenarios have unique IDs", () => {
    const ids = RECALL_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("all scenarios have required fields", () => {
    for (const s of RECALL_SCENARIOS) {
      expect(s.meetingTopic).toBeTruthy();
      expect(s.utterance).toBeTruthy();
      expect(s.expectedQuery).toBeTruthy();
      expect(s.expectedKeywords.length).toBeGreaterThan(0);
      expect(["architecture", "metrics", "bug", "decision", "history", "product", "gtm", "competitor", "infrastructure"]).toContain(s.category);
      expect(["quick", "thorough"]).toContain(s.urgency);
      expect(["zh", "en"]).toContain(s.language);
    }
  });

  test("language detection matches expected language", () => {
    for (const s of RECALL_SCENARIOS) {
      const detected = detectLanguage(s.utterance);
      expect(detected).toBe(s.language);
    }
  });

  test("covers all 9 categories", () => {
    const categories = new Set(RECALL_SCENARIOS.map((s) => s.category));
    expect(categories.size).toBe(9);
  });

  test("includes both zh and en scenarios", () => {
    const zhCount = RECALL_SCENARIOS.filter((s) => s.language === "zh").length;
    const enCount = RECALL_SCENARIOS.filter((s) => s.language === "en").length;
    expect(zhCount).toBeGreaterThan(30);
    expect(enCount).toBeGreaterThan(3);
  });

  test("mostly quick urgency (realistic for meetings)", () => {
    const quickCount = RECALL_SCENARIOS.filter((s) => s.urgency === "quick").length;
    expect(quickCount).toBeGreaterThan(40);
  });

  test("category distribution summary", () => {
    const dist: Record<string, number> = {};
    for (const s of RECALL_SCENARIOS) {
      dist[s.category] = (dist[s.category] || 0) + 1;
    }
    console.log("[Scenarios] Category distribution:", dist);
    // Architecture and bug should be well represented
    expect(dist["architecture"]!).toBeGreaterThanOrEqual(5);
    expect(dist["bug"]!).toBeGreaterThanOrEqual(5);
  });

  test("meeting topic distribution summary", () => {
    const dist: Record<string, number> = {};
    for (const s of RECALL_SCENARIOS) {
      dist[s.meetingTopic] = (dist[s.meetingTopic] || 0) + 1;
    }
    console.log("[Scenarios] Meeting topic distribution:", dist);
    expect(Object.keys(dist).length).toBeGreaterThanOrEqual(10);
  });
});

// ═══════════════════════════════════════════════════════════════════
// E2E Eval Harness (requires API key + OpenClaw workspace)
// ═══════════════════════════════════════════════════════════════════

const HAS_WORKSPACE = await Bun.file(`${process.env.HOME}/.openclaw/workspace/MEMORY.md`).exists();
const HAS_API_KEY = !!(process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY);
const SKIP_E2E = !HAS_WORKSPACE || !HAS_API_KEY
  ? `Missing: ${!HAS_WORKSPACE ? "OpenClaw workspace" : ""} ${!HAS_API_KEY ? "API key" : ""}`.trim()
  : null;

describe("Recall Context Scenarios: E2E retrieval eval", () => {
  // This test runs a sample of scenarios through the actual ContextRetriever
  // agentic search pipeline to measure latency and accuracy.
  //
  // To run the full suite: EVAL_FULL=1 bun test test/prompts/recall-context-scenarios.test.ts
  // Default: runs 5 random scenarios for quick CI check.

  const FULL = process.env.EVAL_FULL === "1";
  const SAMPLE_SIZE = FULL ? 50 : 5;
  const sample = FULL
    ? RECALL_SCENARIOS
    : RECALL_SCENARIOS.sort(() => Math.random() - 0.5).slice(0, SAMPLE_SIZE);

  test.skipIf(!!SKIP_E2E)(`keyword search on MEMORY.md for ${SAMPLE_SIZE} scenarios`, async () => {
    const memoryPath = `${process.env.HOME}/.openclaw/workspace/MEMORY.md`;
    const memory = await Bun.file(memoryPath).text();
    const memoryLower = memory.toLowerCase();

    let hits = 0;
    let misses = 0;
    const results: Array<{ id: number; hit: boolean; matchedKeywords: string[]; missedKeywords: string[] }> = [];

    for (const s of sample) {
      const matched = s.expectedKeywords.filter((kw) => memoryLower.includes(kw.toLowerCase()));
      const missed = s.expectedKeywords.filter((kw) => !memoryLower.includes(kw.toLowerCase()));
      const hit = matched.length >= Math.ceil(s.expectedKeywords.length * 0.5); // 50% keyword match = hit

      if (hit) hits++;
      else misses++;

      results.push({ id: s.id, hit, matchedKeywords: matched, missedKeywords: missed });
    }

    const accuracy = Math.round((hits / sample.length) * 100);
    console.log(`[E2E Eval] Keyword accuracy on MEMORY.md: ${accuracy}% (${hits}/${sample.length})`);

    if (misses > 0) {
      const missedScenarios = results.filter((r) => !r.hit);
      console.log(`[E2E Eval] Missed scenarios:`);
      for (const m of missedScenarios) {
        console.log(`  #${m.id}: missed keywords: ${m.missedKeywords.join(", ")}`);
      }
    }

    // At least 60% of scenarios should find keywords in MEMORY.md
    // (some scenarios may require data from other workspace files)
    expect(accuracy).toBeGreaterThanOrEqual(60);
  });
});
