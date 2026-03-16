# CallingClaw 2.0 — Agent Reference & Version Maintenance

> For AI agents (Claude Code, OpenClaw, custom agents) working on this codebase.
> Last updated: 2026-03-12 | Version: **2.2.1** | Branch: `feat/electron-shell`

---

## 1. What is CallingClaw 2.0?

A **local-first AI meeting assistant** that runs on a dedicated machine with its own screen, audio, and browser. It provides:

- **Real-time voice** — OpenAI Realtime API (bidirectional audio, function calling)
- **Computer Use** — Claude Vision + pyautogui (screen analysis + mouse/keyboard)
- **4-layer automation** — Shortcuts → Playwright → Peekaboo → Computer Use
- **Meeting lifecycle** — Auto-join Meet/Zoom, transcript, notes, action items
- **Calendar integration** — Google Calendar REST API + OAuth2
- **REST API on :4000** — Any agent can control CallingClaw via HTTP

This is a **complete rewrite** of CallingClaw 1.0 (Chrome extension + Vocode). The old extension is deprecated.

---

## 2. Architecture Overview

```
┌─── Agent / OpenClaw (System 2: Slow Thinking) ───┐
│   Calls REST API on :4000                         │
└──────────────────┬────────────────────────────────┘
                   │ HTTP / WebSocket
                   ▼
┌─── Bun Main Process (:4000) ─────────────────────┐
│                                                    │
│  VoiceModule ──→ OpenAI Realtime WebSocket         │
│  ComputerUseModule ──→ Claude (OpenRouter)         │
│  AutomationRouter (L1→L2→L3→L4 fallback)          │
│  MeetingModule (transcript + summary + export)     │
│  GoogleCalendarClient (REST + OAuth2)              │
│  MeetJoiner (Chrome automation + audio bridge)     │
│  EventBus + TaskStore + ConfigServer               │
│                                                    │
└──────────────────┬────────────────────────────────┘
                   │ WebSocket (:4001)
                   ▼
┌─── Python Sidecar (:4001) ───────────────────────┐
│  Screen capture (mss) │ Audio I/O (pyaudio)       │
│  Mouse/Keyboard (pyautogui) │ BlackHole bridge    │
└───────────────────────────────────────────────────┘
```

### Dual-Process Cognitive Model

| System | Role | Latency | Engine |
|--------|------|---------|--------|
| **System 1 (Fast)** | Voice AI — conversational, tool-calling | ~300ms | OpenAI Realtime |
| **System 2 (Slow)** | Deep reasoning, file access, memory | 2-10s | Claude (OpenClaw) |

### System 1 ↔ System 2 Context Bridge

The two systems have **separate context windows with no shared memory**. Three mechanisms bridge the gap:

| Mechanism | Direction | When | Module |
|-----------|-----------|------|--------|
| **Meeting Prep Brief** | System 2 → System 1 | Pre-meeting | `MeetingPrepSkill` |
| **ContextSync** | Shared ↔ Both | Continuous | `ContextSync` |
| **Dynamic Context Push** | System 2 → System 1 | During meeting | `pushContextUpdate()` |
| **OpenClaw Bridge** | System 1 → System 2 | On-demand delegation | `OpenClawBridge` |

```
┌─── PRE-MEETING ─────────────────────────────────────────────┐
│                                                              │
│  OpenClaw (System 2)                                         │
│    reads MEMORY.md + project files + git context             │
│    │                                                         │
│    ▼                                                         │
│  MeetingPrepSkill.generate(topic)                            │
│    │  → sends prompt to OpenClaw via OpenClawBridge          │
│    │  → OpenClaw returns structured JSON                     │
│    ▼                                                         │
│  MeetingPrepBrief {                                          │
│    topic, goal, summary, keyPoints,                          │
│    architectureDecisions, expectedQuestions,                  │
│    filePaths[], browserUrls[], folderPaths[]                 │
│  }                                                           │
│    │                                                         │
│    ├──→ buildVoiceInstructions(brief)                        │
│    │      → injected into Voice AI system prompt             │
│    │      → Voice knows WHAT to discuss                      │
│    │                                                         │
│    └──→ getComputerBrief()                                   │
│           → injected into Computer Use context               │
│           → CU knows WHERE files are to open/present         │
│                                                              │
├─── DURING MEETING ──────────────────────────────────────────┤
│                                                              │
│  OpenClaw adds live notes:                                   │
│    MeetingPrepSkill.addLiveNote("new finding...")            │
│    │                                                         │
│    ▼                                                         │
│  pushContextUpdate(voiceModule, prepSkill)                   │
│    → rebuilds system prompt with updated liveNotes           │
│    → sends session.update to OpenAI Realtime                 │
│    → Voice AI now sees the new context                       │
│                                                              │
│  Computer Use completes a task:                              │
│    notifyTaskCompletion(voice, prep, "open PRD", "done")     │
│    → adds "[DONE] open PRD: done" to liveNotes              │
│    → pushContextUpdate → Voice says "The PRD is now open"    │
│                                                              │
├─── POST-MEETING ────────────────────────────────────────────┤
│                                                              │
│  getPostMeetingSummary(prepSkill)                            │
│    → returns liveNotes, completedTasks, requirements         │
│    → OpenClaw processes & saves to MEMORY.md                 │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. Meeting Prep Brief — System 2 → System 1 Context Injection

**Source:** `src/skills/meeting-prep.ts` + `src/voice-persona.ts`

The Meeting Prep Brief is the primary mechanism for transferring OpenClaw's deep knowledge into the Voice AI's limited context window.

### Brief Structure (`MeetingPrepBrief`)

```typescript
{
  topic: string;                    // "CallingClaw 2.0 PRD review"
  goal: string;                     // "Align on architecture decisions"
  summary: string;                  // 2-3 paragraph overview (user's language)
  keyPoints: string[];              // 5-8 bullet talking points

  // For Voice AI — conversational context
  architectureDecisions: [          // WHY things were built this way
    { decision: "Use Bun not Node", rationale: "Native WebSocket, faster startup" }
  ];
  expectedQuestions: [              // Proactive Q&A preparation
    { question: "Why not Express?", suggestedAnswer: "Bun.serve() is built-in..." }
  ];
  previousContext?: string;         // Previous meeting outcomes

  // For Computer Use — executable references
  filePaths: [                      // Local files: Peekaboo/Finder can open
    { path: "/abs/path/to/prd.md", description: "PRD doc", action: "present" }
  ];
  browserUrls: [                    // URLs: Playwright L2 can navigate
    { url: "https://github.com/...", description: "Repo", action: "navigate" }
  ];
  folderPaths: [                    // Directories to show
    { path: "/abs/path/to/src/", description: "Source code" }
  ];

  // Dynamic — updated during meeting
  liveNotes: string[];              // "[DONE] opened PRD", "[REQ] need auth refactor"
}
```

### Generation Flow

```
1. Agent calls: POST /api/meeting/join { url, instructions }
   OR: prepareMeeting(prepSkill, "topic")

