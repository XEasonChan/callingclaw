# CallingClaw 2.0 — Agent Integration Guide

> For AI agents (OpenClaw, Claude Code, custom agents) to programmatically control CallingClaw capabilities.

---

## Overview

CallingClaw 2.0 exposes a REST API on `http://localhost:4000` that any agent can call to:

- **Voice** — Start/stop real-time voice sessions, send text to voice AI
- **Computer Use** — Analyze screens, perform mouse/keyboard actions
- **Calendar** — List events, create meetings, manage Google Calendar
- **Meeting Notes** — Live transcript, AI summary, markdown export
- **Screen Sharing** — Share/stop screen in Meet, open files for presentation
- **Task Store** — Structured task management with status tracking (pending → done)
- **Event Bus** — Real-time push events via WebSocket or webhooks
- **Workspace Context** — Inject file/git context before meetings
- **Bridge** — Direct low-level control of mouse, keyboard, screen capture

All endpoints accept and return JSON. No authentication is required (local-only service).

---

## Quick Start for Agents

### 1. Check if CallingClaw is Running

```http
GET http://localhost:4000/api/status
```

```json
{
  "callingclaw": "running",
  "version": "2.0.0",
  "bridge": "connected",
  "realtime": "connected",
  "calendar": "connected",
  "uptime": 864.76
}
```

**Decision logic:**
- `bridge: "connected"` → Computer Use and screen capture are available
- `realtime: "connected"` → Voice session is active
- `calendar: "connected"` → Google Calendar operations are available

If `callingclaw` is not reachable, start it:

```bash
cd "CallingClaw 2.0/callingclaw" && bun run start
```

### 2. Check Available Capabilities

```http
GET http://localhost:4000/api/keys
```

```json
{
  "openai": "sk-...xxxx",
  "anthropic": "",
  "openrouter": "sk-or-...xxxx",
  "google_configured": true
}
```

- `openai` non-empty → Voice is available
- `anthropic` or `openrouter` non-empty → Computer Use is available
- `google_configured: true` → Calendar is available

---

## Voice — Real-time Conversation

### Start a Voice Session

```http
POST http://localhost:4000/api/voice/start
Content-Type: application/json

{
  "instructions": "You are CallingClaw, a helpful assistant. Respond in Chinese.",
  "audio_mode": "direct"
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `instructions` | string | CallingClaw default | System prompt for the voice AI |
| `audio_mode` | string | `"direct"` | `"direct"` = default mic/speaker, `"meet_bridge"` = BlackHole for Google Meet |

**Response:**
```json
{ "ok": true, "status": "connected", "audio_mode": "direct" }
```

Once started, the voice session is **fully autonomous** — the user speaks into the microphone, OpenAI Realtime processes the audio, and the AI responds through the speaker. The session also has built-in tools for calendar, meetings, and computer use that the voice AI can invoke on its own.

### Send Text to Voice Session

Use this to inject text commands into an active voice session (useful when the agent wants to instruct the voice AI without speaking):

```http
POST http://localhost:4000/api/voice/text
Content-Type: application/json

{ "text": "Schedule a meeting with bob@example.com tomorrow at 3pm" }
```

**Response:** `{ "ok": true }`

The voice AI will process this as if the user said it, and respond with voice audio.

### Stop Voice Session

```http
POST http://localhost:4000/api/voice/stop
```

**Response:** `{ "ok": true, "status": "disconnected" }`

### Voice Session Built-in Tools

When a voice session is active, the AI can autonomously invoke these tools via function calling:

| Tool | Trigger | What it Does |
|------|---------|-------------|
| `schedule_meeting` | "约一个明天下午的会议" | Creates Google Calendar event with Meet link |
| `check_calendar` | "我今天有什么安排" | Lists upcoming calendar events |
| `join_meeting` | "加入这个会议 meet.google.com/xxx" | Opens Chrome, joins Meet, bridges audio |
| `create_and_join_meeting` | "开一个新会议" | Creates event + auto-joins Meet |
| `leave_meeting` | "退出会议" | Leaves the current Meet session |
| `computer_action` | "帮我打开微信" | Runs Computer Use to operate the screen |
| `share_screen` | "Share my screen" | Starts screen sharing in Meet/Zoom |
| `stop_sharing` | "Stop sharing" | Stops screen sharing |
| `open_file` | "Open the PRD file" | Opens file in vscode/browser/finder |
| `zoom_control` | "Mute the zoom" | Zoom keyboard shortcuts (14 actions) |
| `browser_action` | "Switch to the next tab" | Playwright operations (14 actions) |
| `save_meeting_notes` | "Save the meeting notes" | Export to markdown file |
| `take_screenshot` | "Take a screenshot" | Captures desktop screenshot |

These are invoked by the voice AI internally — no agent action needed. The agent just needs to start the session with the right `instructions`.

---

## Computer Use — Screen Analysis & Control

### Run a Computer Use Task (Full Agent Loop)

This is the high-level API. Claude will:
1. Take a screenshot of the current screen
2. Analyze it with vision
3. Decide and perform actions (click, type, scroll, etc.)
4. Repeat until the task is complete or blocked

```http
POST http://localhost:4000/api/computer/run
Content-Type: application/json

