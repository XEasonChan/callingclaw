---
description: >
  CallingClaw — Join a video meeting (Google Meet, Zoom) as an AI assistant
  with real-time voice conversation, interactive screen sharing, meeting
  transcription, and post-meeting action items. Uses OpenAI Realtime API
  for sub-second voice response. Use when asked to join a call, attend a
  meeting, present slides, or take meeting notes.
argument-hint: <meeting-url> [--name CoCo] [--topic "Q3 Review"]
---

# CallingClaw — AI Meeting Assistant

**Join meetings as an active AI participant — not just a note-taker.**

CallingClaw is fundamentally different from other meeting bots. It uses OpenAI
Realtime API for sub-second voice response (~300ms), Playwright for interactive
screen sharing (click, scroll, navigate real websites), and a dual-system
architecture (System 1: instant voice + System 2: deep reasoning) for natural
conversation.

## Prerequisites

- **CallingClaw Desktop** running on `localhost:4000`
  - Download from [callingclaw.com](https://callingclaw.com)
  - Or build from source: `cd callingclaw-desktop && npm install && npm start`
- **OpenAI API key** with Realtime API access
- **Google account** signed into Chrome (for Google Meet)

### First-Time Setup

If this is your first time, the agent should run through this checklist:

1. Check CallingClaw is running: `curl http://localhost:4000/api/status`
2. Check API keys: `curl http://localhost:4000/api/keys`
3. Check Google OAuth: `curl http://localhost:4000/api/google/auth-status`
4. Check permissions: `curl http://localhost:4000/api/onboarding/permissions`
5. Full readiness: `curl http://localhost:4000/api/onboarding/ready`

If any check fails, use the corresponding setup endpoints to fix it.
See the MCP server (`mcp/`) for the full tool-based setup flow.

## Quick Start

### Join a meeting

```bash
curl -X POST http://localhost:4000/api/meeting/join \
  -H "Content-Type: application/json" \
  -d '{"meetUrl": "https://meet.google.com/abc-defg-hij"}'
```

This takes 30-60 seconds (Playwright launches Chrome, navigates to Meet, joins).

### Say something

```bash
curl -X POST http://localhost:4000/api/voice/text \
  -H "Content-Type: application/json" \
  -d '{"text": "Hey everyone, I'\''m CoCo, your AI meeting assistant."}'
```

The text goes through OpenAI Realtime API and is spoken naturally — not robotic
TTS. Response latency is ~300ms.

### Share screen

```bash
curl -X POST http://localhost:4000/api/screen/share \
  -H "Content-Type: application/json" \
  -d '{"url": "https://your-slides.com/deck"}'
```

Unlike other bots, CallingClaw uses Playwright — it can interact with the page
(click buttons, scroll, fill forms, navigate). This makes it ideal for live
product demos and sales presentations.

### Inject context

```bash
curl -X POST http://localhost:4000/api/voice/inject \
  -H "Content-Type: application/json" \
  -d '{"text": "The customer'\''s company is Acme Corp. They use Salesforce and Jira. Budget is $50K."}'
```

Context injection feeds information to the AI without speaking it aloud.
The AI absorbs it silently and uses it to answer questions naturally.

### Get transcript

```bash
curl http://localhost:4000/api/meeting/transcript
```

### Leave meeting

```bash
curl -X POST http://localhost:4000/api/meeting/leave
```

## MCP Server (Recommended)

For the best experience, use the MCP server which exposes all CallingClaw
capabilities as MCP tools — compatible with Claude Code, Cursor, Claude
Desktop, VS Code Copilot, and any MCP client.

```json
{
  "mcpServers": {
    "callingclaw": {
      "command": "npx",
      "args": ["-y", "callingclaw-mcp"]
    }
  }
}
```

Or run from this repo:

```bash
cd mcp && npm install && npm run build && node dist/index.js
```

20 tools available: join_meeting, leave_meeting, speak, present_url,
get_transcript, inject_context, send_chat_message, get_status,
get_action_items, set_voice_provider, check_health, check_api_keys,
set_api_keys, check_google_auth, setup_google_oauth, google_chrome_login,
get_config, set_config, check_capabilities, check_audio.

## API Reference

### Meeting Lifecycle

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/meeting/join` | POST | Join a meeting (30-60s) |
| `/api/meeting/leave` | POST | Leave meeting |
| `/api/meeting/status` | GET | Meeting state |
| `/api/meeting/transcript` | GET | Full transcript |
| `/api/meeting/summary` | POST | Generate summary |
| `/api/meeting/validate` | POST | Validate meeting URL |
| `/api/meeting/prepare` | POST | Prepare context/brief |
| `/api/meeting/talk-locally` | POST | Voice chat without meeting |

### Voice

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/voice/text` | POST | Speak text naturally |
| `/api/voice/inject` | POST | Inject silent context |
| `/api/voice/start` | POST | Start voice session |
| `/api/voice/stop` | POST | Stop voice session |
| `/api/voice/instructions` | GET/POST | Get/set AI instructions |

### Screen Sharing

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/screen/share` | POST | Share URL or screen |
| `/api/screen/stop` | POST | Stop sharing |
| `/api/screen/scroll` | POST | Scroll the shared page |
| `/api/screen/snapshot` | GET | DOM snapshot |
| `/api/screen/present` | POST | Start guided presentation |

### Setup & Config

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | Health check |
| `/api/keys` | GET/POST | API key management |
| `/api/config` | GET/POST | Configuration |
| `/api/google/auth-status` | GET | Google OAuth status |
| `/api/google/scan` | GET | Scan for OAuth credentials |
| `/api/google/apply` | POST | Apply found credentials |
| `/api/google/chrome-login` | POST | Open Chrome for sign-in |
| `/api/onboarding/ready` | GET | Full readiness check |
| `/api/onboarding/permissions` | GET | macOS permission status |
| `/api/capabilities` | GET | Available features |

### Calendar

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/calendar/events` | GET | List upcoming events |
| `/api/calendar/create` | POST | Create calendar event |
| `/api/scheduler/schedule` | POST | Schedule auto-join |

## How CallingClaw Works

```
User speaks → Mic → OpenAI Realtime API → AI responds (~300ms)
                         ↕
                    System 2 (Haiku/Opus)
                    Deep reasoning when needed
                    Context retrieval
                    Tool execution
                         ↕
                    Playwright Browser
                    Screen share + interact
                    Navigate + click + scroll
```

### Dual-System Architecture

- **System 1 (Realtime API)**: Handles instant conversation. Sub-second
  response. Always-on during meetings. Natural voice with emotion.
- **System 2 (Haiku/Sonnet)**: Handles complex tasks in background.
  Knowledge retrieval, file search, code review. Results injected back
  into System 1's context silently.

### Why Not Just TTS?

Other meeting bots (like AgentCall) use traditional TTS which requires:
`STT (1s) → LLM reasoning (3-8s) → TTS (1s) = 5-12 second delay`

CallingClaw's Realtime API is end-to-end:
`Audio in → Realtime API → Audio out = ~300ms`

This makes natural conversation possible. In sales demos and business
meetings, a 10-second pause kills the flow. 300ms feels like a real person.

## Comparison with AgentCall

| | CallingClaw | AgentCall |
|---|---|---|
| AI Brain | Built-in (Realtime API) | None (depends on host agent) |
| Voice Latency | ~300ms | 7-12 seconds |
| Screen Share | Interactive (Playwright) | Read-only HTML polling |
| Setup | Local Desktop app | Cloud API + API key |
| Best For | Sales, demos, business meetings | Coding agent voice control |
| License | MIT | MIT |

## Tips

- **First meeting**: Use `talk-locally` first to test voice without joining
  a real meeting
- **Sales demos**: Pre-inject customer context before the meeting starts
- **Presentations**: Use `/api/screen/present/prepare` to plan slide flow,
  then `/api/screen/present/start` for synchronized voice + visuals
- **Multi-language**: Set language in config — works for Chinese, English,
  Japanese, and more
- **Voice provider**: Default `openai` works best. Use `grok` for budget
  ($0.05/min) or `gemini` for cheapest (~$0.02/min). Note: `gemini` WebSocket
  may not work in China.
