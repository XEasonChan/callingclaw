# CallingClaw 2.0 研发架构与技术栈选型指南

形态: 命令行后台服务 (CLI Daemon) + 本地 Web 配置页
核心运行环境: Bun + Python 3.10+ (conda)

---

## 1. 整体技术栈选型 (Tech Stack)

### 1.1 主控节点 & Web 配置端 (Bun)

| 组件 | 选型 | 说明 |
|------|------|------|
| 运行时 | Bun v1.3+ | 极速 TS 执行，内置包管理，原生 .env 读取 |
| HTTP 服务 | `Bun.serve()` | 原生 HTTP + WebSocket，不依赖 Express/Elysia |
| 前端 | 纯 HTML + Tailwind + Vanilla JS | 由 Bun 挂载 `public/callingclaw-panel.html` |
| OpenAI SDK | `openai@6.27+` | Realtime WebSocket + GPT-4o vision |
| Anthropic SDK | `@anthropic-ai/sdk@0.78+` | Computer Use (beta API) via OpenRouter |
| Google Calendar | 直接 REST API + OAuth2 | 自动扫描本地 `~/.openclaw/workspace/` 凭据 |

> **已移除**: `@modelcontextprotocol/sdk` (Google MCP 包不存在于 npm)，改为直接调 Google Calendar REST API。

### 1.2 物理外设网关 (Python Sidecar)

| 组件 | 选型 | 说明 |
|------|------|------|
| 连接 | `websockets` | WebSocket client，连接 Bun bridge (:4001) |
| 截屏 | `mss` | 1 FPS 截屏 + hash 差分，只发送变化帧 |
| 键鼠 | `pyautogui` | 接收 Bun 转发的 Claude Computer Use 坐标执行点击 |
| 音频 | `pyaudio` | 双模式：direct (默认麦克风/扬声器) / meet_bridge (BlackHole) |
| Python 路径 | `/opt/miniconda3/bin/python3` | 通过 `PYTHON_PATH` 环境变量配置 |

---

## 2. 系统拓扑与数据流（独立机器部署）

> **核心前提**: CallingClaw 运行在独立的专用电脑上，拥有自己的屏幕、鼠标、键盘和音频设备。
> 用户通过 Google Meet 与 CallingClaw 进行会议互动。

```
用户的电脑                            CallingClaw 专用机器
┌──────────────┐                     ┌──────────────────────────────────────────┐
│              │                     │                                          │
│  Google Meet │◄═══ Meet 音频 ═══►  │  Google Chrome (Meet)                    │
│  (参会者)     │                     │    Speaker → BlackHole 2ch               │
│              │                     │    Mic    ← BlackHole 16ch               │
└──────────────┘                     │                                          │
                                     │  ┌────────────────────────────────────┐  │
   Agent / OpenClaw                  │  │       Python Sidecar (:4001)       │  │
┌──────────────┐                     │  │  PyAudio (BH2ch→capture→BH16ch)   │  │
│ 慢思考 System 2│─── HTTP :4000 ──►  │  │  mss 截屏 · pyautogui 键鼠        │  │
│ 深度推理+记忆  │                     │  └───────────────┬──────────────────┘  │
│ MEMORY.md     │                     │                   │ WS :4001             │
└──────────────┘                     │  ┌────────────────┴─────────────────┐  │
                                     │  │      Bun 主进程 (callingclaw.ts)  │  │
                                     │  │                                    │  │
                                     │  │  SharedContext ──→ MeetingModule   │  │
                                     │  │       ↑ transcript    ↓ GPT 提取   │  │
                                     │  │  VoiceModule ←→ OpenAI Realtime   │  │
                                     │  │  (快思考 System 1, ~300ms 延迟)    │  │
                                     │  │                                    │  │
                                     │  │  AutomationRouter (4 层路由)       │  │
                                     │  │    L1: Shortcuts  (键盘快捷键)     │  │
                                     │  │    L2: Playwright (浏览器 DOM)     │  │
                                     │  │    L3: Peekaboo   (macOS GUI)     │  │
                                     │  │    L4: Claude CU  (视觉 fallback) │  │
                                     │  │                                    │  │
                                     │  │  MeetingPrepSkill (会议准备 Brief) │  │
                                     │  │  EventBus + TaskStore              │  │
                                     │  │  ConfigServer (REST :4000)         │  │
                                     │  │  GoogleCalendar (REST + OAuth2)    │  │
                                     │  └──────────────────────────────────┘  │
                                     └──────────────────────────────────────────┘
```

