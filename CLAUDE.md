# CallingClaw — AI Engineering Agent

> You are the **AI Engineer**. You own voice AI, context sync, meeting intelligence, vision analysis, transcript auditor, and all AI model integrations.

## Your Scope

### Files You OWN (read + write)
- `callingclaw/src/modules/voice.ts` — OpenAI Realtime client wrapper
- `callingclaw/src/modules/vision.ts` — Gemini Flash screen/meeting vision
- `callingclaw/src/modules/meeting.ts` — Transcript + action items + export
- `callingclaw/src/modules/computer-use.ts` — Claude CU orchestration
- `callingclaw/src/modules/context-sync.ts` — Shared memory layer (MEMORY.md + pinned files)
- `callingclaw/src/modules/context-retriever.ts` — Event-driven agentic search during meetings
- `callingclaw/src/modules/transcript-auditor.ts` — Claude Haiku intent classification
- `callingclaw/src/modules/meeting-scheduler.ts` — Calendar auto-join scheduler
- `callingclaw/src/modules/post-meeting-delivery.ts` — Post-meeting task delivery
- `callingclaw/src/voice-persona.ts` — Voice persona + brief injection + pushContextUpdate()
- `callingclaw/src/openclaw_bridge.ts` — System 2 delegation (WebSocket to :18789)
- `callingclaw/src/computer-use-context.ts` — Vision analysis context
- `callingclaw/src/skills/meeting-prep.ts` — MeetingPrepBrief generation
- `callingclaw/src/skills/openclaw-callingclaw-skill.ts` — /callingclaw OpenClaw command
- `callingclaw/src/ai_gateway/**` — realtime_client.ts, claude_agent.ts

### Files You READ ONLY (never modify)
- `callingclaw/src/config_server.ts` — Backend owns routes
- `callingclaw/src/bridge.ts` — Backend owns sidecar bridge
- `callingclaw/src/meet_joiner.ts` — Backend owns join automation
- `callingclaw/src/mcp_client/**` — Backend owns Playwright/Calendar/Peekaboo
- `callingclaw/src/modules/{automation-router,event-bus,task-store,auth,shared-context}.ts` — Backend
- `callingclaw-desktop/**` — Frontend agent
- `callingclaw/public/**` — Frontend agent

### Key Interfaces You Consume (from Backend)
- `SharedContext` — read transcript, screen state, workspace context
- `EventBus` — emit/subscribe to events (meeting.started, meeting.ended, etc.)
- `AutomationRouter` — call `execute()` for computer tasks
- `PythonBridge` — screenshots via `sendAction("screenshot")`

## Current Priority Tasks

### P0
- [x] ContextRetriever — event-driven agentic search during meetings (Haiku/Gemini tool_use)
- [ ] Vision 1s interval throttling — add change detection (hash diff), only call Gemini when screen changes
- [ ] TranscriptAuditor medium-confidence suggestion — push `[SUGGEST]` liveNote to Voice AI for 0.6-0.85 confidence

### P1
- [ ] Calendar attendee injection into Prep Brief — fetch from Google Calendar, enrich expectedQuestions
- [ ] Voice AI liveNote acknowledgment — Voice proactively says "PRD已经打开了" on `[DONE]` notes
- [ ] Gemini Live API as alternative voice backend — 10x cheaper, native video input

### P2
- [ ] PostMeeting auto-execution — user confirms task → OpenClaw executes
- [ ] Meeting-to-memory feedback loop — write conclusions back to MEMORY.md
- [ ] Multi-language intent classification — expand auditor prompt for Japanese/Cantonese
- [ ] System prompt compression — liveNotes capping to reduce Realtime token costs

## AI Models Used
| Model | Purpose | Via | Latency |
|-------|---------|-----|---------|
| OpenAI Realtime | Voice conversation + function calling | `ai_gateway/realtime_client.ts` | ~300ms |
| Claude Sonnet | Computer Use (vision + tools) | `ai_gateway/claude_agent.ts` via OpenRouter | 2-5s |
| Haiku 4.5 / Gemini 3.1 Flash | Transcript analysis + agentic workspace search | OpenRouter (`CONFIG.analysis`) | 300ms-2s |
| Gemini 3 Flash | Meeting screen vision analysis | OpenRouter | ~1s |
| OpenClaw (System 2) | Pre-meeting prep, deep reasoning, memory | WebSocket :18789 | 5-15s |

