// CallingClaw 2.0 — CostMeter (per-meeting, per-component cost attribution)
//
// PURPOSE
//   Record ACTUAL token usage per COMPONENT per meeting and estimate USD via a
//   rate table, so the team can build a GTM/pricing model from real data.
//
//   Components attributed:
//     voice         — OpenAI Realtime / Gemini Live / Grok (RealtimeClient)
//     vision        — Gemini Flash / Claude Haiku / gpt-4o-mini (VisionModule)
//     context       — Haiku ContextRetriever (gap detection + agentic search)
//     auditor       — Haiku TranscriptAuditor (intent classification)
//     computer_use  — Haiku (in-meeting) / Sonnet (off-meeting) ComputerUseModule
//     agent         — the user's personal AgentAdapter (OpenClaw / Claude Code /
//                     Codex / Hermes). Stated to be the DOMINANT cost — captured
//                     with EXACT reported USD when the CLI provides it
//                     (claude -p --output-format json → total_cost_usd), else via
//                     the rate table, else counted as a call with tokens unknown.
//
// DESIGN
//   • Fully fail-soft: a metering failure must NEVER break a meeting. Every public
//     method wraps its body in try/catch and degrades to a no-op.
//   • Decoupled wiring: model-calling modules call the module-level `recordUsage()`
//     helper (forwards to the installed active meter) so they never need a meter
//     reference threaded through their constructors.
//   • Attribution (precedence, most-specific first):
//       1. event.meetingId              — caller passes it explicitly
//       2. withAttribution() scope       — AsyncLocalStorage id set by the
//          dispatcher around an async agent call (survives await boundaries).
//          This is how PRE-JOIN prep and POST-MEETING summary/timeline work
//          are pinned to the CORRECT meeting even though the mutable "active
//          meeting" has moved on (e.g. a back-to-back meeting already started).
//       3. active meeting                — set via setActiveMeeting on
//          meeting.started; CLEARED on meeting.ended (endActiveMeeting) so
//          pre-join prep for the NEXT meeting can never be billed to the
//          just-ended one.
//       4. default bucket                — "unattributed-prep" for the `agent`
//          component (idle agent work is almost always pre-join prep), else
//          "unattributed". A misattribution here is honest noise; it can never
//          corrupt a real meeting's total.
//     Post-meeting agent work MUST therefore be wrapped in withAttribution() by
//     its dispatcher (see callingclaw.ts meeting.ended / autoLeaveMeeting).
//     Residual limitation: prep dispatched by a caller that does NOT wrap it in
//     withAttribution (HTTP endpoint / scheduler / voice tool) lands in
//     "unattributed-prep" rather than its target meeting — but is never billed
//     to the wrong (previous) meeting.
//
// PERSISTENCE
//   On meeting end, one JSONL line PER MEETING is appended to
//   ~/.callingclaw/shared/cost-log/cost-log.jsonl  (dir auto-created).
//   One line per meeting (not per event) keeps the log directly loadable as a
//   per-meeting table for pricing analysis. See MeetingCostRecord for the schema.

import { homedir } from "os";
import { resolve } from "path";
import { mkdirSync, appendFileSync } from "fs";
import { AsyncLocalStorage } from "node:async_hooks";

/** Default bucket for `agent` usage recorded while no meeting is active/scoped. */
export const UNATTRIBUTED_PREP = "unattributed-prep";
/** Default bucket for non-agent usage recorded with no attribution at all. */
export const UNATTRIBUTED = "unattributed";

// ── Public types ─────────────────────────────────────────────────

export type CostComponent =
  | "voice"
  | "vision"
  | "context"
  | "auditor"
  | "computer_use"
  | "agent"
  | string; // permissive — unknown components are still recorded, never rejected

export interface UsageEvent {
  /** Component to attribute this usage to. */
  component: CostComponent;
  /** Meeting id. Defaults to the meter's active meeting when omitted. */
  meetingId?: string | null;
  /** Model id / slug / CLI alias (e.g. "anthropic/claude-haiku-4-5", "sonnet"). */
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Cached-read / cache-creation tokens (tracked separately, NOT billed here). */
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /**
   * Exact USD cost as reported by the provider (e.g. claude CLI total_cost_usd).
   * When present it OVERRIDES the rate-table estimate for this event — this is
   * how the dominant `agent` cost is captured exactly.
   */
  costUsd?: number;
  /** Free-form metadata (adapter role, provider name, etc.) — not persisted per-event. */
  meta?: Record<string, unknown>;
}

