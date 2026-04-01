import { test, expect, mock, beforeEach, afterAll } from "bun:test";
import { RecallAPI } from "../src/recall-api";

// Mock global fetch
const mockFetch = mock(() => Promise.resolve(new Response()));
const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = mockFetch as any;
  mockFetch.mockReset();
});

test("createBot sends correct payload and returns bot", async () => {
  const botResponse = { id: "bot-123", meeting_url: "https://meet.google.com/abc", status_changes: [] };
  mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(botResponse), { status: 201 }));

  const api = new RecallAPI("test-key", "https://us-west-2.recall.ai/api/v1");
  const bot = await api.createBot({
    meetUrl: "https://meet.google.com/abc",
    clientPageUrl: "https://example.com/recall-client.html?ws=wss://backend/ws/recall-bridge",
    botName: "TestBot",
  });

  expect(bot.id).toBe("bot-123");
  expect(mockFetch).toHaveBeenCalledTimes(1);

  const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("https://us-west-2.recall.ai/api/v1/bot/");
  expect(opts.method).toBe("POST");
  expect(opts.headers).toEqual({
    "Authorization": "Token test-key",
    "Content-Type": "application/json",
  });

  const body = JSON.parse(opts.body as string);
  expect(body.meeting_url).toBe("https://meet.google.com/abc");
  expect(body.bot_name).toBe("TestBot");
  expect(body.output_media.camera.kind).toBe("webpage");
  expect(body.output_media.camera.config.url).toContain("recall-client.html");
});

test("createBot throws on 401 (invalid API key)", async () => {
  mockFetch.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));

  const api = new RecallAPI("bad-key");
  expect(api.createBot({ meetUrl: "https://meet.google.com/abc", clientPageUrl: "https://example.com" }))
    .rejects.toThrow("401");
});

test("createBot throws on 400 (bad meeting URL)", async () => {
  mockFetch.mockResolvedValueOnce(new Response('{"error":"Invalid meeting URL"}', { status: 400 }));

  const api = new RecallAPI("test-key");
  expect(api.createBot({ meetUrl: "not-a-url", clientPageUrl: "https://example.com" }))
    .rejects.toThrow("400");
});

test("getBot returns bot data", async () => {
  const botData = { id: "bot-123", meeting_url: "https://meet.google.com/abc", status_changes: [{ code: "ready", created_at: "2026-03-27T00:00:00Z" }] };
  mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(botData), { status: 200 }));

  const api = new RecallAPI("test-key");
  const bot = await api.getBot("bot-123");
  expect(bot.id).toBe("bot-123");
  expect(bot.status_changes).toHaveLength(1);
});

test("getBot throws on 404", async () => {
  mockFetch.mockResolvedValueOnce(new Response("Not found", { status: 404 }));

  const api = new RecallAPI("test-key");
  expect(api.getBot("nonexistent")).rejects.toThrow("404");
});

test("destroyBot succeeds on 200", async () => {
  mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

  const api = new RecallAPI("test-key");
  await api.destroyBot("bot-123"); // should not throw

  const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
  expect(url).toContain("/bot/bot-123/leave_call/");
  expect(opts.method).toBe("POST");
});

test("destroyBot silently handles 404 (bot already gone)", async () => {
  mockFetch.mockResolvedValueOnce(new Response("Not found", { status: 404 }));

  const api = new RecallAPI("test-key");
  await api.destroyBot("bot-gone"); // should NOT throw
});

test("destroyBot throws on 500", async () => {
  mockFetch.mockResolvedValueOnce(new Response("Server error", { status: 500 }));

  const api = new RecallAPI("test-key");
  expect(api.destroyBot("bot-123")).rejects.toThrow("500");
});

test("default bot name is CallingClaw", async () => {
  mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ id: "bot-1" }), { status: 201 }));

  const api = new RecallAPI("test-key");
  await api.createBot({ meetUrl: "https://meet.google.com/abc", clientPageUrl: "https://example.com" });

  const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
  expect(body.bot_name).toBe("CallingClaw");
});

// Restore fetch after all tests
afterAll(() => {
  globalThis.fetch = originalFetch;
});
