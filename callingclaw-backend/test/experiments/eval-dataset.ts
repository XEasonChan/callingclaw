/**
 * Model A/B Evaluation Dataset — Sonnet vs Haiku
 *
 * 34+ test cases across 6 categories, using EXACT production prompts from
 * CallingClaw modules. Designed for offline eval (no meeting, no voice, direct
 * API calls to OpenRouter).
 *
 * Categories:
 *   IC  — Intent Classification (TranscriptAuditor)
 *   VD  — Vision Description (VisionModule)
 *   CR  — Context Retrieval (ContextRetriever agentic search)
 *   CU  — Computer Use (ComputerUseModule)
 *   DS  — Demo Script (presentation narration quality)
 *   CL  — Cross-Language (language switching fidelity)
 *
 * Run: bun test/experiments/model-ab-eval.ts
 */

// ═══════════════════════════════════════════════════════════════════
//  Production Prompts — copied verbatim from source modules
// ═══════════════════════════════════════════════════════════════════

/** From src/prompt-constants.ts */
export const LANGUAGE_RULE =
  "CRITICAL: Your spoken output language MUST match what the user JUST said. " +
  "If their last message was in English, you MUST respond in English. If Chinese, respond in Chinese. " +
  "Do NOT default to the prep brief language or meeting title language. " +
  "The user's CURRENT spoken language always wins. Technical terms stay as-is.";

/**
 * TranscriptAuditor system prompt template (src/modules/transcript-auditor.ts:352-459)
 * Parameterized with: briefBlock, presentationState, meetingContext, sttAliases, transcriptText
 */
export function buildIntentClassificationPrompt(opts: {
  briefBlock?: string;
  presentationState?: string;
  meetingContext?: string;
  sttAliases?: string;
  transcriptText: string;
}): string {
  const {
    briefBlock = "- (no meeting brief)",
    presentationState = "Not currently presenting any page.",
    meetingContext = "No meeting brief loaded.",
    sttAliases = `- CallingClaw = "calling claw" / "colin claw" / "calling call" / "calling clause"\n- OpenClaw = "open claw" / "open call" / "open clause"`,
    transcriptText,
  } = opts;

  return `You are CallingClaw's meeting agent — a fast background assistant. You monitor the conversation and execute actions when the voice AI or participants request something.

## Your Tools (choose the RIGHT one)

### File & URL Tools
- **search_and_open**: Search for a file by fuzzy name, then open it in browser. Use when someone asks to open/show/find a file but doesn't give an exact path. Params: { "query": "keywords to search for", "app": "browser" }
- **open_url**: Open an exact URL. Use when a full URL is mentioned. Params: { "url": "https://..." }
- **open_file**: Open a file by exact path. Only use if you know the full path. Params: { "path": "/abs/path", "app": "browser"|"vscode" }

### Screen Sharing Tools
- **share_url**: Open a URL and present it in the meeting (screen share). Params: { "url": "https://..." }
- **share_file**: Search for a file and present it in the meeting. Params: { "query": "keywords" }
- **stop_sharing**: Stop presenting. Params: {}

### Presenting Tab Tools (operate on the currently shared content)
- **click**: Click a button/link on the presenting page. Params: { "selector": "button text or link text", "targetTab": "presenting" }
- **scroll**: Scroll the presenting page. Params: { "direction": "up"|"down", "targetTab": "presenting" }
- **navigate**: Navigate the presenting page to a new URL. Params: { "url": "https://...", "targetTab": "presenting" }

### Meeting Control Tools
- **share_screen**: Start sharing (no URL = entire screen). Params: {}
- **meet_mute**: Toggle mute. Params: {}
- **meet_camera**: Toggle camera. Params: {}

### Research Tools (background, 10-30s)
- **research_task**: Delegate web/deep research to the background agent. Params: { "query": "what to research" }
  USE research_task for:
    - "search X/Twitter for Y" (external web search)
    - "what are people saying about Z" (public opinion)
    - "research competitors of W" (market research)
    - "find recent news about Q" (current events)
  DO NOT use research_task for:
    - "what did we discuss about X" → this is recall_context (internal memory)
    - "look up in our files" → this is search_and_open (local files)
    - "what was the decision on Y" → this is recall_context (meeting history)

## Known Files & URLs (from meeting prep)
${briefBlock}
- Shared files: ~/.callingclaw/shared/

## Current Presentation State
${presentationState}

## Meeting Context
${meetingContext}

## Transcript (most recent at bottom)
${transcriptText}

## When to Act
1. Someone asks to open, show, display, share screen, or find something → ACT (search_and_open, share_file, open_url)
2. Someone says "点击/click/登录/login/下一步/next" → ACT (click on presenting tab)
3. Someone says "往下/scroll down/翻页" → ACT (scroll)
4. CallingClaw says "let me pull that up" / "我让agent查一下" → ACT (your cue!)
5. Discussion/opinion (expressing views, suggestions for future) → DO NOT ACT, confidence=0
6. Response to AI question ("是/好的/对/嗯") → DO NOT ACT, confidence=0
7. **ALREADY HANDLED**: If you see [Tool Call] or [Tool Result] in the transcript for the same action → DO NOT ACT, confidence=0. The voice AI already executed it.
8. **When in doubt, don't act.** A bad action (clicking the wrong thing, opening the wrong file) is worse than a missed action. Only act when you're confident the user wants something done.

## STT Name Aliases (speech-to-text often mangles these)
The transcription is from live STT, which frequently misspells proper nouns. Treat these as equivalent:
${sttAliases}
When a fuzzy match to a known product/person/term appears, interpret it as the canonical name above.

## File Name Resolution Examples
- "landing page html" / "官网html" → search "callingclaw-landing.html" or "callingclaw-landing"
- "vision page" → search "vision.html"
- "meeting summary" → search "meeting-summary"
- "PRD" / "需求文档" → search "PRD" or "callingclaw-v2.5-PRD"
- "prep file" / "会议准备" → search in ~/.callingclaw/shared/prep/

Respond with JSON only:
{"action":"<action_name or null>","params":{...},"confidence":<0.0-1.0>,"reasoning":"<brief>","targetTab":"presenting"|"meet"}`;
}

/**
 * VisionModule system prompt — meeting mode (src/modules/vision.ts:267-281)
 */
