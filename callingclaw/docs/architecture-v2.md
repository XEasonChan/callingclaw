# CallingClaw v2.2 — 完整架构图

## 统一会议引擎

Talk Locally 和 Meeting Mode 共享同一个引擎，只有音频路由不同：

```
┌─────────────────────────────────────────────────────────────┐
│                    CallingClaw 会议引擎                       │
│                                                              │
│  ┌─ 输入层 ───────────────────────────────────────────────┐  │
│  │                                                        │  │
│  │  音频路由（唯一区别）:                                    │  │
│  │    Talk Locally: 本地麦克风 → OpenAI → 本地扬声器        │  │
│  │    Meet Mode:    BlackHole 2ch → OpenAI → BlackHole 16ch│  │
│  │                                                        │  │
│  │  截图: VisionModule (1s) — Gemini Flash                 │  │
│  │  DOM:  BrowserContext (10s) — Talk Locally 独有          │  │
│  └────────────────────────────────────────────────────────┘  │
│                           ↓                                  │
│  ┌─ AI 处理层 ────────────────────────────────────────────┐  │
│  │                                                        │  │
│  │  Voice AI: OpenAI Realtime (MEETING_PERSONA + Brief)   │  │
│  │  TranscriptAuditor: Claude Haiku (意图识别, 2.5s)       │  │
│  │  ContextRetriever: 知识空白检测 + 语义搜索              │  │
│  │  MeetingModule: 录音 + 行动项提取                       │  │
│  └────────────────────────────────────────────────────────┘  │
│                           ↓                                  │
│  ┌─ 文件系统（统一后台）──────────────────────────────────┐  │
│  │                                                        │  │
│  │  ~/.callingclaw/shared/                                │  │
│  │    {meetingId}_prep.md       ← OpenClaw 写             │  │
│  │    {meetingId}_live.md       ← 实时追加                 │  │
│  │    {meetingId}_summary.md    ← 会后生成                 │  │
│  │    {meetingId}_transcript.md ← 会后生成                 │  │
│  │    sessions.json             ← 会议索引                 │  │
│  │                                                        │  │
│  │  meetingId = cc_{ts}_{rand} (CallingClaw 生成)         │  │
│  └────────────────────────────────────────────────────────┘  │
│                           ↓                                  │
│  ┌─ 输出层 ───────────────────────────────────────────────┐  │
│  │                                                        │  │
│  │  EventBus → WebSocket → Desktop UI 渲染                │  │
│  │  OpenClaw → Telegram/Discord 通知                       │  │
│  │  PostMeetingDelivery → Todo 列表 + 确认按钮            │  │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## 会议生命周期（两种模式共用）

```
PRE-MEETING (会前)
━━━━━━━━━━━━━━━━━
  Desktop 输入话题
    → CallingClaw 生成 meetingId
    → 委托 OpenClaw:
        1. 语义理解 → 标题 + 时间
        2. Google Calendar → 日历 + Meet 链接
        3. 深度调研 → {meetingId}_prep.md
        4. POST /api/meeting/prep-result → Desktop 渲染

DURING MEETING (会中)
━━━━━━━━━━━━━━━━━━━━
  meeting.started 事件触发全部模块:
    ├─ VoiceModule: MEETING_PERSONA + Prep Brief 注入
    ├─ TranscriptAuditor: 替代 OpenAI 的 tool calling
    ├─ ContextRetriever: 检测知识空白 → 补充 context
    ├─ VisionModule: 每 1s 截图分析 → 推送到 OpenClaw
    ├─ MeetingModule: 录音 + 行动项提取
    └─ LiveLog: 每条笔记追加到 {meetingId}_live.md

  Meet Mode 独有:
    ├─ AdmissionMonitor: 3s 检测 → 自动准入参会人
    └─ MeetingEndDetector: DOM 检测会议结束 → 自动 leave

  Talk Locally 独有:
    └─ BrowserContext: 10s 捕获本地浏览器 DOM

POST-MEETING (会后)
━━━━━━━━━━━━━━━━━━
  meeting.ended 事件:
    ├─ 生成会议总结 (GPT-4o) → {meetingId}_summary.md
    ├─ 导出完整记录 → {meetingId}_transcript.md
    ├─ 创建 tasks → TaskStore
    ├─ PostMeetingDelivery → OpenClaw → Telegram Todo 列表
    ├─ 更新 sessions.json { status: "ended" }
    ├─ 停止 TranscriptAuditor + ContextRetriever
    ├─ 停止 VisionModule + flush buffer
    └─ Voice 恢复 DEFAULT_PERSONA
