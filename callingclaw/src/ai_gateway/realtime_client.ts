// CallingClaw 2.0 — Realtime Voice WebSocket Client (Multi-Provider)
//
// Supports OpenAI Realtime API and Grok Voice Agent via provider config.
// Provider differences are isolated in RealtimeProviderConfig objects:
//   - Connection URL + auth headers
//   - session.update format (audio config shape differs)
//   - Event name mapping (3 audio events differ between providers)
//   - Auto-reconnect with transcript context replay (both providers)
//
// Architecture:
//   RealtimeClient
//     ├── provider: RealtimeProviderConfig (openai | grok)
//     ├── connect() → provider.url + provider.headers + provider.buildSession()
//     ├── onmessage → provider.eventMap normalizes event names
//     └── onclose → auto-reconnect with context replay (max 3 retries)

import { CONFIG } from "../config";

// ── Provider Config Types ──────────────────────────────────────────

export type VoiceProviderName = "openai" | "grok";

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

  get connected() {
    return this._connected;
  }

  get providerName(): VoiceProviderName {
    return this._provider.name;
  }

  addTool(tool: RealtimeTool) {
    this.tools.push(tool);
  }

  /** Register callback for when reconnect retries are exhausted */
  onReconnectFailed(handler: () => void) {
    this._onReconnectFailed = handler;
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
        } catch (e) {
          console.error("[Realtime] Parse error:", e);
        }
      };

      this.ws.onerror = (event) => {
        console.error(`[Realtime] WebSocket error (${provider.name}):`, event);
        reject(new Error(`${provider.name} WebSocket connection failed`));
      };

      this.ws.onclose = (event: CloseEvent) => {
        console.log(`[Realtime] Disconnected from ${provider.name} (code: ${event.code}, reason: ${event.reason || "none"})`);
        this._connected = false;

        // Auto-reconnect if not intentional
        if (!this._intentionalClose) {
          this._scheduleReconnect();
        }
      };
    });
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
        // Rebuild instructions with transcript context for continuity
        let instructions = this._lastInstructions;
        if (this._transcriptContext.length > 0) {
          const contextBlock = this._transcriptContext.join("\n");
          instructions += `\n\n═══ RECONNECTED SESSION ═══\nThe previous session disconnected. Here is the recent conversation context:\n${contextBlock}\n═══ Continue the conversation naturally. ═══`;
        }
        await this._connectInternal(instructions);
        console.log(`[Realtime] Reconnected to ${this._provider.name} successfully`);
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
    this.ws.send(JSON.stringify({ type, ...data }));
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
