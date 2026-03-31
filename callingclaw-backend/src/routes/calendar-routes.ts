// CallingClaw 2.0 — Calendar API Routes
// /api/calendar/events, /api/calendar/create

import type { Services, RouteHandler } from "./types";

/** Read sessions.json to find prep briefs for matching events */
async function loadPrepSessions(): Promise<Map<string, { topic: string; prepFile: string }>> {
  const map = new Map<string, { topic: string; prepFile: string }>();
  try {
    const sessionsPath = `${process.env.CALLINGCLAW_HOME || process.env.HOME + "/.callingclaw"}/shared/sessions.json`;
    const file = Bun.file(sessionsPath);
    if (await file.exists()) {
      const data = await file.json() as any;
      for (const s of data.sessions || []) {
        if (s.topic && s.files?.prep) {
          map.set(s.topic.toLowerCase(), { topic: s.topic, prepFile: s.files.prep });
        }
      }
    }
  } catch {}
  return map;
}

export function calendarRoutes(services: Services): RouteHandler {
  return {
    match: (pathname, method) => pathname.startsWith("/api/calendar/"),

    handle: async (req, url, headers) => {
      // GET /api/calendar/events — List upcoming events with prep brief status
      if (url.pathname === "/api/calendar/events" && req.method === "GET") {
        const connected = services.calendar.connected;
        const events = await services.calendar.listUpcomingEvents();

        // Enrich events with prep brief status from sessions.json
        const prepSessions = await loadPrepSessions();
        const enriched = events.map((e: any) => {
          const titleLower = (e.summary || "").toLowerCase();
          // Match by topic substring — prep topics often contain the calendar event title
          let prepBrief: string | null = null;
          for (const [topic, data] of prepSessions) {
            if (titleLower.includes(topic) || topic.includes(titleLower)) {
              prepBrief = data.prepFile;
              break;
            }
          }
          return { ...e, _prepBrief: prepBrief };
        });

        return Response.json({ events: enriched, connected }, { headers });
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
