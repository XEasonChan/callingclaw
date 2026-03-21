# CallingClaw 2.0 — 部署与使用手册

> 面向初次使用的用户，从零开始部署和使用 CallingClaw

---

## 一、CallingClaw 是什么？

CallingClaw 是一个运行在你本机（或独立专用机器）的 AI 会议助手服务，具备以下核心能力：

| 能力 | 说明 | 需要的 Key |
|------|------|-----------|
| **语音对话** | 实时双向语音，像打电话一样和 AI 对话 | OpenAI API Key |
| **4 层电脑操作** | 键盘快捷键 → Playwright 浏览器 → macOS GUI → Claude Vision，智能路由 | OpenRouter 或 Anthropic API Key |
| **日历管理** | 查看日程、创建会议、自动加入 Google Meet / Zoom | Google OAuth 凭证 |
| **集成会议加入** | 一键启动语音 AI + 音频桥接 + 加入会议 | OpenAI + Google OAuth |
| **会议准备 Brief** | OpenClaw 深度推理生成会议准备材料，注入 Voice AI | OpenClaw 连接 |
| **会议记录与任务** | 实时转录、自动提取 action items、会后 Markdown 导出 | OpenAI API Key |

你可以通过语音告诉 AI "帮我约一个明天下午3点的会议"，它会自动创建日历事件并生成 Meet 链接。也可以一键加入已有会议：AI 语音自动参与会议讨论、记录笔记、操控屏幕演示。

---

## 二、环境要求

### 必须安装

| 软件 | 最低版本 | 安装方法 |
|------|---------|---------|
| **Bun** | 1.3+ | `curl -fsSL https://bun.sh/install \| bash` |
| **Python** | 3.10+ | macOS 自带或 `brew install python3` |
| **PortAudio** | — | `brew install portaudio`（语音需要） |

### 会议音频桥接（Meet/Zoom 必装）

AI 参与 Google Meet / Zoom 会议需要虚拟音频设备和音频切换工具：

```bash
brew install blackhole-2ch blackhole-16ch switchaudio-osx
```

> ⚠️ **安装 BlackHole 后必须重启 Mac**，否则系统不会加载虚拟音频驱动。

**验证安装：**

```bash
# 检查 BlackHole 是否被系统识别
system_profiler SPAudioDataType | grep -i blackhole
# 应显示 "BlackHole 2ch" 和 "BlackHole 16ch"

# 检查 SwitchAudioSource
SwitchAudioSource -a | grep BlackHole
# 应显示两行：BlackHole 16ch 和 BlackHole 2ch
```

如果 `system_profiler` 没有显示 BlackHole，说明安装后还未重启。请重启 Mac 后再验证。

**工作原理：**

CallingClaw 加入会议时会自动完成以下操作：

1. **保存**当前系统默认麦克风和扬声器
2. **切换**系统默认输入为 BlackHole 16ch、输出为 BlackHole 2ch
3. Chrome/Meet 自动跟随系统默认设备，形成音频桥接回路：
   ```
   Meet 扬声器 → BlackHole 2ch → Python sidecar 捕获 → OpenAI Realtime（AI 听到会议）
   OpenAI Realtime → Python sidecar 播放 → BlackHole 16ch → Meet 麦克风（AI 发言到会议）
   ```
4. **离开会议后自动恢复**原来的麦克风和扬声器设置

用户无需手动切换任何音频设备。

### 验证安装

```bash
bun --version                # 应显示 1.3.x 或更高
python3 --version            # 应显示 3.10.x 或更高
SwitchAudioSource -a         # 应列出 BlackHole 2ch 和 16ch
```

---

## 三、安装步骤

### 1. 进入项目目录

```bash
cd "CallingClaw 2.0/callingclaw"
```

### 2. 安装 Bun 依赖

```bash
bun install
```

### 3. 安装 Python 依赖

```bash
pip3 install -r requirements.txt
```

如果 pyaudio 安装失败，先装 portaudio：

```bash
brew install portaudio
pip3 install pyaudio
```

### 4. 配置环境变量

复制模板文件：

```bash
cp .env.example .env
```

用编辑器打开 `.env` 文件，填写你的 API Key：

```env
# 【必填】OpenAI — 用于语音对话
OPENAI_API_KEY=sk-你的openai密钥

# 【推荐】OpenRouter — 用于电脑操作（Computer Use）
# 在 https://openrouter.ai/keys 免费注册获取
OPENROUTER_API_KEY=sk-or-v1-你的openrouter密钥

# 【可选】Anthropic 直连 — 如果你有 Anthropic 账户
# ANTHROPIC_API_KEY=sk-ant-你的anthropic密钥

# 【可选】Google 日历 — 如果你有 OAuth 凭证
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
# GOOGLE_REFRESH_TOKEN=
```

