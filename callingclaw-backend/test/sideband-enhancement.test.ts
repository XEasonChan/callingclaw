// CallingClaw 2.0 — Sideband Enhancement Tests
// Tests: injectImage (multi-provider), submitToolResultBackground, SceneController, Gemini image adapter

import { test, expect, describe, beforeEach } from "bun:test";
import { RealtimeClient } from "../src/ai_gateway/realtime_client";
import { GeminiProtocolAdapter } from "../src/ai_gateway/gemini-adapter";
import { SceneController } from "../src/modules/presentation-engine";
import type { SceneSpec } from "../src/modules/presentation-engine";

// ── Mock WebSocket (same pattern as realtime_client_context.test.ts) ──

function createMockClient(providerName?: string): {
  client: RealtimeClient;
  sentEvents: Array<{ type: string; [key: string]: any }>;
  simulateConnected: () => void;
} {
  const client = new RealtimeClient();
  const sentEvents: Array<{ type: string; [key: string]: any }> = [];

  (client as any).sendEvent = (type: string, data: any = {}) => {
    sentEvents.push({ type, ...data });
    return true;
  };

  const simulateConnected = () => {
    (client as any)._connected = true;
    if (providerName) {
      (client as any)._provider = { name: providerName };
    }
  };

  return { client, sentEvents, simulateConnected };
}

// ── Fake base64 JPEG (tiny valid-looking string) ──
const FAKE_JPEG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk";

// ══════════════════════════════════════════════════════════════════
// 1. injectImage — Multi-Provider
// ══════════════════════════════════════════════════════════════════

describe("injectImage", () => {
  test("returns false when not connected", () => {
    const { client } = createMockClient("openai15");
    expect(client.injectImage(FAKE_JPEG)).toBe(false);
  });

  test("returns false with empty base64", () => {
    const { client, simulateConnected } = createMockClient("openai15");
    simulateConnected();
    expect(client.injectImage("")).toBe(false);
  });

  test("openai15: sends conversation.item.create with input_image content", () => {
    const { client, sentEvents, simulateConnected } = createMockClient("openai15");
    simulateConnected();

    const id = client.injectImage(FAKE_JPEG, "Test screenshot");
    expect(id).toBeString();
    expect(id).toStartWith("img_");

    // Should send conversation.item.create
    const createEvent = sentEvents.find(e => e.type === "conversation.item.create");
    expect(createEvent).toBeDefined();

    const item = createEvent!.item;
    expect(item.type).toBe("message");
    expect(item.role).toBe("user");
    expect(item.content).toHaveLength(2); // caption + image
    expect(item.content[0].type).toBe("input_text");
    expect(item.content[0].text).toBe("Test screenshot");
    expect(item.content[1].type).toBe("input_image");
    expect(item.content[1].image).toBe(FAKE_JPEG);
  });

  test("openai15: sends image without caption (single content element)", () => {
    const { client, sentEvents, simulateConnected } = createMockClient("openai15");
    simulateConnected();

    client.injectImage(FAKE_JPEG);

    const createEvent = sentEvents.find(e => e.type === "conversation.item.create");
    const item = createEvent!.item;
    expect(item.content).toHaveLength(1); // image only
    expect(item.content[0].type).toBe("input_image");
  });

  test("grok: falls back to text caption via injectContext", () => {
    const { client, sentEvents, simulateConnected } = createMockClient("grok");
    simulateConnected();

    const id = client.injectImage(FAKE_JPEG, "A screenshot of the settings page");
    expect(id).toBeString();

    // Should send conversation.item.create with input_text (not input_image)
    const createEvent = sentEvents.find(e => e.type === "conversation.item.create");
    expect(createEvent).toBeDefined();
    const content = createEvent!.item.content;
    expect(content[0].type).toBe("input_text");
    expect(content[0].text).toContain("[SCREENSHOT]");
    expect(content[0].text).toContain("settings page");
  });

  test("grok: returns false without caption (no useful fallback)", () => {
    const { client, simulateConnected } = createMockClient("grok");
    simulateConnected();
    expect(client.injectImage(FAKE_JPEG)).toBe(false);
  });

  test("openai (legacy): falls back to text caption", () => {
    const { client, sentEvents, simulateConnected } = createMockClient("openai");
    simulateConnected();

    const id = client.injectImage(FAKE_JPEG, "Legacy provider screenshot");
    expect(id).toBeString();

    const createEvent = sentEvents.find(e => e.type === "conversation.item.create");
    expect(createEvent!.item.content[0].text).toContain("[SCREENSHOT]");
  });

  test("tracks image in context queue for FIFO eviction", () => {
    const { client, simulateConnected } = createMockClient("openai15");
    simulateConnected();

    client.injectImage(FAKE_JPEG, "test");
    const queue = client.getContextQueue();
    expect(queue.length).toBe(1);
    expect(queue[0]!.text).toContain("[IMAGE]");
  });
});

