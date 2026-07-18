# S1 ↔ S2 Conversation Architecture — Robustness & Unification Plan

Status: DRAFT for cross-review (codex) → implementation
Owner: principal architect synthesis of 4 robustness audits
Scope: `callingclaw-backend/` — the live voice loop (System 1) and its deliberate backend (System 2)
Constraint: this touches the LIVE, latency-sensitive, in-meeting voice path. Every change is judged first on "can it make the AI go silent, mute, or wrong in a real meeting."

All code anchors below were re-read against the worktree at synthesis time. Line numbers are stable references, not guarantees post-edit.

---

## 0. Section outline

1. Problem statement & the keystone
2. Ground-truth map: the five divergent S2 return paths (current)
3. The P0 blocker, dissected (why the AI lies about a result it actually has)
4. Target architecture — the unified S2-result contract
   - 4.1 The `DeliberateResult` envelope (verbatim)
   - 4.2 The `deliverDeliberateResult()` sink (verbatim signature + responsibilities)
   - 4.3 The shared staleness/relevance guard
   - 4.4 Producers: research_task, recall_context, ContextRetriever, action-completion
   - 4.5 Proof: a 3rd deliberate capability needs zero new return plumbing
5. The reliability layer (watchdog, timeouts, reconnect supervisor, liveness)
6. Decoupling S2 escalation from OpenClaw
7. Config centralization (`CONFIG.conversation` + profiles) — the generality fix
8. Cross-meeting isolation fix
9. Generality: pluggable tool-classification + context-provider
10. Concurrency & correlation fixes
11. Phasing (P0 / P1 / P2 / P3) with files, risk, verification
12. Risk & rollout (flags, dogfood vs unit, scoped tsc gate)
13. What we are deliberately NOT doing this cycle
14. Top 3 design risks for cross-review
15. Appendix: file:line anchor index

---

## 1. Problem statement & the keystone

CallingClaw's cognition is a two-system loop:

- **System 1 (S1)** — fast, reactive, real-time. The Realtime voice model (`ai_gateway/realtime_client.ts`, `modules/voice.ts`) plus two Haiku helpers that ride the transcript: `TranscriptAuditor` (intent classify + regex fast-lanes, `modules/transcript-auditor.ts`) and `ContextRetriever` (gap detection + retrieval, `modules/context-retriever.ts`).
- **System 2 (S2)** — slow, deliberate. `agentAdapter.executeTask()` (web/deep research), `recall_context` → `openclaw-dispatcher.ts` / `openclaw_bridge.ts` / adapters, and ComputerUse/automation completions.

S2 always produces a result that must re-enter the S1 voice conversation. **There is no contract for how it does so.** Five independent, ad-hoc paths have grown, each with different injection layer, prefix, speech-trigger, dedup, and staleness policy. This structural gap is the root cause of the most damaging bugs (a shipped `TypeError` that makes the AI announce failure while holding the answer; late answers spoken into dead air; results stranded in Layer 3 unspoken).

**The keystone of this plan is a single unified S2-result contract:** one envelope type and one gated sink on `VoiceModule`. Every S2 capability becomes a *producer* of that envelope; the sink owns — in one place — the injection-layer choice, the gated response trigger, and a shared staleness guard. Everything else (reliability layer, OpenClaw decoupling, config, isolation, generality) is either a prerequisite for shipping the contract safely, or a generality cleanup that the contract makes tractable.

Four themes, in priority order:

- **P0 — Reliability floor.** A shipped blocker + four missing liveness mechanisms mean the loop can silently die mid-meeting (mute AI, dead lane, dead voice socket, cross-meeting bleed). Ship-broken today.
- **P1 — The unified contract.** The structural keystone. Collapses five paths to one.
- **P2 — Config & generality.** ~30 hardcoded magic numbers; S1/S2 welded to the meeting scenario; dual response-gate; correlation bugs.
- **P3 — Nice-to-haves.** EventBus durability, Gemini resume symmetry, full cross-source coalescing.

---

## 2. Ground-truth map: the five divergent S2 return paths (current)

| # | Producer | Return mechanism (file:line) | Injection layer | Speech trigger | Staleness | Dedup |
|---|----------|------------------------------|-----------------|----------------|-----------|-------|
| 1 | `research_task` (auditor) | `voice.replaceContext("[RESEARCH] …", "ctx_research_result")` then a hand-rolled `if listening → sendEvent("response.create") else client.queuePendingResponse()` — `transcript-auditor.ts:664-673` | Fixed-id (singleton) | Conditional, **broken** | none | fixed id `ctx_research_result` (2nd research clobbers 1st) |
| 2 | `recall_context` (voice tool) | SLOW_TOOL path: `injectContext("[DONE] recall_context: …")` + `_requestResponse({})` — `voice.ts:466-505` | FIFO | Always (gated `_requestResponse`) | none | orchestrator/`_activeResearch` (partial) |
| 3 | Automation/ComputerUse completion | `notifyTaskCompletion(voice, prepSkill, …)` → live note + push — `transcript-auditor.ts:500,1325`, `automation-tools.ts:247`, `voice-persona.ts:524` | Live note (Layer 2/3) | Silent (方向A) | live-note TTL |
| 4 | `ContextRetriever` retrieval | `speakWithInstruction(...)` when `answeredQuestion`, else `injectContext("[CONTEXT_HINT] …")` — `context-retriever.ts:1162-1198` | FIFO + liveNotes | `speakWithInstruction` (has the ONLY soft staleness guard) | soft prompt guard | topic cache |
| 5 | Deep/thorough recall fallback | `[Recall via …]` / `[OpenClaw recall]` strings returned to tool handler — `ai-tools.ts:113-152` | via #2's `[DONE]` | via #2 | none | none |