2. MeetingPrepSkill.generate(topic)
     → Builds prompt from MEETING_PREP_PROMPT template
     → Sends to OpenClaw via OpenClawBridge.sendTask()
     → OpenClaw reads MEMORY.md + relevant files
     → Returns structured JSON

3. buildVoiceInstructions(brief)
     → MEETING_PERSONA (role + behavior rules)
     → ═══ MEETING PREP BRIEF (from OpenClaw) ═══
     → topic, goal, summary, keyPoints
     → architectureDecisions (for "why" questions)
     → expectedQuestions (proactive answers)
     → filePaths + browserUrls (for "show me" requests)
     → liveNotes (dynamic updates)

4. VoiceModule.start(instructions)
     OR: VoiceModule.updateInstructions(instructions)
```

### Voice Persona Modes

| Mode | Persona | When |
|------|---------|------|
| **Default** | `DEFAULT_PERSONA` — general assistant | No meeting prep |
| **Meeting** | `MEETING_PERSONA` + Brief | After `prepareMeeting()` |

The `MEETING_PERSONA` instructs Voice AI to:
- Use `keyPoints` to guide discussion flow
- Reference `architectureDecisions` when asked "why"
- Proactively address `expectedQuestions`
- Trigger Computer Use for `filePaths`/`browserUrls` when asked to "show"
- Acknowledge `liveNotes` updates (e.g., "[DONE] opened PRD")
- Track: requirements, decisions, open questions, action items

---

## 4. ContextSync — Shared Memory Across All Systems

**Source:** `src/modules/context-sync.ts`

ContextSync is the persistent shared context layer. Unlike the Meeting Prep Brief (one-shot generation), ContextSync continuously aggregates context from multiple sources and generates tiered briefs.

### Data Sources

```
ContextSync
  ├── OpenClaw MEMORY.md      ← ~/.openclaw/workspace/MEMORY.md (auto-loaded)
  ├── Pinned Files[]           ← agent pins files via REST API
  └── Custom Notes[]           ← free-text session notes
```

### Tiered Brief Generation

| Target | Max Chars | Content |
|--------|-----------|---------|
| **Voice brief** | 2,000 (~500 tokens) | User profile, current work, pinned file summaries, notes |
| **Computer brief** | 8,000 (~2,000 tokens) | User profile, infrastructure, full pinned file contents |

Voice gets summaries-only (token-efficient); Computer Use gets full file contents (needs detail for screen operations).

### Auto-Injection into Voice Sessions

When a voice session starts (`POST /api/voice/start`), the config server automatically appends:
1. **Workspace context** — from `SharedContext.getWorkspacePrompt()` (meeting topic, files, git diff)
2. **ContextSync voice brief** — from `ContextSync.getBrief().voice` (user profile, pinned files)

This happens transparently — agents don't need to manually inject context.

### REST API for ContextSync

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/context/sync` | Status: memory loaded?, pinned files, brief lengths |
| GET | `/api/context/brief` | Get both briefs (voice + computer) with char counts |
| POST | `/api/context/pin` | Pin a file `{ path, summary? }` — reads from disk |
| DELETE | `/api/context/pin` | Unpin a file `{ path }` |
| POST | `/api/context/note` | Add session note `{ note }` |
| POST | `/api/context/reload` | Reload OpenClaw MEMORY.md from disk |

### ContextSync + Voice Live Push

ContextSync registers an `onUpdate` callback. When pinned files or notes change:
1. `ContextSync` fires `_onUpdate()`
2. Callback rebuilds voice instructions with updated brief
3. Calls `VoiceModule.updateInstructions()` → OpenAI Realtime `session.update`
4. Voice AI immediately sees the new context

---

## 5. OpenClaw Bridge — System 1 → System 2 Delegation

**Source:** `src/openclaw_bridge.ts`

The OpenClaw Bridge is a WebSocket client that connects to OpenClaw's local Gateway (`ws://localhost:18789`). It allows CallingClaw's fast-thinking layer to delegate complex tasks to OpenClaw's slow-thinking agent.

### Protocol

```
CallingClaw (Bun)  ←—— WebSocket ——→  OpenClaw Gateway (:18789)

Frame types:
  Request:  { type: "req",   id, method, params }
  Response: { type: "res",   id, ok, payload, error }
  Event:    { type: "event", event, payload, seq }
```

### Connection Flow

```
1. Read token from ~/.openclaw/openclaw.json
2. Connect to ws://localhost:18789
3. Receive "connect.challenge" event
4. Send "connect" request with auth token, role: "operator"
5. Receive response with session snapshot
6. Connected — sessionKey established
```

### Task Delegation

```typescript
// CallingClaw delegates a task to OpenClaw
const result = await openclawBridge.sendTask(
  "Generate a meeting prep brief about CallingClaw 2.0 architecture"
);
// OpenClaw reads its MEMORY.md, project files, and returns structured result
// Timeout: 2 minutes per task
```

### Real-time Activity Feed

The bridge exposes streaming activity events for visibility:

| Event | When | Data |
|-------|------|------|
| `openclaw.delta` | Streaming response chunk | First 80 chars of text |
| `openclaw.done` | Task completed | Full response text |
| `openclaw.error` | Task failed or aborted | Error message |

### Auto-Reconnect

If OpenClaw disconnects, the bridge schedules reconnection after 5 seconds. Pending requests are flushed with error. If OpenClaw is unreachable when `sendTask` is called, it returns a fallback message: "OpenClaw is not running. Use bash or computer tools instead."

