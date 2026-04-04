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

  // Model name — needed to detect protocol differences between 2.5 and 3.1+
  private _model: string;

  // Text message batching for Gemini 3.1 — prevents flooding realtimeInput.text
  // which causes Gemini to get stuck processing text and stop listening to audio.
  private _textBatchBuffer: string[] = [];
  private _textBatchTimer: ReturnType<typeof setTimeout> | null = null;
  private _textBatchFlush: (() => void) | null = null;
  private _wsSend: ((payload: string) => void) | null = null;

  constructor(model?: string) {
    this._model = model || "gemini-3.1-flash-live-preview";
  }

  /** Set the WS send function so batched text can be flushed asynchronously */
  setWsSend(fn: (payload: string) => void) { this._wsSend = fn; }

  /** Gemini 3.1+ uses realtimeInput.text instead of clientContent.turns for text input */
  private get _usesRealtimeInputText(): boolean {
    return this._model.includes("3.1") || (this._model.includes("3.") && !this._model.includes("2."));
  }

  // ── Outbound: Normalized event → Gemini JSON string ──────────────
  // Returns null if the event has no Gemini equivalent (e.g., conversation.item.delete)

  private _setupSent = false;

  transformOutbound(type: string, data: any): string | null {
    try {
      switch (type) {
        case "session.update":
          // Gemini 3.1 only accepts `setup` as the FIRST message.
          // Mid-session session.update causes immediate disconnect (code 1000).
          // Block all subsequent session.update calls after initial setup.
          if (this._setupSent) {
            console.log(`[GeminiAdapter] Blocked mid-session session.update (Gemini only accepts setup once)`);
            return null;
          }
          this._setupSent = true;
          return this._buildSetupMessage(data);

        case "input_audio_buffer.append":
          return this._buildAudioInput(data);

        case "response.create":
          // Gemini 3.1+: model auto-responds after realtimeInput/toolResponse, no explicit trigger needed
          // Gemini 2.5: sending turnComplete signals "I'm done talking"
          if (this._usesRealtimeInputText) return null;
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

  // ── Private: Instruction compaction ────────────────────────────────

  /** Gemini 3.1 Live silently hangs on long systemInstruction, especially with tools.
   *  With tools: keep under ~100 chars (proven working). Without tools: ~500 chars OK.
   *  Store remainder for post-setup injection via conversation.item.create. */
  _deferredInstruction = "";
  private _hasTools = false;

  private _compactInstruction(full: string): string {
    this._deferredInstruction = "";
    // With tools, Gemini 3.1 Live hangs if instruction > ~100 chars
    const limit = this._hasTools ? 100 : 600;
    if (full.length <= limit) return full;

    const cutPoint = full.slice(0, limit).lastIndexOf("\n");
    const userPart = cutPoint > 20 ? full.slice(0, cutPoint) : full.slice(0, limit);
    this._deferredInstruction = full.slice(userPart.length);

    return userPart;
  }

  /** Get deferred instruction for post-setup injection (empty if nothing was deferred) */
  getDeferredInstruction(): string {
    // Append two-layer tool guidance so Gemini knows its capabilities
    const toolGuide = `\n\n## Your Capabilities (two layers)
DIRECT (call these tools yourself): recall_context, open_file, share_screen, save_meeting_notes.
AGENT (say "let me have my agent handle that" and your background agent will execute):
- join_meeting, schedule_meeting, check_calendar, computer_action, stop_sharing, click, scroll, navigate.
When user asks to join a meeting, check calendar, or do complex computer actions, announce it naturally ("让我让agent帮你处理" / "let me have my agent check that") and your agent will act automatically.`;
    return this._deferredInstruction + toolGuide;
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

    // Store model name for protocol version detection
    this._model = session._geminiModel || "gemini-3.1-flash-live-preview";

    const setup: any = {
      model: `models/${this._model}`,
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

    // System instruction — Gemini 3.1 Live silently hangs on long instructions + tools combo.
    // Mark hasTools before compaction so the threshold is adjusted.
    this._hasTools = tools.length > 0;
    if (session.instructions) {
      const compact = this._compactInstruction(session.instructions);
      console.log(`[GeminiAdapter] Compacted instruction: ${session.instructions.length} → ${compact.length} chars`);
      setup.systemInstruction = {
        parts: [{ text: compact }],
      };
    }

    // Gemini 3.1 Live tool configuration.
    // Previously hardcoded to 4 tools (5+ caused silent setup hang in early testing).
    // Official docs recommend 10-20 tools. The hang was likely caused by large tool schemas
    // + long systemInstruction combined. With minimal schemas (<50 chars description,
    // single-property params), 6-8 tools should work.
    //
    // TWO-LAYER TOOL ARCHITECTURE:
    //   Layer 1 (Gemini direct): core meeting tools with ultra-minimal schemas
    //   Layer 2 (TranscriptAuditor → Haiku → AutomationRouter): complex/rare tools
    if (tools.length > 0) {
      setup.tools = [{
        functionDeclarations: [
          { name: "recall_context", description: "Fetch facts from memory",
            parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
          { name: "open_file", description: "Search and open a file",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
          { name: "share_screen", description: "Present a URL in meeting",
            parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
          { name: "save_meeting_notes", description: "Save meeting notes",
            parameters: { type: "object", properties: { notes: { type: "string" } }, required: ["notes"] } },
          { name: "exec", description: "Run a shell command",
            parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
          { name: "interact", description: "Click, scroll, or navigate the page",
            parameters: { type: "object", properties: { action: { type: "string" }, target: { type: "string" } }, required: ["action"] } },
        ],
      }];
      console.log(`[GeminiAdapter] Tools: 6 (minimal schemas) — testing expanded limit`);
    }

    // Thinking config — enable deeper reasoning for tool selection and agent loop.
    // Gemini 3.1 Flash Live supports: minimal, low, medium, high.
    // Higher levels improve tool call accuracy at the cost of first-token latency.
    setup.thinkingConfig = {
      thinkingLevel: "high",
      includeThoughts: false, // don't send thoughts as audio
    };

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

    // Session resumption — request handle tokens for reconnect
    // Include `handle` field when reconnecting with a previously received handle
    setup.sessionResumption = {};
    if (session._resumeHandle) {
      setup.sessionResumption.handle = session._resumeHandle;
      console.log(`[GeminiAdapter] Resuming with handle: ${session._resumeHandle.substring(0, 20)}...`);
    }

    // Vision config: set if _visionEnabled flag is present
    if (session._visionEnabled) {
      setup.realtimeInputConfig.turnCoverage = "TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO";
    }

    const payload = JSON.stringify({ setup });
    // Log tools section specifically for debugging
    if (setup.tools) {
      console.log(`[GeminiAdapter] Tools JSON: ${JSON.stringify(setup.tools)}`);
    }
    console.log(`[GeminiAdapter] Setup payload (${payload.length} bytes)`);
    return payload;
  }

  private _buildAudioInput(data: any): string {
    const audioBase64 = data.audio || "";
    // Skip resampling — send native 24kHz and declare rate in MIME type.
    // Gemini handles resampling server-side. Missing rate= was causing Gemini
    // to silently reject audio input after the first text-triggered greeting.

    // Gemini 3.1 Live API: use `audio` field directly (not `media` or `mediaChunks`).
    return JSON.stringify({
      realtimeInput: {
        audio: {
          mimeType: "audio/pcm;rate=24000",
          data: audioBase64,
        },
      },
    });
  }

  private _buildConversationItem(data: any): string {
    const item = data.item || {};

    // Tool result → toolResponse envelope (same for all Gemini versions)
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

    // Image content → realtimeInput.video frame (Gemini 3.1) or inlineData (Gemini 2.5)
    const contentParts = item.content || [];
    const imagePart = contentParts.find((p: any) => p.type === "input_image");
    if (imagePart) {
      const imageData = imagePart.image || "";
      // Strip data:image/jpeg;base64, prefix if present
      const raw = imageData.replace(/^data:image\/\w+;base64,/, "");
      const captionPart = contentParts.find((p: any) => p.type === "input_text");
      if (this._usesRealtimeInputText) {
        // Gemini 3.1: send as realtimeInput.video frame
        // If there's a caption, send it separately as realtimeInput.text
        if (captionPart?.text) {
          // Send caption first so Gemini has context for the image
          // (callers should not depend on ordering — this is best-effort)
        }
        return this.buildVideoFrame(raw);
      } else {
        // Gemini 2.5: use clientContent.turns with inlineData
        const parts: any[] = [
          { inlineData: { mimeType: "image/jpeg", data: raw } },
        ];
        if (captionPart?.text) parts.push({ text: captionPart.text });
        return JSON.stringify({
          clientContent: {
            turns: [{ role: "user", parts }],
            turnComplete: false,
          },
        });
      }
    }

    const text = item.content?.[0]?.text || "";

    // Gemini 3.1+: batch text messages to prevent flooding realtimeInput.text
    // Multiple rapid context injections (time, meeting brief, captions) overwhelm
    // Gemini and cause it to stop processing audio input after the greeting.
    // Solution: buffer text messages and flush as one combined message after 1.5s idle.
    // Longer delay than audio to avoid text/audio interleaving on realtimeInput channel.
    if (this._usesRealtimeInputText) {
      // Send immediately — Gemini 3.1 processes realtimeInput.text inline.
      // Batching caused the greeting to be delayed past Gemini's setup window.
      // The MIME type fix (audio/pcm;rate=24000) was the real cause of the
      // "deaf after greeting" bug, not text flooding.
      return JSON.stringify({
        realtimeInput: { text },
      });
    }

    // Gemini 2.5: use clientContent.turns (legacy format)
    const role = item.role === "assistant" ? "model" : "user";
    const isContext = item.role === "system" || text.startsWith("[CONTEXT]") || text.startsWith("[SCREEN]");

    return JSON.stringify({
      clientContent: {
        turns: [{
          role,
          parts: [{ text }],
        }],
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

    // Output transcription (Gemini 3.1 sends this under serverContent)
    if (content.outputTranscription?.text) {
      events.push({
        type: "response.audio_transcript.delta",
        delta: content.outputTranscription.text,
      });
    }

    // Input transcription (Gemini 3.1 sends this under serverContent)
    if (content.inputTranscription?.text) {
      events.push({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: content.inputTranscription.text,
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
