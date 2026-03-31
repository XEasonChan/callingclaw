# OpenAI Realtime API 原理与非实时模型对比

## 核心区别：实时 vs 非实时

### 非实时模型（Chat Completions API）

```
用户输入文本 ──HTTP POST──> 服务端处理 ──HTTP Response──> 返回文本
```

- **协议**: HTTP 请求/响应（或 SSE 流式）
- **输入输出**: 纯文本（或图片），不支持原生音频
- **延迟**: 每次交互需要完整的请求-响应周期
- **语音流程**: 需要 3 个独立系统串联
  ```
  用户说话 → [STT: Whisper] → 文本 → [LLM: GPT-4o] → 文本 → [TTS: 语音合成] → 播放
  ```
  每个环节都有延迟，总延迟通常 2-5 秒

### 实时模型（Realtime API）

```
音频流 ←──WebSocket 双向──→ 服务端（STT + LLM + TTS 一体化）
```

- **协议**: WebSocket 持久连接，全双工
- **输入输出**: 原生音频流（PCM16），同时支持文本
- **延迟**: 音频直接流入流出，端到端延迟 ~300-500ms
- **语音流程**: 单一模型原生处理
  ```
  用户说话 → [GPT-4o-realtime: 听 + 想 + 说] → 播放
  ```
  没有中间转换，模型直接"听懂"音频并"说出"回复

### 对比总结

| 特性 | Chat Completions (非实时) | Realtime API (实时) |
|------|--------------------------|-------------------|
| 协议 | HTTP/SSE | WebSocket |
| 输入 | 文本/图片 | 音频流 + 文本 |
| 输出 | 文本（需额外 TTS） | 音频流 + 文本转录 |
| 延迟 | 2-5 秒（STT+LLM+TTS） | 300-500ms（原生） |
| 打断 | 不支持 | 服务端 VAD 实时检测 |
| 连接模式 | 无状态，每次请求独立 | 有状态，持续会话 |
| 上下文窗口 | 取决于模型（128K-1M） | ~128K tokens |
| 工具调用 | function calling | 同样支持，但在音频流中 |
| 费用 | 按 token 计费 | 按时间+token（~$0.30/min） |

---

## CallingClaw 中的实现

### WebSocket 连接生命周期

```
1. 建立连接
   ws = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview")
   Headers: Authorization + OpenAI-Beta: realtime=v1

2. 发送 session.update（仅在连接时发一次）
   - modalities: ["text", "audio"]
   - voice: "marin"
   - input/output_audio_format: "pcm16"
   - input_audio_transcription: { model: "whisper-1" }
   - instructions: 系统提示词 (Layer 0)
   - tools: 工具定义数组
   - turn_detection: { type: "server_vad", threshold, silence_duration_ms }

3. 双向音频流
   客户端 → 服务端: input_audio_buffer.append { audio: "<base64 PCM16>" }
   服务端 → 客户端: response.audio.delta { delta: "<base64 PCM16>" }

4. 断线自动重连（最多 3 次，线性退避）
   - 重新发送 session.update
   - 回放上下文队列（最近 15 条）
   - 回放转录历史（最近 20 条）
```

### 音频规格

CallingClaw 全链路统一使用：
- **采样率**: 24000 Hz
- **声道**: 单声道 (mono)
- **位深**: 16-bit 有符号整数 (PCM16)
- **编码**: base64 传输

### 服务端 VAD（语音活动检测）

服务端自动检测用户是否在说话，无需客户端判断：

```
threshold:          0.6    (灵敏度，0-1，越高越不敏感)
prefix_padding_ms:  300    (语音前保留的静音毫秒数)
silence_duration_ms: 800   (静音多久后判定说完)
```

这使得"打断"成为可能——用户随时开口，AI 立即停止说话。

---

## 语音状态机

CallingClaw 的 VoiceModule 管理 5 个状态：

```
idle ──(session.updated)──> listening
          ↑                    │
          │            (用户说话, 服务端开始生成)
          │                    ↓
          │               thinking
          │                    │
          │            (第一个音频 delta)
          │                    ↓
          │               speaking ──(用户打断)──> interrupted
          │                    │                       │
          │            (音频播完)                 (取消响应)
          └────────────────────┘───────────────────────┘
```

### 打断处理（Interruption）

当 AI 正在说话时，用户开口：
1. 服务端发送 `input_audio_buffer.speech_started`
2. 计算"已听比例"（考虑 150ms 播放延迟）：
   ```
   heardRatio = (已播放时间 - 150ms) / 总音频时长
   ```
