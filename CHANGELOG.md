# Changelog

All notable changes to CallingClaw are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/).

## [2.7.10] - 2026-03-25

### Added
- **权限预检** — Talk Locally / Join Meeting 前检查麦克风权限，denied 则弹 ccConfirm 引导用户开启
- **BlackHole 扬声器检测** — direct 模式检测系统默认输出是否为 BlackHole，警告用户切换
- **Bundle ID 提示** — dev 模式启动时 console 提醒 TCC 权限与 production 不通用
- **Landing page 更新** + logo 压缩

### Fixed
- **Onboarding 步骤映射** — step 2 现在正确检查麦克风（之前错误检查辅助功能），step 3 检查辅助功能，step 6 Summary 包含麦克风状态
- **checkAll() 缺少麦克风** — 两种模式都需要 getUserMedia()，麦克风加入必须权限列表

## [2.7.9] - 2026-03-25

### Added
- **自定义确认弹窗** — `ccConfirm()` 通用组件，毛玻璃背景 + scale 动画 + 品牌色按钮，替代系统 `confirm()`

### Fixed
- **删除会议即时刷新** — 删除后同时清理 `S.meetingFiles` 和 `S.manifest.sessions`，调用 `renderMeetings()` 即时移除，不再需要刷新页面
- **Scheduler 重复 session** — `triggerMeetingPrep()` 按 meetUrl/calendarEventId 检查已有 session，避免日历轮询重复创建

## [2.7.8] - 2026-03-25

### Added
- **Prep 即时通知** — `onPrepReady` 回调机制，`savePrepBrief()` 完成后立即通过 EventBus 发送 `meeting.prep_ready`，前端延迟从 ~5min 降至 <1s
- **权限文档** — `callingclaw-desktop/docs/permissions.md`：4 项 TCC 权限、BlackHole 设备、Entitlements、音频链路权限依赖图、排查表

### Fixed
- **防止重复会议 session** — `triggerMeetingPrep()` 按 meetUrl/calendarEventId 匹配已有 session，避免日历轮询重复创建
- **Scheduler 事件名错误** — 改 `scheduler.prep_ready` → 由 `onPrepReady` 回调统一发 `meeting.prep_ready`，前端不再漏接
- **Scheduler 缺少 meetingId** — `triggerMeetingPrep()` 现在生成 meetingId 并传入 `generate()`，前端可正确匹配会议卡片

## [2.7.7] - 2026-03-25

### Added
- **Prep Recovery** — automatic recovery of stuck/missing meeting preps during poll cycle
  - Case A: detects prep files already on disk but not indexed (OpenClaw wrote file, never called prep-result)
  - Case B: regenerates stale sessions (>12 min) via OpenClaw with dedup guard (`_prepInFlight`)
  - Single-task serialization — only regenerates one prep at a time to respect OpenClaw bridge constraints
- **Prep Recovery tests** — 9 unit tests covering no-op, disk recovery, young/stale thresholds, bridge disconnect, failure handling

## [2.6.1] - 2026-03-21

### Added
- **NativeBridge** — direct osascript + cliclick execution for mouse/keyboard actions, replacing Python sidecar WebSocket bridge
- **InputBridge interface** — typed interface for dependency injection; all consumers depend on interface, not implementation

### Changed
- **Architecture: Python sidecar eliminated** — no more WebSocket server on port 4001, no reconnect loops, no Python process. `bridge.ready` is always true.
- **Voice persona: depth-matching** — replaced rigid "under 3 sentences" cap with depth-matching response style ("insightful advisor, not cheerleader"); confirmations stay brief, strategy questions get substantive analysis with tradeoffs
- **Granular memory search** — `searchMemory` now splits by bullet points, not just headings; match-centered excerpts + heading re-emission for interleaved results
- Audio config calls are now no-ops — AudioWorklet + SwitchAudioSource handle all audio routing

### Fixed
- **Brief injection logging** — logs item ID, key point count, and warns when voice is not connected
- **Screenshot backward compat** — `bridge.sendAction("screenshot")` uses screencapture CLI + emits "screenshot" event for existing callers
- **Exit code checking** — non-zero osascript/cliclick exits correctly reported as failures

### Removed
- **Python sidecar** (`python_sidecar/main.py`, `requirements.txt`) — 552 lines of Python deleted
- `bridgePort` and `pythonSidecar` config entries
- Python process spawn and lifecycle management from `callingclaw.ts`

## [2.5.3] - 2026-03-21