export interface ModelRate {
  inputPer1M: number;
  outputPer1M: number;
  /** Marks rates that are best-effort approximations (audio-blended / unpublished). */
  approx?: boolean;
}

export type RateTable = Record<string, ModelRate>;

export interface ComponentBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Sum of computable costs (rate-table + reported costUsd). */
  estimatedUsd: number;
  /** Number of record() calls attributed to this component. */
  calls: number;
  /** Distinct model ids seen. */
  models: string[];
  /** Calls whose model had no rate AND no reported costUsd (tokens counted, $0 added). */
  unknownModelCalls: number;
  /** Calls that carried no token counts at all (e.g. Hermes/Codex plain-text CLIs). */
  tokensUnknownCalls: number;
}

export interface MeetingReport {
  meetingId: string;
  /** 1-based session number (see MeetingCostRecord.session). */
  session: number;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  components: Record<string, ComponentBreakdown>;
  totals: {
    inputTokens: number;
    outputTokens: number;
    estimatedUsd: number;
    calls: number;
    unknownModelCalls: number;
    tokensUnknownCalls: number;
  };
}

export interface CostReport {
  /** Present when getReport(meetingId) targets a single meeting. */
  meeting?: MeetingReport;
  /** Present when getReport() aggregates across all retained meetings. */
  meetings?: MeetingReport[];
  totals: MeetingReport["totals"];
}

// ── Default rate table (USD per 1,000,000 tokens) ─────────────────
//
// Anthropic rates are the published list prices (claude-api skill, cached
// 2026-06-24). Voice/vision provider rates without a per-token public price are
// marked `approx` and are audio-blended or estimated — they are DIRECTIONAL for
// GTM math, not billing-accurate. Override any of these via COST_RATES_JSON env
// or the constructor `rates` option.
export const DEFAULT_RATES: RateTable = {
  // ── Anthropic (in-meeting Haiku, off-meeting Sonnet, Opus) ──
  "claude-haiku-4-5": { inputPer1M: 1.0, outputPer1M: 5.0 },
  "claude-sonnet-5": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-sonnet-4-6": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-opus-4-8": { inputPer1M: 5.0, outputPer1M: 25.0 },
  "claude-opus-4-6": { inputPer1M: 5.0, outputPer1M: 25.0 },
  "claude-opus-4-5": { inputPer1M: 5.0, outputPer1M: 25.0 },
  // CLI tier aliases (claude -p --model sonnet|haiku|opus). Rarely used for cost
  // since claude reports total_cost_usd, but kept for completeness.
  haiku: { inputPer1M: 1.0, outputPer1M: 5.0 },
  sonnet: { inputPer1M: 3.0, outputPer1M: 15.0 },
  opus: { inputPer1M: 5.0, outputPer1M: 25.0 },

  // ── Voice (per config.ts provider comments) ──
  // gpt-realtime-2: audio $32/$64 per 1M (text output up to $24). Audio dominates
  // a live meeting, so we use the audio rate as a blended approximation.
  "gpt-realtime-2": { inputPer1M: 32.0, outputPer1M: 64.0, approx: true },
  // Gemini 3.1 Flash Live: config quotes ~$0.02/min; no public per-token price.
  "gemini-3.1-flash-live-preview": { inputPer1M: 0.5, outputPer1M: 2.0, approx: true },
  // Grok Voice: config quotes ~$0.05/min; no public per-token price.
  "grok-voice": { inputPer1M: 5.0, outputPer1M: 15.0, approx: true },

  // ── Vision (OpenRouter Gemini Flash primary/fallback, gpt-4o-mini fallback) ──
  "gemini-3.5-flash": { inputPer1M: 0.3, outputPer1M: 2.5, approx: true },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
};

// ── Module-level active meter (decoupled wiring) ─────────────────

let _activeMeter: CostMeter | null = null;

/** Install the process-wide meter that `recordUsage()` forwards to. */
export function setActiveCostMeter(meter: CostMeter | null): void {
  _activeMeter = meter;
}

export function getActiveCostMeter(): CostMeter | null {
  return _activeMeter;
}