{
  "instruction": "Open Chrome and search for 'CallingClaw 2.0'",
  "screenshot": "<optional: base64 PNG if you already have one>"
}
```

**Response:**
```json
{
  "summary": "Opened Chrome and searched for CallingClaw 2.0",
  "steps": [
    "Step 1: screenshot — analyzed current screen",
    "Step 2: left_click at (120,780) — clicked Chrome icon in dock",
    "Step 3: left_click at (400,65) — clicked address bar",
    "Step 4: type \"CallingClaw 2.0\" — entered search query",
    "Step 5: key \"Return\" — submitted search"
  ]
}
```

**Requirements:** OpenRouter API Key (`OPENROUTER_API_KEY`) or Anthropic API Key (`ANTHROPIC_API_KEY`).

### Analyze Screen (Vision Only, No Actions)

Use this when you just want to understand what's on screen:

```http
POST http://localhost:4000/api/computer/analyze
Content-Type: application/json

{
  "image": "<base64 PNG — optional, auto-captures if omitted>",
  "question": "What application is currently open? What text is visible?"
}
```

**Response:**
```json
{
  "answer": "The screen shows Visual Studio Code with a TypeScript file 'callingclaw.ts' open. The terminal panel at the bottom shows CallingClaw 2.0 running on port 4000."
}
```

### Low-level Actions (Direct Mouse/Keyboard)

For precise control, bypass the AI loop and send actions directly:

```http
POST http://localhost:4000/api/bridge/action
Content-Type: application/json

{ "action": "click", "params": { "x": 500, "y": 300, "button": "left" } }
```

**Available actions:**

```jsonc
// Click at coordinates
{ "action": "click", "params": { "x": 500, "y": 300, "button": "left" } }
// button options: "left", "right", "double", "middle"

// Type text
{ "action": "type", "params": { "text": "Hello World" } }

// Press key or key combination
{ "action": "key", "params": { "key": "Return" } }
{ "action": "key", "params": { "key": "command+c" } }

// Scroll
{ "action": "scroll", "params": { "direction": "down", "amount": 3 } }

// Move mouse
{ "action": "mouse_move", "params": { "x": 960, "y": 540 } }

// Drag from A to B
{ "action": "drag", "params": { "startX": 100, "startY": 100, "endX": 500, "endY": 300 } }

// Take screenshot (returns base64 PNG)
{ "action": "screenshot" }

// Run shell command
{ "action": "run_command", "params": { "command": "open -a 'Google Chrome'" } }

// Find and click UI element by text (macOS AppleScript)
{ "action": "find_and_click", "params": { "target": "Join now", "fallback_target": "Ask to join" } }
```

**Response:**
```json
{ "ok": true, "action": "click", "position": [500, 300] }
```

---

## Calendar — Google Calendar Operations

### List Upcoming Events

```http
GET http://localhost:4000/api/calendar/events
```

```json
{
  "events": [
    {
      "summary": "Team Standup",
      "start": "2026-03-10T09:00:00+08:00",
      "end": "2026-03-10T09:30:00+08:00",
      "attendees": ["alice@company.com", "bob@company.com"],
      "meetLink": "https://meet.google.com/abc-defg-hij"
    }
  ]
}
```

### Create a Calendar Event

```http
POST http://localhost:4000/api/calendar/create
Content-Type: application/json

