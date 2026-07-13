// CallingClaw 2.0 — Realtime Voice WebSocket Client (Multi-Provider)
//
// Supports OpenAI Realtime API, Grok Voice Agent, and Gemini Live via provider config.
// Provider differences are isolated in RealtimeProviderConfig objects:
//   - Connection URL + auth headers
//   - session.update format (audio config shape differs)
//   - Event name mapping (3 audio events differ between OpenAI/Grok)
//   - Gemini: GeminiProtocolAdapter does structural transform (different protocol)
//   - Auto-reconnect with transcript context replay (Gemini uses session resumption)
//
// Context Injection (v2.4.9+):
//   Instead of replacing the full system instructions on every context update,
//   we inject context incrementally via conversation.item.create (role: system).
//   This avoids interrupting in-progress responses (session.update is deferred
//   by the Realtime API until the next turn, causing audio breaks).
//   A FIFO queue manages context items; oldest are deleted when the queue is full.
//
// Architecture:
//   RealtimeClient
//     ├── provider: RealtimeProviderConfig (openai | grok | gemini)
//     ├── connect() → provider.url + provider.headers + provider.buildSession()
//     ├── onmessage → provider.eventMap normalizes names (OpenAI/Grok)
//     │               → GeminiProtocolAdapter.transformInbound() (Gemini)
//     ├── sendEvent() → direct JSON (OpenAI/Grok)
//     │                → GeminiProtocolAdapter.transformOutbound() (Gemini)
//     ├── injectContext() → conversation.item.create (incremental, no audio break)
//     ├── removeContext() → conversation.item.delete (FIFO eviction; no-op for Gemini)
//     └── onclose → auto-reconnect with context replay (Gemini: session resumption)

import { CONFIG } from "../config";
import { GeminiProtocolAdapter } from "./gemini-adapter";

// Load ws npm package at module level (not dynamic require at connection time).
// MUST use require() — `import from "ws"` gives Bun's built-in shim which ignores proxy.
const WsWebSocket = require("ws");
const WsHttpsProxyAgent = require("https-proxy-agent").HttpsProxyAgent;

// ── Provider Config Types ──────────────────────────────────────────

export type VoiceProviderName = "openai" | "openai15" | "grok" | "gemini";

export interface ProviderCapabilities {
  supportsInterruption: boolean;
  supportsResume: boolean;
  supportsNativeTools: boolean;
  supportsTranscription: boolean;
  audioFormats: string[];       // e.g. ["pcm16"]
  maxSessionMinutes: number;    // e.g. 30 for Grok, 120 for OpenAI
}

export interface RealtimeProviderConfig {
  name: VoiceProviderName;
  url: string;
  headers: Record<string, string>;
  /** Map provider-specific event names → normalized names used by VoiceModule */
  eventMap: Record<string, string>;
  /** Build the session.update payload for this provider */
  buildSession(opts: {
    instructions: string;
    tools: RealtimeTool[];
    voice: string;
    vad: { threshold: number; prefix_padding_ms: number; silence_duration_ms: number };
  }): Record<string, any>;
  /** Explicit capability declaration for this provider */
  capabilities: ProviderCapabilities;
  /** Default voice for this provider */
  defaultVoice: string;
  /** Default VAD settings tuned for this provider */
  defaultVad: { threshold: number; prefix_padding_ms: number; silence_duration_ms: number };
}

