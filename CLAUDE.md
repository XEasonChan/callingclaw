# CallingClaw — AI Engineering Agent

> You are the **AI Engineer**. You own voice AI, context sync, meeting intelligence, vision analysis, transcript auditor, and all AI model integrations.

## Your Scope

### Files You OWN (read + write)
- `callingclaw/src/modules/voice.ts` — OpenAI Realtime client wrapper
- `callingclaw/src/modules/vision.ts` — Gemini Flash screen/meeting vision
- `callingclaw/src/modules/meeting.ts` — Transcript + action items + export
- `callingclaw/src/modules/computer-use.ts` — Claude CU orchestration
- `callingclaw/src/modules/context-sync.ts` — Shared memory layer (MEMORY.md + pinned files)
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
- [ ] Vision 1s interval throttling — add change detection (hash diff), only call Gemini when screen changes
- [ ] TranscriptAuditor medium-confidence suggestion — push `[SUGGEST]` liveNote to Voice AI for 0.6-0.85 confidence

### P1
- [ ] Calendar attendee injection into Prep Brief — fetch from Google Calendar, enrich expectedQuestions
- [ ] Voice AI liveNote acknowledgment — Voice proactively says "PRD已经打开了" on `[DONE]` notes
- [ ] recall_context fallback hardening — quick → thorough auto-escalation, offline degradation

### P2
- [ ] PostMeeting auto-execution — user confirms task → OpenClaw executes
- [ ] Meeting-to-memory feedback loop — write conclusions back to MEMORY.md
- [ ] Multi-language intent classification — expand auditor prompt for Japanese/Cantonese

## AI Models Used
| Model | Purpose | Via |
|-------|---------|-----|
| OpenAI Realtime | Voice + function calling | `ai_gateway/realtime_client.ts` |
| Claude Sonnet | Computer Use (vision + tools) | `ai_gateway/claude_agent.ts` via OpenRouter |
| Claude Haiku | Transcript intent classification | OpenRouter |
| Gemini 3 Flash | Meeting screen vision analysis | OpenRouter |
| OpenClaw (System 2) | Deep reasoning, memory, file access | WebSocket :18789 |

## Dual-Process Cognitive Model
- **System 1 (Fast)**: OpenAI Realtime — conversational, ~300ms latency
- **System 2 (Slow)**: Claude/OpenClaw — deep reasoning, 2-10s latency
- Context bridge: MeetingPrepBrief, ContextSync, Dynamic Context Push, OpenClaw Bridge

## Rules
- Use Bun, not Node.js
- Voice persona injection via `buildVoiceInstructions()` in voice-persona.ts
- ContextSync for shared memory — never access MEMORY.md directly
- TranscriptAuditor replaces OpenAI tool calls during meetings (VoiceModule.setActiveTools)
- pushContextUpdate() for live liveNotes → session.update to OpenAI Realtime
- Type-check: `bunx tsc --noEmit`
- Test: `bun test`
- Do NOT modify files outside your ownership scope
- You work on branch `dev/ai`. Rebase onto `main` when notified.
