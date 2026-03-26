# CallingClaw Architecture

Complete feature-to-code flow map covering frontend (Electron), backend (Bun), and OpenClaw interactions.

---

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│  CallingClaw Desktop (Electron, macOS)                      │
│  ┌──────────┐  ┌──────────┐  ┌─────────────────────────┐   │
│  │ Main     │  │ Renderer │  │ AudioBridge (WorkletAPI) │   │
│  │ Process  │  │ UI       │  │ 24kHz PCM16 mono        │   │
│  └────┬─────┘  └────┬─────┘  └────────────┬────────────┘   │
│       │ IPC          │ HTTP/WS             │ WS              │
└───────┼──────────────┼─────────────────────┼────────────────┘
        │              │                     │
        ▼              ▼                     ▼
┌─────────────────────────────────────────────────────────────┐
│  CallingClaw Backend (Bun, :4000)                           │
│                                                             │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ VoiceModule │  │ MeetingModule│  │ ComputerUseModule │  │
│  │ + Realtime  │  │ + Transcript │  │ + Anthropic API   │  │
│  │   Client    │  │ + Summary    │  │ + Playwright      │  │
│  └──────┬──────┘  └──────────────┘  └───────────────────┘  │
│         │                                                   │
│  ┌──────┴──────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ Context     │  │ Meeting      │  │ OpenClaw          │  │
│  │ Retriever   │  │ Prep Skill   │  │ Bridge + Dispatch │  │
│  │ + Sync      │  │ + Scheduler  │  │ (3 channels)      │  │
│  └─────────────┘  └──────────────┘  └─────────┬─────────┘  │
└───────────────────────────────────────────────┼─────────────┘
                                                │
                      ┌─────────────────────────┤
                      │                         │
                      ▼                         ▼
            ┌──────────────────┐    ┌────────────────────────┐
            │ Subprocess       │    │ OpenClaw Gateway       │
            │ `claude -p`      │    │ (WS :18789)            │
            │ Fast, no gateway │    │ Deep reasoning,        │
            │ needed           │    │ memory, Telegram,      │
            │                  │    │ cron scheduling        │
            └──────────────────┘    └────────────────────────┘
```

---

## Data Flow Directions

| Direction | Transport | When |
|-----------|-----------|------|
| **Desktop → Backend** | HTTP REST + WebSocket (:4000) | All user actions |
| **Backend → Voice AI** | WebSocket (OpenAI Realtime / Grok) | Voice sessions |
| **Backend → OpenClaw** | WebSocket (:18789), CallingClaw initiates | Meeting prep, context recall, delivery |
| **OpenClaw → Backend** | HTTP callback to CallingClaw API | Cron jobs, todo execution (requires reachable URL) |
| **Backend → Subprocess** | `claude -p` CLI spawned locally | Fast recall, file editing |

**Key insight:** CallingClaw → OpenClaw works over any network (WebSocket client). OpenClaw → CallingClaw callbacks only work when CallingClaw has a reachable URL (same machine or public IP).

---

## Feature Flows

### 1. Voice Conversation (Direct Mode)

```
User starts a voice session
  → POST /api/meeting/start { topic }
  → VoiceModule.start({ mode: "direct", transport: "direct" })
      → RealtimeClient connects to OpenAI/Grok WS
  → AudioBridge captures mic → PCM16 → Realtime API
  → AI responds with audio → AudioBridge plays through speaker
```

**During conversation:**
- `recall_context` tool → OpenClawDispatcher → local search / subprocess / gateway
- `computer_action` tool → ComputerUseModule → Anthropic API (no OpenClaw)

**OpenClaw:** Optional. Voice works without it.

### 2. Join Meeting (Google Meet/Zoom)

```
User clicks "Join" + pastes URL
  → POST /api/meeting/join { url }
  → MeetJoiner.join(url)
      → Detect platform (Meet/Zoom)
      → PlaywrightCLI navigates Chrome to Meet URL
      → Auto-clicks "Join" button
  → Audio routing switches:
      Meet → BlackHole 16ch (capture) → Realtime API
      AI response → BlackHole 2ch → Meet mic input
  → VoiceModule.start({ mode: "meeting", transport: "meet_bridge" })
  → MeetingModule.startRecording()
  → ContextRetriever starts (gap analysis every ~500 chars)
  → VisionModule starts (screenshot every ~40s)