> **没有 Key？**
> - OpenAI：前往 https://platform.openai.com/api-keys 创建
> - OpenRouter：前往 https://openrouter.ai/keys 创建（免费注册）
> - Google：如果你之前用过 OpenClaw，系统会自动发现已有凭证

---

## 四、启动服务

### 一键启动

```bash
cd "CallingClaw 2.0/callingclaw"
bun run start
```

你会看到如下输出：

```
   ██████╗ █████╗ ██╗     ██╗     ...
  ██╔════╝██╔══██╗██║     ██║     ...
                v2.0.0

[Bridge] WebSocket server on ws://localhost:4001
[Init] Launching Python sidecar...
[Sidecar] Connected to Bun bridge!
[Config] HTTP server on http://localhost:4000

╔══════════════════════════════════════════════════════╗
║  CallingClaw 2.0 is running!                        ║
║  Config UI:  http://localhost:4000                  ║
║  Press Ctrl+C to stop                               ║
╚══════════════════════════════════════════════════════╝
```

### 开发模式（热重载）

```bash
bun run dev
```

---

## 五、使用方法

### 方式一：网页控制面板

浏览器打开 **http://localhost:4000**，你会看到 CallingClaw 控制面板。

#### 配置 API Key

在 "API Keys" 区域填写：
- **OpenAI API Key** — 用于语音对话
- **Anthropic API Key** — 用于电脑操作（直连方式）
- **OpenRouter API Key** — 用于电脑操作（推荐，免费注册）

点击 **Save Keys** 保存。

#### 开始语音对话

1. 确保 OpenAI Key 已配置（顶部状态栏 "Voice" 指示灯变绿）
2. 点击 **Start Voice**
3. 对着麦克风说话，AI 会实时语音回复
4. 你也可以在文本框输入文字发送给 AI
5. 点击 **Stop** 结束语音

#### 电脑操作

1. 确保 OpenRouter 或 Anthropic Key 已配置
2. 在 "Computer Use" 区域输入指令，例如：
   - "打开 Chrome 搜索今天的天气"
   - "打开微信发消息给张三"
3. 点击 **Execute**，AI 会分析屏幕并自动操作

### 方式二：命令行

所有功能都可以通过 `curl` 调用 REST API：

```bash
# 检查服务状态
curl -s http://localhost:4000/api/status | python3 -m json.tool

# 开始语音对话
curl -s -X POST http://localhost:4000/api/voice/start \
  -H "Content-Type: application/json" \
  -d '{"instructions": "你是一个友好的中文助手"}'

# 停止语音
curl -s -X POST http://localhost:4000/api/voice/stop

# 发送文字给语音 AI
curl -s -X POST http://localhost:4000/api/voice/text \
  -H "Content-Type: application/json" \
  -d '{"text": "帮我约一个明天下午3点的会议"}'

# 一键加入会议（自动启动语音 + 音频桥接 + 加入 Meet）
curl -s -X POST http://localhost:4000/api/meeting/join \
  -H "Content-Type: application/json" \
  -d '{"url": "https://meet.google.com/abc-defg-hij"}'

# 离开会议（自动生成总结 + 创建任务）
curl -s -X POST http://localhost:4000/api/meeting/leave | python3 -m json.tool

# 通过 4 层自动化路由执行电脑操作
curl -s -X POST http://localhost:4000/api/automation/run \
  -H "Content-Type: application/json" \
  -d '{"instruction": "切换到下一个浏览器标签"}'

# 旧版 Computer Use（纯视觉 fallback）
curl -s -X POST http://localhost:4000/api/computer/run \
  -H "Content-Type: application/json" \
  -d '{"instruction": "打开 Safari 浏览器"}'

# 查看日历事件
curl -s http://localhost:4000/api/calendar/events | python3 -m json.tool

# 查看会议转录
curl -s "http://localhost:4000/api/meeting/transcript?count=20" | python3 -m json.tool

# 生成会议总结
curl -s -X POST http://localhost:4000/api/meeting/summary | python3 -m json.tool
```

---

## 六、Google 日历配置

### 自动发现（推荐）

如果你之前使用过 OpenClaw 或有 Google OAuth 凭证，CallingClaw 可以自动发现：

```bash
# 扫描本机已有的 Google 凭证
curl -s http://localhost:4000/api/google/scan | python3 -m json.tool

# 找到后一键应用
curl -s -X POST http://localhost:4000/api/google/apply | python3 -m json.tool
```

