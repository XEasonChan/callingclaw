// CallingClaw 2.0 — Unit Tests for Gemini Protocol Adapter
// Tests all outbound/inbound transforms + audio resampler

import { test, expect, describe } from "bun:test";
import { GeminiProtocolAdapter, resampleAudio24kTo16k } from "./gemini-adapter";

const adapter = new GeminiProtocolAdapter();

// ── Helper: create base64 PCM16 from Int16Array ──────────────────
function int16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer);
  const CHUNK = 0x2000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
  }
  return btoa(parts.join(""));
}

// ══════════════════════════════════════════════════════════════════
// Outbound Transforms (CallingClaw → Gemini)
// ══════════════════════════════════════════════════════════════════

describe("transformOutbound", () => {
  test("session.update → setup envelope with model, voice, instructions, tools", () => {
    const result = adapter.transformOutbound("session.update", {
      session: {
        instructions: "You are a helpful assistant",
        voice: "Kore",
        _geminiModel: "gemini-3.1-flash-live-preview",
        tools: [
          { type: "function", name: "get_weather", description: "Get weather", parameters: { type: "object" } },
        ],
      },
    });

    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.setup).toBeDefined();
    expect(parsed.setup.model).toBe("models/gemini-3.1-flash-live-preview");
    expect(parsed.setup.systemInstruction.parts[0].text).toBe("You are a helpful assistant");
    expect(parsed.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Kore");
    expect(parsed.setup.tools[0].functionDeclarations).toHaveLength(1);
    expect(parsed.setup.tools[0].functionDeclarations[0].name).toBe("get_weather");
    expect(parsed.setup.contextWindowCompression).toBeDefined();
    expect(parsed.setup.sessionResumption).toBeDefined();
  });

  test("input_audio_buffer.append → realtimeInput.media with 16kHz", () => {
    // Create a small 24kHz audio sample
    const samples24k = new Int16Array([100, 200, 300, 400, 500, 600]);
    const b64 = int16ToBase64(samples24k);

    const result = adapter.transformOutbound("input_audio_buffer.append", { audio: b64 });
    expect(result).not.toBeNull();

    const parsed = JSON.parse(result!);
    expect(parsed.realtimeInput).toBeDefined();
    expect(parsed.realtimeInput.media.mimeType).toBe("audio/pcm;rate=16000");
    expect(parsed.realtimeInput.media.data).toBeTruthy(); // resampled data
  });

  test("response.create → clientContent.turnComplete", () => {
    const result = adapter.transformOutbound("response.create", {});
    expect(result).not.toBeNull();

    const parsed = JSON.parse(result!);
    expect(parsed.clientContent.turnComplete).toBe(true);
  });

  test("conversation.item.create (user message) → clientContent with turnComplete true", () => {
    const result = adapter.transformOutbound("conversation.item.create", {
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Hello world" }],
      },
    });

    const parsed = JSON.parse(result!);
    expect(parsed.clientContent.turns[0].role).toBe("user");
    expect(parsed.clientContent.turns[0].parts[0].text).toBe("Hello world");
    expect(parsed.clientContent.turnComplete).toBe(true);
  });

  test("conversation.item.create (system context) → clientContent with turnComplete false", () => {
    const result = adapter.transformOutbound("conversation.item.create", {
      item: {
        type: "message",
        role: "system",
        content: [{ type: "input_text", text: "[CONTEXT] Meeting is about Q3 revenue" }],
      },
    });

    const parsed = JSON.parse(result!);
    expect(parsed.clientContent.turns[0].role).toBe("user"); // Gemini has no system role
    expect(parsed.clientContent.turnComplete).toBe(false); // Don't trigger response
  });

  test("conversation.item.create (tool result) → toolResponse envelope", () => {
    const result = adapter.transformOutbound("conversation.item.create", {
      item: {
        type: "function_call_output",
        call_id: "call_123",
        output: '{"temp": 72}',
      },
    });

    const parsed = JSON.parse(result!);
    expect(parsed.toolResponse).toBeDefined();
    expect(parsed.toolResponse.functionResponses[0].id).toBe("call_123");
    expect(parsed.toolResponse.functionResponses[0].response.result).toBe('{"temp": 72}');
  });

  test("conversation.item.delete → null (no-op)", () => {
    const result = adapter.transformOutbound("conversation.item.delete", { item_id: "ctx_123" });
    expect(result).toBeNull();
  });

  test("unknown event → null", () => {
    const result = adapter.transformOutbound("some.unknown.event", {});
    expect(result).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
// Inbound Transforms (Gemini → CallingClaw)
// ══════════════════════════════════════════════════════════════════

describe("transformInbound", () => {
  test("setupComplete → session.created + session.updated", () => {
    const events = adapter.transformInbound(JSON.stringify({ setupComplete: {} }));
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("session.created");
    expect(events[1].type).toBe("session.updated");
  });

  test("serverContent with audio inlineData → response.audio.delta", () => {
    const events = adapter.transformInbound(JSON.stringify({
      serverContent: {
        modelTurn: {
          parts: [{
            inlineData: { data: "base64audiodata", mimeType: "audio/pcm;rate=24000" },
          }],
        },
      },
    }));

    expect(events.length).toBeGreaterThanOrEqual(1);
    const audioDelta = events.find(e => e.type === "response.audio.delta");
    expect(audioDelta).toBeDefined();
    expect(audioDelta!.delta).toBe("base64audiodata");
  });

  test("serverContent with text → response.audio_transcript.delta", () => {
    const events = adapter.transformInbound(JSON.stringify({
      serverContent: {
        modelTurn: {
          parts: [{ text: "Hello, I can help with that." }],
        },
      },
    }));

    const textDelta = events.find(e => e.type === "response.audio_transcript.delta");
    expect(textDelta).toBeDefined();
    expect(textDelta!.delta).toBe("Hello, I can help with that.");
  });

  test("serverContent with turnComplete → response.audio.done + response.done", () => {
    const events = adapter.transformInbound(JSON.stringify({
      serverContent: { turnComplete: true },
    }));

    expect(events.find(e => e.type === "response.audio.done")).toBeDefined();
    expect(events.find(e => e.type === "response.done")).toBeDefined();
  });

  test("serverContent with interrupted → input_audio_buffer.speech_started", () => {
    const events = adapter.transformInbound(JSON.stringify({
      serverContent: { interrupted: true },
    }));

    expect(events.find(e => e.type === "input_audio_buffer.speech_started")).toBeDefined();
  });

  test("inputTranscription → transcription completed", () => {
    const events = adapter.transformInbound(JSON.stringify({
      inputTranscription: { text: "What is the weather?" },
    }));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("conversation.item.input_audio_transcription.completed");
    expect(events[0].transcript).toBe("What is the weather?");
  });

  test("outputTranscription → response.audio_transcript.done", () => {
    const events = adapter.transformInbound(JSON.stringify({
      outputTranscription: { text: "The weather is sunny." },
    }));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("response.audio_transcript.done");
    expect(events[0].transcript).toBe("The weather is sunny.");
  });

  test("toolCall → response.function_call_arguments.done", () => {
    const events = adapter.transformInbound(JSON.stringify({
      toolCall: {
        functionCalls: [{
          id: "call_456",
          name: "get_weather",
          args: { city: "Tokyo" },
        }],
      },
    }));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("response.function_call_arguments.done");
    expect(events[0].call_id).toBe("call_456");
    expect(events[0].name).toBe("get_weather");
    expect(JSON.parse(events[0].arguments)).toEqual({ city: "Tokyo" });
  });

  test("goAway → gemini.go_away with timeLeft", () => {
    const events = adapter.transformInbound(JSON.stringify({
      goAway: { timeLeft: "30s" },
    }));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("gemini.go_away");
    expect(events[0].timeLeft).toBe("30s");
  });

  test("sessionResumptionUpdate → gemini.session_resumption with handle", () => {
    const events = adapter.transformInbound(JSON.stringify({
      sessionResumptionUpdate: { newHandle: "resume_token_abc123" },
    }));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("gemini.session_resumption");
    expect(events[0].handle).toBe("resume_token_abc123");
  });

  test("usageMetadata → response.done with token counts", () => {
    const events = adapter.transformInbound(JSON.stringify({
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        totalTokenCount: 150,
      },
    }));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("response.done");
    expect(events[0].response.usage.input_tokens).toBe(100);
    expect(events[0].response.usage.output_tokens).toBe(50);
    expect(events[0].response.usage.total_tokens).toBe(150);
  });

  test("unknown envelope → empty array", () => {
    const events = adapter.transformInbound(JSON.stringify({ unknownKey: {} }));
    expect(events).toHaveLength(0);
  });

  test("malformed JSON → empty array (no crash)", () => {
    const events = adapter.transformInbound("not valid json {{{");
    expect(events).toHaveLength(0);
  });

  test("toolCallCancellation → function_call_cancelled events", () => {
    const events = adapter.transformInbound(JSON.stringify({
      toolCallCancellation: { ids: ["call_1", "call_2"] },
    }));

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("response.function_call_cancelled");
    expect(events[0].call_id).toBe("call_1");
  });
});

// ══════════════════════════════════════════════════════════════════
// Audio Resampler (24kHz → 16kHz)
// ══════════════════════════════════════════════════════════════════

describe("resampleAudio24kTo16k", () => {
  test("empty input → empty output", () => {
    expect(resampleAudio24kTo16k("")).toBe("");
  });

  test("correct sample count (ratio 1.5)", () => {
    // 6 samples at 24kHz → 4 samples at 16kHz
    const input = new Int16Array([100, 200, 300, 400, 500, 600]);
    const b64 = int16ToBase64(input);

    const result = resampleAudio24kTo16k(b64);
    expect(result).toBeTruthy();

    // Decode result
    const binary = atob(result);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const output = new Int16Array(bytes.buffer);

    expect(output.length).toBe(4); // 6 / 1.5 = 4
  });

  test("larger buffer preserves signal character", () => {
    // Generate a simple ramp signal
    const len = 240; // 10ms at 24kHz
    const input = new Int16Array(len);
    for (let i = 0; i < len; i++) input[i] = i * 100;

    const result = resampleAudio24kTo16k(int16ToBase64(input));
    const binary = atob(result);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const output = new Int16Array(bytes.buffer);

    // Output should be 160 samples (240 / 1.5)
    expect(output.length).toBe(160);
    // First sample should match
    expect(output[0]).toBe(0);
    // Signal should be monotonically increasing (ramp preserved)
    for (let i = 1; i < output.length; i++) {
      expect(output[i]).toBeGreaterThan(output[i - 1]);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
// Video Frame Transform
// ══════════════════════════════════════════════════════════════════

describe("buildVideoFrame", () => {
  test("JPEG base64 → realtimeInput.video envelope", () => {
    const result = adapter.buildVideoFrame("base64jpegdata");
    const parsed = JSON.parse(result);
    expect(parsed.realtimeInput.video.data).toBe("base64jpegdata");
    expect(parsed.realtimeInput.video.mimeType).toBe("image/jpeg");
  });
});
