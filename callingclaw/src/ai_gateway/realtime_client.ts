// CallingClaw 2.0 — OpenAI Realtime WebSocket Client (Bun native WebSocket)

import { CONFIG } from "../config";

export interface RealtimeTool {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

type EventHandler = (event: any) => void;

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, EventHandler[]>();
  private _audioLogThrottle = 0;
  private tools: RealtimeTool[] = [];
  private _connected = false;

  get connected() {
    return this._connected;
  }

  addTool(tool: RealtimeTool) {
    this.tools.push(tool);
  }

  async connect(systemInstructions?: string) {
    const url = `${CONFIG.openai.realtimeUrl}?model=${CONFIG.openai.realtimeModel}`;

    return new Promise<void>((resolve, reject) => {
      // Bun native WebSocket with custom headers
      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${CONFIG.openai.apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      } as any);

      this.ws.onopen = () => {
        console.log("[Realtime] Connected to OpenAI Realtime API");
        this._connected = true;

        // Configure session
        this.sendEvent("session.update", {
          session: {
            modalities: ["text", "audio"],
            voice: CONFIG.openai.voice,
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            input_audio_transcription: { model: "whisper-1" },
            instructions: systemInstructions || "You are CallingClaw, a helpful voice assistant.",
            tools: this.tools.map((t) => ({
              type: "function",
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            })),
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
            },
          },
        });
        resolve();
      };

      this.ws.onmessage = (event: MessageEvent) => {
        try {
          const data = typeof event.data === "string" ? event.data : String(event.data);
          const parsed = JSON.parse(data);

          // Log events (audio events logged sparingly to avoid spam)
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

          const listeners = this.handlers.get(parsed.type) || [];
          for (const fn of listeners) fn(parsed);

          // Global handler
          const globalListeners = this.handlers.get("*") || [];
          for (const fn of globalListeners) fn(parsed);

          // Log errors from the API
          if (parsed.type === "error") {
            console.error("[Realtime] API error:", JSON.stringify(parsed.error, null, 2));
          }
        } catch (e) {
          console.error("[Realtime] Parse error:", e);
        }
      };

      this.ws.onerror = (event) => {
        console.error("[Realtime] WebSocket error:", event);
        reject(new Error("WebSocket connection failed"));
      };

      this.ws.onclose = (event: CloseEvent) => {
        console.log(`[Realtime] Disconnected (code: ${event.code}, reason: ${event.reason || "none"})`);
        this._connected = false;
      };
    });
  }

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

  // Send audio chunk (PCM16 base64)
  sendAudio(base64Audio: string) {
    return this.sendEvent("input_audio_buffer.append", {
      audio: base64Audio,
    });
  }

  // Submit tool call result
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

  /** Dynamically update session instructions (e.g. when context changes) */
  updateInstructions(instructions: string) {
    return this.sendEvent("session.update", {
      session: { instructions },
    });
  }

  /** Dynamically update the voice (e.g. alloy, ash, ballad, coral, echo, sage, shimmer, verse) */
  updateVoice(voice: string) {
    return this.sendEvent("session.update", {
      session: { voice },
    });
  }

  /** Dynamically update session tools (e.g. when TranscriptAuditor takes over automation) */
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

  // Send text message
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
    this.ws?.close();
    this._connected = false;
  }
}
