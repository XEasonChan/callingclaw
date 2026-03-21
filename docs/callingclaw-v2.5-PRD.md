# CallingClaw v2.5 — Product Requirements Document

## Vision
AI meeting room that joins Google Meet/Zoom as a real participant. Listens, speaks, takes notes, controls the computer, retrieves context — like having a sharp team member who never forgets.

## Architecture

### System 1 (Fast Voice) — 300ms response
- OpenAI Realtime API or xAI Grok Realtime (switchable via provider selector)
- Audio state machine: idle → listening → thinking → speaking → interrupted
- Heard transcript truncation on interrupt
- Fast tools: schedule_meeting, check_calendar, recall_context (inline, <1s)
- Slow tools: browser_action, computer_action (async dispatch + filler)

### System 2 (Deep Reasoning) — Pre/post meeting
- OpenClaw (Claude Opus) via Gateway or subprocess
- Meeting prep brief generation
- Post-meeting summary + action items + delivery
- Long-term memory management (MEMORY.md)

### 5-Layer Context Model
| Layer | Content | Budget | Mechanism |
|-------|---------|--------|-----------|
| 0 | Core Identity | <250 tokens | session.update (once) |
| 1 | Tool definitions | ~300 tokens | session.update tools |
| 2 | Meeting brief | <500 tokens | conversation.item.create (once) |
| 3 | Live context | <3000 tokens | conversation.item.create (FIFO) |
| 4 | Conversation | ~124K tokens | Managed by Realtime API |

### Audio Pipeline
- Capture: AudioWorklet at native rate → downsample to 24kHz → PCM16 → base64
- Playback: AudioWorklet ring buffer (gapless, pop-free)
- Meet Bridge: BlackHole 2ch (input) → BlackHole 16ch (output)
- Direct: system mic → speaker

### Provider Support
| Provider | Voices | Session Limit | Native Tools |
|----------|--------|---------------|--------------|
| OpenAI | alloy, marin, nova, ... (12) | 120 min | — |
| Grok (xAI) | Eve, Ara, Rex, Sal, Leo | 30 min | web_search, x_search |

### Observability
- VoiceTracer: 9 per-turn metrics (speech→playback timing)
- Token budget: auto-evict at 90%, warn at 80%
- Audio state machine: logged transitions

## Desktop App (Electron)
- Tray icon + main window + overlay
- Talk Locally: instant start (<1s perceived), parallel API calls
- Provider/voice selector in status bar
- Mic device selector (auto-skip virtual devices)
- Audio waveform bar in meeting panel

## Deployment
- Backend: `bun run src/callingclaw.ts` on localhost:4000
- Desktop: DMG (ad-hoc signed), auto-starts backend daemon
- Config: `.env` for API keys, `~/.callingclaw/user-config.json` for preferences
