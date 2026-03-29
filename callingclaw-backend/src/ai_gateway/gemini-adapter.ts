// CallingClaw 2.0 — Gemini Live API Protocol Adapter
//
// Gemini Live uses a fundamentally different protocol from OpenAI/Grok:
//   - No `type` field — envelope key IS the message type
//   - Client sends: { setup }, { realtimeInput }, { clientContent }, { toolResponse }
//   - Server sends: { setupComplete }, { serverContent }, { toolCall }, { goAway }, etc.
//
// This adapter transforms between CallingClaw's normalized event format
// (OpenAI-compatible) and Gemini's envelope format. It sits between
// RealtimeClient.sendEvent() and the raw WebSocket.
//
// Architecture:
//   VoiceModule (normalized events)
//       ↓
//   RealtimeClient
//       ├── OpenAI WS  (direct, eventMap={})
//       ├── Grok WS    (eventMap remaps 3 audio events)
//       └── GeminiProtocolAdapter → Gemini WS (structural transform)
//            ├── transformOutbound(): normalized event → Gemini JSON string
//            ├── transformInbound(): Gemini JSON string → normalized event(s)
//            └── resampleAudio(): 24kHz PCM16 → 16kHz PCM16

import type { RealtimeTool } from "./realtime_client";

// ── Audio Resampler ─────────────────────────────────────────────────
// PCM16 base64: 24kHz → 16kHz (ratio 1.5: every 3 input samples → 2 output)
// Uses nearest-neighbor (same technique as voice-test.html:612-620)

export function resampleAudio24kTo16k(base64_24k: string): string {
  if (!base64_24k) return "";

  // Decode base64 → Int16Array
  const binary = atob(base64_24k);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const input = new Int16Array(bytes.buffer);

  if (input.length === 0) return "";

  // Downsample 24kHz → 16kHz (ratio 1.5)
  const ratio = 24000 / 16000; // 1.5
  const outLen = Math.round(input.length / ratio);
  const output = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    output[i] = input[Math.round(i * ratio)] || 0;
  }

  // Encode back to base64
  const outBytes = new Uint8Array(output.buffer);
  const CHUNK = 0x2000;
  const parts: string[] = [];
  for (let i = 0; i < outBytes.length; i += CHUNK) {
    parts.push(String.fromCharCode(...outBytes.subarray(i, i + CHUNK)));
  }
  return btoa(parts.join(""));
}

// ── Normalized Event (CallingClaw internal format, OpenAI-compatible) ──

interface NormalizedEvent {
  type: string;
  [key: string]: any;
}

// ── Gemini Protocol Adapter ─────────────────────────────────────────

export class GeminiProtocolAdapter {

  // ── Outbound: Normalized event → Gemini JSON string ──────────────
  // Returns null if the event has no Gemini equivalent (e.g., conversation.item.delete)

  transformOutbound(type: string, data: any): string | null {
    try {
      switch (type) {
        case "session.update":
          return this._buildSetupMessage(data);

        case "input_audio_buffer.append":
          return this._buildAudioInput(data);

        case "response.create":
          // Gemini auto-responds; sending turnComplete signals "I'm done talking"
          return JSON.stringify({ clientContent: { turnComplete: true } });

        case "conversation.item.create":
          return this._buildConversationItem(data);

        case "conversation.item.delete":
          // Gemini has no individual item deletion — no-op
          return null;

        default:
          console.log(`[GeminiAdapter] Unmapped outbound event: ${type}`);
          return null;
      }
    } catch (e: any) {
      console.error(`[GeminiAdapter] Outbound transform error for ${type}:`, e.message);
      return null;
    }
  }

  // ── Inbound: Gemini JSON string → array of normalized events ─────
  // Returns an array because one Gemini message can emit multiple normalized events
  // (e.g., setupComplete → session.created + session.updated)

  transformInbound(raw: string): NormalizedEvent[] {
    try {
      const msg = JSON.parse(raw);

      if (msg.setupComplete !== undefined) {
        return [
          { type: "session.created" },
          { type: "session.updated" },
        ];
      }

      if (msg.serverContent) {
        return this._parseServerContent(msg.serverContent);
      }

      if (msg.toolCall) {
        return this._parseToolCall(msg.toolCall);
      }

      if (msg.toolCallCancellation) {
        // Tool call was cancelled (e.g., user interrupted)
        const ids = msg.toolCallCancellation.ids || [];
        return ids.map((id: string) => ({
          type: "response.function_call_cancelled",
          call_id: id,
        }));
      }

      if (msg.goAway) {
        return [{
          type: "gemini.go_away",
          timeLeft: msg.goAway.timeLeft,
        }];
      }

      if (msg.sessionResumptionUpdate) {
        return [{
          type: "gemini.session_resumption",
          handle: msg.sessionResumptionUpdate.newHandle,
        }];
      }

      if (msg.inputTranscription) {
        return [{
          type: "conversation.item.input_audio_transcription.completed",
          transcript: msg.inputTranscription.text || "",
        }];
      }

      if (msg.outputTranscription) {
        return [{
          type: "response.audio_transcript.done",
          transcript: msg.outputTranscription.text || "",
        }];
      }

      if (msg.usageMetadata) {
        return [{
          type: "response.done",
          response: {
            usage: {
              input_tokens: msg.usageMetadata.promptTokenCount || 0,
              output_tokens: msg.usageMetadata.candidatesTokenCount || 0,
              total_tokens: msg.usageMetadata.totalTokenCount || 0,
            },
          },
        }];
      }

      // Unknown envelope — log and skip
      const keys = Object.keys(msg);
      if (keys.length > 0) {
        console.log(`[GeminiAdapter] Unknown inbound envelope key: ${keys[0]}`);
      }
      return [];
    } catch (e: any) {
      console.error(`[GeminiAdapter] Inbound parse error:`, e.message);
      return [];
    }
  }