---

## 3. 语音实时对话架构 (Real-time Voice)

```
┌─────────────────── Real-time 双向语音对话 ───────────────────────┐
│                                                                    │
│  ┌──────────┐    audio_chunk     ┌──────────┐    input_audio      │
│  │  麦克风   │ ─── PCM16 24kHz──→│   Bun    │ ─── base64 ────→   │
│  │ (PyAudio) │   via WS :4001    │ 主进程    │  via WSS OpenAI    │
│  └──────────┘                    │          │                     │
│                                  │          │   OpenAI Realtime   │
│  ┌──────────┐   audio_playback   │          │   (Server VAD)      │
│  │  扬声器   │ ←── PCM16 24kHz──│          │ ←── response ───   │
│  │ (PyAudio) │   via WS :4001    │          │  .audio.delta       │
│  └──────────┘                    └──────────┘                     │
│                                                                    │
│  Python Sidecar               Bun                  OpenAI API     │
└────────────────────────────────────────────────────────────────────┘

音频参数：
  - 采样率: 24kHz (匹配 OpenAI Realtime 要求)
  - 格式: PCM16 (16-bit signed integer)
  - Chunk: 20ms (480 samples = 960 bytes)
  - 传输: base64 编码通过 JSON WebSocket

两种音频模式（独立机器，无音频冲突）：
  ┌─── "direct" 模式 (测试/独立对话) ─────────────────────┐
  │ 默认麦克风 → PyAudio → WS → Bun → OpenAI              │
  │ OpenAI → Bun → WS → PyAudio → 默认扬声器               │
  └──────────────────────────────────────────────────────┘
  ┌─── "meet_bridge" 模式 (Google Meet 会议，推荐) ────────┐
  │ Meet Speaker → BlackHole 2ch → PyAudio capture          │
  │      → WS → Bun → OpenAI Realtime (AI 听到会议内容)     │
  │                                                         │
  │ OpenAI Realtime → Bun → WS → PyAudio playback           │
  │      → BlackHole 16ch → Meet Mic (AI 发言到会议)         │
  │                                                         │
  │ 两个 BlackHole 设备隔离输入输出，无反馈回路              │
  │ 安装: brew install blackhole-2ch blackhole-16ch         │
  │ Chrome Meet 设置:                                       │
  │   Speaker output → BlackHole 2ch                        │
  │   Mic input → BlackHole 16ch                            │
  └──────────────────────────────────────────────────────┘

VAD (语音活动检测)：
  - 类型: server_vad (OpenAI 端检测)
  - 灵敏度: threshold 0.5
  - 前缀填充: 300ms
  - 静音判定: 500ms
```

---

## 4. 子模块实现详情

### 4.1 模块 Auth — API 密钥管理

| 属性 | 值 |
|------|------|
| 文件 | `src/modules/auth.ts` |
| 功能 | API key 存储、读取、验证、掩码显示 |
| 存储 | `.env` 文件 (Bun 原生读取) |
| 支持的 Key | `OPENAI_API_KEY` (必需), `OPENROUTER_API_KEY` (推荐), `ANTHROPIC_API_KEY` (可选) |
| 验证方式 | OpenAI: `GET /v1/models`, Anthropic: `POST /v1/messages` with minimal payload |
| 测试 | `src/modules/auth.test.ts` — 2 tests (masking, status) |

### 4.2 模块 Voice — OpenAI Realtime 语音