---

## 6. Dynamic Context Push — Live Updates During Meetings

**Source:** `src/voice-persona.ts` (functions `pushContextUpdate`, `notifyTaskCompletion`)

During a live meeting, context flows continuously from System 2 → System 1:

### Push Mechanism

```typescript
// 1. OpenClaw discovers something → adds live note
meetingPrepSkill.addLiveNote("[REQ] User wants auth refactor by Friday");

// 2. Push to Voice AI
pushContextUpdate(voiceModule, prepSkill);
//   → Rebuilds full system prompt: MEETING_PERSONA + brief + updated liveNotes
//   → voiceModule.updateInstructions(newPrompt)
//   → OpenAI Realtime session.update event
//   → Voice AI now sees "[REQ] User wants auth refactor by Friday"

// 3. Computer Use completes a task → notify Voice
notifyTaskCompletion(voiceModule, prepSkill, "open PRD file", "opened in VS Code");
//   → Adds "[DONE] open PRD file: opened in VS Code" to liveNotes
//   → pushContextUpdate() → Voice says "The PRD is now open"
```

### What Gets Pushed

| Prefix | Meaning | Example |
|--------|---------|---------|
| `[DONE]` | Computer Use task completed | `[DONE] open PRD: opened in Chrome` |
| `[REQ]` | Requirement captured | `[REQ] Need SSO by Q3` |
| (none) | General note | `User prefers dark mode` |

### Complete Meeting Data Flow

```
PRE-MEETING:
  OpenClaw → MeetingPrepBrief → Voice system prompt
                              → Computer Use context

DURING MEETING:
  User speaks → Voice transcribes → SharedContext.transcript
  Voice calls tool → AutomationRouter → CU executes
  CU completes → notifyTaskCompletion() → Voice liveNotes push
  OpenClaw adds context → addLiveNote() → pushContextUpdate()

  Voice AI reads liveNotes on each turn:
    "I see the PRD is now open. Let me walk through the key architecture decisions..."

POST-MEETING:
  getPostMeetingSummary() → { liveNotes, completedTasks, requirements }
  → MeetingModule.exportToMarkdown() → saved to meeting_notes/
  → TaskStore creates tasks from action items
  → EventBus emits "meeting.ended" with follow-up report
  → Follow-up sent to OpenClaw for execution (pending user confirmation)
  → OpenClaw saves outcomes to MEMORY.md
```

---

## 6b. TranscriptAuditor — System 2 Intent Classification for Automation

**Source:** `src/modules/transcript-auditor.ts` + wiring in `src/callingclaw.ts`

During meetings, OpenAI Realtime's built-in function calling is unreliable for automation dispatch (System 1 fast thinking is optimized for conversation, not tool orchestration). The TranscriptAuditor replaces OpenAI's automation tool calls with Claude-powered intent classification.

### Architecture

```
OpenAI Realtime (System 1)        TranscriptAuditor (System 2)
━━━━━━━━━━━━━━━━━━━━━━━━━━        ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Voice conversation              Subscribes to SharedContext.transcript
✅ Calendar, join/leave meeting    Debounce: 2.5s after last user speech
❌ Automation tools REMOVED          ↓
   during meetings                Claude Haiku classifies intent
                                  (transcript window + meeting brief context)
                                     ↓
                                  confidence ≥ 0.85 → AutomationRouter
                                  confidence 0.6-0.85 → suggest via liveNote
                                  confidence < 0.6 → ignore
```

### Why Claude Haiku Instead of OpenAI Tool Calls

| | OpenAI Tool Call | TranscriptAuditor |
|---|---|---|
| Intent accuracy | Shallow (single-turn) | Deep (transcript window + meeting brief) |
| "Discussion" vs "Command" | Often confused | Explicit classification rules |
| Parameter resolution | Guesses file paths/URLs | Uses brief's `filePaths[]` and `browserUrls[]` |
| False positive rate | High | Low (0.85 confidence threshold) |
| Cost per classification | Included in Realtime | ~$0.001 (Haiku, 500 input + 100 output tokens) |

### Lifecycle

```
meeting.started event
  → Remove automation tools from OpenAI session (voice.setActiveTools)
  → TranscriptAuditor.activate(voice)
  → Starts monitoring SharedContext.transcript for user entries

meeting.ended event
  → TranscriptAuditor.deactivate()
  → Restore all tools to OpenAI session (voice.restoreAllTools)
```

### Tools Managed by Auditor (removed from OpenAI during meetings)

- `computer_action` — 4-layer automation
- `browser_action` — Playwright CLI
- `share_screen` / `stop_sharing` — Meet screen sharing
- `open_file` — File/URL opening

### Tools Kept on OpenAI (not affected)

- `schedule_meeting`, `check_calendar` — Calendar operations
- `join_meeting`, `create_and_join_meeting`, `leave_meeting` — Meeting lifecycle
- `recall_context` — Memory access
- `take_screenshot`, `save_meeting_notes` — Utilities
- `zoom_control` — Zoom shortcuts

### Classification Prompt Design

The auditor's prompt includes:
1. **Available actions** — `open_url`, `open_file`, `share_screen`, `navigate`, `scroll`, `computer_action`
2. **Meeting context** — topic, goal, known files/URLs from prep brief, recent `[DONE]` actions
3. **Recent transcript** — last 15 entries with speaker roles
4. **Classification rules** — explicit examples of commands vs. discussion (e.g., "帮我打开X" = command, "这个要改成X" = discussion)

### Execution Flow

```
1. User says "我们看看那个官网"
2. Whisper STT → SharedContext.transcript → auditor._onTranscript()
3. Debounce 2.5s (wait for user to finish speaking)
4. runAudit() → classifyIntent(entries)
5. Claude Haiku: { action: "open_url", params: { url: "https://..." }, confidence: 0.92 }
6. confidence ≥ 0.85 → executeAction()
7. automationRouter.execute("open https://... in browser") → L1 shortcut
8. notifyTaskCompletion() → Voice AI says "官网已经打开了"
```

### Safety Mechanisms