### Added
- **Multimodal Meeting Timeline** — KeyFrameStore persists screenshots + transcript to disk during meetings; OC-010 protocol sends timeline to OpenClaw for visual action extraction
- **Three-Channel OpenClaw Dispatcher** — local / subprocess / gateway routing for OpenClaw tasks
- **Snapshot Diff in BrowserActionLoop** — sends only changed regions to reduce vision API cost
- **KeyFrameStore** — screenshot dedup + priority frame detection + resize for efficient storage

### Changed
- Directory restructure: `callingclaw/` → `callingclaw-backend/`

## [2.5.2] - 2026-03-21

### Added
- **Provider Capability Matrix** — `ProviderCapabilities` interface with `supportsInterruption`, `supportsResume`, `supportsNativeTools`, `supportsTranscription`, `audioFormats`, `maxSessionMinutes` per provider
- **Audio State Machine** — `AudioState` type (idle/listening/thinking/speaking/interrupted) with logged transitions wired to Realtime API events
- **Heard Transcript Truncation** — on interrupt, calculates `heardRatio` and writes `[HEARD]` correction entry to prevent multi-turn confusion
- **Logical Session Resume** — `_replayTranscriptContext()` replays conversation as proper `conversation.item.create` messages after reconnect (not instruction text)
- **Fast/Slow Tool Dispatch** — `SLOW_TOOLS` set: slow tools (browser_action, computer_action, etc.) return "Working on it" immediately, execute async, inject result via context
- **Voice-Path Tracing** — `VoiceTracer` tracks 9 metrics per turn (userSpeechStart → ttsPlaybackEnd), 50-turn history, `getAverages()` for dashboards
- **Typed Event Schema** — `AudioFrame`, `TextFrame`, `ContextFrame`, `ToolEvent`, `SessionEvent`, `AudioStateEvent` typed interfaces decoupling business logic from provider JSON

### Fixed
- **Audio contract mismatch** — `CONFIG.audio.sampleRate` fixed from 16000 → 24000 (matching actual provider rate), added `bitDepth`, `format`, `chunkSamples`
- **Startup validation** — warns if audio sample rate drifts from 24000Hz

## [2.5.1] - 2026-03-20

### Fixed
- **Meeting summary OpenClaw pollution** — `generateSummary()` now uses `getConversationText()` (user + assistant only), excluding tool calls, system messages, and OpenClaw task results
- **Chrome blank page loop after meeting exit** — `playwright-cli.stop()` now always sets `_explicitlyStopped` and cleans up admission monitor, even when already disconnected
- **Cross-session transcript leak** — `SharedContext.resetTranscript()` called on `meeting.started`; old meeting's 200 entries no longer pollute new meeting
- **Listener accumulation** — `MeetingModule` and `TranscriptAuditor` now unsubscribe transcript listeners on stop/deactivate via new `SharedContext.off()` method
- **ContextRetriever stale state** — `activate()` resets `_topicCache`, `_currentTopic`, `_currentDirection`, `_topicStableSince`, `_pendingQuestion`
- **Pinned files leak** — `ContextSync.clearPinnedFiles()` called on `meeting.ended`
- **PostMeetingDelivery unbounded** — deliveries Map trimmed to last 10 entries
- **Live log file collision** — removed extraneous args from `generateMeetingId()` calls
- **EventBus correlation guards** — warns on overwrite and double-end of correlations
- **Talk Locally skips Chrome** — `voice.started` handler checks mode, skips `browserCapture.connect()` for local sessions
- **Provider selection ignored** — config_server.ts duplicate route handler now passes provider/voice through
- **Talk Locally startup crash** — fixed `browserAudio` ReferenceError → `ElectronAudioBridge`
- **Duplicate `st-voice` ID** — renamed to `st-voice-dot` + `st-voice-select`

### Added
- **Instant Talk Locally startup** — UI opens immediately, API calls run in parallel (perceived: 5-9s → <1s)
- **AudioWorklet ring buffer playback** — replaces BufferSource scheduling, eliminates pops/clicks
- **Mic level waveform bar** — AnalyserNode + RAF loop in Desktop panel header
- **12 activity feed events** — voice, auditor, retriever, screen, postmeeting events now visible in Desktop
- **`SharedContext.off()`** — listener cleanup for all modules
- **`SharedContext.getConversationText()`** — filtered transcript for summaries
- **`SharedContext.resetTranscript()`** — clean slate per meeting
- **`ContextSync.clearPinnedFiles()`** — meeting-scoped file references

## [2.5.0] - 2026-03-20