| 属性 | 值 |
|------|------|
| 文件 | `src/ai_gateway/realtime_client.ts` |
| 连接 | Bun 原生 WebSocket → `wss://api.openai.com/v1/realtime` |
| 认证 | `Authorization: Bearer <key>`, `OpenAI-Beta: realtime=v1` |
| 模型 | `gpt-4o-realtime-preview-2024-12-17` |
| 音频格式 | `pcm16` input + output, 24kHz |
| 语音 | `alloy` (可通过 API 切换) |
| VAD | Server-side, threshold=0.5, silence=500ms |
| Tool Calls | 7 个注册工具: schedule_meeting, check_calendar, join_meeting, create_and_join_meeting, leave_meeting, computer_action |
| 事件监听 | `session.created`, `session.updated`, `response.audio.delta`, `response.audio_transcript.delta`, `response.function_call_arguments.done`, `response.done` |
| 测试 | `src/ai_gateway/realtime_client.test.ts` — 8 tests (连接、事件、文本→音频回复、音频发送、工具注册、断开) |

**音频数据流:**
```
Python mic capture → audio_chunk (base64 PCM16) → bridge WS
  → Bun realtime.sendAudio() → OpenAI input_audio_buffer.append

OpenAI response.audio.delta → Bun
  → bridge.sendAudioPlayback() → audio_playback WS → Python speaker
```

### 4.3 模块 Vision — 屏幕截图 + AI 理解

| 属性 | 值 |
|------|------|
| 文件 | `src/modules/vision.ts` (模块封装) + `python_sidecar/main.py` (截屏执行) |
| 截屏 | Python `mss` 库, 1 FPS, 主显示器 |
| 变化检测 | 简易 hash 差分 (非 SSIM), 只有画面变化时才发送 |
| AI 分析 | OpenAI GPT-4o vision (`gpt-4o`), 带上下文 (最近对话 transcript) |
| 传输 | base64 PNG via WebSocket bridge |
| 自动分析 | 可配置周期性分析，写入 SharedContext |

### 4.4 模块 Computer Use — Claude 屏幕操作

| 属性 | 值 |
|------|------|
| 文件 | `src/ai_gateway/claude_agent.ts` + `src/modules/computer-use.ts` |
| API | Anthropic `client.beta.messages.create()` with `betas: ["computer-use-2025-01-24"]` |
| 工具 | `computer_20250124` (screenshot, click, type, scroll, key) |
| 网关 | **OpenRouter** (`baseURL: https://openrouter.ai/api/v1`, model: `anthropic/claude-sonnet-4-20250514`) — 无需 Anthropic 直接账户 |
| 回退 | 若设置了 `ANTHROPIC_API_KEY` 则直接调用 Anthropic API |
| Agent Loop | 截图 → Claude 分析 → 返回 tool_use → Python 执行动作 → 新截图 → 循环直到完成 |
| 上下文 | 从 SharedContext 读取最近 transcript + 屏幕状态 |
| 测试 | `src/modules/computer-use.test.ts` — 3 tests (config check, cancel) |

**执行流:**
```
指令 → ClaudeAgent.runComputerUseLoop(instruction)
  → 发送截图给 Claude → Claude 返回 {type: "computer_20250124", action: "left_click", coordinate: [x,y]}
  → bridge.sendAction("click", {x, y}) → Python PyAutoGUI 执行
  → 重新截图 → 再次发给 Claude → 直到 Claude 返回纯文本 (任务完成)
```

### 4.5 模块 Meeting — 会议记录 + 待办提取

| 属性 | 值 |
|------|------|
| 文件 | `src/modules/meeting.ts` |
| 录制 | 持续从 SharedContext 读取 transcript |
| Action Items | 每 2 分钟用 GPT-4o-mini 提取 action items |
| 触发关键词 | "action item", "todo", "follow up", "待办", "跟进" — 在语音中检测到时触发即时提取 |
| 输出 | `MeetingSummary`: keyPoints, actionItems, decisions, followUps |

