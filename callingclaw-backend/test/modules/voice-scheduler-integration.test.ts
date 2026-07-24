// VoiceModule ↔ VoiceResponseScheduler integration (P1 STEP 1)
//
// End-to-end through the real VoiceModule event handlers (with a fake client):
//   - barge-in STILL cancels (response.cancel on speech_started while speaking)
//     — the happy path we must preserve while collapsing the response gate.
//   - tool completions now route their response.create through the SINGLE
//     scheduler authority (submitToolResultBackground + gated _requestResponse),
//     not RealtimeClient's bundled submitToolResult — so there is one gate and
//     one pending slot. A fast-tool completion during an active response defers
//     and fires on response.done.
//   - sendText() routes its response through the scheduler too (creates the user
//     item directly, then a gated response) rather than client.sendText()'s
//     bundled response.create.
//
// The VoiceModule builds its own RealtimeClient; we swap in a fake and re-run
// setupEventHandlers() so handlers (and the scheduler's send/isConnected
// closures, which read this.client lazily) bind to the fake.

import { test, expect, describe } from "bun:test";

const { VoiceModule } = await import("../../src/modules/voice");

function makeFakeClient() {
  const handlers = new Map<string, Function[]>();
  const fake: any = {
    connected: true,
    providerName: "openai",
    capabilities: {},
    sent: [] as Array<{ type: string; data: any }>,
    calls: [] as any[][],
    on(type: string, h: Function) { const l = handlers.get(type) || []; l.push(h); handlers.set(type, l); },
    emit(type: string, ev: any = {}) { for (const h of handlers.get(type) || []) h(ev); },
    sendEvent(type: string, data: any = {}) { fake.sent.push({ type, data }); return true; },
    setSpeaking() {},
    injectContext(_t: string, id?: string) { fake.calls.push(["injectContext", _t]); return id || "item"; },
    removeContext() { return true; },
    // Bundled variant — must NOT be used by VoiceModule anymore (single authority).
    submitToolResult(cid: string, r: string) { fake.calls.push(["submitToolResult", cid, r]); return fake.sendEvent("response.create", {}); },
    // Background variant — the reroute uses this + a gated _requestResponse.
    submitToolResultBackground(cid: string, r: string) { fake.calls.push(["submitToolResultBackground", cid, r]); return true; },
    addTool() {},
    clearContextQueue() {},
    updateInstructions() { return true; },
    updateTranscriptContext() {},
    disconnect() { fake.connected = false; },
  };
  return fake;
}

function makeVoice(onToolCall?: (name: string, args: any, callId: string) => Promise<string>) {
  const voice = new VoiceModule({
    context: { addTranscript() {}, getRecentTranscript: () => [] } as any,
    onToolCall,
  });
  const fake = makeFakeClient();
  (voice as any).client = fake;
  (voice as any).setupEventHandlers();
  return { voice, fake };
}

const creates = (fake: any) => fake.sent.filter((e: any) => e.type === "response.create");

// ═══════════════════════════════════════════════════════════════════
// Barge-in still cancels
// ═══════════════════════════════════════════════════════════════════

describe("barge-in (preserved)", () => {
  test("speech_started while speaking still commits + cancels the active response", () => {
    const { voice, fake } = makeVoice();
    (voice as any)._audioState = "speaking";
    (voice as any)._lastAudioOutputTs = 0;        // ancient → not treated as echo
    (voice as any)._currentResponseAudioSamples = 0; // skip heard-truncation branch
    fake.sent.length = 0;

    fake.emit("input_audio_buffer.speech_started", {});

    const types = fake.sent.map((e: any) => e.type);
    expect(types).toContain("input_audio_buffer.commit");
    expect(types).toContain("response.cancel");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tool completions route through the single scheduler authority
// ═══════════════════════════════════════════════════════════════════

describe("tool completion → single-owned gate", () => {
  test("fast-tool completion during an active response defers, then fires on response.done", async () => {
    const { fake } = makeVoice(async () => "TOOL_OK");

    fake.emit("response.created", {}); // a response is now active (scheduler.active=true)
    fake.sent.length = 0;

    // Fast tool (not in SLOW_TOOLS) completes.
    fake.emit("response.function_call_arguments.done", { call_id: "c1", name: "some_fast_tool", arguments: "{}" });
    await Bun.sleep(10); // handler awaits onToolCall

    // Output submitted via the BACKGROUND variant; the bundled submitToolResult
    // (which would fire response.create outside the scheduler) is NOT used.
    expect(fake.calls.some((c: any[]) => c[0] === "submitToolResultBackground")).toBe(true);
    expect(fake.calls.some((c: any[]) => c[0] === "submitToolResult")).toBe(false);
    // Deferred (busy) — not sent yet.
    expect(creates(fake).length).toBe(0);

    // Response completes → the deferred trigger flushes exactly once.
    fake.emit("response.done", {});
    await Bun.sleep(90);
    expect(creates(fake).length).toBe(1);
  });

  test("malformed tool args → background error output + a single gated retry response (idle → fires now)", async () => {
    const { fake } = makeVoice(async () => "x");
    fake.sent.length = 0;
    fake.calls.length = 0;

    fake.emit("response.function_call_arguments.done", { call_id: "c1", name: "open_file", arguments: "NOT JSON" });
    await Bun.sleep(5);

    expect(fake.calls.some((c: any[]) => c[0] === "submitToolResultBackground")).toBe(true);
    expect(fake.calls.some((c: any[]) => c[0] === "submitToolResult")).toBe(false);
    expect(creates(fake).length).toBe(1); // idle → gated create fired now
  });
});

// ═══════════════════════════════════════════════════════════════════
// sendText routes through the scheduler
// ═══════════════════════════════════════════════════════════════════

describe("sendText → single-owned gate", () => {
  test("creates the user item directly + one gated response (idle → fires once)", () => {
    const { voice, fake } = makeVoice();
    fake.sent.length = 0;

    voice.sendText("hello");

    const itemCreates = fake.sent.filter((e: any) => e.type === "conversation.item.create");
    expect(itemCreates.length).toBe(1);
    expect(itemCreates[0].data.item.content[0].text).toBe("hello");
    expect(creates(fake).length).toBe(1);
  });
});
