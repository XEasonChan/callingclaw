# CallingClaw 2.0 — 部署与使用手册

> 面向初次使用的用户，从零开始部署和使用 CallingClaw

---

## 一、CallingClaw 是什么？

CallingClaw 是一个运行在你本机的 AI 会议助手，具备以下核心能力：

| 能力 | 说明 | 需要的 Key |
|------|------|-----------|
| **语音对话** | 实时双向语音，像打电话一样和 AI 对话 | OpenAI API Key |
| **屏幕视觉** | Gemini Flash 实时截屏分析，理解幻灯片、代码、图表 | OpenRouter API Key |
| **电脑操作** | 语音触发文件打开、屏幕共享、滚动、点击 | OpenRouter 或 Anthropic API Key |
| **日历管理** | 查看日程、创建会议、自动加入 Google Meet | Google OAuth 凭证 |
| **会议准备** | OpenClaw 深度推理生成会议准备材料，注入 Voice AI | OpenClaw 连接 |
| **会议记录与任务** | 实时转录、自动提取 action items、会后结构化总结 | OpenAI API Key |

你可以通过语音告诉 AI "帮我约一个明天下午3点的会议"，它会自动创建日历事件并生成 Meet 链接。也可以一键加入已有会议：AI 语音自动参与会议讨论、记录笔记、操控屏幕演示。

---

## 二、环境要求

### 必须安装

