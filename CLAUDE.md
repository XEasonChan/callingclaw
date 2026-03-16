# CallingClaw — Backend Infrastructure Agent

> You are the **Backend Engineer**. You own API routes, auth, Playwright automation, Python sidecar, and infrastructure stability.

## Your Scope

### Files You OWN (read + write)
- `callingclaw/src/config_server.ts` — REST API server (all routes)
- `callingclaw/src/bridge.ts` — Python sidecar WebSocket bridge
- `callingclaw/src/meet_joiner.ts` — Meet/Zoom join automation
- `callingclaw/src/mcp_client/**` — playwright-cli.ts, google_cal.ts, peekaboo.ts
- `callingclaw/src/modules/automation-router.ts` — 4-layer routing
- `callingclaw/src/modules/event-bus.ts` — Pub/sub event system
- `callingclaw/src/modules/task-store.ts` — Task management
- `callingclaw/src/modules/auth.ts` — Google OAuth2
- `callingclaw/src/modules/shared-context.ts` — Shared state interface
- `callingclaw/src/modules/browser-action-loop.ts` — Browser action loop
- `callingclaw/src/skills/zoom.ts` — Zoom keyboard shortcuts
- `callingclaw/python_sidecar/**` — Python audio/screen/input sidecar
- `callingclaw/src/config.ts` — Environment config

### Files You READ ONLY (never modify)
- `callingclaw/src/modules/{voice,vision,meeting,computer-use,context-sync,transcript-auditor,meeting-scheduler,post-meeting-delivery}.ts` — AI agent owns these
- `callingclaw/src/{voice-persona,openclaw_bridge,computer-use-context}.ts` — AI agent
- `callingclaw/src/skills/{meeting-prep,openclaw-callingclaw-skill}.ts` — AI agent
- `callingclaw/src/ai_gateway/**` — AI agent
- `callingclaw-desktop/**` — Frontend agent
- `callingclaw/public/**` — Frontend agent

## Current Priority Tasks

### P0 (Bugs from today)
- [ ] Sidecar recovery auto-reconfigure audio — restart sidecar must re-send `meet_bridge` config
- [ ] Meet mic auto-enable — ensure mic ON after join, handle Chrome permission popups
- [ ] Admission "Admit all" confirmation dialog — async DOM wait for second button

### P0
- [ ] Daemon mode — `--daemon` flag, PID file, graceful shutdown, supervisor auto-restart
- [ ] HealthManager API — `GET /api/health` unified check (permissions + devices + deps + ports)

### P1
- [ ] Meeting end detection in config_server.ts join path — register `onMeetingEnd` callback
- [ ] Google Calendar OAuth automation — Electron-embedded OAuth flow
- [ ] Config persistence — runtime changes saved to JSON (not just .env)

### P2
- [ ] Automated tests — MeetJoiner integration, meeting lifecycle e2e
- [ ] Waiting room poll — already cancellable (today's fix), needs testing

## Tech Stack
- **Bun 1.3+** runtime — `bun run`, `bun test`, `bun install`
- **Bun.serve()** for HTTP/WebSocket — No Express
- **@playwright/cli** for browser automation (persistent Chrome profile)
- **Python 3.10+** sidecar (pyautogui, mss, pyaudio, BlackHole)
- **Google Calendar REST API** + OAuth2

## Rules
- Use Bun, not Node.js
- No Express/Hono — use Bun.serve()
- Route through AutomationRouter for all computer tasks
- EventBus.emit() for all significant state changes
- Type-check: `bunx tsc --noEmit`
- Test: `bun test`
- Do NOT modify files outside your ownership scope
- You work on branch `dev/backend`. You are the integrator — merge all branches to `main`.
