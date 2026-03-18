// CallingClaw 2.0 — Realtime Provider Tests
// Tests: provider config objects, event name mapping, reconnect logic
//
// These are pure unit tests — no WebSocket connections.
// Manual QA checklist for actual Grok voice quality is in the test plan.

import { test, expect, describe } from "bun:test";
import {
  OPENAI_PROVIDER,
  GROK_PROVIDER,
  getProvider,
  type RealtimeTool,
} from "../src/ai_gateway/realtime_client";

// ── Test tools for session building ─────────────────────────────

const SAMPLE_TOOLS: RealtimeTool[] = [
  {
    name: "check_calendar",
    description: "Check upcoming calendar events",
    parameters: {
      type: "object",
      properties: { days: { type: "number", description: "Days ahead to check" } },
      required: [],
    },
  },
  {
    name: "recall_context",
    description: "Search memory for information",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        urgency: { type: "string", enum: ["quick", "thorough"] },
      },
      required: ["query"],
    },
  },
];

const SESSION_OPTS = {
  instructions: "You are CallingClaw, a test assistant.",
  tools: SAMPLE_TOOLS,
  voice: "sage",
  vad: { threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 },
};

// ══════════════════════════════════════════════════════════════════
// 1. Provider Config — Session Format
// ══════════════════════════════════════════════════════════════════

