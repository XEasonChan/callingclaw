// CallingClaw 2.0 — Event Bus API Routes
// /api/events, /api/webhooks (GET+POST+DELETE)

import type { Services, RouteHandler } from "./types";

export function eventRoutes(services: Services): RouteHandler {
  return {
    match: (pathname, method) =>
      pathname === "/api/events" ||
      pathname.startsWith("/api/webhooks"),

    handle: async (req, url, headers) => {
      // GET /api/events — Get recent event history
      if (url.pathname === "/api/events" && req.method === "GET") {
        const count = parseInt(url.searchParams.get("count") || "50");
        const type = url.searchParams.get("type") || undefined;
        const events = services.eventBus.getHistory(count, type);
        return Response.json({ events }, { headers });
      }

      // POST /api/webhooks — Register a webhook
      if (url.pathname === "/api/webhooks" && req.method === "POST") {
        const body = (await req.json()) as {
          url: string;
          events: string[];
          secret?: string;
        };

        if (!body.url || !body.events?.length) {
          return Response.json(
            { error: "url and events[] are required" },
            { status: 400, headers }
          );
        }

        const id = services.eventBus.registerWebhook(body.url, body.events, body.secret);
        return Response.json({ id, url: body.url, events: body.events }, { status: 201, headers });
      }

      // GET /api/webhooks — List registered webhooks
      if (url.pathname === "/api/webhooks" && req.method === "GET") {
        return Response.json({ webhooks: services.eventBus.listWebhooks() }, { headers });
      }

      // Webhook by ID routes
      const webhookMatch = url.pathname.match(/^\/api\/webhooks\/([^/]+)$/);
      if (webhookMatch && req.method === "DELETE") {
        const removed = services.eventBus.removeWebhook(webhookMatch[1]);
        if (!removed) return Response.json({ error: "Webhook not found" }, { status: 404, headers });
        return Response.json({ ok: true }, { headers });
      }

      return Response.json({ error: "Not found" }, { status: 404, headers });
    },
  };
}