| 软件 | 最低版本 | 安装方法 |
|------|---------|---------|
| **Bun** | 1.3+ | `curl -fsSL https://bun.sh/install \| bash` |
| **Google Chrome** | Latest | [chrome.google.com](https://www.google.com/chrome/) |

> **注意：** CallingClaw 使用 Playwright 库控制 Chrome 加入会议并注入音频。不需要安装任何虚拟音频驱动（BlackHole 已在 v2.7.12 移除）。

### 验证安装

```bash
bun --version                # 应显示 1.3.x 或更高
```

---

## 三、安装步骤

### 1. 一键安装（推荐）

```bash
./scripts/setup.sh
```

这会自动完成：安装 Bun、安装依赖、配置 .env、检测 OpenClaw。

### 2. 手动安装

```bash
# 进入项目目录
cd "CallingClaw 2.0/callingclaw-backend"

# 安装依赖
bun install

# 配置环境变量
cp .env.example .env
```

用编辑器打开 `.env` 文件，填写你的 API Key：

```env
# 【必填】OpenAI — 用于语音对话
OPENAI_API_KEY=sk-你的openai密钥

# 【推荐】OpenRouter — 用于屏幕视觉和电脑操作
OPENROUTER_API_KEY=sk-or-v1-你的openrouter密钥

# 【可选】Anthropic 直连
# ANTHROPIC_API_KEY=sk-ant-你的anthropic密钥

# 【可选】Google 日历
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
# GOOGLE_REFRESH_TOKEN=
```

> **没有 Key？**
> - OpenAI：前往 https://platform.openai.com/api-keys 创建
> - OpenRouter：前往 https://openrouter.ai/keys 创建（免费注册）

---

## 四、启动服务

### 一键启动

```bash
./scripts/start.sh
```

### 开发模式（热重载）

```bash
cd callingclaw-backend && bun --hot run src/callingclaw.ts
```

### 启动桌面应用

```bash
cd callingclaw-desktop && npm start
```

### 健康检查

```bash
curl http://localhost:4000/api/status
```

---

## 五、使用方法

### 方式一：桌面应用

启动后在系统托盘中打开 CallingClaw 桌面应用，包含：
- API Key 配置
- 一键加入会议
- 语音控制
- 实时转录显示

### 方式二：REST API

所有功能都可以通过 REST API 调用：

```bash
# 检查服务状态
curl -s http://localhost:4000/api/status | python3 -m json.tool

# 一键加入会议（自动启动语音 + 加入 Meet）
curl -s -X POST http://localhost:4000/api/meeting/join \
  -H "Content-Type: application/json" \
  -d '{"url": "https://meet.google.com/abc-defg-hij"}'

# 离开会议（自动生成总结 + 创建任务）
curl -s -X POST http://localhost:4000/api/meeting/leave | python3 -m json.tool

# 开始语音对话
curl -s -X POST http://localhost:4000/api/voice/start \
  -H "Content-Type: application/json" \
  -d '{"instructions": "你是一个友好的中文助手"}'

# 停止语音
curl -s -X POST http://localhost:4000/api/voice/stop

# 查看日历事件
curl -s http://localhost:4000/api/calendar/events | python3 -m json.tool

# 查看会议转录
curl -s "http://localhost:4000/api/meeting/transcript?count=20" | python3 -m json.tool
```

---

## 六、Google 日历配置

### 自动发现（推荐）

如果你之前使用过 OpenClaw 或有 Google OAuth 凭证，CallingClaw 可以自动发现：

```bash
curl -s http://localhost:4000/api/google/scan | python3 -m json.tool
curl -s -X POST http://localhost:4000/api/google/apply | python3 -m json.tool
```

### 手动配置

1. 前往 [Google Cloud Console](https://console.cloud.google.com/)
2. 创建项目 → 启用 Google Calendar API
3. 创建 OAuth 2.0 客户端 ID（桌面应用类型）
4. 下载凭证获取 Client ID 和 Client Secret
5. 使用 OAuth Playground 获取 Refresh Token
6. 填入 `.env` 或通过 API 设置

---

## 七、音频架构

CallingClaw 使用 **Playwright 浏览器级音频注入**，不需要任何虚拟音频驱动。

### 工作原理

```
┌─────────────────────────────────────────────────────────────┐
│              Playwright Audio Injection (v2.7.12+)          │
│                                                             │
│  Meet 参与者说话                                             │
│       │                                                     │
│       ▼                                                     │
│  RTCPeerConnection audio track (muted=false)                │
│       │                                                     │
│       ▼                                                     │
│  AudioWorklet capture → PCM16 24kHz                         │
│       │                                                     │
│       ▼                                                     │
│  WebSocket → Backend → Voice AI (OpenAI/Gemini/Grok)        │
│       │                                                     │
│       ▼                                                     │
│  AI 语音回复 → base64 audio                                  │
│       │                                                     │
│       ▼                                                     │
│  WebSocket → Ring Buffer AudioWorklet → replaceTrack()      │
│       │                                                     │
│       ▼                                                     │
│  Meet 参与者听到 AI 发言                                     │
└─────────────────────────────────────────────────────────────┘
```

关键文件：
- `public/meet-audio-inject.js` — 音频注入编排
- `public/playback-worklet.js` — Ring buffer worklet
- `src/chrome-launcher.ts` — 通过 `addInitScript()` 在 Chrome 启动时注入

---

## 八、macOS 权限设置

首次运行时，macOS 会请求以下权限：

| 权限 | 用途 | 设置位置 |
|------|------|---------|
| **麦克风** | 语音输入（直连模式） | 系统设置 → 隐私与安全性 → 麦克风 |
| **辅助功能** | 鼠标键盘控制 | 系统设置 → 隐私与安全性 → 辅助功能 |
| **屏幕录制** | 截屏分析 | 系统设置 → 隐私与安全性 → 屏幕录制 |

请确保终端 (Terminal / iTerm2 / VS Code) 和 CallingClaw 桌面应用已获得上述权限。

> **注意：** 开发模式（`com.github.electron`）和生产模式（`com.tanka.callingclaw`）使用不同的 Bundle ID，TCC 权限不互通。

---

## 九、常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| 端口被占用 | 上次未正常关闭 | `lsof -i :4000 \| grep LISTEN` → `kill <PID>` |
| AI 听不到会议内容 | 音频 track 选择错误 | 检查日志 `[AudioInject]`，确认选中了 `muted=false` 的 track |
| Meet 里听不到 AI 声音 | replaceTrack 失败 | 检查日志 `[AudioInject] replaceTrack` |
| 语音没有声音 | OpenAI Key 无效 | `curl -s http://localhost:4000/api/status` 检查 Key 状态 |
| 截屏分析无内容 | 屏幕录制权限未授予 | 系统设置 → 屏幕录制 → 勾选应用 |
| 无法控制鼠标键盘 | 辅助功能权限未授予 | 系统设置 → 辅助功能 → 勾选应用 |
| Chrome 加入 Meet 被拦截 | 自动化检测 | ChromeLauncher 已内置 `--disable-blink-features=AutomationControlled` |

---

## 十、架构概览

```
用户 (语音/桌面应用)
       │
       ▼
┌──────────────────────────────────────────┐
│        CallingClaw Bun Backend (:4000)    │
│                                          │
│  VoiceModule ←→ OpenAI Realtime / Gemini │
│  (System 1, ~300ms)                      │
│                                          │
│  VisionModule — Gemini Flash 截屏分析     │
│  ContextRetriever — Haiku 缺口检测       │
│  TranscriptAuditor — Haiku 意图分类      │
│  ComputerUseModule — Haiku/Sonnet 操控   │
│                                          │
│  Browser (Dual Chrome):                  │
│    Chrome #1: Playwright — Meet 加入     │
│      + 音频注入 + 屏幕共享               │
│    Chrome #2: OpenCLI — 隔离执行环境     │
│                                          │
│  MeetingPrepSkill — 会议准备 Brief       │
│  MeetingScheduler — 日历自动加入         │
│  EventBus + TaskStore — 事件+任务管理    │
│  GoogleCalendar — 日历 REST API          │
└────────────┬─────────────────────────────┘
             │
┌────────────┴─────────────────────────────┐
│  Electron Desktop App                     │
│  AudioWorklet (capture + playback)        │
│  WebSocket ←→ Backend                     │
└──────────────────────────────────────────┘
             │
┌────────────┴─────────────────────────────┐
│  OpenClaw (System 2, 慢思考)              │
│  深度推理 + MEMORY.md + 文件系统          │
│  → 会前 Brief → 会后总结 → 任务执行      │
└──────────────────────────────────────────┘
```