```

## 模块能力对照表

| 模块 | Talk Locally | Meet Mode | 文件输出 |
|------|:-----------:|:---------:|----------|
| **Voice AI** (OpenAI Realtime) | ✅ direct | ✅ meet_bridge | — |
| **MEETING_PERSONA** + Brief | ✅ | ✅ | — |
| **TranscriptAuditor** (Haiku) | ✅ | ✅ | — |
| **ContextRetriever** | ✅ | ✅ | — |
| **VisionModule** (Gemini, 1s) | ✅ | ✅ | → live.md |
| **MeetingModule** (录音) | ✅ | ✅ | → summary.md |
| **LiveLog** (实时追加) | ✅ | ✅ | {id}_live.md |
| **PostMeetingDelivery** | ✅ | ✅ | → Telegram |
| **Summary** (GPT-4o) | ✅ | ✅ | {id}_summary.md |
| **Transcript** export | ✅ | ✅ | {id}_transcript.md |
| **BrowserContext** (DOM, 10s) | ✅ | ✅ (跳过 Meet 标签页) | — |
| **AdmissionMonitor** (3s) | ❌ | ✅ 独有 | — |
| **MeetingEndDetector** (DOM) | ❌ 手动停止 | ✅ 自动检测 | — |
| **Playwright** 入会操作 | ❌ | ✅ | — |
| **BlackHole** 音频桥 | ❌ | ✅ | — |

## 三方通信架构

```
┌─── Desktop (Electron) ──────────────────────┐
│  index.html (会议列表 + 侧面板渲染)          │
│    ├─ HTTP → CallingClaw :4000               │
│    ├─ WebSocket ← EventBus 实时推送          │
│    └─ 读 ~/.callingclaw/shared/ 文件渲染     │
└──────────────────┬──────────────────────────┘
                   │ HTTP + WebSocket
                   ▼
┌─── CallingClaw Daemon (:4000) ──────────────┐
│  REST API + WebSocket EventBus               │
│    ├─ Voice AI (OpenAI Realtime)             │
│    ├─ Vision (Gemini Flash via OpenRouter)   │
│    ├─ Computer Use (Claude via OpenRouter)   │
│    ├─ Playwright CLI (Chrome 自动化)          │
│    ├─ Google Calendar (REST + OAuth2)        │
│    └─ Python Sidecar (音频 + 截图 + 输入)    │
│                                               │
│  文件系统:                                    │
│    ~/.callingclaw/shared/ ← 统一文档目录      │
│    ~/.callingclaw/user-config.json            │
│    ~/.callingclaw/scheduled-meetings.json     │
│    ~/.callingclaw/browser-profile/            │
└──────────────────┬──────────────────────────┘
                   │ WebSocket (:18789)
                   ▼
┌─── OpenClaw Gateway ────────────────────────┐
│  AI 大脑 (System 2: 深度推理)                │
│    ├─ MEMORY.md (用户记忆)                   │
│    ├─ 项目文件读取 + 代码分析                 │
│    ├─ /callingclaw skill (15+ 命令)          │
│    ├─ Google Calendar tool                    │
│    ├─ Cron 自动调度                           │
│    └─ 多渠道通知 (Telegram/Discord/Slack)    │
│                                               │
│  写入: ~/.callingclaw/shared/{id}_prep.md    │
│  通知: POST /api/meeting/prep-result         │
└──────────────────────────────────────────────┘
```

## 文件命名约定

```
~/.callingclaw/shared/
  ├── cc_mx1k2abc_f7k2_prep.md          ← OpenClaw 写
  ├── cc_mx1k2abc_f7k2_live.md          ← CallingClaw 追加
  ├── cc_mx1k2abc_f7k2_summary.md       ← CallingClaw 生成
  ├── cc_mx1k2abc_f7k2_transcript.md    ← CallingClaw 生成
  └── sessions.json                      ← 会议索引

sessions.json:
{
  "sessions": [{
    "meetingId": "cc_mx1k2abc_f7k2",
    "topic": "CallingClaw 官网讨论",
    "calendarEventId": "tnkfge7gfvnhit4cmc09no4hjc",
    "meetUrl": "https://meet.google.com/xxx",
    "status": "ready",
    "files": {
      "prep": "cc_mx1k2abc_f7k2_prep.md",
      "live": "cc_mx1k2abc_f7k2_live.md",
      "summary": "cc_mx1k2abc_f7k2_summary.md"
    },
    "createdAt": "2026-03-17T20:00:00Z"
  }]
}
```

## 职责分离

| 角色 | 职责 | 不做什么 |
|------|------|----------|
| **Desktop** | 渲染 UI、读文件显示 | 不做 AI 推理、不写 prep |
| **CallingClaw** | 硬件控制、音频、截图、录音、文件追加 | 不做深度调研、不做内容生成 |
| **OpenClaw** | 深度调研、记忆搜索、内容生成、写 prep.md | 不直接操作硬件、不做实时音频 |

## EventBus 事件（统一，两种模式共用）

### 会前
| 事件 | 数据 | 触发 |
|------|------|------|
| `meeting.prep_progress` | `{ meetingId, step, message }` | 每个调研步骤 |
| `meeting.prep_ready` | `{ meetingId, mdContent }` | prep.md 就绪 |
| `meeting.agenda` | `{ meetingId, topic, meetUrl }` | 日历创建完成 |

### 会中
| 事件 | 数据 | 触发 |
|------|------|------|
| `meeting.started` | `{ meetingId, meet_url }` | 进入会议 |
| `meeting.vision` | `{ description }` | 每次截图分析 |
| `meeting.live_note` | `{ note, topic }` | [DONE]/[REQ] 笔记 |
| `meeting.context_pushed` | `{ topic }` | context 推送到 Voice |
| `meeting.browser_context` | `{ url, title, ... }` | Talk Locally DOM |
| `auditor.intent` | `{ action, confidence }` | 意图识别 |
| `retriever.complete` | `{ context }` | 知识检索完成 |

### 会后
| 事件 | 数据 | 触发 |
|------|------|------|
| `meeting.ended` | `{ meetingId, summary, filepath }` | 会议结束 |
| `postmeeting.todos_sent` | `{ meetingId, todos[] }` | Todo 发送 |
| `postmeeting.todo_confirmed` | `{ meetingId, todoId }` | 用户确认 |
