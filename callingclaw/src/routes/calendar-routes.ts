// CallingClaw 2.0 — Calendar API Routes
// /api/calendar/events, /api/calendar/create

import type { Services, RouteHandler } from "./types";

export function calendarRoutes(services: Services): RouteHandler {
  return {
    match: (pathname, method) => pathname.startsWith("/api/calendar/"),

    handle: async (req, url, headers) => {
      // GET /api/calendar/events — List upcoming events
      if (url.pathname === "/api/calendar/events" && req.method === "GET") {
        const events = await services.calendar.listUpcomingEvents();
        return Response.json({ events }, { headers });
      }

      // POST /api/calendar/create — Create calendar event
      if (url.pathname === "/api/calendar/create" && req.method === "POST") {
        const body = await req.json();
        const result = await services.calendar.createEvent(body);
        return Response.json({ result }, { headers });
      }

      return Response.json({ error: "Not found" }, { status: 404, headers });
    },
  };
}
