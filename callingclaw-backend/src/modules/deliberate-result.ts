// CallingClaw 2.0 — Unified System-2 → System-1 result contract (P1 STEP 2).
//
// THE structural keystone of docs/s1s2-conversation-architecture.md §4.
// Every deliberate (slow-brain) capability — web/deep research, recall_context,
// ContextRetriever gap-fill, ComputerUse/automation completion — produces ONE
// of these `DeliberateResult` envelopes and hands it to the ONE sink
// `VoiceModule.deliverDeliberateResult()`. No producer talks to the Realtime
// client, the Layer-3 context queue, `response.create`, or a staleness prompt
// directly. Collapses the five divergent ad-hoc return paths (§2) into one.
//
// This file is intentionally dependency-free and pure (no VoiceModule / client
// import) so the staleness turn-lease + sentinel classifier are unit-testable
// in isolation, and so the scoped tsc gate (glob src/modules/deliberate-*.ts)
// keeps it honest.
//
// Reconciled to LEAN-first (vs the §4.1 verbatim sketch): `detail` is optional,
// staleness is a DETERMINISTIC turn-lease (below) rather than a per-kind
// `StalenessPolicy` enum the model is asked to interpret. The "stay silent if
// irrelevant" model instruction is at most a politeness add-on layered on top
// of the hard turn-lease, never the mechanism.

/** The deliberate capability that produced this result. */
export type DeliberateKind =
  | "research"    // web/deep research via agentAdapter.executeTask
  | "recall"      // recall_context: memory/file/agent fact lookup
  | "retrieval"   // ContextRetriever proactive gap-fill
  | "action";     // ComputerUse / automation completion

/** How the producer wants the result presented to the voice model. */
export type SpeakMode =
  | "proactive"   // inject + (subject to the turn-lease) trigger a gated one-turn response
  | "silent";     // inject only; the model picks it up on its next natural turn

/**
 * The unified System-2 → System-1 envelope. LEAN-first: only `id`, `kind`,
 * `summary`, `dispatchedAt`, and `speak` are required.
 */
export interface DeliberateResult {
  /** Unique PER-DISPATCH id. Correlation + idempotency. e.g. "research_<ts>_<seq>".
   *  Dedup keys on THIS, never on `replaceId` (which is the in-place-update key). */
  id: string;
  kind: DeliberateKind;
  /** One-line, spoken-ready. What the model may weave into speech. Never a sentinel. */
  summary: string;
  /** Full detail for Layer-3 injection / working doc. May be long; the sink caps it. */
  detail?: string;
  /** The user utterance/intent that triggered this dispatch — used to label the
   *  injected block so the model knows what it answers. */
  sourceUtterance?: string;
  /** The VoiceModule user-turn id captured AT DISPATCH. The sink compares it to
   *  the CURRENT user-turn id to decide the turn-lease (see classifyStaleness). */
  sourceTurnId?: number;
  /** ms epoch when the triggering dispatch began — the age half of the lease. */
  dispatchedAt: number;
  speak: SpeakMode;
  /** Optional fixed Layer-3 id for replace-semantics (in-place, no FIFO growth).
   *  Omit for FIFO append. NOTE: per-DISPATCH (e.g. "ctx_research_<taskId>"), NOT
   *  a shared singleton — that singleton was the concurrent-clobber bug (§10). */
  replaceId?: string;
  /** Set when the deliberate call failed (or returned a bare error string). The
   *  sink renders this as an INTERNAL neutral note and NEVER as spoken fact, and
   *  never triggers speech. This is the SOLE failure signal the sink trusts —
   *  producers set it precisely (research via its catch, recall via
   *  isUnusableRecallResult). The sink does NOT content-sniff a SUCCESS envelope. */
  error?: string;
  /** OPTIONAL ephemeral one-turn instruction for the gated speak trigger (§4.2/§4.3).
   *  When set AND the result speaks, the sink passes it as `response.create`'s
   *  `response.instructions` — a ONE-TURN instruction that is NOT persisted to
   *  Layer 3. Use for a guarded imperative ("follow up NOW … else stay silent")
   *  that must NOT linger and re-fire on later turns. The concrete CONTENT still
   *  travels via `summary`/`detail` (Layer-3) or the producer's own liveNotes;
   *  only the imperative is ephemeral. */
  instruction?: string;
}