### Added
- **Grok (xAI) voice provider** — full realtime voice support with Eve/Ara/Rex/Sal/Leo voices, `input_audio_transcription` via grok-2-audio, native `web_search` + `x_search` tools
- **Provider/voice selector in Desktop** — status bar dropdowns for OpenAI/Grok + voice, passed through to session start
- **AudioWorklet mic capture** — replaces deprecated ScriptProcessor; runs on audio thread via Blob URL (Electron-compatible)
- **Scheduled BufferSource playback** — sample-accurate gapless audio, eliminates chunk-boundary pops/clicks
- **Speech interruption** — `speech_started` → auto-cancel AI response + stop playback on all clients
- **Microphone device selector** — voice-test.html dropdown, auto-skips BlackHole/virtual devices
- **Mic audio buffering** — captures first 200-700ms of speech before session ready, flushes on connect
- **Talk Locally voice status indicator** — pulsing dot (connecting → connected → failed)
- **5-layer context engineering** — CORE_IDENTITY (Layer 0) via session.update, meeting brief (Layer 2) via conversation.item.create

### Fixed
- **AudioBridge: suspended AudioContext** — explicit `resume()` for contexts created outside user gesture
- **AudioBridge: mic failure no longer kills playback** — capture error is soft
- **79% audio data loss with Grok** — large audio deltas (13K-32K samples) now handled correctly
- **Provider selection ignored** — duplicate route handler in config_server.ts stripped provider/voice fields
- **Talk Locally startup crash** — `browserAudio` ReferenceError silently killed `startLocalTalk()`
- **Mic silence in Edge/Safari** — dual AudioContext (native capture + 24kHz playback) with downsampling
- **Meeting prep file 404** — meetingId threaded through entire prepareMeeting chain
- **OpenClaw response parsing** — handles more formats (output_text, parts[], nested messages[])
- **Context recall fallback** — validates OpenClaw answers, falls back to local memory on errors
- **Playwright Chrome tab spam** — prevented auto-start from opening repeated about:blank tabs

### Changed
- System instructions reduced 94% (~1650 → ~100 tokens) — context on-demand via recall_context
- Voice routes unified: `startVoiceSession()` helper with provider/voice passthrough
- Desktop audio-bridge.js fully rewritten: AudioWorklet + BufferSource + interruption

## [2.4.21] - 2026-03-20

### Changed
- **Context engineering layers** — meeting briefs now injected via `conversation.item.create` (Layer 2) instead of overriding session instructions. Voice reverts to Layer 0 CORE_IDENTITY on meeting end
- **Token budget tracking** — RealtimeClient tracks input/output tokens per response, warns at 80%, auto-evicts oldest context items at 90%
- **Reconnect no longer stuffs transcript** — reconnect uses clean Layer 0 instructions; context restored via `_replayContextQueue()` after session.updated
- **Voice provider selection in Desktop UI** — status bar now has OpenAI/Grok provider selector with voice list (alloy/ash/marin/etc. for OpenAI, Eve/Ara/Rex for Grok)

### Fixed
- **Context retriever enhancements** — improved gap detection and retrieval
- **Computer use simplification** — cleaned up vision analysis prompts
- **Meeting tools cleanup** — removed redundant voice instruction overrides

## [2.4.20] - 2026-03-20

### Fixed
- **Playwright Chrome crash (SIGTRAP)** — `playwright-config.json` had `--use-fake-ui-for-media-stream` in `launchOptions.args` which is incompatible with system Chrome (`--browser=chrome`). Removed the flag; media permissions already handled by `ensureChromePreferences()`

### Changed
- Voice session start passes frontend voice selection to provider config (Grok/OpenAI)

## [2.4.19] - 2026-03-20

### Fixed
- **Audio playback pops/clicks** — replaced ScriptProcessor queue playback with scheduled `AudioBufferSourceNode` for sample-accurate gapless audio (both Desktop and voice-test)
- **Mic capture silence in Edge/Safari** — split into dual AudioContext (native rate capture + 24kHz playback) with proper downsampling; fixed BlackHole default mic issue
- **79% audio data loss with Grok** — Grok sends 13K-32K samples per delta vs OpenAI's ~2K-4K; now handled correctly by BufferSource scheduling
- **Voice session disconnect on provider switch** — guarded `setVoice()` to not send OpenAI voice names to Grok sessions

### Added
- **Grok provider support in voice-test.html** — provider selector (OpenAI/Grok), dynamic voice list (Eve/Ara/Rex/Sal/Leo)
- **Microphone device selector** — dropdown lists all audio input devices, auto-skips BlackHole/Virtual devices
- **`input_audio_transcription: { model: "grok-2-audio" }`** — enables user speech transcription with Grok
- **`web_search` + `x_search` native Grok tools** — free built-in web search, no token cost
- **Speech interruption** — `speech_started` event cancels AI response + stops playback when user speaks
- **AudioWorklet mic capture** — replaces deprecated ScriptProcessor for both Desktop (Blob URL) and browser; runs on audio thread, no main-thread blocking
- **Mic audio buffering** — captures first 200-700ms of speech before session is ready, flushes on connect
- **Talk Locally voice status indicator** — pulsing dot: yellow (connecting) → green (connected) → red (failed)

