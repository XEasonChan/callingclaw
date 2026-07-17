// Tests for the IMPORTANT_EVENTS allowlist + CALLINGCLAW_EVENTS_LEVEL gate.
// Same real-stdio-MCP-server pattern as e2e-mcp.test.ts, but focused on which
// EventBus events survive the filter at each level.
//
// "live" (default, no env var): lifecycle + research/auditor/computer-use/stage.
// "lifecycle": only the original 7 meeting/voice/calendar milestones.
// Both levels must always drop transcript-level noise and voice.tool_call.

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";

function textOf(result: any): string {
  return (result.content || []).map((c: any) => c.text || "").join("");
}

/** Spin up a stub CallingClaw backend (REST + /ws/events) and connect a real
 * MCP client to a real `bun index.ts` server process over stdio. */
async function startHarness(envOverrides: Record<string, string> = {}) {
  const wsClients = new Set<any>();
  const backend = Bun.serve({
    port: 0,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws/events") {
        if (server.upgrade(req)) return;
        return new Response("upgrade failed", { status: 400 });
      }
      switch (url.pathname) {
        case "/api/status": return Response.json({ ok: true });
        case "/api/meeting/status": return Response.json({ active: false });
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

  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(import.meta.dir, "..", "index.ts")],
    env: {
      ...process.env,
      CALLINGCLAW_HTTP: httpBase,
      CALLINGCLAW_URL: wsUrl,
      ...envOverrides,
    },
  });
  const client = new Client({ name: "events-level-test-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  // Let the server's WS bridge connect to the stub backend before we emit anything.
  await new Promise((r) => setTimeout(r, 300));

  return {
    client,
    emit: (type: string, data: Record<string, any> = {}) => {
      const msg = JSON.stringify({ type, data });
      for (const ws of wsClients) ws.send(msg);
    },
    stop: async () => {
      try { await client.close(); } catch {}
      try { backend.stop(true); } catch {}
    },
  };
}

describe("CALLINGCLAW_EVENTS_LEVEL=live (default)", () => {
  let h: Awaited<ReturnType<typeof startHarness>>;

  beforeAll(async () => {
    h = await startHarness(); // no override → default "live"
  });
  afterAll(async () => h.stop());

  test("surfaces the new live-only events (research.completed) and lifecycle events", async () => {
    h.emit("research.completed", { taskId: "t1", query: "pricing", filePath: "/tmp/research-t1.md" });
    h.emit("meeting.no_show", { meetingId: "m1" });
    await new Promise((r) => setTimeout(r, 250));

    const res = await h.client.callTool({ name: "callingclaw_recent_events", arguments: {} });
    const data = JSON.parse(textOf(res));
    const types = data.events.map((e: any) => e.type);
    expect(types).toContain("research.completed");
    expect(types).toContain("meeting.no_show");

    // filePath is normalized but the buffered event just carries the raw payload —
    // confirm the raw data made it through untouched.
    const research = data.events.find((e: any) => e.type === "research.completed");
    expect(research.data.filePath).toBe("/tmp/research-t1.md");
  });

  test("still drops high-volume/noisy events (voice.tool_call, transcript-level)", async () => {
    const before = await h.client.callTool({ name: "callingclaw_recent_events", arguments: {} });
    const cursor = JSON.parse(textOf(before)).cursor;

    h.emit("voice.tool_call", { tool: "take_screenshot" });
    h.emit("transcript.updated", { text: "hello world" }); // hypothetical transcript-level event
    await new Promise((r) => setTimeout(r, 250));

    const after = await h.client.callTool({
      name: "callingclaw_recent_events",
      arguments: { since: cursor },
    });
    const data = JSON.parse(textOf(after));
    expect(data.count).toBe(0);
  });
});

describe("CALLINGCLAW_EVENTS_LEVEL=lifecycle", () => {
  let h: Awaited<ReturnType<typeof startHarness>>;

  beforeAll(async () => {
    h = await startHarness({ CALLINGCLAW_EVENTS_LEVEL: "lifecycle" });
  });
  afterAll(async () => h.stop());

  test("restores the old 7-event allowlist and drops the new live-only events", async () => {
    h.emit("meeting.started", { meetingId: "m2" });
    h.emit("research.completed", { taskId: "t2", query: "q", filePath: "/tmp/x.md" });
    h.emit("auditor.intent", { intent: "share_screen" });
    h.emit("computer.task_started", { instruction: "click button" });
    h.emit("stage.documents_updated", { filePath: "/tmp/doc.md" });
    h.emit("meeting.no_show", { meetingId: "m2" });
    await new Promise((r) => setTimeout(r, 250));

    const res = await h.client.callTool({ name: "callingclaw_recent_events", arguments: {} });
    const data = JSON.parse(textOf(res));
    const types = data.events.map((e: any) => e.type);

    expect(types).toContain("meeting.started");
    expect(types).not.toContain("research.completed");
    expect(types).not.toContain("auditor.intent");
    expect(types).not.toContain("computer.task_started");
    expect(types).not.toContain("stage.documents_updated");
    // meeting.no_show is a v"live"-tier addition, NOT part of the original 7 — excluded at lifecycle level.
    expect(types).not.toContain("meeting.no_show");
  });
});
