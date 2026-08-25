# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is CallingClaw

Real-time voice AI for meetings. Joins Google Meet/Zoom as a participant, listens, speaks, takes notes, and controls the computer. macOS only.

## Commands

```bash
# Setup (first time)
./scripts/setup.sh                    # installs Bun, OpenClaw, dependencies, configures .env

# Start / Stop (daily use)
./scripts/start.sh                    # start OpenClaw + backend + desktop
./scripts/start.sh --no-desktop       # headless mode
./scripts/stop.sh                     # stop everything

# Development
cd callingclaw-backend && bun --hot run src/callingclaw.ts    # dev with hot reload
cd callingclaw-desktop && npm start -- --dev                  # dev with DevTools
cd callingclaw-backend && bun test                            # all tests
cd callingclaw-backend && bun test test/modules/voice.test.ts # single test

# Build DMG
cd callingclaw-desktop && xattr -cr . && npm run build

# Health check
curl http://localhost:4000/api/status
curl http://localhost:18789/healthz    # OpenClaw gateway
```

## Configuration

Single `.env` file at project root (symlinked into `callingclaw-backend/`). See `.env.example` for all options.

OpenClaw has its own config at `~/.openclaw/openclaw.json` — manage it via `openclaw configure`.

### Agent platform (cognitive backend)

`AGENT_PLATFORM` selects the agentic backend: `openclaw | claude-code | codex | hermes | raven | standalone` (auto-detected if unset). Each is an `AgentAdapter` (`src/agent-adapter.ts` + `src/adapters/`). To converse with CallingClaw / launch meetings *from* an agent, the agent registers the universal MCP server `plugins/callingclaw-events` (tools: status, transcript, summary, recent_events, join_meeting, prepare_meeting, list_calendar) — works with any MCP client (Hermes, Raven, Claude Code, opencode, Cursor).

- **Codex** (OpenAI): `./scripts/setup-codex.sh` installs the Codex CLI and registers the MCP server in `~/.codex/config.toml`. Adapter shells out to `codex exec "<prompt>"` (per-run model via `-m`, defaulting to `~/.codex/config.toml`). Talk to it via `codex exec "..."`.
- **Hermes** (NousResearch): `./scripts/setup-hermes.sh` installs Hermes, wires OpenRouter, registers the MCP server in `~/.hermes/config.yaml`. Adapter shells out to `hermes -z "<prompt>" -m <model> --provider openrouter`. Talk to it via `./scripts/start-hermes.sh`. Live E2E: `bun scripts/e2e-hermes.ts`. Design + gotchas: `docs/superpowers/specs/2026-05-28-hermes-agent-integration-design.md`.
- **Raven** (EverMind-AI): `./scripts/setup-raven.sh` installs Raven (pipx), injects the MCP client dependency, seeds an OpenRouter provider + model into `~/.raven/config.json`, and registers the `callingclaw-events` MCP server. Talk to it via `./scripts/start-raven.sh`. Live E2E: `bun scripts/e2e-raven.ts`. Adapter shells out to `raven agent -m "<prompt>"`; model/provider are config-file based (`~/.raven/config.json`, NOT CLI flags). Design: `docs/raven-adapter-design.md`.

## Architecture

```
callingclaw-backend/     Bun backend — AI orchestration, voice, meeting lifecycle
callingclaw-desktop/     Electron desktop app — UI, audio bridge, tray
# Website: github.com/XEasonChan/callingclaw-website (separate repo, Vercel)
```

### Backend: Module-Wired Pattern

All services instantiate once in `callingclaw.ts` and inject cross-module dependencies:

1. **Infrastructure** — NativeBridge (osascript+cliclick), SharedContext (central state), EventBus, TaskStore, GoogleCalendarClient
2. **Voice & AI** — VoiceModule (wraps RealtimeClient), VisionModule (Gemini Flash), ComputerUseModule (Haiku 4.5 during meetings [latency-sensitive default]; Sonnet 5 outside meetings — `IN_MEETING_COMPUTERUSE_MODEL` is an opt-in in-meeting A/B flag, default Haiku), ContextRetriever (Haiku gap detection), TranscriptAuditor (Haiku intent classification)
3. **Meeting** — MeetingModule (recording+action items), MeetingScheduler (calendar auto-join), PostMeetingDelivery, KeyFrameStore
4. **Skills** — MeetingPrepSkill, OpenClawBridge (System 2 deep reasoning), BrowserActionLoop (Haiku + Playwright snapshot)
5. **Browser (Dual Chrome)** — Chrome #1: ChromeLauncher (Playwright library: Meet join + audio injection + admission monitor + screen share). Chrome #2: OpenCLIBridge (fault-isolated execution: deterministic web adapters, CLI hub, operate mode). See `docs/opencli-experiment-findings.md` for architecture decision.
6. **Meeting Stage** — `public/stage.html` transparent AI workspace for screen sharing. Left: presentation iframe (Playwright-controlled). Right: dual-model EventBus feed + Working Documents. Default screen share target.
7. **HTTP Server** — `config_server.ts` takes a `Services` interface, builds REST + WebSocket APIs via `Bun.serve()`

### Multi-Provider Voice (ai_gateway/)

`RealtimeClient` normalizes OpenAI Realtime API, Grok Voice, and Gemini 3.1 Flash Live behind a `RealtimeProviderConfig` interface. Each provider defines URL, headers, event name mapping, capabilities, and session builder. Gemini uses `GeminiProtocolAdapter` for structural protocol transform (envelope-based, not type-field). The `VoiceModule` wraps this with a state machine: `idle <-> listening <-> thinking <-> speaking` (with interruption handling that tracks "heard transcript" ratio).