/**
 * Fire-and-forget usage report from a model-calling module. Forwards to the
 * installed meter; a no-op (never throws) when no meter is installed or metering
 * fails. This is the seam every wired module imports.
 */
export function recordUsage(event: UsageEvent): void {
  try {
    _activeMeter?.record(event);
  } catch {
    /* metering must never break a meeting */
  }
}

// ── CostMeter ─────────────────────────────────────────────────────

interface MeetingBucket {
  meetingId: string;
  startedAt: number;
  endedAt: number | null;
  /**
   * 1-based session counter. A meetingId that RE-JOINS after its previous
   * session was already finalized starts a FRESH bucket with session+1, so each
   * JSONL line covers a disjoint window — summing lines by meetingId can never
   * double-count an earlier session (Finding 4).
   */
  session: number;
  components: Map<string, ComponentBreakdown>;
}

export interface CostMeterOptions {
  /** Directory for the JSONL log. Default: ~/.callingclaw/shared/cost-log */
  logDir?: string;
  /** Rate overrides merged over DEFAULT_RATES (constructor precedence). */
  rates?: RateTable;
  /** Master switch. Default true. */
  enabled?: boolean;
  /** Max meetings retained in memory (oldest evicted). Default 100. */
  maxMeetings?: number;
}

export class CostMeter {
  private meetings = new Map<string, MeetingBucket>();
  private rates: RateTable;
  private logDir: string;
  private logFile: string;
  private enabled: boolean;
  private maxMeetings: number;
  private _activeMeetingId: string | null = null;
  private _finalized = new Set<string>();
  private _loggedUnknownModels = new Set<string>();
  /** Highest session number ever assigned per meetingId (survives bucket eviction). */
  private _sessionSeq = new Map<string, number>();
  /**
   * Explicit per-async-flow attribution. When a dispatcher wraps an agent call
   * in withAttribution(id, fn), record() reads the id from here for every event
   * emitted inside fn's async chain — even across awaits, and even if
   * setActiveMeeting moved on to another meeting in the meantime.
   */
  private _attribution = new AsyncLocalStorage<string>();

  constructor(opts: CostMeterOptions = {}) {
    this.enabled = opts.enabled !== false;
    this.maxMeetings = opts.maxMeetings ?? 100;
    this.logDir =
      opts.logDir ||
      resolve(
        process.env.CALLINGCLAW_HOME || resolve(homedir(), ".callingclaw"),
        "shared",
        "cost-log",
      );
    this.logFile = resolve(this.logDir, "cost-log.jsonl");

    // Rate precedence: DEFAULT_RATES < COST_RATES_JSON env < constructor opts.
    let envRates: RateTable = {};
    try {
      if (process.env.COST_RATES_JSON) {
        envRates = JSON.parse(process.env.COST_RATES_JSON) as RateTable;
      }
    } catch {
      console.warn("[CostMeter] COST_RATES_JSON is not valid JSON — ignoring");
    }
    this.rates = { ...DEFAULT_RATES, ...normalizeRateKeys(envRates), ...normalizeRateKeys(opts.rates || {}) };
  }

  /** Current merged rate table (for inspection / an endpoint). */
  getRates(): RateTable {
    return { ...this.rates };
  }

  /**
   * Set the meeting new usage attributes to by default. Called on meeting.started.
   * Cleared on meeting.ended via endActiveMeeting() so pre-join prep for the NEXT
   * meeting is never billed to the previous one; post-meeting work is attributed
   * explicitly via withAttribution() instead of the retained active id.
   *
   * Re-join semantics (Finding 4):
   *   • Re-join BEFORE the previous session was finalized → reuse the same
   *     bucket (one meeting, one accumulating session, one JSONL line).
   *   • Re-join AFTER finalize → reset to a FRESH bucket with an incremented
   *     session number, so the next JSONL line is disjoint from the first and
   *     summing lines by meetingId never double-counts session 1.
   */
  setActiveMeeting(meetingId: string | null | undefined): void {
    try {
      this._activeMeetingId = meetingId || null;
      if (this._activeMeetingId) {
        const id = this._activeMeetingId;
        if (this._finalized.has(id)) {
          // Already written to the log — start a brand-new, non-overlapping
          // session so the next finalize() line holds ONLY this session's totals.
          const prevSession = this.meetings.get(id)?.session
            ?? this._sessionSeq.get(id) ?? 1;
          this.meetings.delete(id);
          this._finalized.delete(id);
          this._sessionSeq.set(id, prevSession + 1);
        }
        this.ensureBucket(id);
      }
    } catch {
      /* fail-soft */
    }
  }