3. 截断 AI 转录到用户实际听到的部分
4. 发送 `response.cancel` 取消当前响应
5. 状态切换: speaking → interrupted → listening

---

## 5 层上下文模型

**关键约束**: 会议中**永远不用 `session.update`**（会导致音频中断），运行时上下文全部通过 `conversation.item.create` 注入。

| 层 | 内容 | 注入方式 | Token 预算 |
|---|------|---------|-----------|
| **L0** | 核心身份（不可改） | `session.update` instructions（仅连接时） | <250 |
| **L1** | 工具定义 | `session.update` tools 数组（仅连接时） | ~300 |
| **L2** | 任务上下文（会议 brief） | `conversation.item.create`（一次） | <500 |
| **L3** | 实时上下文（FIFO 队列） | `conversation.item.create`（增量） | <3000 |
| **L4** | 对话历史 | Realtime API 自动管理 | ~124K |

### Layer 3 FIFO 管理
- 最多 15 条上下文项
- 超出时删除最旧的（`conversation.item.delete`）
- 80% token 容量时告警，90% 时自动压缩（删一半）
- 来源标记: `[CONTEXT]` 知识检索、`[SCREEN]` 屏幕描述、`[DONE]` 工具结果、`[NOTE]` 笔记

---

## 工具调用在实时 API 中的工作方式

### 与 Chat API 的区别

**Chat Completions**: 模型返回 JSON → 客户端执行 → 再次请求
**Realtime API**: 模型在音频流中发起工具调用 → 客户端执行 → 通过 WebSocket 提交结果 → 模型继续说话

### 调用流程

```
1. 服务端: response.function_call_arguments.done
   { call_id: "call_xyz", name: "join_meeting", arguments: '{"meet_url":"..."}' }

2. 客户端执行工具，提交结果:
   conversation.item.create { type: "function_call_output", call_id, output: "..." }
   response.create {}  ← 触发模型基于结果继续回复

3. 服务端: 模型生成新的音频回复
```

### 快慢工具分离

| 类型 | 工具 | 处理方式 |
|------|------|---------|
| **快速** | join_meeting, check_calendar, recall_context | 同步等待结果，模型阻塞 |
| **慢速** | browser_action, computer_action, take_screenshot | 立即回复"正在处理"，后台执行，结果通过 Layer 3 注入 |

---

## 多 Provider 支持

CallingClaw 通过 `RealtimeProviderConfig` 接口统一 OpenAI 和 Grok：

| 特性 | OpenAI | Grok |
|------|--------|------|
| WebSocket URL | `wss://api.openai.com/v1/realtime` | `wss://api.x.ai/v1/realtime` |
| 音频事件命名 | 标准名称 | 3 个事件不同（通过 eventMap 归一化） |
| 会话配置格式 | 扁平结构 `input_audio_format` | 嵌套结构 `audio.input.format` |
| 可用声音 | marin, echo, sage 等 | Eve, Ara, Rex, Sal, Leo |
| 原生工具 | 无 | web_search, x_search（免费） |
| 转录模型 | whisper-1 | grok-2-audio |
| 会话时长上限 | 120 分钟 | 30 分钟（自动重连处理） |
| VAD 灵敏度 | 0.6（更敏感） | 0.9（更保守） |
| 费用 | ~$0.30/分钟 | ~$0.05/分钟（6 倍便宜） |
| 项目默认 | 否 | 是 (`CONFIG.voiceProvider = "grok"`) |

VoiceModule 完全不感知底层 provider，通过归一化层实现透明切换。

---

## 断线重连与上下文恢复

```
1. WebSocket 意外断开
2. 线性退避重试（3s × 次数，最多 3 次）
3. 新连接建立，发送 session.update（干净的 Layer 0）
4. 等待 session.updated 确认
5. 回放上下文队列（_contextQueue, 最多 15 条）
6. 回放转录历史（_transcriptContext, 最近 20 条）
7. 模型恢复完整状态，对话无缝继续
```

---

## 关键文件索引

| 文件 | 职责 |
|------|------|
| `src/ai_gateway/realtime_client.ts` | WebSocket 客户端、会话生命周期、上下文注入 |
| `src/modules/voice.ts` | 状态机、事件处理、打断逻辑 |
| `src/ai_gateway/voice-events.ts` | 类型化事件 schema |
| `src/config.ts` | Provider URL、API Key、音频格式 |
| `src/prompt-constants.ts` | Layer 0 核心身份提示词 |
| `CONTEXT-ENGINEERING.md` | 5 层上下文模型完整文档 |
| `src/modules/voice-trace.ts` | 逐 turn 的延迟观测指标 |
