// CallingClaw 2.0 — Core API Routes
// /api/status, /api/config (GET+POST), /api/keys (GET+POST)

import { CONFIG } from "../config";
import { readFileSync } from "fs";
import { resolve } from "path";
import type { Services, RouteHandler } from "./types";

// ── Read unified VERSION file ────────────────────────────────
let APP_VERSION = "2.0.0";
try {
  APP_VERSION = readFileSync(resolve(__dirname, "..", "..", "..", "VERSION"), "utf-8").trim();
} catch {
  // Fallback
}

const ENV_PATH = `${import.meta.dir}/../../../.env`;

export function coreRoutes(services: Services): RouteHandler {
  return {
    match: (pathname, method) =>
      pathname === "/api/status" ||
      pathname === "/api/keys" ||
      pathname === "/api/config",

    handle: async (req, url, headers) => {
      // GET /api/status — Service health check
      if (url.pathname === "/api/status") {
        return Response.json(
          {
            callingclaw: "running",
            version: APP_VERSION,
            bridge: services.bridge.ready ? "connected" : "disconnected",
            realtime: services.realtime.connected
              ? "connected"
              : "disconnected",
            calendar: services.calendar.connected
              ? "connected"
              : "disconnected",
            openclaw: services.computerUse.openclawConnected
              ? "connected"
              : "disconnected",
            meeting: services.meeting.getNotes().isRecording
              ? "recording"
              : "idle",
            sharing: services.meetJoiner.isSharing,
            transcriptLength: services.context.transcript.length,
            taskStats: services.taskStore.stats(),
            automation: services.automationRouter?.getStatus() || null,
            transcriptAuditor: services.transcriptAuditor?.active ? "active" : "standby",
            uptime: process.uptime(),
          },
          { headers }
        );
      }

      // GET /api/keys — Get current API key status (masked)
      if (url.pathname === "/api/keys" && req.method === "GET") {
        return Response.json(
          {
            openai: CONFIG.openai.apiKey
              ? `sk-...${CONFIG.openai.apiKey.slice(-4)}`
              : "",
            anthropic: CONFIG.anthropic.apiKey
              ? `sk-ant-...${CONFIG.anthropic.apiKey.slice(-4)}`
              : "",
            openrouter: CONFIG.openrouter.apiKey
              ? `sk-or-...${CONFIG.openrouter.apiKey.slice(-4)}`
              : "",
            google_configured: !!(
              process.env.GOOGLE_CLIENT_ID &&
              process.env.GOOGLE_REFRESH_TOKEN
            ),
          },
          { headers }
        );
      }

      // POST /api/keys — Update API keys (writes to .env)
      if (url.pathname === "/api/keys" && req.method === "POST") {
        const body = (await req.json()) as Record<string, string>;
        const envFile = Bun.file(ENV_PATH);
        let envContent = (await envFile.exists()) ? await envFile.text() : "";

        for (const [key, value] of Object.entries(body)) {
          const envKey = key.toUpperCase();
          const regex = new RegExp(`^${envKey}=.*$`, "m");
          if (regex.test(envContent)) {
            envContent = envContent.replace(regex, `${envKey}=${value}`);
          } else {
            envContent += `\n${envKey}=${value}`;
          }
          if (envKey === "OPENAI_API_KEY") CONFIG.openai.apiKey = value;
          if (envKey === "ANTHROPIC_API_KEY") CONFIG.anthropic.apiKey = value;
          if (envKey === "OPENROUTER_API_KEY") CONFIG.openrouter.apiKey = value;
        }

        await Bun.write(ENV_PATH, envContent);
        return Response.json({ ok: true, message: "Keys updated" }, { headers });
      }

      // GET /api/config — Get non-secret configuration
      if (url.pathname === "/api/config" && req.method === "GET") {
        return Response.json(
          {
            screen: CONFIG.screen,
            audio: CONFIG.audio,
            openai_model: CONFIG.openai.realtimeModel,
            openai_voice: CONFIG.openai.voice,
            anthropic_model: CONFIG.anthropic.model,
            openrouter_model: CONFIG.openrouter.model,
          },
          { headers }
        );
      }

      // POST /api/config — Update configuration
      if (url.pathname === "/api/config" && req.method === "POST") {
        const body = await req.json();
        if (body.screen) Object.assign(CONFIG.screen, body.screen);
        if (body.audio) Object.assign(CONFIG.audio, body.audio);
        if (body.openai_voice) {
          CONFIG.openai.voice = body.openai_voice;
          // Push to live session if connected
          if (services.realtime.connected) {
            services.realtime.setVoice(body.openai_voice);
          }
        }
        return Response.json({ ok: true, voice: CONFIG.openai.voice }, { headers });
      }

      return Response.json({ error: "Not found" }, { status: 404, headers });
    },
  };
}
