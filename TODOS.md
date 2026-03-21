# TODOS

## Backend: Emit meeting.summary_ready WebSocket event
**Priority:** P1
**Owner:** Backend agent
**Context:** When a meeting ends, the frontend receives `meeting.ended` but the summary file is generated asynchronously afterwards. The frontend currently has no way to know when the summary file is ready. The backend should emit a `meeting.summary_ready` event (with `meetingId` and optionally `filePath`) once the summary markdown file has been written to shared storage. Until this is implemented, the frontend summary tab may show stale "pending" state after meeting end.
**Why:** Without this event, the user has to manually refresh to see the meeting summary. This breaks the "consistent file asset" mental model — prep appears automatically but summary doesn't.
**Depends on:** Backend WS event bus, summary generation pipeline
**Added:** 2026-03-19
**Completed:** v2.5.x (2026-03-21) — Implemented in callingclaw.ts: `eventBus.emit("meeting.summary_ready", { filepath, title, timestamp })`. Desktop renderer and meeting-tools.ts both consume this event.

## Frontend: Generalize tabbed side panel for multi-doc contexts
**Priority:** P2
**Owner:** Frontend agent
**Context:** The tabbed side panel (Live Feed / Prep / Summary) is built specifically for the meeting use case. If other features need multi-document side panels (e.g., viewing multiple related docs, comparing versions), the tab system could be generalized into a reusable pattern. Currently only one use case exists — generalize when a second appears.
**Why:** Avoid premature abstraction, but track the pattern so we don't rebuild it from scratch.
**Depends on:** A second use case emerging
**Added:** 2026-03-19

## Electron: Migrate from file:// to app:// custom protocol
**Priority:** P2
**Owner:** Frontend agent
**Context:** Electron 当前用 `win.loadFile('index.html')` 加载 renderer（file:// 协议）。AudioWorklet 的 `addModule()` 对 file:// 支持不稳定，当前用 Blob URL 内联 worklet 代码绕过。Electron 官方推荐用 `protocol.registerSchemesAsPrivileged()` 注册 `app://` scheme 并标记 standard + secure，然后 `win.loadURL('app://index.html')`。这样 AudioWorklet、fetch、Service Worker、流媒体等都能正常工作。
**Why:** Blob URL 方案可用但 worklet 代码内联为字符串不直观，且某些 CSP 策略下可能被拦。`app://` 是更正规的基础设施方案，受益面广（不只音频）。当前 Blob URL 已验证功能可用，升级为 P2。
**What to change:** (1) main/index.js: `protocol.registerSchemesAsPrivileged([{scheme:'app',privileges:{standard:true,secure:true}}])` 在 app.ready 之前调用 (2) 注册 protocol handler 映射 `app://` → renderer 文件目录 (3) `win.loadURL('app://index.html')` 替代 `win.loadFile()` (4) audio-bridge.js 的 worklet 改为 `addModule('app://pcm-processor-worklet.js')` (5) 将 pcm-processor-worklet.js 复制到 renderer 目录
**Depends on:** 当前 Blob URL 方案功能验证通过
**Added:** 2026-03-20

## Voice: Haiku context compression for meeting instructions
**Priority:** P2
**Owner:** Backend agent
**Context:** 当前 voice session 的 system instructions 要么是完整的 OpenClaw memory dump（~1600 tokens，包含色号、文件路径等无关信息），要么是精简的通用 persona（~100 tokens，缺少会议上下文）。对 Grok 的较小 context window（估计 8-32K tokens）尤其浪费。应该用 Haiku 按会议主题从 full memory 中提取相关上下文，生成 ~300 token 的精准摘要。
**Why:** 减少 token 浪费 94%，同时保持会议相关性。Haiku 调用 ~200ms，不影响启动延迟。
**What to change:** voice-persona.ts 加 `compressInstructionsForMeeting(topic, fullContext)` 函数，Talk Locally 和 Meet Join 启动时调用。
**Depends on:** OpenRouter API key（已有）、Haiku model access
**Added:** 2026-03-20