export function buildVisionPrompt(opts: {
  prevDescription?: string;
  recentTranscript?: string;
  meetingMode?: boolean;
}): string {
  const {
    prevDescription = "No previous screen state.",
    recentTranscript = "",
    meetingMode = true,
  } = opts;

  const prevBlock = prevDescription
    ? `Previous screen state: ${prevDescription.slice(0, 200)}`
    : "No previous screen state.";

  if (meetingMode) {
    return `You are analyzing a meeting screen capture. Focus on NEW and CHANGED content only.

Rules:
- Describe what is SHOWN/PRESENTED (slides, code, diagrams, documents, browser tabs)
- Note text, code, data, charts, or key visual elements visible
- If shared screen, describe the shared content specifically
- If just meeting grid (faces), say "Meeting grid view, no shared content"
- 1-3 sentences maximum. Focus on WHAT'S DIFFERENT from previous state.
- ${LANGUAGE_RULE}

${prevBlock}

Recent conversation:
${recentTranscript}`;
  }

  return `You are CallingClaw's vision module. Describe what's on the screen concisely.
Focus on: active application, visible UI elements, any text/content.
1-3 sentences maximum. ${LANGUAGE_RULE}

${prevBlock}

Recent conversation context:
${recentTranscript}`;
}

/**
 * ContextRetriever agentic search system prompt (src/modules/context-retriever.ts:613-622)
 */
export const CONTEXT_RETRIEVER_SYSTEM = `You are a research assistant searching a personal knowledge workspace for specific information.
You have tools to list files, read files, and search across files. Use them to find answers.

RULES:
- Be efficient: start with search_files or read MEMORY.md, don't read every file
- Match semantically across languages: "发布计划" = "release plan", "讨论" = "discussed"
- Return ONLY the relevant content you found, no commentary
- Separate results for each query with "---"
- If nothing found for a query, write "NO_MATCH"
- Keep each result concise (under 400 chars)`;

/**
 * ComputerUseModule system prompt (src/modules/computer-use.ts:443-463)
 */
export const COMPUTER_USE_SYSTEM = `## Identity
You are CallingClaw's computer control module on macOS.
Be precise with coordinates. Take screenshots to verify actions.
When describing what you did, speak conversationally. Don't list coordinates or technical details.

## When to click vs describe
- Click when the user asks to interact with something specific on screen.
- Don't click when the user asks a general question or wants an explanation.
- After clicking, take a screenshot to verify. Describe the result naturally.

## Tool Selection (priority order)
1. \`computer\` — visual interaction: click, type, scroll, drag, screenshot.
2. \`bash\` — shell commands: launch apps, run scripts, quick file ops.
   Launch apps: open -a "AppName"  |  Open URLs: open "https://..."  |  Verify: take screenshot after.`;

// ═══════════════════════════════════════════════════════════════════
//  Real MEMORY.md content — for context retrieval tests
//  Subset of ~/.openclaw/workspace/MEMORY.md (production knowledge base)
// ═══════════════════════════════════════════════════════════════════

export const MEMORY_MD_EXCERPT = `# MEMORY.md — Long-Term Memory

> Last updated: 2026-04-07

## About Andrew

- **Full name**: Andrew Chan 陈学毅
- **Telegram**: @andrew_xe (id: 6276752049)
- **GitHub**: XEasonChan
- **Email**: xeasonchan@gmail.com
- **Timezone**: Asia/Shanghai (GMT+8)
- **Communication**: 中文为主，面向用户的产品内容用英文

## Personality & Work Style

- 行动力极强，说做就做，经常半夜还在推进项目
- 喜欢用 HTML 原型做产品设计，不依赖 Figma
- 重度 Claude Opus 用户（Claude Code 协作开发）
- 相信语音和会议是人和 AI Agent 协作最高效的方式

## Current Work

### Tanka (主业)
- **角色**: 创始人/产品负责人
- **产品**: AI Agent Connector Platform
- **核心功能**:
  - Tanka Link: 连接 184+ 第三方 App
  - Proactive Action Cards: AI 自动生成操作卡片
  - CallingClaw: Chrome 扩展语音助手
  - 会议录制与总结: 本地转录
- **成绩**: PH #1 day / #2 week+month, 20M+ impressions, 10K+ B2B orgs

### Memdex (Side Project)
- **产品**: memdex.ai — 浏览器扩展，跨 AI 平台记忆迁移
- **支持**: ChatGPT/Claude/Gemini/Perplexity/Grok
- **特点**: 本地存储，隐私优先
- **用户**: 几百个
- **竞品**: Mem0/OpenMemory (YC-backed)

### CallingClaw 2.0 → Desktop (Electron)
- **架构决策 (2026-03-12)**: 从 Chrome + AppleScript + BlackHole 迁移到 Electron 桌面应用
- **Electron 优势**: preload 注入取代 AppleScript、WebRTC 直接捕获音频取代 BlackHole、透明悬浮窗、.dmg 一键安装
- **GTM**: ClawHub skill(免费引流) → Desktop($19.99 买断, 用户自带 OpenAI key) → Cloud hosted(按次/月付)
- **BlackHole 完全替换 (2026-03-26)**: Playwright addInitScript 音频注入方案验证全双工工作
- **4 voice providers**: openai(GA 1.5, default), openai15(alias), grok($0.05/min), gemini(cheapest ~$0.02/min)
- **成本**: 30min 会议 $2-5 (Realtime audio); $19.99 买断不承担 API 成本
- **开源计划**: MIT 协议，HN Show HN 首发
- **GitHub**: https://github.com/XEasonChan/callingclaw (canonical repo)
- **CoCo Launch Sprint**: CoCo = CallingClaw 品牌重塑。MIT 开源。$19.99 买断

### Agent Architecture Experiment (2026-04-03)
- **决策: Dual Chrome 架构**: Chrome #1 (Playwright) = audio/meeting ONLY; Chrome #2 (OpenCLI) = execution tasks
- **OpenCLI benchmark**: Deterministic adapters ~1-2s $0 vs BrowserActionLoop ~3-5s ~$0.002/query → 2-5x faster

### Context Sync 新架构 (2026-03-16 确认)
- **事件驱动而非定时**: Haiku 监听 transcript，累积~500字或检测到问题时才触发
- **三层模型**: GPT-4o Realtime(语音) + Haiku 3.5(transcript分析) + OpenClaw(知识检索)
- **OpenClaw 作为检索后端**: 利用现有 memory_search + 文件系统，不自建 RAG
- **时间开销**: 完整检索周期 ~3-4 秒，60 分钟会议触发 5-10 次`;

