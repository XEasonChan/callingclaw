# CallingClaw Prompts、Instructions 与数据存储路径

## 1. Prompt & Instruction 文件索引

### 1.1 Voice AI 核心身份 (Layer 0)

**文件**: `src/prompt-constants.ts`
**变量**: `CORE_IDENTITY` (~260 tokens)

```
You are CallingClaw, a voice AI meeting facilitator. You are an insightful advisor, not a cheerleader.

## Rules (non-negotiable)
1. Match depth to the question. Confirmation → 1 sentence. Strategy → substantive analysis with tradeoffs. Never filler ("You've got this!" / "Great question!").
2. Match the user's language. Chinese conversation → Chinese response. Technical terms stay in English.
3. Stay silent when user is presenting unless directly addressed.
4. Drive depth: ask "why?", "what's the tradeoff?", "who owns this?", "acceptance criteria?"
5. Confirm decisions explicitly: "So the decision is X — correct?"
6. Push back on vague requirements: "What specifically do you mean by...?"
7. Summarize action items with owner and deadline before moving on.
8. Background context grows silently. Use it naturally, never announce searching.
```

---

### 1.2 会议上下文注入 (Layer 2)

**文件**: `src/voice-persona.ts`

- 前缀: `═══ MEETING CONTEXT ═══`
- 后缀: `═══ END MEETING CONTEXT ═══`
- 预算: ~500 tokens
- 包含: 会议主题、目标、摘要、要点、架构决策、预期问题、历史上下文、文件路径、URL

---

### 1.3 屏幕分析 (Vision Module)

**文件**: `src/modules/vision.ts` (L239-261)

**会议模式** (Gemini Flash):
```
You are analyzing a meeting screen capture. Focus on NEW and CHANGED content only.

Rules:
- Describe what is SHOWN/PRESENTED (slides, code, diagrams, documents, browser tabs)
- Note text, code, data, charts, or key visual elements visible
- If shared screen, describe the shared content specifically
- If just meeting grid (faces), say "Meeting grid view, no shared content"
- 1-3 sentences maximum. Focus on WHAT'S DIFFERENT from previous state.
```

**本地对话模式**:
```
You are CallingClaw's vision module. Describe what's on the screen concisely.
Focus on: active application, visible UI elements, any text/content.
1-3 sentences maximum.
```

---

### 1.4 电脑控制 (Computer Use Module)

**文件**: `src/modules/computer-use.ts` (L414-431)

```
## Identity
You are CallingClaw's computer control module on macOS.
Be precise with coordinates. Take screenshots to verify actions.

## Tool Selection (priority order)
1. computer — visual interaction: click, type, scroll, drag, screenshot.
2. bash — shell commands: launch apps, run scripts, quick file ops.
3. openclaw — delegate to OpenClaw agent: precise file editing, web research, messaging, calendar.
```

---

### 1.5 上下文检索 (ContextRetriever) — 3 层 Prompt

**文件**: `src/modules/context-retriever.ts`

**Layer 1: 主题分类** (L439-449):
```
What specific topic is being discussed RIGHT NOW in this meeting conversation?

Previous topic: "${previousTopic}"

Reply with JSON only:
{"topic": "specific topic in 3-8 words", "direction": "what the user wants to know or decide", "shifted": true/false}
```

**Layer 2: 需求推断** (L496-523):
```
The meeting just shifted to a new topic. Determine what specific information would help the AI assistant respond well.

Think about what the AI assistant NEEDS to know to be helpful on this topic.
- NOT: search for the noun that was mentioned ("memdex")
- YES: search for what the conversation needs ("memdex blog performance metrics and conversion data")

Output JSON:
{"needsRetrieval": true/false, "queries": ["need-based search query 1", ...], "reasoning": "..."}
```

**Layer 3: 工作区搜索 Agent** (L609-618):
```
You are a research assistant searching a personal knowledge workspace for specific information.
You have tools to list files, read files, and search across files.

RULES:
- Be efficient: start with search_files or read MEMORY.md, don't read every file
- Match semantically across languages: "发布计划" = "release plan"
- Return ONLY the relevant content you found, no commentary
- Keep each result concise (under 400 chars)
```

