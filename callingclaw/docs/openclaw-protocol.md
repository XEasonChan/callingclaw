# CallingClaw ↔ OpenClaw Protocol Reference

> All message schemas between CallingClaw and OpenClaw, with IDs for cross-reference.
> Source of truth: `callingclaw/src/openclaw-protocol.ts`

---

## Protocol Overview

CallingClaw communicates with OpenClaw via WebSocket JSON-RPC on `ws://localhost:18789`.
All calls go through `OpenClawBridge.sendTask(prompt)` → returns response text.

Each call type has:
- **Schema ID** (`OC-xxx`) — stable identifier for docs and code
- **Typed Request** — structured input with TypeScript interface
- **Prompt Template** — the actual text sent to OpenClaw
- **Typed Response** — expected output format with parser
- **Failure mode** — what happens when it fails

---

## Schema Index

| ID | Name | Trigger | Response Format | Latency |
|----|------|---------|----------------|---------|
| OC-001 | Meeting Prep Brief | Pre-meeting | **JSON** (parsed) | 5-15s |
| OC-002 | Context Recall | Voice `recall_context` tool | Text <500w | 2-10s |
| OC-003 | Calendar Cron | MeetingScheduler poll | Job ID (regex) | 2-5s |
| OC-004 | Todo Delivery | Meeting ends + todos | "sent" | 3-8s |
| OC-005 | Summary Delivery | Meeting ends, no todos | "sent" | 3-8s |
| OC-006 | Todo Execution | User confirms todo | JSON status | 10-60s |
| OC-007 | Vision Push | Every ~40s in meeting | "ok" (fire & forget) | 2-5s |
| OC-008 | CU Delegation | Claude CU agent | Text result | 5-30s |
| OC-009 | Follow-up Fallback | Delivery fails | "ok" (fire & forget) | 2-5s |

---

## OC-001: Meeting Prep Brief Generation

**File**: `skills/meeting-prep.ts` → `MeetingPrepSkill.generate()`

### Request
```typescript
interface OC001_Request {
  id: "OC-001";
  topic: string;                    // "CallingClaw 2.0 PRD review"
  userContext?: string;             // Additional user instructions
  attendees?: Array<{
    name: string;
    email: string;
    status?: string;                // "accepted" | "declined" | "tentative"
  }>;
}
```

### Response (JSON)
```typescript
interface OC001_Response {
  topic: string;
  goal: string;
  summary: string;                  // 2-3 paragraphs in user's language
  keyPoints: string[];              // 5-8 items
  architectureDecisions: Array<{ decision: string; rationale: string }>;
  expectedQuestions: Array<{ question: string; suggestedAnswer: string }>;
  previousContext?: string;
  filePaths: Array<{ path: string; description: string; action?: "open"|"scroll"|"present" }>;
  browserUrls: Array<{ url: string; description: string; action?: "navigate"|"demo"|"show" }>;
  folderPaths: Array<{ path: string; description: string }>;
}
```

### Parse: JSON regex extraction with raw text fallback

---

## OC-002: Context Recall

**File**: `tool-definitions/ai-tools.ts` → `recall_context` handler

### Request
```typescript
interface OC002_Request {
  id: "OC-002";
  query: string;                    // "Tanka Link Phase II test results"
  localContext?: string;            // Pre-fetched from ContextSync keyword search
  language: string;                 // "zh" | "en" | "ja"
}
```

### Response
```typescript
interface OC002_Response {
  answer: string;                   // Concise factual answer, <500 words
}
```

### Parse: Direct text, capped at 3000 chars

---

## OC-003: Calendar Cron Registration

**File**: `modules/meeting-scheduler.ts` → `MeetingScheduler.registerAutoJoin()`

### Request
```typescript
interface OC003_Request {
  id: "OC-003";
  cronName: string;                 // "auto-join: CallingClaw PRD review"
  joinAtISO: string;                // "2026-03-17T14:58:00+08:00"
  eventSummary: string;
  eventDescription: string;         // Full event context for OpenClaw
}
```

### Response
```typescript
interface OC003_Response {
  jobId: string;                    // Cron job ID, e.g. "cron_abc123"
}
```