  /**
   * Clear the active-attribution target when a meeting ends. Keeps the bucket in
   * memory (finalize is scheduled separately with an explicit id) but stops NEW
   * unscoped usage — notably pre-join prep for the next meeting — from being
   * attributed to the meeting that just ended. Only clears when the ended id is
   * still the active one (a back-to-back meeting may already own it).
   */
  endActiveMeeting(meetingId?: string | null): void {
    try {
      const id = meetingId || this._activeMeetingId;
      if (id && this._activeMeetingId === id) this._activeMeetingId = null;
    } catch {
      /* fail-soft */
    }
  }

  /**
   * Run `fn` with an explicit attribution scope: every recordUsage/record call
   * made inside fn's async chain attributes to `meetingId`, overriding the
   * mutable active meeting. Use it to pin pre-join prep and post-meeting
   * (summary/timeline/delivery) agent work to the meeting that owns it, even
   * when a later meeting has already become active. Passing a falsy id is a
   * no-op scope (falls through to the normal precedence). Never throws.
   */
  withAttribution<T>(meetingId: string | null | undefined, fn: () => T): T {
    if (!meetingId) return fn();
    // .run executes fn exactly once and rethrows fn's synchronous errors as-is
    // (do NOT wrap — a catch+re-invoke here would run fn twice on a throw).
    return this._attribution.run(String(meetingId), fn);
  }

  get activeMeetingId(): string | null {
    return this._activeMeetingId;
  }

  /** Record one usage event. Fail-soft: never throws. */
  record(event: UsageEvent): void {
    if (!this.enabled) return;
    try {
      const component = String(event.component || "other");
      // Precedence: explicit id → withAttribution() scope → active meeting →
      // default bucket. `agent` work with no attribution is (almost always)
      // pre-join prep, so it lands in "unattributed-prep" rather than a real
      // meeting — never billed to the wrong one.
      const scoped = this._attribution.getStore() || undefined;
      const meetingId =
        (event.meetingId || undefined) ??
        scoped ??
        this._activeMeetingId ??
        (component === "agent" ? UNATTRIBUTED_PREP : UNATTRIBUTED);
      const bucket = this.ensureBucket(meetingId);
      const comp = this.ensureComponent(bucket, component);

      const inTok = num(event.inputTokens);
      const outTok = num(event.outputTokens);
      const hasTokens = event.inputTokens != null || event.outputTokens != null;

      comp.calls += 1;
      comp.inputTokens += inTok;
      comp.outputTokens += outTok;
      comp.cacheReadTokens += num(event.cacheReadTokens);
      comp.cacheCreationTokens += num(event.cacheCreationTokens);
      if (!hasTokens && event.costUsd == null) comp.tokensUnknownCalls += 1;

      if (event.model && !comp.models.includes(event.model)) comp.models.push(event.model);

      // Cost: reported USD wins; else rate table; else unknown (tokens still counted).
      if (typeof event.costUsd === "number" && isFinite(event.costUsd)) {
        comp.estimatedUsd += event.costUsd;
      } else {
        const rate = this.rateFor(event.model);
        if (rate) {
          comp.estimatedUsd += (inTok / 1e6) * rate.inputPer1M + (outTok / 1e6) * rate.outputPer1M;
        } else if (hasTokens) {
          // Tokens present but no rate → count tokens, mark cost unknown, log once.
          comp.unknownModelCalls += 1;
          const key = event.model || "(no-model)";
          if (!this._loggedUnknownModels.has(key)) {
            this._loggedUnknownModels.add(key);
            console.warn(
              `[CostMeter] No rate for model "${key}" (component=${event.component}) — tokens recorded, cost unknown. Add it to COST_RATES_JSON to price it.`,
            );
          }
        }
      }
    } catch {
      /* fail-soft */
    }
  }