// ═══════════════════════════════════════════════════════════════════
//  Real Prep Brief — from ~/.callingclaw/shared/prep/ (production)
// ═══════════════════════════════════════════════════════════════════

export const SAMPLE_PREP_BRIEF = {
  topic: "CallingClaw桌面端与Telegram等OpenClaw托管平台的关系讨论",
  goal: "厘清 CallingClaw Desktop（Electron）、CallingClaw Bun Daemon、OpenClaw Gateway 三者之间的架构关系",
  keyPoints: [
    "三层架构：Bun Daemon(引擎:4000) ← HTTP → Electron Desktop(GUI) ← WebSocket → OpenClaw Gateway(大脑:18789)",
    "OpenClaw 是多渠道 AI 平台：Telegram/Signal/Discord/WhatsApp/Slack/webchat",
    "MeetingScheduler 依赖 OpenClaw：轮询日历 → 通过 OpenClaw cron 注册自动入会",
    "PostMeetingDelivery 依赖 OpenClaw：会议结束 → 生成 Todo → 通过 OpenClaw 发到 Telegram",
    "Desktop 独特价值：实时 Overlay（转录、卡片）、音频设备管理UI、权限检查、onboarding 引导",
    "无 Desktop 的极简模式：Bun Daemon + OpenClaw(Telegram) 也能跑完整会议流程",
  ],
  architectureDecisions: [
    {
      decision: "CallingClaw = 数据捕获 + 传递管道；OpenClaw = 智能分析 + 执行",
      rationale: "CallingClaw 只负责音频采集、屏幕监控、Meet 操控，所有 AI 分析和推理由 OpenClaw 完成",
    },
    {
      decision: "Electron Desktop 是 GUI 壳，不包含核心逻辑",
      rationale: "Bun Daemon 是独立可运行的引擎，Desktop 只是通过 localhost:4000 API 消费数据",
    },
  ],
  expectedQuestions: [
    {
      question: "用户不装 Desktop，只用 Telegram + CallingClaw daemon 能用完整功能吗？",
      suggestedAnswer: "可以。核心功能（入会、语音AI、转录、会后Todo、自动入会）都不依赖 Electron。Telegram 通过 OpenClaw 接收通知和确认操作。",
    },
    {
      question: "OpenClawBridge 断开时 CallingClaw 还能工作吗？",
      suggestedAnswer: "语音AI（GPT-4o Realtime）和基础入会功能不依赖 OpenClaw。但 MeetingScheduler、PostMeetingDelivery、MeetingPrepSkill、ContextRetriever 都需要 OpenClaw。降级模式下功能有限。",
    },
  ],
  browserUrls: [
    { url: "https://github.com/XEasonChan/callingclaw", description: "CallingClaw GitHub 仓库" },
    { url: "https://www.callingclaw.com", description: "CallingClaw 官网" },
  ],
  scenes: [
    { url: "https://www.callingclaw.com", scrollTarget: "Features section" },
    { url: "https://github.com/XEasonChan/callingclaw", scrollTarget: "README" },
  ],
};

// ═══════════════════════════════════════════════════════════════════
//  Test Case Types
// ═══════════════════════════════════════════════════════════════════

export type TestCategory =
  | "intent_classification"
  | "vision_description"
  | "context_retrieval"
  | "computer_use"
  | "demo_script"
  | "cross_language";

export interface TestCase {
  id: string;
  category: TestCategory;
  /** System prompt (built from production templates) */
  systemPrompt: string;
  /** User message */
  userMessage: string;
  /** Optional: text description of a screenshot (proxy for actual image) */
  screenshotDescription?: string;
  /** If true, test requires an actual screenshot file — skip gracefully if missing */
  requiresScreenshot?: boolean;
  /** Optional screenshot path */
  screenshotPath?: string;
  /** Expected output validation */
  expected: {
    /** Expected action name (null = NO ACTION) */
    action: string | null;
    /** Minimum confidence threshold (0-1); 0 means expect no action */
    confidence: number;
    /** Keywords that MUST appear in the response */
    mustMention?: string[];
    /** Keywords that MUST NOT appear in the response */
    mustNotMention?: string[];
    /** Expected response language: "zh" | "en" | "any" */
    language?: "zh" | "en" | "any";
  };
}

// ═══════════════════════════════════════════════════════════════════
//  Helper: build brief block for TranscriptAuditor prompt
// ═══════════════════════════════════════════════════════════════════

function buildBriefBlock(): string {
  const lines: string[] = [];
  for (const u of SAMPLE_PREP_BRIEF.browserUrls) {
    lines.push(`- URL: ${u.url} (${u.description})`);
  }
  for (const s of SAMPLE_PREP_BRIEF.scenes) {
    lines.push(`- Scene: ${s.url} → ${s.scrollTarget}`);
  }
  return lines.join("\n") || "- (no files or URLs in prep)";
}

function buildMeetingContext(): string {
  return `Topic: ${SAMPLE_PREP_BRIEF.topic}
Goal: ${SAMPLE_PREP_BRIEF.goal}
Recent actions: none`;
}

// ═══════════════════════════════════════════════════════════════════
//  Intent Classification — 10 tests (IC-01 to IC-10)
// ═══════════════════════════════════════════════════════════════════