### 手动配置

如果自动扫描未找到凭证，你需要创建 Google Cloud OAuth 项目：

1. 前往 [Google Cloud Console](https://console.cloud.google.com/)
2. 创建项目 → 启用 Google Calendar API
3. 创建 OAuth 2.0 客户端 ID（桌面应用类型）
4. 下载凭证获取 Client ID 和 Client Secret
5. 使用 OAuth Playground 获取 Refresh Token
6. 填入 `.env` 或通过 API 设置：

```bash
curl -s -X POST http://localhost:4000/api/google/set \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "你的client_id",
    "client_secret": "你的client_secret",
    "refresh_token": "你的refresh_token"
  }'
```

---

## 七、音频设备配置

### 语音对话（直连模式）

默认使用系统默认麦克风和扬声器，适合一对一和 AI 对话。如果你使用 AirPods：

1. macOS **系统设置 → 声音** 中将输入和输出设为 AirPods
2. 确认 **系统设置 → 隐私与安全性 → 麦克风** 中已允许终端访问

### Google Meet / Zoom 音频桥接（全自动）

> **前提：** 已安装 `blackhole-2ch`、`blackhole-16ch`、`switchaudio-osx`（见第二节）

CallingClaw 加入会议时 **全自动完成音频配置**，用户无需手动操作：

```bash
# 一键：启动 Voice AI + 自动切换音频设备 + 加入会议
curl -s -X POST http://localhost:4000/api/meeting/join \
  -H "Content-Type: application/json" \
  -d '{"url": "https://meet.google.com/abc-defg-hij"}'
```

**自动执行的步骤：**

| 步骤 | 操作 | 说明 |
|------|------|------|
| 1 | 保存当前音频设备 | 记住你原来的麦克风和扬声器 |
| 2 | 系统输入 → BlackHole 16ch | AI 语音输出进入 Meet 麦克风 |
| 3 | 系统输出 → BlackHole 2ch | Meet 音频被 AI 捕获 |
| 4 | 启动 OpenAI Realtime 语音 | GPT-4o 实时语音会话 |
| 5 | 配置 Python sidecar | `meet_bridge` 音频模式 |
| 6 | 打开 Chrome 加入会议 | 自动关闭摄像头和麦克风 |

**离开会议时自动恢复：**

```bash
curl -s -X POST http://localhost:4000/api/meeting/leave
# 自动：生成总结 → 导出笔记 → 恢复原音频设备
```

系统会自动把麦克风和扬声器切回加入会议前的设备。

**音频路由原理：**

```
┌─────────────────────────────────────────────────────────────┐
│                    音频桥接回路                               │
│                                                             │
│  Meet 参与者说话                                             │
│       │                                                     │
│       ▼                                                     │
│  Meet 扬声器输出 → [系统默认输出: BlackHole 2ch]              │
│       │                                                     │
│       ▼                                                     │
│  Python sidecar 从 BlackHole 2ch 捕获音频                    │
│       │                                                     │
│       ▼                                                     │
│  OpenAI Realtime (GPT-4o) 听到 → 思考 → 生成语音回复         │
│       │                                                     │
│       ▼                                                     │
│  Python sidecar 将 AI 语音播放到 BlackHole 16ch              │
│       │                                                     │
│       ▼                                                     │
│  [系统默认输入: BlackHole 16ch] → Meet 麦克风输入             │
│       │                                                     │
│       ▼                                                     │
│  Meet 参与者听到 AI 发言                                     │
└─────────────────────────────────────────────────────────────┘
```

**手动分步操作（高级用户）：**

```bash
# 先启动语音（meet_bridge 模式）
curl -s -X POST http://localhost:4000/api/voice/start \
  -H "Content-Type: application/json" \
  -d '{"audio_mode": "meet_bridge"}'

# 再加入会议
curl -s -X POST http://localhost:4000/api/meeting/join \
  -H "Content-Type: application/json" \
  -d '{"url": "https://meet.google.com/abc-defg-hij"}'
```

### 音频故障排查

| 问题 | 原因 | 解决 |
|------|------|------|
| AI 听不到会议内容 | BlackHole 2ch 未被系统识别 | 重启 Mac |
| Meet 里听不到 AI 声音 | BlackHole 16ch 未被系统识别 | 重启 Mac |
| `SwitchAudioSource` 找不到 | 未安装 | `brew install switchaudio-osx` |
| 加入会议后自己听不到声音 | 系统输出被切到 BlackHole | 正常现象，离开会议后自动恢复 |
| 希望自己也能同时听到会议 | 需要 Multi-Output Device | 见下方说明 |

**同时监听会议（可选）：**

如果你想在 AI 参会的同时自己也听到会议音频，需要创建一个 Multi-Output Device：

1. 打开 **Audio MIDI Setup**（`open -a "Audio MIDI Setup"`）
2. 点左下角 **+** → **Create Multi-Output Device**
3. 勾选 **BlackHole 2ch** + **外置耳机**（或你的扬声器）
4. 在系统设置中将输出设为这个 Multi-Output Device

这样 Meet 音频会同时流向 BlackHole 2ch（AI 捕获）和你的耳机（你听到）。

---

## 八、macOS 权限设置

首次运行时，macOS 会弹窗请求以下权限：

| 权限 | 用途 | 设置位置 |
|------|------|---------|
| **麦克风** | 语音输入 | 系统设置 → 隐私与安全性 → 麦克风 |
| **辅助功能** | 鼠标键盘控制 | 系统设置 → 隐私与安全性 → 辅助功能 |
| **屏幕录制** | 截屏分析 | 系统设置 → 隐私与安全性 → 屏幕录制 |

请确保终端 (Terminal / iTerm2 / VS Code) 已获得上述权限。

---

## 九、常见问题

### 启动时提示端口被占用

```
error: Failed to start server. EADDRINUSE
```

上一次的 CallingClaw 没有正常关闭。查找并关闭：

```bash
lsof -i :4000 -i :4001 | grep LISTEN
# 找到 PID 后
kill <PID>
```

### 语音没有声音

1. 检查 OpenAI Key 是否正确：`curl -s http://localhost:4000/api/keys`
2. 检查麦克风权限（见第八节）
3. 查看终端日志是否有 `[Audio] Failed to open microphone` 错误

### Meet 会议里 AI 没有声音

1. 确认 BlackHole 已安装且重启过 Mac：`system_profiler SPAudioDataType | grep -i blackhole`
2. 确认 SwitchAudioSource 已安装：`which SwitchAudioSource`
3. 检查当前系统音频设备：`SwitchAudioSource -c` 和 `SwitchAudioSource -c -t input`
4. 加入会议后应显示：输出=BlackHole 2ch，输入=BlackHole 16ch
5. 如果设备未切换，手动测试：`SwitchAudioSource -s "BlackHole 2ch" -t output && SwitchAudioSource -s "BlackHole 16ch" -t input`

### Computer Use 不工作

1. 确保有 OpenRouter 或 Anthropic Key
2. 确保终端有"辅助功能"和"屏幕录制"权限
3. 如果提示 key 未配置，检查控制面板或 `.env` 文件

### Python sidecar 连接不上

1. 检查 Python 路径：`which python3`
2. 如果 Python 不在默认路径，在 `.env` 中设置：`PYTHON_PATH=/你的python3路径`
3. 确认 Python 依赖已安装：`pip3 install -r requirements.txt`

---

## 十、停止服务

在终端按 **Ctrl + C** 即可优雅停止所有组件。

---

## 十一、架构概览

```
用户 (语音/面板)
       │
       ▼
┌──────────────────────────────────────────┐
│        CallingClaw Bun 主进程 (:4000)     │
│                                          │
│  VoiceModule ←→ OpenAI Realtime          │
│  (快思考 System 1, ~300ms)                │
│                                          │
│  AutomationRouter (4 层自动化路由)        │
│    L1: Shortcuts   — 键盘快捷键, <100ms  │
│    L2: Playwright  — 浏览器 DOM, ~500ms  │
│    L3: Peekaboo    — macOS GUI, ~1s      │
│    L4: Claude CU   — 视觉 fallback, ~5s │
│                                          │
│  MeetingPrepSkill  — 会议准备 Brief       │
│  MeetJoiner        — Meet/Zoom 自动加入   │
│  EventBus + TaskStore — 事件+任务管理     │
│  GoogleCalendar    — 日历 REST API        │
└────────────┬─────────────────────────────┘
             │ WebSocket :4001
             ▼
┌──────────────────────────────────────────┐
│        Python Sidecar (:4001)            │
│  Audio (PyAudio + BlackHole) │ Screen    │
│  Mouse/Keyboard (pyautogui)  │ (mss)    │
└──────────────────────────────────────────┘
             ▲
             │ HTTP :4000
┌──────────────────────────────────────────┐
│  OpenClaw (慢思考 System 2)               │
│  深度推理 + MEMORY.md + 文件系统          │
│  → 生成会议 Brief → 推送到 Voice AI      │
└──────────────────────────────────────────┘
```
