// CallingClaw 2.0 — Unit Tests for Incremental Context Injection
// Tests the Layer-3 context queue (token-budgeted text eviction, separate
// image-count cap — see CONTEXT-ENGINEERING.md), inject/remove/replay
// without real WebSocket.

import { test, expect, describe, beforeEach } from "bun:test";
import { RealtimeClient, getProvider } from "./realtime_client";

// ── Mock WebSocket ──────────────────────────────────────────────────
// We need to bypass the real WebSocket connection and manually control
// the client's connected state + capture sent events.

function createMockClient(): {
  client: RealtimeClient;
  sentEvents: Array<{ type: string; [key: string]: any }>;
  simulateConnected: () => void;
} {
  const client = new RealtimeClient();
  const sentEvents: Array<{ type: string; [key: string]: any }> = [];

  // Override sendEvent to capture events instead of sending via WS
  (client as any).sendEvent = (type: string, data: any = {}) => {
    sentEvents.push({ type, ...data });
    return true;
  };

  // Simulate connected state
  const simulateConnected = () => {
    (client as any)._connected = true;
  };

  return { client, sentEvents, simulateConnected };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("Incremental Context Injection", () => {
  let client: RealtimeClient;
  let sentEvents: Array<{ type: string; [key: string]: any }>;
  let simulateConnected: () => void;

  beforeEach(() => {
    const m = createMockClient();
    client = m.client;
    sentEvents = m.sentEvents;
    simulateConnected = m.simulateConnected;
  });

  test("injectContext returns false when not connected", () => {
    const result = client.injectContext("test context");
    expect(result).toBe(false);
    expect(sentEvents.length).toBe(0);
  });

  test("injectContext returns false for empty text", () => {
    simulateConnected();
    const result = client.injectContext("");
    expect(result).toBe(false);
  });

  test("injectContext sends conversation.item.create with role system", () => {
    simulateConnected();
    const result = client.injectContext("[CONTEXT] PRD v2.3 核心目标是...");

    expect(result).not.toBe(false);
    expect(typeof result).toBe("string");
    expect(sentEvents.length).toBe(1);

    const ev = sentEvents[0]!;
    expect(ev.type).toBe("conversation.item.create");
    expect(ev.item.type).toBe("message");
    expect(ev.item.role).toBe("system");
    expect(ev.item.content[0].type).toBe("input_text");
    expect(ev.item.content[0].text).toBe("[CONTEXT] PRD v2.3 核心目标是...");
  });

  test("injectContext does NOT send response.create (silent injection)", () => {
    simulateConnected();
    client.injectContext("test");

    const responseCreateEvents = sentEvents.filter((e) => e.type === "response.create");
    expect(responseCreateEvents.length).toBe(0);
  });

  test("injectContext uses custom ID when provided", () => {
    simulateConnected();
    const result = client.injectContext("test", "my_custom_id");

    expect(result).toBe("my_custom_id");
    expect(sentEvents[0]!.item.id).toBe("my_custom_id");
  });

  test("injectContext auto-generates ID when not provided", () => {
    simulateConnected();
    const result = client.injectContext("test");

    expect(typeof result).toBe("string");
    expect((result as string).startsWith("ctx_")).toBe(true);
  });

  test("context queue tracks injected items", () => {
    simulateConnected();

    client.injectContext("context 1");
    client.injectContext("context 2");
    client.injectContext("context 3");

    const queue = client.getContextQueue();
    expect(queue.length).toBe(3);
    expect(queue[0]!.text).toBe("context 1");
    expect(queue[1]!.text).toBe("context 2");
    expect(queue[2]!.text).toBe("context 3");
  });

  // Text eviction is TOKEN-budgeted (MAX_CONTEXT_TOKENS_L3 = 3000 estimated
  // tokens), not item-count FIFO. estimateTokens() is ~1 token per 3 chars,
  // so a 3000-char item ≈ 1000 tokens — sized here for predictable math.
  const TOKENS_1000 = "x".repeat(3000); // ceil(3000/3) = 1000 estimated tokens

  test("text eviction deletes oldest item once the Layer-3 token budget is exceeded", () => {
    simulateConnected();

    // 3 items @ ~1000 tokens = 3000 total, exactly at budget (not over) — no eviction yet
    client.injectContext(TOKENS_1000, "ctx_0");
    client.injectContext(TOKENS_1000, "ctx_1");
    client.injectContext(TOKENS_1000, "ctx_2");
    expect(client.getContextQueue().length).toBe(3);

    // 4th item pushes total to ~4000 tokens (> 3000 budget) → evict oldest (ctx_0)
    // until back under budget: evicting one 1000-token item brings it to 3000, which stops the loop.
    client.injectContext(TOKENS_1000, "ctx_3");

    const queue = client.getContextQueue();
    expect(queue.length).toBe(3);
    expect(queue[0]!.id).toBe("ctx_1"); // ctx_0 evicted
    expect(queue[2]!.id).toBe("ctx_3"); // newest survives

    const deleteEvents = sentEvents.filter((e) => e.type === "conversation.item.delete");
    expect(deleteEvents.length).toBe(1);
    expect(deleteEvents[0]!.item_id).toBe("ctx_0");
  });

  test("text eviction can evict multiple oldest items in a single call", () => {
    simulateConnected();

    // 3 items @ ~1000 tokens = 3000 total (at budget, not over)
    client.injectContext(TOKENS_1000, "ctx_0");
    client.injectContext(TOKENS_1000, "ctx_1");
    client.injectContext(TOKENS_1000, "ctx_2");
    expect(client.getContextQueue().length).toBe(3);

    // One big ~1500-token item pushes total to ~4500 → must evict ctx_0 (3500
    // remaining, still over) then ctx_1 (2500 remaining, under budget) to settle.
    const TOKENS_1500 = "x".repeat(4500); // ceil(4500/3) = 1500 estimated tokens
    client.injectContext(TOKENS_1500, "ctx_3");

    const queue = client.getContextQueue();
    expect(queue.length).toBe(2);
    expect(queue[0]!.id).toBe("ctx_2");
    expect(queue[1]!.id).toBe("ctx_3");

    const deleteEvents = sentEvents.filter((e) => e.type === "conversation.item.delete");
    expect(deleteEvents.length).toBe(2);
    expect(deleteEvents.map((e) => e.item_id)).toEqual(["ctx_0", "ctx_1"]);
  });

  test("images are capped by count (MAX_IMAGE_ITEMS = 2), independent of the text token budget", () => {
    simulateConnected();
    // openai/grok have no image support and fall back to text captions —
    // use a provider that supports input_image so injectImage exercises the
    // real image-pool eviction path.
    (client as any)._provider = getProvider("openai15");

    // Small text item stays well under the token budget throughout.
    client.injectContext("some retrieved context", "ctx_text");

    client.injectImage("aGVsbG8=", "screenshot 1");
    client.injectImage("aGVsbG8=", "screenshot 2");
    expect(sentEvents.filter((e) => e.type === "conversation.item.delete").length).toBe(0);

    // 3rd image exceeds MAX_IMAGE_ITEMS=2 → oldest image evicted, text item untouched
    client.injectImage("aGVsbG8=", "screenshot 3");

    const queue = client.getContextQueue();
    const images = queue.filter((c) => c.kind === "image");
    expect(images.length).toBe(2);
    expect(queue.some((c) => c.id === "ctx_text")).toBe(true);

    const deleteEvents = sentEvents.filter((e) => e.type === "conversation.item.delete");
    expect(deleteEvents.length).toBe(1);
  });

  test("removeContext sends delete event and removes from queue", () => {
    simulateConnected();

    client.injectContext("keep me", "keep_1");
    client.injectContext("delete me", "delete_1");
    client.injectContext("keep me too", "keep_2");

    sentEvents.length = 0; // Clear previous events

    const result = client.removeContext("delete_1");
    expect(result).toBe(true);

    const queue = client.getContextQueue();
    expect(queue.length).toBe(2);
    expect(queue[0]!.id).toBe("keep_1");
    expect(queue[1]!.id).toBe("keep_2");

    expect(sentEvents[0]!.type).toBe("conversation.item.delete");
    expect(sentEvents[0]!.item_id).toBe("delete_1");
  });

  test("removeContext handles non-existent ID gracefully", () => {
    simulateConnected();

    client.injectContext("test", "test_1");
    const result = client.removeContext("non_existent");

    // Still sends the delete event (server may have it even if we don't track it)
    expect(result).toBe(true);
    // Queue unchanged
    expect(client.getContextQueue().length).toBe(1);
  });

  test("clearContextQueue empties the queue", () => {
    simulateConnected();

    client.injectContext("a");
    client.injectContext("b");
    client.injectContext("c");
    expect(client.getContextQueue().length).toBe(3);

    client.clearContextQueue();
    expect(client.getContextQueue().length).toBe(0);
  });

  test("context items have injectedAt timestamps", () => {
    simulateConnected();
    const before = Date.now();

    client.injectContext("test");

    const queue = client.getContextQueue();
    expect(queue[0]!.injectedAt).toBeGreaterThanOrEqual(before);
    expect(queue[0]!.injectedAt).toBeLessThanOrEqual(Date.now());
  });
});

describe("Context Queue Reconnect Replay", () => {
  test("_replayContextQueue replays all items after reconnect", () => {
    const { client, sentEvents, simulateConnected } = createMockClient();
    simulateConnected();

    // Inject some context items
    client.injectContext("context A", "ctx_a");
    client.injectContext("context B", "ctx_b");
    client.injectContext("context C", "ctx_c");

    sentEvents.length = 0; // Clear

    // Simulate replay (calling private method via bracket notation)
    (client as any)._replayContextQueue();

    expect(sentEvents.length).toBe(3);
    expect(sentEvents[0]!.type).toBe("conversation.item.create");
    expect(sentEvents[0]!.item.id).toBe("ctx_a");
    expect(sentEvents[0]!.item.role).toBe("system");
    expect(sentEvents[0]!.item.content[0].text).toBe("context A");

    expect(sentEvents[1]!.item.id).toBe("ctx_b");
    expect(sentEvents[2]!.item.id).toBe("ctx_c");
  });

  test("_replayContextQueue does nothing with empty queue", () => {
    const { client, sentEvents, simulateConnected } = createMockClient();
    simulateConnected();

    (client as any)._replayContextQueue();
    expect(sentEvents.length).toBe(0);
  });
});
