// End-to-end test of the CallingClaw MCP server over the REAL stdio MCP
// protocol: a real MCP client spawns `bun index.ts`, which talks to a stub
// CallingClaw backend (REST + /ws/events). Proves the whole integration path:
//   MCP client → tools/list + tools/call → MCP server → REST → backend
//   backend event → /ws/events → server buffer → callingclaw_recent_events

import { test, expect, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";

let backend: ReturnType<typeof Bun.serve>;
let client: Client;
const wsClients = new Set<any>();
const restCalls: Array<{ method: string; path: string; body?: any }> = [];

beforeAll(async () => {
  // ── Stub CallingClaw backend: REST + /ws/events ──
  backend = Bun.serve({
    port: 0,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws/events") {
        if (server.upgrade(req)) return;
        return new Response("upgrade failed", { status: 400 });
      }
      let body: any;
      if (req.method === "POST") { try { body = await req.json(); } catch {} }
      restCalls.push({ method: req.method, path: url.pathname, body });
      const json = (o: any) => Response.json(o);
      switch (url.pathname) {
        case "/api/status": return json({ ok: true });
        case "/api/meeting/status": return json({ active: true, platform: "google-meet" });
        case "/api/meeting/transcript": return json({ entries: ["alice: hi", "bob: hello"] });
        case "/api/meeting/summary": return json({ summary: "synced on roadmap", actionItems: ["ship v2"] });
        case "/api/calendar/events": return json({ events: [{ id: "e1", title: "Review" }] });
        case "/api/meeting/join": return json({ joining: body?.url });
        case "/api/meeting/prepare": return json({ prepStarted: true, topic: body?.topic });
        default: return new Response("not found", { status: 404 });
      }
    },
    websocket: {
      open(ws) { wsClients.add(ws); },
      close(ws) { wsClients.delete(ws); },
      message() {},
    },
  });

  const httpBase = `http://localhost:${backend.port}`;
  const wsUrl = `ws://localhost:${backend.port}/ws/events`;

  // ── Real MCP client spawns the real MCP server (index.ts) over stdio ──
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(import.meta.dir, "..", "index.ts")],
    env: {
      ...process.env,
      CALLINGCLAW_HTTP: httpBase,
      CALLINGCLAW_URL: wsUrl,
    },
  });
  client = new Client({ name: "e2e-test-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  // Give the server's WS bridge a moment to connect to the stub backend.
  await new Promise((r) => setTimeout(r, 300));
});

afterAll(async () => {
  try { await client.close(); } catch {}
  try { backend.stop(true); } catch {}
});

function textOf(result: any): string {
  return (result.content || []).map((c: any) => c.text || "").join("");
}

test("tools/list exposes all 7 universal CallingClaw tools", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  expect(names).toEqual([
    "callingclaw_join_meeting",
    "callingclaw_list_calendar",
    "callingclaw_prepare_meeting",
    "callingclaw_recent_events",
    "callingclaw_status",
    "callingclaw_summary",
    "callingclaw_transcript",
  ]);
});

test("callingclaw_status round-trips through MCP → REST → backend", async () => {
  const res = await client.callTool({ name: "callingclaw_status", arguments: {} });
  const data = JSON.parse(textOf(res));
  expect(data.system.ok).toBe(true);
  expect(data.meeting.platform).toBe("google-meet");
});

test("callingclaw_summary returns action items", async () => {
  const res = await client.callTool({ name: "callingclaw_summary", arguments: {} });
  const data = JSON.parse(textOf(res));
  expect(data.actionItems).toContain("ship v2");
});

test("callingclaw_join_meeting (拉起会议) POSTs to the backend", async () => {
  restCalls.length = 0;
  const res = await client.callTool({
    name: "callingclaw_join_meeting",
    arguments: { url: "https://meet.google.com/e2e" },
  });
  const data = JSON.parse(textOf(res));
  expect(data.joining).toBe("https://meet.google.com/e2e");
  const call = restCalls.find((c) => c.path === "/api/meeting/join");
  expect(call?.method).toBe("POST");
  expect(call?.body.url).toBe("https://meet.google.com/e2e");
});

test("callingclaw_prepare_meeting (会议议程) POSTs the topic", async () => {
  restCalls.length = 0;
  const res = await client.callTool({
    name: "callingclaw_prepare_meeting",
    arguments: { topic: "Q3 Review" },
  });
  const data = JSON.parse(textOf(res));
  expect(data.prepStarted).toBe(true);
  expect(restCalls.find((c) => c.path === "/api/meeting/prepare")?.body.topic).toBe("Q3 Review");
});

test("backend event → /ws/events → callingclaw_recent_events", async () => {
  // Emit a meeting.summary_ready event from the stub backend to all WS clients.
  const evt = JSON.stringify({
    type: "meeting.summary_ready",
    data: { meetingId: "m-e2e", filepath: "/tmp/summary.md" },
  });
  for (const ws of wsClients) ws.send(evt);
  // Allow the event to flow through the MCP server's buffer.
  await new Promise((r) => setTimeout(r, 250));

  const res = await client.callTool({ name: "callingclaw_recent_events", arguments: {} });
  const data = JSON.parse(textOf(res));
  expect(data.count).toBeGreaterThanOrEqual(1);
  const summary = data.events.find((e: any) => e.type === "meeting.summary_ready");
  expect(summary).toBeTruthy();
  expect(summary.data.meetingId).toBe("m-e2e");
});

test("error path: join without url returns isError", async () => {
  const res: any = await client.callTool({ name: "callingclaw_join_meeting", arguments: {} });
  expect(res.isError).toBe(true);
  expect(textOf(res)).toMatch(/url/);
});
