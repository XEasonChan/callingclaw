// CallingClaw 2.0 — Meeting Scheduler API Routes
// /api/scheduler/status, /api/scheduler/start, /api/scheduler/stop,
// /api/scheduler/poll, /api/scheduler/schedule

import type { Services, RouteHandler } from "./types";

export function schedulerRoutes(services: Services): RouteHandler {
  return {
    match: (pathname, method) => pathname.startsWith("/api/scheduler/"),

    handle: async (req, url, headers) => {
      // GET /api/scheduler/status — Get scheduler status and upcoming scheduled meetings
      if (url.pathname === "/api/scheduler/status" && req.method === "GET") {
        return Response.json(
          services.meetingScheduler?.getStatus() || { active: false, scheduled: 0, meetings: [] },
          { headers }
        );
      }

      // POST /api/scheduler/start — Start the meeting scheduler
      if (url.pathname === "/api/scheduler/start" && req.method === "POST") {
        if (services.meetingScheduler) {
          services.meetingScheduler.start();
          return Response.json({ ok: true, status: "started" }, { headers });
        }
        return Response.json({ error: "Scheduler not available" }, { status: 500, headers });
      }

      // POST /api/scheduler/stop — Stop the meeting scheduler
      if (url.pathname === "/api/scheduler/stop" && req.method === "POST") {
        if (services.meetingScheduler) {
          services.meetingScheduler.stop();
          return Response.json({ ok: true, status: "stopped" }, { headers });
        }
        return Response.json({ error: "Scheduler not available" }, { status: 500, headers });
      }

      // POST /api/scheduler/poll — Force an immediate calendar poll
      if (url.pathname === "/api/scheduler/poll" && req.method === "POST") {
        if (services.meetingScheduler) {
          await services.meetingScheduler.poll();
          return Response.json({
            ok: true,
            ...services.meetingScheduler.getStatus(),
          }, { headers });
        }
        return Response.json({ error: "Scheduler not available" }, { status: 500, headers });
      }

      // POST /api/scheduler/schedule — Manually schedule a meeting for auto-join
      if (url.pathname === "/api/scheduler/schedule" && req.method === "POST") {
        const body = (await req.json()) as { url: string; joinAt: string; summary?: string };
        if (!body.url || !body.joinAt) {
          return Response.json({ error: "url and joinAt (ISO) are required" }, { status: 400, headers });
        }
        if (services.meetingScheduler) {
          const jobId = await services.meetingScheduler.scheduleManual(body.url, body.joinAt, body.summary);
          return Response.json({ ok: !!jobId, jobId }, { headers });
        }
        return Response.json({ error: "Scheduler not available" }, { status: 500, headers });
      }

      return Response.json({ error: "Not found" }, { status: 404, headers });
    },
  };
}
