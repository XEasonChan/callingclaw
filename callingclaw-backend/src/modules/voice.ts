// CallingClaw 2.0 — Module 2: Voice (Multi-Provider Realtime)
// Handles: real-time voice conversation, live transcript, tool calls
// Produces: transcript entries → SharedContext
// Does NOT do: screen analysis or computer use (separate modules)
//
// Provider support:
//   "openai" — OpenAI Realtime API (default, battle-tested)
//   "grok"   — xAI Grok Voice Agent (A/B test, 6x cheaper)
//
// All event names are normalized by RealtimeClient — VoiceModule
// uses the same handlers regardless of provider.

import { RealtimeClient, type RealtimeTool, type VoiceProviderName, type ContextItem, type ProviderCapabilities } from "../ai_gateway/realtime_client";
import type { SharedContext } from "./shared-context";
import { CONFIG } from "../config";
import { VoiceTracer, type VoiceTurnTrace } from "./voice-trace";
import type { AudioStateEvent, ToolEvent, SessionEvent } from "../ai_gateway/voice-events";
import {
  type DeliberateResult,
  type DeliveryDisposition,
  classifyStaleness,
  isDeliberateError,
  renderDeliberateText,
  renderErrorNote,
  MAX_DELIBERATE_DETAIL_CHARS,
} from "./deliberate-result";
// Recall-result failure classifier (single source of truth in the recall
// handler). The recall producer (SLOW_TOOL path below) reads it to set
// DeliberateResult.error so a leaked "All channels failed"/"Gateway not
// available" sentinel is suppressed by the sink instead of spoken as fact.
import { isUnusableRecallResult } from "../tool-definitions/ai-tools";

// ── Watchdog mode (observe / enforce) — s1s2 §12 safety valve ─────────────
// The reliability watchdogs (this module's response-watchdog + realtime_client's
// liveness-watchdog) can either ACT or only OBSERVE (log what they WOULD do
// without touching state). The mode is read ONCE at module load from the
// S1S2_WATCHDOG_MODE env var (Bun auto-loads .env). DEFAULT "observe" for the
// Phase-0 landing (spec §7 Phase 0: land watchdogs log-only first, flip to
// enforce after a clean observe day, §12). Set S1S2_WATCHDOG_MODE=enforce to
// activate both watchdogs WITHOUT a code change. realtime_client.ts reads the
// same env var independently.
export type WatchdogMode = "observe" | "enforce";
const WATCHDOG_MODE: WatchdogMode =
  process.env.S1S2_WATCHDOG_MODE === "enforce" ? "enforce" : "observe";

export type AudioState = "idle" | "listening" | "speaking" | "interrupted" | "thinking";

/** Tools that are too slow to await inline — dispatched async to avoid blocking voice thread */
const SLOW_TOOLS = new Set([
  "browser_action",
  "computer_action",
  "take_screenshot",
  "open_file",
  "share_screen",
  // Gemini 3.1 Live is very sensitive to delays — any blocking tool call
  // causes the connection to stall or disconnect. These are normally "fast"
  // for OpenAI/Grok but must be async for Gemini to keep audio flowing.
  "recall_context",
  "save_meeting_notes",
  // The longest operations in the product (20-60s): awaiting these inline
  // produced total dead silence with no acknowledgment.
  "join_meeting",
  "create_and_join_meeting",
  "leave_meeting",
  "search_files",
  "prepare_meeting",
]);

export interface VoiceModuleOptions {
  context: SharedContext;
  systemInstructions?: string;
  tools?: RealtimeTool[];
  onToolCall?: (name: string, args: any, callId: string) => Promise<string>;
  /** Called when auto-reconnect retries are exhausted */
  onReconnectFailed?: () => void;
}

// ── Response gate: the single-owned VoiceResponseScheduler (P1 STEP 1) ──────
//
// Honest disposition of a response.create request. Each value MEANS what it
// says — there is deliberately NO "spoken" that really means "attempted":
export type ResponseDisposition =
  /** We triggered response.create right now (the raw send happened). */
  | "response-requested"
  /** Queued because a response is in-flight; WILL fire on the next idle
   *  transition (response.done + audio.done). Not dropped, not sent-yet. */
  | "deferred"
  /** Explicitly dropped: within the debounce window of the last create. The
   *  distinct payload is NOT reported as success. */
  | "dropped-debounced"
  /** Explicitly dropped: a previously-deferred payload was displaced by a
   *  newer distinct one (replace-latest policy). Surfaced via onDisposition. */
  | "dropped-superseded"
  /** No live session — nothing was sent or queued. */
  | "no-session";

export interface VoiceResponseSchedulerOptions {
  /** Is a live session available right now? */
  isConnected: () => boolean;
  /** RAW send of response.create (no gating — the scheduler already decided). */
  send: (payload: any) => void;
  /** Debounce window: distinct creates closer than this are dropped. */
  debounceMs?: number;
  /** Settle delay before flushing a deferred payload for a text-only response. */
  flushDelayMs?: number;
  /** Settle delay before flushing a deferred payload after an audio response
   *  (mirrors the historical post-audio settle so a follow-up never truncates
   *  still-playing audio). */
  flushDelayWithAudioMs?: number;
  /** Observer for dispositions that can't be returned to the original caller
   *  (a deferred payload later displaced → "dropped-superseded"). */
  onDisposition?: (payload: any, disposition: ResponseDisposition) => void;
  /** Injectable clock for deterministic debounce tests. */
  now?: () => number;
}

/**
 * VoiceResponseScheduler — the SOLE authority for triggering `response.create`.
 *
 * Collapses the former DUAL response-gate (VoiceModule `_responseActive` +
 * `_pendingResponseCreate` AND RealtimeClient `_isSpeaking` + its own
 * `_pendingResponseCreate` + a 500ms debounce) into ONE owner. It reconciles
 * the two "is a response active/in-flight" signals into a single `busy`:
 *
 *     busy = _active (response.created … response.done)
 *          || _speaking (first response.audio.delta … response.audio.done)
 *
 * so the two layers can no longer disagree (the old bug: `_responseActive=false`
 * but `_isSpeaking=true` → caller told "sent" while it was only queued).
 *
 * Responsibilities, in ONE place:
 *   (a) acceptance — is a response allowed right now? (idle vs busy)
 *   (b) pending-replacement policy — a SINGLE pending slot, EXPLICIT semantics:
 *       coalesce-identical (same payload already queued) + replace-latest
 *       (a newer distinct payload displaces the older; the displaced one is
 *       reported as "dropped-superseded" via onDisposition — never a silent
 *       overwrite). No two competing queues.
 *   (c) debounce — ONE place, honest: a distinct create dropped by the debounce
 *       returns "dropped-debounced", not a false success.
 *   (d) honest disposition — see ResponseDisposition.
 *
 * The scheduler OBSERVES the realtime lifecycle via onResponseCreated /
 * onAudioDelta / onAudioDone / onResponseDone (called from VoiceModule's event
 * handlers) and owns the state. It is provider-agnostic: it only asks its
 * `send` callback to emit response.create and never touches provider-specific
 * mechanics (no conversation.item.delete, no Gemini assumptions).
 *
 * GENERATION-TOKENS (P1 STEP 4 — built): `onResponseCreated(generation)` stamps
 * the connection generation the response belongs to (see `responseGeneration`).
 * The response-watchdog reads it and only resets a stuck response when it still
 * equals the client's current generation — so a reconnect that started a NEW
 * connection can't have the response reset out from under it.
 *
 * SEAMS for later steps (left intentionally, not built yet):
 *   - turn-leases: `request()` is the choke point where a lease/priority check
 *     would gate acceptance before the busy/debounce checks.
 *   - unified sink / envelope (§4.2): `deliverDeliberateResult()` will sit ABOVE
 *     this scheduler and call `request(instruction?)` after choosing the
 *     injection layer + staleness guard; the scheduler stays the response
 *     primitive underneath. Nothing here needs to change for that.
 */
export class VoiceResponseScheduler {
  // ── Reconciled "response active/in-flight" state (single source of truth) ──
  private _active = false;    // response.created … response.done
  private _speaking = false;  // first audio.delta … audio.done
  private _hadAudio = false;  // did the current response emit any audio?
  // Connection generation the CURRENT response belongs to (stamped at
  // onResponseCreated). The response-watchdog reads it via `responseGeneration`
  // and only resets a stuck response when this still equals the client's current
  // generation — otherwise a reconnect already superseded the response and the
  // watchdog must step aside (never truncate a NEWER generation's response).
  private _responseGeneration = 0;
  // ── Single pending slot (replaces the two former competing slots) ──
  private _pending: any | null = null;
  // ── Debounce (single place) ──
  private _lastCreateTs = 0;
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly _debounceMs: number;
  private readonly _flushDelayMs: number;
  private readonly _flushDelayWithAudioMs: number;
  private readonly _now: () => number;
  private readonly _isConnected: () => boolean;
  private readonly _send: (payload: any) => void;
  private readonly _onDisposition?: (payload: any, d: ResponseDisposition) => void;

  constructor(opts: VoiceResponseSchedulerOptions) {
    this._isConnected = opts.isConnected;
    this._send = opts.send;
    this._debounceMs = opts.debounceMs ?? 500;             // historical RealtimeClient value
    this._flushDelayMs = opts.flushDelayMs ?? 50;          // historical response.done-flush value
    this._flushDelayWithAudioMs = opts.flushDelayWithAudioMs ?? 500; // historical both-done settle
    this._onDisposition = opts.onDisposition;
    this._now = opts.now ?? Date.now;
  }

