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

## Backend: Migrate meet_joiner.ts from osascript to Playwright
**Priority:** P1
**Owner:** Backend agent
**Context:** meet_joiner.ts currently uses 20+ osascript-based Chrome JS injection calls to join Google Meet — running shell-escaped AppleScript that executes JavaScript in Chrome's active tab. This is the most fragile code in the codebase: timing-dependent, breaks if Chrome UI changes, and the string escaping is unmaintainable. Playwright (already integrated) handles all of this natively via CDP with proper selectors, waits, and error handling. The playwright-browser.test.ts already demonstrates Meet join via Playwright with device selection and settings configuration.
**Why:** The osascript join flow is the #2 fragility source after the sidecar itself. Now that the sidecar is eliminated (NativeBridge), the osascript→Playwright migration is the next reliability win.
**What to change:** (1) Replace `Bun.$`osascript...`` calls in joinGoogleMeet() with PlaywrightCLI.execute() calls (2) Use Playwright selectors instead of JS injection for button clicks, device selection (3) Keep Zoom flow as-is (uses native app, not browser) (4) Update tests
**Depends on:** NativeBridge migration (must be stable first)
**Added:** 2026-03-21
**Completed:** v2.7.13 (2026-03-26) — ChromeLauncher.joinGoogleMeet() replaces both osascript and playwright-cli for Google Meet. Uses Playwright library page.evaluate() directly. MeetJoiner (osascript) retained as final fallback only.

## Voice: Haiku context compression for meeting instructions
**Priority:** P2
**Owner:** Backend agent
**Context:** 当前 voice session 的 system instructions 要么是完整的 OpenClaw memory dump（~1600 tokens，包含色号、文件路径等无关信息），要么是精简的通用 persona（~100 tokens，缺少会议上下文）。对 Grok 的较小 context window（估计 8-32K tokens）尤其浪费。应该用 Haiku 按会议主题从 full memory 中提取相关上下文，生成 ~300 token 的精准摘要。
**Why:** 减少 token 浪费 94%，同时保持会议相关性。Haiku 调用 ~200ms，不影响启动延迟。
**What to change:** voice-persona.ts 加 `compressInstructionsForMeeting(topic, fullContext)` 函数，Talk Locally 和 Meet Join 启动时调用。
**Depends on:** OpenRouter API key（已有）、Haiku model access
**Added:** 2026-03-20

## Voice: Proactive Grok session rotation (zero-gap)
**Priority:** P2
**Owner:** Backend agent
**Context:** Grok has a 30-minute session limit. Currently, when the session expires, the backend creates a new one with a ~2-3 second gap where no AI audio is generated. During this gap, the ring buffer drains and participants hear a brief silence. Proactive rotation would start a new session at ~28 minutes (before expiry), overlap with the old session for a smooth handoff, and eliminate the gap entirely.
**Why:** Improves UX for long meetings. Current behavior is acceptable (sounds like AI is thinking), but seamless rotation would be unnoticeable.
**What to change:** (1) Track session age in realtime_client.ts (2) At 28min mark, create new session in parallel (3) Let old session finish current response (4) Swap audio output to new session (5) Close old session. Needs concurrent WS management and context replay to new session.
**Depends on:** WebRTC audio injection (replaceTrack approach) working first
**Added:** 2026-03-26

## Voice: Integrate Recall.ai as fallback audio transport
**Priority:** P2
**Owner:** Backend agent
**Context:** Recall.ai Output Media 已验证可行——cloud-hosted bot 加入会议，运行你的网页（voice-recall.html），通过 Cloudflare Tunnel 连回 CallingClaw 后端获得完整 AI 语音能力。代码已在 `feat/recall-ai-transport` 分支（5eacdce）：recall-client.ts（REST API 客户端）+ voice-recall.html（Output Media 网页）。适合"不需要本地操作"的场景（AI 代参、跨平台 Zoom/Teams）。
**Why:** Playwright 注入是主链路但依赖本地 Chrome + macOS。Recall.ai 提供云端 fallback：任意平台（Zoom/Teams/Meet）、无桌面依赖、$0.65/hr。两种 transport 共享 realtime_client.ts 和 voice.ts，维护成本低。
**What to change:** (1) 合并 `feat/recall-ai-transport` 到 main (2) 在 callingclaw.ts 添加 transport 选择逻辑 (3) 配置 Cloudflare Tunnel（$0）(4) 申请 Recall.ai API key（免费 5 小时试用）(5) 添加 `/ws/recall/webhook` 端点处理 bot 状态事件
**Depends on:** v2.7.12 Playwright 注入稳定运行、Recall.ai API key
**Added:** 2026-03-26
**Branch:** `feat/recall-ai-transport` (5eacdce)
