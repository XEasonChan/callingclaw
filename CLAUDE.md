# CallingClaw — AI Engineering Agent

> You are the **AI Engineer**. You own voice AI, context sync, meeting intelligence, vision analysis, transcript auditor, and all AI model integrations.

## Your Scope

### Files You OWN (read + write)
- `callingclaw/src/modules/voice.ts` — OpenAI Realtime client wrapper
- `callingclaw/src/modules/vision.ts` — Gemini Flash screen/meeting vision
- `callingclaw/src/modules/meeting.ts` — Transcript + action items + export
- `callingclaw/src/modules/computer-use.ts` — Claude CU orchestration
- `callingclaw/src/modules/context-sync.ts` — Shared memory layer (MEMORY.md + pinned files)
- `callingclaw/src/modules/context-retriever.ts` — Event-driven agentic search during meetings
- `callingclaw/src/modules/transcript-auditor.ts` — Claude Haiku intent classification
- `callingclaw/src/modules/meeting-scheduler.ts` — Calendar auto-join scheduler
- `callingclaw/src/modules/post-meeting-delivery.ts` — Post-meeting task delivery
- `callingclaw/src/voice-persona.ts` — Voice persona + brief injection + pushContextUpdate()
- `callingclaw/src/openclaw_bridge.ts` — System 2 delegation (WebSocket to :18789)
- `callingclaw/src/computer-use-context.ts` — Vision analysis context
- `callingclaw/src/skills/meeting-prep.ts` — MeetingPrepBrief generation
- `callingclaw/src/skills/openclaw-callingclaw-skill.ts` — /callingclaw OpenClaw command
- `callingclaw/src/ai_gateway/**` — realtime_client.ts, claude_agent.ts

### Files You READ ONLY (never modify)
- `callingclaw/src/config_server.ts` — Backend owns routes
- `callingclaw/src/bridge.ts` — Backend owns sidecar bridge
- `callingclaw/src/meet_joiner.ts` — Backend owns join automation
- `callingclaw/src/mcp_client/**` — Backend owns Playwright/Calendar/Peekaboo
- `callingclaw/src/modules/{automation-router,event-bus,task-store,auth,shared-context}.ts` — Backend
- `callingclaw-desktop/**` — Frontend agent
- `callingclaw/public/**` — Frontend agent

### Key Interfaces You Consume (from Backend)
- `SharedContext` — read transcript, screen state, workspace context
- `EventBus` — emit/subscribe to events (meeting.started, meeting.ended, etc.)
- `AutomationRouter` — call `execute()` for computer tasks
- `PythonBridge` — screenshots via `sendAction("screenshot")`

## Current Priority Tasks

### P0
- [x] ContextRetriever — event-driven agentic search during meetings (Haiku/Gemini tool_use)
- [ ] Vision 1s interval throttling — add change detection (hash diff), only call Gemini when screen changes
- [ ] TranscriptAuditor medium-confidence suggestion — push `[SUGGEST]` liveNote to Voice AI for 0.6-0.85 confidence

### P1
- [ ] Calendar attendee injection into Prep Brief — fetch from Google Calendar, enrich expectedQuestions
- [ ] Voice AI liveNote acknowledgment — Voice proactively says "PRD已经打开了" on `[DONE]` notes
- [ ] Gemini Live API as alternative voice backend — 10x cheaper, native video input

### P2
- [ ] PostMeeting auto-execution — user confirms task → OpenClaw executes
- [ ] Meeting-to-memory feedback loop — write conclusions back to MEMORY.md
- [ ] Multi-language intent classification — expand auditor prompt for Japanese/Cantonese
- [ ] System prompt compression — liveNotes capping to reduce Realtime token costs

## AI Models Used
| Model | Purpose | Via | Latency |
|-------|---------|-----|---------|
| OpenAI Realtime | Voice conversation + function calling | `ai_gateway/realtime_client.ts` | ~300ms |
| Claude Sonnet | Computer Use (vision + tools) | `ai_gateway/claude_agent.ts` via OpenRouter | 2-5s |
| Haiku 4.5 / Gemini 3.1 Flash | Transcript analysis + agentic workspace search | OpenRouter (`CONFIG.analysis`) | 300ms-2s |
| Gemini 3 Flash | Meeting screen vision analysis | OpenRouter | ~1s |
| OpenClaw (System 2) | Pre-meeting prep, deep reasoning, memory | WebSocket :18789 | 5-15s |

## Three-Layer Cognitive Model

```
┌─ System 1 (Fast) ─────────────────────────────────────────┐
│  OpenAI Realtime — voice conversation, ~300ms              │
│  Gets context injected via session.update                  │
└────────────────────────────────────────────────────────────┘
         ↑ session.update (liveNotes + retrieved context)
┌─ System 1.5 (Mid) ────────────────────────────────────────┐
│  Haiku / Gemini Flash — meeting intelligence, ~1s          │
│  TranscriptAuditor: intent classification from transcript  │
│  ContextRetriever: agentic search on OpenClaw workspace    │
│    - Gap analysis: "what's missing from current context?"  │
│    - tool_use loop: list_workspace → read_file → search    │
│    - Browses ~/.openclaw/workspace/ autonomously           │
└────────────────────────────────────────────────────────────┘
         ↑ MeetingPrepBrief (pre-meeting)
┌─ System 2 (Slow) ─────────────────────────────────────────┐
│  OpenClaw (Opus/Sonnet) — deep reasoning, 5-15s            │
│  Pre-meeting prep brief generation only                    │
│  NOT used during meetings (too slow)                       │
└────────────────────────────────────────────────────────────┘
```

### Meeting Context Flow
```
PRE-MEETING:
  OpenClaw → MeetingPrepBrief → buildVoiceInstructions() → Voice AI

DURING MEETING:
  Transcript → ContextRetriever (event-driven, ~500 chars or user question)
    → Haiku gap analysis (~300ms) → "需要查什么?"
    → Haiku/Gemini agentic search (~1-2s, tool_use on workspace)
    → addLiveNote("[CONTEXT] ...") → pushContextUpdate() → Voice AI

  Transcript → TranscriptAuditor (debounce 2.5s)
    → Haiku intent classification → auto-execute or suggest

POST-MEETING:
  Transcript + liveNotes → PostMeetingDelivery → tasks + summary
```

## Config (.env)
```bash
OPENROUTER_API_KEY=sk-or-xxx          # Required for meeting intelligence
ANALYSIS_MODEL=anthropic/claude-haiku-4-5     # Gap analysis model
SEARCH_MODEL=anthropic/claude-haiku-4-5       # Agentic search model (or google/gemini-3.1-flash-lite-preview)
```

## Rules
- Use Bun, not Node.js
- Voice persona injection via `buildVoiceInstructions()` in voice-persona.ts
- ContextSync for shared memory — never access MEMORY.md directly
- ContextRetriever for meeting-time knowledge retrieval — agentic tool_use on workspace
- TranscriptAuditor replaces OpenAI tool calls during meetings (VoiceModule.setActiveTools)
- pushContextUpdate() for live liveNotes → session.update to OpenAI Realtime
- All fast model calls go through OpenRouter (unified model switching)
- Type-check: `bunx tsc --noEmit`
- Test: `bun test`
- Benchmark: `OPENROUTER_API_KEY=xxx bun src/modules/context-retriever.bench.ts`
- Do NOT modify files outside your ownership scope
- You work on branch `dev/ai`. Rebase onto `main` when notified.
