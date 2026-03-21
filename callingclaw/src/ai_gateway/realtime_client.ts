// CallingClaw 2.0 — Realtime Voice WebSocket Client (Multi-Provider)
//
// Supports OpenAI Realtime API and Grok Voice Agent via provider config.
// Provider differences are isolated in RealtimeProviderConfig objects:
//   - Connection URL + auth headers
//   - session.update format (audio config shape differs)
//   - Event name mapping (3 audio events differ between providers)
//   - Auto-reconnect with transcript context replay (both providers)
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
//     ├── provider: RealtimeProviderConfig (openai | grok)
//     ├── connect() → provider.url + provider.headers + provider.buildSession()
//     ├── onmessage → provider.eventMap normalizes event names
//     ├── injectContext() → conversation.item.create (incremental, no audio break)
//     ├── removeContext() → conversation.item.delete (FIFO eviction)
//     └── onclose → auto-reconnect with context + context queue replay

import { CONFIG } from "../config";

// ── Provider Config Types ──────────────────────────────────────────

export type VoiceProviderName = "openai" | "grok";

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
    "OpenAI-Beta": "realtime=v1",
  },
  // OpenAI → normalized: no mapping needed (these ARE the canonical names)
  eventMap: {},
  capabilities: {
    supportsInterruption: true,
    supportsResume: false,
    supportsNativeTools: true,
    supportsTranscription: true,
    audioFormats: ["pcm16"],
    maxSessionMinutes: 120,
  },
  buildSession({ instructions, tools, voice, vad }) {
    return {
      session: {
        modalities: ["text", "audio"],
        voice,
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        input_audio_transcription: { model: "whisper-1" },
        instructions,
        tools: tools.map((t) => ({
          type: "function",
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
        turn_detection: { type: "server_vad", ...vad },
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
          // Grok native tools (free, no token cost)
          { type: "web_search" },
          { type: "x_search" },
          // CallingClaw function tools
          ...tools.map((t) => ({
            type: "function",
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        ],
        turn_detection: { type: "server_vad", ...vad },
      },
    };
  },
};

const PROVIDERS: Record<VoiceProviderName, RealtimeProviderConfig> = {
  openai: OPENAI_PROVIDER,
  grok: GROK_PROVIDER,
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

    return this._connectInternal(instructions);
  }

  private _connectInternal(instructions: string): Promise<void> {
    const provider = this._provider;

    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(provider.url, {
        headers: provider.headers,
      } as any);

      this.ws.onopen = () => {
        console.log(`[Realtime] Connected to ${provider.name} Voice API`);
        this._connected = true;
        this._reconnectRetries = 0;

        // Determine voice for this provider
        const voice = provider.name === "grok"
          ? CONFIG.grok.voice
          : CONFIG.openai.voice;

        // Build and send session config
        const sessionPayload = provider.buildSession({
          instructions,
          tools: this.tools,
          voice,
          vad: {
            threshold: provider.name === "grok" ? 0.85 : 0.5,
            prefix_padding_ms: provider.name === "grok" ? 333 : 300,
            silence_duration_ms: provider.name === "grok" ? 800 : 500,
          },
        });

        this.sendEvent("session.update", sessionPayload);
        resolve();
      };

      this.ws.onmessage = (event: MessageEvent) => {
        try {
          const data = typeof event.data === "string" ? event.data : String(event.data);
          const parsed = JSON.parse(data);

          // Normalize event name via provider's event map
          const rawType = parsed.type as string;
          const normalizedType = provider.eventMap[rawType] || rawType;
          if (normalizedType !== rawType) {
            parsed.type = normalizedType;
          }

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
        } catch (e) {
          console.error("[Realtime] Parse error:", e);
        }
      };

      this.ws.onerror = (event) => {
        console.error(`[Realtime] WebSocket error (${provider.name}):`, event);
        reject(new Error(`${provider.name} WebSocket connection failed`));
      };

      this.ws.onclose = (event: CloseEvent) => {
        console.log(`[Realtime] Disconnected from ${provider.name} (code: ${event.code}, reason: ${event.reason || "none"}, wasClean: ${event.wasClean})`);
        this._connected = false;

        // Auto-reconnect if not intentional
        if (!this._intentionalClose) {
          this._scheduleReconnect();
        }
      };
    });
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
      const evictCount = Math.ceil(this._contextQueue.length / 2);
      for (let i = 0; i < evictCount; i++) {
        const oldest = this._contextQueue.shift();
        if (oldest) {
          this.sendEvent("conversation.item.delete", { item_id: oldest.id });
          console.log(`[Realtime] Token critical (${this._tokenBudget.usagePercent}%) — evicted context: ${oldest.id}`);
        }
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

  // ── Event Handlers ───────────────────────────────────────────────

  on(eventType: string, handler: EventHandler) {
    const list = this.handlers.get(eventType) || [];
    list.push(handler);
    this.handlers.set(eventType, list);
  }

  sendEvent(type: string, data: any = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
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

  /** Dynamically update session instructions */
  updateInstructions(instructions: string) {
    this._lastInstructions = instructions;
    return this.sendEvent("session.update", {
      session: { instructions },
    });
  }

  /** Dynamically update the voice */
  updateVoice(voice: string) {
    return this.sendEvent("session.update", {
      session: { voice },
    });
  }

  /** Dynamically update session tools */
  updateTools(tools: RealtimeTool[]) {
    this.tools = tools;
    return this.sendEvent("session.update", {
      session: {
        tools: tools.map((t) => ({
          type: "function",
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    });
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