### 4.6 模块 SharedContext — 跨模块状态总线

| 属性 | 值 |
|------|------|
| 文件 | `src/modules/shared-context.ts` |
| 功能 | Voice/Vision/ComputerUse/Meeting 的共享状态 |
| 内容 | transcript[] (对话记录), screen state (截图描述), meeting notes |
| 事件系统 | `on(event, callback)` 用于跨模块通知 |
| 自动清理 | transcript 超过 200 条自动裁剪 |
| `getTranscriptText()` | 格式化给 AI 消费的文本 |
| 测试 | `src/modules/shared-context.test.ts` — 8 tests |

### 4.7 模块 Google Calendar — 日历集成

| 属性 | 值 |
|------|------|
| 文件 | `src/mcp_client/google_cal.ts` |
| 方式 | 直接 Google Calendar REST API (`googleapis.com/calendar/v3`) |
| 认证 | OAuth2 refresh token (自动扫描 `~/.openclaw/workspace/` 或 `.env`) |
| 项目 | `memdex-ops` (Client ID: `366611748816-...`) |
| Token 刷新 | 自动，过期前 1 分钟刷新 |
| 功能 | `listUpcomingEvents()`, `createEvent()` (自动创建 Meet 链接), `findFreeSlots()` (FreeBusy API) |
| 扫描路径 | `~/.openclaw/workspace/`, `~/.config/gcloud/`, `~/.callingclaw/` |
| API 端点 | `GET /api/google/scan`, `POST /api/google/apply`, `POST /api/google/set` |

### 4.8 模块 Meet Joiner — 自动加入会议 (集成语音 + 音频桥接)

| 属性 | 值 |
|------|------|
| 文件 | `src/meet_joiner.ts` |
| 方式 | 脚本化 (非 AI), 通过 Chrome + 键盘快捷键 |
| 集成 | `POST /api/meeting/join` 自动启动 OpenAI Realtime + 配置音频桥接 + 加入会议 |
| 支持平台 | Google Meet + Zoom |
| Google Meet 流程 | `open` Meet URL → Cmd+E (关摄像头) → Cmd+D (关麦克风) → AppleScript 找 "Join now" 按钮 → 点击 |
| Zoom 流程 | `open` Zoom URL → Return (确认加入) → Cmd+Shift+V (关摄像头) → Cmd+Shift+A (关麦克风) |
| 屏幕共享 | Meet: Present now → Entire screen; Zoom: Cmd+Shift+S |
| 音频切换 | 加入后发送 `config: {audio_mode: "meet_bridge"}` 给 Python sidecar |
| 创建+加入 | `createAndJoinMeeting()` — 先用 Calendar API 创建带 Meet 的事件，再自动加入 |
| 离开+总结 | `leave_meeting` → 自动生成会议 Markdown 总结 + 创建后续任务 |

### 4.9 Python Sidecar — 物理设备网关

| 属性 | 值 |
|------|------|
| 文件 | `python_sidecar/main.py` |
| 连接 | `websockets` client → `ws://localhost:4001` (自动重连) |
| 截屏 | `mss` 1FPS + hash 差分，只发送变化帧 |
| 键鼠 | `pyautogui` — click, type, key, scroll, drag, mouse_move, find_and_click (AppleScript) |
| 音频 | `AudioBridge` class — direct (默认设备) / meet_bridge (BlackHole) |
| 消息协议 | JSON via WebSocket: `{type, payload, ts}` |
| 消息类型 | `action`, `action_result`, `audio_chunk`, `audio_playback`, `screenshot`, `status`, `config` |

### 4.10 Config Server — HTTP REST API

| 属性 | 值 |
|------|------|
| 文件 | `src/config_server.ts` |
| 端口 | `:4000` |
| 静态文件 | `public/callingclaw-panel.html` (控制面板 UI) |
| 端点数量 | 40+ 个 REST 端点 |