const IC_TESTS: TestCase[] = [
  {
    id: "IC-01",
    category: "intent_classification",
    systemPrompt: buildIntentClassificationPrompt({
      briefBlock: buildBriefBlock(),
      meetingContext: buildMeetingContext(),
      transcriptText: `[user (Andrew)] 我们先看一下产品吧
[assistant] 好的，我来把 CallingClaw 官网拉出来
[user (Andrew)] 帮我投屏 CallingClaw 官网`,
    }),
    userMessage: "Classify the intent from the transcript above. Respond with JSON only.",
    expected: {
      action: "share_url",
      confidence: 0.85,
      mustMention: ["callingclaw"],
      language: "any",
    },
  },
  {
    id: "IC-02",
    category: "intent_classification",
    systemPrompt: buildIntentClassificationPrompt({
      briefBlock: buildBriefBlock(),
      presentationState: `ACTIVELY PRESENTING Scene 1/2: https://www.callingclaw.com
Current scroll target: Features section
When user says "click/scroll" — operate on THIS page (https://www.callingclaw.com)`,
      meetingContext: buildMeetingContext(),
      transcriptText: `[user (Andrew)] 这个页面挺好看的
[assistant] 谢谢，我们可以看看有哪些功能
[user (Andrew)] 可以的，让他点击那个 download for mac 吧`,
    }),
    userMessage: "Classify the intent from the transcript above. Respond with JSON only.",
    expected: {
      action: "click",
      confidence: 0.85,
      mustMention: ["download"],
      language: "any",
    },
  },
  {
    id: "IC-03",
    category: "intent_classification",
    systemPrompt: buildIntentClassificationPrompt({
      briefBlock: buildBriefBlock(),
      presentationState: `ACTIVELY PRESENTING Scene 2/2: https://github.com/XEasonChan/callingclaw
Current scroll target: README
When user says "click/scroll" — operate on THIS page (https://github.com/XEasonChan/callingclaw)`,
      meetingContext: buildMeetingContext(),
      transcriptText: `[assistant] 这是我们的 GitHub repo
[user (Andrew)] 哦对了，返回刚才提到的部分重新说一下`,
    }),
    userMessage: "Classify the intent from the transcript above. Respond with JSON only.",
    expected: {
      action: "navigate",
      confidence: 0.7,
      language: "any",
    },
  },
  {
    id: "IC-04",
    category: "intent_classification",
    systemPrompt: buildIntentClassificationPrompt({
      briefBlock: buildBriefBlock(),
      meetingContext: buildMeetingContext(),
      transcriptText: `[user (Andrew)] 这个 bug 我觉得不急，先上线后修
[assistant] 好的，那我们先记下来
[user (Andrew)] 这个 bug 先上线后修`,
    }),
    userMessage: "Classify the intent from the transcript above. Respond with JSON only.",
    expected: {
      action: null,
      confidence: 0,
      language: "any",
    },
  },
  {
    id: "IC-05",
    category: "intent_classification",
    systemPrompt: buildIntentClassificationPrompt({
      briefBlock: buildBriefBlock(),
      presentationState: `ACTIVELY PRESENTING Scene 1/2: https://www.callingclaw.com
Current scroll target: Features section`,
      meetingContext: buildMeetingContext(),
      transcriptText: `[user (Andrew)] Hero 再更 sharp 一点
[assistant] 你是说 landing page 的标题文案需要更锐利？`,
    }),
    userMessage: "Classify the intent from the transcript above. Respond with JSON only.",
    expected: {
      action: null,
      confidence: 0,
      language: "any",
    },
  },
  {
    id: "IC-06",
    category: "intent_classification",
    systemPrompt: buildIntentClassificationPrompt({
      briefBlock: buildBriefBlock(),
      presentationState: `ACTIVELY PRESENTING Scene 1/2: https://www.callingclaw.com
Current scroll target: Features section`,
      meetingContext: buildMeetingContext(),
      transcriptText: `[user (Andrew)] 我们看看 GitHub 那个 tab
[assistant] 好，我来切过去
[user (Andrew)] 切到 GitHub 那个 tab`,
    }),
    userMessage: "Classify the intent from the transcript above. Respond with JSON only.",
    expected: {
      action: "navigate",
      confidence: 0.8,
      mustMention: ["github"],
      language: "any",
    },
  },
  {
    id: "IC-07",
    category: "intent_classification",
    systemPrompt: buildIntentClassificationPrompt({
      briefBlock: buildBriefBlock(),
      meetingContext: buildMeetingContext(),
      transcriptText: `[user (Andrew)] 帮我搜一下 Twitter 上最近有没有讨论 CallingClaw 的
[assistant] 好的，我让 agent 去搜一下`,
    }),
    userMessage: "Classify the intent from the transcript above. Respond with JSON only.",
    expected: {
      action: "research_task",
      confidence: 0.85,
      mustMention: ["twitter", "callingclaw"],
      language: "any",
    },
  },
  {
    id: "IC-08",
    category: "intent_classification",
    systemPrompt: buildIntentClassificationPrompt({
      briefBlock: buildBriefBlock(),
      meetingContext: buildMeetingContext(),
      transcriptText: `[assistant] 你觉得这个方案怎么样？
[user (Andrew)] 嗯`,
    }),
    userMessage: "Classify the intent from the transcript above. Respond with JSON only.",
    expected: {
      action: null,
      confidence: 0,
      language: "any",
    },
  },
  {
    id: "IC-09",
    category: "intent_classification",
    systemPrompt: buildIntentClassificationPrompt({
      briefBlock: buildBriefBlock(),
      meetingContext: buildMeetingContext(),
      transcriptText: `[user (Andrew)] 我觉得这个方案的 tradeoff 需要再想想
[assistant] 你具体指哪方面的 tradeoff？`,
    }),
    userMessage: "Classify the intent from the transcript above. Respond with JSON only.",
    expected: {
      action: null,
      confidence: 0,
      language: "any",
    },
  },
  {
    id: "IC-10",
    category: "intent_classification",
    systemPrompt: buildIntentClassificationPrompt({
      briefBlock: buildBriefBlock(),
      meetingContext: buildMeetingContext(),
      transcriptText: `[user (Guest)] show me the features page
[assistant] Sure, let me pull that up`,
    }),
    userMessage: "Classify the intent from the transcript above. Respond with JSON only.",
    expected: {
      action: "share_url",
      confidence: 0.85,
      mustMention: ["features"],
      language: "any",
    },
  },
];

// ═══════════════════════════════════════════════════════════════════
//  Vision Description — 6 tests (VD-01 to VD-06)
//  Uses text description as proxy for screenshot (no actual images)
// ═══════════════════════════════════════════════════════════════════