{
  "summary": "Product Review",
  "start": "2026-03-11T14:00:00+08:00",
  "end": "2026-03-11T15:00:00+08:00",
  "attendees": ["bob@company.com", "carol@company.com"]
}
```

Events are automatically created with a Google Meet link attached.

### Auto-discover Google Credentials

If the user has Google credentials from other tools (e.g., OpenClaw):

```http
GET http://localhost:4000/api/google/scan
```

Apply found credentials:

```http
POST http://localhost:4000/api/google/apply
```

---

## Meeting — Join & Manage Google Meet

### Joining a Meeting (via Voice)

The recommended way to join meetings is through the voice session. Start a voice session and say (or send via text):

```http
POST http://localhost:4000/api/voice/text
Content-Type: application/json

{ "text": "Join the meeting at https://meet.google.com/abc-defg-hij" }
```

The voice AI will:
1. Open Chrome and navigate to the Meet URL
2. Mute camera and microphone
3. Click "Join now" or "Ask to join"
4. Switch audio to **meet_bridge** mode (BlackHole routing)
5. Start bidirectional audio: Meet participants ↔ AI voice

### Joining a Meeting (via Computer Use)

Alternatively, use Computer Use directly:

```http
POST http://localhost:4000/api/computer/run
Content-Type: application/json

{
  "instruction": "Open Chrome, go to https://meet.google.com/abc-defg-hij, mute camera, and click Join now"
}
```

### Creating + Joining a Meeting (via Voice)

```http
POST http://localhost:4000/api/voice/text
Content-Type: application/json

{ "text": "Create a meeting called 'Sprint Planning' with alice@company.com and join it" }
```

The voice AI will create the calendar event, get the Meet link, and auto-join.

---

## Meeting — Integrated Join Flow (Recommended)

The new integrated endpoint starts Voice AI + configures audio + joins meeting in one call:

```http
POST http://localhost:4000/api/meeting/join
Content-Type: application/json

{
  "url": "https://meet.google.com/abc-defg-hij",
  "instructions": "You are CallingClaw, a meeting assistant discussing the auth module refactoring."
}
```

**Response:**
```json
{
  "meetUrl": "https://meet.google.com/abc-defg-hij",
  "platform": "google_meet",
  "joinedAt": 1710000000000,
  "status": "in_meeting",
  "voice": "connected",
  "audio_mode": "meet_bridge"
}
```

This does 3 things automatically:
1. Starts OpenAI Realtime voice session (if not already running)
2. Configures Python sidecar audio bridge (meet_bridge mode)
3. Joins Google Meet/Zoom with camera & mic muted

### Leave Meeting (with auto-summary)

```http
POST http://localhost:4000/api/meeting/leave
```

Automatically: generates summary → exports markdown → creates tasks from action items → leaves meeting.

### Validate Meeting URL

```http
POST http://localhost:4000/api/meeting/validate
Content-Type: application/json

{ "url": "https://meet.google.com/abc-defg-hij" }
```

---

## 4-Layer Automation — Intelligent Computer Control

CallingClaw routes computer instructions through 4 layers, from fastest to most capable:

| Layer | Name | Speed | What it Does |
|-------|------|-------|-------------|
| L1 | Shortcuts & API | <100ms | Keyboard shortcuts (Zoom/Meet), app launch, URL open |
| L2 | Playwright MCP | 200-800ms | Browser DOM automation via accessibility tree |
| L3 | Peekaboo | 500ms-2s | macOS native GUI: window management, app focus |
| L4 | Computer Use | 3-10s | Claude Vision + pyautogui (fallback) |

### Check Automation Status

```http
GET http://localhost:4000/api/automation/status
```

```json
{
  "shortcuts": { "available": true },
  "playwright": { "available": true },
  "peekaboo": { "available": false, "detail": "Not installed" },
  "computer_use": { "available": true }
}
```

### Run Instruction (Auto-routed)

```http
POST http://localhost:4000/api/automation/run
Content-Type: application/json