### Changed
- System instructions reduced from ~1650 tokens to ~100 tokens (removed full OpenClaw memory dump, context available on-demand via recall_context tool)
- Desktop audio-bridge.js fully rewritten: AudioWorklet capture + BufferSource playback + interruption support

## [2.4.18] - 2026-03-20

### Fixed
- **Meeting prep file 404** — `prepareMeeting()` generated a new meetingId internally instead of using the session's meetingId, causing prep files to save as `cc_xxx_prep.md` while the frontend looked for `cc_yyy_prep.md`. Now threads meetingId through the entire chain: config_server → voice-persona → meeting-prep → savePrepBrief/startLiveLog
- **OpenClaw response parsing** — `extractMessageText()` now handles more response formats: `output_text`, `output`, `summary`, `parts[]`, nested `messages[]`, and plain strings
- **Context recall fallback** — `recall_context` tool now validates OpenClaw answers and falls back to local memory when OpenClaw returns errors or `(no response)`
- **Post-meeting delivery** — fixed to use `OC004_PROMPT(req)` instead of raw instruction string
- **Duplicate meeting cards** — prep card and calendar event for the same meeting no longer both appear; Coming Up list skips events that match an active prep card by topic or calendarEventId
- **AudioBridge: suspended AudioContext** — resume AudioContext created outside user gesture (e.g. inside WS onopen callback); auto-resume on playAudio if tab was backgrounded
- **AudioBridge: mic failure no longer kills playback** — capture error is soft; AI audio output continues even if mic permission is denied
- **Graceful app shutdown** — Electron now stops the Bun daemon before quit, preventing orphan processes

### Added
- **Auto-start daemon** — CallingClaw daemon starts automatically on app launch (no more "启动引擎" banner on every open)

### Changed
- Voice routes refactored: unified `startVoiceSession()` helper, new `/api/voice/session/start`, `/api/voice/session/stop`, `/api/voice/session/status` endpoints for transport-agnostic voice control
- Meeting routes now generate and return `meetingId` in join/prepare responses for frontend session tracking

## [2.4.16] - 2026-03-20

### Fixed
- **Talk Locally audio race condition** — `closePanel()` unconditionally called `stopLocalTalk()`, killing audio during any panel navigation. Now only stops when `meetingMode === 'local'`. Also fixed double-stop in `stopLocalTalk()` and added `_starting` guard in audio-bridge.js
- **MeetingScheduler duplicate crons** — persistent `_everScheduled` Set survives process restarts, prevents re-registering same meeting with OpenClaw (was sending 20+ identical auto-join messages)
- **Meeting title/time extraction** — replaced slow OpenClaw sendTask calls with fast Haiku LLM via OpenRouter (~200ms). "明早10点讨论官网改版" now correctly extracts title + datetime
- **Meeting prep panel not found** — `openCalendarMeetingPanel()` now matches by meetUrl → topic → substring instead of exact topic only
- **Settings permission crash** — null guard for undefined permission checks
- **Markdown display** — meeting link at top, prep content below, no repeated title
- **`/api/meeting/prepare` endpoint** — also replaced OpenClaw sendTask with Haiku for title/time (was duplicate of delegate endpoint fix)

### Changed
- Voice system now follows 3-step separation: meeting lifecycle → voice session → audio transport
- AI transcript deltas flow through to Live Feed (audio playback pending next session debug)

## [2.4.15] - 2026-03-20

### Added
- **SQLite meeting database** — `~/.callingclaw/callingclaw.db` replaces sessions.json. Auto-imports legacy notes/prep files with dates. 68 meetings, 53 files migrated
- **Onboarding: OpenClaw Gateway detection** — Step 4 checks OpenClaw (:18789) instead of Claude Code, with configurable URL and "测试连接" button
- **Settings: Google Calendar scan** — "扫描凭证" button auto-finds OAuth tokens from OpenClaw workspace

### Fixed
- **Past meetings had no dates** — sessions.json never stored startTime. SQLite migration parses dates from filenames (e.g. `2026-03-17_1705_*.md`)
- **Meeting files 404** — loadMeetingFile used hardcoded path convention but legacy files have different names. Now reads actual paths from DB manifest
- **"Google Calendar disconnected" always shown** — `S.calendarConnected` was never set from API response
- **Onboarding detected Claude Code instead of OpenClaw** — Step 4 now probes OpenClaw Gateway