**Gemini-specific constraints:**
- Audio input: `realtimeInput.audio` (not `.media` or `.mediaChunks`), 16kHz PCM16
- Audio output: 24kHz PCM16 (matches CallingClaw canonical rate, no upsampling needed)
- Setup: `systemInstruction` must be <100 chars when tools are present (silently hangs otherwise)
- Tool schemas: minimal format only (`{ type: "string" }`, no property descriptions)
- Session resumption: 15-min limit, auto-reconnect with handle
- WebSocket: must use `require("ws")` npm package (Bun's `import from "ws"` gives built-in shim that ignores proxy)

### 5-Layer Context Model

See `callingclaw-backend/CONTEXT-ENGINEERING.md` for full details. Critical constraint: **never use `session.update` mid-meeting** (causes audio breaks). Use `conversation.item.create` for all runtime context injection.

- **Layer 0** — Core identity (~250 tokens, set once via `session.update`)
- **Layer 1** — Tool definitions (in `session.update` tools array, never in prompt text)
- **Layer 2** — Mission context (<500 tokens, injected once via `conversation.item.create`)
- **Layer 3** — Live context (FIFO, ~3000 tokens max, incremental `conversation.item.create`)
- **Layer 4** — Conversation (~124K tokens, managed by Realtime API)

### Tool Definitions

`tool-definitions/index.ts` exports `buildAllTools(deps)` which collects tools from modular files (calendar-tools, meeting-tools, automation-tools, ai-tools, prep-tools). Each module returns `{ definitions, handler }`.

Key tools added in v2.8.14+:
- `read_prep` (prep-tools) — Zero-cost local query of prep sections (resources, decisions, questions, history, scenes)
- `interact` (automation-tools) — Click/scroll/navigate on presenting page with DOM re-extraction
- `share_screen` — Natural language URL resolution ("官网" → callingclaw.com), tab reuse, iframe pre-loading

### EventBus

Event-driven integration hub (`modules/event-bus.ts`). Supports WebSocket subscribers, HTTP webhooks (HMAC-signed), and in-process listeners with glob patterns (e.g., `"meeting.*"`). Correlation IDs trace meeting lifecycle end-to-end.

### Desktop: Electron Dual-Process

- **Main process** (`main/index.js`) — DaemonSupervisor (spawns/manages Bun backend), PermissionChecker, window+tray management, IPC handlers
- **Renderer** (`renderer/index.html`, vanilla JS) — communicates with backend via HTTP/WS to localhost:4000
- **Preload** (`preload/index.js`) — contextBridge exposes `callingclaw.*` API
- **Audio Bridge** (`renderer/audio-bridge.js`) — AudioWorklet capture+playback with ring buffer. Direct mode only (local mic/speaker). Meet audio is handled by Playwright `addInitScript` injection in ChromeLauncher, not through Electron.

### WebSocket Multiplexing

`config_server.ts` multiplexes three WS types on one port:
- `/ws/events` — EventBus real-time stream (Desktop UI updates)
- `/ws/voice-test` — Browser-based voice testing
- `/ws/audio-bridge` — Electron audio (AudioWorklet PCM chunks)

### Meeting Stage (`/stage`)

Transparent AI workspace screen-shared during meetings. Per-meeting Stage HTML is **pre-generated** during meeting join (`stage-generator.ts`) with iframe src already baked in — no dynamic `loadSlideFrame()` needed.

- **Left**: Presentation iframe. Content loaded at page render time (no race condition). Supports localhost HTML and markdown files via `render.html?file=...`. Scrollable via `contentWindow.scrollBy()` from parent page.
- **Right**: Dual-system panels:
  - **System One** (S1): Voice transcript (🗣️ AI / 👤 user) + tool calls (🔧)
  - **System Two** (S2): Agent actions — intent classification (🎯), file search (🔍), execution (⚡), completion (✅)
- **Working Documents**: From prep brief's `filePaths` + `browserUrls`, registered via `meeting.prep_ready` event.
- **Markdown Renderer**: `public/render.html` — universal CallingClaw-branded markdown renderer. Usage: `/render.html?file=/path/to/file.md`
- **API**: `GET /api/stage/documents`, `GET /api/file/read?path=...`, `POST /api/screen/scroll` (auto-detects Stage → scrolls iframe), `GET /api/audio/status`

### Meeting-Time Model Usage

During meetings, CallingClaw uses its own fast models, NOT OpenClaw:

| Module | Model | Purpose |
|--------|-------|---------|
| VoiceModule | OpenAI Realtime / Gemini Live | Real-time voice conversation |
| VisionModule | Gemini Flash (OpenRouter) → gpt-4o-mini fallback | Screenshot capture 1s, analysis every ~3s |
| ContextRetriever | Haiku (OpenRouter) | Gap detection + agentic search |
| TranscriptAuditor | Haiku (OpenRouter) | Real-time intent classification |
| ComputerUseModule | Haiku 4.5 in-meeting (default; latency-sensitive), Sonnet 5 off-meeting (Anthropic API) | Screen control when voice AI requests. In-meeting model is an opt-in A/B via `IN_MEETING_COMPUTERUSE_MODEL` (default Haiku 4.5). |

OpenClaw is used **before** meetings (OC-001 prep) and **after** meetings (OC-004/005 summary delivery, OC-009 follow-up). During meetings, it is only a fallback for `recall_context` deep search when local + Haiku paths fail.

## Rules

- **Bun, not Node.js** for all backend work. Use `Bun.serve()`, `bun:sqlite`, `Bun.file`, `Bun.$` — see `callingclaw-backend/CLAUDE.md` for full Bun API guidance
- **Vanilla JS** in Electron renderer (no TypeScript in HTML files)
- **Audio format**: always 24kHz PCM16 mono across all audio paths
- **Context engineering**: follow the 5-layer model; never put tool definitions in prompt text
- `setSinkId()` must be called BEFORE `getUserMedia()` in Electron (bug #40704)
- Shared document directories live at `~/.callingclaw/shared/` (prep, notes — accessed by backend, desktop, and OpenClaw)
- User config: single `.env` file at project root (symlinked into backend)
- **DMG build**: output to `/tmp`, not iCloud — `build/afterPack.js` strips xattrs but iCloud re-adds them

## Known Gotchas

| Area | Gotcha | Burned When |
|------|--------|-------------|
| **Desktop renderer** | NEVER use TypeScript syntax in index.html — P0 crash | v2.4.1, v2.6.2 |
| **DMG build** | iCloud resource forks → codesign fails. Build to `/tmp` | v2.7.10 |
| **Bundle ID** | Dev = `com.github.electron`, prod = `com.tanka.callingclaw`. TCC permissions don't carry between them | v2.7.10 |
| **Audio setSinkId** | Must be called BEFORE `getUserMedia()` (Electron bug #40704) | v2.5.0 |
| **Scheduler events** | Use `meeting.prep_ready` not `scheduler.prep_ready` — frontend only listens for the former | v2.7.8 |
| **MeetingScheduler dedup** | Must check existing sessions by meetUrl/calendarEventId before creating new ones | v2.7.9 |
| **BlackHole removed** | BlackHole virtual audio replaced by Playwright `addInitScript` audio injection in v2.7.12. `clearAudioDevicePrefs()` in ChromeLauncher still needed to prevent Chrome from loading cached BlackHole device prefs from old profiles | v2.7.12 |
| **Meet audio receivers** | Meet creates 5+ audio receivers per PeerConnection, most are `muted=true` (silence). MUST select `track.muted===false` for the active speaker | v2.7.11 |
| **Worklet cross-origin** | AudioWorklet.addModule() from localhost fails inside Meet page (cross-origin). MUST use Blob URL inline worklet code | v2.7.11 |
| **Playwright CLI vs Library** | `playwright-cli` eval() cannot intercept getUserMedia (Meet caches at module load). MUST use Playwright library `addInitScript()` for pre-load injection | v2.7.11 |
| **Meet bot detection** | Playwright Chrome must use `--disable-blink-features=AutomationControlled` + `ignoreDefaultArgs: ["--enable-automation"]` or Meet blocks joining | v2.7.11 |
| **Audio capture self-check** | After joining Meet, MUST verify captured audio has nonzero amplitude (maxAmp > 0). If all zeros, cycle through ALL receivers trying each for 5s — the unmuted receiver may appear later after join stabilizes. **FIXED v2.7.12**: setupCapture cycles receivers by index with triedReceiverIdx | v2.7.12 |
| **Playwright lib vs CLI coexistence** | `launchPersistentContext` holds Chrome process — playwright-cli CANNOT connect to same profile simultaneously. **FIXED v2.7.12**: ChromeLauncher.joinGoogleMeet() + admission monitor use Playwright library directly, playwright-cli bypassed for Meet join | v2.7.12 |
| **Admit monitor missing** | **FIXED v2.7.12**: Admission monitor ported to ChromeLauncher (startAdmissionMonitor, _admitEvalLib, onMeetingEnd). Uses page.evaluate() directly | v2.7.12 |
| **Screen share native dialog** | Chrome's screen picker dialog is NATIVE (not DOM), Playwright CANNOT click it. Use `--auto-select-desktop-capture-source=CallingClaw Presenting` flag to auto-select tab by title match. Set tab title via `document.title = "CallingClaw Presenting"` before sharing | v2.7.19 |
| **Stage iframe cross-origin** | Pre-generated Stage HTML must be served via localhost (not `file://`). `file://` parent + `http://localhost` iframe = cross-origin → `contentDocument` blocked. Stage generator writes to `public/` dir | v2.8.14 |
| **Whisper Chinese recognition** | OpenAI transcription defaults to English, misrecognizes Chinese as Russian/Korean/Polish. Set `language` in transcription config. Configurable via `TRANSCRIPTION_LANGUAGE` env var (default: `zh,en`) | v2.8.14 |
| **Transcript reset on re-join** | `meeting.started` was clearing transcript on every join. Now only resets for DIFFERENT meeting URLs. Same URL re-join preserves conversation history | v2.8.14 |
| **Voice session context leak** | Old meeting context leaked into new meetings. `voice.resetForNewMeeting()` now called on `meeting.ended` — clears context queue + refreshes instructions | v2.8.14 |
| **Empty Stage presentation** | `share_screen` without URL defaulted to empty `/stage`. Now uses pre-generated Stage HTML with iframe content baked in. Falls back to `render.html` for markdown files | v2.8.14 |
