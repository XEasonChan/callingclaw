# CallingClaw Architecture Optimization Plan

> Full-codebase audit (2026-06-11): 4 parallel deep-dives over voice core, the
> voice↔computer-use coordination path (手口协同), the auto-research pipeline,
> and meeting lifecycle orchestration. ~50 concrete bugs found with file:line
> evidence, then a target architecture derived from the failure patterns.

---

## Part 1 — Why 手口协同 feels broken (root-cause diagnosis)

The coordination problem is **not** one bug. It is a structural property of the
current design:

### 1.1 Four "hands", zero shared state

The same utterance ("打开那个文件") can be acted on by four independent actors
with wildly different latency and feedback behavior:

| Actor | Path | Latency | Does the AI narrate it? |
|---|---|---|---|
| Realtime model's own `open_file` tool | voice.ts slow-tool path | 1–3s | Yes (`response.create` after `[DONE]`) |
| TranscriptAuditor fast lane (regex ≥0.95) | ChromeLauncher direct | <500ms | **No** (injection only, no `response.create`) |
| TranscriptAuditor medium lane (Haiku) | AutomationRouter | ~3s | **No** |
| `computer_action` → router → ComputerUse loop | Anthropic multi-step | 10s–2min | Sometimes (response.create can be dropped) |

Dedup between them is a 5-second cooldown plus string keys that **can never
match** (`realtime:open_file:{...}` vs `open_file:{...}` — transcript-auditor.ts:120 vs :292).
Result: actions feel random — sometimes narrated, sometimes silent, sometimes
double-executed.

### 1.2 The mouth lies about the hand

- Slow tools submit `function_call_output = "ok"` **before execution starts**
  (voice.ts:346). The model's authoritative channel says "success" at t=0; the
  real result arrives later as a low-salience system item **truncated to 200
  chars** (voice.ts:364) — which destroys `open_file`'s retry-candidate list.
- AutomationRouter returns `"Opened X"` with `success:true` even when
  `open -a X` failed (`.nothrow()`, no exit-code check — automation-router.ts:377-387),
  and never gates on its own confidence score. The voice AI then confidently
  says "已经打开了" for an action that did nothing.

### 1.3 The hand is invisible while running and unstoppable

- During a multi-step ComputerUse loop, `emitActivity()` goes to the UI feed
  only. **Nothing** reaches the voice session — there is no `activeTask` field
  in SharedContext. The AI cannot answer "你在干嘛?" mid-action.
- `ComputerUseModule.cancel()` has **zero call sites**. Voice interruption sends
  `response.cancel` (stops the mouth) but never aborts the hand. The abandoned
  task later resolves and fires an unguarded `response.create` — the AI starts
  talking over the user about a task they cancelled.

### 1.4 The mouth's own pipe is unreliable

Three independent emitters fire `response.create` with no serialization
(filler path voice.ts:354, completion path voice.ts:375, submitToolResult
realtime_client.ts:876, presentSlide voice.ts:583). When two collide, OpenAI
rejects with `conversation_already_has_active_response`, the error is only
logged, and **the tool result is never spoken**. This is the single biggest
source of "did the action, said nothing".

### 1.5 The brain (auto-research) arrives too late and gets evicted

- Trigger→inject latency is typically **6–13s** (debounce 2s + L1 classify +
  L2 infer + agentic search ≤15s); no `response.create` follows injection, so
  retrieved context only helps the *next* turn — by then the AI already said
  "I'm not sure".
- Layer 3 FIFO is **15 items, not 3000 tokens** (realtime_client.ts:326), and
  raw screenshots injected every 5s share the same queue → useful retrieved
  context is evicted within ~75 seconds by screenshot spam.

---

## Part 2 — Bug inventory (file:line verified)

### P0 — broken core functionality