## [2.4.14] - 2026-03-19

### Fixed
- **P0: Empty Desktop UI** — `new BrowserAudio()` threw ReferenceError at page top, killing all JS including data fetching. PR #8 renamed class to `ElectronAudioBridge` (IIFE singleton). Fixed reference + null guards
- **P0: Main process crash on ready-to-show** — `isDev` undefined, should be `IS_DEV`. Caused Electron to crash before renderer could initialize IPC
- **Backend VERSION mismatch** — `callingclaw/VERSION` was stuck at 2.4.9 while root `VERSION` was 2.4.13. Both now synced

## [2.4.13] - 2026-03-19

### Added
- **`/ws/audio-bridge` WebSocket endpoint** — Bun server now handles Electron AudioBridge messages (audio_chunk, audio_playback, config, ping) on port 4000, replacing Python sidecar bridge on port 4001
- **`meeting.summary_ready` event** — backend emits when summary markdown is written, frontend auto-loads summary tab
- **Python sidecar conditional launch** — `AUDIO_SOURCE=electron` config flag disables sidecar; defaults to Electron audio path
- **Electron AudioBridge** — `audio-bridge.js` (256 lines) replaces Python PyAudio with Web Audio API + BlackHole device selection
- **Automation IPC** — `osascript`-based click/type/key from Electron main process replaces PyAutoGUI
- **Meeting files UI** — persistent prep/summary badges on meeting cards, tabbed side panel

### Changed
- Architecture simplified: 3 processes → 2, 2 IPC boundaries → 1
- Talk Locally uses browser-native audio (getUserMedia + AudioContext) instead of Python sidecar
- `config_server.ts` Talk Locally endpoint returns `voiceInstructions` for browser client

### Fixed
- **Root cause of Talk Locally silence** — Python sidecar duplicate config race condition eliminated by bypassing sidecar entirely

## [2.4.12] - 2026-03-19

### Fixed
- **Talk Locally had no persona** — voice started with generic stub instead of DEFAULT_PERSONA. Now loads full persona + OpenClaw soul (SOUL.md, USER.md) + MEMORY.md brief for user profile, projects, and personality
- **Status bar schema mismatch** — OpenClaw/audio dots always showed gray because UI expected `{connected: bool}` but API returned `"connected"` string. Added `isConn()` helper for both formats

## [2.4.11] - 2026-03-19

### Added
- **Meeting files data model** — `S.meetingFiles` centralized state replacing `window._prepCards`, tracking prep/summary content per meeting with status lifecycle
- **Tabbed side panel** — during active meetings, side panel shows [Live Feed] [Prep Doc] [Summary] tabs with independent content areas and status badges
- **File attachments on meeting cards** — persistent prep and summary badges that survive meeting start/end lifecycle (previously destroyed on prep completion)
- **Past meetings grouping** — manifest-based session grouping with prep + summary file attachments per meeting (replaces flat note file list)
- **`meeting.summary_ready` handler** — ready to receive future backend event for post-meeting summary notification
- **Manifest TTL cache** — `fetchManifestCached()` with 30s TTL for past meeting data
- **Config panel** — voice provider selector + automation benchmark + chat locally (prior commit)
- **TODOS.md** — cross-team dependency tracking for backend events

### Fixed
- **P1: Meeting prep cards destroyed on completion** — `meeting.prep_ready` no longer calls `wrap.remove()`; updates badge in-place from shimmer to green
- **Meeting actions conflated with files** — starting Talk Locally or Join Meeting no longer removes file entries from cards
- **Desktop icon** — proper macOS squircle mask (180px radius), 80% artwork padding per Apple HIG, alpha channel for transparent corners, regenerated .icns

### Changed
- `loadMeetingFile()` consolidates 4 duplicate fetch paths into one data-model-driven function
- `openMeetingPanel()` refactored from single-content to tabbed layout
- Past meetings section uses `/api/shared/manifest` sessions instead of flat note files

## [2.4.10] - 2026-03-19

### Fixed
- **Desktop: external daemon detection** — DaemonSupervisor now detects externally-started daemons (e.g. manual `bun run start`) via health check, renderer correctly shows "Engine Running" status
- **Playwright: Meet mic/camera auto-allow** — Chrome preferences set `media_stream_mic=allow`, `media_stream_camera=allow` + site-specific permission for `meet.google.com`, eliminating permission dialog on every join