  // ── State accessors (VoiceModule delegates _responseActive/_pendingResponseCreate here) ──
  get active(): boolean { return this._active; }
  set active(v: boolean) { this._active = v; }
  get speaking(): boolean { return this._speaking; }
  get pending(): any { return this._pending; }
  set pending(v: any) { this._pending = v; }
  /** The reconciled single "busy" signal used for acceptance. */
  get busy(): boolean { return this._active || this._speaking; }
  /** Connection generation the CURRENT (possibly stuck) response belongs to. */
  get responseGeneration(): number { return this._responseGeneration; }

  private _equal(a: any, b: any): boolean {
    if (a === b) return true;
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  }

  private _sendNow(payload: any) {
    this._lastCreateTs = this._now();
    this._send(payload);
  }

  /**
   * The ONE entry point for a response.create decision. Returns an HONEST
   * disposition describing what actually happened to THIS request. (A payload
   * that is displaced LATER — after it was accepted as "deferred" — is reported
   * to onDisposition as "dropped-superseded", since its caller already returned.)
   */
  request(payload: any = {}): ResponseDisposition {
    if (!this._isConnected()) return "no-session";

    if (this.busy) {
      // Deferred: park in the SINGLE pending slot.
      if (this._pending === null) {
        this._pending = payload;
        return "deferred";
      }
      // Coalesce-identical: the queued response already satisfies this request.
      if (this._equal(this._pending, payload)) {
        return "deferred";
      }
      // Replace-latest: the newer distinct payload wins (matches the historical
      // latest-wins overwrite) — but the displaced one is surfaced, not silent.
      const displaced = this._pending;
      this._pending = payload;
      console.log("[VoiceScheduler] pending superseded (replace-latest): dropped older deferred payload");
      this._onDisposition?.(displaced, "dropped-superseded");
      return "deferred";
    }

    // Idle: apply the single debounce.
    const now = this._now();
    if (now - this._lastCreateTs < this._debounceMs) {
      console.log(`[VoiceScheduler] response.create dropped-debounced (${now - this._lastCreateTs}ms < ${this._debounceMs}ms)`);
      this._onDisposition?.(payload, "dropped-debounced");
      return "dropped-debounced";
    }

    this._sendNow(payload);
    return "response-requested";
  }

  // ── Realtime lifecycle observation (called from VoiceModule handlers) ──
  onResponseCreated(generation: number = 0) {
    // Generation-token: stamp the connection generation this response belongs to
    // (VoiceModule passes the RealtimeClient's current generation). The
    // response-watchdog compares it to the live generation before resetting, so a
    // reconnect that started a NEW connection can't have this response reset out
    // from under it. Default 0 keeps single-generation unit tests working.
    this._responseGeneration = generation;
    this._active = true;
    this._speaking = false;
    this._hadAudio = false;
  }
  onAudioDelta() {
    this._speaking = true;
    this._hadAudio = true;
  }
  onAudioDone() {
    this._speaking = false;
    this._maybeFlush();
  }
  onResponseDone() {
    this._active = false;
    this._maybeFlush();
  }

  /**
   * Flush the single pending payload once the response is fully idle (neither a
   * response in-flight nor audio still playing). This unifies the two former
   * flush paths (VoiceModule's response.done 50ms flush + RealtimeClient's
   * both-done 500ms `flushPendingResponse`) into one "flush on idle" with the
   * historical settle delays. The flush BYPASSES the debounce on purpose — a
   * deferred payload is a committed response and MUST fire (the requirement:
   * "when deferred, actually fire on the next response.done; don't silently
   * lose it"). This also fixes the old edge where a very short response could
   * let the debounce eat its own deferred follow-up.
   */
  private _maybeFlush() {
    if (this.busy) return;
    if (this._pending === null) return;
    const payload = this._pending;
    this._pending = null; // clear synchronously; the actual send is delayed
    const delay = this._hadAudio ? this._flushDelayWithAudioMs : this._flushDelayMs;
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      if (!this._isConnected()) return;
      if (this.busy) {
        // A new response started during the settle window — re-defer so we
        // never fire into an active response.
        this._pending = payload;
        return;
      }
      this._sendNow(payload);
      console.log("[VoiceScheduler] flushed deferred response.create");
    }, delay);
    (this._flushTimer as any)?.unref?.();
  }

  /**
   * Watchdog recovery — a response got STUCK (e.g. a barge-in response.cancel
   * with no following response.done left `_active` true forever, muting the loop).
   * Force the reconciled gate back to idle and flush any pending deferred payload
   * so the next turn is answered. The response-watchdog (VoiceModule) is the ONLY
   * caller, and only AFTER it has generation-guarded that the stuck response still
   * belongs to the current connection (see checkResponseWatchdog). This keeps the
   * authority to reset response state inside the single gate owner (§5).
   */
  recoverFromStuck() {
    this._active = false;
    this._speaking = false;
    this._hadAudio = false;
    // Now idle → flush the single deferred payload if one is parked.
    this._maybeFlush();
  }

  /** Clear all state (new meeting / stop). */
  reset() {
    this._active = false;
    this._speaking = false;
    this._hadAudio = false;
    this._pending = null;
    this._lastCreateTs = 0;
    this._responseGeneration = 0;
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
  }
}

// ── Reconnect supervisor: the THIRD authority tier (s1s2 §5 / §14 risk 2) ─────
//
// AUTHORITY SEPARATION (explicit, so two controllers never race one socket):
//
//   • RealtimeClient owns PER-DROP reconnects. Each socket drop → onclose →
//     _scheduleReconnect, up to RECONNECT_MAX_RETRIES with its own backoff. It
//     also owns socket RECYCLING (the liveness force-close). While the client
//     still has retries left, the supervisor does NOTHING.
//   • VoiceModule owns resetting response state (the response-watchdog).
//   • The SUPERVISOR owns the RE-INIT that happens AFTER the client GIVES UP:
//     RealtimeClient fires onReconnectFailed → VoiceModule emits
//     `voice.reconnect_failed` → the supervisor restarts the whole voice session
//     (voice.start) with its OWN exponential backoff + a hard cap. Exactly one
//     tier owns a given reconnect attempt at a time.
//
// The GENERATION GUARD makes the boundary collision-proof: the supervisor
// captures the connection generation when it schedules a restart and NO-OPs at
// fire time if the generation advanced — the client reconnected on its own, or
// the session was stopped/restarted by another path. So the supervisor can never
// double-connect against the client's own connect (§14 risk 2).
//
// Dependency-injected (no hard EventBus / VoiceModule coupling) so it is
// unit-testable in isolation; callingclaw.ts wires the real deps.
export interface ReconnectSupervisorOptions {
  /** Current connection generation (RealtimeClient-owned socket lifecycle token). */
  getGeneration: () => number;
  /** Is a voice session live right now? */
  isConnected: () => boolean;
  /** Re-init the voice session — the supervisor's job, AFTER the client gave up. */
  restart: () => Promise<void>;
  /** Called when the supervisor hits its own hard cap and gives up for good. */
  onDead?: (info: { restarts: number }) => void;
  /** Max supervised restarts before giving up (default 5). */
  maxRestarts?: number;
  /** Base backoff delay in ms (default 3000). */
  baseDelayMs?: number;
  /** Exponential backoff factor (default 2). */
  backoff?: number;
  /** Backoff hard ceiling in ms (default 60000). */
  maxDelayMs?: number;
  /** Injectable scheduler for deterministic tests. */
  setTimer?: (fn: () => void, ms: number) => any;
  clearTimer?: (t: any) => void;
}

export class ReconnectSupervisor {
  private _restarts = 0;
  private _timer: any = null;
  private _dead = false;

  private readonly _getGeneration: () => number;
  private readonly _isConnected: () => boolean;
  private readonly _restart: () => Promise<void>;
  private readonly _onDead?: (info: { restarts: number }) => void;
  private readonly _maxRestarts: number;
  private readonly _baseDelayMs: number;
  private readonly _backoff: number;
  private readonly _maxDelayMs: number;
  private readonly _setTimer: (fn: () => void, ms: number) => any;
  private readonly _clearTimer: (t: any) => void;

