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
    // GA API: no "OpenAI-Beta" header needed (removed for gpt-realtime-1.5)
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

// ── OpenAI 1.5 GA Provider ─────────────────────────────────────────
// gpt-realtime-1.5: GA API (no beta header), new event names, session.type required.
// Key differences from legacy:
//   - No "OpenAI-Beta: realtime=v1" header
//   - session.update requires type: "realtime"
//   - Event names changed: response.text.delta → response.output_text.delta, etc.
//   - New features: semantic_vad, image input, MCP servers, async function calling
//   - Transcription: gpt-4o-transcribe with language hint (prevents zh→foreign misrecognition)

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

// ── Incremental Context Injection ────────────────────────────────

/** Max context items before FIFO eviction kicks in */
const MAX_CONTEXT_ITEMS = 15;

export interface ContextItem {
  id: string;
  text: string;
  injectedAt: number;
}

// ── Token Budget Tracking ────────────────────────────────────────

/** Estimated context window size for the Realtime API */
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

  get connected() {
    return this._connected;
  }

  get providerName(): VoiceProviderName {
    return this._provider.name;
  }

  get capabilities(): ProviderCapabilities {
    return this._provider.capabilities;
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
          try { this.ws.close(); } catch {}
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
        // Create a thin wrapper that maps ws EventEmitter → Bun-style onXxx callbacks
        this.ws = {
          send: (d: any) => pws.send(d),
          close: () => pws.close(),
          get readyState() { return pws.readyState; },
        } as any;
        pws.on("open", () => this.ws!.onopen?.(new Event("open") as any));
        pws.on("message", (d: any) => {
          const str = d.toString();
          // Log first 200 chars of each raw message for debugging
          console.log(`[Realtime] RAW Gemini msg (${str.length} chars): ${str.substring(0, 200)}`);
          this.ws!.onmessage?.({ data: str } as any);
        });
        pws.on("close", (code: number, reason: any) => {
          console.log(`[Realtime] RAW Gemini close: ${code} ${reason?.toString?.() || ""}`);
          this.ws!.onclose?.({ code, reason: reason?.toString?.() || "", wasClean: code === 1000 } as any);
        });
        pws.on("error", (e: any) => {
          console.error(`[Realtime] RAW Gemini error:`, e.message || e);
          this.ws!.onerror?.(e);
        });
      } else {
        // OpenAI / Grok: original Bun WebSocket (unchanged)
        this.ws = new WebSocket(wsUrl, {
          headers: provider.headers,
        } as any);
      }

      this.ws.onopen = () => {
        clearTimeout(connectTimeout);
        console.log(`[Realtime] Connected to ${provider.name} Voice API`);
        this._connected = true;
        this._reconnectRetries = 0;

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
        clearTimeout(connectTimeout);
        console.error(`[Realtime] WebSocket error (${provider.name}):`, event);
        reject(new Error(`${provider.name} WebSocket connection failed`));
      };

      this.ws.onclose = (event: CloseEvent) => {
        console.log(`[Realtime] Disconnected from ${provider.name} (code: ${event.code}, reason: ${event.reason || "none"}, wasClean: ${event.wasClean})`);
        this._connected = false;

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
      // Send greeting prompt so Gemini speaks first
      setTimeout(() => {
        if (this._connected) {
          this.sendText("Please introduce yourself briefly and say hello.");
          console.log(`[Realtime] Sent Gemini greeting prompt`);
        }
      }, 500);
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

    this._reconnectRetries++;
    const delay = RECONNECT_DELAY_MS * this._reconnectRetries; // Linear backoff
    console.log(`[Realtime] Reconnecting to ${this._provider.name} in ${delay}ms (attempt ${this._reconnectRetries}/${RECONNECT_MAX_RETRIES})`);

    this._reconnectTimer = setTimeout(async () => {
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

    this._reconnectRetries++;
    const delay = RECONNECT_DELAY_MS * this._reconnectRetries;
    console.log(`[Realtime] Gemini session resume in ${delay}ms (attempt ${this._reconnectRetries}/${RECONNECT_MAX_RETRIES}, handle: ${this._geminiSessionHandle.substring(0, 12)}...)`);

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

  // ── Event Handlers ───────────────────────────────────────────────

  on(eventType: string, handler: EventHandler) {
    const list = this.handlers.get(eventType) || [];
    list.push(handler);
    this.handlers.set(eventType, list);
  }

  private _lastResponseCreateTs = 0;
  private _pendingResponseCreate: any | null = null;  // Queued response.create waiting for speech to finish
  private _isSpeaking = false;

  /** Set by VoiceModule when audio state changes */
  setSpeaking(speaking: boolean) { this._isSpeaking = speaking; }

  /** Flush pending response.create — call when audio state leaves "speaking" */
  flushPendingResponse() {
    if (this._pendingResponseCreate) {
      const pending = this._pendingResponseCreate;
      this._pendingResponseCreate = null;
      console.log(`[Realtime] Flushing queued response.create`);
      this.sendEvent("response.create", pending);
    }
  }

  sendEvent(type: string, data: any = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;

    // Guard response.create — the main source of audio truncation bugs
    if (type === "response.create") {
      const now = Date.now();
      // Source tracking: log where this came from (helps debug truncation)
      const stack = new Error().stack?.split("\n").slice(2, 4).map(l => l.trim().replace(/^at /, "")).join(" ← ") || "unknown";
      console.log(`[Realtime] response.create from: ${stack}`);
      // Debounce: skip if <500ms since last
      if (now - this._lastResponseCreateTs < 500) {
        console.log(`[Realtime] response.create debounced (${now - this._lastResponseCreateTs}ms)`);
        return true;
      }
      // Queue if speaking
      if (this._isSpeaking) {
        this._pendingResponseCreate = data;
        console.log(`[Realtime] response.create queued (AI is speaking)`);
        return true;
      }
      this._lastResponseCreateTs = now;
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

    this._contextQueue.push({ id: itemId, text, injectedAt: Date.now() });

    // FIFO eviction — delete oldest items when over limit
    while (this._contextQueue.length > MAX_CONTEXT_ITEMS) {
      const oldest = this._contextQueue.shift()!;
      this.sendEvent("conversation.item.delete", { item_id: oldest.id });
      console.log(`[Realtime] Context evicted: ${oldest.id} (queue full, max ${MAX_CONTEXT_ITEMS})`);
    }

    return itemId;
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

    this._contextQueue.push({ id: itemId, text: `[IMAGE] ${caption || "screenshot"}`, injectedAt: Date.now() });

    // FIFO eviction — images are token-expensive, evict aggressively
    while (this._contextQueue.length > MAX_CONTEXT_ITEMS) {
      const oldest = this._contextQueue.shift()!;
      this.sendEvent("conversation.item.delete", { item_id: oldest.id });
      console.log(`[Realtime] Context evicted: ${oldest.id} (queue full)`);
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
        const mappedRole = role === "assistant" ? "assistant" : "user";
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
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this.ws?.close();
    this._connected = false;
  }
}
