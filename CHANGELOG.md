# Changelog

All notable changes to CallingClaw are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/).

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
