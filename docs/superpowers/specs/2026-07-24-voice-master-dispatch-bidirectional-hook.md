# Voice-Master → Subagent Dispatch & the Bidirectional Hook (in-meeting)

**Status:** Research + Design. **PR-ready, NOT implemented.** No code changes this round.
**Date:** 2026-07-24 · **Surface:** in-meeting harness only · **Author:** systems design pass
**Branch inspected:** `fix/intent-recognition-optimization` (HEAD `b250e6d`)

> Provenance. External claims carry a source tag: `[T2 Sx]` = Codex-voice research (see §8),
> `[T3 …url]` = industry SOTA research (see §8). Every codebase claim carries a `file:line` that
> an independent reviewer can open; those trace to T1 (`scratchpad/research/T1-callingclaw-current-state.md`),
> which was independently re-confirmed while writing this doc (see §0, first bullet).

---

## 0. TL;DR / Executive summary

- **Premise flip (read first).** The task assumed the "bidirectional hook" — PR #37's
  `VoiceResponseScheduler` + `DeliberateResult` sink — **already runs in-meeting. It does not on this
  branch.** It lives only on the unmerged branch `feat/s1s2-robustness` (commit `62468c2`), which is
  **not an ancestor of HEAD** (re-verified: `git merge-base --is-ancestor 62468c2 HEAD` → false).
  `deliverDeliberateResult`, `VoiceResponseScheduler`, and `DeliberateResult` return **zero hits** in
  `src/` (re-verified by grep). `DeliberateResult` is therefore a strong *starting contract to land*,
  not a shipped feature.
- **Live phantom bug on the research hook-back path.** `transcript-auditor.ts:902` calls
  `this.voice.client.queuePendingResponse()`; grep confirms **one call site, zero definitions** in
  `src/`. Whenever a research result lands while voice is not `listening`, this throws `TypeError`.
- **Today there is no single hook-back — there are FOUR divergent ad-hoc paths** (T1 §C.1): voice slow
  tool (`voice.ts:478-494`, *speaks*), auditor action (`transcript-auditor.ts:1498-1533`, *silent*),
  auditor research (`transcript-auditor.ts:896-903`, *buggy*), context-retriever
  (`context-retriever.ts:1248-1260`, *conditional*). Each producer wires its own return.
- **Autonomous auditor actions are silent.** `notifyTaskCompletion(...)` only speaks when
  `opts.speak === true` (`voice-persona.ts:538`), and **every in-meeting caller omits it**
  (`transcript-auditor.ts:1501`, `automation-tools.ts:247`) — the "did the action, said nothing" gap.
- **`task.completed` never speaks.** The ActionOrchestrator's terminal event only refreshes the
  `[ACTING]` context item (`callingclaw.ts:928`); no result is voiced.
- **Dispatch carries almost no context.** `agentAdapter.executeTask` receives a *bare synthesized
  string* with no meeting state, no correlation id, no return-address (`transcript-auditor.ts:866-868`);
  the ActionOrchestrator executor gets only `instruction` + `AbortSignal` + `onStep`
  (`action-orchestrator.ts:44-45`). This is the single biggest gap versus SOTA context contracts.
- **Routing is distributed across three deciders, not one router** (T1 §E): the Realtime model's own
  tool-choice × the `recall_context` urgency ladder (`ai-tools.ts:56-60,127-163`) × the auditor's
  3-lane confidence routing (`transcript-auditor.ts:591-627`).
- **Codex desktop voice mode (shipped 2026-07-23) is the reference implementation of exactly this
  pattern** — inline answers by the live voice model, long tasks dispatched to background agent threads
  that narrate completion by voice `[T2 S1,S6,S11]`. CallingClaw is building the same shape at meeting
  scale.