// ══════════════════════════════════════════════════════════════════
// 2. submitToolResultBackground
// ══════════════════════════════════════════════════════════════════

describe("submitToolResultBackground", () => {
  test("sends function_call_output WITHOUT response.create", () => {
    const { client, sentEvents, simulateConnected } = createMockClient("openai15");
    simulateConnected();

    client.submitToolResultBackground("call_123", "ok");

    // Should have exactly ONE event (function_call_output)
    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0]!.type).toBe("conversation.item.create");
    expect(sentEvents[0]!.item.type).toBe("function_call_output");
    expect(sentEvents[0]!.item.call_id).toBe("call_123");
    expect(sentEvents[0]!.item.output).toBe("ok");

    // NO response.create — that's the whole point of backgroundResult
    const responseCreate = sentEvents.find(e => e.type === "response.create");
    expect(responseCreate).toBeUndefined();
  });

  test("contrast: submitToolResult DOES send response.create", () => {
    const { client, sentEvents, simulateConnected } = createMockClient("openai15");
    simulateConnected();

    client.submitToolResult("call_456", "result text");

    // Should have TWO events
    expect(sentEvents).toHaveLength(2);
    expect(sentEvents[0]!.type).toBe("conversation.item.create");
    expect(sentEvents[1]!.type).toBe("response.create");
  });
});

// ══════════════════════════════════════════════════════════════════
// 3. Gemini Adapter — Image Content Handling
// ══════════════════════════════════════════════════════════════════