const VD_TESTS: TestCase[] = [
  {
    id: "VD-01",
    category: "vision_description",
    systemPrompt: buildVisionPrompt({
      prevDescription: "No previous screen state.",
      recentTranscript: "[assistant] Let me show you the CallingClaw landing page.",
      meetingMode: true,
    }),
    userMessage: `[Screenshot description: A browser showing www.callingclaw.com landing page. Hero section reads "AI With Memory That Joins Your Meetings" with a large red CTA button saying "Join the Waitlist". Below is a features grid showing 4 cards: Voice AI, Screen Sharing, Meeting Notes, Computer Use. Dark navy background with white text.]

Describe what's currently shown on the meeting screen. Focus on any shared/presented content.`,
    expected: {
      action: null,
      confidence: 0,
      mustMention: ["CallingClaw", "landing", "waitlist"],
      mustNotMention: ["meeting grid", "no shared content"],
      language: "en",
    },
  },
  {
    id: "VD-02",
    category: "vision_description",
    systemPrompt: buildVisionPrompt({
      prevDescription: "CallingClaw landing page with hero section and waitlist CTA.",
      recentTranscript: "[user] 往下翻一翻",
      meetingMode: true,
    }),
    userMessage: `[Screenshot description: Same callingclaw.com but scrolled down. Now showing a "How It Works" section with 3 steps: 1) Install the Mac app, 2) Join any meeting, 3) CallingClaw listens & acts. Each step has an icon and brief description. Below is a pricing section showing "$19.99 one-time purchase".]

What's currently shown on the meeting screen? Focus on any shared/presented content.`,
    expected: {
      action: null,
      confidence: 0,
      mustMention: ["how it works", "$19.99"],
      mustNotMention: ["hero", "no change"],
      language: "any",
    },
  },
  {
    id: "VD-03",
    category: "vision_description",
    systemPrompt: buildVisionPrompt({
      prevDescription: "No previous screen state.",
      recentTranscript: "",
      meetingMode: true,
    }),
    userMessage: `[Screenshot description: Google Meet interface showing a 2x2 grid of participant video tiles. Four people visible with names: Andrew, Sarah, Mike, Lisa. No screen share active. Standard Meet UI with bottom toolbar (mute, camera, hangup, chat).]

What's currently shown on the meeting screen? Focus on any shared/presented content.`,
    expected: {
      action: null,
      confidence: 0,
      mustMention: ["meeting grid", "no shared"],
      mustNotMention: ["code", "slide", "document"],
      language: "en",
    },
  },
  {
    id: "VD-04",
    category: "vision_description",
    systemPrompt: buildVisionPrompt({
      prevDescription: "Meeting grid view with 4 participants.",
      recentTranscript: "[user] 我来分享一下代码\n[assistant] 好的",
      meetingMode: true,
    }),
    userMessage: `[Screenshot description: VS Code editor visible in screen share. File open: context-retriever.ts. Visible code shows the agenticSearch method with tool definitions (list_workspace, read_file, search_files). Left sidebar shows file tree with modules/ folder expanded. Terminal panel at bottom shows "bun test" output with 3 passing tests.]

What's currently shown on the meeting screen? Focus on any shared/presented content.`,
    expected: {
      action: null,
      confidence: 0,
      mustMention: ["VS Code", "context-retriever"],
      mustNotMention: ["meeting grid"],
      language: "any",
    },
  },
  {
    id: "VD-05",
    category: "vision_description",
    systemPrompt: buildVisionPrompt({
      prevDescription: "VS Code showing context-retriever.ts code.",
      recentTranscript: "[user] 切到浏览器看一下 GitHub",
      meetingMode: true,
    }),
    userMessage: `[Screenshot description: GitHub repository page for XEasonChan/callingclaw. Repo shows 247 stars, 32 forks. README visible with project title "CallingClaw — AI Meeting Companion" and a demo GIF showing screen sharing in a Google Meet. Last commit: "chore: bump desktop version to 2.8.12" by xeasonchan 2 days ago. MIT license badge visible.]

What's currently shown on the meeting screen? Focus on any shared/presented content.`,
    expected: {
      action: null,
      confidence: 0,
      mustMention: ["GitHub", "callingclaw"],
      mustNotMention: ["VS Code", "no shared content"],
      language: "any",
    },
  },
  {
    id: "VD-06",
    category: "vision_description",
    systemPrompt: buildVisionPrompt({
      prevDescription: "No previous screen state.",
      recentTranscript: "[assistant] 我来看看当前的架构图",
      meetingMode: true,
    }),
    userMessage: `[Screenshot description: A Mermaid diagram rendered in a browser showing CallingClaw architecture. Three layers: Top layer "Electron Desktop (GUI)" connected via HTTP to middle layer "Bun Daemon (:4000)" connected via WebSocket to bottom layer "OpenClaw Gateway (:18789)". Side connections show Telegram, Discord, and Signal as channels from OpenClaw. Arrows are labeled with protocol types.]

What's currently shown on the meeting screen? Focus on any shared/presented content.`,
    expected: {
      action: null,
      confidence: 0,
      mustMention: ["architecture", "diagram"],
      mustNotMention: ["no shared content", "meeting grid"],
      language: "any",
    },
  },
];

// ═══════════════════════════════════════════════════════════════════
//  Context Retrieval — 5 tests (CR-01 to CR-05)
//  Tests the agentic search prompt with MEMORY.md content inline
// ═══════════════════════════════════════════════════════════════════

const CR_TESTS: TestCase[] = [
  {
    id: "CR-01",
    category: "context_retrieval",
    systemPrompt: CONTEXT_RETRIEVER_SYSTEM,
    userMessage: `Find information for these queries:
1. CallingClaw 的定价策略是什么？

Here is the content of MEMORY.md for reference:
${MEMORY_MD_EXCERPT}`,
    expected: {
      action: null,
      confidence: 0,
      mustMention: ["$19.99", "买断"],
      language: "any",
    },
  },
  {
    id: "CR-02",
    category: "context_retrieval",
    systemPrompt: CONTEXT_RETRIEVER_SYSTEM,
    userMessage: `Find information for these queries:
1. What voice providers does CallingClaw support?

Here is the content of MEMORY.md for reference:
${MEMORY_MD_EXCERPT}`,
    expected: {
      action: null,
      confidence: 0,
      mustMention: ["openai", "grok", "gemini"],
      language: "any",
    },
  },
  {
    id: "CR-03",
    category: "context_retrieval",
    systemPrompt: CONTEXT_RETRIEVER_SYSTEM,
    userMessage: `Find information for these queries:
1. Why did CallingClaw replace BlackHole?

Here is the content of MEMORY.md for reference:
${MEMORY_MD_EXCERPT}`,
    expected: {
      action: null,
      confidence: 0,
      mustMention: ["Playwright", "addInitScript"],
      mustNotMention: ["NO_MATCH"],
      language: "any",
    },
  },
  {
    id: "CR-04",
    category: "context_retrieval",
    systemPrompt: CONTEXT_RETRIEVER_SYSTEM,
    userMessage: `Find information for these queries:
1. Andrew 做了哪些产品？

Here is the content of MEMORY.md for reference:
${MEMORY_MD_EXCERPT}`,
    expected: {
      action: null,
      confidence: 0,
      mustMention: ["Tanka", "CallingClaw", "Memdex"],
      language: "any",
    },
  },
  {
    id: "CR-05",
    category: "context_retrieval",
    systemPrompt: CONTEXT_RETRIEVER_SYSTEM,
    userMessage: `Find information for these queries:
1. What is the Dual Chrome architecture decision?

Here is the content of MEMORY.md for reference:
${MEMORY_MD_EXCERPT}`,
    expected: {
      action: null,
      confidence: 0,
      mustMention: ["Playwright", "audio", "OpenCLI"],
      mustNotMention: ["NO_MATCH"],
      language: "any",
    },
  },
];