- **Recommended shape (three parts, one spine).** (1) A **DispatchRouter** that normalizes the three
  existing deciders into one taxonomy — `inline | fast-local-action | long-horizon-agent` — adding
  **zero new model calls** (reuses the auditor's existing Haiku classify), honoring the SOTA
  near-free-classifier rule. (2) A **SubagentTaskEnvelope** — the missing *outbound* contract
  (objective + output format + scoped tools + boundaries + meeting-state slice + correlation id +
  `sourceTurnId` + return-address), the mirror of PR #37's *return* envelope. (3) **One sink** —
  PR #37's `VoiceModule.deliverDeliberateResult()` — extended to the two things PR #37 left open
  (action-producer migration so autonomous results speak, and cross-source coalescing), plus wiring
  `task.completed → sink`, plus collapsing the dual response gates.
- **Phasing.** Phase 0 = land/rebase PR #37 (kills the phantom bug, delivers the sink + turn-lease).
  Phase 1 = context envelope + unified router. Phase 2 = full bidirectional hook (action producers +
  `task.completed`→speak + cross-source coalescing + single gate).
- **Constraints held throughout.** In-meeting models stay Haiku-class (no Opus on the live path);
  all runtime context via `conversation.item.create`, never `session.update` mid-meeting
  (`realtime_client.ts:1082-1117`).

---

## 1. The target mental model — voice-master → subagent dispatch

CallingClaw's in-meeting stack already *is* a master/worker system; it just lacks the naming and the
seams. Cast in the SOTA "manager keeps the mic" pattern `[T3 openai.github.io/multi_agent]`:

- **The voice-master = `VoiceModule` + `RealtimeClient`** — the single mouth and ears. It owns the
  conversation and is the *only* thing that speaks (`voice.ts`, `ai_gateway/realtime_client.ts`).
- **The hand = `ActionOrchestrator`** — one serialized executor for every screen/browser action, any
  source (`action-orchestrator.ts:28,88`). Deterministic, sub-second-to-seconds.
- **The brain = `AgentAdapter.executeTask`** — a local background agent (OpenClaw / Claude Code /
  Codex / Hermes) reached by shelling out to a separate process with a fresh context
  (`agent-adapter.ts:69`; T1 §B.8). Minutes-scale, isolated.

The three lanes the master must route between:

1. **(a) Voice-answerable Q&A → answered inline by the live voice model.** No dispatch. The model
   speaks from Layers 0–4 (identity, tools, mission, live context, conversation). This includes the
   instant `recall_context` hits (prep-brief / retriever-cache / local memory) that return
   synchronously and read as inline (`ai-tools.ts:74-138`).
2. **(b) Fast, local, deterministic actions → the hand.** Click / scroll / share / mute / open —
   `ActionOrchestrator.submit(...)` with an `AbortSignal`. Latency-critical; runs now.
3. **(c) Long-horizon / multi-step tasks → the brain, in the background.** Web/deep research,
   file-editing, multi-step reasoning — `AgentAdapter.executeTask(...)`, fire-and-continue while the
   master keeps talking. Needs the full context envelope (§5b) and the async hook-back (§5c).

The closed loop: **voice → (route) → hand/brain → (result) → one sink → voice speaks.** Today lane (a)
works, lane (b) works but returns *silently*, and lane (c) returns through a *buggy* path — and there
is no single router deciding a/b/c and no single sink closing the loop. This design supplies the
router (§5a), the outbound envelope (§5b), and the unified sink (§5c).

A CallingClaw-specific twist absent from generic voice agents: the **Meeting Stage** (`public/stage.html`)
mirrors S2 worker activity to the human audience via the EventBus. The Stage is *display-only* and does
**not** feed results back to voice (T1 §B.6) — the real S2→S1 "conversation" is the backend hook-back
this design unifies. Keeping the sink as the one producer of `response.create` also keeps the Stage
feed coherent (one authoritative completion per dispatch instead of four).

---

## 2. Industry SOTA (distilled from T3)

### 2.1 Routing — answer-now vs dispatch

- **Fork with a near-free classifier, never a second LLM turn.** "The classifier itself must be cheap
  and fast — a regex or keyword pass … under 20ms … routing decisions should not be routed through a
  second LLM call"; router overhead should be <5% of the response budget, and the whole
  STT→route→infer→TTS path must fit under the ~300–500 ms a user notices
  `[T3 futureagi.com/how-to-optimize-voice-agent-latency-2026]`.
- **Default to agents-as-tools (manager keeps control of the mic).** "A manager agent keeps control of
  the conversation and calls specialist agents through `Agent.as_tool()`" — right when "you want one
  agent to own the final answer." Reserve **handoffs** (a specialist "becomes the active agent for the
  rest of the turn") for when routing itself is the workflow `[T3 openai.github.io/multi_agent]`. A
  background worker should **not** seize the live mic.
- **The delegation bar.** Subagents "earn their complexity" only for **context isolation, parallelism,
  specialized instructions, or tool restrictions** `[T3 code.claude.com/agent-sdk/subagents]`; below
  that bar, answer inline. Size the dispatch to complexity — "simple fact-finding requires just 1 agent
  with 3–10 tool calls, direct comparisons might need 2–4 subagents"
  `[T3 anthropic.com/built-multi-agent-research-system]` — and remember multi-agent runs **~15× the
  tokens**, so dispatch only when "the value of the outcome outweighs the expense"
  `[T3 claude.com/building-multi-agent-systems-when-and-how]`.
- **Orchestrate via code where possible** (structured outputs) for determinism; reserve LLM-driven
  orchestration for open-ended planning `[T3 openai.github.io/multi_agent]`.

### 2.2 Context-passing contract to subagents

- **The canonical task brief: objective + output format + tool/source guidance + explicit boundaries.**
  "Each subagent needs an objective, an output format, guidance on the tools and sources to use, and
  clear task boundaries." Skipping this is the named failure mode — "agents duplicate work, leave gaps,
  or fail to find necessary information" `[T3 anthropic.com/built-multi-agent-research-system]`.
- **Everything crosses in the prompt string; the subagent inherits nothing else.** "A subagent's
  context window starts fresh… The only content you pass from parent to subagent is the Agent tool's
  prompt string, so include any file paths, error messages, or decisions the subagent needs directly
  in that prompt" `[T3 code.claude.com/agent-sdk/subagents]`. It does **not** receive the parent's
  history, system prompt, or tool results.
- **Typed handoff surface** (`AgentDefinition`): `description` (the routing signal), `prompt`, scoped
  `tools`/`disallowedTools` (least privilege), per-agent `model`/`effort`, and
  **`background: boolean`** — "run this agent as a non-blocking background task"
  `[T3 code.claude.com/agent-sdk/subagents]`.
- **Fresh, isolated context; summary-only return.** "Only its final message returns to the parent" —
  intermediate reads stay inside, keeping the master's context lean
  `[T3 code.claude.com/agent-sdk/subagents]`. Isolation is a feature, not a limitation `[T3 §B4]`.

### 2.3 Async result → voice hook-back

- **The Realtime primitive: inject, then trigger.** Return the tool result via
  `conversation.item.create`, then **separately** emit `response.create` to make the model speak it —
  "`conversation.item.create` does not auto-generate a response"
  `[T3 developers.openai.com/realtime-conversations]`. This is the exact seam:
  add the async result whenever it lands, then fire `response.create` to voice it.
- **Native long-running tools (gpt-realtime, Aug 2025):** "Long-running function calls will no longer
  disrupt the flow of a session — the model can continue a fluid conversation while waiting on results"
  `[T3 openai.com/introducing-gpt-realtime]`. Prefer this over hand-rolled audio-blocking.
- **Out-of-band responses** — `"conversation": "none"` runs model work that does **not** touch the
  spoken transcript (summaries, validation, background triggers); disambiguate concurrent responses
  with `metadata` `[T3 developers.openai.com/realtime-conversations; community.openai.com/realtime-out-of-band-response]`.
- **Two-phase acknowledgment + give progress a voice.** Speak "on it / let me check" instantly (or play
  a thinking sound), then return with the real answer; for slow tools emit a spoken status update after
  a delay `[T3 huggingface.co/voice-agent-latency-playbook; docs.livekit.io/external-data]`.
- **Event-driven terminal-state for minutes-to-hours work.** Background agents "deliver task
  notifications on terminal state"; the master injects a "done + result" item and voices it — the
  `research.completed` / `computer.task_done` event shape is exactly this
  `[T3 tembo.io/background-coding-agents]`. Make such tools idempotent and
  non-cancel-on-interruption; ack immediately (return 200), store results, reference later
  `[T3 docs.vapi.ai/custom-tools-troubleshooting; docs.pipecat.ai/function-calling]`.

---

## 3. Codex desktop voice mode (distilled from T2) — the reference for this exact pattern

On **2026-07-23** OpenAI shipped **ChatGPT Voice** in the ChatGPT desktop app: "Control your computer
and direct multiple agents running in ChatGPT Work or Codex, using just your voice… powered by
GPT-Live, so it can speak, listen, and coordinate work in the app at the same time" `[T2 S1,S6]`. It is
a full-duplex voice layer that *orchestrates background agents*, not dictation `[T2 S3]`.

The interaction model is a **two-layer inline-vs-dispatch split** — precisely the mental model of §1:

- **Layer 1 — model-level reasoning delegation (inside GPT-Live).** Conversational turns are answered
  **inline** in real time. When a turn "calls for web search, deeper reasoning, or multi-step work with
  tools," GPT-Live "hands the task to GPT-5.5 in the background, keeps talking while that model runs,
  and weaves the result back in" with no perceptible gap; the two models "share the conversation's
  context but are orchestrated and served separately" `[T2 S9,S10]`. The voice model makes a talk /
  listen / wait / interrupt / **trigger-a-tool** decision many times per second `[T2 S9,S10]`.
- **Layer 2 — app-level task dispatch to background Codex/Work agent threads.** For longer jobs the
  voice layer "spins up separate agent threads that run in the background" while you keep talking; it
  can "start separate threads for longer tasks, check existing threads, and send follow-up
  instructions" and **narrate status/results back by voice** `[T2 S5]`. Execution runs on **Codex
  Remote** as a *control plane* — "the code still runs where it belongs: on your Mac… or other
  connected host" — with a **completion notification** that opens the relevant thread `[T2 S11]`.
  Codex Remote distinguishes **Queue** ("waits until the current response finishes, then sends your
  prompt as the next turn") vs **Steer** ("injects guidance into the work already in progress")
  `[T2 S11]`.
- Inferred (OpenAI hasn't disclosed the wiring): the desktop→agent bridge almost certainly uses
  tool/function-calling mapped onto Codex Remote's queue/steer/notify primitives `[T2 §D, inferred]`.
  No public GPT-Live API or latency numbers `[T2 S9,S10]`.

**Explicit parallel to CallingClaw.** Codex's Layer 1 ≈ CallingClaw's **`recall_context` urgency
ladder** (inline hits vs `thorough` dispatch to a background reasoning process; `ai-tools.ts:127-163`)
plus the Realtime model's own inline-vs-tool choice. Codex's Layer 2 ≈ CallingClaw's
**`agentAdapter.executeTask` research dispatch** + **`ActionOrchestrator`** hand, with `research.*` /
`computer.task_*` / `task.*` events as the terminal-state notifications the Stage and MCP clients
already consume (T1 §B.6; MCP `research.completed` / `computer.task_done`). CallingClaw is missing three
things Codex has: (i) one router deciding inline-vs-dispatch, (ii) a real context brief crossing the
dispatch boundary, and (iii) a reliable narrate-completion-by-voice path. Codex's Queue-vs-Steer is a
*future* affordance for CallingClaw's in-flight long-horizon tasks (today only **abort** exists —
`action-orchestrator.ts:152`; see §7 open questions).

---

## 4. CallingClaw current-state (from T1 — file:line ground truth)

### 4.1 Two in-meeting dispatch entry points (run in parallel, hook back differently)

- **A.1 Voice-model-initiated** — the Realtime model calls a tool. `response.function_call_arguments.done`
  at `voice.ts:420`; `SLOW_TOOLS` (`voice.ts:22-40`) take the async pattern (`voice.ts:466-505`):
  background-ack the call (`submitToolResultBackground`, `realtime_client.ts:1002`), inject a silent
  `[WORKING]` note, run `onToolCall` async, and on resolve inject `[DONE] …` + `_feedbackScreenshot`
  + **`_requestResponse({})`** → the model speaks (`voice.ts:478-494`). **This loop closes today.**
- **A.2 Auditor-initiated** — no tool call; `TranscriptAuditor` watches every user transcript
  (`transcript-auditor.ts:591`) and fans out three lanes: agent-address fast lane → immediate research
  dispatch (`:601-617`), regex fast lane `confidence ≥ 0.95` → local action now (`:619-627`), medium
  lane → debounced Haiku audit (`runAudit` `:927` → `classifyIntent` `:995`, model `CONFIG.analysis.model` `:1073`) → `executeAction`
  (`≥ CONFIDENCE_AUTO`) / `suggestAction` (`≥ 0.6`) / silent (`:962-984`).

### 4.2 The four ad-hoc hook-back paths (no unified sink — T1 §C.1)

| Producer | How the result reaches the voice model | Speaks? | file:line |
|---|---|---|---|
| Voice slow tool (`computer_action`, `recall_context`, `share_screen`…) | `injectContext("[DONE] …")` + `_feedbackScreenshot` + `_requestResponse({})` | **Yes** (gated) | `voice.ts:478-494` |
| Auditor automation/computer action | `notifyTaskCompletion` (no `speak`) / `injectContext("[DONE] …")`, **no `response.create`** | **No** (silent, next turn) | `transcript-auditor.ts:1498-1533` |
| Auditor research (`research_task`) | `replaceContext("[RESEARCH] …")` + `response.create` **if listening** else `queuePendingResponse()` | Partly — **buggy** | `transcript-auditor.ts:896-903` |
| ContextRetriever gap-fill | `pushContextUpdate` + (if it answered a live question) `speakWithInstruction(...)` else silent `[CONTEXT_HINT]` | Conditional | `context-retriever.ts:1248-1260` |

Shared helper `notifyTaskCompletion(...)` speaks **only if `opts.speak === true`** (`voice-persona.ts:538`),
and every in-meeting caller omits it (`transcript-auditor.ts:1501`, `automation-tools.ts:247`) → the
comment at `voice-persona.ts:534-537` describes an intent the wiring does not fulfill.
**Live phantom bug:** `transcript-auditor.ts:902` `queuePendingResponse()` — undefined in `src/`
(re-verified: one call site, zero definitions).

### 4.3 EXISTS vs MISSING (for a clean voice-master → subagent → voice-reply model — T1 §D)

| Capability | Status TODAY | Evidence |
|---|---|---|
| Serialized runtime task queue (dedup, abort, progress) | **EXISTS** — screen/browser executors only | `action-orchestrator.ts:88-224` |
| Voice→runtime dispatch from the model's own tool call | **EXISTS** — SLOW_TOOLS async | `voice.ts:443-506`; `automation-tools.ts:203-250` |
| Voice→runtime dispatch from background intent | **EXISTS** — auditor 3-lane | `transcript-auditor.ts:591-991` |
| Runtime→voice hook-back that SPEAKS | **PARTIAL** — voice tools yes; auditor actions silent; research buggy | `voice.ts:493`; `transcript-auditor.ts:1529,902` |
| Single unified result→voice contract (one sink) | **MISSING** — 4 divergent paths | §4.2 |
| Cross-producer dedup / idempotency | **PARTIAL** — orchestrator coalesces by instruction; auditor rings; no cross-producer id | `action-orchestrator.ts:91-110`; `transcript-auditor.ts:586` |
| Staleness / turn-lease | **MISSING** — designed in PR #37 only | unmerged `deliberate-result.ts` |
| Producer error never spoken as fact | **MISSING/PARTIAL** — research regex-sniffs its own errors only | `transcript-auditor.ts:878-879` |
| Single response gate | **MISSING** — two overlapping gates | `voice.ts:167`; `realtime_client.ts:927-944` |
| Long-horizon agent dispatch in-meeting | **PARTIAL/ONE-WAY** — research `executeTask` + fire-and-forget vision push | `transcript-auditor.ts:866`; `callingclaw.ts:358-366` |
| Runtime context injection w/o audio break | **EXISTS** — `conversation.item.create`, FIFO-evicted | `realtime_client.ts:1082-1117` |
| Task lifecycle → spoken completion | **MISSING** — `task.completed` only refreshes context | `callingclaw.ts:928` |
| Live phantom method on research hook-back | **BUG PRESENT** | `transcript-auditor.ts:902` |

### 4.4 Routing is distributed, and dispatch carries almost no context (T1 §E)

"Inline vs dispatch" = (Realtime model's tool choice) × (`recall_context` urgency ladder,
`ai-tools.ts:56-60,127-163`) × (auditor lane + confidence, `transcript-auditor.ts:591-627`). What
crosses the dispatch boundary today:

- **To `agentAdapter.executeTask` (research):** only a synthesized string
  (`"Search the web for: \"<query>\"…"`, `transcript-auditor.ts:866-868`) — **no meeting state, no
  correlation id, no return-address.**
- **To the ActionOrchestrator executor:** `instruction` + `AbortSignal` + `onStep`
  (`action-orchestrator.ts:44-45`; `automation-tools.ts:223-226`). No transcript, no prep.
- **To ComputerUse:** `instruction` + `maxSteps` + self-captured screenshots (`computer-use.ts:336`).
- **To `recall_context` thorough:** `query` + `localContext` + detected language (`ai-tools.ts:143-158`).

### 4.5 PR #37's `DeliberateResult` — designed-but-unmerged (read from `62468c2`)

PR #37 (`62468c2:callingclaw-backend/src/modules/deliberate-result.ts`, confirmed present in that
object, absent from HEAD) defines the **return** contract this design builds on:

- **`DeliberateResult` envelope** — `{ id, kind:"research"|"recall"|"retrieval"|"action", summary,
  detail?, sourceUtterance?, sourceTurnId?, dispatchedAt, speak:"proactive"|"silent", replaceId?,
  error?, instruction? }`. One shape every System-2 producer returns.
- **One sink** — `VoiceModule.deliverDeliberateResult()` — the *only* thing allowed to touch the
  Realtime client / Layer-3 queue / `response.create` / staleness. Producers never call
  `response.create` directly.
- **Deterministic turn-lease staleness** — pure `classifyStaleness(input)`: compares `sourceTurnId`
  (stamped at dispatch) to the current user-turn id + a hard `maxAgeMs` (default 10 min). Decisions
  `speak` (≤1 turn) / `inject-silent` (≤4 turns) / `drop`. **No model, no network.**
- **Honest disposition enum** — `response-requested | deferred | injected-silent | dropped-stale |
  dropped-duplicate | no-session | error-suppressed`.
- **Producer-declared `error` → suppressed** — rendered as a neutral internal note, never spoken,
  never triggers speech; the sink does **not** content-sniff a success envelope (the old
  content-sniff was removed as a borderline-blocker regression — see the file's own comment).
- **`instruction`** — optional ephemeral one-turn `response.instructions`, not persisted to Layer 3.

**Two things PR #37 explicitly left open** (T1 §C.2, and the project memory note): (i) **action-producer
migration** — ComputerUse / automation completion was a follow-up, so even PR #37 did not unify the
action path; (ii) **cross-source coalescing** — a voice-recall and an auditor-research for the same
question can double-answer (needs a "DeliberateDispatcher"). PR #37's reliability layer
(`S1S2_WATCHDOG_MODE`, generation-token watchdogs, `ReconnectSupervisor`) is also absent from this
branch. **Bottom line: a strong starting contract, not a finished bidirectional bus.**

---

## 5. Design proposal (in-meeting, concrete, grounded)

Three sub-designs, one spine: **Router → Envelope → Sink.** All named against real modules with
concrete integration points. Interfaces/pseudocode only — **no source edits this round.**

```
 user speech
     │
     ▼
┌─────────────────┐   inline           ┌──────────────────────────────┐
│  DispatchRouter │ ─────────────────▶ │ VoiceModule speaks (Layers 0-4)│
│  (§5a, no new   │                    └──────────────────────────────┘
│   model call)   │   fast-local-action ┌─────────────────────────────┐
│                 │ ─────────envelope─▶ │ ActionOrchestrator (the hand) │──┐
│  taxonomy:      │                     └─────────────────────────────┘  │
│  inline /       │   long-horizon      ┌─────────────────────────────┐  │ DeliberateResult
│  fast-local /   │ ─────────envelope─▶ │ AgentAdapter.executeTask     │──┤  (§5c return)
│  long-horizon   │                     │ (the brain, background)      │  │
└─────────────────┘                     └─────────────────────────────┘  │
                                                                          ▼
                            ┌───────────────────────────────────────────────────┐
                            │  VoiceModule.deliverDeliberateResult()  — ONE SINK   │
                            │  turn-lease staleness · error-suppress · dedup ·     │
                            │  single response.create gate → voice speaks (or not) │
                            └───────────────────────────────────────────────────┘
```

### 5a. Dispatch router — one place classifies "answer inline vs dispatch"

**Goal:** collapse the three distributed deciders (T1 §E) into one *taxonomy* and one *decision object*,
**without adding a model call**, honoring the SOTA near-free-classifier rule (`<20ms`, `≤5%` of budget,
never a second full LLM turn `[T3 futureagi.com]`) and the "manager keeps the mic" default
`[T3 openai.github.io/multi_agent]`.

**Key stance: the router *normalizes existing signals*; it does not introduce a new brain.** The three
deciders already produce enough signal — the Realtime model's tool choice, the regex/`AutomationRouter`
confidence, and the auditor's single Haiku `classifyIntent` (`transcript-auditor.ts:995`, called from `runAudit` `:949`). The router is
a pure function that maps those into one enum + a routed target, and stamps the envelope (§5b). The only
model touch remains the auditor's *already-existing* Haiku call — no new latency.

**Taxonomy (the decision):**

```ts
type DispatchLane =
  | "inline"             // voice model answers from Layers 0-4; NO dispatch
  | "fast-local-action"  // ActionOrchestrator (the hand): click/scroll/share/mute/open
  | "long-horizon-agent";// AgentAdapter.executeTask (the brain): research/deep-recall/multi-step

interface DispatchDecision {
  lane: DispatchLane;
  target?: "orchestrator" | "agent"; // undefined ⇒ inline
  urgency?: "quick" | "thorough";    // carries the recall ladder’s existing enum
  confidence: number;                // from the source decider
  reason: string;                    // for the Stage / telemetry
}
```

**Decision precedence (deterministic, cheapest-first — mirrors T3's fast-lane-first ordering):**

1. **Inline hits (near-zero cost).** `recall_context` Path -1/0/A instant hits already return
   synchronously and read as inline (`ai-tools.ts:74-138`) → `lane:"inline"`. If the Realtime model
   answered without calling a tool, that is inline by definition (the model's own free choice — keep
   it; §2.1).
2. **Fast-local-action (regex/keyword, <20ms).** Reuse `AutomationRouter.classify` /
   the auditor regex fast lane at `confidence ≥ 0.95` and layer ≠ computer_use
   (`transcript-auditor.ts:619-627`) → `lane:"fast-local-action", target:"orchestrator"`. This is the
   SOTA keyword pass; it never touches a model.
3. **The delegation bar → long-horizon (only when it clears the bar).** Apply the SOTA bar — context
   isolation, parallelism, specialized skill, or tool restriction
   `[T3 code.claude.com/agent-sdk/subagents]` — realized as CallingClaw's existing signals:
   `recall_context urgency:"thorough"` (`ai-tools.ts:56-60`), auditor `research_task`
   (`transcript-auditor.ts:1361-1367`), or an explicit agent address (`:601-617`) →
   `lane:"long-horizon-agent", target:"agent"`. Everything below the bar stays inline or fast-local.
4. **Uncertain → the auditor's existing Haiku classify (the *only* model in the router).** When lanes
   1–3 don't fire, the medium lane's debounced single Haiku call (`runAudit` `:927` → `classifyIntent` `:995`, model
   `CONFIG.analysis.model` `:1073`) produces the intent; its confidence maps to `CONFIDENCE_AUTO`
   (execute), `≥ 0.6` (suggest), else silent (`:962-984`). **No new model call is added** — the router
   consumes this decision, it does not spawn its own.

**Placement / integration.** A small pure module `modules/dispatch-router.ts` exporting
`route(input): DispatchDecision`. It is *called by the existing deciders*, not inserted ahead of them:

- `VoiceModule` (SLOW_TOOLS branch, `voice.ts:443`) tags the tool's dispatch with the lane
  (`share_screen`/`computer_action` → fast-local; `recall_context thorough` → long-horizon).
- `TranscriptAuditor` (`transcript-auditor.ts:601-627,962-984`) replaces its ad-hoc lane picks with a
  single `route(...)` call so the taxonomy is authoritative and observable.
- `recall_context` (`ai-tools.ts:127-163`) reports its `quick`/`thorough` choice as the router's
  `urgency`.

**Latency & tiers.** Router adds **zero** model calls and no network on the hot path (pure normalization
over signals that already exist) — within the `<20ms / ≤5%` budget `[T3 futureagi.com]`. In-meeting
executors stay Haiku-class (ComputerUse Haiku `computer-use.ts:370-388`; agentAdapter Haiku-class) per
the meeting-latency constraint — **no Opus on the live path.** Emitting `dispatch.routed {lane, reason}`
on the EventBus gives the Stage/S2 a single, honest "why we did this" signal and a measurable routing
accuracy target (reuse the `auditor-intent-eval` harness for a labeled router test set).

### 5b. Subagent context envelope — fix "dispatch carries almost no context"

**Goal:** supply the missing **outbound** contract (T1 §E: research dispatch gets a bare string). PR #37
defined only the *return* envelope; this is its mirror. Grounded in Anthropic's task-brief contract —
**objective + output format + tool/source guidance + boundaries, self-contained, fresh isolated
context, summary-only return** `[T3 anthropic.com/built-multi-agent-research-system;
code.claude.com/agent-sdk/subagents]`.

```ts
// modules/subagent-envelope.ts (new; pure types + one composer)
interface SubagentTaskEnvelope {
  // ── identity / correlation ──
  id: string;                // per-dispatch: "disp_<ts>_<seq>" — idempotency + dedup key
  correlationId: string;     // meeting lifecycle id (EventBus.startCorrelation, event-bus.ts:31)
  kind: DeliberateKind;      // reuse PR #37 union: research|recall|retrieval|action
  // ── the task brief (T3 §B1) ──
  objective: string;         // what to accomplish, imperative
  outputFormat: string;      // e.g. "3-5 findings, each 1 line + source; concise"
  boundaries?: string;       // scope limits / do-not (T3: "clear task boundaries")
  tools?: string[];          // least-privilege allowlist / source guidance (T3 §B2)
  // ── the meeting-state slice (the T1 gap) ──
  meetingState: {
    topic?: string;                 // prepSkill.currentBrief.topic
    recentTranscript?: string;      // last ~N turns, capped (context.getRecentTranscript)
    screenContext?: string;         // current presenting URL/page summary
    prepRefs?: string[];            // matched prep sections / file paths (read_prep)
    language?: string;              // detectLanguage(query)
  };
  // ── staleness + return address ──
  sourceTurnId: number;      // VoiceModule.userTurnId at dispatch (NEW counter, §5c)
  sourceUtterance?: string;  // the utterance that triggered dispatch
  dispatchedAt: number;
  speak: SpeakMode;          // how the RESULT should return (proactive|silent)
  returnAddress: "voice-sink";  // always the one sink (§5c) — no per-producer wiring
}
```

**Composer, not a leak.** `composePrompt(env): string` folds `objective + outputFormat + boundaries +
meetingState` into a single prompt string, because the subagent inherits *nothing but the prompt*
`[T3 code.claude.com/agent-sdk/subagents]`. This matches how `agentAdapter` shells out to a separate
process (T1 §B.8) — the envelope IS the fresh, isolated context. The meeting-state slice is **capped**
(recent transcript ≤ ~800 chars, prepRefs ≤ 3) to keep dispatch cheap and the subagent focused.

**Integration points (back-compatible — envelope is optional):**

- `AgentAdapter.executeTask(instruction: string)` (`agent-adapter.ts:69`) →
  `executeTask(instruction: string, envelope?: SubagentTaskEnvelope)`. When present, adapters use
  `composePrompt(envelope)`; when absent, behavior is unchanged (existing callers keep working). The
  research dispatch at `transcript-auditor.ts:866-868` builds the envelope instead of a bare string.
- `ActionOrchestrator.submit(source, instruction, executor)` (`action-orchestrator.ts:88`) →
  add optional `envelope` carried on `ActionTask` (`:31`) so the executor and the hook-back share one
  object and the coalesce key (§5c) can prefer `envelope.id`.
- `recall_context` thorough dispatch (`ai-tools.ts:143`) attaches `localContext` + language into the
  envelope's `meetingState`/`boundaries` rather than an ad-hoc arg pair.

**Return contract (already right, formalize it).** Research already returns a concise summary and writes
the full result to a Working Document (`transcript-auditor.ts:889-897`) — that is exactly the
**summary-only return** SOTA prescribes `[T3 code.claude.com/agent-sdk/subagents]`. Formalize: the
subagent's summary → `DeliberateResult.summary` (spoken-ready), full detail → working doc + capped
`DeliberateResult.detail` (Layer-3). Least-privilege + right-sized model per `kind` keeps in-meeting
work Haiku-class (T3 §D7; the meeting-latency constraint).

### 5c. Bidirectional hook — unify the four paths behind ONE sink

**Goal:** one sink closes voice→runtime→voice for *every* producer, extended past what PR #37 shipped.
Start from PR #37's `DeliberateResult` + `VoiceModule.deliverDeliberateResult()` + deterministic
turn-lease, then add the two open items (action-producer migration; cross-source coalescing), wire
`task.completed → sink`, collapse the dual gates, and fix the phantom bug.

**The sink (from PR #37, unchanged in shape):**

```ts
// VoiceModule
deliverDeliberateResult(r: DeliberateResult): DeliveryDisposition;
// - the ONLY caller of response.create / injectContext-for-results / staleness
// - classifyStaleness(sourceTurnId, userTurnId, dispatchedAt, speak) → speak|inject-silent|drop
// - isDeliberateError(r) → render neutral note, never speak, never trigger response
// - dedup on r.id (dropped-duplicate); replaceId for in-place Layer-3 update
```

**Extensions this design adds on top of PR #37:**

1. **Add the missing `userTurnId` counter (prerequisite).** `classifyStaleness` needs
   `VoiceModule.userTurnId`, which **does not exist on this branch** (re-verified: zero hits in `src/`).
   Add a monotonic counter incremented in the `input_audio_buffer.speech_started` handler
   (`voice.ts:222-239`, adjacent to the existing `_tracer.startTurn()`), stamped onto every envelope at
   dispatch (§5b `sourceTurnId`). Without it the turn-lease degrades to "always fresh."

2. **Fix the phantom bug (Phase 0, via the sink).** Delete the `queuePendingResponse()` call at
   `transcript-auditor.ts:902`; research returns a `DeliberateResult{kind:"research", speak:"proactive"}`
   to the sink. The sink owns the "speak now vs defer vs drop" decision — no producer branches on
   `audioState` anymore. This is exactly PR #37's rename, now landed.

3. **Migrate all four producers to the sink (kills the 4 divergent paths):**
   - Voice slow tool (`voice.ts:478-494`) → build `DeliberateResult{kind:"action"|"recall"…,
     speak:"proactive"}`, call the sink instead of manual `injectContext + _feedbackScreenshot +
     _requestResponse`. (`_feedbackScreenshot` still runs before delivery.)
   - Auditor research (`transcript-auditor.ts:896-903`) → sink (see #2).
   - ContextRetriever gap-fill (`context-retriever.ts:1248-1260`) → sink with `speak:"proactive"` only
     when it answered a live question, else `speak:"silent"` (its existing logic, now expressed as the
     envelope's `speak` field instead of an ad-hoc `speakWithInstruction`).

4. **Action-producer migration so autonomous actions SPEAK (PR #37 left this open — T1 §C.2).**
   Auditor automation/computer completion (`transcript-auditor.ts:1498-1533`) and the `computer_action`
   tool (`automation-tools.ts:244-248`) return `DeliberateResult{kind:"action", speak:"proactive"}`.
   The turn-lease decides whether it actually speaks (fresh → speak; stale → silent). This closes the
   "did the action, said nothing" gap **without** the chattiness risk, because the lease gates it —
   an action whose triggering turn has passed degrades to silent injection, matching today's
   intended-but-unwired behavior (`voice-persona.ts:534-537`). `notifyTaskCompletion` is refactored to
   *produce a DeliberateResult* rather than conditionally speak.

5. **Wire `ActionOrchestrator.task.completed → sink** (`callingclaw.ts:928` today only refreshes
   context). On `task.completed`, build a `DeliberateResult{kind:"action"}` from the task's `result`
   + carried `envelope` and deliver it. This makes **every** orchestrator task — from any source
   (voice/auditor/http/agent) — able to narrate its own completion through one path, subsuming the
   per-caller `notifyTaskCompletion` wiring. `task.cancelled` still injects the silent "do not narrate"
   note (`callingclaw.ts:933`); `task.failed` produces an `error`-flagged envelope → suppressed.

6. **Cross-source coalescing — a `DeliberateDispatcher` (PR #37 descoped — T1 §C.2).** Prevent a
   voice-recall and an auditor-research for the *same question* from double-answering. Two layers,
   reusing the orchestrator's proven pattern:
   - **Dispatch-time** — key the envelope on a normalized objective (same `_normalize` shape as
     `action-orchestrator.ts:171`); a second dispatch within a coalesce window returns the first's
     promise (mirrors `action-orchestrator.ts:91-110`, generalized from actions to all dispatches).
   - **Return-time** — the sink already dedups on `DeliberateResult.id`; the dispatcher additionally
     drops a late second result whose objective-key matches one already delivered this turn-lease.

7. **Collapse the dual response gates into the sink** (`voice.ts:167` `_requestResponse` +
   `realtime_client.ts:927-944`). The sink becomes the single owner of `response.create` — it holds the
   one `_responseActive`/deferred-payload gate and flushes on `response.done`. `_requestResponse`
   remains a thin private used only by `speakWithInstruction` for non-result speech (fillers,
   progress); result-speech goes *only* through the sink. This removes the "two overlapping debounces"
   root cause of "did the action, said nothing" (T1 §C.1).

**Latency-safe & 5-layer-compliant (non-negotiable):**

- The sink injects via `conversation.item.create` (`realtime_client.ts:1082-1117`), **never**
  `session.update` mid-meeting. Runtime results are Layer-3 FIFO items exactly as today.
- `response.create` fires **only** on a lease-open `proactive` result and only when the model is not
  mid-utterance — preserving the project's "never interrupt speech" invariant
  (`transcript-auditor.ts:1531` comment) while still closing the loop when it's safe.
- Optional side-work (silent summaries/validation) can use out-of-band `conversation:"none"`
  `[T3 developers.openai.com/realtime-conversations]` — not required for the core loop but available.
- The two-phase-ack filler already exists as silent `[WORKING]` / `[RESEARCH_STARTED]` injection
  (`voice.ts:473`, `transcript-auditor.ts:862`); keep it as the phase-1 ack (§7 open question: whether a
  *spoken* ack is worth breaking the silent-injection invariant for long-horizon dispatch only).

---

## 6. Comparison table

| Dimension | CallingClaw **today** | CallingClaw **proposed** | Codex desktop voice `[T2]` | SOTA best-practice `[T3]` |
|---|---|---|---|---|
| **Routing (inline vs dispatch)** | 3 distributed deciders, no shared taxonomy (`voice.ts` SLOW_TOOLS × `ai-tools.ts:56-60` × `transcript-auditor.ts:601-627`) | One `DispatchRouter`, taxonomy `inline/fast-local/long-horizon`, **no new model call** | GPT-Live per-frame talk/tool decision + app-level thread dispatch `[T2 S9,S11]` | Near-free classifier <20ms, manager keeps mic `[futureagi; openai.github.io]` |
| **Context handoff to worker** | bare string; no meeting state / correlation / return-addr (`transcript-auditor.ts:866-868`) | `SubagentTaskEnvelope`: objective+format+tools+boundaries+meetingState+ids | shares conversation context; Codex Remote brief `[T2 S10,S11]` | objective+format+tools+boundaries, self-contained, fresh isolated ctx `[anthropic; code.claude.com]` |
| **Hook-back (result→voice)** | 4 ad-hoc paths, 1 buggy (`transcript-auditor.ts:902`) | one sink `deliverDeliberateResult()`; every producer returns an envelope | narrate status/results by voice + notification `[T2 S5,S11]` | inject `conversation.item.create` + `response.create` `[developers.openai.com]` |
| **Staleness** | none (research can barge in late) | deterministic turn-lease `sourceTurnId` vs `userTurnId` + `maxAgeMs` | (not disclosed) | terminal-state + relevance gating `[tembo.io]` |
| **Error suppression** | research regex-sniffs its own errors only (`:878`) | producer-declared `error` → neutral note, never spoken; no success content-sniff | (not disclosed) | never speak a failure as fact (implied) |
| **Speaks autonomous results** | **No** — auditor actions silent (`voice-persona.ts:538` unset) | **Yes**, gated by turn-lease (fresh→speak, stale→silent) | Yes — background threads narrate completion `[T2 S5]` | give progress/completion a voice `[docs.livekit.io]` |
| **In-flight control** | abort only (`action-orchestrator.ts:152`) | abort now; Queue/Steer flagged as future (§7) | Queue vs Steer `[T2 S11]` | steer/queue for long tasks `[T2 S11]` |
| **Model tiers (in-meeting)** | Haiku classify + Haiku ComputerUse (latency-safe) | unchanged — Haiku-class only, no Opus on live path | GPT-Live + GPT-5.5 background `[T2 S9]` | cheap model for cheap work, capable for high-stakes `[code.claude.com]` |
| **Response gate** | two overlapping (`voice.ts:167`, `realtime_client.ts:927-944`) | one gate owned by the sink | (not disclosed) | single owner of the spoken turn `[openai.github.io]` |

---

## 7. Gap analysis + phased recommendation

The design decomposes cleanly onto PR #37 as the foundation. **Recommended path (not a menu):**

### Phase 0 — Land / rebase PR #37 (the foundation)

- **What changes:** rebase `feat/s1s2-robustness` (`62468c2`) onto HEAD and merge — brings
  `deliberate-result.ts` (new), `VoiceModule.deliverDeliberateResult()`, the deterministic turn-lease,
  the honest disposition enum, and PR #37's producer migrations for research/recall/retrieval; land the
  reliability watchdogs in **observe** mode (`S1S2_WATCHDOG_MODE=observe`) first.
- **Files:** `modules/deliberate-result.ts` (new), `modules/voice.ts`, `modules/transcript-auditor.ts`,
  `modules/context-retriever.ts`, `tool-definitions/ai-tools.ts`, plus the `userTurnId` counter in
  `voice.ts:222-239`.
- **Acceptance:** the phantom bug is gone (a research result completing while `audioState !== "listening"`
  no longer throws — repro against `transcript-auditor.ts:902`); research/recall/retrieval return through
  the sink; the scoped `tsc` gate (glob `src/modules/deliberate-*.ts`) is green; `auditor-intent-eval`
  and any `s1s2` tests pass; watchdogs log without enforcing.
- **Risk:** rebase conflicts — `main` moved (HEAD `b250e6d` merged `origin/main`) after `62468c2`
  diverged; the Japan-pricing/audio changes are unrelated so conflicts should be localized to
  `voice.ts` / `transcript-auditor.ts`. Mitigate by landing watchdogs in observe mode and gating the
  sink behind the existing tests before enabling enforce.

### Phase 1 — Context envelope + unified router

- **What changes:** add `SubagentTaskEnvelope` + `composePrompt` (§5b); extend
  `AgentAdapter.executeTask(instruction, envelope?)` and `ActionOrchestrator.submit(..., envelope?)`
  back-compatibly; add `modules/dispatch-router.ts` (§5a) and route the three deciders' outputs through
  it; thread the capped meeting-state slice into research/recall dispatch.
- **Files:** `agent-adapter.ts` + `adapters/*`, `modules/action-orchestrator.ts`,
  `modules/transcript-auditor.ts` (`:866` builds envelope), `tool-definitions/ai-tools.ts` (`:143`
  builds envelope), `modules/dispatch-router.ts` (new), `modules/subagent-envelope.ts` (new).
- **Acceptance:** the composed dispatch prompt now contains topic + recent transcript + prep refs +
  `correlationId` (assert by inspecting the string handed to `executeTask`); a router unit test over a
  labeled utterance set (reuse the `auditor-intent-eval` harness) classifies `inline/fast-local/
  long-horizon` at ≥ today's auditor accuracy; **no new model call on the hot path** (latency trace
  unchanged; router overhead within `<20ms/≤5%` `[T3 futureagi]`).
- **Risk:** envelope bloat inflating dispatch cost/latency — mitigate with hard caps on the meeting-state
  slice and keeping the envelope optional (absent = today's behavior).

### Phase 2 — Full bidirectional hook

- **What changes:** migrate the action producers (auditor actions, `computer_action` tool,
  `notifyTaskCompletion`) to return `DeliberateResult{kind:"action", speak:"proactive"}` (§5c #4);
  wire `ActionOrchestrator.task.completed → sink` (§5c #5); add the `DeliberateDispatcher` cross-source
  coalescing (§5c #6); collapse the dual response gates into the sink (§5c #7); flip watchdogs to
  **enforce** once observe-mode telemetry is clean.
- **Files:** `callingclaw.ts` (`:928` `task.completed`→sink; `:917-935` lifecycle wiring),
  `modules/transcript-auditor.ts` (`:1498-1533`), `tool-definitions/automation-tools.ts` (`:244-248`),
  `src/voice-persona.ts` (`notifyTaskCompletion` → producer of an envelope),
  `modules/voice.ts` (`:167` gate) + `ai_gateway/realtime_client.ts` (`:927-944` gate), new
  `modules/deliberate-dispatcher.ts`.
- **Acceptance:** an autonomous auditor action whose triggering turn is still open produces a **spoken**
  one-line result (no longer silent); a voice-recall + auditor-research for the same question **speaks
  once** (coalesced); a failed dispatch is **never** spoken as fact (`error-suppressed` disposition
  observed); exactly one response gate remains (grep shows result-speech routes only through the sink);
  the "never interrupt speech" invariant holds (proactive fires only on lease-open + not-speaking).
- **Risk:** chattiness from newly-speaking autonomous actions — mitigate with the turn-lease
  (`speakWithinTurns: 1`) and a per-`kind` speak policy (actions default proactive-but-lease-gated;
  low-signal clicks can be set `silent`). Regression of the silent-injection invariant — mitigate by
  gating `response.create` on `audioState !== "speaking"` in the sink.

### Open questions for the user

1. **Autonomous action chattiness.** Should *every* auditor action (incl. a small click/scroll) speak
   when the lease is open, or only "user-visible-significant" actions (share/navigate/open)? Recommend
   per-`kind` policy, default the small ones to `silent`.
2. **Spoken two-phase ack.** SOTA favors a spoken "on it" before long-horizon dispatch
   `[T3 huggingface.co]`, but the project deliberately chose *silent* injection to never interrupt
   speech (`voice.ts:471` "方向A"). Break that for long-horizon dispatch only, or keep silent?
3. **Rebase vs cherry-pick PR #37.** Given `main` moved (`b250e6d`), rebase the whole branch or
   cherry-pick just `deliberate-result.ts` + the sink + `userTurnId` and re-derive the producer
   migrations here? Recommend rebase (keeps the reliability layer + tests).
4. **In-flight control parity with Codex.** Do we want Queue/Steer for long-horizon tasks
   `[T2 S11]`, or is abort-and-resubmit (`action-orchestrator.ts:152`) sufficient for meetings?
5. **Per-`kind` model/effort in the envelope.** Expose `tools`/model tier per dispatch now (T3 §D7) or
   defer until off-meeting escalation is in scope? (In-meeting stays Haiku-class regardless.)

---

## 8. Sources

**Codebase claims** trace to T1 (`scratchpad/research/T1-callingclaw-current-state.md`) — every
`file:line` above was opened directly for this doc or is a verified T1 reference; the critical-framing
findings (PR #37 unmerged, `userTurnId` absent, `queuePendingResponse` phantom) were **independently
re-confirmed** here via `git merge-base --is-ancestor 62468c2 HEAD` (false) and grep (zero
definitions). PR #37's contract read from `62468c2:callingclaw-backend/src/modules/deliberate-result.ts`.

**Codex desktop voice mode (T2)** — full source list S1–S13 in
`scratchpad/research/T2-codex-voice-mode.md`. Key:
- S1 OpenAI (X) announcement · S6 OpenAI changelog "ChatGPT Voice and multi-folder projects 26.715"
  (2026-07-23) · S5 OpenAI docs "ChatGPT Voice" (https://learn.chatgpt.com/docs/features/voice)
- S9 MarkTechPost "GPT-Live … delegate deeper reasoning to GPT-5.5" ·
  S10 DeepLearning.ai The Batch "One model talks, another one thinks"
- S11 OpenAI Developers "Mastering remote engineering work from your phone" (Codex Remote control-plane,
  Queue vs Steer, completion notifications) · S2 Fortune · S3 9to5Mac · S7 TestingCatalog (pre-release)

**Industry SOTA (T3)** — full URL list in `scratchpad/research/T3-industry-sota.md` §E. Key:
- Routing: https://futureagi.com/blog/how-to-optimize-voice-agent-latency-2026/ ·
  https://openai.github.io/openai-agents-python/multi_agent/ ·
  https://www.anthropic.com/engineering/built-multi-agent-research-system ·
  https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them
- Context contract: https://code.claude.com/docs/en/agent-sdk/subagents ·
  https://www.anthropic.com/engineering/built-multi-agent-research-system
- Hook-back: https://developers.openai.com/api/docs/guides/realtime-conversations ·
  https://openai.com/index/introducing-gpt-realtime/ ·
  https://docs.livekit.io/agents/build/external-data/ ·
  https://docs.pipecat.ai/pipecat/learn/function-calling ·
  https://docs.vapi.ai/tools/custom-tools-troubleshooting ·
  https://www.tembo.io/blog/background-coding-agents ·
  https://huggingface.co/blog/dvalle08/voice-agent-latency-playbook