  /**
   * Build a report. With a meetingId → that meeting only. Without → all retained
   * meetings plus aggregated totals.
   */
  getReport(meetingId?: string): CostReport {
    try {
      if (meetingId) {
        const bucket = this.meetings.get(meetingId);
        const report = bucket ? bucketToReport(bucket) : emptyReport(meetingId);
        return { meeting: report, totals: report.totals };
      }
      const meetings = [...this.meetings.values()].map(bucketToReport);
      return { meetings, totals: aggregateTotals(meetings) };
    } catch {
      return { totals: emptyTotals() };
    }
  }

  /**
   * Persist one JSONL line for a meeting (default: the active meeting). Idempotent
   * per meetingId unless `force` — a second call for the same id is a no-op.
   * Returns the log file path on success, else null. Fail-soft.
   */
  async finalizeMeeting(meetingId?: string, opts: { force?: boolean } = {}): Promise<string | null> {
    if (!this.enabled) return null;
    try {
      const id = meetingId || this._activeMeetingId;
      if (!id) return null;
      const bucket = this.meetings.get(id);
      if (!bucket) return null;
      if (this._finalized.has(id) && !opts.force) return null;

      bucket.endedAt = bucket.endedAt ?? Date.now();
      const record = this.buildRecord(bucket);

      mkdirSync(this.logDir, { recursive: true });
      appendFileSync(this.logFile, JSON.stringify(record) + "\n");
      this._finalized.add(id);
      console.log(
        `[CostMeter] Finalized meeting ${id}: $${record.totals.estimatedUsd.toFixed(4)} across ${record.totals.calls} calls → ${this.logFile}`,
      );
      return this.logFile;
    } catch (e: any) {
      console.warn(`[CostMeter] finalizeMeeting failed (non-fatal): ${e?.message || e}`);
      return null;
    }
  }

  /** Finalize every retained meeting not yet written (e.g. on shutdown). */
  async finalizeAllPending(): Promise<void> {
    try {
      for (const id of this.meetings.keys()) {
        if (!this._finalized.has(id)) await this.finalizeMeeting(id);
      }
    } catch {
      /* fail-soft */
    }
  }

  /** Drop retained in-memory data for one meeting (or all). */
  reset(meetingId?: string): void {
    try {
      if (meetingId) {
        this.meetings.delete(meetingId);
        this._finalized.delete(meetingId);
        this._sessionSeq.delete(meetingId);
        if (this._activeMeetingId === meetingId) this._activeMeetingId = null;
      } else {
        this.meetings.clear();
        this._finalized.clear();
        this._sessionSeq.clear();
        this._activeMeetingId = null;
      }
    } catch {
      /* fail-soft */
    }
  }

  /** The structured per-meeting record written to JSONL (also useful to tests). */
  buildRecord(bucket: MeetingBucket): MeetingCostRecord {
    const report = bucketToReport(bucket);
    return {
      schemaVersion: COST_LOG_SCHEMA_VERSION,
      meetingId: report.meetingId,
      session: bucket.session,
      startedAt: report.startedAt,
      endedAt: report.endedAt,
      durationMs: report.durationMs,
      generatedAt: new Date().toISOString(),
      totals: report.totals,
      components: report.components,
    };
  }

  // ── internals ──

  private ensureBucket(meetingId: string): MeetingBucket {
    let b = this.meetings.get(meetingId);
    if (!b) {
      const session = this._sessionSeq.get(meetingId) ?? 1;
      this._sessionSeq.set(meetingId, session);
      b = { meetingId, startedAt: Date.now(), endedAt: null, session, components: new Map() };
      this.meetings.set(meetingId, b);
      // Bound memory: evict oldest insertion once over the cap.
      while (this.meetings.size > this.maxMeetings) {
        const oldest = this.meetings.keys().next().value;
        if (oldest === undefined) break;
        this.meetings.delete(oldest);
        this._finalized.delete(oldest);
        this._sessionSeq.delete(oldest);
      }
    }
    return b;
  }

  private ensureComponent(bucket: MeetingBucket, component: string): ComponentBreakdown {
    let c = bucket.components.get(component);
    if (!c) {
      c = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedUsd: 0,
        calls: 0,
        models: [],
        unknownModelCalls: 0,
        tokensUnknownCalls: 0,
      };
      bucket.components.set(component, c);
    }
    return c;
  }

  /** Resolve a rate for a model id/slug/alias, or null when unknown. */
  private rateFor(model?: string): ModelRate | null {
    if (!model) return null;
    for (const key of normalizeModelCandidates(model)) {
      const r = this.rates[key];
      if (r) return r;
    }
    return null;
  }
}