- **Debounce** (2.5s) — waits for user to finish speaking, avoids partial-sentence classification
- **Cooldown** (5s) — minimum gap between executions, prevents rapid-fire
- **Dedup** — ring buffer of last 5 actions, skips exact duplicates
- **Conservative threshold** (0.85) — false positives are much worse than false negatives
- **Medium confidence suggestion** (0.6-0.85) — adds `[SUGGEST]` liveNote, Voice AI can ask user to confirm

### EventBus Events

| Event | When | Data |
|-------|------|------|
| `auditor.activated` | Meeting starts, auditor begins monitoring | — |
| `auditor.deactivated` | Meeting ends, auditor stops | — |
| `auditor.intent` | Intent classified (any confidence) | `action, params, confidence, reasoning` |
| `auditor.executing` | Auto-executing (high confidence) | `action, params, confidence` |
| `auditor.suggest` | Suggesting to Voice AI (medium confidence) | `action, params, confidence, reasoning` |
| `auditor.error` | Classification or execution failed | `error` |

---

## 6c. Google Meet Join + Admission (Deterministic Fast Path)

**Source:** `src/mcp_client/playwright-cli.ts`

CallingClaw joins Google Meet meetings and admits participants using **pure JS eval** through Playwright CLI — no AI model needed. This is the fastest possible path (~200ms per eval round-trip).

### Meet Join Flow (7 phases)

```
Phase 1: Navigate + dismiss blocking dialogs (Got it, cookie, notification)
Phase 2: Detect page state (prejoin, switch_here, already_in, ended, error, loading)
Phase 3: Handle "Switch here" (already in meeting on another device)
Phase 4: Configure camera OFF, mic ON, display name = "CallingClaw"
Phase 5: Set audio devices to BlackHole (mic: 16ch, speaker: 2ch)
Phase 6: Click join button (Join now, Ask to join, Switch here + Chinese locale)
Phase 7: Verify state (in_meeting, waiting_room with 60s timeout)
```

### Admission Monitor (Two-Step Chained)

Google Meet admission requires TWO clicks:
1. **Step A**: Click green "Admit N guest(s)" notification → opens People sidebar
2. **Step B**: Click "Admit" / "Admit all" in the sidebar

**Speed optimization**: Both steps are chained in a single monitor cycle:
```
Cycle 1 (3s interval):
  → _admitEval() detects green notification → clicks it (Step A)
  → wait 800ms for sidebar DOM to render
  → _admitEval() finds "Admit" button → clicks it (Step B)
  → Total: ~1.5s from detection to admission
```

Without chaining: Step A in cycle 1, wait 5s, Step B in cycle 2 = ~8s (too slow, user gets kicked).

**Important DOM knowledge**: Meet's buttons can be `div[tabindex]` or `[role=button]`, not just `<button>`. The `aria-label` appears in the accessibility tree but NOT always as an HTML attribute. Must search by `textContent`.

**Fallback**: After 3 consecutive L1 (JS eval) failures, delegates to AutomationRouter (Haiku snapshot → Computer Use vision). This is critical for unattended operation.

---

## 6d. Self-Recovery (Unattended Operation)

**Source:** `src/config_server.ts` (recovery endpoints) + `src/mcp_client/playwright-cli.ts` (resetBrowser)

CallingClaw runs as an unattended computer — no human clicks the UI. When things go wrong (browser hang, sidecar crash, voice disconnect), it must self-recover.

### Recovery API

| Method | Endpoint | What it does |
|--------|----------|-------------|
| POST | `/api/recovery/browser` | Kill Chrome + restart Playwright CLI session |
| POST | `/api/recovery/sidecar` | Kill Python sidecar + restart it |
| POST | `/api/recovery/voice` | Stop + restart OpenAI Realtime voice session |
| GET | `/api/recovery/health` | Quick health check of all subsystems |

### Health Check Response

```json
{
  "healthy": true,
  "subsystems": {
    "browser": true,       // Playwright CLI connected
    "sidecar": true,       // Python bridge ready
    "voice": true,         // OpenAI Realtime connected
    "calendar": true,      // Google Calendar connected
    "openclaw": false,     // OpenClaw Gateway connected
    "admissionMonitor": false,
    "meetingActive": false
  }
}
```

### Browser Reset Flow

```
PlaywrightCLIClient.resetBrowser()
  1. Stop admission monitor (if running)
  2. Close playwright-cli session gracefully
  3. pkill Chrome processes launched by CallingClaw
  4. Wait 1s for cleanup
  5. Restart playwright-cli with same profile
```

### When to Trigger Recovery

OpenClaw / agents should call recovery when:
- `GET /api/recovery/health` shows `healthy: false`
- Browser operations timeout repeatedly
- Voice session disconnects unexpectedly
- Python sidecar stops responding to actions

---

## 7a. recall_context Tool — Voice AI Memory Access

**Source:** `src/callingclaw.ts` (tool definition + handler)

The `recall_context` tool allows Voice AI to query OpenClaw's memory and files when the user asks context-dependent questions during casual conversation.

### When Voice AI Calls It

- "那些memdex blog效果怎么样" → `recall_context({ query: "memdex blog performance", urgency: "thorough" })`
- "我们之前准备的发布计划..." → `recall_context({ query: "previous launch plans for Tanka Link", urgency: "thorough" })`
- "那个PR merge了没" → `recall_context({ query: "recent pull request status", urgency: "quick" })`

### Two-Path Execution

| Path | Latency | Method | When |
|------|---------|--------|------|
| **Quick** | <100ms | `ContextSync.searchMemory(query)` — keyword search in MEMORY.md | `urgency: "quick"` or OpenClaw offline |
| **Thorough** | 2-15s | `OpenClawBridge.sendTask()` — full agent with file access | `urgency: "thorough"` |

Quick search auto-escalates to thorough if no results found and OpenClaw is available.

### Voice AI Behavior

The `DEFAULT_PERSONA` instructs Voice AI to:
1. Answer from background context when possible (no tool call)
2. Say "让我查一下" / "我看看记录" before calling `recall_context` (fills the pause)
3. Call `quick` first for simple lookups, `thorough` for detailed/metric questions

---

## 7b. Meeting Lifecycle — Pre-meeting Agenda & Post-meeting Follow-up

### Pre-meeting: Agenda Confirmation

