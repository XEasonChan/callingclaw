// CallingClaw 2.0 — HTTP Config Server (Bun.serve)
// Provides REST API for the web config page + service status + meeting notes
// + EventBus WebSocket + TaskStore + Workspace Context
//
// Route handlers are extracted into src/routes/ for parallel development.
// This file retains: WebSocket upgrade, static file serving, voice test WS.

import { CONFIG } from "./config";
import { buildAllRoutes } from "./routes";
import type { Services } from "./routes";

// ── Tool Layer Definitions (for Voice Test toggles) ──
const TOOL_LAYERS: Record<string, { label: string; tools: string[] }> = {
  memory:     { label: "Memory",     tools: ["recall_context"] },
  calendar:   { label: "Calendar",   tools: ["schedule_meeting", "check_calendar"] },
  meeting:    { label: "Meeting",    tools: ["join_meeting", "create_and_join_meeting", "leave_meeting", "save_meeting_notes"] },
  automation: { label: "Automation", tools: ["computer_action", "browser_action", "open_file", "share_screen", "stop_sharing", "take_screenshot"] },
  zoom:       { label: "Zoom",       tools: ["zoom_control"] },
};

export function startConfigServer(services: Services) {
  // ── Browser Voice Test clients ──
  const browserVoiceClients = new Set<any>();

  // ── Build all route handlers ──
  const routes = buildAllRoutes(services);

  const server = Bun.serve({
    port: CONFIG.port,

    // ── WebSocket handler (multiplexed: EventBus + Voice Test) ──
    websocket: {
      open(ws: any) {
        if (ws.data?.type === "voice-test") {
          browserVoiceClients.add(ws);
          ws.send(JSON.stringify({ type: "status", voiceConnected: services.realtime.connected }));
          console.log(`[VoiceTest] Browser client connected (${browserVoiceClients.size} total)`);
        } else {
          services.eventBus.addSubscriber(ws);
        }
      },
      close(ws: any) {
        if (ws.data?.type === "voice-test") {
          browserVoiceClients.delete(ws);
          console.log(`[VoiceTest] Browser client disconnected (${browserVoiceClients.size} remaining)`);
        } else {
          services.eventBus.removeSubscriber(ws);
        }
      },
      message(ws: any, msg: any) {
        if (ws.data?.type === "voice-test") {
          try {
            const raw = typeof msg === "string" ? msg : new TextDecoder().decode(msg as ArrayBuffer);
            const data = JSON.parse(raw);
            if (data.type === "audio" && data.audio) {
              services.realtime.sendAudio(data.audio);
            } else if (data.type === "start") {
              // Start voice session from browser
              const instructions = data.instructions || undefined;
              services.realtime.start(instructions).then(() => {
                ws.send(JSON.stringify({ type: "status", voiceConnected: true }));
                services.eventBus.emit("voice.started", { audio_mode: "browser" });
              }).catch((e: any) => {
                ws.send(JSON.stringify({ type: "error", message: e.message }));
              });
            } else if (data.type === "stop") {
              services.realtime.stop();
              ws.send(JSON.stringify({ type: "status", voiceConnected: false }));
              services.eventBus.emit("voice.stopped", {});
            } else if (data.type === "update_instructions" && data.instructions) {
              const ok = services.realtime.updateInstructions(data.instructions);
              ws.send(JSON.stringify({ type: "instructions_updated", ok }));
            } else if (data.type === "set_layers") {
              // Toggle tool layers: filter getAllTools() by selected layers
              const enabledLayers: string[] = data.layers || [];
              const enabledToolNames = new Set<string>();
              for (const layerName of enabledLayers) {
                const layer = TOOL_LAYERS[layerName];
                if (layer) for (const t of layer.tools) enabledToolNames.add(t);
              }
              const allTools = services.realtime.getAllTools();
              const filtered = allTools.filter((t) => enabledToolNames.has(t.name));
              const ok = services.realtime.setActiveTools(filtered);
              ws.send(JSON.stringify({
                type: "layers_updated",
                ok,
                activeLayers: enabledLayers,
                activeTools: filtered.map((t) => t.name),
                totalTools: allTools.length,
              }));
              console.log(`[VoiceTest] Layers: [${enabledLayers.join(", ")}] → ${filtered.length}/${allTools.length} tools active`);
            } else if (data.type === "get_layers") {
              // Return layer definitions + dependency status
              const layerStatus: Record<string, any> = {};
              for (const [key, layer] of Object.entries(TOOL_LAYERS)) {
                layerStatus[key] = {
                  label: layer.label,
                  toolCount: layer.tools.length,
                  tools: layer.tools,
                };
              }
              // Add dependency info
              if (layerStatus.memory) {
                layerStatus.memory.status = services.openclawBridge?.connected ? "OpenClaw connected" : "local only";
              }
              if (layerStatus.calendar) {
                layerStatus.calendar.status = services.calendar.connected ? "connected" : "not configured";
              }
              if (layerStatus.automation) {
                layerStatus.automation.status = services.bridge.ready ? "sidecar connected" : "sidecar offline";
              }
              ws.send(JSON.stringify({ type: "layers_info", layers: layerStatus, totalTools: services.realtime.getAllTools().length }));
            }
          } catch (e) {
            // Ignore parse errors for audio chunks
          }
        }
      },
    },

    async fetch(req, server) {
      const url = new URL(req.url);

      // CORS headers
      const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Content-Type": "application/json",
      };

      if (req.method === "OPTIONS") {
        return new Response(null, { headers });
      }

      // ── WebSocket upgrade for /ws/events ──
      if (url.pathname === "/ws/events") {
        const upgraded = server.upgrade(req, { data: { type: "events" } });
        if (!upgraded) {
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return undefined as any;
      }

      // ── WebSocket upgrade for /ws/voice-test (browser mic/speaker) ──
      if (url.pathname === "/ws/voice-test") {
        const upgraded = server.upgrade(req, { data: { type: "voice-test" } });
        if (!upgraded) {
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return undefined as any;
      }

      // ── Delegate to route modules ──
      for (const route of routes) {
        if (route.match(url.pathname, req.method)) {
          return route.handle(req, url, headers);
        }
      }

      // --- Static files (public/) ---
      // Friendlier URL aliases
      const pathnameAlias: Record<string, string> = {
        "/meeting-view": "/meeting-view.html",
        "/panel": "/callingclaw-panel.html",
        "/voice-test": "/voice-test.html",
        "/meeting-join-test": "/meeting-join-test.html",
      };
      const resolvedPath = pathnameAlias[url.pathname] ?? url.pathname;
      const publicPath = `${import.meta.dir}/../public${resolvedPath === "/" ? "/callingclaw-panel.html" : resolvedPath}`;
      const file = Bun.file(publicPath);
      if (await file.exists()) {
        return new Response(file);
      }

      return Response.json({ error: "Not found" }, { status: 404, headers });
    },
  });

  // ── Forward AI audio output to browser voice test clients ──
  services.realtime.onAudioOutput((base64Pcm) => {
    for (const ws of browserVoiceClients) {
      try { ws.send(JSON.stringify({ type: "audio", audio: base64Pcm })); } catch {}
    }
  });

  // ── Forward transcript entries to browser voice test clients ──
  services.context.on("transcript", (entry: any) => {
    const msg = JSON.stringify({ type: "transcript", role: entry.role, text: entry.text, ts: entry.ts });
    for (const ws of browserVoiceClients) {
      try { ws.send(msg); } catch {}
    }
  });

  console.log(`[Config] HTTP server on http://localhost:${CONFIG.port}`);
  console.log(`[Config] WebSocket events on ws://localhost:${CONFIG.port}/ws/events`);
  console.log(`[Config] Voice test WS on ws://localhost:${CONFIG.port}/ws/voice-test`);
  return server;
}