**API 概览:**
| 端点 | 功能 |
|------|------|
| `GET /api/status` | 服务健康检查 |
| `GET/POST /api/keys` | API key 管理 |
| `GET/POST /api/config` | 运行时配置 |
| `POST /api/voice/start` | 启动语音 + 激活麦克风 |
| `POST /api/voice/stop` | 停止语音 + 关闭音频 |
| `POST /api/voice/text` | 发送文字给语音 AI |
| `POST /api/computer/run` | 执行 Computer Use 任务 |
| `POST /api/computer/analyze` | 分析截图 (纯视觉) |
| `GET /api/calendar/events` | 日历事件列表 |
| `POST /api/calendar/create` | 创建日历事件 + Meet |
| `GET /api/google/scan` | 扫描本地 Google 凭据 |
| `POST /api/google/apply` | 应用扫描到的凭据 |
| `POST /api/google/set` | 手动设置 Google 凭据 |
| `POST /api/bridge/action` | 直接发送 sidecar 指令 |
| `POST /api/meeting/join` | 加入会议 (集成语音+音频桥接) |
| `POST /api/meeting/leave` | 离开会议 + 自动生成总结 + 创建任务 |
| `POST /api/meeting/validate` | 验证会议链接 |
| `GET /api/meeting/status` | 会议录制状态 |
| `POST /api/meeting/start` | 开始录制 |
| `POST /api/meeting/stop` | 停止录制 |
| `GET /api/meeting/transcript` | 获取实时转录 |
| `POST /api/meeting/summary` | 生成会议总结 |
| `POST /api/meeting/export` | 导出 Markdown |
| `GET /api/meeting/notes` | 已保存的会议笔记 |
| `POST /api/automation/run` | 通过4层路由执行指令 |
| `POST /api/automation/classify` | 意图分类 (dry-run) |
| `GET /api/automation/status` | 4 层可用性状态 |
| `POST /api/screen/share` | 开始屏幕共享 |
| `POST /api/screen/stop` | 停止屏幕共享 |
| `POST /api/screen/open` | 打开文件到屏幕 |
| `GET/POST /api/context/workspace` | 工作区上下文注入 |
| `GET /api/context/sync` | Context Sync 状态 |
| `GET /api/context/brief` | 获取上下文摘要 |
| `POST /api/context/pin` | 固定文件到上下文 |
| `POST /api/context/note` | 添加会话笔记 |
| `GET/POST /api/tasks` | 任务 CRUD |
| `GET/PATCH/DELETE /api/tasks/:id` | 单任务操作 |
| `GET /api/events` | 事件历史 |
| `GET /ws/events` | WebSocket 实时事件 |
| `POST/GET/DELETE /api/webhooks` | Webhook 管理 |

### 4.11 模块 AutomationRouter — 4 层自动化路由

| 属性 | 值 |
|------|------|
| 文件 | `src/modules/automation-router.ts` |
| 功能 | 意图分类 + 4 层自动化执行，自动降级 |

**4 层路由架构:**

| 层级 | 名称 | 延迟 | 说明 |
|------|------|------|------|
| **L1** | Shortcuts & API | <100ms | 键盘快捷键 + bash 命令，始终可用。Zoom (mute/unmute, video, share, record, chat 等)，Google Meet (mute, video)，App launch (`open -a`)，URL open。通过 regex 模式匹配。 |
| **L2** | Playwright MCP | 200-800ms | 浏览器 DOM 自动化。通过 `@playwright/mcp` subprocess (JSON-RPC over stdio)。Tab 管理、scroll、navigate、click by accessibility ref、type、snapshot。处理 Notion, GitHub, Google Slides, Docs 等。 |
| **L3** | Peekaboo | 500ms-2s | macOS 原生 GUI 自动化。窗口管理 (maximize, split view, resize)、app focus、system settings、menu interaction via AppleScript。 |
| **L4** | Computer Use (Vision) | 3-10s | Claude Vision fallback。Screenshot + Claude 分析 + pyautogui 执行。用于非标准 UI (Figma 等) 或 L1-L3 失败时。 |