  constructor(opts: ReconnectSupervisorOptions) {
    this._getGeneration = opts.getGeneration;
    this._isConnected = opts.isConnected;
    this._restart = opts.restart;
    this._onDead = opts.onDead;
    this._maxRestarts = opts.maxRestarts ?? 5;
    this._baseDelayMs = opts.baseDelayMs ?? 3000;
    this._backoff = opts.backoff ?? 2;
    this._maxDelayMs = opts.maxDelayMs ?? 60_000;
    this._setTimer = opts.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); (t as any)?.unref?.(); return t; });
    this._clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t));
  }

  // ── Diagnostic / test accessors ──
  get restarts(): number { return this._restarts; }
  get dead(): boolean { return this._dead; }
  get scheduled(): boolean { return this._timer !== null; }

  /** Backoff delay for the NEXT (0-based) restart attempt, capped at maxDelayMs. */
  private _delayFor(attempt: number): number {
    return Math.min(this._maxDelayMs, Math.round(this._baseDelayMs * Math.pow(this._backoff, attempt)));
  }

  /**
   * Entry point: the client exhausted its per-drop retries (voice.reconnect_failed).
   * Schedule a supervised restart with backoff — unless we've hit our own cap
   * (give up: emit dead) or a restart is already scheduled (never stack).
   */
  onReconnectFailed(): "scheduled" | "already-scheduled" | "dead" {
    if (this._dead) return "dead";
    if (this._timer !== null) return "already-scheduled";
    if (this._restarts >= this._maxRestarts) { this._giveUp(); return "dead"; }

    const scheduledGen = this._getGeneration();
    const delay = this._delayFor(this._restarts);
    console.warn(
      `[Voice][reconnect-supervisor] scheduling supervised restart ` +
      `#${this._restarts + 1}/${this._maxRestarts} in ${delay}ms (gen=${scheduledGen}).`,
    );
    this._timer = this._setTimer(() => { this._fire(scheduledGen); }, delay);
    return "scheduled";
  }

  private _fire(scheduledGen: number) {
    this._timer = null;
    if (this._dead) return;

    // GENERATION GUARD: if the connection moved on since we scheduled — the client
    // reconnected on its own, or the session was stopped/restarted elsewhere — a
    // restart now would DOUBLE-CONNECT. Step aside and treat it as recovery.
    const currentGen = this._getGeneration();
    if (currentGen !== scheduledGen) {
      console.log(
        `[Voice][reconnect-supervisor] generation advanced ` +
        `(${scheduledGen} → ${currentGen}) before restart fired — the client ` +
        `recovered on its own; NO-OP (no double-connect).`,
      );
      this._onHealthy();
      return;
    }

    // Already healthy again (a late confirmation) → nothing to do.
    if (this._isConnected()) { this._onHealthy(); return; }

    this._restarts++;
    console.warn(
      `[Voice][reconnect-supervisor] restart attempt #${this._restarts}/${this._maxRestarts} — re-initializing voice session.`,
    );
    this._restart()
      .then(() => {
        if (this._isConnected()) {
          console.log(`[Voice][reconnect-supervisor] restart #${this._restarts} confirmed healthy.`);
          this._onHealthy();
        }
        // If not connected yet, the client owns per-drop retries on the FRESH
        // session; if THAT exhausts, another voice.reconnect_failed re-enters here.
      })
      .catch((e: any) => {
        console.error(
          `[Voice][reconnect-supervisor] restart #${this._restarts} threw: ${e?.message ?? e}. ` +
          `Waiting for the next voice.reconnect_failed.`,
        );
      });
  }

  /** Confirmed health: reset the supervised-restart budget. */
  private _onHealthy() {
    if (this._restarts !== 0) {
      console.log(`[Voice][reconnect-supervisor] session healthy — resetting supervised restart counter (was ${this._restarts}).`);
    }
    this._restarts = 0;
  }

  /**
   * External health signal (e.g. `voice.started` from a normal (re)start). Clears
   * any pending scheduled restart and resets the budget — the session is up again.
   * Also revives a supervisor that had given up (a manual restart is a fresh lease).
   */
  notifyHealthy() {
    if (this._timer !== null) { this._clearTimer(this._timer); this._timer = null; }
    this._dead = false;
    this._onHealthy();
  }

  private _giveUp() {
    this._dead = true;
    console.error(
      `[Voice][reconnect-supervisor] hard cap hit (${this._maxRestarts} restarts) — giving up. Voice is DOWN.`,
    );
    this._onDead?.({ restarts: this._restarts });
  }

  /** Cancel any pending restart (intentional stop). */
  cancel() {
    if (this._timer !== null) { this._clearTimer(this._timer); this._timer = null; }
  }
}

export class VoiceModule {
  private client: RealtimeClient;
  private context: SharedContext;
  private onToolCall?: VoiceModuleOptions["onToolCall"];
  private _transcriptBuffer = "";
  private _lastInstructions = "";
  private _allTools: RealtimeTool[] = [];  // Full tool set (immutable reference)
  private _provider: VoiceProviderName = "openai";

  // Audio state machine
  private _audioState: AudioState = "idle";
  private _audioStateTs: number = 0;
  private _presentationMode = false;
  private _lastAudioOutputTs: number = 0;  // When AI last produced audio (for echo debounce)

  // Response gate: the SINGLE-OWNED VoiceResponseScheduler (P1 STEP 1). It is
  // the sole authority for triggering response.create — acceptance, the single
  // pending slot, the debounce, and the honest disposition all live in one
  // place. It replaces the former dual gate (this module's _responseActive +
  // _pendingResponseCreate AND RealtimeClient's _isSpeaking + its own
  // _pendingResponseCreate + debounce), which could disagree.
  private _scheduler!: VoiceResponseScheduler;

  // Delegating accessors → the scheduler is the single source of truth for
  // "a response is active" and for the single pending slot. Kept as named
  // accessors so existing call sites (checkResponseWatchdog) and tests that
  // read/poke _responseActive / _pendingResponseCreate keep working unchanged.
  private get _responseActive(): boolean { return this._scheduler.active; }
  private set _responseActive(v: boolean) { this._scheduler.active = v; }
  private get _pendingResponseCreate(): any { return this._scheduler.pending; }
  private set _pendingResponseCreate(v: any) { this._scheduler.pending = v; }

  // ── Response watchdog (ACTING — s1s2 §5) ──
  // Detects a response stuck in thinking/interrupted (or _responseActive) with
  // no audio deltas for longer than MAX_RESPONSE_MS — the mute-forever failure
  // mode (e.g. missing response.done after a barge-in response.cancel). It now
  // ACTS: force the single scheduler gate back to idle, flush any pending, return
  // to listening — BUT only when the stuck response still belongs to the current
  // connection generation (a reconnect that superseded it must win; the watchdog
  // never truncates a NEWER generation's response).
  private static readonly MAX_RESPONSE_MS = 30000;   // stuck threshold (N)
  private static readonly WATCHDOG_TICK_MS = 5000;   // poll cadence
  private _watchdogTimer: ReturnType<typeof setInterval> | null = null;
  // Observe/enforce valve (s1s2 §12). Defaults to the module-level env read;
  // overridable per-instance (tests, or a future per-session toggle). In
  // "observe" the watchdog logs what it WOULD do and returns without acting.
  private _watchdogMode: WatchdogMode = WATCHDOG_MODE;

  // ── User-turn counter (P1 STEP 2 — the turn-lease clock) ──
  // A lightweight MONOTONIC counter incremented on each user utterance (voice
  // transcription completed) and each typed user turn (sendText). It is the
  // clock the deliberate-result turn-lease reads: a producer stamps the CURRENT
  // value into `DeliberateResult.sourceTurnId` AT DISPATCH; the sink compares it
  // to this counter's value at DELIVERY to decide speak-now vs inject-silent vs
  // drop (see classifyStaleness). Deliberately NOT reset per meeting — a stale
  // envelope from a previous meeting keeps a LARGE turn delta (→ stale/drop),
  // whereas resetting to 0 would make an old sourceTurnId look "fresh" again.
  private _userTurnId = 0;

  // ── Deliberate-result idempotency (dedup by PER-DISPATCH id) ──
  // Bounded, insertion-ordered. Keys on DeliberateResult.id (unique per
  // dispatch), NOT replaceId (which is the intended in-place-update key — two
  // envelopes sharing a replaceId is a replace, not a duplicate).
  private _seenDeliberateIds: string[] = [];
  private static readonly MAX_SEEN_DELIBERATE = 200;

  // Heard transcript tracking (interruption truncation)
  private _currentResponseAudioSamples = 0;  // Total samples received from provider
  private _currentResponseStartTime = 0;      // When first audio chunk arrived
  private _currentResponseTranscript = "";     // Accumulated transcript for heard tracking

  // Voice path tracing (observability)
  private _tracer = new VoiceTracer();

  // External callback for speech-started (registered via onSpeechStarted())
  private _onSpeechStarted?: () => void;

  // Post-tool screenshot feedback: called after visual tools complete to auto-inject screen state
  private _onScreenCapture?: () => Promise<{ screenshot: string; caption: string } | null>;

  get connected() {
    return this.client.connected;
  }

  /** Which voice provider is currently active */
  get provider(): VoiceProviderName {
    return this._provider;
  }

  /** Current connection generation-token (delegated to the client). The reconnect
   *  supervisor captures this when it schedules a restart and no-ops if it has
   *  advanced by fire time (the client reconnected on its own → no double-connect). */
  get connectionGeneration(): number {
    return this.client.connectionGeneration;
  }

  /** Provider capability flags (interruption, native tools, etc.) */
  get capabilities(): ProviderCapabilities {
    return this.client.capabilities;
  }

  /** Current audio state (idle, listening, speaking, interrupted, thinking) */
  get audioState(): AudioState {
    return this._audioState;
  }

  /** Timestamp of the last audio state transition */
  get audioStateTimestamp(): number {
    return this._audioStateTs;
  }

  /** Monotonic user-turn counter — the turn-lease clock (see _userTurnId).
   *  A deliberate producer stamps this into DeliberateResult.sourceTurnId at
   *  dispatch; the sink compares it to the value here at delivery. */
  get userTurnId(): number {
    return this._userTurnId;
  }

