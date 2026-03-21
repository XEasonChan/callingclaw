// CallingClaw 2.0 — Post-Meeting Delivery API Routes
// /api/postmeeting/status, /api/postmeeting/callback

import type { Services, RouteHandler } from "./types";

export function postmeetingRoutes(services: Services): RouteHandler {
  return {
    match: (pathname, method) => pathname.startsWith("/api/postmeeting/"),

    handle: async (req, url, headers) => {
      // GET /api/postmeeting/status — Get post-meeting delivery status
      if (url.pathname === "/api/postmeeting/status" && req.method === "GET") {
        return Response.json(
          services.postMeetingDelivery?.getStatus() || { deliveries: 0, active: [] },
          { headers }
        );
      }

      // POST /api/postmeeting/callback — Handle user confirmation from Telegram inline buttons
      // Called by OpenClaw when user clicks buttons
      if (url.pathname === "/api/postmeeting/callback" && req.method === "POST") {
        const body = (await req.json()) as { callbackData: string };
        if (!body.callbackData) {
          return Response.json({ error: "callbackData is required" }, { status: 400, headers });
        }
        if (services.postMeetingDelivery) {
          const result = await services.postMeetingDelivery.handleCallback(body.callbackData);
          return Response.json({ ok: true, result }, { headers });
        }
        return Response.json({ error: "PostMeetingDelivery not available" }, { status: 500, headers });
      }

      return Response.json({ error: "Not found" }, { status: 404, headers });
    },
  };
}