### Added
- **AI Context Engineering survey** — comprehensive architecture doc (`context-sync-architecture.html`) mapping all 5 AI roles, 10 context nodes, 5 sync mechanisms, timing, schemas, and optimization roadmap with eng review decisions
- **AutomationRouter fallback chain** documented in architecture survey (Shortcuts → Playwright → Peekaboo → Computer Use)

### Changed
- `.gitignore`: added `.collaborator` directory
- `ARCHITECTURE-DECISIONS.md`: YAML front-matter + format normalization
- `.claude/`: added project config, hooks, and settings for Claude Code tooling

## [2.4.9] - 2026-03-19

### Fixed
- **Audio bridge stability — sidecar reconnect loop** — removed config guard clause (`audio_mode != new_mode`) that prevented audio restart on duplicate config; increased reconnect backoff from 3s to 5s; bridge sends config once on reconnect instead of 3-attempt verify loop
- **Root cause:** Bridge replaced "stale" connections → sidecar cleanup killed audio → rapid reconnect → replaced again → infinite loop with 0 audio_chunks

### Added
- **14 unit tests** for audio bridge stability (config handler, reconnect backoff, audio chain invariants)

## [2.5.0] - 2026-03-18

### Added
- **Unified Meeting Panel** — Talk Locally and Remote Meeting now share the same 3-section sidebar layout: Meeting Prep + AI Activity + Live Transcript (+ screenshot for local mode)
- **Real-time live log streaming** — `appendToLiveLog()` emits `meeting.live_entry` WebSocket events, frontend transcript section updates instantly
- **meetingId-based document indexing** — all meeting flows (join, talk-locally, delegate) generate and return stable `meetingId`; frontend uses it to load `_prep.md` and `_live.md` from shared directory
- **WebSocket reconnect resilience** — exponential backoff (1s→30s max) + `/api/events` history replay on reconnect to recover missed events
- **marked.js** — full CommonMark markdown renderer replaces custom `renderMd()` (supports links, ordered lists, blockquotes, tables, images)
- **Session manifest lookup** — `openCalendarMeetingPanel()` queries `/api/shared/manifest` (sessions.json) to find the correct `meetingId` for each calendar event

### Changed
- **Event routing unified** — `handleMeetingEvent()` routes all 12+ event types (transcript.entry, voice.tool_call, computer.task_done, openclaw.*, meeting.live_entry, meeting.vision) through a single handler
- **Prep brief loading** — frontend loads `_prep.md` files directly via `/api/shared/file` instead of converting brief objects client-side

### Fixed
- **`readManifest` import error** — replaced with `readSessions` in config_server.ts (pre-existing bug)

