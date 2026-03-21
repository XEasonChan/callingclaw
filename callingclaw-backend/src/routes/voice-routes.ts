// CallingClaw 2.0 — Voice API Routes
// /api/voice/start, /api/voice/stop, /api/voice/text, /api/voice/instructions

import { CONFIG } from "../config";
import type { VoiceProviderName } from "../ai_gateway/realtime_client";
import type { Services, RouteHandler } from "./types";

export function voiceRoutes(services: Services): RouteHandler {
  const startVoiceSession = async (body: {
    instructions?: string;
    audio_mode?: string;
    transport?: "direct" | "meet_bridge" | "browser";
    mode?: "default" | "local" | "meeting" | "test";
  }) => {
    const provider: VoiceProviderName = (body as any).provider || CONFIG.voiceProvider;

    if (provider === "grok" && !CONFIG.grok.apiKey) {
      throw new Error("Grok API key not configured (set XAI_API_KEY in .env)");
    }
    if (provider === "openai" && !CONFIG.openai.apiKey) {
      throw new Error("OpenAI API key not configured");
    }

    // Keep instructions lean — don't dump full memory/workspace into the system prompt.
    // Context is available on-demand via recall_context tool.
    let instructions = body.instructions || undefined;

    // Apply voice selection from frontend (if provided)
    const voice = (body as any).voice;
    if (voice && provider === "grok") CONFIG.grok.voice = voice;
    else if (voice && provider === "openai") CONFIG.openai.voice = voice;

    await services.realtime.start(instructions, provider);

    const transport = body.transport || (body.audio_mode as any) || "meet_bridge";
    if (transport === "meet_bridge") {
      const audioOk = await services.bridge.sendConfigAndVerify(
        { audio_mode: "meet_bridge" },
        { timeoutMs: 3000, retries: 3 }
      );
      console.log(`[Voice] Audio mode: meet_bridge, provider: ${provider} (confirmed: ${audioOk})`);
    }

    services.eventBus.emit("voice.started", { audio_mode: transport, provider, mode: body.mode || "default" });

    return {
      ok: true,
      status: "connected",
      connected: true,
      audio_mode: transport,
      provider,
      mode: body.mode || "default",
    };
  };

  return {
    match: (pathname, method) => pathname.startsWith("/api/voice/"),

    handle: async (req, url, headers) => {
      // POST /api/voice/start — Start voice session + activate audio
      // Accepts optional `provider`: "openai" | "grok" for A/B testing
      if (url.pathname === "/api/voice/start" && req.method === "POST") {
        try {
          const body = (await req.json()) as {
            instructions?: string;
            audio_mode?: string;
            provider?: VoiceProviderName;
          };
          const result = await startVoiceSession(body);
          return Response.json(result, { headers });
        } catch (e: any) {
          return Response.json(
            { error: e.message },
            { status: 500, headers }
          );
        }
      }

      // POST /api/voice/session/start — Unified session start for any transport
      if (url.pathname === "/api/voice/session/start" && req.method === "POST") {
        try {
          const body = (await req.json().catch(() => ({}))) as {
            instructions?: string;
            transport?: "direct" | "meet_bridge" | "browser";
            mode?: "default" | "local" | "meeting" | "test";
            provider?: VoiceProviderName;
          };
          const result = await startVoiceSession(body);
          return Response.json(result, { headers });
        } catch (e: any) {
          return Response.json({ error: e.message }, { status: 500, headers });
        }
      }

      // POST /api/voice/stop — Stop voice session + deactivate audio
      if (url.pathname === "/api/voice/stop" && req.method === "POST") {
        services.realtime.stop();
        services.bridge.send("config", { audio_mode: "default" });
        services.eventBus.emit("voice.stopped", {});
        return Response.json({ ok: true, status: "disconnected" }, { headers });
      }

      // POST /api/voice/session/stop — Unified session stop for any transport
      if (url.pathname === "/api/voice/session/stop" && req.method === "POST") {
        services.realtime.stop();
        services.bridge.send("config", { audio_mode: "default" });
        services.eventBus.emit("voice.stopped", {});
        return Response.json({ ok: true, status: "disconnected", connected: false }, { headers });
      }

      // GET /api/voice/instructions — Get current voice instructions
      if (url.pathname === "/api/voice/instructions" && req.method === "GET") {
        return Response.json({
          instructions: services.realtime.getLastInstructions(),
          connected: services.realtime.connected,
        }, { headers });
      }

      // GET /api/voice/session/status — Lightweight session status
      if (url.pathname === "/api/voice/session/status" && req.method === "GET") {
        return Response.json({
          connected: services.realtime.connected,
          provider: services.realtime.provider,
          instructions: services.realtime.getLastInstructions(),
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