```

**OpenClaw:** Not involved in join. ContextRetriever uses subprocess for fast recall.

### 3. Meeting Prep (Deep Research Brief)

```
User clicks "Prepare" on a calendar event
  → POST /api/meeting/prepare { topic, attendees? }
  → MeetingPrepSkill.generate()
      → Build OC-001 prompt with topic + attendees
      → OpenClawBridge.sendTaskIsolated(prompt)
          Session: agent:main:callingclaw (isolated)
          Timeout: 10 minutes
      → OpenClaw reads MEMORY.md, workspace files, past meetings
      → Returns JSON: { goal, summary, keyPoints, expectedQuestions, filePaths, ... }
  → Parse response → save to ~/.callingclaw/shared/prep/
  → If voice session active: inject brief via conversation.item.create
  → EventBus emits "meeting.prep.ready"
  → Desktop UI renders prep card
```

**OpenClaw:** Required (OC-001 protocol). Fallback: direct Anthropic API (less context).

### 4. Voice AI (Real-time During Meeting)

```
Audio loop (continuous during meeting):
  Mic/BlackHole → AudioWorklet → PCM16 base64 → WS → Realtime API
  Realtime API → STT transcript → SharedContext
  Realtime API → AI audio response → AudioWorklet → Speaker/BlackHole

Tool calls (automatic, triggered by AI):
  recall_context → ContextRetriever cache (0ms)
                 → or OpenClawDispatcher local/subprocess (100ms-10s)
  computer_action → ComputerUseModule → Anthropic API
  browser_action → PlaywrightCLI (fastest for web)
  take_screenshot → screencapture CLI
  check_calendar → GoogleCalendarClient
```

**Voice State Machine:** `idle → listening → thinking → speaking → listening`

**Context Injection (5 layers):**
| Layer | Content | Injected Via | When |
|-------|---------|-------------|------|
| 0 | Core identity | `session.update` | Once at session start |
| 1 | Tool definitions | `session.update` tools array | Once at session start |
| 2 | Meeting brief | `conversation.item.create` | Once when prep ready |
| 3 | Live context (FIFO) | `conversation.item.create` | Incrementally during meeting |
| 4 | Conversation | Managed by Realtime API | Automatic |

**Critical:** Never use `session.update` mid-meeting (causes audio breaks).

### 5. Meeting Notes & Summary (Post-Meeting)

```
User clicks "Leave" or voice AI calls leave_meeting
  → POST /api/meeting/leave
  → MeetingModule.stopRecording()
  → MeetingModule.generateSummary()
      → OpenClawBridge.sendTaskIsolated(OC-004 prompt + transcript)
      → OpenClaw analyzes with full project context
      → Returns: { title, keyPoints, decisions, actionItems, followUps }
  → Save to ~/.callingclaw/shared/notes/
  → If actionItems.length > 0:
      → PostMeetingDelivery.deliver(actionItems)
          → OpenClawBridge.sendTask(OC-004 Telegram prompt)
          → OpenClaw sends Telegram message with ✅ buttons
  → Audio routing restored to original devices
  → VoiceModule.stop()
```

**OpenClaw:** Required for summary generation and Telegram delivery.

### 6. Calendar (View/Create Events)

```
Desktop UI loads → GET /api/calendar/events
  → GoogleCalendarClient.listUpcomingEvents()
  → For each event: check if prep brief exists in shared/prep/
  → Return events with prep status badges

MeetingScheduler (background, every 5 min):
  → Poll calendar for events in next 2 hours
  → For each with Meet link + no cron registered:
      → OpenClawBridge.sendTask(OC-003 cron registration)
      → OpenClaw registers cron: "at {time-2min}, POST localhost:4000/api/meeting/join"
  → At scheduled time:
      → OpenClaw fires cron → HTTP callback to CallingClaw
      → CallingClaw auto-joins meeting
```

**OpenClaw:** Required for auto-join cron. Calendar viewing works without it.

### 7. Computer Use (Screen Control)

```
Voice AI detects need for screen action
  → computer_action tool call → SLOW_TOOLS queue (async)
  → ComputerUseModule.run(instruction)
      → Screenshot → resize 1280x800 → base64
      → Anthropic API (claude-sonnet with computer_20251124 tool)
      → Response: { action: "click", coordinate: [x, y] }
      → NativeBridge executes: osascript + cliclick
      → New screenshot → verify → loop if needed
  → Result injected to voice context
  → Voice AI: "Done, I've clicked the button"
```

**4-layer automation stack:**
| Layer | Tech | Latency | Use |
|-------|------|---------|-----|
| L1 Keyboard shortcuts | osascript + cliclick | 50ms | Mute, zoom, app switch |
| L2 Browser automation | Playwright CLI | 200-500ms | Web apps |
| L3 Computer Use | Anthropic API | 2-5s | Unknown/complex UI |
| L4 Fallback | NativeBridge | 100ms | Direct mouse/keyboard |

**OpenClaw:** Not involved. Pure Anthropic API.

### 8. Context Recall (During Voice)

```
Voice AI: "What was the Q3 revenue?"
  → recall_context({ query: "Q3 revenue", urgency: "quick" })