```
1. POST /api/meeting/prepare { topic: "CallingClaw PRD review" }
   → Returns: { topic, contextBrief, upcomingEvents, pendingConfirmation }
   → EventBus emits "meeting.agenda"
   → User reviews agenda + meeting link

2. User confirms → POST /api/meeting/join { url, instructions }
   → Voice starts + audio bridge + joins meeting
   → EventBus emits "meeting.agenda" with full agenda object
   → meeting.agenda event includes workspace context
```

### Post-meeting: Follow-up Report

```
1. leave_meeting tool / POST /api/meeting/leave
   → Generates summary (title, keyPoints, decisions, actionItems, followUps)
   → Exports to meeting_notes/*.md
   → Creates tasks in TaskStore (status: pending)
   → Builds follow-up report { filepath, summary, tasks, pendingConfirmation }

2. EventBus emits "meeting.ended" with full follow-up
   → If OpenClaw connected: sends follow-up report to OpenClaw
   → OpenClaw saves to memory, waits for user confirmation

3. User reviews follow-up:
   → GET /api/meeting/notes/:filename — read the meeting notes markdown
   → GET /api/tasks?status=pending — see created tasks
   → PATCH /api/tasks/:id { status: "in_progress" } — confirm tasks
   → OpenClaw picks up confirmed tasks and executes them
```

### New REST Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/meeting/prepare` | Pre-meeting agenda generation for user confirmation |
| GET | `/api/meeting/prep-brief` | Get current meeting prep + context briefs |
| GET | `/api/meeting/notes/:filename` | Read a specific meeting note file content |

### Event Bus Events (New)

| Event | When | Data |
|-------|------|------|
| `meeting.agenda` | Pre-meeting agenda generated | `topic, meetUrl, contextBrief, upcomingEvents` |

---

## 7c. Meeting Vision — Screen Capture Analysis During Meetings

**Source:** `src/modules/vision.ts` (meeting mode) + `src/callingclaw.ts` (wiring)

During meetings, VisionModule periodically captures the meeting window and analyzes shared screen content using **Gemini 3 Flash via OpenRouter** (switched from GPT-4o for better multimodal performance).

### How It Works

```
meeting.started event
  → VisionModule.startMeetingVision(8000ms)
  → Every 8s:
      1. Request screenshot from Python sidecar
      2. Analyze with Gemini Flash (meeting-focused prompt)
      3. Jaccard similarity check (>70% = skip duplicate)
      4. Inject [Screen] entry into SharedContext transcript
      5. Callback → buffer descriptions
      6. Every 5 descriptions → batch push to OpenClaw

meeting.ended event
  → VisionModule.stopMeetingVision()
  → Flush remaining buffer to OpenClaw
```

### Vision Model Configuration

```typescript
// config.ts
vision: {
  model: "google/gemini-3-flash-preview",  // via OpenRouter
}
// Overridable with VISION_MODEL env var

// vision.ts uses OpenAI SDK pointed at OpenRouter
visionClient = new OpenAI({
  apiKey: CONFIG.openrouter.apiKey,
  baseURL: CONFIG.openrouter.baseUrl,
});
```

### Meeting-Specific Prompt

The meeting analysis prompt:
- Focuses on **shared/presented content** (slides, code, diagrams, documents)
- Compares against **previous screen state** to report only changes
- Outputs 1-3 sentences max
- Uses the meeting's language (Chinese if conversation is Chinese)
- Returns "Meeting grid view, no shared content" when nobody is sharing

### Similarity Deduplication

`isSimilarDescription()` uses Jaccard similarity on significant words (>3 chars). If similarity > 70%, the description is skipped to avoid flooding the transcript with repeated content.

---

## 7d. /callingclaw Command — OpenClaw Skill

**Source:** `src/skills/openclaw-callingclaw-skill.ts`

The `/callingclaw` command allows OpenClaw to control CallingClaw via its REST API.

### Usage

```
/callingclaw status              — Check if CallingClaw is running
/callingclaw voice start|stop    — Start/stop voice session
/callingclaw join <url>          — Join a meeting
/callingclaw leave               — Leave meeting + follow-up
/callingclaw say <text>          — Send text to voice AI
/callingclaw screen <instruction>— Computer use task
/callingclaw calendar            — Check upcoming events
/callingclaw tasks               — List pending tasks
/callingclaw confirm <id>        — Confirm task for execution
/callingclaw context <note>      — Add shared context note
/callingclaw pin <path> [summary]— Pin file to shared context
/callingclaw screenshot          — Take screenshot
/callingclaw notes               — List saved meeting notes
/callingclaw transcript [count]  — Get live transcript
```

### Skill Manifest

```typescript
{
  name: "callingclaw",
  trigger: "/callingclaw",
  endpoint: "http://localhost:4000",
  healthCheck: "http://localhost:4000/api/status",
  capabilities: [
    "voice_conversation", "meeting_join_leave", "computer_use",
    "calendar_management", "screen_capture", "task_management", "context_sharing"
  ]
}
```

---

## 8. Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Runtime | **Bun 1.3+** | No Node.js. Use `bun run`, `bun test`, `bun install` |
| Language | **TypeScript 5+** | Strict types, ESM modules |
| HTTP | **Bun.serve()** | Built-in HTTP + WebSocket. No Express |
| Voice AI | **OpenAI Realtime API** | Native Bun WebSocket, 24kHz PCM audio |
| Computer Use | **Claude Sonnet** (via OpenRouter) | Vision + tool_use loop |
| Browser | **@playwright/cli** | Layer 2 automation (persistent Chrome profile) |
| macOS GUI | **Peekaboo MCP** | Layer 3 accessibility |
| Python | **Python 3.10+** | Sidecar only (screen, audio, input) |
| Audio bridge | **BlackHole 2ch/16ch** | Virtual audio for Meet/Zoom |

### Key Dependencies

```
# Bun (package.json)
@anthropic-ai/sdk  ^0.78.0    # Claude Computer Use
openai             ^6.27.0    # Realtime + GPT-4o vision

# Python (requirements.txt)
websockets  >=15.0    # Bridge to Bun
pyautogui   >=0.9.54  # Mouse/keyboard
mss         >=10.0    # Screen capture
Pillow      >=12.0    # Image processing
pyaudio     >=0.2.14  # Audio I/O (requires portaudio)
```

---

## 8. Source Code Map

