# CallingClaw — Context Engineering Strategy

> How CallingClaw manages AI context across its multi-model, multi-layer architecture.

## 5-Layer Context Model

CallingClaw uses a strict 5-layer model for context management. Each layer has a
fixed token budget, a specific injection mechanism, and clear ownership.

```
Layer 0  CORE IDENTITY         session.update instructions      <250 tokens
Layer 1  CAPABILITIES           session.update tools array       ~300 tokens
Layer 2  MISSION CONTEXT        conversation.item.create (once)  <500 tokens
Layer 3  LIVE CONTEXT           conversation.item.create (FIFO)  <3000 tokens
Layer 4  CONVERSATION           Managed by Realtime API          ~124K tokens
```

### Layer 0: Core Identity (Static)

**What:** Facilitator identity and non-negotiable behavioral rules.
**When set:** Once, at session start via `session.update`.
**Token budget:** <250 tokens.

**Core philosophy:** CallingClaw is a meeting FACILITATOR, not a retrieval engine.
Like a sharp engineering manager or strategy advisor from /plan-eng-review and
/plan-ceo-review — it drives clarity, confirms decisions, and challenges vague
thinking. Retrieval (recall_context) is a LAST RESORT for concrete facts.

Contents:
- Who you are: facilitator, drive clarity not retrieval (1 sentence)
- Depth-driving behaviors: ask "why?", "tradeoff?", "who owns this?"
- Decision confirmation pattern: "So the decision is X — correct?"
- Pushback on vagueness: "What specifically do you mean by...?"
- Action item tracking: owner + deadline before moving on
- Language rule
- recall_context as last resort only

**Key principle:** This layer is SMALL. Every token here competes with conversation
context. Only rules that must ALWAYS be followed belong here.

### Layer 1: Capabilities (Static)

**What:** Tool definitions registered in the Realtime session.
**When set:** Once, at session start via `session.update` tools array.
**Token budget:** ~300 tokens (depends on number of tools).