| # | Bug | Location |
|---|---|---|
| P0-1 | Meeting-time ComputerUse sends OpenRouter slug `anthropic/claude-haiku-4-5` to the direct Anthropic API → **every meeting-time L4 call fails instantly** | computer-use.ts:316-319 + config.ts:132-134 |
| P0-2 | `isMeeting = transcript.length > 0` but transcript is never cleared on `meeting.ended` → after first utterance, the meeting model (and P0-1) applies **forever**, Haiku/Sonnet split never toggles back | computer-use.ts:316, callingclaw.ts:352 |
| P0-3 | AutomationRouter: false success on `open_app`/`open_url` (`.nothrow()`, no exit check) + `intent.confidence` computed but **never read** in `execute()` → 0.4-confidence catch-all executes, fails silently, blocks ComputerUse fallback | automation-router.ts:377-387, :105, :255-325 |
| P0-4 | `callModel({model, system, prompt,...})` called with an object; signature is `callModel(prompt: string, opts)` → throws every time. Kills DOM-aware click resolution AND STT alias generation. **tsc-confirmed** | transcript-auditor.ts:515, skills/meeting-prep.ts:230, llm-client.ts:17 |
| P0-5 | Vision fallback `catch` references try-scoped consts → `ReferenceError` whenever primary vision call fails. **tsc-confirmed** | vision.ts:309,314 vs :248,272 |
| P0-6 | Failed join still arms `onMeetingEnd` → "ended" detected in seconds → generateSummary + Telegram delivery + **stops the voice session**, possibly marking a *different* live session ended (`active[0]`) | config_server.ts:1789-1857, chrome-launcher.ts:996-1019 |

### P1 — coordination & reliability