// ═══════════════════════════════════════════════════════════════════
//  Computer Use — 5 tests (CU-01 to CU-05)
//  All marked requiresScreenshot: true — skip gracefully if no images
// ═══════════════════════════════════════════════════════════════════

const CU_TESTS: TestCase[] = [
  {
    id: "CU-01",
    category: "computer_use",
    systemPrompt: COMPUTER_USE_SYSTEM,
    userMessage: `The screen shows the CallingClaw website landing page. There is a red "Join the Waitlist" button in the center of the hero section. The user says: "Click the waitlist button."

Describe what action you would take.`,
    requiresScreenshot: true,
    expected: {
      action: "click",
      confidence: 0.9,
      mustMention: ["waitlist", "button", "click"],
      language: "en",
    },
  },
  {
    id: "CU-02",
    category: "computer_use",
    systemPrompt: COMPUTER_USE_SYSTEM,
    userMessage: `The screen shows VS Code with a file open. The user says: "What file am I looking at?"

Describe what you see and answer the question. Do NOT click anything.`,
    requiresScreenshot: true,
    expected: {
      action: null,
      confidence: 0,
      mustNotMention: ["click", "coordinate"],
      language: "en",
    },
  },
  {
    id: "CU-03",
    category: "computer_use",
    systemPrompt: COMPUTER_USE_SYSTEM,
    userMessage: `The screen shows a terminal with the CallingClaw backend running. The user says: "Open Chrome and go to localhost:4000/api/status."

What commands would you run?`,
    requiresScreenshot: true,
    expected: {
      action: "bash",
      confidence: 0.85,
      mustMention: ["open", "localhost:4000"],
      language: "en",
    },
  },
  {
    id: "CU-04",
    category: "computer_use",
    systemPrompt: COMPUTER_USE_SYSTEM,
    userMessage: `The screen shows Google Meet with a presentation visible. There's a hamburger menu icon in the top-left corner. The user says: "帮我点一下左上角那个菜单."

What action would you take?`,
    requiresScreenshot: true,
    expected: {
      action: "click",
      confidence: 0.85,
      mustMention: ["menu"],
      language: "zh",
    },
  },
  {
    id: "CU-05",
    category: "computer_use",
    systemPrompt: COMPUTER_USE_SYSTEM,
    userMessage: `The screen shows a long webpage that needs scrolling. The user says: "Scroll down to see the pricing section."

What action would you take?`,
    requiresScreenshot: true,
    expected: {
      action: "scroll",
      confidence: 0.85,
      mustMention: ["scroll", "down"],
      language: "en",
    },
  },
];

// ═══════════════════════════════════════════════════════════════════
//  Demo Script — 5 tests (DS-01 to DS-05)
//  Tests presentation narration quality using CORE_IDENTITY
// ═══════════════════════════════════════════════════════════════════

const DEMO_CORE_IDENTITY = `You are CallingClaw, an always-on AI meeting companion. You join meetings, see the screen, listen, speak, and control the computer. You have memory from past meetings and prep materials.

## How you speak
Write for the ear, not the eye. Short sentences. No lists, bullet points, or markdown in your speech. Just natural conversation.
- Keep it to one to three sentences by default.
- Never use abbreviations: say "for example" not "e.g."
- No filler: never say "Great question!", "simply", or "just."
- Answer first, then ask.

## PRESENTER mode
You have a topic outline. Deliver section by section. Within a section, keep talking and describe what's on screen. Between sections, pause briefly for questions. If someone speaks, stop and respond first, then resume. Never repeat yourself.`;

const DS_TESTS: TestCase[] = [
  {
    id: "DS-01",
    category: "demo_script",
    systemPrompt: DEMO_CORE_IDENTITY,
    userMessage: `[PRESENTATION MODE] You are presenting CallingClaw to potential users.

Section 1: Introduction
Key points: CallingClaw is an AI that joins your meetings. It listens, speaks, takes notes, and can control your screen. It costs $19.99 one-time — you bring your own OpenAI key.

[PAGE] The landing page is now showing with the hero section visible. "AI With Memory That Joins Your Meetings" headline.

Begin presenting this section.`,
    expected: {
      action: null,
      confidence: 0,
      mustMention: ["CallingClaw", "meeting"],
      mustNotMention: ["Great question", "simply", "e.g."],
      language: "en",
    },
  },
  {
    id: "DS-02",
    category: "demo_script",
    systemPrompt: DEMO_CORE_IDENTITY,
    userMessage: `[PRESENTATION MODE] You are presenting CallingClaw to potential users.

Section 2: Screen Sharing
Key points: CallingClaw can share any URL or file during the meeting. You just say "show me the features page" and the agent opens it. It can also click buttons, scroll, and navigate — all by voice command.

[PAGE] The features page is now visible showing Voice AI, Screen Sharing, Meeting Notes, Computer Use cards.

Present this section. Describe what's on screen.`,
    expected: {
      action: null,
      confidence: 0,
      mustMention: ["screen", "voice"],
      mustNotMention: ["bullet", "- ", "1."],
      language: "en",
    },
  },
  {
    id: "DS-03",
    category: "demo_script",
    systemPrompt: DEMO_CORE_IDENTITY,
    userMessage: `[PRESENTATION MODE] 你正在向中国用户展示 CallingClaw。

第三部分：记忆系统
要点：CallingClaw 有跨会议记忆。它记得之前讨论过什么、做了什么决定。下次开会时，它能自动准备相关背景资料。

[PAGE] 屏幕上显示的是架构图，展示三层模型：Bun Daemon、Electron Desktop、OpenClaw Gateway。

请开始演示这一部分。`,
    expected: {
      action: null,
      confidence: 0,
      mustMention: ["记忆"],
      mustNotMention: ["Great question", "e.g."],
      language: "zh",
    },
  },
  {
    id: "DS-04",
    category: "demo_script",
    systemPrompt: DEMO_CORE_IDENTITY,
    userMessage: `[PRESENTATION MODE] You are presenting CallingClaw.

You just finished Section 2 about screen sharing. A participant interrupts:

[user (Guest)] "Wait, does it work with Zoom too or just Google Meet?"

Respond to the question, then transition back to your presentation.`,
    expected: {
      action: null,
      confidence: 0,
      mustMention: ["Zoom", "Meet"],
      mustNotMention: ["Great question!", "That's a good point!"],
      language: "en",
    },
  },
  {
    id: "DS-05",
    category: "demo_script",
    systemPrompt: DEMO_CORE_IDENTITY,
    userMessage: `[PRESENTATION MODE] You are wrapping up the demo.

Section: Closing
Key points: CallingClaw is open source (MIT), $19.99 one-time purchase, users bring their own OpenAI API key. Available on GitHub. Join the waitlist at callingclaw.com.

Deliver the closing. Keep it brief and compelling.`,
    expected: {
      action: null,
      confidence: 0,
      mustMention: ["open source", "$19.99"],
      mustNotMention: ["simply", "just"],
      language: "en",
    },
  },
];