## Three-Layer Cognitive Model

```
┌─ System 1 (Fast) ─────────────────────────────────────────┐
│  OpenAI Realtime — voice conversation, ~300ms              │
│  Gets context injected via session.update                  │
└────────────────────────────────────────────────────────────┘
         ↑ session.update (liveNotes + retrieved context)
┌─ System 1.5 (Mid) ────────────────────────────────────────┐
│  Haiku / Gemini Flash — meeting intelligence, ~1s          │
│  TranscriptAuditor: intent classification from transcript  │
│  ContextRetriever: agentic search on OpenClaw workspace    │
│    - Gap analysis: "what's missing from current context?"  │
│    - tool_use loop: list_workspace → read_file → search    │
│    - Browses ~/.openclaw/workspace/ autonomously           │
└────────────────────────────────────────────────────────────┘
         ↑ MeetingPrepBrief (pre-meeting)
┌─ System 2 (Slow) ─────────────────────────────────────────┐
│  OpenClaw (Opus/Sonnet) — deep reasoning, 5-15s            │
│  Pre-meeting prep brief generation only                    │
│  NOT used during meetings (too slow)                       │
└────────────────────────────────────────────────────────────┘
```

### Meeting Context Flow
```
PRE-MEETING:
  OpenClaw → MeetingPrepBrief → buildVoiceInstructions() → Voice AI

DURING MEETING:
  Transcript → ContextRetriever (event-driven, ~500 chars or user question)
    → Haiku gap analysis (~300ms) → "需要查什么?"
    → Haiku/Gemini agentic search (~1-2s, tool_use on workspace)
    → addLiveNote("[CONTEXT] ...") → pushContextUpdate() → Voice AI

  Transcript → TranscriptAuditor (debounce 2.5s)
    → Haiku intent classification → auto-execute or suggest

POST-MEETING:
  Transcript + liveNotes → PostMeetingDelivery → tasks + summary
```

## Config (.env)
```bash
OPENROUTER_API_KEY=sk-or-xxx          # Required for meeting intelligence
ANALYSIS_MODEL=anthropic/claude-haiku-4-5     # Gap analysis model
SEARCH_MODEL=anthropic/claude-haiku-4-5       # Agentic search model (or google/gemini-3.1-flash-lite-preview)
```

### Environment Variables (.env)

```bash
# Required
OPENAI_API_KEY=sk-...              # Voice + Vision

# Recommended (Computer Use + Vision)
OPENROUTER_API_KEY=sk-or-v1-...    # Claude CU + Gemini Flash vision via OpenRouter
# OR: ANTHROPIC_API_KEY=sk-ant-... # Direct Anthropic

# Optional (Calendar)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...

# Service
PORT=4000                          # REST API + Config UI
BRIDGE_PORT=4001                   # Python sidecar
PYTHON_PATH=/opt/miniconda3/bin/python3
SCREEN_WIDTH=1920
SCREEN_HEIGHT=1080
VISION_MODEL=google/gemini-3-flash-preview  # Override vision model (default: Gemini Flash)
```

---

## 10. REST API Summary