**Key principle:** Tools are NEVER listed in the system prompt text. The model
discovers available tools from the session configuration. This prevents tool
hallucination (the model calling tools that don't exist).

### Layer 2: Mission Context (Semi-Static)

**What:** Meeting prep brief, compressed to essential context.
**When set:** Once after session starts, via `conversation.item.create`.
**Token budget:** <500 tokens.

Contents:
- Meeting topic and goal
- Key points (compressed)
- Architecture decisions (compressed)
- Expected questions (compressed)
- File/URL references

**Key principle:** This is injected as a conversation item, NOT part of the system
prompt. This separation ensures Layer 0 stays tiny and Layer 2 can be updated
without rebuilding the session.

### Layer 3: Live Context (Dynamic, FIFO) — "The Silent Knowledge Layer"

**What:** Real-time context updates injected silently during meetings.
**When set:** Incrementally via `conversation.item.create` as new context arrives.
**Token budget:** ~3000 tokens (MAX_CONTEXT_ITEMS=15, ~200 tokens each).

Sources:
- ContextRetriever search results ([CONTEXT] prefix)
- Screen descriptions ([SCREEN] prefix)
- Computer Use completions ([DONE] prefix)
- Live notes from OpenClaw ([NOTE] prefix)

**The magic:** Users never see Layer 3. They just notice the AI "gets smarter"
as the meeting progresses. ContextRetriever runs aggressive background retrieval
(300 char threshold, 20s intervals, broad intent detection) and silently injects
results. The Voice AI uses this context naturally — never saying "让我查一下"
or "let me look that up."

**Design principle:** Wide intent detection, silent injection.
- Trigger on: questions, past references (之前/上次), decision mentions,
  metric references, bug mentions, competitor references
- All retrieval is invisible to the user
- Voice AI rule 8: "never announce that you are searching"

**Key principle:** FIFO eviction — when the queue exceeds MAX_CONTEXT_ITEMS,
the oldest item is deleted via `conversation.item.delete`. The model sees
only the most recent and relevant context.

### Layer 4: Conversation (Organic)

**What:** User speech transcripts, AI responses, tool call results.
**When set:** Automatically by the Realtime API.
**Token budget:** ~124K tokens (everything not used by Layers 0-3).

**Key principle:** We do NOT manage this layer. The Realtime API handles
conversation history internally. Our job is to keep Layers 0-3 small
so Layer 4 has maximum room.

## Token Budget Tracking

Total context window: ~128K tokens (OpenAI Realtime).

| Layer | Budget | % of Total |
|-------|--------|-----------|
| 0: Identity | <250 | 0.20% |
| 1: Tools | ~300 | 0.23% |
| 2: Mission | <500 | 0.39% |
| 3: Live | <3000 | 2.34% |
| 4: Conversation | ~124K | 96.8% |
| **Overhead** | **<4K** | **3.2%** |

Monitor via `response.done` events which include `event.usage` with
`input_tokens` and `output_tokens`. Emit warnings at 80% capacity,
auto-compress context queue at 90%.

## Prompt Modification Guidelines

### Adding a new behavioral rule
1. Ask: "Must this ALWAYS be followed?" → Layer 0 (non-negotiable)
2. Ask: "Is this meeting-specific?" → Layer 2 (mission context)
3. Ask: "Is this situational?" → Layer 3 (live context)
4. Verify Layer 0 stays under 200 tokens after the change.

### Adding a new tool
1. Define it in `ai-tools.ts` or a new tool definition file.
2. Register it via `VoiceModule.addTool()`.
3. Do NOT mention it in any prompt text — the model discovers it from the session config.

### Modifying meeting behavior
1. If it's a persistent behavioral change → Layer 0 constraints
2. If it's meeting-specific context → Layer 2 mission brief
3. If it's a live update → Layer 3 via `injectContext()`
4. Never use `session.update` for mid-meeting changes (causes audio breaks).

## Verification Checklist

Before shipping any prompt change:

- [ ] Layer 0 (CORE_IDENTITY) is under 200 tokens
- [ ] No tool names appear in system prompt text
- [ ] LANGUAGE_RULE constant is used (no copy-paste)
- [ ] Non-negotiable rules have priority markers
- [ ] Meeting brief is injected via conversation.item.create, not session.update
- [ ] Context queue FIFO eviction is working (MAX_CONTEXT_ITEMS respected)
- [ ] Token budget logging shows overhead <4K tokens
- [ ] Reconnect uses clean instructions (no transcript stuffing)
- [ ] Prompt eval tests pass

## Architecture Diagram

```
User Speech ──→ Realtime API ──→ Voice AI Model
                    │                    │
                    │  Layer 0: CORE_IDENTITY (session.update instructions)
                    │  Layer 1: Tools (session.update tools)
                    │  Layer 2: Mission Brief (conversation.item.create, once)
                    │  Layer 3: Live Context (conversation.item.create, FIFO)
                    │  Layer 4: Conversation (automatic)
                    │                    │
                    │                    ├──→ Tool Call: recall_context
                    │                    │       ├── Cache hit (<1ms)
                    │                    │       ├── Memory search (<100ms)
                    │                    │       └── OpenClaw deep search (2-15s)
                    │                    │
                    │                    └──→ Audio Response ──→ Speaker
                    │
    ContextRetriever ──→ Layer 3 injection
    VisionModule ──→ Layer 3 injection
    ComputerUse ──→ Layer 3 injection ([DONE] prefix)
```

## Cross-Reference: Other AI Layers

CallingClaw has 4 AI layers. Only the Voice layer uses this 5-layer context model.
The others have simpler prompt structures:

| AI Layer | Model | Prompt Structure | Token Budget |
|----------|-------|-----------------|-------------|
| Voice | OpenAI Realtime / Grok | 5-layer model (this doc) | ~128K total |
| Computer Use | Claude (Anthropic) | system + messages loop | 200K total |
| Vision | Gemini Flash | system + single image | ~8K total |
| ContextRetriever | Haiku / Gemini Flash | single prompt per call | ~4K total |
