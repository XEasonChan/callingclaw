// config_server.ts — POST /api/voice/respond (adversarial-review finding #4)
//
// Regression coverage for: the endpoint used to call
// `services.realtime.sendEvent("response.create", {})` directly — a RAW,
// UNGATED passthrough to the Realtime client that completely bypassed the
// VoiceResponseScheduler (the P1-invariant SOLE authority for triggering
// response.create). Firing it while a response is already active/speaking
// is exactly the collision class P1.1 unified away (truncation / "did the
// action, said nothing").
//
// The fix routes the handler through `VoiceModule.requestDeliberateResponse()`,
// which delegates to the scheduler: fires now when idle, defers to the next
// idle transition when busy — never a second concurrent response.create.
//
// This test boots the REAL HTTP server (startConfigServer) with a REAL
// VoiceModule (so the actual scheduler gating runs, not a stub), swapping in
// a fake Realtime client (same pattern as
// test/modules/voice-deliberate-response.test.ts) to observe what actually
// gets sent over the wire.

import { test, expect } from "bun:test";

process.env.PORT = "0"; // ephemeral port — never collide with a real dev server
process.env.BIND_HOST = "127.0.0.1";

const { startConfigServer } = await import("../src/config_server");
const { VoiceModule } = await import("../src/modules/voice");

function makeFakeClient() {
  const handlers = new Map<string, Function[]>();
  const fake: any = {
    connected: true,
    providerName: "openai",
    capabilities: {},
    connectionGeneration: 0,
    sent: [] as Array<{ type: string; data: any }>,
    speaking: false,
    on(type: string, h: Function) {
      const l = handlers.get(type) || [];
      l.push(h);
      handlers.set(type, l);
    },
    emit(type: string, ev: any = {}) {
      for (const h of handlers.get(type) || []) h(ev);
    },
    sendEvent(type: string, data: any = {}) {
      fake.sent.push({ type, data });
      return true;
    },
    setSpeaking(s: boolean) { fake.speaking = s; },
    flushPendingResponse() {},
    injectContext(_t: string, id?: string) { return id || "item"; },
    removeContext() { return true; },
    addTool() {},
    clearContextQueue() {},
    updateInstructions() { return true; },
    updateTranscriptContext() {},
    disconnect() { fake.connected = false; },
  };
  return fake;
}

function makeSharedContextStub() {
  const listeners = new Map<string, Function[]>();
  return {
    addTranscript() {},
    getRecentTranscript: () => [],
    // startConfigServer eagerly registers `services.context.on("transcript", ...)`
    // at module setup — must exist even though this test never fires it.
    on(event: string, handler: Function) {
      const l = listeners.get(event) || [];
      l.push(handler);
      listeners.set(event, l);
    },
  };
}

async function withServer(fn: (opts: { server: any; fake: ReturnType<typeof makeFakeClient> }) => Promise<void>) {
  const contextStub = makeSharedContextStub();
  const voice = new VoiceModule({ context: contextStub as any });
  const fake = makeFakeClient();
  (voice as any).client = fake;
  (voice as any).setupEventHandlers(); // re-attach handlers to the fake client

  // Minimal Services bag — startConfigServer only touches `realtime` and
  // `context` eagerly (onAudioOutput/onSpeechStarted/context.on("transcript")).
  // Every other field is unused unless a request/WS message routes to it, and
  // this test only ever hits POST /api/voice/respond.
  const services: any = {
    realtime: voice,
    context: contextStub,
  };

  const server = startConfigServer(services);
  try {
    await fn({ server, fake });
  } finally {
    server.stop(true);
  }
}

test("POST /api/voice/respond — idle: fires exactly one gated response.create via the scheduler", async () => {
  await withServer(async ({ server, fake }) => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/voice/respond`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });

    const creates = fake.sent.filter((e: any) => e.type === "response.create");
    expect(creates.length).toBe(1);
  });
});

test("POST /api/voice/respond — busy (response already active): does NOT fire a colliding response.create", async () => {
  await withServer(async ({ server, fake }) => {
    // Simulate an in-flight response the way the real Realtime API would:
    // this flips the VoiceResponseScheduler to `_active = true` via the
    // module's own `client.on("response.created", ...)` handler.
    fake.emit("response.created", {});

    const res = await fetch(`http://127.0.0.1:${server.port}/api/voice/respond`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Honest disposition: deferred still counts as "issued" (will fire on the
    // next idle transition), so `ok` stays true — but critically...
    expect(body).toEqual({ ok: true });

    // ...NO second response.create was sent while busy. A raw
    // sendEvent("response.create", {}) (the pre-fix bug) would have fired
    // immediately here regardless of the active response, colliding with it.
    const creates = fake.sent.filter((e: any) => e.type === "response.create");
    expect(creates.length).toBe(0);
  });
});

test("POST /api/voice/respond — no live session: reports ok:false instead of blindly sending", async () => {
  await withServer(async ({ server, fake }) => {
    fake.connected = false;

    const res = await fetch(`http://127.0.0.1:${server.port}/api/voice/respond`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: false });
    expect(fake.sent.length).toBe(0);
  });
});