Base URL: `http://localhost:4000`

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/status` | Service health + connection status |
| GET | `/api/config` | Current configuration |
| POST | `/api/config` | Update configuration |
| GET/POST | `/api/keys` | Get/set API keys |
| POST | `/api/voice/start` | Start voice session |
| POST | `/api/voice/stop` | Stop voice session |
| POST | `/api/voice/text` | Inject text into voice session |
| POST | `/api/computer/run` | Run Computer Use task (full agent loop) |
| POST | `/api/computer/analyze` | Vision-only screen analysis |
| POST | `/api/bridge/action` | Low-level mouse/keyboard/screenshot |
| GET | `/api/calendar/events` | List upcoming events |
| POST | `/api/calendar/create` | Create calendar event |
| POST | `/api/meeting/join` | Integrated join (voice + audio + join) |
| POST | `/api/meeting/leave` | Leave + auto-summary + tasks |
| GET | `/api/meeting/transcript` | Live transcript |
| POST | `/api/meeting/prepare` | Pre-meeting agenda for user confirmation |
| GET | `/api/meeting/prep-brief` | Get current prep + context briefs |
| POST | `/api/meeting/summary` | Generate AI summary |
| POST | `/api/meeting/export` | Export to markdown |
| GET | `/api/meeting/notes` | List saved note files |
| GET | `/api/meeting/notes/:file` | Read specific note file content |
| POST | `/api/automation/run` | Auto-routed instruction (4-layer) |
| POST | `/api/automation/classify` | Classify instruction (dry-run) |
| GET | `/api/automation/status` | Layer availability |
| GET/POST/PATCH/DELETE | `/api/tasks` | Task CRUD |
| POST | `/api/context/workspace` | Inject meeting context (topic, files, git) |
| DELETE | `/api/context/workspace` | Clear workspace context |
| GET | `/api/context/sync` | ContextSync status (memory, pinned, briefs) |
| GET | `/api/context/brief` | Get tiered briefs (voice + computer) |
| POST | `/api/context/pin` | Pin file to shared context `{ path, summary? }` |
| DELETE | `/api/context/pin` | Unpin file `{ path }` |
| POST | `/api/context/note` | Add session note `{ note }` |
| POST | `/api/context/reload` | Reload OpenClaw MEMORY.md from disk |
| POST | `/api/screen/share` | Start screen sharing |
| POST | `/api/screen/stop` | Stop screen sharing |
| POST | `/api/recovery/browser` | Kill + restart browser (Playwright CLI) |
| POST | `/api/recovery/sidecar` | Kill + restart Python sidecar |
| POST | `/api/recovery/voice` | Restart voice session `{ instructions? }` |
| GET | `/api/recovery/health` | Health check all subsystems |
| WS | `/ws/events` | Real-time event stream |
| POST | `/api/webhooks` | Register webhook listener |

Full API details: `callingclaw/docs/agent-integration-guide.md`

---

## 11. Voice AI Tool Definitions

The voice module registers these tools for OpenAI Realtime function calling:

| Tool | Trigger Example | Handler |
|------|----------------|---------|
| `schedule_meeting` | "约一个明天的会议" | GoogleCalendarClient.createEvent |
| `check_calendar` | "我今天有什么安排" | GoogleCalendarClient.listUpcomingEvents |
| `join_meeting` | "加入这个会议" | MeetJoiner.joinMeeting |
| `create_and_join_meeting` | "开一个新会议" | MeetJoiner.createAndJoinMeeting |
| `leave_meeting` | "退出会议" | MeetJoiner.leaveMeeting + summary |
| `computer_action` | "帮我打开微信" | AutomationRouter → ComputerUse |
| `take_screenshot` | "看看屏幕" | PythonBridge screenshot |
| `save_meeting_notes` | "保存会议记录" | MeetingModule.exportToMarkdown |
| `share_screen` | "共享屏幕" | MeetJoiner.shareScreen |
| `stop_sharing` | "停止共享" | MeetJoiner.stopSharing |
| `open_file` | "打开PRD文件" | MeetJoiner.openFile |
| `recall_context` | "那些blog效果怎么样" | ContextSync.searchMemory / OpenClawBridge |
| `zoom_control` | "静音Zoom" | ZoomSkill (14 actions) |
| `browser_action` | "切换到下一个标签" | PlaywrightCLIClient (11 actions) |

---

## 12. 4-Layer Automation Router

Instructions are routed through layers in order, with fallback:

| Layer | Name | Speed | When to Use |
|-------|------|-------|-------------|
| **L1** | Shortcuts & API | <100ms | Keyboard shortcuts, app launch, URL open |
| **L2** | Playwright CLI | 200-800ms | Browser DOM: navigate, click, type, scroll (real Chrome) |
| **L3** | Peekaboo | 500ms-2s | macOS native: window focus, accessibility tree |
| **L4** | Computer Use | 3-10s | Vision fallback: anything L1-L3 can't handle |

---

## 13. Audio Bridge Architecture

### Direct Mode (default)
```
User Mic → Python (PyAudio) → Bun → OpenAI Realtime → Bun → Python → Speaker
```

### Meet Bridge Mode (Google Meet)
```
Meet audio out → BlackHole 2ch → Python capture → OpenAI (AI listens)
OpenAI response → Python playback → BlackHole 16ch → Meet mic in
```

---

## 14. Event Bus Events

| Event | When | Key Data |
|-------|------|----------|
| `meeting.joining` | Starting join flow | `meet_url` |
| `meeting.started` | In meeting, recording | `meet_url, correlation_id` |
| `meeting.action_item` | Action item detected | `text, assignee` |
| `meeting.ended` | Exported + tasks created | `filepath, summary, tasks` |
| `voice.started` | Voice session connected | `audio_mode` |
| `voice.stopped` | Voice session ended | — |
| `computer.task_started` | CU task begins | `instruction` |
| `computer.task_done` | CU task completed | `summary, layer, durationMs` |
| `task.created` | New task | `task` |
| `task.updated` | Status changed | `task` |
| `workspace.updated` | Context injected via API | `topic, fileCount` |
| `recovery.browser` | Browser reset attempted | `success, detail` |
| `recovery.sidecar` | Python sidecar restarted | `success` |
| `recovery.voice` | Voice session restarted | `success` |

---

## 15. Development Rules

1. **Use Bun, not Node.js** — `bun run`, `bun test`, `bun install`
2. **No Express/Hono** — Use `Bun.serve()` for HTTP/WebSocket
3. **No dotenv** — Bun auto-loads `.env`
4. **Native WebSocket** — Don't use the `ws` package
5. **Never commit `.env`** — Contains API keys
6. **TypeScript strict** — All source in `src/`
7. **Python sidecar only** — Python handles hardware (screen, audio, input)
8. **4-layer routing** — Always route through AutomationRouter for computer tasks
9. **SharedContext** — All modules share state through this event emitter
10. **EventBus** — All significant actions emit events for external consumption

---

## 16. Version History

### v2.2.1 (2026-03-13 — Current, branch: `feat/electron-shell`)

**Electron Shell + TranscriptAuditor + Meeting Join/Admit + Self-Recovery**

New since v2.1.0:
- [x] Electron Shell (`callingclaw-desktop/`) — setup wizard, permission checker, tray, overlay
- [x] Desktop icons — watercolor claw-phone icon (window, dock, tray, .icns)
- [x] Overlay window — Meeting Prep Brief + AI Activity feed sections
- [x] Favicon on localhost:4000 config panel
- [x] TranscriptAuditor — Claude Haiku intent classification replaces OpenAI tool calls for automation during meetings
- [x] Dynamic tool management — VoiceModule.setActiveTools() / restoreAllTools() for mid-session tool changes
- [x] Playwright fast-join for Google Meet — deterministic JS eval (no AI model), handles Join/Switch here/Ask to join
- [x] Two-step admission monitor — chained Step A (open notification) + Step B (click Admit) in single cycle (~1.5s)
- [x] Calendar attendee lookup — fetches attendees from Google Calendar, passes to meeting prep brief
- [x] Self-recovery API — `POST /api/recovery/{browser,sidecar,voice}` + `GET /api/recovery/health`
- [x] Browser reset — `PlaywrightCLIClient.resetBrowser()` kills Chrome + restarts session
- [ ] HealthManager API (unified permission + device + dependency health check)
- [ ] AudioDeviceManager (SwitchAudioSource automation)
- [ ] Daemon mode (--daemon flag, PID file, graceful shutdown)

See: `callingclaw_electron_upgrade_prd.md`

### v2.1.0 (2026-03-12, tag: `v2.1.0`)

**Stable checkpoint** before Electron Shell upgrade. Includes all core modules + browser automation exploration.

New since v2.0.0:
- [x] Playwright CLI client (`src/mcp_client/playwright-cli.ts`) — replaced Agent Browser + PlaywrightMCP
- [x] Playwright CLI evaluation + test harness (`test-playwright-cli/`)
- [x] Electron upgrade PRD (`callingclaw_electron_upgrade_prd.md`)
- [x] Meeting Vision with Gemini 3 Flash
- [x] Voice tool_call events + meeting transparency view
- [x] CallingClaw 1.0 (Chrome extension) fully removed

### v2.0.0 (2026-03 — Initial)

**Complete architectural rewrite** from Chrome extension to dedicated machine.

Core modules:
- [x] VoiceModule — OpenAI Realtime bidirectional voice + function calling
- [x] ComputerUseModule — Claude Vision + pyautogui agent loop
- [x] AutomationRouter — 4-layer intelligent routing (L1-L4)
- [x] MeetingModule — Transcript extraction, summary, markdown export
- [x] GoogleCalendarClient — REST API + OAuth2 (create, list, auto-join)
- [x] MeetJoiner — Chrome automation for Meet/Zoom (join, leave, share)
- [x] EventBus — Pub/sub + webhook delivery
- [x] TaskStore — Persistent task management from action items
- [x] ConfigServer — Full REST API on :4000 (40+ endpoints)
- [x] PythonBridge — WebSocket bridge to sidecar (:4001)
- [x] PlaywrightCLIClient — Browser CLI automation via @playwright/cli (Layer 2, persistent Chrome profile)
- [x] PeekabooClient — macOS native GUI access (Layer 3)
- [x] ZoomSkill — 14 Zoom keyboard shortcut actions
- [x] MeetingPrepSkill — System 2 generates structured brief for System 1
- [x] ContextSync — Shared memory layer (OpenClaw MEMORY.md + pinned files → tiered briefs)
- [x] OpenClawBridge — WebSocket delegation to OpenClaw Gateway (:18789)
- [x] Dynamic Context Push — Live liveNotes + session.update to Voice AI mid-meeting
- [x] Voice Persona — DEFAULT_PERSONA (context-aware) / MEETING_PERSONA with brief injection
- [x] recall_context tool — Voice AI queries OpenClaw memory (quick/thorough paths)
- [x] Pre-meeting agenda — POST /api/meeting/prepare → user confirmation
- [x] Post-meeting follow-up — structured report → OpenClaw for execution
- [x] /callingclaw skill — OpenClaw command interface (15 subcommands)
- [x] Meeting note file reading — GET /api/meeting/notes/:filename
- [x] Periodic MEMORY.md refresh — 60s interval, auto-push to live Voice
- [x] Meeting Vision — Auto screen capture + Gemini Flash analysis during meetings
- [x] Vision via OpenRouter — Gemini 3 Flash replaces GPT-4o for multimodal (better accuracy)
- [x] Landing page — Vercel deployment (TankaLink2.0-callingclaw-landing/)

Python sidecar:
- [x] Screen capture (mss, 1 FPS, hash-based delta compression)
- [x] Audio I/O (PyAudio + BlackHole virtual audio bridge)
- [x] Mouse/keyboard (pyautogui)
- [x] WebSocket client to Bun bridge

### v1.0.0 (2025 — Deprecated)

Chrome extension + Vocode Python backend. Fully replaced by v2.0.0.
- Chrome extension with side panel UI
- Vocode framework + ElevenLabs TTS
- Gemini Live API for voice
- Manual keyboard shortcuts only
- No calendar integration, no Computer Use

---

## 17. Known Limitations & TODOs

- [ ] CallingClaw 2.0 directory is **untracked in git** — needs initial commit
- [ ] Peekaboo MCP not always available (depends on system install)
- [ ] BlackHole audio bridge requires manual macOS audio device setup
- [ ] Google Calendar requires manual OAuth2 token generation
- [ ] No automated tests for MeetJoiner (depends on Chrome + Meet)
- [ ] Python sidecar requires conda environment with specific pyobjc versions
- [ ] Landing page needs deployment verification

---

## 18. Quick Reference for Common Agent Tasks

### Port Reference

| Port | Protocol | Purpose |
|------|----------|---------|
| 4000 | HTTP + WS | REST API + Config UI + Event Bus |
| 4001 | WebSocket | Python sidecar bridge |
| 18789 | WebSocket | OpenClaw Gateway (external, CallingClaw connects as client) |

### Start CallingClaw
```bash
cd "CallingClaw 2.0/callingclaw" && bun run start
```

### Check if running
```bash
curl -s http://localhost:4000/api/status | python3 -m json.tool
```

### Join a meeting programmatically
```bash
curl -X POST http://localhost:4000/api/meeting/join \
  -H "Content-Type: application/json" \
  -d '{"url": "https://meet.google.com/xxx-yyyy-zzz"}'
