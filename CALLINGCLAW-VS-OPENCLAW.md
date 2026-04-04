# CallingClaw vs OpenClaw 职责划分

## CallingClaw 独立能力（不需要 OpenClaw）

CallingClaw 可以独立创建 Google Calendar 会议，不依赖 OpenClaw。日历操作通过 Google Calendar REST API 直接完成（`google_cal.ts` → `createEvent()`）。

| 能力 | 实现方式 | 模型 |
|------|---------|------|
| 创建日历事件 + Meet 链接 | `calendar.createEvent()` 直接调 Google API | 无需模型 |
| 加入 Google Meet | ChromeLauncher (Playwright library) | 无需模型 |
| 实时语音对话 | VoiceModule → RealtimeClient | OpenAI Realtime / Gemini Live |
| 屏幕截图分析 | VisionModule (每 ~40s) | Gemini Flash (OpenRouter) |
| 实时意图分类 | TranscriptAuditor (每句话) | Haiku (OpenRouter) |
| 上下文主动搜索 | ContextRetriever (每 ~500 字) | Haiku (OpenRouter) |
| 电脑控制 | ComputerUseModule | Haiku/Sonnet (Anthropic API) |
| 会议录制 + 转录 | MeetingModule | 无需模型 |
| 投屏 Meeting Stage | ChromeLauncher + stage.html | 无需模型 |
| Working Documents 语音上下文 | SharedContext → voice.injectContext | 无需模型 |

## OpenClaw 的交互点（全部可选）

| 交互点 | 作用 | 没有 OpenClaw 时 |
|--------|------|-----------------|
| **`recall_context`** 工具 (深度搜索) | 搜 MEMORY.md + 项目文件做深度知识检索 | 回退到本地搜索，能力降级 |
| **会议准备** (`prepareMeeting`) | 基于项目知识生成会前调研 brief | 跳过，不生成 brief |
| **MeetingScheduler** | OpenClaw cron 定时触发自动入会 | Scheduler 不启动 |
| **会议摘要生成** | 委托 OpenClaw 结合项目记忆生成更丰富的摘要 | 回退到 OpenRouter/OpenAI 生成 |
| **`/api/meeting/delegate`** | 委托 OpenClaw 做深度调研 + CallingClaw 创日历 | API 返回 503 |
| **`/api/meeting/prepare`** | 同上但 OpenClaw 不可用时的 fallback | CallingClaw 独立处理 |
| **会后报告** (OC-009) | 推送会议 timeline + 截图给 OpenClaw 分析 | 跳过 |

## 会议创建的 4 个入口

| 入口 | 触发方式 | 何时创建会议 |
|------|---------|------------|
| **`schedule_meeting` 工具** | AI 语音调用 | 用户说"帮我安排/预约一个会议" |
| **`create_and_join_meeting` 工具** | AI 语音调用 | 用户说"帮我创建一个会议并加入" |
| **`POST /api/meeting/delegate`** | HTTP API (Desktop UI) | Electron 界面点"准备会议" |
| **`POST /api/meeting/prepare`** | HTTP API (Desktop UI) | Electron 界面点"准备会议"（OpenClaw 不可用时 fallback） |

> **注意**: `join_meeting` 工具只加入已有会议，不会创建新会议。