export interface RealtimeTool {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

type EventHandler = (event: any) => void;

// ── Provider Definitions ───────────────────────────────────────────

export const OPENAI_PROVIDER: RealtimeProviderConfig = {
  name: "openai",
  url: `${CONFIG.openai.realtimeUrl}?model=${CONFIG.openai.realtimeModel}`,
  headers: {
    Authorization: `Bearer ${CONFIG.openai.apiKey}`,
    // GA API: no "OpenAI-Beta" header needed (gpt-realtime-1.5 / -2)
  },
  // GA API event names → normalized (internal) names
  // The GA API renamed output events; map them back to names used by VoiceModule
  eventMap: {
    "response.output_text.delta": "response.text.delta",
    "response.output_text.done": "response.text.done",
    "response.output_audio.delta": "response.audio.delta",
    "response.output_audio.done": "response.audio.done",
    "response.output_audio_transcript.delta": "response.audio_transcript.delta",
    "response.output_audio_transcript.done": "response.audio_transcript.done",
    "conversation.item.added": "conversation.item.created",
  },
  capabilities: {
    supportsInterruption: true,
    supportsResume: false,
    supportsNativeTools: true,
    supportsTranscription: true,
    audioFormats: ["pcm16"],
    maxSessionMinutes: 120,
  },
  defaultVoice: CONFIG.openai.voice,
  defaultVad: { threshold: 0.6, prefix_padding_ms: 300, silence_duration_ms: 1200 },
  buildSession({ instructions, tools, voice, vad }) {
    return {
      session: {
        type: "realtime",
        model: CONFIG.openai.realtimeModel,
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            turn_detection: { type: "semantic_vad" },
            transcription: { model: "gpt-4o-transcribe", language: CONFIG.transcriptionLanguage.split(",")[0] || "zh" },
          },
          output: {
            format: { type: "audio/pcm", rate: 24000 },
            voice,
          },
        },
        output_modalities: ["audio"],
        instructions,
        // gpt-realtime-2 reasoning effort. Field path per OpenAI Realtime docs +
        // LiveKit plugin: session.reasoning.effort (nested object, mirrors the
        // Responses API). Omitted entirely when CONFIG.openai.realtimeEffort === ""
        // so non-reasoning models / older endpoints don't get an unknown field.
        ...buildReasoning(CONFIG.openai.realtimeEffort),
        tools: tools.map((t) => ({
          type: "function",
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    };
  },
};

/**
 * Build the optional `reasoning` session fragment for gpt-realtime-2.
 * Returns `{ reasoning: { effort } }` for a non-empty effort, or `{}` to omit
 * the field entirely (omitted-by-default-safe — see CONFIG.openai.realtimeEffort).
 *
 * Field name CONFIDENCE: medium-high. OpenAI's Realtime prompting guide and the
 * LiveKit OpenAI plugin both reference `reasoning.effort` (nested), matching the
 * Responses API shape. The exact GA session schema was not pinned from the public
 * docs at wire time — if a future API rejects this field, set OPENAI_REALTIME_EFFORT=""
 * to omit it (default behavior is otherwise the model's own default of "low").
 */
function buildReasoning(effort: string): Record<string, any> {
  if (!effort) return {};
  return { reasoning: { effort } };
}

// ── OpenAI Realtime GA Provider (gpt-realtime-2 default, 1.5 compatible) ──
// GA API (no beta header), new event names, session.type required.
// Key differences from legacy preview:
//   - No "OpenAI-Beta: realtime=v1" header
//   - session.update requires type: "realtime"
//   - Event names changed: response.text.delta → response.output_text.delta, etc.
//   - New features: semantic_vad, image input, MCP servers, async function calling
//   - Transcription: gpt-4o-transcribe with language hint (prevents zh→foreign misrecognition)
// gpt-realtime-2 adds (over 1.5): 128K ctx, parallel tool calls, configurable
// reasoning effort, spoken preambles. Wire format unchanged — model swap is drop-in.

export const OPENAI15_PROVIDER: RealtimeProviderConfig = {
  name: "openai15",
  url: `${CONFIG.openai15.realtimeUrl}?model=${CONFIG.openai15.realtimeModel}`,
  headers: {
    Authorization: `Bearer ${CONFIG.openai15.apiKey}`,
    // NO "OpenAI-Beta" header — GA API doesn't need it
  },
  // GA API event names → normalized (legacy-compatible) names
  // The GA API renamed output events; we map them back to the names
  // used internally by VoiceModule for backward compatibility
  eventMap: {
    "response.output_text.delta": "response.text.delta",
    "response.output_text.done": "response.text.done",
    "response.output_audio.delta": "response.audio.delta",
    "response.output_audio.done": "response.audio.done",
    "response.output_audio_transcript.delta": "response.audio_transcript.delta",
    "response.output_audio_transcript.done": "response.audio_transcript.done",
    // conversation.item.added replaces conversation.item.created in GA
    "conversation.item.added": "conversation.item.created",
  },
  capabilities: {
    supportsInterruption: true,
    supportsResume: false,
    supportsNativeTools: true,
    supportsTranscription: true,
    audioFormats: ["pcm16"],
    maxSessionMinutes: 120,
  },
  defaultVoice: CONFIG.openai15.voice,
  defaultVad: { threshold: 0.6, prefix_padding_ms: 300, silence_duration_ms: 1200 },
  buildSession({ instructions, tools, voice, vad }) {
    return {
      session: {
        // GA API requires type: "realtime" for speech-to-speech sessions
        type: "realtime",
        model: CONFIG.openai15.realtimeModel,
        // GA API: audio config is nested under audio.input / audio.output
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            turn_detection: { type: "semantic_vad" },
            transcription: { model: "gpt-4o-transcribe", language: CONFIG.transcriptionLanguage.split(",")[0] || "zh" },
          },
          output: {
            format: { type: "audio/pcm", rate: 24000 },
            voice,
          },
        },
        output_modalities: ["audio"],
        instructions,
        // gpt-realtime-2 reasoning effort (session.reasoning.effort); omitted when
        // CONFIG.openai15.realtimeEffort === "". See buildReasoning() above OPENAI_PROVIDER.
        ...buildReasoning(CONFIG.openai15.realtimeEffort),
        tools: tools.map((t) => ({
          type: "function",
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
        // GA API: turn_detection is inside audio.input, not at session level
        // semantic_vad is already set above in audio.input
      },
    };
  },
};

export const GROK_PROVIDER: RealtimeProviderConfig = {
  name: "grok",
  url: CONFIG.grok.realtimeUrl,
  headers: {
    Authorization: `Bearer ${CONFIG.grok.apiKey}`,
  },
  // Grok event names → normalized (OpenAI-compatible) names
  // Only 3 audio output events differ; everything else is identical
  capabilities: {
    supportsInterruption: true,
    supportsResume: false,
    supportsNativeTools: true,  // web_search, x_search
    supportsTranscription: true, // grok-2-audio
    audioFormats: ["pcm16", "pcmu", "pcma"],
    maxSessionMinutes: 30,
  },
  defaultVoice: CONFIG.grok.voice,
  defaultVad: { threshold: 0.9, prefix_padding_ms: 500, silence_duration_ms: 1200 },
  eventMap: {
    "response.output_audio.delta": "response.audio.delta",
    "response.output_audio.done": "response.audio.done",
    "response.output_audio_transcript.delta": "response.audio_transcript.delta",
    "response.output_audio_transcript.done": "response.audio_transcript.done",
  },
  buildSession({ instructions, tools, voice, vad }) {
    return {
      session: {
        instructions,
        voice,
        audio: {
          input: { format: { type: "audio/pcm", rate: 24000 } },
          output: { format: { type: "audio/pcm", rate: 24000 } },
        },
        input_audio_transcription: { model: "grok-2-audio" },
        tools: [
          // Grok native tools (server-side execution, free, no token cost, FAST)
          { type: "web_search" },
          { type: "x_search" },
          // CallingClaw function tools (client-side execution)
          ...tools.map((t) => ({
            type: "function",
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        ],
        // Search settings (optimize for meeting context)
        search: {
          mode: "auto", // Let Grok decide when to search
        },
        turn_detection: { type: "server_vad", ...vad },
      },
    };
  },
};

export const GEMINI_PROVIDER: RealtimeProviderConfig = {
  name: "gemini",
  // URL gets API key appended as query param in _connectInternal()
  url: CONFIG.gemini.realtimeUrl,
  headers: {},  // Gemini uses query param auth, not headers
  // Gemini uses completely different protocol — GeminiProtocolAdapter handles transform
  // eventMap is unused for Gemini (adapter does structural transform, not string rename)
  eventMap: {},
  capabilities: {
    supportsInterruption: true,
    supportsResume: true,           // Built-in session resumption tokens
    supportsNativeTools: true,
    supportsTranscription: true,    // Built-in input/output transcription
    audioFormats: ["pcm16"],
    maxSessionMinutes: 15,          // 15min audio, 2min video (extended via compression + resume)
  },
  defaultVoice: CONFIG.gemini.voice,
  defaultVad: { threshold: 0.7, prefix_padding_ms: 300, silence_duration_ms: 1000 },
  buildSession({ instructions, tools, voice, vad }) {
    // Gemini session config is handled by GeminiProtocolAdapter.transformOutbound()
    // This returns the raw data that the adapter will transform into a setup envelope
    return {
      session: {
        instructions,
        voice,
        _geminiModel: CONFIG.gemini.realtimeModel,
        tools: tools.map((t) => ({
          type: "function",
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    };
  },
};

const PROVIDERS: Record<VoiceProviderName, RealtimeProviderConfig> = {
  openai: OPENAI_PROVIDER,
  openai15: OPENAI15_PROVIDER,
  grok: GROK_PROVIDER,
  gemini: GEMINI_PROVIDER,
};

export function getProvider(name: VoiceProviderName): RealtimeProviderConfig {
  return PROVIDERS[name] || OPENAI_PROVIDER;
}

// ── Auto-Reconnect Config ──────────────────────────────────────────

const RECONNECT_MAX_RETRIES = 3;
const RECONNECT_DELAY_MS = 3000;       // 3s between retries
const RECONNECT_CONTEXT_ENTRIES = 20;   // Replay last 20 transcript entries

// ── Fix 1: session-health confirmation gate ──────────────────────
// A raw `onopen` proves only that the TCP+WS handshake + auth succeeded — NOT
// that the session is usable. The failure mode is "auth ok, session rejected":
// the socket opens (onopen fires), we send session.update, the server rejects it
// and closes. If `_reconnectRetries` resets on every onopen, RECONNECT_MAX_RETRIES
// never bites and the client churns forever (3-9s linear backoff) without ever
// firing `_onReconnectFailed`. So we only reset the retry counter once the session
// is CONFIRMED HEALTHY: either a positive inbound event (first `session.updated`
// or first inbound audio delta) OR the socket staying open this long.
export const SESSION_HEALTH_CONFIRM_MS = 5000; // stable-for-N fallback confirmation

// ── Fix 3: liveness watchdog (ACTING — s1s2 §5) ──────────────────
// A half-open socket (TCP alive, no frames) never fires `onclose`, so the voice
// AI can go silently deaf/mute with no recovery. We track the last-inbound-event
// timestamp; if no inbound frames arrive for LIVENESS_TIMEOUT_MS *while a response
// or audio is expected*, the socket is a suspected half-open and we force-close it
// so the normal reconnect path fires (the death this watchdog exists to catch —
// `onclose` may NEVER arrive, so we drive recovery ourselves).
// TWO guards keep the action safe (§14 risk 2):
//   1. the expectation gate (`_responseInFlight || _isSpeaking`) — legitimate
//      quiet (long user monologue, idle meeting) never trips it; and
//   2. the connection generation guard — a stale watchdog tick belonging to a
//      socket that a newer generation already replaced NO-OPs instead of
//      recycling the healthy newer socket.
export const LIVENESS_TIMEOUT_MS = 10_000;      // inbound-silence threshold while active
const LIVENESS_CHECK_INTERVAL_MS = 2_000;       // how often the watchdog samples

// ── Watchdog mode (observe / enforce) — s1s2 §12 safety valve ─────────────
// Governs whether the liveness watchdog ACTS (force-close a suspected half-open
// socket → reconnect) or only OBSERVES (log what it WOULD recycle, socket
// untouched). Read ONCE at module load from the S1S2_WATCHDOG_MODE env var (Bun
// auto-loads .env), DEFAULT "enforce" — the branch's goal is ACTIVE watchdogs.
// Setting S1S2_WATCHDOG_MODE=observe reverts to log-only WITHOUT a code change
// (observe-a-day-then-flip, §12). VoiceModule's response-watchdog reads the same
// env var independently.
export type WatchdogMode = "observe" | "enforce";
const WATCHDOG_MODE: WatchdogMode =
  process.env.S1S2_WATCHDOG_MODE === "observe" ? "observe" : "enforce";

// ── Incremental Context Injection ────────────────────────────────
//
// Layer 3 is TOKEN-budgeted (~3000 tokens per CONTEXT-ENGINEERING.md), with
// images in a separate small slot pool. The old 15-ITEM FIFO let 5s-cadence
// screenshots evict retrieved [CONTEXT] text within ~75 seconds.

/** Layer-3 text budget in estimated tokens */
const MAX_CONTEXT_TOKENS_L3 = 3000;
/** Images kept in the conversation at once (token-expensive) */
const MAX_IMAGE_ITEMS = 2;

/** Rough token estimate for mixed zh/en text (zh ≈ 1-2 chars/token, en ≈ 4) */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export interface ContextItem {
  id: string;
  text: string;
  injectedAt: number;
  kind?: "text" | "image";
  tokens?: number;
}

// ── Token Budget Tracking ────────────────────────────────────────

/**
 * Context window size for the Realtime API token-budget tracking.
 * gpt-realtime-2 provides a 128K context window (up from 32K on the 1.x
 * preview), so long meetings use the larger budget before warn/compress fire.
 * Layer-3 budget logic (MAX_CONTEXT_TOKENS_L3) is independent of this value.
 */
const TOTAL_CONTEXT_TOKENS = 128_000;
const TOKEN_WARNING_THRESHOLD = 0.8;   // 80% → emit warning
const TOKEN_COMPRESS_THRESHOLD = 0.9;  // 90% → auto-compress context queue

export interface TokenBudget {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextCapacity: number;       // TOTAL_CONTEXT_TOKENS
  usagePercent: number;          // 0-100
  warningLevel: "ok" | "warning" | "critical";
  responsesTracked: number;
}

// ── RealtimeClient ─────────────────────────────────────────────────

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, EventHandler[]>();
  private _audioLogThrottle = 0;
  private tools: RealtimeTool[] = [];
  private _connected = false;
  private _provider: RealtimeProviderConfig = OPENAI_PROVIDER;

  // Auto-reconnect state
  private _intentionalClose = false;
  private _reconnectRetries = 0;
  private _reconnectTimer: Timer | null = null;
  private _lastInstructions = "";
  private _transcriptContext: string[] = [];  // Recent transcript for context replay
  private _onReconnectFailed?: () => void;

  // ── Connection generation-token (the safety foundation — s1s2 §5 / §14 risk 2) ─
  // A monotonic integer bumped on EVERY connection-lifecycle transition: a fresh
  // connect, an auto-reconnect attempt, a Gemini resume attempt, a forced close
  // (liveness recycle), and an intentional disconnect. Every DEFERRED/async action
  // that will mutate connection or response state CAPTURES this value when it is
  // scheduled and NO-OPs at execution time if `captured !== current` — the
  // connection moved on, so the action is stale. This ONE mechanism is what makes
  // the three watchdogs safe to ACT: it prevents
  //   (a) the response-watchdog (VoiceModule) truncating a response that belongs
  //       to a NEWER generation (a reconnect already superseded it),
  //   (b) the liveness watchdog recycling a healthy-but-NEWER socket, and
  //   (c) the reconnect-supervisor (callingclaw) double-connecting against this
  //       client's own _scheduleReconnect timers.
  // The increment is single-sourced at the top of _connectInternal() (covers
  // fresh connect + reconnect + Gemini resume, which all route through it) plus
  // the forced-close and disconnect paths, so it can never be missed.
  private _connectionGeneration = 0;

  // Fix 1: session-health confirmation. `_reconnectRetries` is reset to 0 ONLY
  // after this flips true (positive inbound event or stable-for-N). Re-armed
  // false on every socket open so each reconnect attempt must re-confirm.
  private _sessionConfirmedHealthy = false;
  private _healthConfirmTimer: Timer | null = null;

  // Fix 3: liveness watchdog state. `_lastInboundTs` is bumped on every inbound
  // frame; `_responseInFlight` marks when the server owes us audio. `_livenessGen`
  // is the connection generation this watchdog was armed for (captured in
  // _startLivenessWatchdog) — a tick whose generation no longer matches the
  // current one belongs to a socket that has been superseded and must NOT recycle
  // the (newer) live socket. `_livenessClosing` guards against a second
  // force-close within the same recycle.
  private _lastInboundTs = 0;
  private _livenessTimer: Timer | null = null;
  private _livenessWarned = false;
  private _responseInFlight = false;
  private _livenessGen = 0;
  private _livenessClosing = false;
  // Observe/enforce valve (s1s2 §12). Defaults to the module-level env read;
  // overridable per-instance (tests). In "observe" _runLivenessCheck detects +
  // logs what it WOULD recycle but does NOT force-close the socket.
  private _livenessMode: WatchdogMode = WATCHDOG_MODE;

  // Incremental context injection queue
  private _contextQueue: ContextItem[] = [];

  // Token budget tracking
  private _tokenBudget: TokenBudget = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    contextCapacity: TOTAL_CONTEXT_TOKENS,
    usagePercent: 0,
    warningLevel: "ok",
    responsesTracked: 0,
  };
  private _onTokenWarning?: (budget: TokenBudget) => void;

  // Gemini protocol adapter (only instantiated for gemini provider)
  private _geminiAdapter: GeminiProtocolAdapter | null = null;

  // Gemini session resumption handle (for reconnect without transcript replay)
  private _geminiSessionHandle: string | null = null;

  // Greeting sent only on the FIRST session.updated of a session — every
  // resume/reconnect also fires setupComplete, and re-prompting made the AI
  // re-introduce itself to the meeting after each 15-min resumption.
  private _geminiGreeted = false;

  get connected() {
    return this._connected;
  }

  get providerName(): VoiceProviderName {
    return this._provider.name;
  }

  get capabilities(): ProviderCapabilities {
    return this._provider.capabilities;
  }

  /**
   * The current connection generation-token (see `_connectionGeneration`).
   * Read by the response-watchdog (VoiceModule) and the reconnect-supervisor
   * (callingclaw) to detect that the socket lifecycle has moved past the point at
   * which a deferred action was scheduled → that action must no-op.
   */
  get connectionGeneration(): number { return this._connectionGeneration; }

  /** Bump the connection generation on a lifecycle transition. Central so the
   *  increment can never be missed by a new connect/reconnect/resume/close path. */
  private _bumpGeneration(reason: string): number {
    this._connectionGeneration++;
    console.log(`[Realtime] connection generation → ${this._connectionGeneration} (${reason})`);
    return this._connectionGeneration;
  }

  addTool(tool: RealtimeTool) {
    this.tools.push(tool);
  }

  /** Register callback for when reconnect retries are exhausted */
  onReconnectFailed(handler: () => void) {
    this._onReconnectFailed = handler;
  }

  /** Register callback for token budget warnings (80% or 90% threshold) */
  onTokenWarning(handler: (budget: TokenBudget) => void) {
    this._onTokenWarning = handler;
  }

  /** Get current token budget state */
  getTokenBudget(): TokenBudget {
    return { ...this._tokenBudget };
  }

  /** Feed transcript entries for context replay on reconnect */
  updateTranscriptContext(entries: Array<{ role: string; text: string }>) {
    this._transcriptContext = entries
      .slice(-RECONNECT_CONTEXT_ENTRIES)
      .map((e) => `[${e.role}] ${e.text}`);
  }

  async connect(systemInstructions?: string, providerName?: VoiceProviderName) {
    // Select provider
    if (providerName) {
      this._provider = getProvider(providerName);
    }

    const provider = this._provider;
    const instructions = systemInstructions || "You are CallingClaw, a helpful voice assistant.";
    this._lastInstructions = instructions;
    this._intentionalClose = false;
    this._reconnectRetries = 0;

    // Gemini: retry initial connection up to 3 times.
    // First attempt often fails with 1006 (Connection ended) due to rate limits
    // from previous sessions or proxy instability.
    // IMPORTANT: set _intentionalClose during retry to prevent onclose auto-reconnect
    // from creating parallel connections.
    if (provider.name === "gemini") {
      this._intentionalClose = true; // Block auto-reconnect during retry loop
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await this._connectInternal(instructions);
          this._intentionalClose = false; // Re-enable auto-reconnect after success
          return;
        } catch (e: any) {
          console.warn(`[Realtime] Gemini connect attempt ${attempt}/3 failed: ${e.message}`);
          if (attempt < 3) {
            await new Promise(r => setTimeout(r, 2000 * attempt));
          } else {
            this._intentionalClose = false;
            throw e;
          }
        }
      }
    }

    return this._connectInternal(instructions);
  }

  private _connectInternal(instructions: string): Promise<void> {
    const provider = this._provider;

    // Connection-lifecycle transition: a NEW socket is about to open. Bump the
    // generation here — this is the single point every path (fresh connect,
    // _scheduleReconnect, _scheduleGeminiResume) funnels through, so any deferred
    // action captured against an older generation now correctly sees itself as
    // stale. (See _connectionGeneration.)
    this._bumpGeneration("connect");

    // Gemini: instantiate protocol adapter + append API key to URL
    if (provider.name === "gemini") {
      this._geminiAdapter = new GeminiProtocolAdapter(CONFIG.gemini.realtimeModel);
    } else {
      this._geminiAdapter = null;
    }

    const wsUrl = provider.name === "gemini"
      ? `${provider.url}?key=${CONFIG.gemini.apiKey}`
      : provider.url;

    return new Promise<void>((resolve, reject) => {
      // Connection timeout (15s) — prevents hanging on proxy/network issues
      const connectTimeout = setTimeout(() => {
        console.error(`[Realtime] Connection timeout (15s) to ${provider.name}`);
        if (this.ws) {
          // Detach BEFORE closing: the identity guard in onclose then ignores
          // this socket, so a failed connect doesn't spawn a zombie reconnect
          // loop for a session the caller was told never started.
          const stale = this.ws;
          this.ws = null as any;
          try { stale.close(); } catch {}
        }
        reject(new Error(`Connection timeout to ${provider.name} Voice API`));
      }, 15000);

      // Gemini: always use `ws` package (not Bun native WebSocket).
      // Reason: Bun WS ignores proxy for wss://, and even without proxy, `ws` package
      // is proven reliable with Gemini's endpoint (tested via gemini-live-ping.ts).
      const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || "";
      if (provider.name === "gemini") {
        const wsOpts: any = {};
        if (proxyUrl) {
          wsOpts.agent = new WsHttpsProxyAgent(proxyUrl);
          console.log(`[Realtime] Using ws+proxy for Gemini`);
        } else {
          console.log(`[Realtime] Using ws (direct) for Gemini`);
        }
        const pws = new WsWebSocket(wsUrl, wsOpts);
        // Create a thin wrapper that maps ws EventEmitter → Bun-style onXxx
        // callbacks. The pws handlers reference THIS wrapper (captured), not
        // this.ws — dereferencing this.ws meant an old socket's close event
        // invoked the NEW connection's close handler after a reconnect.
        const wsWrapper: any = {
          send: (d: any) => pws.send(d),
          close: () => pws.close(),
          get readyState() { return pws.readyState; },
        };
        this.ws = wsWrapper;
        pws.on("open", () => wsWrapper.onopen?.(new Event("open") as any));
        pws.on("message", (d: any) => {
          const str = d.toString();
          // Log first 200 chars of each raw message for debugging
          console.log(`[Realtime] RAW Gemini msg (${str.length} chars): ${str.substring(0, 200)}`);
          wsWrapper.onmessage?.({ data: str } as any);
        });
        pws.on("close", (code: number, reason: any) => {
          console.log(`[Realtime] RAW Gemini close: ${code} ${reason?.toString?.() || ""}`);
          wsWrapper.onclose?.({ code, reason: reason?.toString?.() || "", wasClean: code === 1000 } as any);
        });
        pws.on("error", (e: any) => {
          console.error(`[Realtime] RAW Gemini error:`, e.message || e);
          wsWrapper.onerror?.(e);
        });
      } else {
        // OpenAI / Grok: original Bun WebSocket (unchanged)
        this.ws = new WebSocket(wsUrl, {
          headers: provider.headers,
        } as any);
      }

      // Socket identity guard: handlers below belong to THIS socket. When a
      // reconnect/timeout replaces this.ws, late events from the superseded
      // socket must not flip _connected or schedule a second reconnect.
      const sock = this.ws;

      this.ws.onopen = () => {
        if (this.ws !== sock) return;
        clearTimeout(connectTimeout);
        console.log(`[Realtime] Connected to ${provider.name} Voice API`);
        this._connected = true;

        // Fix 1: do NOT reset _reconnectRetries here. A raw onopen only proves the
        // handshake + auth succeeded, not that the session is usable. Resetting on
        // every open let an open-then-immediately-die socket churn forever without
        // hitting RECONNECT_MAX_RETRIES. Retries reset only once the session is
        // CONFIRMED HEALTHY (see _confirmSessionHealthy): a positive inbound event
        // or the stable-for-N fallback timer armed just below.
        this._sessionConfirmedHealthy = false;
        this._lastInboundTs = Date.now();
        if (this._healthConfirmTimer) clearTimeout(this._healthConfirmTimer);
        this._healthConfirmTimer = setTimeout(() => {
          if (this.ws === sock && this._connected) {
            console.log(`[Realtime] Session stable for ${SESSION_HEALTH_CONFIRM_MS}ms — confirming healthy (${provider.name})`);
            this._confirmSessionHealthy();
          }
        }, SESSION_HEALTH_CONFIRM_MS);

        // Fix 3: begin the (acting, generation-guarded) liveness watchdog for
        // this socket. It captures the current generation so a stale tick can't
        // recycle a newer socket.
        this._startLivenessWatchdog();

        // Use provider's default voice and VAD (no more hardcoded ternaries)
        const voice = provider.defaultVoice;
        const vad = provider.defaultVad;

        // Build and send session config
        const sessionPayload = provider.buildSession({
          instructions,
          tools: this.tools,
          voice,
          vad,
        });

        // Gemini: inject session resumption handle for reconnect
        if (provider.name === "gemini" && this._geminiSessionHandle && sessionPayload.session) {
          sessionPayload.session._resumeHandle = this._geminiSessionHandle;
          console.log(`[Realtime] Injecting Gemini resume handle into setup`);
        }

        // Wire up WS send for Gemini text batching
        if (this._geminiAdapter) {
          this._geminiAdapter.setWsSend((payload) => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              this.ws.send(payload);
            }
          });
        }

        this.sendEvent("session.update", sessionPayload);
        resolve();
      };

      this.ws.onmessage = (event: MessageEvent) => {
        if (this.ws !== sock) return;
        // Fix 3: any inbound frame proves the socket is live (truest liveness
        // signal — includes Gemini keepalives and frames that parse to nothing).
        this._lastInboundTs = Date.now();
        this._livenessWarned = false;
        try {
          const data = typeof event.data === "string" ? event.data : String(event.data);

          // Gemini: route through protocol adapter for structural transform
          if (this._geminiAdapter) {
            const normalized = this._geminiAdapter.transformInbound(data);
            for (const parsed of normalized) {
              this._dispatchEvent(parsed);
            }
            return;
          }

          // OpenAI/Grok: standard {type, ...} parsing with eventMap rename
          const parsed = JSON.parse(data);

          // Normalize event name via provider's event map
          const rawType = parsed.type as string;
          const normalizedType = provider.eventMap[rawType] || rawType;
          if (normalizedType !== rawType) {
            parsed.type = normalizedType;
          }

          this._dispatchEvent(parsed);
        } catch (e) {
          console.error("[Realtime] Parse error:", e);
        }
      };

      this.ws.onerror = (event) => {
        if (this.ws !== sock) return;
        clearTimeout(connectTimeout);
        console.error(`[Realtime] WebSocket error (${provider.name}):`, event);
        reject(new Error(`${provider.name} WebSocket connection failed`));
      };

      this.ws.onclose = (event: CloseEvent) => {
        if (this.ws !== sock) {
          console.log(`[Realtime] Ignoring close from superseded ${provider.name} socket (code: ${event.code})`);
          return;
        }
        console.log(`[Realtime] Disconnected from ${provider.name} (code: ${event.code}, reason: ${event.reason || "none"}, wasClean: ${event.wasClean})`);
        this._connected = false;
        // Socket is gone: tear down per-socket watchdogs and clear the
        // in-flight flag so a stale value can't trip the liveness log later.
        this._stopLivenessWatchdog();
        if (this._healthConfirmTimer) { clearTimeout(this._healthConfirmTimer); this._healthConfirmTimer = null; }
        this._responseInFlight = false;

        // Auto-reconnect if not intentional.
        if (!this._intentionalClose) {
          if (this._provider.name === "gemini") {
            // Gemini: use session resumption handle (avoids rate limits from blind reconnect)
            this._scheduleGeminiResume();
          } else {
            this._scheduleReconnect();
          }
        }
      };
    });
  }

  // ── Event Dispatch (shared by OpenAI/Grok and Gemini paths) ──────

  private _dispatchEvent(parsed: any) {
    // Log events (audio events throttled)
    if (parsed.type?.includes("audio")) {
      if (parsed.type === "response.audio.delta") {
        if (!this._audioLogThrottle || Date.now() - this._audioLogThrottle > 5000) {
          console.log(`[Realtime] Audio streaming... (delta ${parsed.delta?.length || 0} chars)`);
          this._audioLogThrottle = Date.now();
        }
      } else {
        console.log(`[Realtime] Audio event: ${parsed.type}`);
      }
    } else {
      console.log(`[Realtime] Event: ${parsed.type}`);
    }

    // Fix 1: confirm session health on the first POSITIVE inbound event. An
    // `error` event does NOT confirm (a rejected session emits error + close,
    // which must NOT reset the retry cap). session.updated = server accepted our
    // session config; response.audio.delta = it is actively producing audio.
    if (!this._sessionConfirmedHealthy &&
        (parsed.type === "session.updated" || parsed.type === "response.audio.delta")) {
      this._confirmSessionHealthy();
    }

    // Fix 3: track whether the server currently owes us frames, so the liveness
    // watchdog only warns when inbound silence is actually anomalous.
    if (parsed.type === "response.created") {
      this._responseInFlight = true;
    } else if (parsed.type === "response.done") {
      this._responseInFlight = false;
    }

    // Dispatch to handlers using normalized event name
    const listeners = this.handlers.get(parsed.type) || [];
    for (const fn of listeners) fn(parsed);

    const globalListeners = this.handlers.get("*") || [];
    for (const fn of globalListeners) fn(parsed);

    if (parsed.type === "error") {
      console.error("[Realtime] API error:", JSON.stringify(parsed.error, null, 2));
    }

    // Token budget tracking from response.done events
    if (parsed.type === "response.done" && parsed.response?.usage) {
      this._updateTokenBudget(parsed.response.usage);
    }

    // Gemini: inject deferred instruction + greeting after setup completes
    if (parsed.type === "session.updated" && this._geminiAdapter) {
      const deferred = this._geminiAdapter.getDeferredInstruction();
      if (deferred) {
        this.injectContext(`[SYSTEM] ${deferred}`, "ctx_deferred_instr");
        console.log(`[Realtime] Injected deferred instruction (${deferred.length} chars)`);
      }
      // Send greeting prompt so Gemini speaks first — first connect ONLY.
      // session.updated also fires on every 15-min resume/reconnect, and
      // re-prompting made the AI re-introduce itself mid-meeting.
      if (!this._geminiGreeted) {
        this._geminiGreeted = true;
        setTimeout(() => {
          if (this._connected) {
            this.sendText("Please introduce yourself briefly and say hello.");
            console.log(`[Realtime] Sent Gemini greeting prompt`);
          }
        }, 500);
      }
    }

    // Gemini session resumption handle
    if (parsed.type === "gemini.session_resumption" && parsed.handle) {
      this._geminiSessionHandle = parsed.handle;
      console.log(`[Realtime] Gemini session handle updated: ${parsed.handle.substring(0, 20)}...`);
    }

    // Gemini goAway — session about to end, log remaining time
    if (parsed.type === "gemini.go_away") {
      console.warn(`[Realtime] Gemini goAway — session ending soon (timeLeft: ${parsed.timeLeft})`);
    }
  }

  // ── Token Budget Tracking ────────────────────────────────────────

  private _updateTokenBudget(usage: { input_tokens?: number; output_tokens?: number; total_tokens?: number }) {
    this._tokenBudget.inputTokens = usage.input_tokens || 0;
    this._tokenBudget.outputTokens = usage.output_tokens || 0;
    this._tokenBudget.totalTokens = usage.total_tokens || (this._tokenBudget.inputTokens + this._tokenBudget.outputTokens);
    this._tokenBudget.usagePercent = Math.round((this._tokenBudget.totalTokens / TOTAL_CONTEXT_TOKENS) * 100);
    this._tokenBudget.responsesTracked++;

    // Determine warning level
    const ratio = this._tokenBudget.totalTokens / TOTAL_CONTEXT_TOKENS;
    if (ratio >= TOKEN_COMPRESS_THRESHOLD) {
      this._tokenBudget.warningLevel = "critical";
      // Auto-compress: evict half the context queue
      // Gemini: skip eviction (no conversation.item.delete equivalent)
      // Gemini uses built-in contextWindowCompression.slidingWindow instead
      if (this._provider.name !== "gemini") {
        const evictCount = Math.ceil(this._contextQueue.length / 2);
        for (let i = 0; i < evictCount; i++) {
          const oldest = this._contextQueue.shift();
          if (oldest) {
            this.sendEvent("conversation.item.delete", { item_id: oldest.id });
            console.log(`[Realtime] Token critical (${this._tokenBudget.usagePercent}%) — evicted context: ${oldest.id}`);
          }
        }
      } else {
        // Gemini uses server-side slidingWindow compression.
        // But trim local queue to prevent unbounded memory growth.
        const trimCount = Math.ceil(this._contextQueue.length / 2);
        for (let i = 0; i < trimCount; i++) {
          this._contextQueue.shift(); // Local trim only, no delete event
        }
        console.log(`[Realtime] Token critical (${this._tokenBudget.usagePercent}%) — Gemini server-side compression, trimmed ${trimCount} local items`);
      }
    } else if (ratio >= TOKEN_WARNING_THRESHOLD) {
      this._tokenBudget.warningLevel = "warning";
    } else {
      this._tokenBudget.warningLevel = "ok";
    }

    // Notify listener
    if (this._tokenBudget.warningLevel !== "ok" && this._onTokenWarning) {
      this._onTokenWarning(this._tokenBudget);
    }

    // Log periodically (every 10 responses)
    if (this._tokenBudget.responsesTracked % 10 === 0 || this._tokenBudget.warningLevel !== "ok") {
      console.log(
        `[Realtime] Token budget: ${this._tokenBudget.usagePercent}% ` +
        `(${this._tokenBudget.totalTokens}/${TOTAL_CONTEXT_TOKENS}) ` +
        `[${this._tokenBudget.warningLevel}] ` +
        `after ${this._tokenBudget.responsesTracked} responses`
      );
    }
  }

  // ── Auto-Reconnect with Context Replay ───────────────────────────

  private _scheduleReconnect() {
    if (this._reconnectRetries >= RECONNECT_MAX_RETRIES) {
      console.error(`[Realtime] Reconnect failed after ${RECONNECT_MAX_RETRIES} attempts (${this._provider.name})`);
      this._onReconnectFailed?.();
      return;
    }

    // Only one reconnect timer in flight at a time — prevents overlapping
    // reconnect attempts if _scheduleReconnect is entered twice before firing.
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);

    this._reconnectRetries++;
    const delay = RECONNECT_DELAY_MS * this._reconnectRetries; // Linear backoff
    console.log(`[Realtime] Reconnecting to ${this._provider.name} in ${delay}ms (attempt ${this._reconnectRetries}/${RECONNECT_MAX_RETRIES})`);

    // Fix 2: a fresh reconnect opens a BRAND-NEW server session — the accumulated
    // token accounting from the dead session is stale. Re-baseline so a resumed
    // "critical" warningLevel can't immediately force-evict Layer-3 context in the
    // new session. (Gemini RESUME restores server-side state, so
    // _scheduleGeminiResume deliberately does NOT re-baseline — see below.)
    this._resetTokenBudget();

    this._reconnectTimer = setTimeout(async () => {
      // Nit (tighten): null the fired timer BEFORE the await. Once a timer fires
      // its handle is inert, but leaving `_reconnectTimer` non-null across the
      // `await _connectInternal` below left the state dishonest — a concurrent
      // `_scheduleReconnect` (e.g. a late onclose during the connect) would
      // clearTimeout() an already-fired handle while believing it canceled a
      // pending reconnect. Nulling here keeps `_reconnectTimer` truthful ("no
      // scheduled reconnect") for the whole async body; the connection
      // generation-token remains the primary guard against a racing double-connect.
      this._reconnectTimer = null;
      try {
        // Reconnect with clean Layer 0 instructions (no transcript stuffing).
        // Context is restored via _replayContextQueue() after session.updated.
        // See CONTEXT-ENGINEERING.md — transcript in instructions violates layer separation.
        await this._connectInternal(this._lastInstructions);
        console.log(`[Realtime] Reconnected to ${this._provider.name} successfully`);

        // Wait for session.updated before replaying context items
        // (items sent before session is configured may be rejected)
        const replayHandler = () => {
          this._replayContextQueue();
          this._replayTranscriptContext();
        };
        // One-shot listener: replay once after session is configured
        const existingHandlers = this.handlers.get("session.updated") || [];
        const wrappedHandler = (event: any) => {
          replayHandler();
          // Remove this one-shot handler
          const list = this.handlers.get("session.updated") || [];
          const idx = list.indexOf(wrappedHandler);
          if (idx !== -1) list.splice(idx, 1);
        };
        existingHandlers.push(wrappedHandler);
        this.handlers.set("session.updated", existingHandlers);
      } catch (e: any) {
        console.error(`[Realtime] Reconnect attempt ${this._reconnectRetries} failed: ${e.message}`);
        // onclose will fire → _scheduleReconnect again
      }
    }, delay);
  }

  // ── Gemini Session Resumption ──────────────────────────────────
  //
  // Gemini Live has a 15-min session limit. Instead of blind reconnect (which
  // triggers rate limits), use the session resumption handle to resume context.

  private _scheduleGeminiResume() {
    if (!this._geminiSessionHandle) {
      console.warn("[Realtime] Gemini session ended without resume handle — falling back to reconnect");
      this._scheduleReconnect();
      return;
    }

    if (this._reconnectRetries >= RECONNECT_MAX_RETRIES) {
      console.error(`[Realtime] Gemini resume failed after ${RECONNECT_MAX_RETRIES} attempts`);
      this._onReconnectFailed?.();
      return;
    }

    // Single resume timer in flight at a time (mirrors _scheduleReconnect).
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);

    this._reconnectRetries++;
    const delay = RECONNECT_DELAY_MS * this._reconnectRetries;
    console.log(`[Realtime] Gemini session resume in ${delay}ms (attempt ${this._reconnectRetries}/${RECONNECT_MAX_RETRIES}, handle: ${this._geminiSessionHandle.substring(0, 12)}...)`);

    // Fix 2: NO token-budget re-baseline here. A Gemini RESUME restores the
    // server-side session (context window carries over), so its accumulated token
    // usage is still valid — zeroing it would under-report and defeat compaction.

    this._reconnectTimer = setTimeout(async () => {
      try {
        // Store handle before reconnect (connect resets adapter state)
        const resumeHandle = this._geminiSessionHandle;
        await this._connectInternal(this._lastInstructions);
        console.log(`[Realtime] Gemini session resumed successfully`);

        // Inject resume handle into the setup message for this session
        // The adapter's _buildSetupMessage checks for _resumeHandle
        // Note: handle is consumed by _connectInternal → sendEvent("session.update") → adapter
        // But _connectInternal already sent setup by now. We need to pass it differently.
        // The handle must be in the session payload BEFORE the setup is sent.
        // This is handled by passing it via GEMINI_PROVIDER.buildSession() session object.
      } catch (e: any) {
        console.error(`[Realtime] Gemini resume attempt ${this._reconnectRetries} failed: ${e.message}`);
        // onclose will fire → _scheduleGeminiResume again
      }
    }, delay);
  }

  // ── Fix 1: session-health confirmation ───────────────────────────
  //
  // The ONLY place (besides a fresh connect()) that resets `_reconnectRetries`.
  // Called from _dispatchEvent on the first positive inbound event and from the
  // stable-for-N fallback timer armed in onopen. Idempotent per socket.
  private _confirmSessionHealthy() {
    if (this._sessionConfirmedHealthy) return;
    this._sessionConfirmedHealthy = true;
    if (this._reconnectRetries > 0) {
      console.log(`[Realtime] Session confirmed healthy — resetting reconnect retries (was ${this._reconnectRetries}, ${this._provider.name})`);
    }
    this._reconnectRetries = 0;
    if (this._healthConfirmTimer) {
      clearTimeout(this._healthConfirmTimer);
      this._healthConfirmTimer = null;
    }
  }

  // ── Fix 2: token-budget re-baseline ──────────────────────────────
  //
  // Reset token accounting to a clean baseline. Called on a FRESH reconnect
  // (new server session); NOT on a Gemini resume (server-side state carries over).
  private _resetTokenBudget() {
    this._tokenBudget = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextCapacity: TOTAL_CONTEXT_TOKENS,
      usagePercent: 0,
      warningLevel: "ok",
      responsesTracked: 0,
    };
  }

  // ── Fix 3: liveness watchdog (ACTING) ────────────────────────────

  private _startLivenessWatchdog() {
    this._stopLivenessWatchdog();
    this._lastInboundTs = Date.now();
    this._livenessWarned = false;
    this._livenessClosing = false;
    // Capture the generation THIS watchdog is armed for. onopen runs after
    // _connectInternal bumped the generation, so this is the current socket's gen.
    // A later tick whose generation no longer matches belongs to a superseded
    // socket and must not recycle the live one.
    this._livenessGen = this._connectionGeneration;
    this._livenessTimer = setInterval(() => this._runLivenessCheck(), LIVENESS_CHECK_INTERVAL_MS);
  }

  private _stopLivenessWatchdog() {
    if (this._livenessTimer) {
      clearInterval(this._livenessTimer);
      this._livenessTimer = null;
    }
  }

  /**
   * ACTING liveness check. Returns true iff it detected the half-open signature
   * this call (and, when un-superseded, force-closed → reconnect). Detects (once
   * per silent episode) when the socket is connected, a response/audio is
   * expected, yet no inbound frames have arrived for LIVENESS_TIMEOUT_MS.
   *
   * Two safety guards (§5 / §14 risk 2):
   *   • expectation gate (`_responseInFlight || _isSpeaking`) — legitimate quiet
   *     (long user monologue, no inbound) never trips it;
   *   • GENERATION guard — a tick whose captured `_livenessGen` no longer equals
   *     the current `_connectionGeneration` belongs to a socket a newer generation
   *     already replaced → NO-OP (never recycle a healthy newer socket).
   *
   * Exposed (name-mangled private) for unit testing; the interval calls it with
   * the default `now`.
   */
  private _runLivenessCheck(now: number = Date.now()): boolean {
    if (!this._connected || this._intentionalClose) return false;
    // GENERATION guard: this watchdog belongs to the socket that was live when it
    // was armed. If the connection moved on (reconnect / resume / another
    // force-close), recycling now would kill a healthy NEWER socket → step aside.
    if (this._connectionGeneration !== this._livenessGen) return false;
    if (this._livenessClosing) return false; // recycle already in progress
    // "response/audio is expected" — the server owes us frames right now. Without
    // this gate a long user monologue (no inbound) would false-positive.
    const expected = this._responseInFlight || this._isSpeaking;
    if (!expected) {
      this._livenessWarned = false;
      return false;
    }
    const silentMs = now - this._lastInboundTs;
    if (silentMs <= LIVENESS_TIMEOUT_MS) return false;
    if (this._livenessWarned) return false; // one detection per silent episode
    this._livenessWarned = true;

    // OBSERVE valve (s1s2 §12): detected + logged, but DO NOT recycle. Lets a day
    // of dogfooding surface false positives (a healthy-but-quiet socket) BEFORE
    // flipping to enforce, without a code change (S1S2_WATCHDOG_MODE=observe).
    if (this._livenessMode !== "enforce") {
      console.warn(
        `[Realtime] LIVENESS (observe): WOULD recycle — no inbound frames for ${silentMs}ms ` +
        `while a response/audio was expected (provider=${this._provider.name}, ` +
        `speaking=${this._isSpeaking}, responseInFlight=${this._responseInFlight}). ` +
        `Log only, not acting.`
      );
      return true;
    }

    console.warn(
      `[Realtime] LIVENESS: no inbound frames for ${silentMs}ms ` +
      `while a response/audio was expected (provider=${this._provider.name}, ` +
      `speaking=${this._isSpeaking}, responseInFlight=${this._responseInFlight}). ` +
      `Suspected half-open socket — recycling.`
    );
    this._forceCloseForLiveness();
    return true;
  }

  /**
   * Force-close the (suspected half-open) socket and drive the reconnect.
   *
   * AUTHORITY (§5 three-tier): recycling the socket is RealtimeClient's job
   * alone. A half-open socket may NEVER fire `onclose` — the exact death the
   * liveness watchdog exists to catch — so we cannot rely on onclose to trigger
   * reconnect; we drive it ourselves. To avoid a DOUBLE reconnect if the socket's
   * onclose DOES later fire, we DETACH `this.ws` first (the onclose identity
   * guard then ignores the stale socket, exactly as the connect-timeout path does).
   * Bumping the generation immediately invalidates any same-generation guarded
   * action (a second liveness tick, or the response-watchdog for a response that
   * lived on this dying socket).
   */
  private _forceCloseForLiveness() {
    if (this._livenessClosing) return;
    this._livenessClosing = true;
    this._bumpGeneration("liveness-force-close");
    this._stopLivenessWatchdog();
    this._connected = false;
    this._responseInFlight = false;
    this._livenessWarned = false;
    if (this._healthConfirmTimer) { clearTimeout(this._healthConfirmTimer); this._healthConfirmTimer = null; }
    // Detach the dying socket so its late onclose (if any) is ignored → no double
    // reconnect. Then close it best-effort.
    const stale = this.ws;
    this.ws = null as any;
    try { stale?.close(); } catch {}
    // Drive recovery — half-open means onclose won't come. Only when not an
    // intentional teardown (mirrors the onclose reconnect branch).
    if (!this._intentionalClose) {
      if (this._provider.name === "gemini") this._scheduleGeminiResume();
      else this._scheduleReconnect();
    }
  }

  // ── Event Handlers ───────────────────────────────────────────────

  on(eventType: string, handler: EventHandler) {
    const list = this.handlers.get(eventType) || [];
    list.push(handler);
    this.handlers.set(eventType, list);
  }

  // Speaking flag — set by VoiceModule when the audio state changes. Retained
  // ONLY as a liveness signal (Fix 3, _runLivenessCheck). It no longer gates
  // response.create: see the note in sendEvent().
  private _isSpeaking = false;

  /** Set by VoiceModule when audio state changes (liveness signal only) */
  setSpeaking(speaking: boolean) { this._isSpeaking = speaking; }

  /**
   * Fix #2: VoiceModule's response-watchdog calls this when it RECOVERS a stuck
   * response — one that never received an inbound `response.done` (e.g. a
   * barge-in `response.cancel` for which the server never sent `response.done`).
   * The two watchdogs otherwise share NO "the response is resolved" signal: the
   * response-watchdog resets the VoiceModule scheduler gate, but the client's
   * `_responseInFlight` would stay stuck true, keeping the liveness expectation
   * gate open and letting a normal quiet gap force-close a HEALTHY socket. This
   * clears it so the two agree. Idempotent / safe to call redundantly.
   */
  notifyResponseResolved() {
    this._responseInFlight = false;
  }

  sendEvent(type: string, data: any = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;

    // ── response.create gate REMOVED (P1 STEP 1: single-owned response gate) ──
    // RealtimeClient no longer independently gates/debounces/queues
    // response.create. The SOLE authority for the response.create DECISION is
    // now VoiceResponseScheduler (owned by VoiceModule, see modules/voice.ts):
    // it owns acceptance, the single pending slot, the debounce, and the honest
    // disposition. This layer only provides the RAW send + marks that inbound
    // frames are now expected (for the Fix-3 liveness watchdog). The old dual
    // gate — VoiceModule._responseActive + a *second* RealtimeClient
    // debounce/_isSpeaking/_pendingResponseCreate — could disagree (caller told
    // "sent" while it was only queued; debounce silently dropping a distinct
    // payload while reporting success; two competing pending slots overwriting
    // each other). Collapsing to one authority removes that class of bug.
    if (type === "response.create") {
      // Source tracking: log where this came from (helps debug truncation).
      const stack = new Error().stack?.split("\n").slice(2, 4).map(l => l.trim().replace(/^at /, "")).join(" ← ") || "unknown";
      console.log(`[Realtime] response.create from: ${stack}`);
      // Fix 3: we asked the server to produce a response — inbound frames are now
      // expected. Cleared on inbound response.done (see _dispatchEvent).
      this._responseInFlight = true;
    } else if (type === "response.cancel") {
      // Fix #2: a barge-in cancels the in-progress response. The server may NEVER
      // send the matching inbound `response.done` for a cancelled response, so we
      // clear the in-flight expectation HERE. Otherwise `_responseInFlight` stays
      // stuck true, keeps the liveness watchdog's expectation gate
      // (`_responseInFlight || _isSpeaking`) open, and a normal ≥LIVENESS_TIMEOUT_MS
      // quiet gap after the barge-in force-closes a perfectly HEALTHY socket.
      this._responseInFlight = false;
    }

    // Gemini: route through protocol adapter for structural transform
    if (this._geminiAdapter) {
      const geminiPayload = this._geminiAdapter.transformOutbound(type, data);
      if (geminiPayload === null) return true; // No-op for this event (e.g., conversation.item.delete)
      if (type !== "input_audio_buffer.append") {
        console.log(`[Realtime] >>> ${type} → gemini (${geminiPayload.length} bytes)`);
      }
      this.ws.send(geminiPayload);
      return true;
    }

    // OpenAI/Grok: standard {type, ...data} format
    const payload = JSON.stringify({ type, ...data });
    if (type !== "input_audio_buffer.append") {
      console.log(`[Realtime] >>> ${type} (${payload.length} bytes)`);
    }
    this.ws.send(payload);
    return true;
  }

  /** Send audio chunk (PCM16 base64) */
  sendAudio(base64Audio: string) {
    return this.sendEvent("input_audio_buffer.append", {
      audio: base64Audio,
    });
  }

  /** Send video frame (JPEG base64) — Gemini only */
  sendVideo(base64Jpeg: string): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    if (!this._geminiAdapter) {
      console.warn("[Realtime] sendVideo() only supported for Gemini provider");
      return false;
    }
    const payload = this._geminiAdapter.buildVideoFrame(base64Jpeg);
    this.ws.send(payload);
    return true;
  }

  /** Submit tool call result */
  submitToolResult(callId: string, result: string) {
    this.sendEvent("conversation.item.create", {
      item: {
        type: "function_call_output",
        call_id: callId,
        output: result,
      },
    });
    return this.sendEvent("response.create", {});
  }

  /**
   * Submit tool result WITHOUT triggering a model response (backgroundResult pattern).
   * The result is injected into conversation context but the model doesn't start speaking.
   * Use with a separate response.create + instructions for natural filler phrases.
   */
  submitToolResultBackground(callId: string, result: string): boolean {
    return this.sendEvent("conversation.item.create", {
      item: {
        type: "function_call_output",
        call_id: callId,
        output: result,
      },
    });
    // Intentionally NO response.create — caller triggers filler phrase separately
  }

  /** Dynamically update session instructions */
  /** Build a minimal session.update payload with required fields for GA API.
   *  GA API requires session.type on EVERY session.update, not just the first one. */
  private _buildSessionUpdate(fields: Record<string, any>) {
    const session: Record<string, any> = { ...fields };
    // GA API (openai/openai15): every session.update must include type + output_modalities
    // CRITICAL: partial session.update without output_modalities may reset to text-only
    if (this._provider.name === "openai" || this._provider.name === "openai15") {
      session.type = "realtime";
      if (!session.output_modalities) {
        session.output_modalities = ["audio"];
      }
    }
    return { session };
  }

  updateInstructions(instructions: string) {
    this._lastInstructions = instructions;
    // Gemini: session.update mid-session causes disconnect. Inject as context instead.
    if (this._provider.name === "gemini") {
      return !!this.injectContext(`[SYSTEM UPDATE] ${instructions.slice(0, 500)}`, "ctx_instr_update");
    }
    return this.sendEvent("session.update", this._buildSessionUpdate({ instructions }));
  }

  /** Dynamically update the voice */
  updateVoice(voice: string) {
    // Gemini: voice can only be set in initial setup, not mid-session
    if (this._provider.name === "gemini") {
      console.log(`[Realtime] Voice update skipped for Gemini (only settable in setup)`);
      return true;
    }
    return this.sendEvent("session.update", this._buildSessionUpdate({ voice }));
  }

  /** Dynamically update session tools */
  updateTools(tools: RealtimeTool[]) {
    this.tools = tools;
    // Gemini: tools can only be set in initial setup
    if (this._provider.name === "gemini") {
      console.log(`[Realtime] Tools update skipped for Gemini (only settable in setup)`);
      return true;
    }
    return this.sendEvent("session.update", this._buildSessionUpdate({
      tools: tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    }));
  }

  // ── Incremental Context Injection ─────────────────────────────────
  //
  // Instead of session.update (which defers during in-progress responses
  // and can cause audio breaks), inject context as conversation items.
  // These are immediately visible to the model on its next turn without
  // disrupting the current response.

  /**
   * Inject context into the conversation as a system message.
   * Does NOT trigger a response — the model sees it on the next turn.
   * FIFO eviction: oldest items are deleted when queue exceeds MAX_CONTEXT_ITEMS.
   *
   * @param text - The context text to inject (e.g., "[CONTEXT] PRD目标是...")
   * @param id - Optional custom item ID (auto-generated if omitted)
   * @returns The item ID if sent, false if not connected
   */
  injectContext(text: string, id?: string): string | false {
    if (!this._connected) return false;
    if (!text) return false;

    const itemId = id || `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    const sent = this.sendEvent("conversation.item.create", {
      item: {
        id: itemId,
        type: "message",
        role: "system",
        content: [{ type: "input_text", text }],
      },
    });

    if (!sent) return false;

    this._contextQueue.push({ id: itemId, text, injectedAt: Date.now(), kind: "text", tokens: estimateTokens(text) });
    this._evictTextOverBudget();

    return itemId;
  }

  /** Evict oldest TEXT items while the Layer-3 text budget is exceeded */
  private _evictTextOverBudget() {
    const textTokens = () => this._contextQueue
      .filter((c) => c.kind !== "image")
      .reduce((sum, c) => sum + (c.tokens ?? estimateTokens(c.text)), 0);
    while (textTokens() > MAX_CONTEXT_TOKENS_L3) {
      const idx = this._contextQueue.findIndex((c) => c.kind !== "image");
      if (idx === -1) break;
      const oldest = this._contextQueue.splice(idx, 1)[0]!;
      this.sendEvent("conversation.item.delete", { item_id: oldest.id });
      console.log(`[Realtime] Context evicted: ${oldest.id} (text budget ${MAX_CONTEXT_TOKENS_L3} tokens)`);
    }
  }

  /**
   * Inject a screenshot image into the voice model's conversation.
   * Provider-aware: openai15 gets input_image, gemini gets realtimeInput.video,
   * openai/grok fall back to text caption.
   *
   * @param base64Jpeg - Base64-encoded JPEG image (no data: prefix)
   * @param caption - Optional text description alongside the image
   * @returns The item ID if sent, false if not connected or unsupported
   */
  injectImage(base64Jpeg: string, caption?: string): string | false {
    if (!this._connected || !base64Jpeg) return false;

    // Grok + legacy OpenAI: no image support — fall back to text caption
    if (this._provider.name === "grok" || this._provider.name === "openai") {
      if (caption) return this.injectContext(`[SCREENSHOT] ${caption}`);
      return false;
    }

    const itemId = `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    const content: any[] = [];
    if (caption) {
      content.push({ type: "input_text", text: caption });
    }
    content.push({ type: "input_image", image: base64Jpeg });

    const sent = this.sendEvent("conversation.item.create", {
      item: {
        id: itemId,
        type: "message",
        role: "user",
        content,
      },
    });

    if (!sent) return false;

    this._contextQueue.push({ id: itemId, text: `[IMAGE] ${caption || "screenshot"}`, injectedAt: Date.now(), kind: "image" });

    // Images live in their own slot pool — they no longer evict retrieved
    // text context (screenshot spam was flushing [CONTEXT] items in ~75s)
    const images = this._contextQueue.filter((c) => c.kind === "image");
    let excess = images.length - MAX_IMAGE_ITEMS;
    while (excess-- > 0) {
      const idx = this._contextQueue.findIndex((c) => c.kind === "image");
      if (idx === -1) break;
      const oldest = this._contextQueue.splice(idx, 1)[0]!;
      this.sendEvent("conversation.item.delete", { item_id: oldest.id });
      console.log(`[Realtime] Image evicted: ${oldest.id} (max ${MAX_IMAGE_ITEMS} images)`);
    }

    console.log(`[Realtime] Injected image ${itemId} (${Math.round(base64Jpeg.length / 1024)}KB${caption ? `, caption: ${caption.slice(0, 60)}` : ""})`);
    return itemId;
  }

  /**
   * Remove a specific context item by ID.
   * @returns true if the delete event was sent
   */
  removeContext(itemId: string): boolean {
    const idx = this._contextQueue.findIndex((c) => c.id === itemId);
    if (idx !== -1) this._contextQueue.splice(idx, 1);
    return this.sendEvent("conversation.item.delete", { item_id: itemId });
  }

  /** Get a copy of the current context queue (for debugging/status) */
  getContextQueue(): readonly ContextItem[] {
    return this._contextQueue;
  }

  /** Clear the context queue (e.g., when session ends) */
  clearContextQueue() {
    this._contextQueue = [];
  }

  /**
   * Replay all context items after a reconnect.
   * Called internally after session.updated is received on reconnect.
   */
  private _replayContextQueue() {
    if (this._contextQueue.length === 0) return;

    console.log(`[Realtime] Replaying ${this._contextQueue.length} context items after reconnect`);
    for (const item of this._contextQueue) {
      // Image payloads aren't retained — replaying "[IMAGE] caption" as text
      // would mislead the model about what it can currently see
      if (item.kind === "image") continue;
      this.sendEvent("conversation.item.create", {
        item: {
          id: item.id,
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: item.text }],
        },
      });
    }
  }

  /**
   * Replay recent transcript as conversation items after a reconnect.
   * Unlike stuffing transcript into instructions, this preserves proper
   * conversation structure (user/assistant roles) so the model can
   * distinguish who said what and maintain coherent turn-taking.
   */
  private _replayTranscriptContext() {
    if (this._transcriptContext.length === 0) return;

    console.log(`[Realtime] Replaying ${this._transcriptContext.length} transcript entries after reconnect`);
    for (const entry of this._transcriptContext) {
      // Parse "[role] text" format produced by updateTranscriptContext()
      const match = entry.match(/^\[(\w+)\]\s(.+)/s);
      if (match) {
        const [, role, text] = match;
        // system entries ([Tool Call]/[HEARD]/[Screen]) must replay as system
        // items — replaying them as "user" made the model respond to its own
        // logs as if the user had said them
        const mappedRole = role === "assistant" ? "assistant" : role === "system" ? "system" : "user";
        this.sendEvent("conversation.item.create", {
          item: {
            type: "message",
            role: mappedRole,
            content: [{ type: "input_text", text }],
          },
        });
      }
    }
  }

  /** Send text message */
  sendText(text: string) {
    this.sendEvent("conversation.item.create", {
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    return this.sendEvent("response.create", {});
  }

  disconnect() {
    this._intentionalClose = true;
    // Connection-lifecycle transition: an intentional teardown. Bumping the
    // generation lets the reconnect-supervisor's guard see that the socket moved
    // on, so a restart it had scheduled before the stop NO-OPs (never resurrect a
    // session the caller deliberately stopped).
    this._bumpGeneration("disconnect");
    this._livenessClosing = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    // Tear down the per-socket watchdogs (Fix 1 + Fix 3) so a deliberate
    // teardown leaves no dangling timers.
    this._stopLivenessWatchdog();
    if (this._healthConfirmTimer) {
      clearTimeout(this._healthConfirmTimer);
      this._healthConfirmTimer = null;
    }
    this._responseInFlight = false;
    this._livenessWarned = false;
    this.ws?.close();
    this._connected = false;
    // A new session must not inherit the previous one's state: a stale
    // resume handle made the next meeting try to resume the previous
    // (expired) Gemini session, and an un-cleared queue replayed the
    // previous meeting's context items after reconnect.
    this._geminiSessionHandle = null;
    this._geminiGreeted = false;
    this._contextQueue = [];
    this._transcriptContext = [];
  }
}