| # | Bug | Location |
|---|---|---|
| P1-1 | `response.create` collisions: filler vs completion vs submitToolResult vs presentSlide, no serialization, no retry → tool results silently never spoken | voice.ts:354/375/583, realtime_client.ts:876-885 |
| P1-2 | `join_meeting` (20-60s), `leave_meeting`, `search_files` missing from `SLOW_TOOLS` → awaited inline, **no filler, pure dead silence** for the product's longest operations | voice.ts:22-33, meeting-tools.ts:163-441 |
| P1-3 | Slow-tool results truncated to 200 chars before reaching the model (breaks `open_file` retry loop; real output already replaced by `"ok"`) | voice.ts:364, :346 |
| P1-4 | No cancellation wiring: `ComputerUseModule.cancel()` and `BrowserActionLoop.abort()` unreachable from voice; late results fire unguarded `response.create` | computer-use.ts:663, voice.ts:375 |
| P1-5 | `_running` flag never reset on early returns, shared across concurrent runs → two overlapping ComputerUse loops kill each other | computer-use.ts:310,:498,:523,:656 |
| P1-6 | OpenCLI layer never wired (`automationRouter` constructed without 5th param; `OpenCLIBridge` never instantiated) + fallback chain descends only ONE level → "check GitHub issues"-class patterns route to a layer that always throws, then stop | callingclaw.ts:761, automation-router.ts:294-320,:639-641 |
| P1-7 | Auditor-executed actions never trigger speech: `notifyTaskCompletion` → injectContext only, no `response.create` → user stares at a changed screen, silent assistant | voice-persona.ts:236-295, transcript-auditor.ts |
| P1-8 | `interact`/`exec` have handlers but **no tool definitions**; meeting-tools.ts:647 tells the model "Use interact/scroll to navigate" — a tool it doesn't have. Core of "AI presents but can't navigate" | automation-tools.ts:336,:363, tool-definitions/index.ts:44-49 |
| P1-9 | Search filler sent via `voice.sendText()` as a **user** message → model replies to it, AND it re-enters both Haiku pipelines (auditor can act on the system's own filler) | callingclaw.ts:813-822, voice.ts:564, realtime_client.ts:1115 |
| P1-10 | No socket-identity guard in WS close handlers → stale socket's close corrupts live connection, double-reconnect; Gemini wrapper invokes the NEW connection's onclose from the OLD socket | realtime_client.ts:604-617, :517-520 |
| P1-11 | Gemini adapter never emits `response.created` → heard-ratio counters never reset (interruption truncation never fires), "thinking" unreachable, `waitForSpeechDone` broken for slides | gemini-adapter.ts:140-219, voice.ts:215-222 |
| P1-12 | Gemini assistant transcript flush only handles top-level `outputTranscription`; nested (real) shape never flushes → assistant turns missing from SharedContext, `_transcriptBuffer` grows forever | gemini-adapter.ts:189-194,:511-516, voice.ts:278-297 |
| P1-13 | Gemini re-greets ("introduce yourself") after **every** reconnect/15-min resume | realtime_client.ts:655-668 |
| P1-14 | `disconnect()` clears neither `_geminiSessionHandle` nor `_contextQueue` → next meeting resumes the previous meeting's session and replays its context | realtime_client.ts:1126-1134, :551-554, :1071-1085 |
| P1-15 | LiveNote TTL eviction splices the array while `pushContextUpdate` tracks an array **index** → after 5-min TTL fires, new notes silently stop reaching the voice model | voice-persona.ts:215,:249-262, meeting-prep.ts:293-316 |
| P1-16 | Dead guard `includes("MEETING PREP BRIEF")` always passes (string no longer in instructions since 5-layer refactor) → MEMORY.md poll + contextSync fire **`session.update` mid-meeting** = the documented audio-break violation | callingclaw.ts:237,:255, voice-persona.ts:80-82 |
| P1-17 | `context.on("transcript", ...)` registered per-meeting, never removed → N duplicate timeline entries after N meetings + listener leak (found independently by two auditors) | callingclaw.ts:358-360 |
| P1-18 | 3-hour vision safety timer never cleared on meeting end → kills the **next** meeting's vision mid-call | callingclaw.ts:405-410 |
| P1-19 | `autoLeaveMeeting()` emits `meeting.ended` before its own finalize → double `keyFrameStore.finalize()` + double `processTimeline` dispatch | callingclaw.ts:658,:666-697,:533-557 |
| P1-20 | HTTP join marks session `active` before joining, no rollback on failure → permanently stuck active session; `talk-locally` and end-handlers then hijack `active[0]` | config_server.ts:1538,:2635 |
| P1-21 | Voice-tool `leave_meeting` / `autoLeaveMeeting` never `markEnded` and never stop ChromeLauncher's admission interval → 3s loop keeps clicking "Admit/准许" on whatever page Chrome shows next | meeting-tools.ts:471-545, chrome-launcher.ts:1031-1040 |
| P1-22 | No SIGTERM handler; SIGINT doesn't await `chromeLauncher.close()` before `process.exit(0)` → orphan Chrome with locked profile | callingclaw.ts:1024,:1046-1053 |
| P1-23 | No Chrome crash/disconnect detection mid-meeting → voice/recording/vision become zombies; end detection can never fire | chrome-launcher.ts:493-541,:918 |
| P1-24 | Meeting-end detector false-positives in the waiting room (lobby has no leave button / call controls / video grid); `'Rejoin'` substring-matches page text | chrome-launcher.ts:1010,:1014-1015 |

### P2 — worth fixing during the refactor (selected)

- `semanticSearch` discards prep-brief results in the mixed branch (`[...[], ...agenticResults]` — context-retriever.ts:603).
- No timeout on `callModel` fetch → hung OpenRouter socket freezes auditor+retriever for the rest of the meeting (llm-client.ts:26-41).
- Question triggers silently dropped by the 20s min-interval gate, no deferred re-arm (context-retriever.ts:227-228).
- Auditor/retriever activation requires `voice.connected` at the exact instant of `meeting.started`; no late-activation path (callingclaw.ts:386-402).
- `KeyFrameStore.appendJsonl` is a silent no-op (`Bun.write` `{mode:"append"}` throws sync) → timeline.jsonl never written → frame-dir cleanup never runs → unbounded disk growth (key-frame-store.ts:356-359, :397).
- Reconnect replays `[Tool Call]`/`[HEARD]` system entries as **user** messages (realtime_client.ts:1099-1110).
- Tool-arg JSON parse failure → executes with `{}` instead of submitting an error result; no duplicate call_id guard (voice.ts:303-307).
- `input_audio_buffer.commit` sent on every barge-in under server VAD → noise errors (voice.ts:190).
- `session-manager.ts:207` `existing.size()` is a property not a method (guard dead); `findOrCreate` topic persist is a no-op (:148-150); sessions.json has two writer modules + fire-and-forget async writes.
- Scheduler dedup checks `status === "pending"` which doesn't exist in `SESSION_STATUS` (meeting-scheduler.ts:183-185).
- `/api/meeting/export` emits `meeting.ended` → tears down a live meeting (config_server.ts:1459-1463).
- `meeting.prep_ready` emits `filePath`, MCP plugin documents `filepath` (callingclaw.ts:172-179 vs plugins/callingclaw-events/index.ts:67).
- Hardcoded `localhost:4000` in scheduler auto-join + injected audio pipeline breaks if PORT changes (callingclaw.ts:133, chrome-launcher.ts:112).
- EventBus webhook fetch has no timeout; WS sends ignore backpressure return codes (event-bus.ts:187,:127-133).
- **Zero auth** on the control API, CORS `*`, 0.0.0.0 bind — anyone on the LAN can make the machine join a meeting with mic on (config_server.ts:260-261,:507-512).
- `presentationMode` await-sync design is dead code — nothing ever sets it (voice.ts:97-101,:324).
- Gemini image caption dropped (gemini-adapter.ts:421-428); `toolCallCancellation` events emitted but no listener.
- `take_screenshot` and ComputerUse both use `bridge.once("screenshot")` → wrong-image delivery under concurrency.
- Three parallel screen channels (Gemini `[Screen]` entries + raw screenshots/5s + DOM `[SCREEN]`/10s) flood Layer 3.

---

## Part 3 — Target architecture

Design principle: **one mouth, one hand, one ledger.** Every action flows
through a single serialized executor with a visible task record; every spoken
turn flows through a single response gate. The mouth always knows what the
hand is doing, and the hand can always be stopped by the mouth's interruption.

```
                       ┌────────────────────────────────────────┐
                       │            VoiceModule (mouth)          │
                       │  state: idle/listening/thinking/        │
                       │         speaking/acting                 │
                       │  ┌──────────────┐                       │
  Realtime events ────▶│  │ ResponseGate │◀── narration requests │
                       │  └──────────────┘                       │
                       └───────┬───────────────────▲─────────────┘
                    tool calls │                   │ task.started/progress/
                    (intents)  ▼                   │ completed/failed
                       ┌────────────────────────────────────────┐
                       │        ActionOrchestrator (hand)        │
                       │  TaskLedger: {id, source, instruction,  │
                       │   state, steps[], startedAt, abort}     │
                       │  - single FIFO queue (1 active task)    │
                       │  - AbortSignal threaded to every layer  │
                       │  - confidence-gated layer routing       │
                       │  - honest results (exit codes checked)  │
                       └───────┬────────────────────────────────┘
                               ▼
                shortcuts │ playwright(ChromeLauncher) │ peekaboo │ ComputerUse
                               │
                       ┌───────▼────────────────────────────────┐
                       │   SharedContext.activeTask (visible    │
                       │   to voice Layer 3 + auditor + UI)     │
                       └────────────────────────────────────────┘
```

### 3.1 ActionOrchestrator — the single hand

New module (`modules/action-orchestrator.ts`), absorbing the execution entry
points of AutomationRouter / ComputerUseModule / BrowserActionLoop / auditor
fast-lane. `BrowserActionLoop` is the template — it already has the right
shape (abortable, step callbacks, deadline).

**Task model:**

```ts
interface Task {
  id: string;                       // ULID
  source: "voice" | "auditor" | "http" | "agent";
  callId?: string;                  // realtime function_call id, if voice-originated
  instruction: string;
  layer: "shortcuts" | "playwright" | "peekaboo" | "computer-use";
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  steps: { ts: number; desc: string }[];   // progress narration source
  startedAt: number;
  abort: AbortController;
  result?: string;                  // FULL result, no truncation
}
```

**Rules:**

1. **One active task.** New tasks queue; a duplicate (same normalized
   instruction within 10s, regardless of source) is coalesced into the running
   task — this replaces the broken string-key dedup and makes the
   four-actors problem structurally impossible.
2. **AbortSignal threaded everywhere.** Every layer's execute receives
   `task.abort.signal`; ComputerUse loop checks it between steps; Playwright
   calls pass it as timeout context; `Bun.$` subprocesses get killed.
3. **Honest results.** Exit codes checked (`open -a`), confidence gated
   (`< 0.6` → escalate to ComputerUse instead of executing the regex guess),
   fallback chain loops until a layer succeeds or all are exhausted.
4. **Progress heartbeat.** While `state === "running"` and elapsed > 4s, emit
   `task.progress` every ~6s with the latest step description. Whether that
   becomes speech is the NarrationPolicy's call (3.3).
5. **Ledger in SharedContext.** `context.activeTask` is set/cleared by the
   orchestrator only. The voice Layer-3 context renders it as one line:
   `[ACTING] opening Q3 budget spreadsheet (step 3: clicked Finder search)…` —
   so the model can answer "你在干嘛" and knows to keep responses short.

### 3.2 ResponseGate — the single mouth valve

Tiny state machine inside VoiceModule wrapping every `response.create`:

```ts
class ResponseGate {
  private active = false;            // set on response.created, cleared on response.done
  private pending: NarrationRequest[] = [];
  request(r: NarrationRequest)       // priority: user-reply > task-result > task-progress > context-hint
  // - if active: queue (coalesce same-task progress; drop superseded)
  // - on response.done: flush highest-priority pending
  // - on provider error "active response": re-queue with backoff (never silently drop)
  // - on user speech_started: clear task-progress entries, keep task-result
}
```

This single change fixes P1-1 (swallowed results), P1-7 (silent auditor
actions — they now `gate.request({type:"task-result"})`), the filler/completion
collision, and presentSlide stomping.

### 3.3 The honest async-tool protocol (voice ↔ orchestrator)

Replace the `"ok"`-then-truncated-DONE pattern:

1. Voice receives `function_call_arguments.done` → classifies *dynamically*:
   dispatch to orchestrator, race 1.5s. If done in <1.5s → submit the **real**
   result as `function_call_output` (fast path, no filler needed).
2. Otherwise submit `function_call_output = {"status":"started","task_id":"…"}`
   (truthful: started, not succeeded) + `gate.request(filler)` — filler is a
   **system-role instruction item**, never `sendText` user message (fixes
   P1-9 / pipeline self-trigger).
3. On `task.completed`: inject `[TASK ${id} DONE] ${fullResult}` (no 200-char
   cap; cap at ~1500 chars with "…truncated" marker) + screenshot for
   screen-mutating layers (**awaited**, ComputerUse included in VISUAL_TOOLS) +
   `gate.request(task-result)`.
4. On interruption (`speech_started` while `activeTask` running): auditor
   fast-classifies stop-intent locally (regex "stop/别/算了/cancel" — no LLM
   needed for the fast path); if stop → `task.abort.abort()` →
   `task.cancelled` → inject `[TASK CANCELLED]`, **no** response.create.
5. SLOW_TOOLS list dies; the 1.5s race replaces it. `join_meeting` /
   `leave_meeting` automatically get filler coverage (fixes P1-2).

### 3.4 Perception consolidation (one eye, token-budgeted memory)

- **One screen channel.** Replace the three parallel feeds (Gemini `[Screen]`
  transcript entries + raw screenshot every 5s + DOM text every 10s) with a
  single `ScreenContext` producer: DOM-text snapshot (cheap, 10s cadence) as
  the default; raw screenshot injected **only** on events (post-action
  feedback, vision detects major change, user asks about the screen).
- **Token-budgeted Layer 3.** Replace the 15-item FIFO with a token budget
  (~3000 as documented), images counted at fixed cost or held in a separate
  2-slot image queue. Retrieved `[CONTEXT]` items get higher retention
  weight than screen snapshots.
- **Research that arrives in time, or speaks late.** When the retriever's
  trigger was a *user question* and injection lands after the model already
  answered, issue `gate.request({type:"context-hint", speak:true})` with an
  instruction item: "You now have the answer to the earlier question about X —
  offer it briefly." (One-turn self-correction instead of wasted retrieval.)
- **Supersede primitive.** New analysis cancels the in-flight one
  (AbortSignal on `callModel` — which also finally gets a 10s timeout);
  cache hits dedup before re-injecting identical liveNotes.
- Unify the three retrieval stacks: `recall_context` becomes a thin pull-API
  over ContextRetriever (shared topic cache, shared scoring), FileAliasIndex
  stays as the one file-resolution path.

### 3.5 Meeting lifecycle FSM (one join, one leave)

Single `MeetingLifecycle` owner (extracted from the 3 join / 4 teardown
copies):

```
scheduled → joining → waiting_room → in_meeting → leaving → ended
                 ↘ failed (rollback: session, monitors, correlation)
```

- `endMeeting(meetingId, reason)` is the **only** teardown path; all callers
  (HTTP leave, voice tool, auto-leave detector, export must NOT) route through
  it. It owns: stop admission monitor, clear end-detector, voice stop,
  keyFrameStore finalize (once), summary gate (skip if transcript empty or
  state never reached `in_meeting`), `markEnded(meetingId)` (never `active[0]`),
  clear 3h timer, end correlation.
- End-detector armed **only** on entering `in_meeting`, requires 2–3
  consecutive `ended` ticks, knows the waiting-room DOM shape (fixes P0-6,
  P1-24).
- Chrome `context.on("close")` → `chrome.disconnected` event → routed into
  `endMeeting(id, "chrome-crashed")` (fixes P1-23).
- Concurrency guard: a join while `state ∈ {joining…in_meeting}` is rejected
  with a spoken explanation (today it silently navigates the tab away).
- SIGTERM = SIGINT handler; both `await chromeLauncher.close()` before exit.

### 3.6 Engineering guardrails

- **`bunx tsc --noEmit` in CI** — it already catches P0-4 and P0-5 today.
- Socket-identity guard pattern (`const sock = this.ws; if (sock !== this.ws) return`)
  in every WS handler; `disconnect()` clears resume handle + context queue.
- `AbortSignal.timeout` on every outbound fetch (llm-client, webhooks, vision).
- Listener hygiene: module-lifetime listeners registered once at startup;
  meeting-scoped listeners must store and call their unsubscribe in
  `endMeeting`.
- Localhost auth token on the control API (or at minimum bind 127.0.0.1) —
  currently anyone on the LAN can join the machine into a meeting hot-mic.

---

## Part 4 — Phased execution plan

### Phase 0 — Stop the bleeding (≈1–2 days, no architecture change)

All one-to-five-line fixes, immediately user-visible:

1. Strip `anthropic/` prefix when `_mode === "anthropic"` (P0-1).
2. Explicit `inMeeting` flag set by meeting.started/ended; drop the transcript
   heuristic (P0-2).
3. Check `open -a` exit code; gate router execution on `confidence >= 0.6`
   (P0-3).
4. Fix the two `callModel({...})` call sites; add `tsc --noEmit` to CI (P0-4).
5. Hoist `systemPrompt`/`userText` above the `try` in vision.ts (P0-5).
6. Arm `onMeetingEnd` only when `joinState === "in_meeting"`; require 3
   consecutive ended ticks (P0-6, P1-24).
7. Add `join_meeting`/`leave_meeting`/`search_files` to SLOW_TOOLS (interim,
   until 3.3 lands) (P1-2).
8. Raise `[DONE]` truncation to 1500 chars (P1-3).
9. Guard the completion `response.create` with audio-state check + retry on
   active-response error (interim ResponseGate) (P1-1).
10. `response.create` after auditor `notifyTaskCompletion` (P1-7).
11. Filler via system-role injection, not `sendText` (P1-9).
12. Add `interact`/`exec` tool definitions (handlers exist) (P1-8).
13. Socket-identity guards; clear `_geminiSessionHandle`/`_contextQueue` in
    `disconnect()`; greeting-once flag (P1-10/13/14).
14. Emit `response.created` from Gemini adapter on first modelTurn; flush
    `_transcriptBuffer` on `response.done` (P1-11/12).
15. Hoist the per-meeting transcript listener; clear the 3h timer on end;
    move `meeting.ended` emit after finalize in autoLeave (P1-17/18/19).
16. SIGTERM handler + awaited Chrome close (P1-22).
17. `markActive` only after in_meeting; thread `meetingId` into end handlers
    instead of `active[0]` (P1-20, partial).
18. 10s timeout on `callModel`; fix `[...prepResults, ...agenticResults]`;
    fix liveNote index→identity tracking; delete the dead "MEETING PREP BRIEF"
    guard (P2 batch + P1-15/16).

### Phase 1 — 手口协同 core (≈1 week): ActionOrchestrator + ResponseGate

- Build TaskLedger + orchestrator queue; migrate `computer_action` /
  `browser_action` / auditor lanes onto it.
- ResponseGate replaces all direct `response.create` call sites.
- Honest async-tool protocol (1.5s race, truthful outputs, awaited screenshot
  feedback, `computer_action` in VISUAL_TOOLS).
- Interruption → stop-intent → task abort wiring.
- `SharedContext.activeTask` + `[ACTING]` Layer-3 line + progress heartbeat.
- Either wire OpenCLIBridge properly or delete the layer + command-gen
  (recommend: delete; ChromeLauncher's Playwright already covers it) (P1-6).

**Acceptance scenario:** "帮我打开 Q3 budget 然后分享屏幕" → AI acknowledges
within 1s, narrates progress at ~6s, user says "等等算了" → action halts within
one step, AI confirms cancellation, no ghost narration afterward.

### Phase 2 — Perception & research (≈1 week)

- Token-budgeted Layer 3, single ScreenContext channel, image slots.
- Retriever supersede/cancel, late-answer speak-back, unified recall stack.
- Keyframe store append fix + disk cleanup revival.

**Acceptance scenario:** user asks "我们上次跟他们报的价格是多少?" → retrieval
lands ≤8s; if the AI already said "let me check", it follows up with the
number unprompted; the injected context survives ≥5 minutes of screen updates.

### Phase 3 — Lifecycle FSM (≈1 week)

- `MeetingLifecycle` + single `endMeeting()`; migrate all four teardown paths
  and three join paths.
- Chrome crash detection; session-manager write serialization (single writer,
  awaited saves); scheduler status-set fix + join retry-once.
- Control-API auth token.

**Acceptance scenario:** kill Chrome mid-meeting → backend detects within 5s,
tears down voice/vision/recording, marks the correct session ended, delivers a
summary flagged "meeting interrupted"; a failed join produces zero summary,
zero Telegram message, and a clean retryable session state.

---

## Part 5 — What NOT to build (scope discipline)

- **No new orchestration framework.** ActionOrchestrator is ~300 lines around
  the existing layers; BrowserActionLoop already proves the pattern in-repo.
- **Don't parallelize the hand.** One active task is a feature: a meeting
  copilot doing two screen actions at once is indistinguishable from chaos.
- **Don't move auto-research to a bigger model.** The latency problem is
  pipeline shape (debounce + serial L1/L2 + no speak-back), not model IQ.
- **Keep the auditor's fast lane** — regex <500ms is the right tier — but it
  must submit tasks to the orchestrator instead of executing directly.