```
CallingClaw 2.0/
├── CLAUDE.md                    ← THIS FILE (agent reference)
├── callingclaw2.0PRD.md         ← Product Requirements Document (中文)
│
├── callingclaw/                 ← Main Bun application
│   ├── package.json             ← v2.0.0, scripts: start/dev/test
│   ├── tsconfig.json
│   ├── CLAUDE.md                ← Bun-specific dev rules
│   ├── DEPENDENCIES.md          ← Full dependency manifest
│   ├── README.md
│   ├── .env                     ← API keys (NEVER commit)
│   │
│   ├── src/
│   │   ├── callingclaw.ts       ← ENTRY POINT — wires all modules
│   │   ├── config.ts            ← Environment config loader
│   │   ├── config_server.ts     ← REST API server (port 4000)
│   │   ├── bridge.ts            ← Python sidecar WebSocket bridge
│   │   ├── meet_joiner.ts       ← Meet/Zoom join automation
│   │   ├── voice-persona.ts     ← Voice persona + brief injection + pushContextUpdate()
│   │   ├── computer-use-context.ts  ← Vision analysis context
│   │   ├── openclaw_bridge.ts   ← System 2 delegation (WebSocket to :18789)
│   │   │
│   │   ├── modules/
│   │   │   ├── index.ts         ← Module registry (re-exports)
│   │   │   ├── shared-context.ts    ← Shared state (screen, notes, events)
│   │   │   ├── voice.ts         ← OpenAI Realtime client wrapper
│   │   │   ├── vision.ts        ← Gemini Flash (OpenRouter) screen/meeting vision
│   │   │   ├── meeting.ts       ← Transcript + action items + export
│   │   │   ├── computer-use.ts  ← Claude CU orchestration
│   │   │   ├── automation-router.ts ← 4-layer routing logic
│   │   │   ├── event-bus.ts     ← Pub/sub event system
│   │   │   ├── task-store.ts    ← Persistent task management
│   │   │   ├── context-sync.ts  ← Shared memory: MEMORY.md + pinned files → tiered briefs
│   │   │   ├── transcript-auditor.ts ← System 2 intent classification (Claude Haiku) during meetings
│   │   │   └── auth.ts          ← Google OAuth2 flow
│   │   │
│   │   ├── ai_gateway/
│   │   │   ├── realtime_client.ts   ← OpenAI Realtime WebSocket
│   │   │   └── claude_agent.ts      ← Claude Computer Use agent
│   │   │
│   │   ├── mcp_client/
│   │   │   ├── google_cal.ts    ← Google Calendar REST + OAuth2
│   │   │   ├── playwright-cli.ts ← Playwright CLI browser automation (@playwright/cli, persistent Chrome profile)
│   │   │   └── peekaboo.ts      ← macOS accessibility layer
│   │   │
│   │   └── skills/
│   │       ├── meeting-prep.ts  ← MeetingPrepBrief generation (System 2 → System 1)
│   │       ├── openclaw-callingclaw-skill.ts ← /callingclaw command for OpenClaw
│   │       └── zoom.ts          ← Zoom keyboard shortcuts
│   │
│   ├── python_sidecar/
│   │   ├── main.py              ← Python entry point
│   │   └── requirements.txt
│   │
│   ├── public/
│   │   └── callingclaw-panel.html   ← Web config UI
│   │
│   ├── docs/
│   │   ├── deployment-guide.md      ← Setup instructions
│   │   ├── agent-integration-guide.md   ← REST API reference
│   │   └── user-stories.md          ← Usage scenarios (中文)
│   │
│   ├── meeting_notes/           ← Exported meeting transcripts
│   └── data/
│       └── tasks.json           ← Persisted task state
│
└── TankaLink2.0-callingclaw-landing/   ← Marketing landing page (Vercel)
```

---

## 9. Development Commands

```bash
cd "CallingClaw 2.0/callingclaw"

bun install              # Install dependencies
bun run start            # Start CallingClaw (production)
bun run dev              # Start with hot reload
bun test                 # Run tests
bun run setup:python     # Install Python dependencies
```

### Environment Variables (.env)

```bash
# Required
OPENAI_API_KEY=sk-...              # Voice + Vision

# Recommended (Computer Use + Vision)
OPENROUTER_API_KEY=sk-or-v1-...    # Claude CU + Gemini Flash vision via OpenRouter
# OR: ANTHROPIC_API_KEY=sk-ant-... # Direct Anthropic

# Optional (Calendar)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...

# Service
PORT=4000                          # REST API + Config UI
BRIDGE_PORT=4001                   # Python sidecar
PYTHON_PATH=/opt/miniconda3/bin/python3
SCREEN_WIDTH=1920
SCREEN_HEIGHT=1080
VISION_MODEL=google/gemini-3-flash-preview  # Override vision model (default: Gemini Flash)
```

---

## 10. REST API Summary

