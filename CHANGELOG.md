# Changelog

All notable changes to CallingClaw are documented here.
Format: `## [version] — date (branch: name)`

---

## [2.4.0] — 2026-03-14 (branch: desktop)

### feat: Meeting Scheduler + Post-Meeting Smart Delivery

#### MeetingScheduler (Calendar → Cron → Auto-Join)
- New module: `src/modules/meeting-scheduler.ts`
- Polls Google Calendar every 5 min for events with Meet/Zoom links
- For each upcoming meeting (within 2h): registers one-shot OpenClaw cron job
- Cron fires 2 min before meeting start → OpenClaw calls `POST /api/meeting/join`
- Deduplicates by calendar event ID, auto-cleans past meetings
- API: `GET /api/scheduler/status`, `POST /api/scheduler/poll`, `POST /api/scheduler/schedule`, start/stop

#### PostMeetingDelivery (Smart Todo → Confirm → Sub-agent Execute)
- New module: `src/modules/post-meeting-delivery.ts`
- After meeting ends: compresses action items to ≤20 chars each
- Sends concise todo list to user via OpenClaw → Telegram with inline ✅/❌ buttons
- User clicks ✅ → CallingClaw builds rich execution context:
  - Full meeting notes + decisions + requirements + live notes (screen captures)
  - Cross-references MEMORY.md + workspace file structure
- OpenClaw spawns sub-agent per confirmed todo (5 min timeout)
- Sub-agent deep-researches: background, acceptance criteria, modification direction
- Then executes: code changes, doc updates, file edits
- API: `GET /api/postmeeting/status`, `POST /api/postmeeting/callback`

### refactor
- `leave_meeting` tool handler now uses PostMeetingDelivery instead of raw OpenClaw push
- Old follow-up text kept as fallback if delivery fails
- Module index exports updated
- Startup banner shows new modules
- CallingClaw SKILL.md updated with scheduler + delivery docs

---

## [2.3.0] — 2026-03-14 (branch: desktop)

### fix (critical — audio pipeline dead on meeting join)
- **Root cause**: Python sidecar's `screen_capture_loop` threw `list index out of range` at high frequency (~1/sec), flooding the asyncio event loop. Although screen capture and message handling ran in separate tasks, the rapid error + sleep cycle starved the event loop, causing `config` messages (audio_mode: meet_bridge) to be delayed or lost. Result: 0 audio_chunk, OpenAI Realtime heard nothing, AI never spoke.
- **Fix 1 — Screen capture backoff**: Added exponential backoff (2s → 4s → ... → 30s max) on consecutive screen capture errors. Only logs first 3 errors then every 20th. Prevents event loop starvation.
- **Fix 2 — Config verification with retry**: New `bridge.sendConfigAndVerify()` method sends config to sidecar and waits for explicit `audio_mode_changed` confirmation. Retries up to 3 times with 3s timeout each. `/api/meeting/join` now uses this instead of fire-and-forget `bridge.send()`.
- **Fix 3 — Bridge heartbeat ping/pong**: Bridge sends `ping` every 5s, sidecar responds with `status` (alive + current audio_mode). If no pong in 15s, bridge marks `_ready = false` and closes stale connection. Prevents phantom "connected" state.
- **Fix 4 — Sidecar robustness**: Added top-level exception handler around message processing loop so one bad message doesn't crash the entire handler. Config messages now send confirmation status back to Bun with success/failure details. Reconnect resets `audio_mode` to "default".
- **Fix 5 — Auto-greeting**: After joining meeting, voice AI sends a greeting message after 2s delay ("大家好，我是 CallingClaw 会议助手") to verify the full audio pipeline (capture → Realtime → playback) is working end-to-end.

### refactor
- `bridge.send()` now catches send errors and marks connection as dead
- `bridge.close()` handler only resets state if closing the current client (not a stale one)
- Sidecar status messages include `audio_mode` and `audio_running` fields

---

## [2.2.1] — 2025-03-12 (branch: feat/electron-shell)

### feat
- Unified VERSION file as single source of truth for all sub-projects
- Electron Desktop titlebar shows CallingClaw logo + version number
- Regenerated tray-icon.png and icon.icns from CallingClaw watercolor logo
- Replaced all remaining emoji logos in landing page (features.html, vision.html)
- Added CallingClaw logo favicon to all pages (landing, features, vision, meeting-view)

### refactor
- Removed Architecture and Evolution Roadmap sections from landing page (too technical, to be redesigned with product-value messaging)

### chore
- Synced all package.json versions to 2.2.1
- Bun daemon + Electron both read `VERSION` file at startup
- Fixed callingclaw.com Vercel deployment (was showing wrong project)

---

## [2.2.1] — 2025-03-12 (branch: feat/electron-shell)

### feat (initial Electron Shell)
- Electron Desktop app with macOS tray icon, dashboard, setup wizard, and log viewer
- DaemonSupervisor spawns and monitors CallingClaw Bun daemon
- Permission checker for macOS TCC (microphone, screen recording, accessibility)
- Meeting overlay window (always-on-top, transparent, floating)
- TranscriptAuditor: System 2 intent classification for voice tool calls

---

## [2.1.0] — 2025-03-11 (branch: main)

### feat
- Meeting transparency view (`meeting-view.html`) — auto-opens during meetings
- AI state machine (idle/thinking/speaking/tool/computing) with CSS animations
- `voice.tool_call` event emissions for real-time UI updates
- Meeting Vision: periodic screenshot capture + Gemini 3 Flash analysis during meetings
- `recall_context` tool: Voice AI queries OpenClaw memory (quick/thorough paths)
- Pre-meeting agenda (`POST /api/meeting/prepare`) with user confirmation
- Post-meeting follow-up: structured report → OpenClaw for execution
- `/callingclaw` skill for OpenClaw (15 subcommands)
- Replace all emoji logos with watercolor claw-phone brand icon

### fix
- Meeting vision stops on both `meeting.ended` and `meeting.stopped` events
- Relative path `./logo.png` for dual file:// and http:// compatibility
- Added on/off local listener API to EventBus

---

## [2.0.0] — 2025-03 (branch: main)

### feat (complete rewrite)
- CallingClaw 2.0: dedicated machine architecture (replaces Chrome extension)
- VoiceModule — OpenAI Realtime bidirectional voice + function calling
- ComputerUseModule — Claude Vision + pyautogui agent loop
- AutomationRouter — 4-layer intelligent routing (L1 Shortcuts → L2 Playwright → L3 Peekaboo → L4 Computer Use)
- MeetingModule — transcript extraction, summary, markdown export
- GoogleCalendarClient — REST API + OAuth2 (create, list, auto-join)
- MeetJoiner — Chrome automation for Meet/Zoom (join, leave, share)
- EventBus — pub/sub + webhook delivery
- TaskStore — persistent task management from action items
- ConfigServer — full REST API on :4000 (40+ endpoints)
- PythonBridge — WebSocket bridge to sidecar (:4001)
- MeetingPrepSkill — System 2 generates structured brief for System 1
- ContextSync — shared memory layer (OpenClaw MEMORY.md + pinned files → tiered briefs)
- OpenClawBridge — WebSocket delegation to OpenClaw Gateway (:18789)

---

## [1.0.0] — 2025 (deprecated)

### legacy
- Chrome extension with side panel UI
- Vocode framework + ElevenLabs TTS
- Gemini Live API for voice
- Fully replaced by v2.0.0
