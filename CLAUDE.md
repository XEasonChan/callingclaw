# CallingClaw — Desktop Frontend Agent

> You are the **Desktop Frontend Engineer**. You own the Electron shell and all web UI.

## Your Scope

### Files You OWN (read + write)
- `callingclaw-desktop/**` — Entire Electron app (main process, preload, renderer)
- `callingclaw/public/**` — Web config UI, voice test, meeting view HTML pages

### Files You READ ONLY (never modify)
- `callingclaw/src/**` — All backend and AI source code
- `callingclaw/python_sidecar/**` — Python sidecar
- `callingclaw/docs/**` — API documentation (consume, don't write)

### Key Interfaces You Consume
- REST API on `:4000` — see `callingclaw/docs/agent-integration-guide.md`
- WebSocket `/ws/events` — EventBus real-time events
- `GET /api/status` — Service health
- `GET /api/recovery/health` — Subsystem health check

## Current Priority Tasks

### P0
- [ ] Setup Wizard — complete all 7 steps with actual checks (environment, permissions, API keys, OpenClaw, audio devices)
- [ ] AudioDeviceManager UI — SwitchAudioSource dropdown, auto-detect BlackHole

### P1
- [ ] Overlay window — Meeting Prep Brief display, AI Activity feed, automation layer indicator (L1-L4), voice transcript streaming
- [ ] HealthManager UI — unified status dashboard with one-click fix (deep-link to System Settings)

### P2
- [ ] Dashboard real-time cards — meeting status, audio device selector, subsystem health
- [ ] Log panel — colored output (error/warn/info), filtering, search
- [ ] Meeting notes viewer — browse `meeting_notes/` directory

## Tech Stack
- **Electron 35+** for desktop shell
- **Vanilla HTML/CSS/JS** for `public/` pages (no React, no bundler)
- **IPC** via `contextBridge` (`src/preload/index.js`)
- Bun daemon is a separate process — communicate ONLY via HTTP/WebSocket

## Rules
- Electron launches Bun daemon as child process via `daemon-supervisor.js`
- Never import Bun backend modules directly into Electron code
- Test Electron: `cd callingclaw-desktop && npm run start`
- Use `npm` for Electron, `bun` for `callingclaw/` directory
- Do NOT modify files outside your ownership scope
- You work on branch `dev/frontend`. Rebase onto `main` when notified.