// ── JSONL record schema ───────────────────────────────────────────

export const COST_LOG_SCHEMA_VERSION = 1;

export interface MeetingCostRecord {
  schemaVersion: number;
  meetingId: string;
  /**
   * 1-based session number for this meetingId. >1 means the meeting re-joined
   * after an earlier session was already finalized; each session's line covers a
   * disjoint window, so aggregate a meeting's true cost by SUMMING all lines that
   * share its meetingId (they never overlap).
   */
  session: number;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  generatedAt: string;
  totals: MeetingReport["totals"];
  components: Record<string, ComponentBreakdown>;
}

// ── helpers ────────────────────────────────────────────────────────

function num(v: unknown): number {
  return typeof v === "number" && isFinite(v) && v > 0 ? v : 0;
}

/** Candidate keys to try against the rate table, most-specific first. */
export function normalizeModelCandidates(model: string): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    if (s && !out.includes(s)) out.push(s);
  };
  const raw = model.trim();
  push(raw);
  const lower = raw.toLowerCase();
  push(lower);
  // Strip provider prefix ("anthropic/claude-haiku-4-5" → "claude-haiku-4-5").
  const noPrefix = lower.includes("/") ? lower.slice(lower.lastIndexOf("/") + 1) : lower;
  push(noPrefix);
  // Version dots → dashes ("claude-haiku-4.5" → "claude-haiku-4-5").
  push(noPrefix.replace(/(\d)\.(\d)/g, "$1-$2"));
  // Tier alias ("...sonnet..." → "sonnet") for CLI-style ids.
  for (const tier of ["opus", "sonnet", "haiku"]) {
    if (noPrefix.includes(tier)) push(tier);
  }
  return out;
}

function normalizeRateKeys(rates: RateTable): RateTable {
  const out: RateTable = {};
  for (const [k, v] of Object.entries(rates)) out[k.toLowerCase()] = v;
  return out;
}

function bucketToReport(bucket: MeetingBucket): MeetingReport {
  const components: Record<string, ComponentBreakdown> = {};
  for (const [name, c] of bucket.components) {
    components[name] = {
      ...c,
      estimatedUsd: round4(c.estimatedUsd),
      models: [...c.models],
    };
  }
  const endedAt = bucket.endedAt;
  return {
    meetingId: bucket.meetingId,
    session: bucket.session,
    startedAt: bucket.startedAt,
    endedAt,
    durationMs: (endedAt ?? Date.now()) - bucket.startedAt,
    components,
    totals: totalsFromComponents(components),
  };
}

function totalsFromComponents(components: Record<string, ComponentBreakdown>): MeetingReport["totals"] {
  const t = emptyTotals();
  for (const c of Object.values(components)) {
    t.inputTokens += c.inputTokens;
    t.outputTokens += c.outputTokens;
    t.estimatedUsd += c.estimatedUsd;
    t.calls += c.calls;
    t.unknownModelCalls += c.unknownModelCalls;
    t.tokensUnknownCalls += c.tokensUnknownCalls;
  }
  t.estimatedUsd = round4(t.estimatedUsd);
  return t;
}

function aggregateTotals(meetings: MeetingReport[]): MeetingReport["totals"] {
  const t = emptyTotals();
  for (const m of meetings) {
    t.inputTokens += m.totals.inputTokens;
    t.outputTokens += m.totals.outputTokens;
    t.estimatedUsd += m.totals.estimatedUsd;
    t.calls += m.totals.calls;
    t.unknownModelCalls += m.totals.unknownModelCalls;
    t.tokensUnknownCalls += m.totals.tokensUnknownCalls;
  }
  t.estimatedUsd = round4(t.estimatedUsd);
  return t;
}

function emptyTotals(): MeetingReport["totals"] {
  return {
    inputTokens: 0,
    outputTokens: 0,
    estimatedUsd: 0,
    calls: 0,
    unknownModelCalls: 0,
    tokensUnknownCalls: 0,
  };
}

function emptyReport(meetingId: string): MeetingReport {
  return {
    meetingId,
    session: 0,
    startedAt: 0,
    endedAt: null,
    durationMs: 0,
    components: {},
    totals: emptyTotals(),
  };
}

function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e4) / 1e4;
}
