# Decoupling CallingClaw from OpenClaw: WebSocket Command Channel

> **Status: PLANNED** — This document describes a future architectural change. None of the phases below are implemented yet. The current codebase still uses HTTP callbacks and shared filesystem.

## Problem

CallingClaw (CC) and OpenClaw (OC) were designed to run on the same machine. Three assumptions break when they're on different machines (e.g., CC on a Mac behind NAT, OC on a remote server):

### 1. HTTP Callbacks (OC → CC)
OC calls `localhost:4000` to push commands to CC. Behind NAT, CC is unreachable.

| Callback | Where | Purpose |
|----------|-------|---------|
| `POST /api/meeting/autojoin` | OC-003 cron fires | Auto-join meeting at scheduled time |
| `GET /api/meeting/notes/{id}` | OC-006 todo execution | Read meeting notes for task context |
| `GET/POST /api/*` | `/callingclaw` skill | OC agent controls CC (voice, screen, etc.) |

### 2. Shared Filesystem
Both read/write `~/.callingclaw/shared/` and `~/.openclaw/workspace/`. On separate machines, these are different filesystems.

### 3. Shared Config
Both read `~/.openclaw/openclaw.json` for the gateway token.

## Solution: WebSocket as Single Channel

CC already opens a WebSocket to OC (`ws://server:18789`). This connection is:
- **Bidirectional** — both sides can send at any time
- **NAT-friendly** — CC initiates outbound, then both sides use it
- **Already working** — `chat` events flow back on it today

### Architecture Change

```
BEFORE:
  CC ──── WS (tasks) ────→ OC     outbound only
  CC ◄─── HTTP callback ── OC     breaks behind NAT
  CC ←→ shared filesystem ←→ OC   breaks on separate machines

AFTER:
  CC ════ WS (bidirectional) ════ OC
  - CC → OC: task requests (prep, summary, recall)
  - OC → CC: results + commands (auto-join, todo confirm)
  - File content sent inline (no shared filesystem)
```

## Implementation Plan

### Phase 1: Auto-Join via Local Timer (remove OC-003 callback)

**Current flow:**
```
MeetingScheduler polls calendar
  → sends OC-003 to OpenClaw cron
  → OpenClaw fires cron at meeting time
  → HTTP POST localhost:4000/api/meeting/autojoin  ← BREAKS
```

**New flow:**
```
MeetingScheduler polls calendar
  → setTimeout(autoJoin, timeUntilMeeting - 2min)  ← LOCAL
  → at meeting time, joins directly
```

**Changes:**
- `meeting-scheduler.ts`: Replace `registerCronJob()` with local `setTimeout`
- Remove OC-003 cron registration
- Add `autoJoin(event)` method that emits EventBus event
- `callingclaw.ts`: Listen for `scheduler.auto_join` → call join logic

### Phase 2: WS Command Channel (replace HTTP callbacks)

**CC declares commands in WS connect handshake:**
```typescript
// openclaw_bridge.ts sendConnectRequest()
commands: [
  "callingclaw.status",
  "callingclaw.meeting.join",
  "callingclaw.meeting.leave",
  "callingclaw.meeting.notes.read",
  "callingclaw.voice.start",
  "callingclaw.voice.stop",
  "callingclaw.voice.text",
  "callingclaw.calendar.events",
  "callingclaw.screenshot",
  "callingclaw.tasks",
  "callingclaw.tasks.confirm",
  "callingclaw.health",
  "callingclaw.postmeeting.callback",
]
```

**CC handles incoming commands:**
```typescript
// New event in onMessage():
if (msg.event === "node.invoke.request") {
  const { id, command, params } = msg.payload;
  const result = await commandHandler.execute(command, params);
  this.request("node.invoke.result", { id, ...result });
}
```

**New file: `ws-command-handler.ts`**
- Maps command names to handler functions
- Reuses same logic as REST endpoints in `config_server.ts`
- Returns `{ ok, payload?, error? }`

### Phase 3: Inline File Content (remove shared filesystem)

**Current:** OC reads meeting notes from `~/.callingclaw/shared/notes/`
**New:** CC sends notes content inline in the OC-006 request

```typescript
// post-meeting-delivery.ts
const notesContent = await Bun.file(notesPath).text();
bridge.sendTask(OC006_PROMPT({ ...req, notesContent }));
```

### Phase 4: Update /callingclaw Skill Manifest

**Current:** OC agent calls `curl localhost:4000/api/...`
**New:** OC agent uses `node.invoke` on CC's declared commands

```
Before: /callingclaw status → fetch("http://localhost:4000/api/status")
After:  /callingclaw status → node.invoke("callingclaw.status")
```

## What Each Phase Fixes

| Phase | Fixes | Effort |
|-------|-------|--------|
| 1. Local timer | Auto-join behind NAT | Small (1 file) |
| 2. WS commands | /callingclaw skill + todo callback | Medium (3 new files) |
| 3. Inline content | Shared filesystem dependency | Small (2 files) |
| 4. Skill manifest | OC agent discovery | Small (1 file) |

## Result

After all phases:
- CC and OC can run on **any topology** (same machine, different machines, Docker, cloud)
- No localhost assumptions, no shared filesystem, no NAT issues
- REST endpoints still work for Desktop UI (local HTTP is fine)
- WebSocket is the single source of truth for CC ↔ OC communication
