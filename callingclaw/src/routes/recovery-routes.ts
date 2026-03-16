// CallingClaw 2.0 — Self-Recovery API Routes
// /api/recovery/browser, /api/recovery/sidecar, /api/recovery/voice, /api/recovery/health

import { CONFIG } from "../config";
import type { Services, RouteHandler } from "./types";

export function recoveryRoutes(services: Services): RouteHandler {
  return {
    match: (pathname, method) => pathname.startsWith("/api/recovery/"),

    handle: async (req, url, headers) => {
      // POST /api/recovery/browser — Kill and restart the browser
      if (url.pathname === "/api/recovery/browser" && req.method === "POST") {
        if (!services.playwrightCli) {
          return Response.json({ error: "Playwright CLI not initialized" }, { status: 500, headers });
        }
        const result = await services.playwrightCli.resetBrowser();
        services.eventBus.emit("recovery.browser", result);
        return Response.json(result, { headers });
      }

      // POST /api/recovery/sidecar — Restart the Python sidecar
      if (url.pathname === "/api/recovery/sidecar" && req.method === "POST") {
        try {
          // Kill existing sidecar
          await Bun.$`pkill -f "python.*python_sidecar/main.py"`.quiet().nothrow();
          await new Promise(r => setTimeout(r, 1000));
          // Bridge will auto-reconnect when new sidecar starts
          const pythonBin = process.env.PYTHON_PATH || "/opt/miniconda3/bin/python3";
          const pythonPath = `${import.meta.dir}/../../python_sidecar/main.py`;
          Bun.spawn([pythonBin, pythonPath], {
            stdout: "inherit",
            stderr: "inherit",
            env: { ...process.env, BRIDGE_PORT: String(CONFIG.bridgePort) },
          });
          services.eventBus.emit("recovery.sidecar", { success: true });
          return Response.json({ success: true, detail: "Python sidecar restarted" }, { headers });
        } catch (e: any) {
          return Response.json({ success: false, detail: e.message }, { status: 500, headers });
        }
      }

      // POST /api/recovery/voice — Restart voice session
      if (url.pathname === "/api/recovery/voice" && req.method === "POST") {
        try {
          if (services.realtime.connected) {
            services.realtime.stop();
            await new Promise(r => setTimeout(r, 500));
          }
          const body = (await req.json().catch(() => ({}))) as { instructions?: string };
          await services.realtime.start(body.instructions);
          services.eventBus.emit("recovery.voice", { success: true });
          return Response.json({ success: true, detail: "Voice session restarted" }, { headers });
        } catch (e: any) {
          return Response.json({ success: false, detail: e.message }, { status: 500, headers });
        }
      }

      // GET /api/recovery/health — Quick health check of all subsystems
      if (url.pathname === "/api/recovery/health" && req.method === "GET") {
        const health = {
          browser: services.playwrightCli?.connected ?? false,
          sidecar: services.bridge.ready,
          voice: services.realtime.connected,
          calendar: services.calendar.connected,
          openclaw: services.openclawBridge?.connected ?? false,
          admissionMonitor: services.playwrightCli?.isAdmissionMonitoring ?? false,
          meetingActive: services.meeting.getNotes().isRecording,
        };
        const allHealthy = health.browser && health.sidecar;
        return Response.json({ healthy: allHealthy, subsystems: health }, { headers });
      }

      return Response.json({ error: "Not found" }, { status: 404, headers });
    },
  };
}