{ "instruction": "Scroll down in the current browser tab" }
```

The router classifies the instruction and picks the best layer. Falls back to lower layers on failure.

### Classify Only (Dry-run)

```http
POST http://localhost:4000/api/automation/classify
Content-Type: application/json

{ "instruction": "Open Figma and select the login screen frame" }
```

```json
{
  "layer": 4,
  "action": "visual_interact",
  "reason": "Figma requires vision-based interaction"
}
```

---

## Meeting Prep Brief — Fast/Slow Thinking Architecture

CallingClaw uses a dual-process cognitive architecture:

- **System 1 (Fast Thinking)** — Voice AI (OpenAI Realtime): low latency (~300ms), conversational, limited context
- **System 2 (Slow Thinking)** — OpenClaw (Claude): full memory, deep reasoning, file system access

The Meeting Prep Brief bridges the gap:

### Workflow

```
1. OpenClaw generates MeetingPrepBrief (reads MEMORY.md + relevant files)
   → Structured JSON: topic, summary, keyPoints, architectureDecisions,
     expectedQuestions, filePaths, browserUrls

2. Brief injected into Voice AI system prompt
   → Voice knows what to discuss, can reference architecture decisions

3. Brief's file paths/URLs available to Computer Use
   → CU knows WHERE files are to open/present

4. During meeting: live notes pushed to Voice via session.update
   → Voice sees "[DONE] opened PRD file" and can narrate it
```

This is handled internally by CallingClaw — agents just need to provide the topic when starting a meeting.

---

## Configuration

### Get Current Config

```http
GET http://localhost:4000/api/config
```

```json
{
  "screen": { "width": 1920, "height": 1080, "captureFps": 1, "ssimThreshold": 0.95 },
  "audio": { "sampleRate": 16000, "channels": 1, "chunkMs": 20 },
  "openai_model": "gpt-4o-realtime-preview-2024-12-17",
  "openai_voice": "alloy",
  "anthropic_model": "claude-sonnet-4-20250514",
  "openrouter_model": "anthropic/claude-sonnet-4-20250514"
}
```

### Update Config

```http
POST http://localhost:4000/api/config
Content-Type: application/json

{
  "screen": { "width": 2560, "height": 1440 },
  "openai_voice": "shimmer"
}
```

### Update API Keys

```http
POST http://localhost:4000/api/keys
Content-Type: application/json

{
  "openai_api_key": "sk-...",
  "openrouter_api_key": "sk-or-v1-...",
  "anthropic_api_key": "sk-ant-..."
}
```

---

## Meeting Notes — Transcript & Summary

### Get Live Transcript

```http
GET http://localhost:4000/api/meeting/transcript?count=50
```

```json
{
  "entries": [
    { "role": "user", "text": "我觉得注册流程需要简化", "ts": 1710000000000 },
    { "role": "assistant", "text": "好的，我记录下来了。简化注册流程作为本次迭代的重点。", "ts": 1710000002000 }
  ],
  "text": "[user] 我觉得注册流程需要简化\n[assistant] 好的...",
  "total": 47
}
```

### Start/Stop Meeting Recording

```http
POST http://localhost:4000/api/meeting/start
POST http://localhost:4000/api/meeting/stop
```

### Generate Summary

```http
POST http://localhost:4000/api/meeting/summary
```

Returns structured JSON with title, participants, keyPoints, actionItems, decisions, followUps.

### Export to Markdown File

```http
POST http://localhost:4000/api/meeting/export
```

```json
{
  "ok": true,
  "filepath": "/path/to/meeting_notes/2026-03-10_1430_Sprint Planning.md",
  "summary": { ... }
}
```

### List Saved Notes

```http
GET http://localhost:4000/api/meeting/notes
```

```json
{ "files": ["2026-03-10_1430_Sprint Planning.md", "2026-03-09_1000_Standup.md"] }
```

---

## Typical Agent Workflows

### Workflow 1: Full Meeting Lifecycle (Recommended)

```
1. POST /api/voice/start {
     "instructions": "You are CallingClaw meeting assistant. Take notes, track action items.",
     "audio_mode": "meet_bridge"
   }