  /** Enable/disable presentation mode — when true, slow tools are awaited instead of async */
  set presentationMode(on: boolean) {
    this._presentationMode = on;
    console.log(`[Voice] Presentation mode: ${on ? "ON" : "OFF"}`);
  }
  get presentationMode(): boolean { return this._presentationMode; }

  /** Voice path tracer for observability metrics */
  get tracer(): VoiceTracer { return this._tracer; }

  private _setAudioState(state: AudioState) {
    if (this._audioState !== state) {
      const prev = this._audioState;
      this._audioState = state;
      this._audioStateTs = Date.now();
      // Sync speaking state to client for response.create queue management
      this.client.setSpeaking(state === "speaking");
      console.log(`[Voice] Audio state: ${prev} → ${state}`);
    }
  }

  /**
   * Gated response.create — now a thin wrapper over the single-owned
   * VoiceResponseScheduler (the SOLE authority). The scheduler defers while a
   * response is active/speaking (instead of colliding — the provider rejects
   * concurrent creates and the trigger is lost, the classic "did the action,
   * said nothing"), keeps ONE pending slot with explicit replace-latest +
   * coalesce-identical, and debounces in one place. Returns the honest
   * disposition; most internal callers ignore it.
   */
  private _requestResponse(payload: any = {}): ResponseDisposition {
    return this._scheduler.request(payload);
  }

  /**
   * Inject a system instruction and trigger the AI to speak it.
   * Use for fillers and task narration — unlike sendText() this does NOT
   * fabricate a user message (which polluted the transcript and re-triggered
   * the auditor/retriever pipelines on the system's own filler).
   */
  speakWithInstruction(instruction: string): boolean {
    if (!this.client.connected) return false;
    if (this.client.providerName === "gemini") {
      // Gemini auto-responds to injected context; response.create is a no-op
      this.client.injectContext(`[SYSTEM] ${instruction}`);
      return true;
    }
    this._requestResponse({ response: { instructions: instruction } });
    return true;
  }

  /**
   * PUBLIC System-2 → System-1 response sink (P0.1 — the blocker fix).
   *
   * A deliberate (slow-brain) producer — e.g. TranscriptAuditor research
   * completion — has ALREADY injected its result into Layer 3 (via
   * injectContext / replaceContext). This method triggers exactly ONE gated
   * voice response so the model actually speaks that result:
   *   - idle              → fires response.create now
   *   - thinking/speaking → defers via the EXISTING _requestResponse gate
   *     (_pendingResponseCreate), which flushes on the next response.done
   *
   * It reuses _requestResponse's gating — no new queue, no reach into the
   * private client, no phantom method (the previous research hook-back call site
   * invoked a nonexistent client-side queue-pending-response method and threw a
   * TypeError in the common non-idle case, which injected a FALSE "failed" note
   * while the real answer sat unspoken in Layer 3).
   *
   * Kept intentionally minimal — P1 subsumes this into a VoiceResponseScheduler.
   *
   * @returns false when there is no live session (or the request was explicitly
   *          dropped), true when the (gated) trigger was issued or honestly
   *          deferred to fire on the next idle transition.
   */
  requestDeliberateResponse(instruction?: string): boolean {
    // Optional EPHEMERAL one-turn instruction (§4.3): rides along as
    // response.create's `response.instructions`, so it applies to THIS response
    // only and is NEVER persisted to Layer 3 (mirrors speakWithInstruction). Bare
    // `{}` when absent. This is how a guarded imperative ("follow up NOW … else
    // stay silent") is delivered without lingering to re-fire on later turns.
    const payload = instruction ? { response: { instructions: instruction } } : {};
    const disposition = this._scheduler.request(payload);
    // Honest: "response-requested" (sent now) and "deferred" (will fire on the
    // next idle) both count as "issued". "no-session" and the explicit drops
    // ("dropped-debounced" / "dropped-superseded") do NOT — we never report a
    // dropped payload as success.
    return disposition === "response-requested" || disposition === "deferred";
  }

  // ── THE unified System-2 → System-1 sink (P1 STEP 2, §4.2) ────────────────

  private _isDuplicateDeliberate(r: DeliberateResult): boolean {
    return !!r.id && this._seenDeliberateIds.includes(r.id);
  }
  private _markDeliberateSeen(r: DeliberateResult): void {
    if (!r.id || this._seenDeliberateIds.includes(r.id)) return;
    this._seenDeliberateIds.push(r.id);
    if (this._seenDeliberateIds.length > VoiceModule.MAX_SEEN_DELIBERATE) {
      this._seenDeliberateIds.shift();
    }
  }

  /**
   * THE single public sink for every System-2 deliberate result (§4.2). Every
   * deliberate producer (research_task migrated in P1 STEP 2; recall_context,
   * ContextRetriever, action-completion in the NEXT steps — see the seams at the
   * bottom of this file) builds a `DeliberateResult` envelope and calls THIS.
   * No producer touches `client`, `response.create`, `injectContext`,
   * `replaceContext`, or a staleness prompt directly anymore.
   *
   * Owns, in ONE auditable place:
   *   1. Sentinel safety FIRST — a producer FAILURE must never be spoken as an
   *      answer. `error` (or a short error-shaped payload) → inject a brief
   *      neutral INTERNAL note (never the error string as fact) and return
   *      "error-suppressed". No speech is ever triggered.
   *   2. Idempotency — a redelivered PER-DISPATCH id returns "dropped-duplicate".
   *   3. DETERMINISTIC turn-lease staleness (PRIMARY, not a model prompt) —
   *      classifyStaleness compares the dispatch-time user-turn id to the
   *      current one. Decided BEFORE injecting (codex: never inject-then-drop):
   *      "drop" → NOT injected, return "dropped-stale".
   *   4. Injection-layer choice — replaceId → replaceContext (in-place, no FIFO
   *      growth); else injectContext (FIFO, Layer-3 budget evicts).
   *   5. Speak vs silent — fresh proactive routes the (gated) trigger through
   *      the SINGLE VoiceResponseScheduler authority (P1 STEP 1), which defers
   *      if a response is active/speaking. Late/silent → injected only.
   *
   * Returns the honest DeliveryDisposition.
   */
  deliverDeliberateResult(result: DeliberateResult): DeliveryDisposition {
    // (0) No live session — nothing to inject or speak.
    if (!this.client.connected) return "no-session";

    // (1) SENTINEL SAFETY FIRST. Uniform: a producer's failure is rendered as a
    //     neutral internal note (honoring replaceId so it can replace a partial),
    //     never as spoken fact, and NEVER triggers speech.
    if (isDeliberateError(result)) {
      const note = renderErrorNote(result);
      if (note) {
        if (result.replaceId) this.replaceContext(note, result.replaceId);
        else this.injectContext(note);
      }
      return "error-suppressed";
    }

    // (2) Idempotency by per-dispatch id (NOT replaceId).
    if (this._isDuplicateDeliberate(result)) return "dropped-duplicate";

    // (3) DETERMINISTIC turn-lease staleness — decide BEFORE injecting.
    const decision = classifyStaleness({
      sourceTurnId: result.sourceTurnId,
      currentTurnId: this._userTurnId,
      dispatchedAt: result.dispatchedAt,
      speak: result.speak,
    });
    if (decision === "drop") {
      // Too old for even silent context. Record the id (a late duplicate is
      // still deduped) but do NOT inject — it would only pollute Layer 3.
      this._markDeliberateSeen(result);
      return "dropped-stale";
    }

    // (4) Injection-layer choice. replaceId → in-place replace; else FIFO.
    const text = renderDeliberateText(result, MAX_DELIBERATE_DETAIL_CHARS);
    if (result.replaceId) this.replaceContext(text, result.replaceId);
    else this.injectContext(text);
    this._markDeliberateSeen(result);

    // (5) Speak vs silent.
    if (decision === "inject-silent") return "injected-silent";

    // decision === "speak": route the gated trigger through the SINGLE scheduler
    // authority. It defers if a response is active/speaking (never collides). An
    // OPTIONAL ephemeral one-turn instruction (§4.3) rides along as
    // response.create's `response.instructions` — one-turn, NOT persisted to
    // Layer 3 — so a guarded imperative can't linger and re-fire on later turns.
    const speakPayload = result.instruction
      ? { response: { instructions: result.instruction } }
      : {};
    const disp = this._scheduler.request(speakPayload);
    switch (disp) {
      case "response-requested":
        return "response-requested";
      case "deferred":
        return "deferred";
      case "no-session":
        return "no-session";
      default:
        // Scheduler debounced/superseded the SPEECH trigger, but the result IS
        // injected — honest: the model picks it up on its next natural turn.
        return "injected-silent";
    }
  }

