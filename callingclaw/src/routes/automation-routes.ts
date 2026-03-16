// CallingClaw 2.0 — Automation Router API Routes
// /api/automation/run, /api/automation/classify, /api/automation/status, /api/automation/browser

import type { Services, RouteHandler } from "./types";

export function automationRoutes(services: Services): RouteHandler {
  return {
    match: (pathname, method) => pathname.startsWith("/api/automation/"),

    handle: async (req, url, headers) => {
      // GET /api/automation/status — Get status of all 4 automation layers
      if (url.pathname === "/api/automation/status" && req.method === "GET") {
        const status = services.automationRouter?.getStatus() || {
          shortcuts: { available: true, detail: "Always available" },
          playwright: { available: false, detail: "Router not initialized" },
          peekaboo: { available: false, detail: "Router not initialized" },
          computer_use: { available: services.computerUse.isConfigured, detail: "Vision fallback" },
        };
        return Response.json(status, { headers });
      }

      // POST /api/automation/run — Run instruction through the 4-layer router
      if (url.pathname === "/api/automation/run" && req.method === "POST") {
        const body = (await req.json()) as { instruction: string };
        if (!body.instruction) {
          return Response.json({ error: "instruction is required" }, { status: 400, headers });
        }

        if (!services.automationRouter) {
          return Response.json({ error: "Automation router not initialized" }, { status: 500, headers });
        }

        const result = await services.automationRouter.execute(body.instruction);

        // If the router signals Computer Use fallback, delegate there
        if (!result.success && result.result === "Failed: DELEGATE_TO_COMPUTER_USE") {
          if (services.computerUse.isConfigured) {
            services.eventBus.emit("computer.task_started", { instruction: body.instruction });
            const cuResult = await services.computerUse.execute(body.instruction);
            services.eventBus.emit("computer.task_done", { instruction: body.instruction, summary: cuResult.summary });
            return Response.json({ layer: "computer_use", ...cuResult }, { headers });
          }
          return Response.json({ error: "No automation layer can handle this instruction" }, { status: 400, headers });
        }

        return Response.json(result, { headers });
      }

      // POST /api/automation/classify — Classify an instruction (dry run, no execution)
      if (url.pathname === "/api/automation/classify" && req.method === "POST") {
        const body = (await req.json()) as { instruction: string };
        if (!services.automationRouter) {
          return Response.json({ error: "Router not initialized" }, { status: 500, headers });
        }
        const intent = services.automationRouter.classify(body.instruction);
        return Response.json(intent, { headers });
      }

      // POST /api/automation/browser — Run a goal through the model-driven browser action loop
      if (url.pathname === "/api/automation/browser" && req.method === "POST") {
        const body = (await req.json()) as { goal: string; context?: string; maxSteps?: number; timeoutMs?: number };
        if (!body.goal) {
          return Response.json({ error: "goal is required" }, { status: 400, headers });
        }
        if (!services.browserLoop) {
          return Response.json({ error: "Browser action loop not initialized" }, { status: 500, headers });
        }
        const result = await services.browserLoop.run(body.goal, {
          context: body.context,
          maxSteps: body.maxSteps,
          timeoutMs: body.timeoutMs,
        });
        return Response.json(result, { headers });
      }

      return Response.json({ error: "Not found" }, { status: 404, headers });
    },
  };
}