**降级链:** L1 → L2 → L3 → L4

### 4.12 模块 EventBus — 事件总线

| 属性 | 值 |
|------|------|
| 文件 | `src/modules/event-bus.ts` |
| 功能 | Pub/sub 跨模块事件关联 |
| 推送 | WebSocket push to UI (`/ws/events`) |
| 关联追踪 | Correlation IDs 追踪相关事件 (如会议生命周期) |
| 事件类型 | `meeting.*`, `voice.*`, `computer.*`, `task.*`, `workspace.*` |

### 4.13 模块 TaskStore — 任务管理

| 属性 | 值 |
|------|------|
| 文件 | `src/modules/task-store.ts` |
| 功能 | 持久化任务管理 |
| 自动创建 | 从会议 action items 自动创建任务 |
| 查询 | 按 status / assignee / priority / meeting_id 查询 |
| API | CRUD via REST API (`GET/POST /api/tasks`, `GET/PATCH/DELETE /api/tasks/:id`) |

### 4.14 Playwright MCP Client — 浏览器自动化

| 属性 | 值 |
|------|------|
| 文件 | `src/mcp_client/playwright.ts` |
| 协议 | JSON-RPC subprocess client for `@playwright/mcp@latest` |
| 浏览器 | 自动 spawn Chromium 浏览器 |
| 超时 | 30s timeout per call |

**可用工具:**

| Tool | 功能 |
|------|------|
| `browser_navigate` | 导航到 URL |
| `browser_snapshot` | 获取 accessibility snapshot |
| `browser_click` | 通过 accessibility ref 点击 |
| `browser_type` | 输入文字 |
| `browser_press_key` | 按键 |
| `browser_hover` | 悬停 |
| `browser_tabs` | 列出标签页 |
| `browser_tab_new` / `browser_tab_close` | 新建/关闭标签页 |
| `browser_evaluate` | 执行 JavaScript |
| `browser_select_option` | 选择下拉选项 |
| `browser_wait_for` | 等待元素 |
| `browser_take_screenshot` | 截图 |

### 4.15 Meeting Prep Brief — 会议准备系统 (Fast/Slow Thinking)

| 属性 | 值 |
|------|------|
| 文件 | `src/skills/meeting-prep.ts`, `src/voice-persona.ts`, `src/computer-use-context.ts` |
| 架构 | System 1 (快思考) = Voice AI (OpenAI Realtime, ~300ms); System 2 (慢思考) = OpenClaw (Claude, 完整记忆, 深度推理) |

**工作流:**

```
1. 会议前准备     OpenClaw 读取 MEMORY.md + 相关文件 → 生成 MeetingPrepBrief (JSON)
2. Brief 注入     Brief 注入 Voice AI system prompt (buildVoiceInstructions())
3. 上下文关联     Brief 的 file paths/URLs 可供 Computer Use (buildComputerUseContext())
4. 会中实时更新   live notes 添加 → pushContextUpdate() → session.update → Voice AI 实时看到
5. 任务完成通知   notifyTaskCompletion() → [DONE] tag → pushed to Voice
```

**MeetingPrepBrief 结构:**

```typescript
interface MeetingPrepBrief {
  topic: string;
  goal: string;
  summary: string;
  keyPoints: string[];
  architectureDecisions: string[];
  expectedQuestions: string[];
  filePaths: string[];
  browserUrls: string[];
  folderPaths: string[];
  liveNotes: string[];
}
```

---

## 5. 实际目录结构