  /**
   * Build + route a recall_context RESULT through the ONE sink (P1 STEP 3).
   *
   * recall_context is a SLOW_TOOL: the tool-call MECHANICS are unchanged
   * (submit "ok" without a response, [WORKING] filler, execute async) — ONLY the
   * RETURN path moves here. On completion the SLOW_TOOL handler calls this
   * instead of the ad-hoc `injectContext("[DONE] recall_context: …")` +
   * `_requestResponse()`, so recall inherits the whole contract in ONE place:
   *   • kind:"recall", speak:"proactive" — the user explicitly asked, so the
   *     turn-lease is open (fresh → speak; moved-on → silent inject; stale → drop);
   *   • per-CALL replaceId (ctx_recall_<callId>) — no singleton clobber if the
   *     model fires two recalls in a row;
   *   • sentinel safety — a leaked dispatcher/gateway failure ("All channels
   *     failed" / "Gateway not available") or the handler's non-answer apology
   *     (isUnusableRecallResult) sets `error`, so the sink injects a neutral
   *     internal note and NEVER speaks the sentinel as if it were the answer
   *     (the audited "error-spoken-as-fact" bug).
   *
   * @param dispatchedAt ms epoch captured when the tool call ARRIVED (dispatch).
   * @param sourceTurnId user-turn id captured at dispatch (the turn-lease clock).
   * @param hardError    set on the async-reject path (the executor threw).
   */
  private deliverRecallResult(
    callId: string,
    query: string,
    result: string,
    dispatchedAt: number,
    sourceTurnId: number | undefined,
    hardError?: string,
  ): DeliveryDisposition {
    const error = hardError || (isUnusableRecallResult(result) ? result.slice(0, 200) : undefined);
    // One-line spoken-ready fallback summary: strip a leading "[Memory recall]"-
    // style tag, take the first non-empty line. `detail` carries the full body
    // and the sink renders detail || summary, so summary is only the fallback.
    const summary =
      result.replace(/^\s*\[[^\]]+\]\s*/, "").split("\n").find((l) => l.trim())?.trim().slice(0, 200) ||
      result.slice(0, 200) ||
      `Recall for "${query}".`;
    return this.deliverDeliberateResult({
      id: `recall_${callId}`,
      kind: "recall",
      summary,
      detail: result || undefined,
      sourceUtterance: query || undefined,
      sourceTurnId,
      dispatchedAt,
      speak: "proactive",
      replaceId: `ctx_recall_${callId}`,
      error,
    });
  }

  // ── SEAMS for the NEXT steps (intentionally left, not built here) ─────────
  //
  //  * DONE (P1 STEP 2) — research_task producer (transcript-auditor.ts).
  //  * DONE (P1 STEP 3) — recall_context producer (deliverRecallResult, above,
  //    wired from the SLOW_TOOL completion) + ContextRetriever producer
  //    (context-retriever.ts injectIntoVoice → { kind:"retrieval" }). All four
  //    deliberate RESULT paths that surface via voice now flow through the sink;
  //    the ONLY remaining producer is action/ComputerUse completion.
  //
  //  * QUICK-RECALL INLINE (codex nit, deferred SEAM): a genuinely sub-second
  //    "quick" recall that hits local memory could return inline as the REAL
  //    tool result (fast-tool path) instead of the async [WORKING]/[DONE] +
  //    sink path. Left as a seam: recall_context is in SLOW_TOOLS, so the
  //    inline short-circuit would have to peek at args.urgency BEFORE the
  //    slow/fast branch — a restructure of the tool-call dispatch on the live
  //    audio path, higher-risk than this step warrants. The async path is
  //    correct today; the optimization is latency-only.
  //
  //  * MIGRATE action/ComputerUse completion (notifyTaskCompletion,
  //    voice-persona.ts): build { kind:"action", speak:"silent" } — preserves
  //    方向A (never interrupt mid-sentence). Not in this step's file scope.
  //
  //  * CROSS-SOURCE COALESCING (§10, P2): a voice recall_context and an auditor
  //    research_task for the SAME question currently double-answer. The sink
  //    dedups by per-dispatch `id` only; a `DeliberateDispatcher` that coalesces
  //    by normalize(query) BEFORE dispatch is the read-only sibling of
  //    ActionOrchestrator. It would sit ABOVE the producers, not here.
  //
  //  * GENERATION-TOKENS (§4.2 / scheduler seam): the scheduler already notes a
  //    generation-id seam in onResponseCreated(). When added, deliverDeliberate-
  //    Result's "speak" branch would capture the generation at request time so a
  //    result whose gated response is later superseded by a barge-in can be
  //    dropped instead of firing into the wrong turn. (Turn-lease covers the
  //    common case today; generation-tokens tighten the barge-in race.)
  //
  //  * SINK-OWNED COMPLETION EMIT (P1.7): the sink should emit a single
  //    `deliberate.delivered { id, kind, disposition }` and producers drop their
  //    own completion emits. Deferred so the current research.* events (which the
  //    Stage S2 panel + tests consume) keep flowing during the migration.

  /**
   * ACTING response-state watchdog (s1s2 §5). Detects the stuck-response failure
   * mode — a response that is active (or the state machine sits in
   * thinking/interrupted) yet produces no further audio deltas — and RECOVERS the
   * loop: forces the single scheduler gate back to idle, flushes any pending
   * deferred response, and returns the state machine to `listening`.
   *
   * Stuck ⇔ (_responseActive OR audioState ∈ {thinking, interrupted}) AND no
   * state transition / audio delta for > MAX_RESPONSE_MS. Anchored on
   * _audioStateTs, widened with _lastAudioOutputTs so a legitimately long
   * streaming response (deltas still arriving) is NOT flagged as stuck — this is
   * the guard against truncating a healthy long stream.
   *
   * GENERATION GUARD (the safety foundation): the reset only fires when the stuck
   * response still belongs to the CURRENT connection generation. If a reconnect /
   * resume / liveness force-close advanced the generation, the stuck response
   * lived on a socket that no longer exists — resetting could interfere with a
   * NEWER generation's response, so the watchdog logs and steps aside (the
   * reconnect path already superseded it). This is the exact defense against
   * "truncate a response from a newer generation."
   *
   * The observe log is preserved (dogfood signal, §12).
   *
   * @param now injectable clock (defaults to Date.now()) for deterministic tests.
   * @returns true when the stuck condition was DETECTED (whether or not it acted).
   */
  checkResponseWatchdog(now: number = Date.now()): boolean {
    if (!this.client.connected) return false;
    const active =
      this._responseActive ||
      this._audioState === "thinking" ||
      this._audioState === "interrupted";
    if (!active) return false;
    // "no deltas": a healthy long response keeps updating _lastAudioOutputTs,
    // so anchoring on the more recent of the two timestamps avoids flagging it.
    const lastActivityTs = Math.max(this._audioStateTs, this._lastAudioOutputTs);
    const stuckMs = now - lastActivityTs;
    if (stuckMs <= VoiceModule.MAX_RESPONSE_MS) return false;

    // Preserve the observe signal (dogfooding / diagnosis).
    console.warn(
      `[Voice] watchdog: response appears stuck — ` +
      `state=${this._audioState}, _responseActive=${this._responseActive}, ` +
      `${stuckMs}ms since last activity (threshold ${VoiceModule.MAX_RESPONSE_MS}ms).`,
    );

    // GENERATION GUARD: only reset a response that still belongs to the current
    // connection. If a reconnect advanced the generation, step aside.
    const currentGen = this.client.connectionGeneration;
    const stuckGen = this._scheduler.responseGeneration;
    if (currentGen !== stuckGen) {
      console.warn(
        `[Voice] watchdog: NOT resetting — connection generation moved on ` +
        `(response gen=${stuckGen}, current gen=${currentGen}); a reconnect ` +
        `superseded this response.`,
      );
      return true; // detected, but not ours to reset
    }

    // OBSERVE valve (s1s2 §12): detected + logged, but DO NOT act. Lets a day of
    // real-meeting dogfooding surface false positives (a legit long response) BEFORE
    // flipping to enforce, without a code change (S1S2_WATCHDOG_MODE=observe).
    if (this._watchdogMode !== "enforce") {
      console.warn(
        `[Voice] watchdog (observe): WOULD reset stuck response (gen ${stuckGen}) → listening — log only, not acting.`,
      );
      return true;
    }

    // ACT: reset the single gate authority + flush pending, return to listening so
    // the next user turn is answered (recovers the mute-forever barge-in bug).
    console.warn(`[Voice] watchdog: resetting stuck response (gen ${stuckGen}) → listening.`);
    this._scheduler.recoverFromStuck();
    // Fix #2: the response-watchdog (VoiceModule) and the client's liveness gate
    // share NO signal otherwise. A stuck response that never received an inbound
    // `response.done` (e.g. after a barge-in `response.cancel`) leaves the client's
    // `_responseInFlight` stuck true — which keeps the liveness expectation gate
    // open and can force-close a HEALTHY-but-quiet socket. Tell the client the
    // response is resolved so the two agree. (Optional-chained: harmless on a test
    // fake that doesn't implement it.)
    this.client.notifyResponseResolved?.();
    if (this._audioState !== "idle") this._setAudioState("listening");
    return true;
  }

  private _startWatchdog() {
    if (this._watchdogTimer) return;
    this._watchdogTimer = setInterval(
      () => { try { this.checkResponseWatchdog(); } catch { /* watchdog must never throw on the timer */ } },
      VoiceModule.WATCHDOG_TICK_MS,
    );
    // Never keep the event loop alive solely for the watchdog.
    (this._watchdogTimer as any)?.unref?.();
  }

  private _stopWatchdog() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  constructor(options: VoiceModuleOptions) {
    this.client = new RealtimeClient();
    this.context = options.context;
    this.onToolCall = options.onToolCall;

    // Single-owned response gate. The callbacks read this.client at call time
    // (lazy) so field/constructor init order is irrelevant.
    this._scheduler = new VoiceResponseScheduler({
      isConnected: () => this.client.connected,
      send: (payload) => this.client.sendEvent("response.create", payload),
    });

    // Register tools
    if (options.tools) {
      this._allTools = [...options.tools];
      for (const tool of options.tools) {
        this.client.addTool(tool);
      }
    }

    // Wire up reconnect failure callback
    if (options.onReconnectFailed) {
      this.client.onReconnectFailed(options.onReconnectFailed);
    }

    this.setupEventHandlers();
  }

  private setupEventHandlers() {
    // ── Audio State: Session ready → listening ──
    this.client.on("session.updated", () => {
      this._setAudioState("listening");
    });

    // ── Audio State + Interruption: User starts speaking ──
    this.client.on("input_audio_buffer.speech_started", () => {
      // Echo debounce: ONLY suppress during active speaking or a brief tail after.
      // P0 FIX: must check _audioState === "speaking" — without this check,
      // real user speech within 1.5s of AI finishing gets blocked as "echo",
      // breaking the entire conversation loop.
      const msSinceLastOutput = Date.now() - this._lastAudioOutputTs;
      const echoThresholdMs = this._presentationMode ? 2000 : 800;
      if (this._audioState === "speaking" && msSinceLastOutput < echoThresholdMs) {
        console.log(`[Voice] Echo debounce: speech_started ${msSinceLastOutput}ms after last audio output (threshold: ${echoThresholdMs}ms, state: speaking) — ignoring`);
        return; // Skip this interruption — likely echo
      }

      // Trace: mark interruption if AI was speaking, then start new turn
      if (this._audioState === "speaking") {
        this._tracer.mark('interruptionTime');
        this._tracer.endTurn();
      }
      this._tracer.startTurn();
      this._tracer.mark('userSpeechStart');

      // Heard transcript truncation: calculate what user actually heard
      if (this._audioState === "speaking" &&
          this._currentResponseAudioSamples > 0 &&
          this._currentResponseStartTime > 0) {
        this._setAudioState("interrupted");

        const elapsedMs = Date.now() - this._currentResponseStartTime;
        const totalDurationMs = (this._currentResponseAudioSamples / 24000) * 1000;
        // heardRatio: how much of the audio timeline elapsed before interrupt
        // Account for 150ms initial buffer latency
        const heardRatio = Math.min(1, Math.max(0, (elapsedMs - 150) / totalDurationMs));

        if (heardRatio < 0.95 && this._currentResponseTranscript) {
          const heardLength = Math.floor(this._currentResponseTranscript.length * heardRatio);
          const heardText = this._currentResponseTranscript.slice(0, heardLength);

          if (heardText.length > 0) {
            // Check if the full transcript was already written to context
            const recent = this.context.getRecentTranscript(5);
            const lastAssistant = recent.filter(e => e.role === "assistant").pop();
            if (lastAssistant && lastAssistant.text === this._currentResponseTranscript) {
              // Add a correction entry noting what was actually heard
              const unheardText = this._currentResponseTranscript.slice(heardLength).trim();
              const recoveryHint = unheardText.length > 20
                ? ` You were cut off mid-response. Key undelivered point: "${unheardText.slice(0, 120)}..." — weave it into your next reply if relevant, don't repeat what was already heard.`
                : "";
              this.context.addTranscript({
                role: "system",
                text: `[HEARD] AI was interrupted at ${Math.round(heardRatio * 100)}%. User heard: "${heardText.slice(0, 100)}..."${recoveryHint}`,
                ts: Date.now(),
              });
            }
            console.log(`[Voice] Interrupt: heard ${Math.round(heardRatio * 100)}% of response (${heardText.length}/${this._currentResponseTranscript.length} chars)`);
          }
        }
      }

      // Commit any buffered audio, then cancel in-progress AI response
      this.client.sendEvent("input_audio_buffer.commit", {});
      // Only cancel if AI was actively responding (avoids "response_cancel_not_active" error)
      if (this._audioState === "speaking" || this._audioState === "thinking" || this._audioState === "interrupted") {
        const cancelled = this.client.sendEvent("response.cancel", {});
        if (!cancelled) {
          // Retry if WebSocket wasn't ready
          setTimeout(() => {
            if (this.client.connected && (this._audioState === "speaking" || this._audioState === "thinking")) {
              this.client.sendEvent("response.cancel", {});
              console.log("[Voice] Retry: sent delayed response.cancel");
            }
          }, 100);
        }
      }

      // Fire external speech-started callback
      if (this._onSpeechStarted) this._onSpeechStarted();
    });

    // ── Trace: User stops speaking ──
    this.client.on("input_audio_buffer.speech_stopped", () => {
      this._tracer.mark('userSpeechEnd');
    });

    // ── Audio State: Response created → thinking ──
    this.client.on("response.created", () => {
      // Scheduler owns the reconciled "active" state + resets its per-response
      // audio flags (single source of truth). Stamp the CURRENT connection
      // generation so the response-watchdog can tell (later) whether a stuck
      // response still belongs to this connection or was superseded by a reconnect.
      this._scheduler.onResponseCreated(this.client.connectionGeneration);
      this._setAudioState("thinking");
      this._tracer.mark('modelFirstToken');
      // Reset heard-transcript counters for new response
      this._currentResponseAudioSamples = 0;
      this._currentResponseStartTime = 0;
      this._currentResponseTranscript = "";
    });

    // ── Audio State + Heard Tracking: Audio streaming → speaking ──
    this.client.on("response.audio.delta", (event) => {
      // Track audio samples for heard-ratio calculation
      // event.delta is base64 PCM16, each sample is 2 bytes
      const b64len = (event.delta || "").length;
      const samples = Math.round(b64len * 3 / 4 / 2);
      this._currentResponseAudioSamples += samples;
      if (!this._currentResponseStartTime) this._currentResponseStartTime = Date.now();

      // Scheduler tracks "speaking" (audio playing) from the audio stream itself,
      // NOT from _setAudioState — so it stays true until audio.done even after
      // response.done flips state to listening. This is what makes a deferred
      // follow-up wait for BOTH done + audio.done (no truncation).
      this._scheduler.onAudioDelta();
      // Track last audio output for echo debounce
      this._lastAudioOutputTs = Date.now();

      // First audio chunk → transition to speaking
      if (this._audioState !== "speaking") {
        this._tracer.mark('modelFirstAudio');
        this._tracer.mark('ttsPlaybackStart');
        this._setAudioState("speaking");
      }
    });

    // ── Audio State: Response audio done → listening ──
    this.client.on("response.audio.done", () => {
      this._tracer.mark('ttsPlaybackEnd');
      this._tracer.endTurn();
      this._setAudioState("listening");
      // Scheduler: audio finished playing → clears "speaking"; flushes the single
      // deferred payload iff the response is now fully idle (both done).
      this._scheduler.onAudioDone();
    });

    this.client.on("response.done", (event: any) => {
      // Track token usage for observability
      if (event?.usage) {
        this._tracer.recordTokens(event.usage.input_tokens || 0, event.usage.output_tokens || 0);
      }
      // Only go to listening if we're not already idle (disconnected)
      if (this._audioState !== "idle") {
        this._setAudioState("listening");
      }
      // Scheduler: response generation finished → clears "active"; flushes the
      // single deferred payload iff now fully idle (audio also done). One owner,
      // one pending slot, unified "flush on idle" (was two racing flush paths).
      this._scheduler.onResponseDone();
    });

    // ── Live Transcript: User speech ──
    // Event name is the same for both providers
    this.client.on("conversation.item.input_audio_transcription.completed", (event) => {
      if (event.transcript) {
        // Turn-lease clock: a completed user utterance is a new user turn.
        this._userTurnId++;
        this.context.addTranscript({
          role: "user",
          text: event.transcript,
          ts: Date.now(),
        });
        console.log(`[Voice] User: ${event.transcript}`);

        // Feed transcript to RealtimeClient for context replay on reconnect
        this._feedTranscriptContext();
      }
    });

    // ── Live Transcript: AI speech ──
    // Grok: response.output_audio_transcript.* → normalized to response.audio_transcript.*
    this.client.on("response.audio_transcript.delta", (event) => {
      this._transcriptBuffer += event.delta || "";
      // Accumulate for heard-ratio tracking (separate from _transcriptBuffer which resets)
      this._currentResponseTranscript += event.delta || "";
    });

    this.client.on("response.audio_transcript.done", (event) => {
      const text = event.transcript || this._transcriptBuffer;
      if (text) {
        this.context.addTranscript({
          role: "assistant",
          text,
          ts: Date.now(),
        });
        console.log(`[Voice] AI: ${text}`);

        // Feed transcript to RealtimeClient for context replay on reconnect
        this._feedTranscriptContext();
      }
      this._transcriptBuffer = "";
    });

    // ── Tool Calls ──
    // Event name is the same for both providers
    this.client.on("response.function_call_arguments.done", async (event) => {
      const { call_id, name, arguments: argsStr } = event;
      let args: any;
      try {
        args = JSON.parse(argsStr);
      } catch {
        // Submit an error result the model can repair instead of silently
        // executing the tool with empty arguments (e.g. open_file({}))
        console.warn(`[Voice] Tool ${name} arguments unparseable: ${String(argsStr).slice(0, 120)}`);
        // Submit the error output WITHOUT a bundled response.create, then route
        // the retry-triggering response through the single scheduler authority
        // (so it's gated against colliding with an active response, and there's
        // no second response.create trigger outside the scheduler).
        this.client.submitToolResultBackground(call_id, `Error: malformed tool arguments (invalid JSON). Retry the ${name} call with valid arguments.`);
        this._requestResponse({});
        return;
      }

      console.log(`[Voice] Tool call: ${name}`, args);
      this._tracer.recordTool(name);

      // Record in transcript
      this.context.addTranscript({
        role: "system",
        text: `[Tool Call] ${name}(${JSON.stringify(args)})`,
        ts: Date.now(),
      });

      if (SLOW_TOOLS.has(name)) {
        // Slow tool handling depends on context:
        // - During presentation: await result (so voice waits for action to complete)
        // - During normal conversation: acknowledge immediately, execute async
        const awaitSlow = this._presentationMode;

        if (awaitSlow) {
          // Presentation mode: await the slow tool so voice and screen stay in sync
          console.log(`[Voice] Slow tool ${name} — awaiting (presentation mode)`);
          let result = "Action completed.";
          if (this.onToolCall) {
            try {
              result = await this.onToolCall(name, args, call_id);
            } catch (e: any) {
              result = `Error: ${e.message}`;
            }
          }
          // Submit output without a bundled create, then trigger via the
          // scheduler (single authority; gated so it can't collide).
          this.client.submitToolResultBackground(call_id, result);
          this._requestResponse({});
          this.context.addTranscript({
            role: "system",
            text: `[Tool Result] ${name}: ${result.slice(0, 200)}`,
            ts: Date.now(),
          });
        } else {
          // Normal conversation: background result pattern (inspired by OpenAI Agents SDK)
          // 1. Submit tool result WITHOUT triggering response (backgroundResult)
          this.client.submitToolResultBackground(call_id, "ok");

          // 2. Silent inject filler context — NO response.create (方向A: never interrupt speech)
          // The model will see this on its next turn (after current speech finishes or user speaks)
          this.injectContext(`[WORKING] Running "${name}"...`);

          // Capture the turn-lease clock AT DISPATCH (tool-call arrival) for
          // deliberate producers routed through the sink (recall_context). The
          // sink compares sourceTurnId (here) to the CURRENT userTurnId when the
          // slow result lands to decide speak-now vs inject-silent vs drop.
          const deliberateDispatchedAt = Date.now();
          const deliberateSourceTurnId = this._userTurnId;
          const recallQuery = typeof args?.query === "string" ? args.query : "";

          // 3. Execute async — inject result when ready (1500-char cap: a 200-char
          // slice destroyed multi-line results like open_file's candidate list).
          if (this.onToolCall) {
            this.onToolCall(name, args, call_id).then(async (result) => {
              // recall_context (P1 STEP 3): route the RESULT through the ONE
              // unified sink — kind:"recall", speak:"proactive", per-call
              // replaceId, sentinel-suppressed. The sink owns injection-layer
              // choice, the gated response trigger, staleness, dedup, and
              // (critically) never speaks a leaked failure sentinel as fact.
              // The tool-call mechanics above (submit "ok", [WORKING] filler,
              // async work) are UNCHANGED — only the return path moved here.
              if (name === "recall_context") {
                this.context.addTranscript({
                  role: "system",
                  text: `[Tool Result] ${name}: ${result.slice(0, 200)}`,
                  ts: Date.now(),
                });
                const disp = this.deliverRecallResult(
                  call_id, recallQuery, result, deliberateDispatchedAt, deliberateSourceTurnId,
                );
                console.log(`[Voice] recall_context result → sink (${disp})`);
                return;
              }

              const capped = result.length > 1500 ? result.slice(0, 1500) + "\n…(truncated)" : result;
              this.injectContext(`[DONE] ${name}: ${capped}`);
              this.context.addTranscript({
                role: "system",
                text: `[Tool Result] ${name}: ${result.slice(0, 200)}`,
                ts: Date.now(),
              });
              // Perception-action loop: screenshot BEFORE triggering the response
              // so the model narrates what the screen actually shows now —
              // unawaited, the image only informed the NEXT turn.
              await this._feedbackScreenshot(name).catch(() => {});
              // Trigger model to process the result and decide next action.
              // Without this, the model sees the context but won't speak or call another tool.
              // This is what closes the agent loop for slow tools.
              this._requestResponse({});
              console.log(`[Voice] Slow tool ${name} completed async → triggered response`);
            }).catch((e: any) => {
              // recall_context failure also flows through the sink (error set →
              // neutral internal note, never a spoken "[ERROR] … failed").
              if (name === "recall_context") {
                this.context.addTranscript({
                  role: "system",
                  text: `[Tool Result] ${name}: Error: ${e.message}`,
                  ts: Date.now(),
                });
                this.deliverRecallResult(
                  call_id, recallQuery, "", deliberateDispatchedAt, deliberateSourceTurnId, e.message,
                );
                console.error(`[Voice] recall_context failed → sink (error-suppressed):`, e.message);
                return;
              }
              this.injectContext(`[ERROR] ${name} failed: ${e.message}`);
              this.context.addTranscript({
                role: "system",
                text: `[Tool Result] ${name}: Error: ${e.message}`,
                ts: Date.now(),
              });
              this._requestResponse({});
              console.error(`[Voice] Slow tool ${name} failed → triggered response:`, e.message);
            });
          }
        }
      } else {
        // Fast tool — await inline (existing behavior)
        let result = "No handler registered";
        if (this.onToolCall) {
          try {
            result = await this.onToolCall(name, args, call_id);
          } catch (e: any) {
            result = `Error: ${e.message}`;
          }
        }

        // Submit the tool output WITHOUT a bundled response.create, then route
        // the response through the single scheduler authority (preserves the
        // "fast tool completes → gated response" behavior; no second trigger).
        this.client.submitToolResultBackground(call_id, result);
        this._requestResponse({});

        // Auto-inject screenshot if this was a visual tool
        this._feedbackScreenshot(name).catch(() => {});

        // Record result in transcript
        this.context.addTranscript({
          role: "system",
          text: `[Tool Result] ${name}: ${result.slice(0, 200)}`,
          ts: Date.now(),
        });
      }
    });
  }

  /** Feed recent transcript entries to RealtimeClient for reconnect context replay */
  private _feedTranscriptContext() {
    const recent = this.context.getRecentTranscript(20);
    this.client.updateTranscriptContext(
      recent.map((e) => ({ role: e.role, text: e.text }))
    );
  }

  /**
   * Start the voice session.
   * @param instructions System prompt (optional — uses default if not provided)
   * @param provider Which voice provider to use (optional — uses CONFIG.voiceProvider)
   */
  async start(instructions?: string, provider?: VoiceProviderName) {
    this._provider = provider || CONFIG.voiceProvider;

    // Validate API key for selected provider
    if (this._provider === "gemini") {
      if (!CONFIG.gemini.apiKey) {
        throw new Error("Google AI API key not configured (set GOOGLE_AI_API_KEY in .env)");
      }
    } else if (this._provider === "grok") {
      if (!CONFIG.grok.apiKey) {
        throw new Error("Grok API key not configured (set XAI_API_KEY in .env)");
      }
    } else {
      if (!CONFIG.openai.apiKey) {
        throw new Error("OpenAI API key not configured");
      }
    }

    const systemPrompt =
      instructions ||
      `You are CallingClaw, an AI meeting assistant with voice, vision, and computer control capabilities.
You can:
- Schedule and join Google Meet meetings
- See the user's screen and understand what's happening
- Control the computer (click, type, scroll) to help with presentations
- Take meeting notes and track action items

Speak naturally and concisely. When you perform actions, briefly narrate what you're doing.`;

    this._lastInstructions = systemPrompt;
    await this.client.connect(systemPrompt, this._provider);
    // Start the (acting, generation-guarded) response watchdog for this session.
    this._startWatchdog();
    console.log(`[Voice] Session started (provider: ${this._provider})`);
  }

  /**
   * Dynamically update the Voice AI's system instructions.
   * Only works while a session is active.
   */
  updateInstructions(instructions: string): boolean {
    if (!this.client.connected) return false;
    this._lastInstructions = instructions;
    return this.client.updateInstructions(instructions);
  }

  /** Get the last system instructions sent to the Voice AI */
  getLastInstructions(): string {
    return this._lastInstructions;
  }

  /** Get all registered tools (the full set, regardless of what's active on the session) */
  getAllTools(): RealtimeTool[] {
    return [...this._allTools];
  }

  /**
   * Update which tools are active on the Realtime session.
   * Used by TranscriptAuditor to remove automation tools during meetings.
   */
  setActiveTools(tools: RealtimeTool[]): boolean {
    if (!this.client.connected) return false;
    return this.client.updateTools(tools);
  }

  /** Restore all tools to the session (call when meeting ends) */
  restoreAllTools(): boolean {
    return this.setActiveTools([...this._allTools]);
  }

  // ── Incremental Context Injection ─────────────────────────────────

  /**
   * Inject context into the live voice session as a system message.
   * Does NOT interrupt the current response or trigger a new one.
   * Uses conversation.item.create instead of session.update to avoid audio breaks.
   *
   * @param text - Context text (e.g., "[CONTEXT] PRD目标是..." or "[DONE] 已打开文件")
   * @param id - Optional stable item id (enables replace-by-removeContext);
   *             previously dropped, which made removeContext("ctx_stage_docs")
   *             a no-op and stage-doc items accumulate
   * @returns The item ID if sent, false if not connected
   */
  injectContext(text: string, id?: string): string | false {
    if (!this.client.connected) return false;
    return this.client.injectContext(text, id);
  }

  /**
   * Inject context with a fixed ID — replaces previous injection with the same ID.
   * Used for page DOM context that should show only the LATEST state,
   * not accumulate in the FIFO queue.
   */
  replaceContext(text: string, id: string): string | false {
    if (!this.client.connected) return false;
    this.client.removeContext(id);
    return this.client.injectContext(text, id);
  }

  /**
   * Inject a screenshot into the voice model's conversation.
   * Provider-aware: openai15/gemini get actual images, others get text caption.
   *
   * @param base64Jpeg - Base64-encoded JPEG (no data: prefix needed)
   * @param caption - Optional text description alongside the image
   * @returns The item ID if sent, false if not connected
   */
  injectScreenshot(base64Jpeg: string, caption?: string): string | false {
    if (!this.client.connected) return false;
    return this.client.injectImage(base64Jpeg, caption);
  }

  /**
   * Remove a previously injected context item by ID.
   * @returns true if the delete was sent
   */
  removeContext(itemId: string): boolean {
    if (!this.client.connected) return false;
    return this.client.removeContext(itemId);
  }

  /** Get the current context injection queue (for debugging/status) */
  getContextQueue(): readonly ContextItem[] {
    return this.client.getContextQueue();
  }

  /** Dynamically change the voice on the live session */
  setVoice(voice: string): boolean {
    if (!this.client.connected) return false;
    return this.client.updateVoice(voice);
  }

  /**
   * Stop the voice session (intentional disconnect — no auto-reconnect)
   */
  stop() {
    this._stopWatchdog();
    this._scheduler.reset(); // drop any pending deferred response + clear gate state
    this.client.disconnect();
    this._setAudioState("idle");
  }

  /**
   * Reset session state for a new meeting.
   * Clears all injected context and conversation history so the next meeting
   * starts fresh. Does NOT disconnect — voice stays connected for continuity.
   */
  resetForNewMeeting() {
    // Clear all injected context items (Layer 2 + Layer 3)
    this.client.clearContextQueue();
    // Reset the response gate (drop any stale pending deferred response so a new
    // meeting never inherits the previous meeting's queued trigger).
    this._scheduler.reset();
    // Reset audio state tracking
    this._currentResponseAudioSamples = 0;
    this._currentResponseStartTime = 0;
    this._currentResponseTranscript = "";
    this._lastAudioOutputTs = 0;
    this._presentationMode = false;
    this._setAudioState("listening");
    // Force a fresh session.update to reset server-side state
    if (this.client.connected && this._lastInstructions) {
      this.client.updateInstructions(this._lastInstructions);
      console.log("[Voice] Session reset for new meeting (context cleared, instructions refreshed)");
    }
  }

  /**
   * Send audio chunk from capture pipeline (Chrome WebSocket or Python sidecar).
   * Server-side echo gate: drop audio when AI is speaking or just finished speaking.
   * This prevents Zoom/Meet SFU echo from reaching the Realtime API's VAD,
   * which would otherwise fire speech_started and cancel the AI response.
   */
  private _echoGateDropped = 0;
  private _sendAudioLogCount = 0;
  sendAudio(base64Pcm: string) {
    if (++this._sendAudioLogCount % 200 === 1) {
      console.log(`[Voice] sendAudio called #${this._sendAudioLogCount} (state=${this._audioState}, connected=${this.client.connected})`);
    }
    if (!this.client.connected) return;

    // Echo gate: suppress audio input while AI is producing audio output.
    // Google Meet has built-in echo cancellation → short gate (300ms).
    // Zoom SFU echoes with 1-2s delay → needs longer gate.
    // Gate ONLY during speaking state + brief tail. NOT during listening
    // (that blocks real user speech and causes "no response" bug).
    const msSinceLastOutput = Date.now() - this._lastAudioOutputTs;
    if (this._audioState === "speaking" && msSinceLastOutput < 500) {
      this._echoGateDropped++;
      if (this._echoGateDropped === 1 || this._echoGateDropped % 500 === 0) {
        console.log(`[Voice] Echo gate: dropped ${this._echoGateDropped} audio chunks (state=${this._audioState}, ${msSinceLastOutput}ms since output)`);
      }
      return;
    }

    // Gate cleared — reset counter and send audio
    if (this._echoGateDropped > 0) {
      console.log(`[Voice] Echo gate cleared after ${this._echoGateDropped} dropped chunks`);
      this._echoGateDropped = 0;
    }
    this.client.sendAudio(base64Pcm);
  }

  /**
   * Send text message to voice AI.
   *
   * The user text item is created directly, but the response trigger is routed
   * through the single scheduler authority (instead of client.sendText()'s
   * bundled response.create) so ALL response.create decisions flow through one
   * gate. Behaviour on the happy path is unchanged: idle → responds now; if a
   * response is in-flight, it defers and fires on the next idle transition
   * (rather than colliding with the active response).
   */
  sendText(text: string) {
    if (!this.client.connected) return;
    // Turn-lease clock: a typed user message is a new user turn too.
    this._userTurnId++;
    this.context.addTranscript({ role: "user", text, ts: Date.now() });
    this.client.sendEvent("conversation.item.create", {
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    this._requestResponse({});
  }

  /**
   * Present a slide — inject talking points as system context, then trigger AI to speak.
   * Unlike sendText() (role:"user" → AI responds TO it), this uses role:"system"
   * so the AI presents FROM the content in its own words.
   */
  presentSlide(text: string, sectionTitle?: string) {
    this.context.addTranscript({ role: "system", text: `[Slide] ${(sectionTitle || text).slice(0, 100)}...`, ts: Date.now() });
    // Use replaceContext with fixed ID — only one slide in context at a time (EXP-7C finding)
    this.replaceContext(
      `[PRESENT NOW] ${sectionTitle ? sectionTitle + "\n\n" : ""}${text}`,
      "ctx_current_slide"
    );
    this._requestResponse({});
  }

  /**
   * Wait for current speech to complete.
   * Resolves when audioState transitions from "speaking" to "listening" or "idle",
   * or when timeoutMs elapses (fallback for missed events).
   * Used by PresentationEngine to wait for actual speech completion instead of fixed timers.
   */
  waitForSpeechDone(timeoutMs: number = 30000): Promise<void> {
    return new Promise((resolve) => {
      // Already not speaking — resolve immediately
      if (this._audioState !== "speaking" && this._audioState !== "thinking") {
        resolve();
        return;
      }

      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };

      // Listen for state change to listening/idle
      const checkInterval = setInterval(() => {
        if (this._audioState === "listening" || this._audioState === "idle") {
          clearInterval(checkInterval);
          done();
        }
      }, 200);

      // Timeout fallback
      setTimeout(() => {
        clearInterval(checkInterval);
        done();
      }, timeoutMs);
    });
  }

  /**
   * Send a raw Realtime API event (passthrough to client).
   * Used for conversation.item.create (caption injection) etc.
   */
  sendEvent(eventName: string, payload: any) {
    if (this.client.connected) {
      this.client.sendEvent(eventName, payload);
    }
  }

  /**
   * Get the underlying client for audio output forwarding.
   * Event name is normalized — works for both providers.
   */
  onAudioOutput(handler: (base64Pcm: string) => void) {
    this.client.on("response.audio.delta", (event) => {
      handler(event.delta);
    });
  }

  /**
   * Register handler for user speech interruption.
   * Called when VAD detects user started speaking — cancel AI response + stop playback.
   * The actual interrupt logic (response.cancel, heard-transcript truncation, state machine)
   * runs in setupEventHandlers(); this just registers the external callback.
   */
  onSpeechStarted(handler: () => void) {
    this._onSpeechStarted = handler;
  }

  /**
   * Register screen capture callback for post-tool visual feedback.
   * After visual tools (interact, scroll, navigate, open_file, share_screen) complete,
   * this callback is called to capture a screenshot and inject it to the voice model.
   * This closes the perception-action loop: model sees result of its actions.
   */
  onScreenCapture(handler: () => Promise<{ screenshot: string; caption: string } | null>) {
    this._onScreenCapture = handler;
  }

  /** Tools that change what's on screen — trigger screenshot feedback after completion */
  private static VISUAL_TOOLS = new Set([
    "interact", "browser_action", "share_screen", "open_file",
    "scroll_page", "click_element", "navigate", "exec",
    // The most screen-mutating tool of all was missing — multi-step computer
    // use completed with zero visual feedback to the voice model
    "computer_action",
  ]);

  /** Auto-inject screenshot after a visual tool completes */
  private async _feedbackScreenshot(toolName: string): Promise<void> {
    if (!this._onScreenCapture || !VoiceModule.VISUAL_TOOLS.has(toolName)) return;
    try {
      const result = await this._onScreenCapture();
      if (result?.screenshot) {
        this.injectScreenshot(result.screenshot, `[SCREEN_UPDATE] after ${toolName}: ${result.caption}`);
        console.log(`[Voice] Post-tool screenshot injected (${toolName})`);
      }
    } catch (e: any) {
      // Non-fatal — screenshot feedback is best-effort
      console.warn(`[Voice] Post-tool screenshot failed: ${e.message}`);
    }
  }
}