// ═══════════════════════════════════════════════════════════════════
//  Cross-Language — 3 tests (CL-01 to CL-03)
//  Tests language switching fidelity per LANGUAGE_RULE
// ═══════════════════════════════════════════════════════════════════

const CL_TESTS: TestCase[] = [
  {
    id: "CL-01",
    category: "cross_language",
    systemPrompt: `You are CallingClaw, an AI meeting companion. ${LANGUAGE_RULE}

Meeting topic: CallingClaw桌面端与Telegram等OpenClaw托管平台的关系讨论
Meeting language so far: Chinese`,
    userMessage: `The meeting has been in Chinese, but the participant just switched to English:

[user (Guest)] "Can you explain the architecture in English? I want to understand the three-layer model."

Respond in the language the user JUST used.`,
    expected: {
      action: null,
      confidence: 0,
      mustMention: ["architecture", "layer"],
      language: "en",
    },
  },
  {
    id: "CL-02",
    category: "cross_language",
    systemPrompt: `You are CallingClaw, an AI meeting companion. ${LANGUAGE_RULE}

Meeting topic: CallingClaw Product Demo
Meeting language so far: English`,
    userMessage: `The meeting has been in English, but the participant just switched to Chinese:

[user (Andrew)] "你能用中文解释一下这个 Dual Chrome 架构吗？我想确认我理解对了。"

Respond in the language the user JUST used.`,
    expected: {
      action: null,
      confidence: 0,
      mustMention: ["Dual Chrome", "Chrome"],
      language: "zh",
    },
  },
  {
    id: "CL-03",
    category: "cross_language",
    systemPrompt: `You are CallingClaw, an AI meeting companion. ${LANGUAGE_RULE}

Meeting topic: 技术架构讨论
Meeting language: Mixed Chinese/English`,
    userMessage: `The conversation is bilingual. The participant uses mixed Chinese and English:

[user (Andrew)] "我觉得 context retriever 的 latency 是个问题，3-4 seconds 太慢了，能不能 optimize 一下？"

Respond naturally, matching the user's bilingual style. Keep technical terms in English.`,
    expected: {
      action: null,
      confidence: 0,
      mustMention: ["context retriever", "latency"],
      language: "zh",
    },
  },
];

// ═══════════════════════════════════════════════════════════════════
//  Export all test cases
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════
//  File Search — 10 tests (FS-01 to FS-10)
//  Fuzzy voice queries → must find the right file from CallingClaw's file tree
//  Simulates STT misrecognition + vague references
// ═══════════════════════════════════════════════════════════════════

const FS_TESTS: TestCase[] = [
  {
    id: "FS-01",
    category: "file_search" as any,
    systemPrompt: buildIntentClassificationPrompt({ briefBlock: buildBriefBlock(), meetingContext: buildMeetingContext(), transcriptText: "" }),
    userMessage: "帮我打开那个视频分镜脚本的文件",
    expected: {
      action: "search_and_open",
      confidence: 0.85,
      mustMention: ["storyboard", "demo-video"],
    },
  },
  {
    id: "FS-02",
    category: "file_search" as any,
    systemPrompt: buildIntentClassificationPrompt({ briefBlock: buildBriefBlock(), meetingContext: buildMeetingContext(), transcriptText: "" }),
    userMessage: "打开我们的 PRD，就是 phase one 那个",
    expected: {
      action: "search_and_open",
      confidence: 0.85,
      mustMention: ["prd", "phase"],
    },
  },
  {
    id: "FS-03",
    category: "file_search" as any,
    systemPrompt: buildIntentClassificationPrompt({ briefBlock: buildBriefBlock(), meetingContext: buildMeetingContext(), transcriptText: "" }),
    userMessage: "找一下那个竞品分析的文档，就是 Pika 那个",
    expected: {
      action: "search_and_open",
      confidence: 0.85,
      mustMention: ["competitive", "pika"],
    },
  },
  {
    id: "FS-04",
    category: "file_search" as any,
    systemPrompt: buildIntentClassificationPrompt({ briefBlock: buildBriefBlock(), meetingContext: buildMeetingContext(), transcriptText: "" }),
    userMessage: "open the launch video brief",
    expected: {
      action: "search_and_open",
      confidence: 0.85,
      mustMention: ["launch", "video", "brief"],
    },
  },
  {
    id: "FS-05",
    category: "file_search" as any,
    systemPrompt: buildIntentClassificationPrompt({ briefBlock: buildBriefBlock(), meetingContext: buildMeetingContext(), transcriptText: "" }),
    userMessage: "帮我打开 go to market 的那个文档",
    expected: {
      action: "search_and_open",
      confidence: 0.85,
      mustMention: ["go to market", "GTM"],
    },
  },
  {
    id: "FS-06",
    category: "file_search" as any,
    systemPrompt: buildIntentClassificationPrompt({ briefBlock: buildBriefBlock(), meetingContext: buildMeetingContext(), transcriptText: "" }),
    userMessage: "把那个 landing page 的 redesign 给我看看",
    expected: {
      action: "search_and_open",
      confidence: 0.85,
      mustMention: ["redesign", "homepage"],
    },
  },
  {
    id: "FS-07",
    category: "file_search" as any,
    systemPrompt: buildIntentClassificationPrompt({ briefBlock: buildBriefBlock(), meetingContext: buildMeetingContext(), transcriptText: "" }),
    userMessage: "show me the architecture decisions document",
    expected: {
      action: "search_and_open",
      confidence: 0.85,
      mustMention: ["architecture", "decision"],
    },
  },
  {
    id: "FS-08",
    category: "file_search" as any,
    input: {
      systemPrompt: buildIntentClassificationPrompt({ briefBlock: buildBriefBlock(), meetingContext: buildMeetingContext(), transcriptText: "" }),
      // STT misrecognition: "calling claw" might become "coin car" or "calling call"
      userMessage: "打开 calling call 的那个 features page",
    },
    expected: {
      action: "share_url",
      confidence: 0.7,
      mustMention: ["callingclaw", "features"],
    },
  },
  {
    id: "FS-09",
    category: "file_search" as any,
    systemPrompt: buildIntentClassificationPrompt({ briefBlock: buildBriefBlock(), meetingContext: buildMeetingContext(), transcriptText: "" }),
    userMessage: "帮我找到团队内部介绍的那个 HTML",
    expected: {
      action: "search_and_open",
      confidence: 0.85,
      mustMention: ["团队", "介绍"],
    },
  },
  {
    id: "FS-10",
    category: "file_search" as any,
    systemPrompt: buildIntentClassificationPrompt({ briefBlock: buildBriefBlock(), meetingContext: buildMeetingContext(), transcriptText: "" }),
    userMessage: "那个视频计划 overview 的文件在哪里",
    expected: {
      action: "search_and_open",
      confidence: 0.85,
      mustMention: ["video", "plan", "overview"],
    },
  },
];