### Removed
- **Duplicate `buildPrepMarkdown()`** — 3 copies (index.html × 2 + shared-documents.ts) reduced to 1 (server-side only)
- **`openPrepBriefFull()`** — dead code removed, replaced by meetingId-based file loading
- **Grok Voice Agent (A/B test)** — xAI Grok as alternative realtime voice provider at $0.05/min (6x cheaper than OpenAI's ~$0.30/min). Desktop UI dropdown for switching providers.
- **Multi-provider RealtimeClient** — Provider config objects isolate URL, auth headers, session format, and event name mapping. Zero if/else branching in core code.
- **Auto-reconnect with context replay** — Both OpenAI and Grok sessions auto-reconnect on disconnect (max 3 retries, linear backoff). Last 20 transcript entries replayed as context.
- **`voice.reconnect_failed` event** — EventBus notification when reconnect retries exhausted.
- **19 unit tests** — Provider config generation, event name mapping, selection logic, reconnect interface.

### Changed
- **`/api/voice/start`** now accepts `{ provider: "openai" | "grok" }` parameter.
- **Desktop voice test panel** — Provider dropdown with automatic voice option switching (OpenAI voices ↔ Grok voices: Eve, Ara, Rex, Sal, Leo).
- **`VOICE_PROVIDER` env var** — Default provider configurable via `.env` (defaults to `openai`).
## [2.4.6] - 2026-03-18

### Fixed
- **Google OAuth auth error detection** — runtime refresh token expiration now detected, sets `_connected = false`, exposes `authError` getter, fires `onAuthError` callback
- **Silent calendar failure** — `getToken()` catch-and-notify replaces silent error swallowing; `createEvent()` returns specific auth error message
- **Desktop UI WebSocket event mismatch** — EventBus sends `type` field but desktop checked `msg.event`; normalized to `msg.type || msg.event` for all handlers

### Added
- **Calendar status dot** — status bar shows green/yellow/empty for connected/auth_error/disconnected
- **Calendar auth warning banner** — amber warning in meeting list when OAuth expired, with "去设置" button
- **`calendar.auth_error` EventBus event** — real-time notification to Desktop UI and OpenClaw
- **`calendar_skipped` prep step** — meeting creation pipeline emits explicit warning when calendar unavailable
- **`calendarAuthError` in /api/status** — API now returns auth error details for programmatic consumers
## [2.4.7] - 2026-03-18

### Added
- **Calendar auto-reconnect** — if Google Calendar connection fails at startup (expired token, network), retries every 5 minutes automatically
- **Prep brief enrichment** — `/api/calendar/events` now returns `_prepBrief` field by matching events against `sessions.json` meeting prep data
- **Calendar disconnect warning** — Desktop frontend shows "Google Calendar disconnected" instead of misleading "No upcoming meetings" when calendar is down
- **OAuth token refresh script** — `bun scripts/refresh-google-token.ts` for one-click token renewal

### Fixed
- **Empty Chrome window keeps popping up after ending meeting** — `playwrightCli.stop()` now called in `meeting.ended` handler, setting `_explicitlyStopped` flag to prevent auto-start from spawning new browser windows

## [2.4.5] - 2026-03-18

### Added
- **gstack skills reference** — CLAUDE.md Section 20 documenting all available gstack skills for agent use
- **Meeting tasks** — 11 new action items from audio/sidecar debugging meeting (task extraction pipeline)

## [2.4.1] - 2026-03-18

### Fixed
- **P0: Desktop UI completely broken** — TypeScript `(pc: any)` syntax in browser JS caused SyntaxError, killing all JS execution. Entire page was static (no meeting list, no settings, no input).
- **P0: Onboarding "启动 CallingClaw" button dead** — `obFinish()` function was never defined. Now starts daemon + completes onboarding + enters home.
- **6 missing onboarding functions** — `obGrantScreen`, `obGrantAccess`, `obSaveKeys`, `obInstallSkill`, `obStopPolling`, `obFinish` all added with full functionality.
- **Onboarding animation off-center** — `.anim-canvas` now uses flexbox centering.
- **HTML hardcoded v2.4.0** — updated to dynamic version from app.info().
- **`readManifest` import error** — replaced with `readSessions` after shared-documents refactor.
- **Permission polling** — Screen Recording and Accessibility buttons now open System Settings and poll every 2s until granted.

## [2.3.1] - 2026-03-17

### Added
- **OpenClaw Protocol Schemas (OC-001 to OC-009)** — typed request/response definitions for all CallingClaw ↔ OpenClaw calls in `openclaw-protocol.ts`
- **Multi-monitor screenshot** — sidecar captures mouse-following or app-locked monitor
- **Protocol documentation** — `docs/openclaw-protocol.md`

### Fixed
- **P0: Vision + recording leak after meeting ends** — three safety nets: voice.stopped auto-stop, 3h timeout, meeting.ended cleanup

## [2.3.0] - 2026-03-17

### Added
- **Shared document directory** — `~/.callingclaw/shared/` with unified `{meetingId}` file naming
- **Agent-first meeting creation** — Desktop delegates to OpenClaw via `/api/meeting/delegate`
- **Pneuma-style agent log** — real-time OpenClaw progress in Desktop side panel
- **`POST /api/meeting/prep-result`** — OpenClaw writes markdown, notifies CallingClaw to render
- **Multi-monitor screenshot** — sidecar detects mouse/app monitor via macOS CGWindowListCopyWindowInfo
- **Unified BrowserContext DOM capture** — both Talk Locally and Meet Mode (skips Meet tab)
- **Architecture v2 documentation** — complete system diagrams in `docs/architecture-v2.md`
- **ROADMAP.md** — v3.0 Electron consolidation plan

### Changed
- **meetingId generated upfront** — `cc_{ts}_{rand}` format, no dependency on Google Calendar
- **OpenClaw writes prep markdown directly** — CallingClaw is pure display layer, no format conversion
- **File naming convention** — `{meetingId}_prep.md`, `_live.md`, `_summary.md`, `_transcript.md`
- **sessions.json** replaces manifest.json as meeting index

### Fixed
- **Sidecar crash loop** — cancel asyncio tasks on disconnect, ws.closed guard
- **Merge conflict markers** — 12 unresolved markers in index.html cleaned up
- **Calendar API format mismatch** — normalized flat start/meetLink to nested format for Desktop
- **"(no response)" meeting titles** — removed synchronous OpenClaw calls, all async now
- **Mouse-mode monitor lock** — first frame now also uses correct monitor

## [2.2.4] - 2026-03-17

### Added
- **`/callingclaw prepare` command** — OpenClaw can now create meetings through CallingClaw's API, which auto-adds `CONFIG.userEmail` as attendee. Supports `--attendees` and `--time` flags.
- **`/callingclaw email` command** — get/set user default email from OpenClaw

### Fixed
- **Missing attendee on OpenClaw-created meetings** — OpenClaw previously created calendar events directly (bypassing CallingClaw), so user email was never included as attendee

## [2.2.3] - 2026-03-17

### Fixed
- **MeetingScheduler dedup bug** — same meeting registered 20+ duplicate cron jobs in OpenClaw. Root cause: `scheduled` Map was in-memory only, cleared on every restart. Now persisted to `~/.callingclaw/scheduled-meetings.json` and keyed by Google Calendar event ID.
- **config_server VERSION fallback** — API reported v2.0.0 instead of actual version. Fallback hardcode updated, now tries `callingclaw/VERSION` before `root/VERSION`.

### Added
- **Git Conventions** — CLAUDE.md Section 19: Conventional Commits, semver, branch strategy, release checklist
- **/release command** — `.claude/commands/release.md` for automated release flow
- **CHANGELOG.md** — full history tracking

## [2.2.2] - 2026-03-17

### Added
- **Desktop Meeting Hub** — Gemini-style centered topic input with personalized greeting
- **Async Meeting Prep** — quick title generation + natural language time parsing + background OpenClaw deep research
- **Talk Locally** — full meeting intelligence stack on local machine (Voice + Auditor + Retriever + Vision + DOM context)
- **Browser DOM Context** — captures URL, title, scroll, visible text every 10s during Talk Locally
- **Agent Activity Feed** — real-time OpenClaw research progress in side panel
- **Meeting Prep Attachment** — shimmer animation during research, done badge when complete
- **Side Panel** — markdown viewer for prep briefs + meeting notes (460px right slide-out)
- **User Email Config** — persistent ~/.callingclaw/user-config.json, auto-invite to calendar
- **Prep Brief Caching** — localStorage persistence across app restarts
- **6 New EventBus Events** — postmeeting.todos_sent, todo_confirmed, meeting.vision, vision_pushed, live_note, context_pushed
- **/release command** — automated release checklist (semver, changelog, tag, push)

### Changed
- **Phase 0 Architecture Split** — callingclaw.ts 1126 to 517 lines, config_server.ts 1610 to 199 lines
- **Tool Definitions** — extracted to src/tool-definitions/ (6 domain-specific files)
- **Route Modules** — extracted to src/routes/ (16 domain-specific files)
- **3 Git Worktrees** — dev/frontend, dev/backend, dev/ai for parallel development
- **OpenClaw Task Timeout** — 2min to 10min (deep research needs time)
- **Playwright Lazy Start** — Chrome only opens when first needed, not at startup
- **Meeting Prep Decoupled** — calendar creation instant, research async in background
- **Icon** — 824x824 macOS squircle with white background

### Fixed
- **Sidecar Disconnect** — PyAudio blocking I/O moved to thread pool + ping timeout 30s
- **Meet Link Null** — createEvent returns JSON string, now properly parsed
- **Meeting End Detection** — DOM polling for "meeting has ended" + auto-leave flow
- **Admission Dialog** — individual Admit prioritized over Admit All, async confirmation handling
- **Input IME** — Chinese input method Enter key no longer triggers premature submit
- **Meeting View Popup** — disabled auto-open of meeting-view.html in browser
- **Waiting Room Poll** — now cancellable via AbortController
- **Audio Bridge Recovery** — sidecar restart auto-replays meet_bridge config

## [2.2.1] - 2026-03-15

### Added
- Electron Shell (callingclaw-desktop/) — setup wizard, permission checker, tray, overlay
- TranscriptAuditor — Claude Haiku intent classification during meetings
- Playwright fast-join for Google Meet — deterministic JS eval
- Two-step admission monitor — chained notification + admit click
- Self-recovery API — /api/recovery/{browser,sidecar,voice}
- Calendar attendee lookup for meeting prep

## [2.0.0] - 2026-03-12

### Added
- Complete architectural rewrite from Chrome extension to dedicated machine
- VoiceModule (OpenAI Realtime), ComputerUseModule (Claude Vision)
- AutomationRouter (4-layer: Shortcuts, Playwright, Peekaboo, Computer Use)
- MeetingModule, GoogleCalendarClient, MeetJoiner, EventBus, TaskStore
- ContextSync, OpenClawBridge, MeetingPrepSkill, recall_context tool
- Python sidecar (screen capture, audio I/O, mouse/keyboard)