### Parse: Regex `job[_\s]?[Ii][Dd][\s:]*[`"']?([a-zA-Z0-9_-]+)`, fallback `auto_${Date.now()}`

---

## OC-004: Post-Meeting Todo Delivery (Telegram)

**File**: `modules/post-meeting-delivery.ts` → `PostMeetingDelivery.deliver()`

### Request
```typescript
interface OC004_Request {
  id: "OC-004";
  topic: string;
  meetingId: string;
  todos: Array<{
    id: string;
    text: string;                   // Compressed ≤20 chars for button display
    fullText: string;
    assignee?: string;
    deadline?: string;
  }>;
}
```

### Response
```typescript
interface OC004_Response {
  sent: boolean;                    // Whether Telegram message was sent
}
```

### Parse: Checks if response contains "sent"

---

## OC-005: Summary Delivery (no todos)

**File**: `modules/post-meeting-delivery.ts`

### Request
```typescript
interface OC005_Request {
  id: "OC-005";
  topic: string;
  keyPoints: string[];
  decisions: string[];
}
```

### Response
```typescript
interface OC005_Response {
  sent: boolean;
}
```

---

## OC-006: Todo Execution Handoff

**File**: `modules/post-meeting-delivery.ts` → `PostMeetingDelivery.executeTodo()`

### Request
```typescript
interface OC006_Request {
  id: "OC-006";
  todo: {
    fullText: string;
    assignee?: string;
    deadline?: string;
  };
  meeting: {
    topic: string;
    time: string;                   // ISO 8601
    notesFilePath: string;
    decisions: string[];
    requirements: string[];
    liveNotes: string[];
  };
}
```

### Response (JSON)
```typescript
interface OC006_Response {
  status: "started" | "completed" | "failed";
  summary: string;
}
```

### Parse: JSON regex extraction, fallback to `{ status: "started", summary: raw }`

---

## OC-007: Meeting Vision Context Push

**File**: `callingclaw.ts` → vision batch handler

### Request
```typescript
interface OC007_Request {
  id: "OC-007";
  reason: "batch" | "final";
  screenDescriptions: string[];     // AI-generated screen descriptions
}
```

### Response
```typescript
interface OC007_Response {
  acknowledged: boolean;
}
```

### Note: Fire-and-forget. Response is not checked.

---

## OC-008: Computer Use Task Delegation

**File**: `modules/computer-use.ts` → `openclaw` tool handler

### Request
```typescript
interface OC008_Request {
  id: "OC-008";
  task: string;                     // Natural language task from Claude CU
}
```

### Response
```typescript
interface OC008_Response {
  result: string;                   // Capped at 10,000 chars
}
```

---

## OC-009: Post-Meeting Follow-up Fallback

**File**: `tool-definitions/meeting-tools.ts`

### Request
```typescript
interface OC009_Request {
  id: "OC-009";
  topic: string;
  time: string;
  filepath: string;
  keyPoints: string[];
  tasks: Array<{ task: string }>;
}
```

### Response
```typescript
interface OC009_Response {
  acknowledged: boolean;
}
```

### Note: Fallback when PostMeetingDelivery Telegram fails. Fire-and-forget.

---

## Error Handling

All calls share the same failure modes from `OpenClawBridge`:

| Failure | Timeout | Behavior |
|---------|---------|----------|
| Connection failed | 6s | Falls back to local-only (no OpenClaw features) |
| Task timeout | 120s | Returns "OpenClaw task timed out (2 minutes)." |
| WebSocket error | — | Auto-reconnect after 5s |
| Disconnect during task | — | Resolves with "OpenClaw disconnected: ..." |

---

## Implementation

All prompt builders and parsers are in `src/openclaw-protocol.ts`.

Usage:
```typescript
import { OC001_PROMPT, parseOC001, type OC001_Request } from "./openclaw-protocol";

const req: OC001_Request = { id: "OC-001", topic: "CallingClaw PRD review" };
const raw = await openclawBridge.sendTask(OC001_PROMPT(req));
const brief = parseOC001(raw, req.topic);
```
