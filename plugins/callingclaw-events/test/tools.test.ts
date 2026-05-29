// Tests for the universal MCP tool layer + event buffer.
// Spins up a mock CallingClaw REST server and drives the tool handlers directly.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { EventBuffer } from "../event-buffer";

let server: ReturnType<typeof Bun.serve>;
const calls: Array<{ method: string; path: string; body?: any }> = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      let body: any = undefined;
      if (req.method === "POST") {
        try { body = await req.json(); } catch {}
      }
      calls.push({ method: req.method, path: url.pathname, body });

      const json = (obj: any) => new Response(JSON.stringify(obj), {
        headers: { "Content-Type": "application/json" },
      });

      switch (url.pathname) {
        case "/api/status": return json({ ok: true, voice: "idle" });
        case "/api/meeting/status": return json({ active: false });
        case "/api/meeting/transcript": return json({ entries: ["hello"] });
        case "/api/meeting/summary": return json({ summary: "did things", actionItems: [] });
        case "/api/calendar/events": return json({ events: [{ id: "evt1", title: "Standup" }] });
        case "/api/meeting/join": return json({ joining: body?.url });
        case "/api/meeting/prepare": return json({ prepStarted: true, topic: body?.topic, eventId: body?.eventId });
        default: return new Response("not found", { status: 404 });
      }
    },
  });
  // Point the client at the mock server. Must be set before importing tools.
  process.env.CALLINGCLAW_HTTP = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));

// Import AFTER env is set so the client picks up the mock base URL.
const { handleToolCall, TOOL_DEFINITIONS } = await import("../tools");

test("exposes the expected universal tools", () => {
  const names = TOOL_DEFINITIONS.map((t) => t.name);
  expect(names).toEqual([
    "callingclaw_status",
    "callingclaw_transcript",
    "callingclaw_summary",
    "callingclaw_recent_events",
    "callingclaw_join_meeting",
    "callingclaw_prepare_meeting",
    "callingclaw_list_calendar",
  ]);
});

test("callingclaw_status aggregates system + meeting", async () => {
  const buf = new EventBuffer();
  const res: any = await handleToolCall("callingclaw_status", {}, buf);
  expect(res.system.ok).toBe(true);
  expect(res.meeting.active).toBe(false);
});

test("callingclaw_transcript / summary / list_calendar hit the right endpoints", async () => {
  const buf = new EventBuffer();
  expect((await handleToolCall("callingclaw_transcript", {}, buf) as any).entries).toEqual(["hello"]);
  expect((await handleToolCall("callingclaw_summary", {}, buf) as any).summary).toBe("did things");
  expect((await handleToolCall("callingclaw_list_calendar", {}, buf) as any).events[0].id).toBe("evt1");
});

test("callingclaw_join_meeting POSTs the url (拉起会议)", async () => {
  const buf = new EventBuffer();
  calls.length = 0;
  const res: any = await handleToolCall("callingclaw_join_meeting", { url: "https://meet.google.com/abc" }, buf);
  expect(res.joining).toBe("https://meet.google.com/abc");
  const joinCall = calls.find((c) => c.path === "/api/meeting/join");
  expect(joinCall?.method).toBe("POST");
  expect(joinCall?.body.url).toBe("https://meet.google.com/abc");
});

test("callingclaw_join_meeting requires url", async () => {
  const buf = new EventBuffer();
  await expect(handleToolCall("callingclaw_join_meeting", {}, buf)).rejects.toThrow(/url/);
});

test("callingclaw_prepare_meeting POSTs topic (会议议程)", async () => {
  const buf = new EventBuffer();
  calls.length = 0;
  const res: any = await handleToolCall("callingclaw_prepare_meeting", { topic: "Q3 planning" }, buf);
  expect(res.topic).toBe("Q3 planning");
  const prepCall = calls.find((c) => c.path === "/api/meeting/prepare");
  expect(prepCall?.body.topic).toBe("Q3 planning");
});

test("callingclaw_prepare_meeting requires topic or eventId", async () => {
  const buf = new EventBuffer();
  await expect(handleToolCall("callingclaw_prepare_meeting", {}, buf)).rejects.toThrow(/topic|eventId/);
});

test("unknown tool throws", async () => {
  const buf = new EventBuffer();
  await expect(handleToolCall("nope", {}, buf)).rejects.toThrow(/Unknown tool/);
});

test("recent_events returns buffered events and advances cursor", async () => {
  const buf = new EventBuffer();
  buf.push("meeting.started", { meetingId: "m1" });
  buf.push("meeting.summary_ready", { meetingId: "m1", filepath: "/tmp/s.md" });

  const all: any = await handleToolCall("callingclaw_recent_events", {}, buf);
  expect(all.count).toBe(2);
  expect(all.cursor).toBe(2);
  expect(all.events[0].type).toBe("meeting.started");

  // Poll again with the cursor → only new events
  const none: any = await handleToolCall("callingclaw_recent_events", { since: all.cursor }, buf);
  expect(none.count).toBe(0);

  buf.push("meeting.ended", { meetingId: "m1" });
  const more: any = await handleToolCall("callingclaw_recent_events", { since: all.cursor }, buf);
  expect(more.count).toBe(1);
  expect(more.events[0].type).toBe("meeting.ended");
});

test("event buffer caps at max size", () => {
  const buf = new EventBuffer(3);
  for (let i = 0; i < 10; i++) buf.push("voice.started", { i });
  const res = buf.since(0);
  expect(res.length).toBe(3);
  // cursor keeps counting even after eviction
  expect(buf.cursor).toBe(10);
  expect(res[res.length - 1].data.i).toBe(9);
});
