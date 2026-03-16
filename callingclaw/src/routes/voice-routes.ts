// CallingClaw 2.0 — Voice API Routes
// /api/voice/start, /api/voice/stop, /api/voice/text, /api/voice/instructions

import { CONFIG } from "../config";
import type { Services, RouteHandler } from "./types";

export function voiceRoutes(services: Services): RouteHandler {
  return {
    match: (pathname, method) => pathname.startsWith("/api/voice/"),

    handle: async (req, url, headers) => {
      // POST /api/voice/start — Start voice session + activate audio
      if (url.pathname === "/api/voice/start" && req.method === "POST") {
        if (!CONFIG.openai.apiKey) {
          return Response.json(
            { error: "OpenAI API key not configured" },
            { status: 400, headers }
          );
        }
        try {
          const body = (await req.json()) as { instructions?: string; audio_mode?: string };

          // Inject shared context: workspace + ContextSync (OpenClaw memory, pinned files)
          let instructions = body.instructions || undefined;
          const workspacePrompt = services.context.getWorkspacePrompt();
          if (workspacePrompt) {
            instructions = (instructions || "") + `\n\nWorkspace context:\n${workspacePrompt}`;
          }
          const syncBrief = services.contextSync?.getBrief().voice;
          if (syncBrief) {
            instructions = (instructions || "") + `\n\nShared context (user profile, pinned files):\n${syncBrief}`;
          }

          await services.realtime.start(instructions);

          const audioMode = body.audio_mode || "meet_bridge";
          const audioOk = await services.bridge.sendConfigAndVerify(
            { audio_mode: audioMode },
            { timeoutMs: 3000, retries: 3 }
          );
          console.log(`[Voice] Audio mode: ${audioMode} (confirmed: ${audioOk})`);

          services.eventBus.emit("voice.started", { audio_mode: audioMode });

          return Response.json({ ok: true, status: "connected", audio_mode: audioMode }, { headers });
        } catch (e: any) {
          return Response.json(
            { error: e.message },
            { status: 500, headers }
          );
        }
      }

      // POST /api/voice/stop — Stop voice session + deactivate audio
      if (url.pathname === "/api/voice/stop" && req.method === "POST") {
        services.realtime.stop();
        services.bridge.send("config", { audio_mode: "default" });
        services.eventBus.emit("voice.stopped", {});
        return Response.json({ ok: true, status: "disconnected" }, { headers });
      }

      // GET /api/voice/instructions — Get current voice instructions
      if (url.pathname === "/api/voice/instructions" && req.method === "GET") {
        return Response.json({
          instructions: services.realtime.getLastInstructions(),
          connected: services.realtime.connected,
        }, { headers });
      }

      // POST /api/voice/instructions — Update voice instructions mid-session
      if (url.pathname === "/api/voice/instructions" && req.method === "POST") {
        const body = (await req.json()) as { instructions: string };
        if (!body.instructions) {
          return Response.json({ error: "instructions is required" }, { status: 400, headers });
        }
        if (services.realtime.connected) {
          services.realtime.updateInstructions(body.instructions);
          return Response.json({ ok: true, updated: true }, { headers });
        }
        return Response.json({ ok: false, error: "Voice not connected" }, { status: 400, headers });
      }

      // POST /api/voice/text — Send text message to voice session
      if (url.pathname === "/api/voice/text" && req.method === "POST") {
        const body = (await req.json()) as { text: string };
        services.realtime.sendText(body.text);
        return Response.json({ ok: true }, { headers });
      }

      return Response.json({ error: "Not found" }, { status: 404, headers });
    },
  };
}