Base URL: `http://localhost:4000`

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/status` | Service health + connection status |
| GET | `/api/config` | Current configuration |
| POST | `/api/config` | Update configuration |
| GET/POST | `/api/keys` | Get/set API keys |
| POST | `/api/voice/start` | Start voice session |
| POST | `/api/voice/stop` | Stop voice session |
| POST | `/api/voice/text` | Inject text into voice session |
| POST | `/api/computer/run` | Run Computer Use task (full agent loop) |
| POST | `/api/computer/analyze` | Vision-only screen analysis |
| POST | `/api/bridge/action` | Low-level mouse/keyboard/screenshot |
| GET | `/api/calendar/events` | List upcoming events |
| POST | `/api/calendar/create` | Create calendar event |
| POST | `/api/meeting/join` | Integrated join (voice + audio + join) |
| POST | `/api/meeting/leave` | Leave + auto-summary + tasks |
| GET | `/api/meeting/transcript` | Live transcript |
| POST | `/api/meeting/prepare` | Pre-meeting agenda for user confirmation |
| GET | `/api/meeting/prep-brief` | Get current prep + context briefs |
| POST | `/api/meeting/summary` | Generate AI summary |
| POST | `/api/meeting/export` | Export to markdown |
| GET | `/api/meeting/notes` | List saved note files |
| GET | `/api/meeting/notes/:file` | Read specific note file content |
| POST | `/api/automation/run` | Auto-routed instruction (4-layer) |
| POST | `/api/automation/classify` | Classify instruction (dry-run) |
| GET | `/api/automation/status` | Layer availability |
| GET/POST/PATCH/DELETE | `/api/tasks` | Task CRUD |
| POST | `/api/context/workspace` | Inject meeting context (topic, files, git) |
| DELETE | `/api/context/workspace` | Clear workspace context |
| GET | `/api/context/sync` | ContextSync status (memory, pinned, briefs) |
| GET | `/api/context/brief` | Get tiered briefs (voice + computer) |
| POST | `/api/context/pin` | Pin file to shared context `{ path, summary? }` |
| DELETE | `/api/context/pin` | Unpin file `{ path }` |
| POST | `/api/context/note` | Add session note `{ note }` |
| POST | `/api/context/reload` | Reload OpenClaw MEMORY.md from disk |
| POST | `/api/screen/share` | Start screen sharing |
| POST | `/api/screen/stop` | Stop screen sharing |
| POST | `/api/recovery/browser` | Kill + restart browser (Playwright CLI) |
| POST | `/api/recovery/sidecar` | Kill + restart Python sidecar |
| POST | `/api/recovery/voice` | Restart voice session `{ instructions? }` |
| GET | `/api/recovery/health` | Health check all subsystems |
| WS | `/ws/events` | Real-time event stream |
| POST | `/api/webhooks` | Register webhook listener |

Full API details: `callingclaw/docs/agent-integration-guide.md`

---

## 11. Voice AI Tool Definitions

The voice module registers these tools for OpenAI Realtime function calling:

| Tool | Trigger Example | Handler |
|------|----------------|---------|
| `schedule_meeting` | "约一个明天的会议" | GoogleCalendarClient.createEvent |
| `check_calendar` | "我今天有什么安排" | GoogleCalendarClient.listUpcomingEvents |
| `join_meeting` | "加入这个会议" | MeetJoiner.joinMeeting |
| `create_and_join_meeting` | "开一个新会议" | MeetJoiner.createAndJoinMeeting |
| `leave_meeting` | "退出会议" | MeetJoiner.leaveMeeting + summary |
| `computer_action` | "帮我打开微信" | AutomationRouter → ComputerUse |
| `take_screenshot` | "看看屏幕" | PythonBridge screenshot |
| `save_meeting_notes` | "保存会议记录" | MeetingModule.exportToMarkdown |
| `share_screen` | "共享屏幕" | MeetJoiner.shareScreen |
| `stop_sharing` | "停止共享" | MeetJoiner.stopSharing |
| `open_file` | "打开PRD文件" | MeetJoiner.openFile |
| `recall_context` | "那些blog效果怎么样" | ContextSync.searchMemory / OpenClawBridge |
| `zoom_control` | "静音Zoom" | ZoomSkill (14 actions) |
| `browser_action` | "切换到下一个标签" | PlaywrightCLIClient (11 actions) |

---

## 12. 4-Layer Automation Router

Instructions are routed through layers in order, with fallback:

| Layer | Name | Speed | When to Use |
|-------|------|-------|-------------|
| **L1** | Shortcuts & API | <100ms | Keyboard shortcuts, app launch, URL open |
| **L2** | Playwright CLI | 200-800ms | Browser DOM: navigate, click, type, scroll (real Chrome) |
| **L3** | Peekaboo | 500ms-2s | macOS native: window focus, accessibility tree |
| **L4** | Computer Use | 3-10s | Vision fallback: anything L1-L3 can't handle |

---

## 13. Audio Bridge Architecture

### Direct Mode (default)
```
User Mic → Python (PyAudio) → Bun → OpenAI Realtime → Bun → Python → Speaker
```

### Meet Bridge Mode (Google Meet)
```
Meet audio out → BlackHole 2ch → Python capture → OpenAI (AI listens)
OpenAI response → Python playback → BlackHole 16ch → Meet mic in
```

---

## 14. Event Bus Events

| Event | When | Key Data |
|-------|------|----------|
| `meeting.joining` | Starting join flow | `meet_url` |
| `meeting.started` | In meeting, recording | `meet_url, correlation_id` |
| `meeting.action_item` | Action item detected | `text, assignee` |
| `meeting.ended` | Exported + tasks created | `filepath, summary, tasks` |
| `voice.started` | Voice session connected | `audio_mode` |
| `voice.stopped` | Voice session ended | — |
| `computer.task_started` | CU task begins | `instruction` |
| `computer.task_done` | CU task completed | `summary, layer, durationMs` |
| `task.created` | New task | `task` |
| `task.updated` | Status changed | `task` |
| `workspace.updated` | Context injected via API | `topic, fileCount` |
| `recovery.browser` | Browser reset attempted | `success, detail` |
| `recovery.sidecar` | Python sidecar restarted | `success` |
| `recovery.voice` | Voice session restarted | `success` |

---

## 15. Development Rules

1. **Use Bun, not Node.js** — `bun run`, `bun test`, `bun install`
2. **No Express/Hono** — Use `Bun.serve()` for HTTP/WebSocket
3. **No dotenv** — Bun auto-loads `.env`
4. **Native WebSocket** — Don't use the `ws` package
5. **Never commit `.env`** — Contains API keys
6. **TypeScript strict** — All source in `src/`
7. **Python sidecar only** — Python handles hardware (screen, audio, input)
8. **4-layer routing** — Always route through AutomationRouter for computer tasks
9. **SharedContext** — All modules share state through this event emitter
10. **EventBus** — All significant actions emit events for external consumption

---

## 16. Version History

### v2.2.1 (2026-03-13 — Current, branch: `feat/electron-shell`)

**Electron Shell + TranscriptAuditor + Meeting Join/Admit + Self-Recovery**

New since v2.1.0:
- [x] Electron Shell (`callingclaw-desktop/`) — setup wizard, permission checker, tray, overlay
- [x] Desktop icons — watercolor claw-phone icon (window, dock, tray, .icns)
- [x] Overlay window — Meeting Prep Brief + AI Activity feed sections
- [x] Favicon on localhost:4000 config panel
- [x] TranscriptAuditor — Claude Haiku intent classification replaces OpenAI tool calls for automation during meetings
- [x] Dynamic tool management — VoiceModule.setActiveTools() / restoreAllTools() for mid-session tool changes
- [x] Playwright fast-join for Google Meet — deterministic JS eval (no AI model), handles Join/Switch here/Ask to join
- [x] Two-step admission monitor — chained Step A (open notification) + Step B (click Admit) in single cycle (~1.5s)
- [x] Calendar attendee lookup — fetches attendees from Google Calendar, passes to meeting prep brief
- [x] Self-recovery API — `POST /api/recovery/{browser,sidecar,voice}` + `GET /api/recovery/health`
- [x] Browser reset — `PlaywrightCLIClient.resetBrowser()` kills Chrome + restarts session
- [ ] HealthManager API (unified permission + device + dependency health check)
- [ ] AudioDeviceManager (SwitchAudioSource automation)
- [ ] Daemon mode (--daemon flag, PID file, graceful shutdown)

See: `callingclaw_electron_upgrade_prd.md`

### v2.1.0 (2026-03-12, tag: `v2.1.0`)

**Stable checkpoint** before Electron Shell upgrade. Includes all core modules + browser automation exploration.

New since v2.0.0:
- [x] Playwright CLI client (`src/mcp_client/playwright-cli.ts`) — replaced Agent Browser + PlaywrightMCP
- [x] Playwright CLI evaluation + test harness (`test-playwright-cli/`)
- [x] Electron upgrade PRD (`callingclaw_electron_upgrade_prd.md`)
- [x] Meeting Vision with Gemini 3 Flash
- [x] Voice tool_call events + meeting transparency view
- [x] CallingClaw 1.0 (Chrome extension) fully removed

### v2.0.0 (2026-03 — Initial)

**Complete architectural rewrite** from Chrome extension to dedicated machine.

Core modules:
- [x] VoiceModule — OpenAI Realtime bidirectional voice + function calling
- [x] ComputerUseModule — Claude Vision + pyautogui agent loop
- [x] AutomationRouter — 4-layer intelligent routing (L1-L4)
- [x] MeetingModule — Transcript extraction, summary, markdown export
- [x] GoogleCalendarClient — REST API + OAuth2 (create, list, auto-join)
- [x] MeetJoiner — Chrome automation for Meet/Zoom (join, leave, share)
- [x] EventBus — Pub/sub + webhook delivery
- [x] TaskStore — Persistent task management from action items
- [x] ConfigServer — Full REST API on :4000 (40+ endpoints)
- [x] PythonBridge — WebSocket bridge to sidecar (:4001)
- [x] PlaywrightCLIClient — Browser CLI automation via @playwright/cli (Layer 2, persistent Chrome profile)
- [x] PeekabooClient — macOS native GUI access (Layer 3)
- [x] ZoomSkill — 14 Zoom keyboard shortcut actions
- [x] MeetingPrepSkill — System 2 generates structured brief for System 1
- [x] ContextSync — Shared memory layer (OpenClaw MEMORY.md + pinned files → tiered briefs)
- [x] OpenClawBridge — WebSocket delegation to OpenClaw Gateway (:18789)
- [x] Dynamic Context Push — Live liveNotes + session.update to Voice AI mid-meeting
- [x] Voice Persona — DEFAULT_PERSONA (context-aware) / MEETING_PERSONA with brief injection
- [x] recall_context tool — Voice AI queries OpenClaw memory (quick/thorough paths)
- [x] Pre-meeting agenda — POST /api/meeting/prepare → user confirmation
- [x] Post-meeting follow-up — structured report → OpenClaw for execution
- [x] /callingclaw skill — OpenClaw command interface (15 subcommands)
- [x] Meeting note file reading — GET /api/meeting/notes/:filename
- [x] Periodic MEMORY.md refresh — 60s interval, auto-push to live Voice
- [x] Meeting Vision — Auto screen capture + Gemini Flash analysis during meetings
- [x] Vision via OpenRouter — Gemini 3 Flash replaces GPT-4o for multimodal (better accuracy)
- [x] Landing page — Vercel deployment (TankaLink2.0-callingclaw-landing/)

Python sidecar:
- [x] Screen capture (mss, 1 FPS, hash-based delta compression)
- [x] Audio I/O (PyAudio + BlackHole virtual audio bridge)
- [x] Mouse/keyboard (pyautogui)
- [x] WebSocket client to Bun bridge

### v1.0.0 (2025 — Deprecated)

Chrome extension + Vocode Python backend. Fully replaced by v2.0.0.
- Chrome extension with side panel UI
- Vocode framework + ElevenLabs TTS
- Gemini Live API for voice
- Manual keyboard shortcuts only
- No calendar integration, no Computer Use

---

## 17. Known Limitations & TODOs

- [ ] CallingClaw 2.0 directory is **untracked in git** — needs initial commit
- [ ] Peekaboo MCP not always available (depends on system install)
- [ ] BlackHole audio bridge requires manual macOS audio device setup
- [ ] Google Calendar requires manual OAuth2 token generation
- [ ] No automated tests for MeetJoiner (depends on Chrome + Meet)
- [ ] Python sidecar requires conda environment with specific pyobjc versions
- [ ] Landing page needs deployment verification

---

## 18. Quick Reference for Common Agent Tasks

### Port Reference

| Port | Protocol | Purpose |
|------|----------|---------|
| 4000 | HTTP + WS | REST API + Config UI + Event Bus |
| 4001 | WebSocket | Python sidecar bridge |
| 18789 | WebSocket | OpenClaw Gateway (external, CallingClaw connects as client) |

### Start CallingClaw
```bash
cd "CallingClaw 2.0/callingclaw" && bun run start
```

### Check if running
```bash
curl -s http://localhost:4000/api/status | python3 -m json.tool
```

### Join a meeting programmatically
```bash
curl -X POST http://localhost:4000/api/meeting/join \
  -H "Content-Type: application/json" \
  -d '{"url": "https://meet.google.com/xxx-yyyy-zzz"}'
```

### Take a screenshot
```bash
curl -X POST http://localhost:4000/api/bridge/action \
  -H "Content-Type: application/json" \
  -d '{"action": "screenshot"}'
```

### Run a computer use task
```bash
curl -X POST http://localhost:4000/api/computer/run \
  -H "Content-Type: application/json" \
  -d '{"instruction": "Open Chrome and go to github.com"}'
```