Three-channel dispatch:
  1. LOCAL (realtime, <100ms): Keyword search on cached MEMORY.md
     → If hit: return immediately
  2. SUBPROCESS (fast, 3-10s): `claude -p --model haiku` search workspace
     → No OpenClaw gateway needed, runs locally
  3. GATEWAY (background, 10s+): OpenClawBridge.sendTask(OC-002)
     → Full OpenClaw session with MCP tools

ContextRetriever (proactive, runs in background):
  → Accumulates transcript (~500 chars)
  → Haiku analyzes: "What topic? What context is missing?"
  → Pre-fetches context BEFORE voice AI asks
  → recall_context checks this cache FIRST
```

**OpenClaw:** Optional fallback. Local + subprocess handle most cases.

### 9. Post-Meeting Delivery (Todos → Telegram)

```
After meeting summary (see Feature 5):
  → PostMeetingDelivery.deliver(actionItems)
  → Compress each item to ≤20 chars for Telegram buttons
  → OpenClawBridge.sendTask(OC-004/OC-005 prompt)
  → OpenClaw sends Telegram message:
      "Meeting: Design Review — 3 action items:
       [✅ Update API docs] [✅ Fix auth bug] [✅ Schedule follow-up]"

  User clicks ✅ in Telegram:
  → OpenClaw receives webhook callback
  → OpenClaw → CallingClaw HTTP: GET /api/meeting/notes/{id}   ← CALLBACK
  → OpenClaw reads full meeting context
  → OpenClaw spawns sub-agent to execute the task
```

**OpenClaw:** Required. The ✅ callback flow requires OpenClaw → CallingClaw HTTP access.

### 10. Auto-Join (Cron-Based)

```
MeetingScheduler (every 5 min):
  → Poll Google Calendar
  → Found: "Team Sync at 3:00 PM" with Meet link
  → OpenClawBridge.sendTask(OC-003)
      → OpenClaw registers cron job
      → Payload: "At 2:58 PM, curl -X POST localhost:4000/api/meeting/join"

At 2:58 PM:
  → OpenClaw fires cron → HTTP POST to CallingClaw   ← CALLBACK
  → CallingClaw joins meeting automatically
  → Starts voice session + recording
```

**OpenClaw:** Required. Cron callback requires reachable CallingClaw URL.

---

## OpenClaw Protocol Summary

| ID | Name | Direction | Transport | Remote OK? |
|----|------|-----------|-----------|-----------|
| OC-001 | Meeting Prep Brief | CC→OC→CC | WS Gateway | ✅ |
| OC-002 | Context Recall | CC→OC→CC | Subprocess or WS | ✅ |
| OC-003 | Calendar Cron | CC→OC, OC→CC | WS + HTTP callback | ❌ callback |
| OC-004 | Todo Delivery (Telegram) | CC→OC | WS Gateway | ✅ |
| OC-005 | Summary Delivery | CC→OC | WS Gateway | ✅ |
| OC-006 | Todo Execution | OC→CC | HTTP callback | ❌ callback |
| OC-007 | Vision Context Push | CC→OC | WS Gateway (fire & forget) | ✅ |
| OC-008 | Computer Use Delegation | CC→OC→CC | WS Gateway | ✅ |
| OC-009 | Follow-up Fallback | CC→OC | WS Gateway (fire & forget) | ✅ |

**CC = CallingClaw, OC = OpenClaw**

**Remote deployment note:** When OpenClaw runs on a remote server:
- All CC→OC flows work (WebSocket client connects outbound)
- OC→CC callbacks (OC-003, OC-006) fail unless CallingClaw has a reachable URL
- Currently the callback URL is hardcoded to `localhost:4000` — see [docs/DECOUPLING.md](./DECOUPLING.md) for the planned fix

---

## What Works Without OpenClaw

| Feature | Without OpenClaw |
|---------|-----------------|
| Voice conversation | ✅ Full (OpenAI/Grok Realtime) |
| Join meeting | ✅ Full (Playwright + BlackHole) |
| Meeting notes | ⚠️ Basic (direct Claude API, less context) |
| Meeting prep | ⚠️ Basic (no deep research, no workspace context) |
| Computer use | ✅ Full (Anthropic API direct) |
| Calendar | ✅ View/create (Google API). ❌ Auto-join (needs cron) |
| Context recall | ⚠️ Local only (MEMORY.md keyword search) |
| Telegram delivery | ❌ Requires OpenClaw |
| Screen analysis | ✅ Full (Gemini Flash via OpenRouter) |