**关键参数**:
- `CHAR_THRESHOLD = 300` (约 1-2 分钟对话触发一次)
- `MIN_INTERVAL_MS = 20s` (分析间隔)
- `DEBOUNCE_MS = 2s` (用户停说后等待)
- `MAX_TOOL_ROUNDS = 3` (agentic 搜索轮次)
- `AGENT_TIMEOUT_MS = 8s` (搜索超时)

---

### 1.6 意图识别 (TranscriptAuditor)

**文件**: `src/modules/transcript-auditor.ts` (L215-253)

```
You classify user intent from a meeting conversation transcript.
The user is talking to CallingClaw, an AI meeting assistant that controls its own computer.

## Available Actions
- open_url, open_file, share_screen, stop_sharing, navigate, scroll, computer_action

## Classification Rules
1. ONLY classify as actionable if the user is DIRECTING CallingClaw to perform a computer action.
2. Actionable: "我们看看X" / "帮我打开X" / "跳到X" / "展示一下X" / "开始投屏"
3. Discussion: "这个要改成X" / "我觉得X应该Y" → NOT commands, confidence=0
4. Resolve references to known files/URLs from meeting brief.
5. Be conservative — false positive >> false negative.
6. If user is responding to AI (answering, agreeing) → confidence=0.

Output JSON:
{"action":"<name or null>","params":{...},"confidence":<0.0-1.0>,"reasoning":"..."}
```

**置信度阈值**:
- `≥ 0.85`: 自动执行 (AutomationRouter)
- `0.6 - 0.85`: 建议执行 (liveNote)
- `< 0.6`: 忽略

---

### 1.7 会议摘要生成

**文件**: `src/modules/meeting.ts`

**行动项提取** (L105-110):
```
Extract action items, decisions, and follow-ups from this meeting transcript.
Use your MEMORY.md and project knowledge to determine assignees and priorities.
CRITICAL: Check MEMORY.md Lessons Learned for past mistakes or failures related to topics discussed.
Add prevention items (type: "action_item", text: "⚠️ Prevent repeat: ...") for relevant past failures.
Return ONLY JSON: {"items": [{"type": "todo"|"decision"|"action_item", "text": "...", "assignee": "..."}]}
```

**摘要生成** (L171-181):
```
Generate a structured meeting summary from this transcript and notes.
CRITICAL: Search MEMORY.md Lessons Learned for past mistakes and failures.
Add "⚠️ Past lesson:" items in keyPoints. Add prevention measures in followUps.

Return ONLY JSON:
{"title":"...", "participants":["..."], "keyPoints":["...", "⚠️ Past lesson: ..."],
 "actionItems":[{"task":"...", "assignee":"...", "deadline":"..."}],
 "decisions":["..."], "followUps":["...", "Prevent repeat: ..."]}
```

---

### 1.8 OpenClaw 协议 Prompts

**文件**: `src/openclaw-protocol.ts`

**OC-001: 会前调研 Brief** (L45-87):
- 输出结构: topic, goal, summary, keyPoints, architectureDecisions, expectedQuestions, previousContext, filePaths, browserUrls, folderPaths
- 强制要求: 搜索 MEMORY.md Lessons Learned，表面过去的错误和教训
- 预算: 完整 JSON，由 OpenClaw agent 生成

**OC-002: 上下文召回** (L132-139):
- 输入: 用户的问题 + 可选的本地预取上下文
- 输出: <500 词的事实性回答
- 用途: `recall_context` 工具的深度搜索路径

**OC-010: 多模态时间线分析** (L469-510):
- 输入: 会议截图 + 转录 timeline
- 输出: 变更请求数组 (action, referenceFrame, targetFrame, fileHint, currentState, desiredState)
- 用途: 会后自动提取"用户指着屏幕说的改动需求"

---

## 2. 数据存储路径

### 2.1 目录结构