/**
 * What the sink actually did — HONEST (each value MEANS what it says). Returned
 * so producers can log/emit consistently.
 */
export type DeliveryDisposition =
  | "response-requested" // injected + a gated response.create fired now
  | "deferred"           // injected + a gated response deferred (fires on next idle)
  | "injected-silent"    // injected only; model picks it up on its next natural turn
  | "dropped-stale"      // turn-lease too old for even silent context → NOT injected
  | "dropped-duplicate"  // same per-dispatch id already delivered
  | "no-session"         // voice not connected — nothing injected or spoken
  | "error-suppressed";  // producer failure: neutral note only, never spoken as fact

// ── Deterministic turn-lease staleness (§4.3) ─────────────────────────────
//
// The PRIMARY staleness mechanism is NOT a model judgment and NOT a Haiku
// round-trip and NOT keyword overlap. It is a deterministic comparison of the
// user-turn id stamped at dispatch to the CURRENT user-turn id, plus a hard age
// ceiling. Rationale: a slow S2 result that lands after the conversation has
// moved on N turns should NOT barge in and answer a dead question; but if it is
// still recent it is worth surfacing. "Recent-enough-but-past" degrades to
// silent injection (late-default-silent) rather than proactive speech.

/** The lease decision the sink acts on. */
export type StalenessDecision =
  | "speak"          // lease open: fresh proactive → inject + gated response
  | "inject-silent"  // silent producer, OR proactive-but-past → inject, no speech
  | "drop";          // beyond even the silent window → do not inject (would pollute L3)

export interface StalenessConfig {
  /** Max user-turns elapsed for a PROACTIVE result to still SPEAK (lease open).
   *  Default 1 = same turn (0 elapsed) or the immediately adjacent turn. */
  speakWithinTurns: number;
  /** Max user-turns elapsed for a proactive result to still be INJECTED silently.
   *  Beyond this the topic has moved on → drop. Default 4. */
  injectWithinTurns: number;
  /** Hard age ceiling (ms). A PROACTIVE result older than this is dropped
   *  regardless of turn count (guards a long-paused meeting). Default 10 min. */
  maxAgeMs: number;
}

export const DEFAULT_STALENESS: StalenessConfig = {
  speakWithinTurns: 1,
  injectWithinTurns: 4,
  maxAgeMs: 10 * 60_000,
};

export interface StalenessInput {
  /** User-turn id stamped at dispatch. `undefined` ⇒ unknown ⇒ treated as the
   *  current turn (lease fully open) so a producer that doesn't track turns
   *  still speaks proactively. */
  sourceTurnId?: number;
  /** Current user-turn id at delivery time (VoiceModule.userTurnId). */
  currentTurnId: number;
  /** ms epoch of dispatch. */
  dispatchedAt: number;
  /** Producer's presentation intent. */
  speak: SpeakMode;
  /** Injectable clock for deterministic tests. */
  now?: number;
  /** Per-call overrides (per-kind windows come from here in later phases). */
  config?: Partial<StalenessConfig>;
}

/**
 * Pure, deterministic turn-lease. No model, no network, no allocation on the
 * hot path beyond the merged config. This is the single behaviour that today
 * lives only in ContextRetriever, generalized so every producer inherits it.
 */
export function classifyStaleness(input: StalenessInput): StalenessDecision {
  const cfg = input.config ? { ...DEFAULT_STALENESS, ...input.config } : DEFAULT_STALENESS;

  // A producer that explicitly wants silence always injects silently (the
  // model weaves it in on its next natural turn). Never escalated to speech.
  if (input.speak === "silent") return "inject-silent";

  // ── Proactive path ──
  const now = input.now ?? Date.now();
  const age = Math.max(0, now - input.dispatchedAt);
  // Hard age pre-gate (free): older than any conversation has use for → drop.
  if (age > cfg.maxAgeMs) return "drop";

  const turnsElapsed =
    typeof input.sourceTurnId === "number"
      ? Math.max(0, input.currentTurnId - input.sourceTurnId)
      : 0; // unknown source turn → lease open

  if (turnsElapsed <= cfg.speakWithinTurns) return "speak";       // fresh → speak
  if (turnsElapsed <= cfg.injectWithinTurns) return "inject-silent"; // past → silent
  return "drop"; // topic long moved on → don't even inject
}