Consequences that fall directly out of this table:
- Inconsistent layer: #1 pins a fixed id (only-latest), #2/#4 append FIFO (accumulate then budget-evict). No principled choice.
- Inconsistent speech: #1 conditionally speaks (and is broken), #2 always speaks, #3 never speaks, #4 sometimes speaks with a guard.
- Only #4 (`answeredQuestion`) has any staleness protection. It is the model to generalize (see §4.3).
- No single place enforces "never speak a failure sentinel as fact" (#5's `[Recall via …]` strings and #1's error branch both leak).

---

## 3. The P0 blocker, dissected

`transcript-auditor.ts:664-673`:

```ts
// #15: Use replaceContext with fixed ID — don't accumulate in FIFO
if (this.voice?.connected) {
  this.voice.replaceContext(`[RESEARCH] ${query}\n\n${result.slice(0, 1200)}`, "ctx_research_result");
  // #2/#3: Don't force response.create — queue it, only flush when voice is idle
  if (this.voice.audioState === "listening") {
    this.voice.client.sendEvent("response.create", {});
  } else {
    this.voice.client.queuePendingResponse();
  }
}
```

Two compile-time defects, tsc-confirmed:
- **TS2551** — `queuePendingResponse()` does not exist on `RealtimeClient`. The client exposes `flushPendingResponse()` and `setSpeaking()` only (`realtime_client.ts:911,914`). There is no `queuePendingResponse`.
- **TS2341 ×2** — `this.voice.client` reaches a `private` field (`voice.ts:52 private client: RealtimeClient`). Both the `sendEvent` branch and the `queuePendingResponse` branch are illegal member access.

Runtime failure mode (the damaging part):
1. The result *is* injected into Layer 3 at line 666 (`replaceContext` runs first).
2. In the **common non-idle case** (AI is mid-sentence or thinking), control reaches line 671 and calls a non-function → `TypeError`.
3. That throw rejects the `.then()`, so control jumps to the `.catch()` at `transcript-auditor.ts:681-688`, which injects `[RESEARCH] Search for "…" failed: <err>`.
4. Net state: the real answer sits in Layer 3 **unspoken**, *and* a contradictory "search failed" note sits beside it. On the next turn the model may read the failure note and tell the user the search failed — while the answer is right there.
5. It only "works" when `audioState === "listening"` at the exact completion instant (the `sendEvent` branch), which is also a private-access violation but happens to be a real method.

This shipped because tsc is not a CI gate and the repo carries ~379 pre-existing tsc errors that mask new ones (see §12).

**P0 fix (minimal, no dependency on P1):** replace lines 667-673 with a single public, gated call:

```ts
this.voice.replaceContext(`[RESEARCH] ${query}\n\n${result.slice(0, 1200)}`, "ctx_research_result");
this.voice.requestDeliberateResponse();   // new PUBLIC method on VoiceModule
```

`VoiceModule.requestDeliberateResponse()` wraps the existing private `_requestResponse({})` (`voice.ts:167`), which is already gated by `_responseActive` and defers correctly when a response is active. This removes the private access and the phantom method, and is correct in both idle and non-idle states. In P1 this method becomes the internal primitive that the unified sink calls (§4.2), so the P0 change is forward-compatible, not throwaway.

---

## 4. Target architecture — the unified S2-result contract

### 4.1 The `DeliberateResult` envelope (verbatim)

New file: `callingclaw-backend/src/modules/deliberate-result.ts`

```ts
// CallingClaw 2.0 — Unified System-2 → System-1 result contract.
// Every deliberate (slow-brain) capability produces ONE of these and hands it
// to VoiceModule.deliverDeliberateResult(). No producer talks to the Realtime
// client, the context queue, or response.create directly.

export type DeliberateKind =
  | "research"    // web/deep research via agentAdapter.executeTask
  | "recall"      // recall_context: memory/file/agent fact lookup
  | "retrieval"   // ContextRetriever proactive gap-fill
  | "action";     // ComputerUse / automation completion

/** How the sink decides whether a (possibly late) result still deserves surfacing. */
export type StalenessPolicy =
  | "always"           // surface regardless of age/relevance (rare; e.g. explicit user-addressed research)
  | "if-relevant"      // surface only if still topically relevant to recent turns
  | "if-question-open" // surface only if the triggering question looks unanswered (the ContextRetriever model)
  | "drop-if-stale";   // hard age gate only; drop past staleWindow

/** How the sink should present the result to the voice model. */
export type SpeakMode =
  | "proactive"   // inject + trigger a gated one-turn response (subject to staleness guard)
  | "silent";     // inject only; the model picks it up on its next natural turn

export interface DeliberateResult {
  /** Unique per-dispatch id. Correlation + idempotency. e.g. "research_<ts>" */
  id: string;
  kind: DeliberateKind;
  /** One-line, spoken-ready. What the model may weave into speech. Never a sentinel. */
  summary: string;
  /** Full detail for Layer-3 injection / working doc. May be long; the sink caps it. */
  detail: string;
  /** The user utterance/intent that triggered this dispatch — used for relevance scoring. */
  sourceUtterance?: string;
  /** ms epoch when the triggering dispatch began — used for age-based staleness. */
  dispatchedAt: number;
  speak: SpeakMode;
  stalenessPolicy: StalenessPolicy;
  /** Optional fixed Layer-3 id for replace-semantics. Omit for FIFO append. */
  replaceId?: string;
  /** Optional working-document to register on the Stage (research artifacts). */
  documentPath?: string;
  /** Set when the deliberate call failed. The sink renders this as an INTERNAL note,
   *  never as spoken fact, and forces speak:"silent". */
  error?: string;
}

/** What the sink actually did — returned so producers log/emit consistently. */
export type DeliveryDisposition =
  | "spoken"         // injected + proactive gated response triggered
  | "injected"       // injected silently (model sees it next natural turn)
  | "dropped-stale"  // staleness guard rejected proactive speech (still injected silently if useful)
  | "dropped-dup"    // same id/replaceId already delivered within the dedup window
  | "no-session";    // voice not connected
```

### 4.2 The `deliverDeliberateResult()` sink (verbatim signature + responsibilities)

Added to `VoiceModule` (`callingclaw-backend/src/modules/voice.ts`):

```ts
/**
 * THE single public sink for every System-2 deliberate result.
 *
 * Owns, in ONE place:
 *   1. Injection-layer choice — replaceId → replaceContext (only-latest);
 *      otherwise injectContext (FIFO, token-budget evicted).
 *   2. The gated response trigger — proactive speak routes through the
 *      response gate (_requestResponse); never collides with an active response.
 *   3. The shared staleness/relevance guard (§4.3) — late/irrelevant answers
 *      are downgraded from proactive to silent, or dropped.
 *   4. Sentinel safety — result.error is injected as an internal note and
 *      never triggers proactive speech, so a failure string can't be spoken as fact.
 *   5. Dedup — id/replaceId seen within the dedup window returns "dropped-dup".
 *
 * Returns the disposition; producers do NOT emit their own EventBus completion
 * (the sink emits `deliberate.delivered { id, kind, disposition }`).
 */
deliverDeliberateResult(result: DeliberateResult): DeliveryDisposition;
```

Internal decision flow (single, auditable):

```
if (!connected) return "no-session";
if (seen(result.id) || (result.replaceId && seenReplace(result.replaceId))) return "dropped-dup";

const text = render(result);            // "[RESEARCH] …" / "[RECALL] …" / "[CONTEXT] …" / "[DONE] …"
if (result.replaceId) replaceContext(text, result.replaceId);
else                  injectContext(text);            // FIFO; Layer-3 budget evicts

if (result.error || result.speak === "silent") return "injected";

const guard = stalenessGuard(result);   // §4.3 → "speak" | "instruct" | "drop"
if (guard === "drop") return "dropped-stale";
requestDeliberateResponse(guard === "instruct" ? guardedInstruction(result) : undefined);
return "spoken";
```

`requestDeliberateResponse(instruction?)` is the P0 primitive extended to accept an optional one-turn instruction; with no instruction it is `_requestResponse({})`, with one it is `_requestResponse({ response: { instructions } })` (mirrors the existing `speakWithInstruction`, `voice.ts:183`). Gemini branch keeps the `injectContext` + auto-respond behaviour already in `speakWithInstruction`.

### 4.3 The shared staleness/relevance guard

Today only `ContextRetriever` guards staleness, and it does so the right way: it does **not** try to hard-classify relevance; it hands the realtime model a one-turn instruction that says "if a question about X is still open, answer now in 1-2 sentences; if you already answered or the topic moved on, stay silent" (`context-retriever.ts:1182-1188`). We generalize exactly this, adding a cheap hard pre-gate so we don't even ask the model when the answer is obviously dead.

Two-stage guard inside the sink:

1. **Hard age pre-gate (deterministic, free).** `age = now - dispatchedAt`. Per policy:
   - `drop-if-stale`: `age > staleWindow` → return `drop` (inject silent only).
   - `if-question-open` / `if-relevant`: `age > staleWindow` → downgrade to `instruct` (never a bare `speak`); within window → `instruct` if any assistant turn occurred since `dispatchedAt`, else `speak`.
   - `always`: never dropped; `speak`.
   Windows come from `CONFIG.conversation.staleness` (§7), defaulted per kind (research minutes; recall/retrieval ~30s).
2. **Soft model-judgment gate (the proven pattern).** When the decision is `instruct`, `requestDeliberateResponse` fires with a guarded instruction built from `summary` + `sourceUtterance`, delegating the final call to the realtime model. This is the single behaviour that today lives only in ContextRetriever; every producer now inherits it.

Rationale: hard relevance classification of "is this still the topic" is exactly what a Haiku round-trip or brittle keyword overlap gets wrong; the realtime model already has full Layer-4 conversation and is the cheapest, most accurate judge. The hard gate only suppresses the unarguable cases (result older than the conversation has any use for). This is the crux the cross-review should attack (§14, risk 1).

### 4.4 Producers

Each producer shrinks to "build envelope, call sink." No producer touches `client`, `response.create`, `replaceContext`, `injectContext`, or emits its own completion.

- **research_task** (`transcript-auditor.ts:596-692`). On `executeTask` resolve, build `{ kind:"research", summary: firstLine(result), detail: result, sourceUtterance: query, dispatchedAt: startTs, speak:"proactive", stalenessPolicy:"if-relevant", documentPath }`. On reject or error-sentinel (`ERROR_PATTERNS`, line 647), set `error` and let the sink render it silently. Delete the hand-rolled `if listening/else queuePendingResponse` block entirely.
- **recall_context** (`voice.ts` SLOW_TOOL path 466-505 + `ai-tools.ts` handler). The tool handler returns a string today; wrap it: the voice SLOW_TOOL completion builds `{ kind:"recall", stalenessPolicy:"if-question-open", speak:"proactive" }`. Replaces the current `[DONE] recall_context` + `_requestResponse({})`.
- **ContextRetriever** (`context-retriever.ts:1162-1198`). `injectIntoVoice` builds `{ kind:"retrieval", stalenessPolicy:"if-question-open", speak: answeredQuestion ? "proactive" : "silent" }`. Replaces `speakWithInstruction` / `[CONTEXT_HINT]`. Its liveNote registration (`addLiveNote`) stays (that is Layer-2 mission memory, orthogonal to the return path).
- **action / ComputerUse completion** (`notifyTaskCompletion`, `transcript-auditor.ts:500,1325`). Build `{ kind:"action", speak:"silent", stalenessPolicy:"drop-if-stale" }`. Preserves 方向A (never interrupt mid-sentence). `notifyTaskCompletion` becomes a thin adapter that constructs the envelope.

### 4.5 Proof: a 3rd deliberate capability needs zero new return plumbing

Suppose we add "live translation lookup" (S2 fetches a domain-term gloss). Implementer writes the fetch, then:

```ts
voice.deliverDeliberateResult({
  id: `gloss_${Date.now()}`,
  kind: "recall",
  summary: gloss.oneLine,
  detail: gloss.full,
  sourceUtterance: term,
  dispatchedAt: startedAt,
  speak: "silent",
  stalenessPolicy: "if-relevant",
});
```

No new injection code, no `response.create`, no staleness logic, no dedup, no EventBus wiring, no private access. The capability is a producer; the sink already owns everything else. This is the test the design must pass.

---

## 5. The reliability layer

Four missing liveness mechanisms. Each has a home and an invariant. All default to **observe** mode first (log, don't act) behind a flag (§12), then flip to **enforce**.

| Mechanism | Lives in | Invariant it enforces | Trigger / action |
|-----------|----------|-----------------------|------------------|
| **Response state-machine watchdog** | `VoiceModule` (`voice.ts`) | `_responseActive===true` (or `audioState` in `thinking`/`speaking`) never persists past `maxResponseMs` without a `response.done` | Arm timer on `response.created` (`voice.ts:305`), clear on `response.done` (`voice.ts:351`). On fire: force `_responseActive=false`, flush pending, set `listening`, log `voice.watchdog_reset`. Fixes the mute-forever-after-barge-in bug (missing `response.done` after `response.cancel`, `voice.ts:282-293`). |
| **Executor timeouts** | `ActionOrchestrator` (`action-orchestrator.ts`) + `TranscriptAuditor` lanes | No lane/hand stuck for the whole meeting | Orchestrator: per-task `taskTimeoutMs` — on expiry `task.abort.abort()` and settle the promise with a timeout string, freeing `_active` (`_drain`, line 190) so the queue drains. Auditor: wrap `classifyIntent`/`executeAction` in `Promise.race` with `auditorLaneTimeoutMs` so `_processing` (line 697/714) and `_fastLaneProcessing` (line 440/457) `finally` always runs. |
| **Reconnect supervisor** | `callingclaw.ts` (new `eventBus.on("voice.reconnect_failed")`) | Exhausted reconnect leads to a supervised restart, not permanent death | `voice.reconnect_failed` is emitted (`callingclaw.ts:1062`) but has **zero listeners** today. Add a listener that restarts `voice.start(lastInstructions, provider)` with exponential backoff + cap (`supervisorMaxRestarts`, `supervisorBaseDelayMs`, `maxDelayMs`). Reset the counter on the next successful `session.updated`. After final give-up: emit `voice.dead` and surface to Desktop UI. Circuit-breaker prevents restart storms. |
| **WS keepalive / liveness** | `RealtimeClient` (`realtime_client.ts`) | A half-open socket is detected within `livenessTimeoutMs` and recycled | Track `_lastInboundTs` on every inbound message. A `keepaliveIntervalMs` watchdog: if the session is supposed to be active and `now - _lastInboundTs > livenessTimeoutMs`, force `ws.close()` → existing `onclose` (`realtime_client.ts:668`) fires → `_scheduleReconnect`. This catches the silent death where `onclose` never fires. (Bun's `WebSocket` has no `ping()` API; inbound-idle detection is the cross-provider-safe mechanism.) |

Additional reliability corrections folded in here (small, same files):
- **Reset token budget + retry counter on reconnect.** `_reconnectRetries` resets on `session.updated` (`realtime_client.ts:598`); also reset `_tokenBudget` counters there so a resumed session doesn't inherit a stale "critical" state and force-evict (`realtime_client.ts:760-788`).
- **`_intentionalClose` audit.** Confirm `stop()` (`voice.ts:679`) sets the intentional-close flag so the supervisor does not fight a deliberate teardown.

Ownership note (deliberate): the **authority to reset `_responseActive`** lives in `VoiceModule` only. The **authority to recycle the socket** lives in `RealtimeClient` only. The supervisor (callingclaw) only restarts after `RealtimeClient` has given up. This three-tier separation avoids two controllers racing (see §14, risk 2).

---

## 6. Decoupling S2 escalation from OpenClaw

Three coupled defects, one fix direction: **route thorough recall and research through `adapter.recallContext()` / `adapter.executeTask()`, never through `openclawBridge.connected` gates or a hardcoded `claude` binary.**

- **Dead thorough recall on 4/5 platforms.** `ai-tools.ts:113` — `if (urgency === "quick" || !openclawBridge.connected)` short-circuits *before* the dispatcher path whenever the OpenClaw gateway is not connected. On claude-code / codex / hermes / standalone the gateway is never connected, so thorough recall returns the "OpenClaw is not currently available" apology (line 118) even though a perfectly good `adapter.recallContext()` exists. **Fix:** add `agentAdapter` to `AIToolDeps` (it is already available in `toolDeps`, `callingclaw.ts:1023`) and route the thorough path to `agentAdapter.recallContext(query, localResult)`. Keep the `dispatcher`/gateway path only as an OpenClaw-specific optimization when connected.
- **Dispatcher hardcodes `claude`.** `openclaw-dispatcher.ts:254-255` spawns `["claude", "-p", …]` regardless of `AGENT_PLATFORM`. This is dead/wrong on non-claude platforms. **Fix:** for recall, bypass the dispatcher entirely in favour of `adapter.recallContext()` (each adapter already implements it, `agent-adapter.ts:63`). The dispatcher's subprocess channel remains valid only under the OpenClaw adapter; gate its use accordingly.
- **Warm recall worker with zero callers.** `claude-code-adapter.ts:357` spawns a warm `recall` worker every meeting (`warmUp` on `meeting.started`, `callingclaw.ts:392`). `recallContext` consumes it via `tryWarm("recall", …)` (`claude-code-adapter.ts:528`), but **nothing calls `adapter.recallContext()` at runtime** (verified: zero `.recallContext(` call sites outside adapter definitions). So the warm worker is pure cost. **Fix falls out of the first bullet:** once `ai-tools.ts` routes thorough recall through `adapter.recallContext()`, the warm worker gains its intended caller and the cold-start budget it was spawned to hide (`recallBudgetMs`, `claude-code-adapter.ts:276`) is actually used.

Sentinel safety (ties to §4.2): the recall path today can return `[OpenClaw recall]` / apology strings that get spoken. Under the contract, the recall producer sets `error` when `isUsableOpenClawAnswer` (`ai-tools.ts:26`) is false, so the sink never speaks a sentinel.

---

## 7. Config centralization (`CONFIG.conversation` + profiles) — the generality fix

~30+ magic numbers govern S1/S2 timing and gating, scattered as class fields and module constants, none in `CONFIG` (`config.ts`), none adaptive to language / speaker-pace / provider. Inventory (representative, with anchors):

| Domain | Constants (current) | Anchor |
|--------|---------------------|--------|
| Voice echo/gate | echo debounce 800/2000ms, echo gate 500ms, flush delays 500/50ms, heardRatio 0.95, buffer 150ms | `voice.ts:228,726,139,366,252` |
| Reconnect | `RECONNECT_MAX_RETRIES=3`, `RECONNECT_DELAY_MS=3000` (linear) | `realtime_client.ts:343-344` |
| Tokens | `MAX_CONTEXT_TOKENS_L3=3000`, `MAX_IMAGE_ITEMS=2`, warn 0.8, compress 0.9, `estimateTokens=len/3` | `realtime_client.ts:354-381,359` |
| Auditor | `DEBOUNCE_MS=1200`, `COOLDOWN_MS=3000`, `WINDOW_ENTRIES=15`, `FAST_LANE_CONFIDENCE=0.95`, `CONFIDENCE_AUTO=0.85`, `CONFIDENCE_SUGGEST=0.6`, in-flight window 120000 | `transcript-auditor.ts:247-252,612` |
| Retriever | `CHAR_THRESHOLD=300`, `MIN_INTERVAL_MS=20000`, `DEBOUNCE_MS=2000`, `AGENT_TIMEOUT_MS=15000` | `context-retriever.ts:120-123,540` |
| Orchestrator | `COALESCE_WINDOW_MS=10000`, `HEARTBEAT_INTERVAL_MS=6000`, `MAX_QUEUE=5` | `action-orchestrator.ts:55-58` |

Target: a `CONFIG.conversation` section, sub-scoped per module, env-overridable, with per-provider and per-language *profiles* applied at init.

```ts
// config.ts (sketch)
conversation: {
  voice:      { echoDebounceMs, echoGateMs, presentationEchoMs, heardRatioFloor, flushDelayMs, initialBufferMs },
  reconnect:  { maxRetries, baseDelayMs, backoff, maxDelayMs, livenessTimeoutMs, keepaliveIntervalMs,
                supervisorMaxRestarts, supervisorBaseDelayMs },
  watchdog:   { maxResponseMs, maxThinkingMs, taskTimeoutMs, auditorLaneTimeoutMs },
  auditor:    { debounceMs, cooldownMs, windowEntries, fastLaneConfidence, autoConfidence, suggestConfidence,
                researchInFlightWindowMs },
  retriever:  { charThreshold, minIntervalMs, debounceMs, agentTimeoutMs },
  staleness:  { research: {staleWindowMs}, recall: {staleWindowMs}, retrieval: {staleWindowMs}, action: {staleWindowMs} },
  tokens:     { l3MaxTokens, imageMax, warnThreshold, compressThreshold, charsPerTokenLatin, charsPerTokenCjk },
},
```

Two generality wins beyond "no more magic numbers":
- **Language-aware `estimateTokens`.** `len/3` (`realtime_client.ts:359`) over-counts English (~4 chars/token) → premature Layer-3 eviction of retrieved `[CONTEXT]`. Replace with a script-detecting estimator using `charsPerTokenLatin` / `charsPerTokenCjk`.
- **Fast-lane threshold coherence.** `FAST_LANE_CONFIDENCE=0.95` (`transcript-auditor.ts:248`) is above the router's scroll/click confidences of 0.85 (`automation-router.ts:153-154`), so those deterministic actions *never* fast-lane and always eat the Haiku round-trip. Aligning both via `CONFIG.conversation.auditor.fastLaneConfidence` (default 0.85) fixes it in one place.

Provider/language profiles are applied once at module construction (e.g. Gemini gets longer echo windows and skips delete-based eviction; zh gets a lower char threshold). Modules read `CONFIG.conversation.*` at construction, not per-call, to keep the hot path allocation-free.

---

## 8. Cross-meeting isolation fix

`meeting.started` (`callingclaw.ts:394-405`) tries to reset the transcript only when joining a *different* meeting:

```ts
const prevUrl = context.workspace?.meetUrl || "";     // <-- always ""
if (currentUrl && prevUrl && currentUrl !== prevUrl) {
  context.resetTranscript();
}
```

`WorkspaceContext` (`shared-context.ts:33-39`) has **no `meetUrl` field**, and no `setWorkspace` call ever sets one. So `prevUrl` is always `""`, the guard is always false, and `resetTranscript()` is **dead code**. Meeting A's transcript survives into meeting B, where it is: (a) re-scanned by the auditor window (`getRecentTranscript(WINDOW_ENTRIES)`, `transcript-auditor.ts:705`), and (b) replayed to the realtime model on reconnect (`_feedTranscriptContext`, `voice.ts:534`). On `meeting.ended`, `voice.resetForNewMeeting()` clears the realtime context queue (`voice.ts:689`) but does **not** reset the SharedContext transcript.

**Fix:** give `SharedContext` a first-class `meetUrl` (getter/setter), set on `meeting.started` *after* the comparison, and compare against it:

```ts
const currentUrl = data?.url || "";
if (currentUrl && context.meetUrl && currentUrl !== context.meetUrl) {
  context.resetTranscript();
}
if (currentUrl) context.setMeetUrl(currentUrl);
```

Preserves the documented same-URL rejoin behaviour (gotcha "Transcript reset on re-join") while making the reset actually fire on a genuinely new meeting. Invariant: **meeting A's transcript is never audited or replayed inside meeting B.** Unit-testable without a live session.

---

## 9. Generality: pluggable tool-classification + context-provider

S1/S2 logic is welded to the meeting+Meet+prep-brief scenario. Two seams unlock reuse; both are *interface extraction + injection*, defaulted to today's meeting behaviour. Pragmatic scope: define and wire the seams, ship the meeting default, do **not** build alternate implementations this cycle.

- **`ToolClassifier`.** Today the string sets `SLOW_TOOLS` / `VISUAL_TOOLS` (`voice.ts:22-40,844-850`) and `AUDITOR_MANAGED_TOOLS` (`transcript-auditor.ts:42`) hardcode meeting semantics. Extract `{ isAsync(name), isVisual(name), isAuditorManaged(name) }`, inject into `VoiceModule`/`TranscriptAuditor` via options, default to the meeting classifier. A non-meeting host supplies its own.
- **`ContextProvider`.** `ContextRetriever` and `recall_context` hard-depend on `MeetingPrepSkill.currentBrief` (`context-retriever.ts:1163`, `ai-tools.ts:75`). Define `{ lookup(query): Promise<string|null>, describeMission(): string }` so a non-meeting scenario supplies its own knowledge source. Default binds to `MeetingPrepSkill`.

These seams also make the unified sink genuinely general: the sink already knows nothing about meetings; once producers depend on interfaces rather than `MeetingPrepSkill`, the whole S1↔S2 loop is scenario-agnostic. But this is P2 — the contract (P1) does not require it.

---

## 10. Concurrency & correlation fixes

- **Bridge FIFO cross-delivery.** `openclaw_bridge.ts:270` correlates a `final` chat event to the *oldest* pending entry for the session (`findIndex(e => !eventSession || e.sessionKey === eventSession)`), ignoring the `idempotencyKey` it already sends (`openclaw_bridge.ts:197,236`). Two concurrent tasks on one session cross-deliver. **Fix:** store `idempotencyKey` per `_chatQueue` entry and match the final event by it when the gateway echoes it; fall back to FIFO only when absent. (Largely mooted for recall once §6 routes recall through per-process subprocess isolation; still needed for concurrent `executeTask` research.)
- **Research singleton id.** `ctx_research_result` (`transcript-auditor.ts:666`) means a 2nd research clobbers the 1st. Under the contract, research uses a **per-dispatch** envelope `id` and FIFO injection (no `replaceId`), so concurrent researches coexist and are budget-managed.
- **Cross-source double-answer.** A voice `recall_context` and an auditor `research_task` for the same question are not deduped, producing two answers. **Fix (P2):** a small `DeliberateDispatcher` that coalesces read-only deliberate work by `normalize(query)` — the read-only sibling of `ActionOrchestrator` (which already coalesces *actions*, `action-orchestrator.ts:88-110`). At minimum, the sink dedups by `id`/`replaceId`; full query coalescing is the dispatcher.

---

## 11. Phasing

Legend — Risk: 🟥 high (live audio path) · 🟧 medium · 🟩 low.

### P0 — Can't-ship-broken (blocker + reliability floor)

| # | Change | Files | Risk | Verify |
|---|--------|-------|------|--------|
| P0.1 | Fix the blocker: replace `client.queuePendingResponse()`/private access with public `voice.requestDeliberateResponse()` | `transcript-auditor.ts:664-673`, new method in `voice.ts` | 🟧 | Unit: research completion while `audioState !== "listening"` injects result AND triggers exactly one gated response, no throw, no false `[RESEARCH] failed`. Scoped tsc clean. |
| P0.2 | Response state-machine watchdog | `voice.ts` (arm@305, clear@351) | 🟥 | Unit: fabricate `response.created` with no `response.done`; after `maxResponseMs` `_responseActive` resets, state→listening. Dogfood: barge-in mid-sentence, confirm AI still responds to the next utterance. |
| P0.3 | Executor timeouts (orchestrator per-task + auditor lanes) | `action-orchestrator.ts:190`, `transcript-auditor.ts:697,440` | 🟧 | Unit: executor that never resolves → task settles at `taskTimeoutMs`, `_active` freed, queue drains; auditor flags cleared. |
| P0.4 | Reconnect supervisor (listen to `voice.reconnect_failed`, restart w/ backoff+cap) | `callingclaw.ts` (near :1060) | 🟧 | Unit: emit `voice.reconnect_failed` N times → backoff schedule respected, cap honoured, `voice.dead` after cap. Dogfood: kill network briefly. |
| P0.5 | WS keepalive / liveness (inbound-idle → recycle) | `realtime_client.ts` (near onclose :668, message handler) | 🟥 | Integration: simulate no inbound for `livenessTimeoutMs` → socket recycled → reconnect. Ensure no false positive during normal silence. |
| P0.6 | Cross-meeting isolation (`SharedContext.meetUrl`) | `shared-context.ts`, `callingclaw.ts:394-405` | 🟩 | Unit: start A, add transcript, start B (different url) → transcript reset; same-url rejoin → preserved. |
| P0.7 | Decouple thorough recall from OpenClaw (route via `adapter.recallContext`), fix warm-worker deadness | `ai-tools.ts:113-152`, `tool-definitions/index.ts` (AIToolDeps), `callingclaw.ts` toolDeps | 🟧 | Unit/integration on standalone+claude-code: thorough recall returns a real answer, not the OpenClaw apology; warm `recall` worker `turnsServed > 0`. |

P0 exit criteria: blocker gone; no single dropped provider event can leave the AI mute, a lane dead, or the socket silently dead for the rest of a meeting; recall works on all platforms; no cross-meeting transcript bleed. Scoped tsc gate green on the S1/S2 file set (§12).

### P1 — The unified contract (structural keystone)

| # | Change | Files | Risk | Verify |
|---|--------|-------|------|--------|
| P1.1 | Add `DeliberateResult` / `DeliveryDisposition` types | new `modules/deliberate-result.ts` | 🟩 | Compiles; exported. |
| P1.2 | Implement `voice.deliverDeliberateResult()` (layer choice + gated trigger + staleness guard + sentinel safety + dedup) | `voice.ts` | 🟥 | Unit matrix over `{kind × speak × stalenessPolicy × connected × age × error}` → asserts disposition + that `_requestResponse` is called ≤1×. |
| P1.3 | Migrate `research_task` producer | `transcript-auditor.ts:596-692` | 🟧 | Behaviour parity + no `ctx_research_result` clobber across two concurrent researches. |
| P1.4 | Migrate `recall_context` producer | `voice.ts:466-505`, `ai-tools.ts` | 🟧 | Recall answer spoken when question open; silent+dedup when late. |
| P1.5 | Migrate `ContextRetriever` producer (retire `speakWithInstruction`/`[CONTEXT_HINT]` as return paths) | `context-retriever.ts:1162-1198` | 🟧 | `answeredQuestion` still yields a guarded one-turn follow-up; no double-answer. |
| P1.6 | Migrate action-completion producer | `transcript-auditor.ts:500,1325`, `automation-tools.ts:247`, `voice-persona.ts:524` | 🟩 | 方向A preserved (silent). |
| P1.7 | Sink emits `deliberate.delivered`; remove per-producer completion emits | above | 🟩 | Stage S2 panel shows unified completion events. |

P1 exit criteria: all five paths replaced by one sink; adding a hypothetical 6th producer requires only an envelope (§4.5); the ONLY code that calls `response.create`/`injectContext`/`replaceContext` for deliberate results is the sink.

### P2 — Config & generality

- P2.1 `CONFIG.conversation` + per-module config objects + env overrides + provider/language profiles. 🟧 (behavioural if defaults drift — snapshot current values exactly).
- P2.2 Language-aware `estimateTokens`. 🟩
- P2.3 Align fast-lane vs router confidence via config. 🟧 (may change which utterances fast-lane — dogfood.)
- P2.4 Collapse the dual response-gate: remove `RealtimeClient`'s separate `_pendingResponseCreate`/`_isSpeaking`/debounce (`realtime_client.ts:906-943`), keep the single gate in `VoiceModule`. 🟥 **behind flag** — this is the historical root of "did the action, said nothing."
- P2.5 `idempotencyKey` correlation in `openclaw_bridge.ts:270`. 🟧
- P2.6 Generality seams: `ToolClassifier` + `ContextProvider` interfaces, meeting defaults. 🟧
- P2.7 Kill subprocess + clean temp files on dispatcher timeout (`openclaw-dispatcher.ts:90-95,273`). 🟩
- P2.8 `DeliberateDispatcher` cross-source coalescing by query. 🟧

### P3 — Nice-to-haves

- EventBus durability: at-least-once/replay, backpressure, webhook timeout (`modules/event-bus.ts`).
- Gemini resume symmetry: preserve/replay the context queue on Gemini resume as OpenAI does (`realtime_client.ts:861+`).
- Full observability dashboard for deliberate deliveries + watchdog/supervisor events.
- Extend sentinel classification uniformly across every producer.

---

## 12. Risk & rollout

This plan edits the live voice loop. Guardrails:

- **Observe-before-enforce for every reliability mechanism.** `CONFIG.conversation.watchdog.mode = "observe" | "enforce"` (and similar for liveness/supervisor). Ship P0.2/P0.5 in observe first: log `would-reset`/`would-recycle` with the state that triggered it, dogfood a day of real meetings, tune windows, then flip to enforce. Prevents a too-tight timeout from truncating a legitimately long response or recycling a healthy-but-quiet socket.
- **Restart storm protection.** Supervisor (P0.4) has a hard cap + exponential backoff + `maxDelayMs`; after cap it emits `voice.dead` and stops (no infinite loop). It never runs while an intentional `stop()` is in effect.
- **Feature-flag the highest-blast-radius change.** P2.4 (dual-gate collapse) ships behind `CONVERSATION_SINGLE_GATE` defaulting off; A/B against the "did the action, said nothing" symptom before defaulting on.
- **Unit-testable without a session** (no live provider needed): envelope sink dispositions (P1.2), staleness guard (age + open-question), watchdog fire/clear, supervisor backoff schedule, cross-meeting reset (P0.6), language-aware `estimateTokens`, orchestrator timeout freeing `_active`.
- **Requires dogfooding in a real meeting** (behaviour, not logic): barge-in mute recovery (P0.2), late-answer staleness feel (P1.2/§4.3), fast-lane threshold change (P2.3), half-open recovery (P0.5), multi-platform recall (P0.7). These cannot be fully asserted in unit tests because they depend on realtime-model judgment and provider timing.
- **Scoped tsc gate — mandatory, and the reason the blocker shipped.** The repo has ~379 pre-existing tsc errors and tsc is not a CI gate, so TS2551/TS2341 in `transcript-auditor.ts` shipped unseen. Add a scoped gate: `tsc --noEmit` filtered to the S1/S2 file set — `voice.ts`, `transcript-auditor.ts`, `context-retriever.ts`, `realtime_client.ts`, `ai-tools.ts`, `action-orchestrator.ts`, `shared-context.ts`, and the new `deliberate-result.ts` — comparing against a committed baseline count and **failing on any new error in those files**. This is a pre-commit hook + CI check; it does not require fixing the 379 legacy errors. Recommended as the first commit of P0 so the rest of the work lands under the gate.

Regression surface to watch: (a) more frequent unsolicited speech if proactive producers over-trigger (mitigated by the staleness guard defaulting late/irrelevant results to silent); (b) watchdog/liveness false positives (mitigated by observe-first + generous windows); (c) supervisor fighting provider reconnect (mitigated by the three-tier authority separation, §5).

---

## 13. What we are deliberately NOT doing this cycle

- **Not** replacing the Realtime provider abstraction or the 5-layer context model — they are sound and reusable; we build the contract on top.
- **Not** collapsing the dual response-gate in P0/P1. It is the historical source of the worst audio-truncation regressions; it moves to P2 behind a flag, after the contract is proven on top of the existing gate.
- **Not** building non-meeting `ToolClassifier`/`ContextProvider` implementations — we extract and default the seams only (§9).
- **Not** hardening EventBus durability (replay/backpressure/webhook timeout) — P3.
- **Not** achieving OpenAI↔Gemini reconnect parity for the context queue — P3.
- **Not** replacing the auditor's regex fast-lane machinery or the Haiku classification — only aligning its confidence threshold with the router (P2.3).
- **Not** introducing a new persistence layer for deliberate results — the envelope is in-memory; documents already persist via `addStageDocument`.

---

## 14. Top 3 design risks for cross-review (codex, attack these)

1. **Staleness guard: does delegating relevance to the realtime model actually prevent the "answers a dead question" failure — without either suppressing useful late answers or increasing unsolicited speech?** The design deliberately avoids a hard relevance classifier and instead uses an age pre-gate plus a guarded one-turn `response.create` instruction (the ContextRetriever pattern, §4.3), betting the realtime model is the cheapest accurate judge. Pressure-test: (a) can the model reliably "stay silent" when instructed, or does it tend to speak anyway? (b) By routing *all four* producers through one proactive trigger, do we multiply the very unsolicited-speech that 方向A (silent injection) was designed to prevent? (c) Are the default `staleWindow`s per kind defensible?

2. **Two controllers, one socket / one response.** The reliability layer adds a `VoiceModule` response watchdog, a `RealtimeClient` liveness watchdog, and a `callingclaw` reconnect supervisor. We separated authority (reset `_responseActive` = VoiceModule; recycle socket = RealtimeClient; restart session = supervisor, only after RealtimeClient gives up). Pressure-test: can the response watchdog force-reset mid-legitimate-long-response and truncate it? Can liveness recycle a healthy-but-quiet socket (long user monologue, no inbound)? Can the supervisor and `RealtimeClient._scheduleReconnect` both be live at once and double-connect? Is "observe-first" enough, or is there a missing lock?

3. **Contract-before-gate-collapse phasing.** The unified sink (P1) is layered on top of the *un-collapsed* dual response-gate (VoiceModule `_responseActive` at `voice.ts:73` + RealtimeClient `_isSpeaking`/debounce at `realtime_client.ts:906-943`), with gate-collapse deferred to P2. Pressure-test: does the sink's gated trigger interact correctly with *both* gates today (e.g., a deliberate result arriving while `_isSpeaking` is true but `_responseActive` is false, or vice versa), or does correctness actually require collapsing the gate *first* — i.e., is the P1-before-P2 order inverted?

---

## 15. Appendix: file:line anchor index

- Blocker: `modules/transcript-auditor.ts:664-673` (phantom `queuePendingResponse` @671; private `client` access @669,671); missing method on `ai_gateway/realtime_client.ts:911,914`.
- Five return paths: `transcript-auditor.ts:596-692` (research), `voice.ts:466-505` (recall SLOW_TOOL), `transcript-auditor.ts:500,1325` + `voice-persona.ts:524` (notifyTaskCompletion), `context-retriever.ts:1162-1198` (retrieval), `ai-tools.ts:113-152` (thorough recall).
- Sink target + primitives: `voice.ts:167` (`_requestResponse`), `voice.ts:183` (`speakWithInstruction`), `voice.ts:627-641` (injectContext/replaceContext), `voice.ts:52` (private `client`).
- Watchdog anchors: `voice.ts:305` (response.created), `voice.ts:351` (response.done), `voice.ts:282-293` (barge-in cancel).
- Reconnect: `realtime_client.ts:343-344` (constants), `:813-854` (`_scheduleReconnect`), `:598` (retry reset), `:668` (onclose), `callingclaw.ts:1060-1066` (emit `voice.reconnect_failed`, no listener).
- Executor stalls: `transcript-auditor.ts:697,714` (`_processing`), `:440,457` (`_fastLaneProcessing`), `action-orchestrator.ts:190` (`_active` in `_drain`), `:55-58` (constants).
- OpenClaw coupling: `ai-tools.ts:113` (gate), `openclaw-dispatcher.ts:254-255` (hardcoded `claude`), `claude-code-adapter.ts:357` (warm recall worker), `agent-adapter.ts:63` (`recallContext` interface).
- Correlation: `openclaw_bridge.ts:197,236` (idempotencyKey sent), `:270,281` (FIFO correlate).
- Config sprawl: `transcript-auditor.ts:247-252`, `context-retriever.ts:120-123,540`, `realtime_client.ts:343-344,354-381`, `action-orchestrator.ts:55-58`, `automation-router.ts:153-154` (0.85 vs 0.95).
- `estimateTokens`: `realtime_client.ts:359-360`.
- Cross-meeting bleed: `callingclaw.ts:394-405` (dead `workspace?.meetUrl`), `shared-context.ts:33-39` (no `meetUrl`), `:147` (`resetTranscript`), `voice.ts:689` (`resetForNewMeeting` clears queue, not transcript), `callingclaw.ts:614-696` (meeting.ended).
- Generality: `voice.ts:22-40,844-850` (SLOW/VISUAL tools), `transcript-auditor.ts:42` (AUDITOR_MANAGED_TOOLS), `context-retriever.ts:1163`, `ai-tools.ts:75` (MeetingPrepSkill dep).
- Dual gate: `voice.ts:73,167` + `realtime_client.ts:906-943`.
- Context model: `callingclaw-backend/CONTEXT-ENGINEERING.md` (5 layers; never `session.update` mid-meeting; Layer 3 budget @realtime_client.ts:354,1082-1117).