```
~/.callingclaw/
├── shared/
│   ├── prep/                          # 会前调研 brief
│   │   └── {meetingId}_prep.md        # OpenClaw 生成
│   ├── notes/                         # 会后摘要
│   │   └── {日期}_{时间}_{标题}.md     # CallingClaw 生成
│   ├── logs/                          # 会中实时日志
│   │   └── {meetingId}_live.md        # CallingClaw 追加写入
│   ├── meetings/                      # 多模态时间线
│   │   └── {meetingId}_live/
│   │       ├── frames/                # 截图 JPEG (640x400, 1秒间隔, 去重)
│   │       │   └── {timestamp}.jpg
│   │       ├── timeline.jsonl         # 结构化时间线
│   │       ├── timeline.md            # 可读时间线
│   │       └── timeline.html          # 可分享 HTML 查看器
│   └── sessions.json                  # 会议索引（所有会话注册表）
├── callingclaw.db                     # SQLite 会议元数据
├── browser-profile/                   # Playwright Chrome 用户数据目录
└── google-credentials.json            # Google OAuth 凭证 (可选)
```

### 2.2 文件命名规则

| 文件类型 | 命名模式 | 示例 |
|---------|---------|------|
| 会前调研 | `{meetingId}_prep.md` | `tnkfge7g_prep.md` |
| 实时日志 | `{meetingId}_live.md` | `cc_mn8khe9w_live.md` |
| 会后摘要 | `{日期}_{时间}_{标题}.md` | `2026-03-27_1530_测试callingclaw.md` |
| 完整转录 | `{meetingId}_transcript.md` | `cc_mn8khe9w_transcript.md` |
| 截图帧 | `{timestamp}.jpg` | `1774595700596.jpg` |

**Meeting ID 格式**:
- 优先: Google Calendar Event ID (如 `tnkfge7gfvnhit4cmc09no4hjc`)
- 回退: `cc_{时间戳base36}_{随机}` (如 `cc_mn8khe9w`)

### 2.3 KeyFrameStore 配置

| 参数 | 值 | 说明 |
|------|---|------|
| FRAME_WIDTH | 640px | 截图宽度 |
| FRAME_HEIGHT | 400px | 截图高度 |
| JPEG_QUALITY | 40 | 压缩质量 |
| DEDUP_THRESHOLD | 0.7 | Jaccard 相似度 > 0.7 跳过 |
| MAX_AGE_DAYS | 30 | 自动清理天数 |

### 2.4 OpenClaw 工作区 (ContextRetriever 搜索目标)

```
~/.openclaw/workspace/
├── MEMORY.md               # 中央知识库 (Lessons Learned 区段最关键)
├── meeting-notes/           # 历史会议笔记
├── project-docs/            # 项目文档
├── daily-memory/            # 每日记录
└── *.md                     # 其他文档
```

---

## 3. 汇总表

| 组件 | Prompt 文件 | 模型 | 存储路径 |
|------|------------|------|---------|
| Voice AI 身份 | `prompt-constants.ts` | OpenAI Realtime / Grok | session.update (Layer 0) |
| 会议上下文 | `voice-persona.ts` | — | conversation.item.create (Layer 2) |
| 屏幕分析 | `modules/vision.ts` | Gemini Flash | 注入转录 + Layer 3 |
| 电脑控制 | `modules/computer-use.ts` | Claude Sonnet | 系统 prompt |
| 主题分类 | `modules/context-retriever.ts` L1 | Haiku (OpenRouter) | — |
| 需求推断 | `modules/context-retriever.ts` L2 | Haiku (OpenRouter) | — |
| 工作区搜索 | `modules/context-retriever.ts` L3 | Haiku (agentic) | ~/.openclaw/workspace/ |
| 意图识别 | `modules/transcript-auditor.ts` | Haiku (OpenRouter) | — |
| 行动项提取 | `modules/meeting.ts` | OpenClaw / OpenRouter | ~/.callingclaw/shared/notes/ |
| 摘要生成 | `modules/meeting.ts` | OpenClaw / OpenRouter | ~/.callingclaw/shared/notes/ |
| 会前调研 | `openclaw-protocol.ts` OC-001 | OpenClaw agent | ~/.callingclaw/shared/prep/ |
| 上下文召回 | `openclaw-protocol.ts` OC-002 | OpenClaw agent | — |
| 时间线分析 | `openclaw-protocol.ts` OC-010 | OpenClaw agent | ~/.callingclaw/shared/meetings/ |
