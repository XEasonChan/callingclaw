# CallingClaw Backend

Bun-powered backend for CallingClaw — handles voice AI, meeting lifecycle, tool execution, and context management.

## Quick Start

```bash
cp .env.example .env
# Fill in API keys: OPENAI_API_KEY, XAI_API_KEY, OPENROUTER_API_KEY, GOOGLE_*
bun install
bun run src/callingclaw.ts
```

Server starts on `http://localhost:4000`.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | System health + version |
| `/api/voice/session/start` | POST | Start voice session (provider, voice, mode) |
| `/api/voice/session/stop` | POST | Stop voice session |
| `/api/voice/text` | POST | Send text to voice AI |
| `/api/meeting/talk-locally` | POST | Start local conversation |
| `/api/meeting/join` | POST | Join Google Meet/Zoom |
| `/api/calendar/events` | GET | Upcoming calendar events |
| `/ws/events` | WS | Real-time EventBus stream |
| `/ws/audio-bridge` | WS | Electron audio transport |
| `/ws/voice-test` | WS | Browser voice test |

## Testing

```bash
bun test
```

## Key Modules

- `src/modules/voice.ts` — Voice module + audio state machine
- `src/modules/meeting.ts` — Meeting recording + summary
- `src/modules/context-retriever.ts` — Event-driven knowledge gap fill
- `src/modules/transcript-auditor.ts` — Real-time intent classification
- `src/ai_gateway/realtime_client.ts` — Multi-provider Realtime WebSocket
