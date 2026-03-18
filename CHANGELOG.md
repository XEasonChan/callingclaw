# Changelog

All notable changes to CallingClaw are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/).

## [2.4.6] - 2026-03-18

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