describe("Provider Config: Session Format", () => {
  test("OpenAI session has flat audio format fields", () => {
    const session = OPENAI_PROVIDER.buildSession(SESSION_OPTS);
    expect(session.session.input_audio_format).toBe("pcm16");
    expect(session.session.output_audio_format).toBe("pcm16");
    expect(session.session.input_audio_transcription).toEqual({ model: "whisper-1" });
    // Should NOT have nested audio object
    expect(session.session.audio).toBeUndefined();
  });

  test("Grok session has nested audio format object", () => {
    const session = GROK_PROVIDER.buildSession({
      ...SESSION_OPTS,
      voice: "Ara",
    });
    expect(session.session.audio).toEqual({
      input: { format: { type: "audio/pcm", rate: 24000 } },
      output: { format: { type: "audio/pcm", rate: 24000 } },
    });
    // Should NOT have flat audio format fields
    expect(session.session.input_audio_format).toBeUndefined();
    expect(session.session.output_audio_format).toBeUndefined();
    expect(session.session.input_audio_transcription).toBeUndefined();
  });

  test("Both providers serialize tools identically", () => {
    const openaiSession = OPENAI_PROVIDER.buildSession(SESSION_OPTS);
    const grokSession = GROK_PROVIDER.buildSession(SESSION_OPTS);

    // Tool format is the same: { type: "function", name, description, parameters }
    expect(openaiSession.session.tools).toEqual(grokSession.session.tools);
    expect(openaiSession.session.tools).toHaveLength(2);
    expect(openaiSession.session.tools[0].type).toBe("function");
    expect(openaiSession.session.tools[0].name).toBe("check_calendar");
  });

  test("Both providers include instructions and VAD config", () => {
    const openaiSession = OPENAI_PROVIDER.buildSession(SESSION_OPTS);
    const grokSession = GROK_PROVIDER.buildSession(SESSION_OPTS);

    for (const session of [openaiSession.session, grokSession.session]) {
      expect(session.instructions).toBe("You are CallingClaw, a test assistant.");
      expect(session.turn_detection.type).toBe("server_vad");
      expect(session.turn_detection.threshold).toBe(0.5);
      expect(session.turn_detection.prefix_padding_ms).toBe(300);
      expect(session.turn_detection.silence_duration_ms).toBe(500);
    }
  });

  test("OpenAI has modalities field, Grok does not", () => {
    const openaiSession = OPENAI_PROVIDER.buildSession(SESSION_OPTS);
    const grokSession = GROK_PROVIDER.buildSession(SESSION_OPTS);

    expect(openaiSession.session.modalities).toEqual(["text", "audio"]);
    expect(grokSession.session.modalities).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════
// 2. Event Name Mapping
// ══════════════════════════════════════════════════════════════════

describe("Event Name Mapping", () => {
  test("OpenAI has no event mappings (canonical names)", () => {
    expect(Object.keys(OPENAI_PROVIDER.eventMap)).toHaveLength(0);
  });

  test("Grok maps 4 audio output events to OpenAI-compatible names", () => {
    const map = GROK_PROVIDER.eventMap;
    expect(map["response.output_audio.delta"]).toBe("response.audio.delta");
    expect(map["response.output_audio.done"]).toBe("response.audio.done");
    expect(map["response.output_audio_transcript.delta"]).toBe("response.audio_transcript.delta");
    expect(map["response.output_audio_transcript.done"]).toBe("response.audio_transcript.done");
  });

  test("Grok event map does NOT remap shared events", () => {
    const map = GROK_PROVIDER.eventMap;
    // These events are identical on both providers — should NOT be in the map
    expect(map["conversation.item.input_audio_transcription.completed"]).toBeUndefined();
    expect(map["response.function_call_arguments.done"]).toBeUndefined();
    expect(map["session.updated"]).toBeUndefined();
    expect(map["error"]).toBeUndefined();
  });

  test("Unmapped events pass through unchanged", () => {
    const map = GROK_PROVIDER.eventMap;
    const unmappedEvent = "conversation.item.input_audio_transcription.completed";
    // Simulate the normalization logic: map[type] || type
    const normalized = map[unmappedEvent] || unmappedEvent;
    expect(normalized).toBe(unmappedEvent);
  });
});

// ══════════════════════════════════════════════════════════════════
// 3. Provider Selection
// ══════════════════════════════════════════════════════════════════

describe("Provider Selection", () => {
  test("getProvider returns correct provider by name", () => {
    expect(getProvider("openai").name).toBe("openai");
    expect(getProvider("grok").name).toBe("grok");
  });

  test("getProvider defaults to OpenAI for unknown names", () => {
    expect(getProvider("unknown" as any).name).toBe("openai");
  });

  test("OpenAI provider has correct URL pattern", () => {
    expect(OPENAI_PROVIDER.url).toContain("api.openai.com/v1/realtime");
    expect(OPENAI_PROVIDER.url).toContain("model=");
  });

  test("Grok provider has correct URL", () => {
    expect(GROK_PROVIDER.url).toBe("wss://api.x.ai/v1/realtime");
  });

  test("OpenAI headers include OpenAI-Beta", () => {
    expect(OPENAI_PROVIDER.headers["OpenAI-Beta"]).toBe("realtime=v1");
  });

  test("Grok headers do NOT include OpenAI-Beta", () => {
    expect(GROK_PROVIDER.headers["OpenAI-Beta"]).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════
// 4. Provider Config — Auth Headers
// ══════════════════════════════════════════════════════════════════

describe("Provider Auth Headers", () => {
  test("OpenAI uses Authorization Bearer header", () => {
    expect(OPENAI_PROVIDER.headers.Authorization).toMatch(/^Bearer /);
  });

  test("Grok uses Authorization Bearer header", () => {
    expect(GROK_PROVIDER.headers.Authorization).toMatch(/^Bearer /);
  });
});

// ══════════════════════════════════════════════════════════════════
// 5. Reconnect Context Building
// ══════════════════════════════════════════════════════════════════

describe("Reconnect Context", () => {
  test("RealtimeClient accepts transcript context updates", () => {
    // This tests the interface — actual reconnect needs a WebSocket
    const { RealtimeClient } = require("../src/ai_gateway/realtime_client");
    const client = new RealtimeClient();

    // Should not throw
    client.updateTranscriptContext([
      { role: "user", text: "Hello" },
      { role: "assistant", text: "Hi there!" },
    ]);
  });

  test("RealtimeClient accepts reconnect failure callback", () => {
    const { RealtimeClient } = require("../src/ai_gateway/realtime_client");
    const client = new RealtimeClient();

    let called = false;
    client.onReconnectFailed(() => { called = true; });
    // Callback should be registered (we can't trigger it without a WebSocket)
    expect(called).toBe(false);
  });
});