  // ── Video frame transform ────────────────────────────────────────

  buildVideoFrame(base64Jpeg: string): string {
    return JSON.stringify({
      realtimeInput: {
        video: {
          data: base64Jpeg,
          mimeType: "image/jpeg",
        },
      },
    });
  }

  // ── Private: Outbound message builders ────────────────────────────

  private _buildSetupMessage(data: any): string {
    const session = data.session || data;
    const tools = (session.tools || [])
      .filter((t: any) => t.type === "function")
      .map((t: any) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));

    const setup: any = {
      model: `models/${session._geminiModel || "gemini-3.1-flash-live-preview"}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: session.voice || "Kore",
            },
          },
        },
      },
    };

    // System instruction
    if (session.instructions) {
      setup.systemInstruction = {
        parts: [{ text: session.instructions }],
      };
    }

    // Function tools
    if (tools.length > 0) {
      setup.tools = [{
        functionDeclarations: tools,
      }];
    }

    // Input config (VAD, turnCoverage, transcription)
    setup.realtimeInputConfig = {
      automaticActivityDetection: {
        disabled: false,
      },
      activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
    };

    // Input/output transcription
    setup.outputAudioTranscription = {};
    setup.inputAudioTranscription = {};

    // Context window compression (extend session duration)
    setup.contextWindowCompression = {
      slidingWindow: {},
      triggerTokens: 80000,
    };

    // Session resumption (always request handles for Phase 2)
    setup.sessionResumption = { transparent: true };

    // Vision config: set if _visionEnabled flag is present
    if (session._visionEnabled) {
      setup.realtimeInputConfig.turnCoverage = "TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO";
    }

    return JSON.stringify({ setup });
  }

  private _buildAudioInput(data: any): string {
    const audioBase64 = data.audio || "";
    const resampled = resampleAudio24kTo16k(audioBase64);

    return JSON.stringify({
      realtimeInput: {
        media: {
          mimeType: "audio/pcm;rate=16000",
          data: resampled,
        },
      },
    });
  }

  private _buildConversationItem(data: any): string {
    const item = data.item || {};

    // Tool result → toolResponse envelope
    if (item.type === "function_call_output") {
      return JSON.stringify({
        toolResponse: {
          functionResponses: [{
            id: item.call_id,
            response: { result: item.output },
          }],
        },
      });
    }

    // Text message or context injection → clientContent
    const role = item.role === "assistant" ? "model" : "user";
    const text = item.content?.[0]?.text || "";
    const isContext = item.role === "system" || text.startsWith("[CONTEXT]") || text.startsWith("[SCREEN]");

    return JSON.stringify({
      clientContent: {
        turns: [{
          role,
          parts: [{ text }],
        }],
        // turnComplete: false for context injection (don't trigger response)
        // turnComplete: true for user messages (trigger response)
        turnComplete: !isContext,
      },
    });
  }

  // ── Private: Inbound message parsers ──────────────────────────────

  private _parseServerContent(content: any): NormalizedEvent[] {
    const events: NormalizedEvent[] = [];

    // Model turn with audio/text parts
    if (content.modelTurn?.parts) {
      for (const part of content.modelTurn.parts) {
        if (part.inlineData) {
          // Audio chunk
          events.push({
            type: "response.audio.delta",
            delta: part.inlineData.data || "",
          });
        }
        if (part.text) {
          // Text/transcript chunk
          events.push({
            type: "response.audio_transcript.delta",
            delta: part.text,
          });
        }
      }
    }

    // Turn complete
    if (content.turnComplete) {
      events.push({ type: "response.audio.done" });
      events.push({
        type: "response.done",
        response: { status: "completed" },
      });
    }

    // Interrupted by user
    if (content.interrupted) {
      events.push({
        type: "input_audio_buffer.speech_started",
      });
    }

    return events;
  }

  private _parseToolCall(toolCall: any): NormalizedEvent[] {
    const calls = toolCall.functionCalls || [];
    return calls.map((fc: any) => ({
      type: "response.function_call_arguments.done",
      call_id: fc.id,
      name: fc.name,
      arguments: JSON.stringify(fc.args || {}),
    }));
  }
}
