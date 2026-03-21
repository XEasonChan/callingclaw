// CallingClaw 2.0 — Screen Sharing API Routes
// /api/screen/share, /api/screen/stop, /api/screen/open

import type { Services, RouteHandler } from "./types";

export function screenRoutes(services: Services): RouteHandler {
  return {
    match: (pathname, method) => pathname.startsWith("/api/screen/"),

    handle: async (req, url, headers) => {
      // POST /api/screen/share — Start screen sharing in Meet
      if (url.pathname === "/api/screen/share" && req.method === "POST") {
        const ok = await services.meetJoiner.shareScreen();
        return Response.json({ ok, sharing: services.meetJoiner.isSharing }, { headers });
      }

      // POST /api/screen/stop — Stop screen sharing
      if (url.pathname === "/api/screen/stop" && req.method === "POST") {
        await services.meetJoiner.stopSharing();
        return Response.json({ ok: true, sharing: false }, { headers });
      }

      // POST /api/screen/open — Open a file on CallingClaw's screen
      if (url.pathname === "/api/screen/open" && req.method === "POST") {
        const body = (await req.json()) as { path: string; app?: "vscode" | "browser" | "finder" };
        await services.meetJoiner.openFile(body.path, body.app || "vscode");
        return Response.json({ ok: true, opened: body.path }, { headers });
      }

      return Response.json({ error: "Not found" }, { status: 404, headers });
    },
  };
}