```
callingclaw/
├── package.json              # Bun 依赖 (openai, @anthropic-ai/sdk)
├── bun.lock
├── .env                      # API Keys + Google OAuth (gitignored)
├── .env.example              # 占位符模板
├── DEPENDENCIES.md           # 完整依赖清单
│
├── src/
│   ├── callingclaw.ts        # CLI 入口，启动全部组件 + Python 子进程
│   ├── config.ts             # 中央配置 (从 .env 读取)
│   ├── config_server.ts      # Bun.serve() HTTP 服务 + REST API
│   ├── bridge.ts             # Python Sidecar WebSocket 服务端 (:4001)
│   ├── meet_joiner.ts        # Google Meet / Zoom 自动加入 + 屏幕共享
│   │
│   ├── skills/
│   │   └── meeting-prep.ts   # Meeting Prep Brief (慢思考 → 会议准备)
│   ├── voice-persona.ts      # Voice AI Persona + 动态 Context Push
│   ├── computer-use-context.ts # Computer Use 记忆架构文档
│   ├── openclaw_bridge.ts    # OpenClaw WebSocket 桥接
│   │
│   ├── ai_gateway/
│   │   ├── realtime_client.ts      # OpenAI Realtime (Bun native WebSocket)
│   │   ├── realtime_client.test.ts # 8 tests — 连接/事件/音频/工具
│   │   └── claude_agent.ts         # Claude Computer Use (OpenRouter)
│   │
│   ├── mcp_client/
│   │   ├── google_cal.ts    # Google Calendar REST API + 凭据自动扫描
│   │   └── playwright.ts    # Playwright MCP Client (Layer 2)
│   │
│   └── modules/
│       ├── index.ts          # 模块统一导出
│       ├── auth.ts           # API key 管理
│       ├── auth.test.ts      # 2 tests
│       ├── voice.ts          # Voice 模块封装 (wraps RealtimeClient)
│       ├── vision.ts         # Vision 模块 (GPT-4o 截图分析)
│       ├── computer-use.ts   # Computer Use 模块 (Claude via OpenRouter)
│       ├── computer-use.test.ts  # 3 tests
│       ├── meeting.ts        # 会议记录 + action item 提取
│       ├── shared-context.ts # 跨模块共享状态总线
│       │   shared-context.test.ts  # 8 tests
│       ├── event-bus.ts       # 事件总线 + 关联追踪
│       ├── task-store.ts      # 持久化任务管理
│       ├── automation-router.ts # 4 层自动化路由
│       └── context-sync.ts    # OpenClaw 记忆同步
│
├── python_sidecar/
│   └── main.py               # Python 网关 (截屏/音频/键鼠，单文件)
│
└── public/
    └── callingclaw-panel.html # 控制面板 UI (Space Grotesk + lobster red)
```

---

## 6. 测试覆盖

| 测试文件 | 测试数 | 覆盖模块 |
|----------|--------|----------|
| `shared-context.test.ts` | 8 | transcript, screen, notes, events, auto-trim, reset |
| `auth.test.ts` | 2 | key masking, status |
| `computer-use.test.ts` | 3 | config check, cancel |
| `realtime_client.test.ts` | 8 | WS 连接, session events, text→audio, audio send, tool registration, disconnect |
| **合计** | **21** | |

```bash
bun test   # 全部 21 tests pass
```

---

## 7. 环境变量

| 变量 | 必需 | 说明 |
|------|------|------|
| `OPENAI_API_KEY` | 是 | Realtime 语音 + GPT-4o vision |
| `OPENROUTER_API_KEY` | 推荐 | Claude Computer Use (无需 Anthropic 账户) |
| `ANTHROPIC_API_KEY` | 可选 | 直接 Anthropic API (有账户时使用) |
| `GOOGLE_CLIENT_ID` | 自动 | 日历集成 (可自动扫描) |
| `GOOGLE_CLIENT_SECRET` | 自动 | 日历集成 (可自动扫描) |
| `GOOGLE_REFRESH_TOKEN` | 自动 | 日历集成 (可自动扫描) |
| `PORT` | 否 | HTTP 端口 (默认 4000) |
| `BRIDGE_PORT` | 否 | Python bridge 端口 (默认 4001) |
| `PYTHON_PATH` | 否 | Python 路径 (默认 /opt/miniconda3/bin/python3) |
| `SCREEN_WIDTH` | 否 | 屏幕宽度 (默认 1920) |
| `SCREEN_HEIGHT` | 否 | 屏幕高度 (默认 1080) |

