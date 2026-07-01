#!/usr/bin/env bun
// Stub CallingClaw backend for the Raven E2E. Runs as its OWN process so it
// doesn't share an event loop with the test driver that spawns Raven.
//
// Args: <port> <callsLogFile>
//   - Records every REST hit (one JSON line per request) to <callsLogFile>.
//   - Serves /ws/events so the MCP server's EventBus bridge connects cleanly.
//   - /api/status returns a recognizable VERSION string so the E2E can prove
//     the full round-trip (raven → MCP stdio → callingclaw-events → HTTP → back)
//     by matching that exact string in Raven's model output.

const port = parseInt(process.argv[2] || "4097");
const callsLog = process.argv[3];
const version = process.argv[4] || "CC-E2E-0.0.0";
const wsClients = new Set<any>();

function record(method: string, path: string, body?: any) {
  if (callsLog) {
    try {
      require("fs").appendFileSync(callsLog, JSON.stringify({ method, path, body }) + "\n");
    } catch {}
  }
}

Bun.serve({
  port,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws/events") {
      if (server.upgrade(req)) return;
      return new Response("upgrade failed", { status: 400 });
    }
    let body: any;
    if (req.method === "POST") {
      try { body = await req.json(); } catch {}
    }

    if (url.pathname === "/__emit" && req.method === "POST") {
      const msg = JSON.stringify({ type: body?.type, data: body?.data || {} });
      for (const ws of wsClients) ws.send(msg);
      return Response.json({ emitted: wsClients.size });
    }

    record(req.method, url.pathname, body);
    const j = (o: any) => Response.json(o);
    switch (url.pathname) {
      // Recognizable version string is the whole point of the /api/status stub.
      case "/api/status": return j({ ok: true, version, voice: "idle" });
      case "/api/meeting/status": return j({ active: false });
      case "/api/meeting/transcript": return j({ entries: ["alice: let's ship"] });
      case "/api/meeting/summary": return j({ summary: "shipped", actionItems: ["release"] });
      case "/api/calendar/events": return j({ events: [] });
      case "/api/meeting/join": return j({ joining: body?.url });
      case "/api/meeting/prepare": return j({ prepStarted: true, topic: body?.topic });
      default: return new Response("not found", { status: 404 });
    }
  },
  websocket: { open(ws) { wsClients.add(ws); }, close(ws) { wsClients.delete(ws); }, message() {} },
});

console.error(`[stub] listening on ${port} (version=${version})`);