2. POST /api/voice/text { "text": "Join the meeting at https://meet.google.com/xxx" }
   → Voice AI joins Meet, starts recording, bidirectional audio active
3. (Meeting happens — AI listens, responds, takes notes automatically)
4. POST /api/voice/text { "text": "Save meeting notes and leave" }
   → AI generates summary, exports markdown, leaves meeting
5. GET  /api/meeting/notes
   → Get list of saved meeting note files
```

### Workflow 2: Schedule + Auto-join

```
1. POST /api/voice/start  { "audio_mode": "meet_bridge" }
2. POST /api/voice/text   { "text": "帮我约 alice@co.com 明天下午2点开会，创建好之后自动加入" }
   → Voice AI creates calendar event → gets Meet link → joins → recording starts
```

### Workflow 3: Automated Screen Task

```
1. GET  /api/status        → verify bridge is connected
2. POST /api/computer/run  { "instruction": "Open Slack and send 'Hello team' to #general" }
   → Returns { "summary": "...", "steps": [...] }
```

### Workflow 4: Meeting + Screen Sharing

```
1. POST /api/voice/start  { "audio_mode": "meet_bridge" }
2. POST /api/voice/text   { "text": "Join meeting at <url>" }
   → AI joins meeting
3. POST /api/voice/text   { "text": "Share my screen and open the sprint board" }
   → AI calls computer_action tool internally:
      Claude CU clicks "Present now" → selects screen → opens Jira board
4. POST /api/meeting/export
   → Save notes after meeting
```

### Workflow 5: Meeting with Prep Brief (Full AI-Assisted Meeting)

```
── OpenClaw (System 2: Slow Thinking) ──────────────────────────

1. POST /api/context/workspace     ← inject meeting context
2. POST /api/meeting/join          ← one call: voice + audio + join
   { "url": "https://meet.google.com/xxx",
     "instructions": "Review the CallingClaw PRD with the team..." }

── CallingClaw (System 1: Fast Thinking) ───────────────────────

3. Voice AI guides discussion using Meeting Prep Brief
   - References keyPoints and architectureDecisions
   - Proactively addresses expectedQuestions
4. Voice AI triggers Computer Use:
   "Open the PRD file" → L1 shortcut → open -a "VS Code" /path/to/prd
   "Show the architecture diagram" → L2 Playwright → navigate to Figma URL
5. Task completion notified to Voice:
   "[DONE] opened PRD in VS Code" → Voice says "The PRD is now open"

── Meeting ends ─────────────────────────────────────────────────

6. POST /api/meeting/leave
   → summary + markdown export + task creation
7. OpenClaw receives webhook → executes action items → reports done
```

---

## Error Handling

All error responses follow this format:

```json
{ "error": "Human-readable error message" }
```

| HTTP Code | Meaning |
|-----------|---------|
| 200 | Success |
| 400 | Missing required field or key not configured |
| 404 | Endpoint not found or resource not found |
| 500 | Internal error (check CallingClaw terminal logs) |

### Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `"OpenAI API key not configured"` | No OPENAI_API_KEY | POST /api/keys with openai_api_key |
| `"Anthropic API key not configured"` | No ANTHROPIC/OPENROUTER key | POST /api/keys with openrouter_api_key |
| `"No Python client connected"` | Python sidecar not running | Restart CallingClaw or check Python path |
| `"WebSocket connection failed"` | OpenAI Realtime connection issue | Check API key validity and network |

---

## Architecture Reference

```
┌──────────────────────────────────────────────────────────────┐
│                    Agent / OpenClaw                           │
│        (System 2: Slow Thinking, Deep Reasoning)             │
│              (calls REST API on :4000)                        │
└──────────────┬───────────────────────────────────────────────┘
               │ HTTP REST
               ▼