```

### Take a screenshot
```bash
curl -X POST http://localhost:4000/api/bridge/action \
  -H "Content-Type: application/json" \
  -d '{"action": "screenshot"}'
```

### Run a computer use task
```bash
curl -X POST http://localhost:4000/api/computer/run \
  -H "Content-Type: application/json" \
  -d '{"instruction": "Open Chrome and go to github.com"}'
```

---

## 19. Git Conventions

### Commit Rules
- 使用 **Conventional Commits**: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`
- 每完成一个独立功能点或修复，**立即 commit**，不要积攒
- commit 前必须运行 `bunx tsc --noEmit` 检查编译
- 大的重构前先创建 checkpoint commit: `"checkpoint: before xxx refactoring"`
- 主线**不允许 force push**
- 所有 commit 包含 `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`

### Versioning (Semantic Versioning)
- **MAJOR**: 不兼容的 API 变更或用户可见的 breaking change
- **MINOR**: 新功能，向后兼容
- **PATCH**: bug 修复，性能优化
- 版本号统一维护在: `VERSION`, `callingclaw/package.json`, `callingclaw-desktop/package.json`, `callingclaw/src/callingclaw.ts`
- 每次 release 必须同步更新 `CHANGELOG.md`

### Branch Strategy
```
main (稳定版) ← dev/frontend, dev/backend, dev/ai (worktrees)
```
- Feature 在对应角色的 worktree 分支上开发
- Backend agent 作为 integrator 合并到 main
- 合并前检查文件所有权边界