// ── Sentinel safety (§4.2 responsibility #4) ──────────────────────────────
//
// A producer's FAILURE must never be spoken as an answer. The sink decides this
// SOLELY from the explicit `error` field — it TRUSTS the producer's own
// classification (research sets `error` in its catch; recall sets it via
// isUnusableRecallResult, which is precise about the known "All channels failed"
// / "Gateway not available" sentinels). The sink does NOT content-sniff a
// SUCCESS envelope.
//
// WHY THE OLD CONTENT-SNIFF WAS REMOVED (borderline-BLOCKER regression): the
// previous heuristic ran `ERROR_SENTINEL.test(body) && body.length < 200`
// against ANY short body — INCLUDING success envelopes with no `error` set. A
// legitimate short recall answer such as "Deploy failed on the 14th" or "The
// server was unavailable" matched `failed` / `unavailable` and got suppressed,
// re-creating the original blocker's shape (the AI withholds an answer it
// actually has) and OVERRIDING the recall producer's precise verdict. So the
// backstop is gone: the explicit `error` field is authoritative.
//
// `looksLikeErrorSentinel` (the regex) is retained as a standalone utility a
// PRODUCER may opt into when it must classify a bare string BEFORE building the
// envelope — but it is never applied by the sink to a producer-declared success.

const ERROR_SENTINEL =
  /(?:timed?\s*out|timeout|no external agent|failed|error:|unavailable|billing error|not\s+(?:currently\s+)?available|couldn'?t|could not)/i;

/** True if the text reads like an error/apology sentinel rather than content.
 *  A PRODUCER-side helper only — the sink does NOT use this to reclassify a
 *  success envelope (see isDeliberateError). */
export function looksLikeErrorSentinel(text: string | undefined | null): boolean {
  if (!text) return false;
  return ERROR_SENTINEL.test(text);
}

/**
 * Decide whether an envelope represents a FAILURE (so the sink suppresses
 * speech and injects only a neutral internal note). The ONLY signal is the
 * explicit `error` field — the sink trusts the producer's classification and
 * never content-sniffs a success envelope. A legit short answer that merely
 * READS error-shaped (e.g. "Deploy failed on the 14th") is spoken, not muted.
 */
export function isDeliberateError(r: DeliberateResult): boolean {
  return !!(r.error && r.error.trim());
}

// ── Rendering (Layer-3 text) ──────────────────────────────────────────────

/** Per-kind Layer-3 tag. Mirrors the historical prefixes the model is tuned on. */
export const DELIBERATE_PREFIX: Record<DeliberateKind, string> = {
  research: "[RESEARCH]",
  recall: "[RECALL]",
  retrieval: "[CONTEXT]",
  action: "[DONE]",
};

/** Default cap for the injected detail block (matches the old research slice). */
export const MAX_DELIBERATE_DETAIL_CHARS = 1200;

/**
 * Render the Layer-3 text for a (non-error) result. Labels the block with the
 * source utterance so the model knows what it answers, then the body (detail,
 * or summary when there is no detail), capped. Matches the historical
 * "[RESEARCH] <query>\n\n<result>" shape.
 */
export function renderDeliberateText(
  r: DeliberateResult,
  maxDetailChars: number = MAX_DELIBERATE_DETAIL_CHARS,
): string {
  const head = DELIBERATE_PREFIX[r.kind] ?? "[S2]";
  const label = r.sourceUtterance ? ` ${r.sourceUtterance.trim()}` : "";
  const body = (r.detail && r.detail.trim()) || (r.summary || "").trim();
  if (!body) return `${head}${label}`.trim();
  const capped =
    body.length > maxDetailChars ? `${body.slice(0, maxDetailChars)}\n…(truncated)` : body;
  return `${head}${label}\n\n${capped}`;
}

/**
 * Render a NEUTRAL internal note for a failed result. It deliberately does NOT
 * echo the raw `error` string (so the model can't read a sentinel aloud) and
 * instructs the model not to fabricate an answer. Injected silently.
 */
export function renderErrorNote(r: DeliberateResult): string {
  const head = DELIBERATE_PREFIX[r.kind] ?? "[S2]";
  const src = r.sourceUtterance ? ` for "${r.sourceUtterance.trim()}"` : "";
  return (
    `${head} (internal note) The background ${r.kind} task${src} did not return a usable ` +
    `result. Do NOT tell the user it succeeded or invent an answer; if asked, say the lookup didn't come back.`
  );
}