┌──────────────────────────────────────────────────────────────┐
│               Bun Main Process (:4000)                       │
│                                                              │
│  ┌──────────┐  ┌──────────────┐  ┌──────────┐  ┌──────────┐ │
│  │  Voice   │  │  Automation  │  │ Calendar │  │  Config  │ │
│  │  Module  │  │   Router     │  │  Module  │  │  Server  │ │
│  │(System 1)│  │  (4-Layer)   │  │          │  │(REST API)│ │
│  └────┬─────┘  └──┬─┬─┬──┬───┘  └────┬─────┘  └──────────┘ │
│       │           │ │ │  │            │                      │
│       ▼           │ │ │  ▼            ▼                      │
│  OpenAI RT WS     │ │ │ Claude CU  Google Cal REST           │
│  (24kHz PCM)      │ │ │ (L4 Vision) (OAuth2)                │
│                   │ │ ▼                                      │
│  ┌─────────────┐  │ │ Peekaboo                               │
│  │MeetingPrep  │  │ ▼ (L3 macOS)                             │
│  │Brief + Live │  │ Playwright                               │
│  │Context Sync │  │ (L2 Browser)                             │
│  └─────────────┘  ▼                                          │
│                 Shortcuts (L1)                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                   │
│  │EventBus  │  │TaskStore │  │ Webhooks │                   │
│  └──────────┘  └──────────┘  └──────────┘                   │
└──────────────┬───────────────────────────────────────────────┘
               │ WebSocket (:4001)
               ▼
┌──────────────────────────────────────────────────────────────┐
│              Python Sidecar (:4001)                           │
│  Audio Bridge (PyAudio) │ Screen (mss) │ Mouse/KB (pyautogui)│
└──────────────────────────────────────────────────────────────┘
```

---

## Event Bus — Real-time Push Notifications

### Subscribe via WebSocket

Connect to receive real-time events as they happen:

```
ws://localhost:4000/ws/events
```

Events are JSON messages:

```json
{
  "type": "meeting.ended",
  "timestamp": 1710000000000,
  "correlationId": "mtg_abc123",
  "data": {
    "filepath": "/path/to/notes.md",
    "summary": { "title": "Sprint Review", "actionItems": [...] },
    "tasks": [{ "id": "task_xyz", "task": "Refactor auth module" }]
  }
}
```

**Event Types:**

| Event | When | Data |
|-------|------|------|
| `meeting.joining` | CallingClaw starts joining a Meet | `{ meet_url }` |
| `meeting.started` | Successfully joined + recording | `{ meet_url, correlation_id }` |
| `meeting.action_item` | Action item detected in transcript | `{ text, assignee }` |
| `meeting.stopped` | Recording stopped | `{}` |
| `meeting.ended` | Meeting exported + tasks created | `{ filepath, summary, tasks }` |
| `voice.started` | Voice session connected | `{ audio_mode }` |
| `voice.stopped` | Voice session disconnected | `{}` |
| `computer.task_started` | CU task begins | `{ instruction }` |
| `computer.task_done` | CU task completed | `{ instruction, summary }` |
| `task.created` | New task created | `{ task }` |
| `task.updated` | Task status changed | `{ task }` |
| `workspace.updated` | Workspace context injected | `{ topic, fileCount }` |

### Register a Webhook

For agents that prefer HTTP callbacks:

```http
POST http://localhost:4000/api/webhooks
Content-Type: application/json

{
  "url": "http://localhost:5000/callingclaw-events",
  "events": ["meeting.*", "task.*"],
  "secret": "my-signing-secret"
}
```

**Response:** `{ "id": "wh_abc123", "url": "...", "events": [...] }`

Events matching the filter are POST'd to the URL. If `secret` is set, requests include `X-CallingClaw-Signature` header (HMAC-SHA256).

### List / Delete Webhooks

```http
GET    http://localhost:4000/api/webhooks
DELETE http://localhost:4000/api/webhooks/wh_abc123
```

### Get Event History

```http
GET http://localhost:4000/api/events?count=50&type=meeting.*
```

---

## Task Store — Structured Task Management

Tasks are created automatically from meeting action items and can also be created manually.

### List Tasks

```http
GET http://localhost:4000/api/tasks?status=pending&assignee=openclaw
```

**Filters:** `status` (pending/in_progress/done/cancelled), `meeting_id`, `assignee`, `priority`

```json
{
  "tasks": [
    {
      "id": "task_abc123",
      "task": "Refactor auth module to use PKCE flow",
      "status": "pending",
      "priority": "high",
      "assignee": "openclaw",
      "deadline": "2026-03-12",
      "context": "User said the current OAuth flow is too complex",
      "sourceMeetingId": "mtg_xyz789",
      "createdAt": 1710000000000,
      "updatedAt": 1710000000000
    }
  ],
  "stats": { "total": 5, "pending": 3, "in_progress": 1, "done": 1, "cancelled": 0 }
}
```

### Create a Task

```http
POST http://localhost:4000/api/tasks
Content-Type: application/json

