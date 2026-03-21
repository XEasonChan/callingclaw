// CallingClaw 2.0 — Computer Use API Routes
// /api/computer/run, /api/computer/analyze, /api/bridge/action

import type { Services, RouteHandler } from "./types";

export function computerRoutes(services: Services): RouteHandler {
  return {
    match: (pathname, method) =>
      pathname.startsWith("/api/computer/") ||
      pathname === "/api/bridge/action",

    handle: async (req, url, headers) => {
      // POST /api/computer/run — Run Computer Use task
      if (url.pathname === "/api/computer/run" && req.method === "POST") {
        if (!services.computerUse.isConfigured) {
          return Response.json(
            { error: "No API key configured. Set ANTHROPIC_API_KEY for Computer Use support." },
            { status: 400, headers }
          );
        }
        const body = (await req.json()) as { instruction: string };
        services.eventBus.emit("computer.task_started", { instruction: body.instruction });
        try {
          const result = await services.computerUse.execute(body.instruction);
          services.eventBus.emit("computer.task_done", { instruction: body.instruction, summary: result.summary });
          return Response.json(result, { headers });
        } catch (e: any) {
          const msg = e.message || String(e);
          services.eventBus.emit("computer.task_done", { instruction: body.instruction, summary: `Error: ${msg}` });
          return Response.json({ summary: `Error: ${msg}`, steps: [] }, { status: 500, headers });
        }
      }

      // POST /api/computer/analyze — Analyze a screenshot
      if (url.pathname === "/api/computer/analyze" && req.method === "POST") {
        const body = (await req.json()) as {
          image: string;
          question: string;
        };
        const { ClaudeAgent } = await import("../ai_gateway/claude_agent");
        const agent = new ClaudeAgent(services.bridge);
        const answer = await agent.analyzeImage(body.image, body.question);
        return Response.json({ answer }, { headers });
      }

      // POST /api/bridge/action — Send direct action to Python sidecar
      if (url.pathname === "/api/bridge/action" && req.method === "POST") {
        const body = (await req.json()) as {
          action: string;
          params?: Record<string, any>;
        };
        const sent = services.bridge.sendAction(body.action, body.params || {});
        return Response.json({ sent }, { headers });
      }

      return Response.json({ error: "Not found" }, { status: 404, headers });
    },
  };
}
