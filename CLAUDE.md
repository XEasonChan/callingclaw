# CallingClaw — AI Meeting Room

> Real-time voice AI for meetings. Joins Google Meet/Zoom, listens, speaks, takes notes, controls the computer.

## Architecture

```
callingclaw-backend/     Bun backend — AI orchestration, voice, meeting lifecycle
callingclaw-desktop/     Electron desktop app — UI, audio bridge, tray
Callingclaw-landing/     Landing page (Vercel)
docs/                    Architecture decisions, PRD
test/                    E2E test fixtures
```

## Tech Stack

- **Runtime:** Bun (backend), Electron 35+ (desktop)
- **Voice:** OpenAI Realtime API / xAI Grok Realtime (switchable)
- **AI:** Claude via OpenRouter (analysis), Haiku (fast classification), Gemini Flash (vision)
- **Audio:** AudioWorklet capture + playback ring buffer, BlackHole routing for Meet
- **Context:** 5-layer model (see callingclaw-backend/CONTEXT-ENGINEERING.md)

## Quick Start

```bash
cd callingclaw-backend && bun install && bun run src/callingclaw.ts
cd callingclaw-desktop && npm install && npm start
```

## Key Files

| File | Purpose |
|------|---------|
| `callingclaw-backend/src/callingclaw.ts` | Main entry, module wiring |
| `callingclaw-backend/src/ai_gateway/realtime_client.ts` | Multi-provider Realtime WS client |
| `callingclaw-backend/src/modules/voice.ts` | Voice module (audio state machine, heard transcript) |
| `callingclaw-backend/src/config_server.ts` | HTTP API + WebSocket server |
| `callingclaw-backend/src/voice-persona.ts` | Context engineering layers |
| `callingclaw-desktop/src/renderer/audio-bridge.js` | AudioWorklet capture + playback |
| `callingclaw-desktop/src/renderer/index.html` | Desktop UI (vanilla JS) |
| `callingclaw-desktop/src/main/index.js` | Electron main process |

## Development

- Backend: `cd callingclaw-backend && bun --hot run src/callingclaw.ts`
- Desktop: `cd callingclaw-desktop && npm start -- --dev`
- Build DMG: `cd callingclaw-desktop && xattr -cr . && npm run build`
- Tests: `cd callingclaw-backend && bun test`

## Rules

- Use Bun, not Node.js (backend)
- Vanilla JS in Electron renderer (no TypeScript in HTML files)
- Audio: always 24kHz PCM16 mono
- Context: follow 5-layer model in CONTEXT-ENGINEERING.md
- Strip xattrs before DMG build (iCloud resource fork issue)