describe("Gemini adapter image handling", () => {
  const adapter31 = new GeminiProtocolAdapter(); // defaults to 3.1
  const adapter25 = new GeminiProtocolAdapter("gemini-2.5-flash-live-preview");

  test("Gemini 3.1: input_image → realtimeInput.video frame", () => {
    const result = adapter31.transformOutbound("conversation.item.create", {
      item: {
        type: "message",
        role: "user",
        content: [
          { type: "input_image", image: FAKE_JPEG },
        ],
      },
    });

    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.realtimeInput).toBeDefined();
    expect(parsed.realtimeInput.video).toBeDefined();
    expect(parsed.realtimeInput.video.data).toBe(FAKE_JPEG);
    expect(parsed.realtimeInput.video.mimeType).toBe("image/jpeg");
  });

  test("Gemini 2.5: input_image → clientContent.turns with inlineData", () => {
    const result = adapter25.transformOutbound("conversation.item.create", {
      item: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Here's the screenshot" },
          { type: "input_image", image: FAKE_JPEG },
        ],
      },
    });

    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.clientContent).toBeDefined();
    expect(parsed.clientContent.turns).toHaveLength(1);

    const parts = parsed.clientContent.turns[0].parts;
    // Should have inlineData + text
    const imagePart = parts.find((p: any) => p.inlineData);
    const textPart = parts.find((p: any) => p.text);
    expect(imagePart).toBeDefined();
    expect(imagePart.inlineData.mimeType).toBe("image/jpeg");
    expect(imagePart.inlineData.data).toBe(FAKE_JPEG);
    expect(textPart).toBeDefined();
    expect(textPart.text).toBe("Here's the screenshot");
  });

  test("Gemini 3.1: strips data:image/jpeg;base64, prefix", () => {
    const withPrefix = `data:image/jpeg;base64,${FAKE_JPEG}`;
    const result = adapter31.transformOutbound("conversation.item.create", {
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_image", image: withPrefix }],
      },
    });

    const parsed = JSON.parse(result!);
    // Should strip the prefix
    expect(parsed.realtimeInput.video.data).toBe(FAKE_JPEG);
  });

  test("text-only content still goes through text path (no regression)", () => {
    const result = adapter31.transformOutbound("conversation.item.create", {
      item: {
        type: "message",
        role: "system",
        content: [{ type: "input_text", text: "Hello world" }],
      },
    });

    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    // Should use realtimeInput.text (not realtimeInput.video)
    expect(parsed.realtimeInput?.text).toBe("Hello world");
    expect(parsed.realtimeInput?.video).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════
// 4. SceneController — Voice-Driven Navigation
// ══════════════════════════════════════════════════════════════════

describe("SceneController", () => {
  const testScenes: SceneSpec[] = [
    { url: "https://example.com/page1", scrollTarget: "Introduction", talkingPoints: "Talk about intro", durationMs: 5000 },
    { url: "https://example.com/page1", scrollTarget: "Details", talkingPoints: "Talk about details", durationMs: 8000 },
    { url: "https://example.com/page2", talkingPoints: "Talk about page 2", durationMs: 6000 },
  ];

  // Mock ChromeLauncher
  function mockChromeLauncher() {
    let currentUrl = "";
    return {
      navigatePresentingPage: async (url: string) => { currentUrl = url; },
      evaluateOnPresentingPage: async (_code: string) => "scrolled",
      presentingPage: {
        screenshot: async (_opts: any) => Buffer.from(FAKE_JPEG),
      },
      get _currentUrl() { return currentUrl; },
    };
  }

  test("initial state: not loaded, index -1", () => {
    const sc = new SceneController();
    expect(sc.isLoaded).toBe(false);
    expect(sc.currentIndex).toBe(-1);
    expect(sc.currentScene).toBeNull();
  });

  test("load sets scenes and resets state", () => {
    const sc = new SceneController();
    sc.load(testScenes, mockChromeLauncher());
    expect(sc.isLoaded).toBe(true);
    expect(sc.totalScenes).toBe(3);
    expect(sc.currentIndex).toBe(-1);
    expect(sc.hasNext).toBe(true);
    expect(sc.hasPrev).toBe(false);
  });

  test("next() advances through scenes", async () => {
    const sc = new SceneController();
    sc.load(testScenes, mockChromeLauncher());

    const r1 = await sc.next();
    expect(r1.index).toBe(0);
    expect(r1.scene?.scrollTarget).toBe("Introduction");
    expect(r1.screenshot).toBeString();
    expect(sc.currentIndex).toBe(0);

    const r2 = await sc.next();
    expect(r2.index).toBe(1);
    expect(r2.scene?.scrollTarget).toBe("Details");

    const r3 = await sc.next();
    expect(r3.index).toBe(2);
    expect(r3.scene?.url).toBe("https://example.com/page2");

    // Beyond last scene
    const r4 = await sc.next();
    expect(r4.scene).toBeNull();
    expect(r4.screenshot).toBeNull();
  });

  test("prev() goes back", async () => {
    const sc = new SceneController();
    sc.load(testScenes, mockChromeLauncher());

    await sc.next(); // 0
    await sc.next(); // 1
    const r = await sc.prev();
    expect(r.index).toBe(0);
    expect(r.scene?.scrollTarget).toBe("Introduction");
  });

  test("prev() at start returns null scene", async () => {
    const sc = new SceneController();
    sc.load(testScenes, mockChromeLauncher());

    await sc.next(); // 0
    const r = await sc.prev(); // can't go before 0
    expect(r.scene).toBeNull();
  });

  test("goTo() jumps to specific scene", async () => {
    const sc = new SceneController();
    sc.load(testScenes, mockChromeLauncher());

    const r = await sc.goTo(2);
    expect(r.index).toBe(2);
    expect(r.scene?.url).toBe("https://example.com/page2");
    expect(sc.currentIndex).toBe(2);
  });

  test("goTo() with invalid index returns null", async () => {
    const sc = new SceneController();
    sc.load(testScenes, mockChromeLauncher());

    expect((await sc.goTo(-1)).scene).toBeNull();
    expect((await sc.goTo(99)).scene).toBeNull();
  });

  test("unload() resets everything", () => {
    const sc = new SceneController();
    sc.load(testScenes, mockChromeLauncher());
    sc.unload();
    expect(sc.isLoaded).toBe(false);
    expect(sc.totalScenes).toBe(0);
    expect(sc.currentIndex).toBe(-1);
  });
});