{
  "task": "Review pull request #42",
  "priority": "high",
  "assignee": "openclaw",
  "deadline": "2026-03-11"
}
```

### Update Task Status (Agent Reports Back)

```http
PATCH http://localhost:4000/api/tasks/task_abc123
Content-Type: application/json

{
  "status": "done",
  "result": "Refactored auth module. See commit abc123."
}
```

### Delete a Task

```http
DELETE http://localhost:4000/api/tasks/task_abc123
```

---

## Workspace Context — Pre-meeting File Injection

Before starting a meeting, inject workspace context so the Voice AI knows what to discuss:

### Set Workspace Context

```http
POST http://localhost:4000/api/context/workspace
Content-Type: application/json

{
  "topic": "Review auth module refactoring",
  "files": [
    { "path": "src/auth.ts", "summary": "Added OAuth2 PKCE flow", "diffLines": 45 },
    { "path": "src/config.ts", "summary": "Added Google credentials config", "diffLines": 12 }
  ],
  "git_summary": "3 commits: add OAuth PKCE, fix token refresh, update config",
  "discussion_points": [
    "Is the PKCE implementation correct?",
    "Should we add token rotation?"
  ]
}
```

This context is automatically injected into the Voice AI's system prompt when a session starts.

### Clear Workspace Context

```http
DELETE http://localhost:4000/api/context/workspace
```

---

## Screen Sharing — Present in Google Meet

### Start Screen Sharing

```http
POST http://localhost:4000/api/screen/share
```

**Response:** `{ "ok": true, "sharing": true }`

### Stop Screen Sharing

```http
POST http://localhost:4000/api/screen/stop
```

### Open File on Screen

```http
POST http://localhost:4000/api/screen/open
Content-Type: application/json

{ "path": "/path/to/file.ts", "app": "vscode" }
```

**App options:** `"vscode"`, `"browser"`, `"finder"`

---

## Full Agent Workflow: OpenClaw + CallingClaw

The complete workflow for "OpenClaw schedules a review meeting with the user":

```
── OpenClaw (orchestrator) ──────────────────────────────────────

1. POST /api/context/workspace     ← inject files + git diff + discussion points
2. POST /api/webhooks              ← register callback for meeting.ended + task.*
3. POST /api/voice/start           ← start voice session (auto-includes workspace context)
   { "audio_mode": "meet_bridge" }
4. POST /api/voice/text
   { "text": "Create a meeting called 'Auth Module Review' with user@co.com and join it" }

── CallingClaw (autonomous) ─────────────────────────────────────

5. Voice AI → create_and_join_meeting tool → Google Calendar → Meet link
6. Voice AI joins Meet → bidirectional audio active
7. User and AI discuss the files (AI knows the workspace context)
8. AI uses share_screen + open_file to show code during discussion
9. Meeting notes captured in real-time, action items extracted

── Meeting ends ─────────────────────────────────────────────────

10. Voice AI → leave_meeting tool
    - Generates summary → exports markdown → creates tasks
    - EventBus pushes: meeting.ended { filepath, summary, tasks }

── OpenClaw receives webhook ────────────────────────────────────

11. GET /api/tasks?status=pending  ← fetch tasks from this meeting
12. OpenClaw executes each task (code changes, PRs, etc.)
13. PATCH /api/tasks/:id           ← report back: { status: "done", result: "..." }
14. Next meeting: tasks show as completed ✓
```

---

## Port Reference

| Port | Protocol | Purpose |
|------|----------|---------|
| 4000 | HTTP | REST API + Web Config UI |
| 4000 | WebSocket | Event Bus (`/ws/events`) |
| 4001 | WebSocket | Python sidecar bridge |