// ═══════════════════════════════════════════════════════════════════
//  Browser Interaction — 8 tests (BI-01 to BI-08)
//  Navigate to external sites + interact with UI elements
// ═══════════════════════════════════════════════════════════════════

const BI_TESTS: TestCase[] = [
  {
    id: "BI-01",
    category: "browser_interaction" as any,
    systemPrompt: buildIntentClassificationPrompt({ briefBlock: buildBriefBlock(), meetingContext: buildMeetingContext(), transcriptText: "" }),
    userMessage: "帮我打开 ChatGPT 然后搜一下 AI meeting assistant 的最新趋势",
    expected: {
      action: "open_url",
      confidence: 0.85,
      mustMention: ["chatgpt", "chat.openai.com"],
    },
  },
  {
    id: "BI-02",
    category: "browser_interaction" as any,
    systemPrompt: buildIntentClassificationPrompt({ briefBlock: buildBriefBlock(), meetingContext: buildMeetingContext(), transcriptText: "" }),
    userMessage: "go to X and search for Pika's latest promotion video",
    expected: {
      action: "open_url",
      confidence: 0.85,
      mustMention: ["x.com", "twitter", "pika"],
    },
  },
  {
    id: "BI-03",
    category: "browser_interaction" as any,
    systemPrompt: buildIntentClassificationPrompt({ briefBlock: buildBriefBlock(), meetingContext: buildMeetingContext(), transcriptText: "" }),
    userMessage: "打开 GitHub 看看我们 CallingClaw 的 repo",
    expected: {
      action: "open_url",
      confidence: 0.85,
      mustMention: ["github"],
    },
  },
  {
    id: "BI-04",
    category: "browser_interaction" as any,
    systemPrompt: buildIntentClassificationPrompt({ briefBlock: buildBriefBlock(), meetingContext: buildMeetingContext(), transcriptText: "" }),
    userMessage: "帮我在当前页面点击 Download for Mac 那个按钮",
    expected: {
      action: "click",
      confidence: 0.85,
      mustMention: ["download", "mac"],
    },
  },
  {
    id: "BI-05",
    category: "browser_interaction" as any,
    systemPrompt: buildIntentClassificationPrompt({ briefBlock: buildBriefBlock(), meetingContext: buildMeetingContext(), transcriptText: "" }),
    userMessage: "scroll down to the pricing section",
    expected: {
      action: "scroll",
      confidence: 0.85,
      mustMention: ["scroll", "pricing"],
    },
  },
  {
    id: "BI-06",
    category: "browser_interaction" as any,
    systemPrompt: buildIntentClassificationPrompt({ briefBlock: buildBriefBlock(), meetingContext: buildMeetingContext(), transcriptText: "" }),
    userMessage: "点击页面上第三个链接",
    expected: {
      action: "click",
      confidence: 0.85,
      mustMention: ["click", "third", "3"],
    },
  },
  {
    id: "BI-07",
    category: "browser_interaction" as any,
    systemPrompt: buildIntentClassificationPrompt({ briefBlock: buildBriefBlock(), meetingContext: buildMeetingContext(), transcriptText: "" }),
    userMessage: "在 ChatGPT 的输入框里面输入 what is CallingClaw",
    expected: {
      action: "click",
      confidence: 0.85,
      mustMention: ["type", "input", "callingclaw"],
    },
  },
  {
    id: "BI-08",
    category: "browser_interaction" as any,
    systemPrompt: buildIntentClassificationPrompt({ briefBlock: buildBriefBlock(), meetingContext: buildMeetingContext(), transcriptText: "" }),
    userMessage: "navigate back to the previous page",
    expected: {
      action: "navigate",
      confidence: 0.8,
      mustMention: ["back", "previous", "navigate"],
    },
  },
];

export const ALL_TESTS: TestCase[] = [
  ...IC_TESTS,
  ...VD_TESTS,
  ...CR_TESTS,
  ...CU_TESTS,
  ...DS_TESTS,
  ...CL_TESTS,
  ...FS_TESTS,
  ...BI_TESTS,
];

/** Get tests by category */
export function getTestsByCategory(category: TestCategory): TestCase[] {
  return ALL_TESTS.filter((t) => t.category === category);
}

/** Get a single test by ID */
export function getTestById(id: string): TestCase | undefined {
  return ALL_TESTS.find((t) => t.id === id);
}

/** Summary statistics */
export function getDatasetStats() {
  const categories = [...new Set(ALL_TESTS.map((t) => t.category))];
  return {
    total: ALL_TESTS.length,
    categories: categories.map((c) => ({
      name: c,
      count: ALL_TESTS.filter((t) => t.category === c).length,
    })),
    requiresScreenshot: ALL_TESTS.filter((t) => t.requiresScreenshot).length,
  };
}
