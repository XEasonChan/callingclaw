// CallingClaw 2.0 — Unit Tests for Incremental Context Injection
// Tests the FIFO context queue, inject/remove/replay without real WebSocket.

import { test, expect, describe, beforeEach } from "bun:test";
import { RealtimeClient } from "./realtime_client";

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

  test("FIFO eviction deletes oldest items when queue exceeds MAX (15)", () => {
    simulateConnected();

    // Inject 16 items (exceeds MAX_CONTEXT_ITEMS = 15)
    for (let i = 0; i < 16; i++) {
      client.injectContext(`context ${i}`, `ctx_${i}`);
    }

    const queue = client.getContextQueue();
    expect(queue.length).toBe(15);

    // First item should have been evicted
    expect(queue[0]!.id).toBe("ctx_1");
    expect(queue[0]!.text).toBe("context 1");

    // Last item should be the newest
    expect(queue[14]!.id).toBe("ctx_15");
    expect(queue[14]!.text).toBe("context 15");

    // Should have sent a conversation.item.delete for ctx_0
    const deleteEvents = sentEvents.filter((e) => e.type === "conversation.item.delete");
    expect(deleteEvents.length).toBe(1);
    expect(deleteEvents[0]!.item_id).toBe("ctx_0");
  });

  test("FIFO eviction handles multiple evictions at once", () => {
    simulateConnected();

    // Fill to exactly 15
    for (let i = 0; i < 15; i++) {
      client.injectContext(`context ${i}`, `ctx_${i}`);
    }
    expect(client.getContextQueue().length).toBe(15);

    // Now add 3 more → should evict 3 oldest
    client.injectContext("new 1", "new_1");
    client.injectContext("new 2", "new_2");
    client.injectContext("new 3", "new_3");

    const queue = client.getContextQueue();
    expect(queue.length).toBe(15);
    expect(queue[0]!.id).toBe("ctx_3"); // 0,1,2 evicted
    expect(queue[14]!.id).toBe("new_3");

    const deleteEvents = sentEvents.filter((e) => e.type === "conversation.item.delete");
    expect(deleteEvents.length).toBe(3);
    expect(deleteEvents.map((e) => e.item_id)).toEqual(["ctx_0", "ctx_1", "ctx_2"]);
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