### Release Process (使用 `/release` 命令)
1. 列出上个 tag 以来的所有 commit，按类型分类
2. 判断 semver bump (MAJOR/MINOR/PATCH)
3. 更新所有版本号文件
4. 生成 CHANGELOG.md 条目
5. 运行编译检查
6. Commit + Tag + Push + GitHub Release

### Worktree Paths
| Role | Path | Branch |
|------|------|--------|
| Main | `CallingClaw 2.0/` (iCloud) | `main` |
| Frontend | `/Users/admin/dev/callingclaw-worktrees/frontend` | `dev/frontend` |
| Backend | `/Users/admin/dev/callingclaw-worktrees/backend` | `dev/backend` |
| AI | `/Users/admin/dev/callingclaw-worktrees/ai` | `dev/ai` |

---

## 20. gstack Skills

Use the `/browse` skill from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools.

Available skills:
- `/plan-ceo-review` — CEO-level product review of feature plans
- `/plan-eng-review` — Engineering architecture review with diagrams and test matrices
- `/plan-design-review` — Design audit with AI slop detection
- `/design-consultation` — Design consultation
- `/review` — Paranoid code review with auto-fixes
- `/ship` — Release engineer: ship the PR
- `/browse` — Headless browser for web browsing, QA, and verification
- `/qa` — Full QA: opens real browser, clicks through flows, finds bugs
- `/qa-only` — QA without code fixes
- `/qa-design-review` — QA with design review
- `/setup-browser-cookies` — Configure browser cookies for QA
- `/retro` — Developer stats retrospective
- `/document-release` — Generate release documentation

If gstack skills aren't working, run: `cd ~/.claude/skills/gstack && ./setup`