---

## 8. 完整会议工作流

CallingClaw 运行在独立机器上，通过 Google Meet / Zoom 与用户进行会议。集成 Fast/Slow Thinking + 4 层自动化的完整流程：

```
1. 准备会议          MeetingPrepSkill.generate(topic) → OpenClaw 生成 Brief
2. 启动语音 + 加入   POST /api/meeting/join → 自动启动 OpenAI RT + 音频桥接 + 加入 Meet
3. 双向语音对话       meet_bridge: BH2ch (听) → OpenAI RT → BH16ch (说)
4. AI 引导讨论        Voice AI 使用 Brief 的 keyPoints + expectedQuestions 引导
5. 实时上下文更新     OpenClaw 添加 live notes → pushContextUpdate → Voice 看到
6. Computer Use       4 层路由: L1 快捷键 → L2 Playwright → L3 Peekaboo → L4 Vision
7. 任务完成通知       notifyTaskCompletion → Voice 播报 "[DONE] ..."
8. 离开 + 保存        leave_meeting → 生成 Markdown + 自动创建任务
9. 持续跟进          OpenClaw 接收 webhook → 执行任务 → 报告完成
```

### 会后 Markdown 输出示例

```markdown
# Sprint Planning Meeting

**Date:** 2026年3月10日 星期二
**Duration:** 45 minutes
**Participants:** Alice, Bob, CallingClaw

## Key Points
- 下一个迭代聚焦用户注册流程优化
- 数据库迁移计划延后一周

## Action Items
| Task | Assignee | Deadline |
|------|----------|----------|
| 完成注册页面 redesign | Alice | 3/14 |
| 准备数据迁移方案 | Bob | 3/17 |

## Follow-ups
1. 下周一 review 注册页面设计稿
2. 安排与 DBA 的迁移讨论会
```

---

## 9. 开发执行流

- [x] Step 1: Bun + Web 配置中心 (config_server + callingclaw-panel.html)
- [x] Step 2: Python Bridge (Local WS :4001，截屏 + 键鼠已联调)
- [x] Step 3: OpenAI Realtime 语音 (Bun native WS，24kHz PCM16 双向)
- [x] Step 4: Google Calendar REST API (OAuth2 自动凭据扫描，替代 MCP)
- [x] Step 5: Claude Computer Use (OpenRouter gateway，agent loop)
- [x] Step 6: 模块化拆分 (SharedContext 状态总线，5 个独立模块)
- [x] Step 7: Claude Code Skill (`/callingclaw` 命令，20+ 子命令)
- [x] Step 8: 模块接线 (callingclaw.ts 串联 VoiceModule + MeetingModule + ComputerUse + SharedContext)
- [x] Step 9: 语音转录 (input_audio_transcription: whisper-1, 实时用户语音→文字)
- [x] Step 10: 会议记录 (MeetingModule: 实时提取 action items, 会后 Markdown 导出)
- [x] Step 11: 双 BlackHole 音频桥接 (BH2ch 捕获 Meet 输出, BH16ch 回传 AI 语音)
- [x] Step 12: Meeting API (transcript/summary/export/notes 全套 REST 端点)
- [x] Step 13: 4 层自动化路由 (Shortcuts / Playwright / Peekaboo / Computer Use)
- [x] Step 14: 事件总线 + 任务管理 (EventBus + TaskStore + Webhooks)
- [x] Step 15: Playwright MCP Client (JSON-RPC subprocess, browser DOM automation)
- [x] Step 16: Meeting Prep Brief 系统 (fast/slow thinking, context sync)
- [x] Step 17: Voice Persona + 动态 Context Push (session.update mid-meeting)
- [x] Step 18: 集成会议加入流程 (voice start + audio bridge + meet join 一键完成)
- [ ] Step 19: BlackHole 手动安装 + 音频路由验证
- [ ] Step 20: 端到端集成测试 (完整会议流程)
