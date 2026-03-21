// CallingClaw 2.0 — HTTP Config Server (Bun.serve)
// Provides REST API for the web config page + service status + meeting notes
// + EventBus WebSocket + TaskStore + Workspace Context

import { CONFIG, USER_CONFIG_PATH } from "./config";
import { readFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import type { PythonBridge } from "./bridge";

// ── Read unified VERSION file ────────────────────────────────
let APP_VERSION = "2.4.2";
try {
  // Try callingclaw/VERSION first, then root CallingClaw 2.0/VERSION
  try {
    APP_VERSION = readFileSync(resolve(__dirname, "..", "VERSION"), "utf-8").trim();
  } catch {
    APP_VERSION = readFileSync(resolve(__dirname, "..", "..", "VERSION"), "utf-8").trim();
  }
} catch {
  // Fallback to hardcoded
}
import type { VoiceModule } from "./modules/voice";
import type { GoogleCalendarClient } from "./mcp_client/google_cal";
import type { SharedContext } from "./modules/shared-context";
import type { MeetingModule } from "./modules/meeting";
import type { ComputerUseModule } from "./modules/computer-use";
import type { MeetJoiner } from "./meet_joiner";
import type { EventBus } from "./modules/event-bus";
import type { TaskStore } from "./modules/task-store";
import type { AutomationRouter } from "./modules/automation-router";
import type { ContextSync } from "./modules/context-sync";
import type { MeetingPrepSkill } from "./skills/meeting-prep";
import type { OpenClawBridge } from "./openclaw_bridge";
import type { TranscriptAuditor } from "./modules/transcript-auditor";
import type { BrowserActionLoop } from "./modules/browser-action-loop";
import type { PlaywrightCLIClient } from "./mcp_client/playwright-cli";
import { buildVoiceInstructions, prepareMeeting, injectMeetingBrief } from "./voice-persona";
import { scanForGoogleCredentials } from "./mcp_client/google_cal";
import { validateMeetingUrl } from "./meet_joiner";
import { readSessions, readSharedFile, listPrepFiles } from "./modules/shared-documents";
import { SHARED_PREP_DIR, SHARED_NOTES_DIR } from "./config";

const ENV_PATH = `${import.meta.dir}/../../.env`;

import type { MeetingScheduler } from "./modules/meeting-scheduler";
import type { PostMeetingDelivery } from "./modules/post-meeting-delivery";

interface Services {
  bridge: PythonBridge;
  realtime: VoiceModule;
  calendar: GoogleCalendarClient;
  context: SharedContext;
  meeting: MeetingModule;
  computerUse: ComputerUseModule;
  meetJoiner: MeetJoiner;
  eventBus: EventBus;
  taskStore: TaskStore;
  automationRouter?: AutomationRouter;
  contextSync?: ContextSync;
  meetingPrepSkill?: MeetingPrepSkill;
  openclawBridge?: OpenClawBridge;
  transcriptAuditor?: TranscriptAuditor;
  browserLoop?: BrowserActionLoop;
  playwrightCli?: PlaywrightCLIClient;
  meetingScheduler?: MeetingScheduler;
  postMeetingDelivery?: PostMeetingDelivery;
  meetingDB?: import("./modules/meeting-db").MeetingDB;
}

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
  // ── Electron Audio Bridge clients (replaces Python sidecar) ──
  const audioBridgeClients = new Set<any>();
  const voiceSessionState: {
    active: boolean;
    mode: "default" | "local" | "meeting" | "test";
    transport: "direct" | "meet_bridge" | "browser" | "none";
    topic: string | null;
    provider: string | null;
    startedAt: number | null;
  } = {
    active: false,
    mode: "default",
    transport: "none",
    topic: null,
    provider: null,
    startedAt: null,
  };

  // Keep instructions lean — context available on-demand via recall_context tool.
  const buildSessionInstructions = (baseInstructions?: string) => {
    return baseInstructions || undefined;
  };

  const markVoiceSession = (opts: {
    mode: "default" | "local" | "meeting" | "test";
    transport: "direct" | "meet_bridge" | "browser" | "none";
    topic?: string | null;
    provider?: string | null;
  }) => {
    voiceSessionState.active = true;
    voiceSessionState.mode = opts.mode;
    voiceSessionState.transport = opts.transport;
    voiceSessionState.topic = opts.topic ?? null;
    voiceSessionState.provider = opts.provider ?? services.realtime.provider;
    voiceSessionState.startedAt = Date.now();
  };

  const clearVoiceSession = () => {
    voiceSessionState.active = false;
    voiceSessionState.mode = "default";
    voiceSessionState.transport = "none";
    voiceSessionState.topic = null;
    voiceSessionState.provider = null;
    voiceSessionState.startedAt = null;
  };

  const startVoiceSession = async (opts: {
    instructions?: string;
    transport?: "direct" | "meet_bridge" | "browser";
    mode?: "default" | "local" | "meeting" | "test";
    topic?: string;
    provider?: string;
    voice?: string;
  }) => {
    const provider = (opts.provider || CONFIG.voiceProvider) as any;

    // Validate API key for selected provider
    if (provider === "grok" && !CONFIG.grok.apiKey) {
      throw new Error("Grok API key not configured (set XAI_API_KEY in .env)");
    }
    if (provider === "openai" && !CONFIG.openai.apiKey) {
      throw new Error("OpenAI API key not configured");
    }

    // Apply voice selection
    if (opts.voice && provider === "grok") CONFIG.grok.voice = opts.voice;
    else if (opts.voice && provider === "openai") CONFIG.openai.voice = opts.voice;

    const transport = opts.transport || "meet_bridge";
    const mode = opts.mode || "default";
    const instructions = buildSessionInstructions(opts.instructions);

    if (services.realtime.connected) {
      services.realtime.stop();
    }

    await services.realtime.start(instructions, provider);

    if (transport === "meet_bridge") {
      const audioOk = await services.bridge.sendConfigAndVerify(
        { audio_mode: "meet_bridge" },
        { timeoutMs: 3000, retries: 3 }
      );
      console.log(`[VoiceSession] Audio mode: meet_bridge (confirmed: ${audioOk})`);
    }

    markVoiceSession({
      mode,
      transport,
      topic: opts.topic,
      provider: services.realtime.provider,
    });
    services.eventBus.emit("voice.started", { audio_mode: transport, mode, topic: opts.topic || null });

    return {
      ok: true,
      status: "connected",
      connected: true,
      mode,
      transport,
      topic: opts.topic || null,
      provider: services.realtime.provider,
      startedAt: voiceSessionState.startedAt,
    };
  };

  const stopVoiceSession = (opts?: { resetBridge?: boolean }) => {
    if (services.realtime.connected) {
      services.realtime.stop();
    }
    if (opts?.resetBridge !== false) {
      services.bridge.send("config", { audio_mode: "default", capture_mode: "mouse" });
    }
    clearVoiceSession();
    services.eventBus.emit("voice.stopped", {});
    return { ok: true, status: "disconnected", connected: false };
  };

  const server = Bun.serve({
    port: CONFIG.port,

    // ── WebSocket handler (multiplexed: EventBus + Voice Test + Audio Bridge) ──
    websocket: {
      open(ws: any) {
        if (ws.data?.type === "voice-test") {
          browserVoiceClients.add(ws);
          ws.send(JSON.stringify({ type: "status", voiceConnected: services.realtime.connected }));
          console.log(`[VoiceTest] Browser client connected (${browserVoiceClients.size} total)`);
        } else if (ws.data?.type === "audio-bridge") {
          audioBridgeClients.add(ws);
          ws.send(JSON.stringify({ type: "status", voiceConnected: services.realtime.connected }));
          console.log(`[AudioBridge] Electron client connected (${audioBridgeClients.size} total)`);
        } else {
          services.eventBus.addSubscriber(ws);
        }
      },
      close(ws: any) {
        if (ws.data?.type === "voice-test") {
          browserVoiceClients.delete(ws);
          console.log(`[VoiceTest] Browser client disconnected (${browserVoiceClients.size} remaining)`);
        } else if (ws.data?.type === "audio-bridge") {
          audioBridgeClients.delete(ws);
          console.log(`[AudioBridge] Electron client disconnected (${audioBridgeClients.size} remaining)`);
        } else {
          services.eventBus.removeSubscriber(ws);
        }
      },
      message(ws: any, msg: any) {
        // ── Audio Bridge: Electron mic → OpenAI Realtime, same protocol as Python bridge ──
        if (ws.data?.type === "audio-bridge") {
          try {
            const raw = typeof msg === "string" ? msg : new TextDecoder().decode(msg as ArrayBuffer);
            const data = JSON.parse(raw);
            if (data.type === "audio_chunk" && data.payload?.audio) {
              services.realtime.sendAudio(data.payload.audio);
            }
          } catch {}
          return;
        }
        if (ws.data?.type === "voice-test") {
          try {
            const raw = typeof msg === "string" ? msg : new TextDecoder().decode(msg as ArrayBuffer);
            const data = JSON.parse(raw);
            if (data.type === "audio" && data.audio) {
              if (!globalThis._vtAudioCount) globalThis._vtAudioCount = 0;
              if (++globalThis._vtAudioCount % 50 === 1) {
                console.log(`[VoiceTest] Mic audio chunk #${globalThis._vtAudioCount} (${data.audio.length} b64 chars)`);
              }
              services.realtime.sendAudio(data.audio);
            } else if (data.type === "start") {
              // Start voice session from browser (supports provider + voice selection)
              const instructions = data.instructions || undefined;
              const provider = data.provider || undefined; // "openai" | "grok"
              const voice = data.voice || undefined;

              // If Grok provider selected with a specific voice, update Grok config before start
              if (provider === "grok" && voice) {
                CONFIG.grok.voice = voice;
              } else if (provider === "openai" && voice) {
                CONFIG.openai.voice = voice;
              }

              services.realtime.start(instructions, provider).then(() => {
                ws.send(JSON.stringify({ type: "status", voiceConnected: true, provider: services.realtime.provider }));
                services.eventBus.emit("voice.started", { audio_mode: "browser", provider });
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

      // ── WebSocket upgrade for /ws/audio-bridge (Electron AudioBridge, replaces Python sidecar) ──
      if (url.pathname === "/ws/audio-bridge") {
        const upgraded = server.upgrade(req, { data: { type: "audio-bridge" } });
        if (!upgraded) {
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return undefined as any;
      }

      // ══════════════════════════════════════════════════════════════
      // ── Core API Routes ──
      // ══════════════════════════════════════════════════════════════

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
            voiceSession: {
              connected: services.realtime.connected,
              ...voiceSessionState,
            },
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
          // Push to live session if connected — but only if using OpenAI provider
          // Sending OpenAI voice names (e.g. "marin") to Grok would be invalid
          if (services.realtime.connected && services.realtime.provider === "openai") {
            services.realtime.setVoice(body.openai_voice);
          }
        }
        return Response.json({ ok: true, voice: CONFIG.openai.voice }, { headers });
      }

      // GET /api/config/user-email — Get persistent user email
      if (url.pathname === "/api/config/user-email" && req.method === "GET") {
        return Response.json({ email: CONFIG.userEmail }, { headers });
      }

      // POST /api/config/user-email — Set persistent user email
      if (url.pathname === "/api/config/user-email" && req.method === "POST") {
        const body = await req.json();
        const email = (body.email || "").trim();
        CONFIG.userEmail = email;
        // Persist to ~/.callingclaw/user-config.json
        try {
          let existing: Record<string, string> = {};
          const f = Bun.file(USER_CONFIG_PATH);
          if (await f.exists()) {
            existing = await f.json();
          }
          existing.userEmail = email;
          mkdirSync(dirname(USER_CONFIG_PATH), { recursive: true });
          await Bun.write(USER_CONFIG_PATH, JSON.stringify(existing, null, 2));
        } catch (e: any) {
          console.warn("[Config] Failed to persist user email:", e.message);
        }
        return Response.json({ ok: true, email }, { headers });
      }

      // ══════════════════════════════════════════════════════════════
      // ── Voice API ──
      // ══════════════════════════════════════════════════════════════

      // POST /api/voice/start — Start voice session + activate audio
      if (url.pathname === "/api/voice/start" && req.method === "POST") {
        try {
          const body = (await req.json()) as { instructions?: string; audio_mode?: string };
          const audioMode = (body.audio_mode as "direct" | "meet_bridge" | "browser" | undefined) || "meet_bridge";
          const result = await startVoiceSession({
            instructions: body.instructions,
            transport: audioMode,
            mode: audioMode === "meet_bridge" ? "meeting" : "default",
          });
          return Response.json({ ...result, audio_mode: audioMode }, { headers });
        } catch (e: any) {
          return Response.json(
            { error: e.message },
            { status: 500, headers }
          );
        }
      }

      // POST /api/voice/session/start — Start voice session without assuming a transport implementation
      if (url.pathname === "/api/voice/session/start" && req.method === "POST") {
        try {
          const body = (await req.json().catch(() => ({}))) as {
            instructions?: string;
            transport?: "direct" | "meet_bridge" | "browser";
            mode?: "default" | "local" | "meeting" | "test";
            topic?: string;
            provider?: string;
            voice?: string;
          };
          const result = await startVoiceSession({
            instructions: body.instructions,
            transport: body.transport || "direct",
            mode: body.mode || "default",
            topic: body.topic,
            provider: body.provider,
            voice: body.voice,
          });
          return Response.json(result, { headers });
        } catch (e: any) {
          return Response.json({ error: e.message }, { status: 500, headers });
        }
      }

      // POST /api/voice/stop — Stop voice session + deactivate audio
      if (url.pathname === "/api/voice/stop" && req.method === "POST") {
        return Response.json(stopVoiceSession(), { headers });
      }

      // GET /api/voice/session/status — Inspect current unified voice session state
      if (url.pathname === "/api/voice/session/status" && req.method === "GET") {
        return Response.json({
          connected: services.realtime.connected,
          ...voiceSessionState,
          instructions: services.realtime.getLastInstructions(),
        }, { headers });
      }

      // POST /api/voice/session/stop — Stop unified voice session without assuming meeting teardown
      if (url.pathname === "/api/voice/session/stop" && req.method === "POST") {
        return Response.json(stopVoiceSession(), { headers });
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

      // ══════════════════════════════════════════════════════════════
      // ── Computer Use API ──
      // ══════════════════════════════════════════════════════════════

      // POST /api/computer/run — Run Computer Use task
      if (url.pathname === "/api/computer/run" && req.method === "POST") {
        if (!services.computerUse.isConfigured) {
          return Response.json(
            { error: "No API key configured. Set ANTHROPIC_API_KEY for Computer Use support." },
            { status: 400, headers }
          );
        }
        const body = (await req.json()) as { instruction: string };
        services.eventBus.emit("computer.task_started", { instruction: body.instruction });
        try {
          const result = await services.computerUse.execute(body.instruction);
          services.eventBus.emit("computer.task_done", { instruction: body.instruction, summary: result.summary });
          return Response.json(result, { headers });
        } catch (e: any) {
          const msg = e.message || String(e);
          services.eventBus.emit("computer.task_done", { instruction: body.instruction, summary: `Error: ${msg}` });
          return Response.json({ summary: `Error: ${msg}`, steps: [] }, { status: 500, headers });
        }
      }

      // POST /api/computer/analyze — Analyze a screenshot
      if (url.pathname === "/api/computer/analyze" && req.method === "POST") {
        const body = (await req.json()) as {
          image: string;
          question: string;
        };
        const { ClaudeAgent } = await import("./ai_gateway/claude_agent");
        const agent = new ClaudeAgent(services.bridge);
        const answer = await agent.analyzeImage(body.image, body.question);
        return Response.json({ answer }, { headers });
      }

      // ══════════════════════════════════════════════════════════════
      // ── Automation Router API ──
      // ══════════════════════════════════════════════════════════════

      // GET /api/automation/status — Get status of all 4 automation layers
      if (url.pathname === "/api/automation/status" && req.method === "GET") {
        const status = services.automationRouter?.getStatus() || {
          shortcuts: { available: true, detail: "Always available" },
          playwright: { available: false, detail: "Router not initialized" },
          peekaboo: { available: false, detail: "Router not initialized" },
          computer_use: { available: services.computerUse.isConfigured, detail: "Vision fallback" },
        };
        return Response.json(status, { headers });
      }

      // POST /api/automation/run — Run instruction through the 4-layer router
      if (url.pathname === "/api/automation/run" && req.method === "POST") {
        const body = (await req.json()) as { instruction: string };
        if (!body.instruction) {
          return Response.json({ error: "instruction is required" }, { status: 400, headers });
        }

        if (!services.automationRouter) {
          return Response.json({ error: "Automation router not initialized" }, { status: 500, headers });
        }

        const result = await services.automationRouter.execute(body.instruction);

        // If the router signals Computer Use fallback, delegate there
        if (!result.success && result.result === "Failed: DELEGATE_TO_COMPUTER_USE") {
          if (services.computerUse.isConfigured) {
            services.eventBus.emit("computer.task_started", { instruction: body.instruction });
            const cuResult = await services.computerUse.execute(body.instruction);
            services.eventBus.emit("computer.task_done", { instruction: body.instruction, summary: cuResult.summary });
            return Response.json({ layer: "computer_use", ...cuResult }, { headers });
          }
          return Response.json({ error: "No automation layer can handle this instruction" }, { status: 400, headers });
        }

        return Response.json(result, { headers });
      }

      // POST /api/automation/classify — Classify an instruction (dry run, no execution)
      if (url.pathname === "/api/automation/classify" && req.method === "POST") {
        const body = (await req.json()) as { instruction: string };
        if (!services.automationRouter) {
          return Response.json({ error: "Router not initialized" }, { status: 500, headers });
        }
        const intent = services.automationRouter.classify(body.instruction);
        return Response.json(intent, { headers });
      }

      // POST /api/automation/browser — Run a goal through the model-driven browser action loop
      if (url.pathname === "/api/automation/browser" && req.method === "POST") {
        const body = (await req.json()) as { goal: string; context?: string; maxSteps?: number; timeoutMs?: number };
        if (!body.goal) {
          return Response.json({ error: "goal is required" }, { status: 400, headers });
        }
        if (!services.browserLoop) {
          return Response.json({ error: "Browser action loop not initialized" }, { status: 500, headers });
        }
        const result = await services.browserLoop.run(body.goal, {
          context: body.context,
          maxSteps: body.maxSteps,
          timeoutMs: body.timeoutMs,
        });
        return Response.json(result, { headers });
      }

      // ══════════════════════════════════════════════════════════════
      // ── Self-Recovery API (for unattended operation) ──
      // ══════════════════════════════════════════════════════════════

      // POST /api/recovery/browser — Kill and restart the browser
      if (url.pathname === "/api/recovery/browser" && req.method === "POST") {
        if (!services.playwrightCli) {
          return Response.json({ error: "Playwright CLI not initialized" }, { status: 500, headers });
        }
        const result = await services.playwrightCli.resetBrowser();
        services.eventBus.emit("recovery.browser", result);
        return Response.json(result, { headers });
      }

      // POST /api/recovery/sidecar — REMOVED (Python sidecar eliminated)
      if (url.pathname === "/api/recovery/sidecar" && req.method === "POST") {
        return Response.json({
          success: true,
          detail: "Python sidecar removed in v2.6.0. NativeBridge handles input actions directly.",
        }, { headers });
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

      // ══════════════════════════════════════════════════════════════
      // ── Onboarding API ──
      // ══════════════════════════════════════════════════════════════

      // GET /api/onboarding/ready — Full readiness check for first-run experience
      // Returns a checklist of all prerequisites + a quickStart command.
      // Frontend shows "Ready" page when all required items pass.
      if (url.pathname === "/api/onboarding/ready" && req.method === "GET") {
        // ── Audio drivers ──
        let blackhole2ch = false;
        let blackhole16ch = false;
        let switchAudioSource = false;
        try {
          const audioDevices = await Bun.$`system_profiler SPAudioDataType 2>/dev/null`.text();
          blackhole2ch = audioDevices.includes("BlackHole 2ch");
          blackhole16ch = audioDevices.includes("BlackHole 16ch");
        } catch {}
        try {
          await Bun.$`which SwitchAudioSource`.quiet();
          switchAudioSource = true;
        } catch {}

        // ── macOS permissions (check via CLI probes) ──
        let screenRecording = false;
        try {
          // Screen capture test: mss/screencapture will fail without permission
          const result = await Bun.$`screencapture -x -t png /dev/null 2>&1`.quiet().nothrow();
          screenRecording = result.exitCode === 0;
        } catch {}

        let accessibility = false;
        try {
          const result = await Bun.$`osascript -e 'tell application "System Events" to return name of first process' 2>&1`.quiet().nothrow();
          accessibility = result.exitCode === 0;
        } catch {}

        // ── Services ──
        const sidecar = services.bridge.ready;
        const voiceKey = !!CONFIG.openai.apiKey;
        const computerKey = !!(CONFIG.anthropic.apiKey || CONFIG.openrouter.apiKey);
        const openclaw = services.openclawBridge?.connected ?? false;
        const browser = services.playwrightCli?.connected ?? false;

        // ── OpenClaw command file ──
        let openclawCommand = false;
        try {
          const cmdPath = `${process.env.HOME}/.claude/commands/callingclaw.md`;
          openclawCommand = await Bun.file(cmdPath).exists();
        } catch {}

        const checklist = {
          // Required for meeting audio (must all pass)
          blackhole2ch,
          blackhole16ch,
          switchAudioSource,
          // Required macOS permissions
          screenRecording,
          accessibility,
          // Services (runtime state)
          sidecar,
          browser,
          // API keys (at least voice key is needed)
          voiceKey,
          computerKey,
          // Optional but recommended
          openclaw,
          openclawCommand,
        };

        const requiredOk = blackhole2ch && blackhole16ch && switchAudioSource
          && screenRecording && accessibility && sidecar && voiceKey;

        return Response.json({
          ready: requiredOk,
          checklist,
          quickStart: requiredOk
            ? "/callingclaw join <your-meeting-url>"
            : null,
          hints: {
            ...(!blackhole2ch || !blackhole16ch ? {
              blackhole: "BlackHole audio driver not installed. Required for meeting audio bridging.",
            } : {}),
            ...(!switchAudioSource ? {
              switchAudioSource: "SwitchAudioSource not found. Install: brew install switchaudio-osx",
            } : {}),
            ...(!screenRecording ? {
              screenRecording: "Screen recording permission not granted. Open System Settings → Privacy → Screen Recording.",
            } : {}),
            ...(!accessibility ? {
              accessibility: "Accessibility permission not granted. Open System Settings → Privacy → Accessibility.",
            } : {}),
            ...(!voiceKey ? {
              voiceKey: "OpenAI API key not set. Required for voice AI in meetings.",
            } : {}),
            ...(!sidecar ? {
              sidecar: "Python sidecar not connected. Check python_sidecar/main.py is running.",
            } : {}),
          },
        }, { headers });
      }

      // GET /api/onboarding/permissions — Detailed macOS permission status
      // Frontend uses this to show permission checklist with action buttons.
      if (url.pathname === "/api/onboarding/permissions" && req.method === "GET") {
        // Screen Recording
        let screenRecording: { granted: boolean; canRequest: boolean } = { granted: false, canRequest: false };
        try {
          const result = await Bun.$`screencapture -x -t png /dev/null 2>&1`.quiet().nothrow();
          screenRecording = { granted: result.exitCode === 0, canRequest: false };
        } catch {}

        // Accessibility
        let accessibility: { granted: boolean; canRequest: boolean } = { granted: false, canRequest: false };
        try {
          const result = await Bun.$`osascript -e 'tell application "System Events" to return name of first process' 2>&1`.quiet().nothrow();
          accessibility = { granted: result.exitCode === 0, canRequest: false };
        } catch {}

        // Microphone (optional — only for direct mode, not needed for BlackHole)
        // Cannot be checked from Bun CLI; only Electron systemPreferences can detect this.
        // We report "not_applicable" in meeting mode.
        const audioMode = services.bridge.ready ? "meet_bridge" : "unknown";
        const microphone = {
          required: false,
          reason: "Not required for meeting mode (BlackHole virtual audio). Only needed for direct mic mode.",
          hint: audioMode === "meet_bridge" ? null : "Switch to direct mode in settings to enable.",
        };

        return Response.json({
          permissions: {
            screenRecording: {
              ...screenRecording,
              label: "Screen Recording",
              description: "Required for screen capture and meeting analysis",
              settingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
            },
            accessibility: {
              ...accessibility,
              label: "Accessibility",
              description: "Required for keyboard/mouse automation (PyAutoGUI)",
              settingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
            },
            microphone: {
              ...microphone,
              label: "Microphone",
              description: "Optional — only for direct voice mode (no meeting)",
              settingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
            },
          },
          allRequiredGranted: screenRecording.granted && accessibility.granted,
        }, { headers });
      }

      // POST /api/onboarding/permissions/open — Open macOS System Settings to a specific panel
      // Body: { "panel": "screenRecording" | "accessibility" | "microphone" }
      if (url.pathname === "/api/onboarding/permissions/open" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { panel?: string };
        const urls: Record<string, string> = {
          screenRecording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
          accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
          microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
          camera: "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
        };

        const settingsUrl = body.panel ? urls[body.panel] : null;
        if (!settingsUrl) {
          return Response.json(
            { error: "Invalid panel. Use: screenRecording, accessibility, microphone, camera" },
            { status: 400, headers }
          );
        }

        try {
          await Bun.$`open ${settingsUrl}`.quiet();
          return Response.json({ ok: true, panel: body.panel, url: settingsUrl }, { headers });
        } catch (e: any) {
          return Response.json({ ok: false, error: e.message }, { status: 500, headers });
        }
      }

      // GET /api/onboarding/audio — Check BlackHole + SwitchAudioSource status
      if (url.pathname === "/api/onboarding/audio" && req.method === "GET") {
        let devices: string[] = [];
        let blackhole2ch = false;
        let blackhole16ch = false;
        let switchAudioSource = false;
        let currentInput = "";
        let currentOutput = "";

        try {
          const raw = await Bun.$`system_profiler SPAudioDataType 2>/dev/null`.text();
          blackhole2ch = raw.includes("BlackHole 2ch");
          blackhole16ch = raw.includes("BlackHole 16ch");
        } catch {}

        try {
          await Bun.$`which SwitchAudioSource`.quiet();
          switchAudioSource = true;
          const all = await Bun.$`SwitchAudioSource -a`.text();
          devices = all.trim().split("\n").filter(Boolean);
          currentOutput = (await Bun.$`SwitchAudioSource -c`.text()).trim();
          currentInput = (await Bun.$`SwitchAudioSource -c -t input`.text()).trim();
        } catch {}

        const ready = blackhole2ch && blackhole16ch && switchAudioSource;

        return Response.json({
          ready,
          blackhole2ch,
          blackhole16ch,
          switchAudioSource,
          currentInput,
          currentOutput,
          devices,
          needsReboot: !blackhole2ch && !blackhole16ch, // If both missing after install, likely needs reboot
        }, { headers });
      }

      // ══════════════════════════════════════════════════════════════
      // ── Calendar API ──
      // ══════════════════════════════════════════════════════════════

      // GET /api/calendar/events — List upcoming events with prep brief enrichment
      if (url.pathname === "/api/calendar/events" && req.method === "GET") {
        const connected = services.calendar.connected;
        const events = await services.calendar.listUpcomingEvents();

        // Enrich events with prep brief status from sessions.json
        let enriched = events;
        try {
          const { readSessions } = await import("./modules/shared-documents");
          const sessions = readSessions().sessions || [];
          enriched = events.map((e: any) => {
            const titleLower = (e.summary || "").toLowerCase();
            let _prepBrief: string | null = null;
            // Find the matching session that HAS a prep file (skip sessions with only live/summary)
            for (const s of sessions) {
              const sTopic = (s.topic || "").toLowerCase();
              if (sTopic && (titleLower.includes(sTopic) || sTopic.includes(titleLower))) {
                if (s.files?.prep) {
                  _prepBrief = s.files.prep;
                  break; // Found a match WITH prep — use it
                }
                // Topic matches but no prep — keep looking for one that has it
              }
            }
            return { ...e, _prepBrief };
          });
        } catch {}

        return Response.json({ events: enriched, connected }, { headers });
      }

      // POST /api/calendar/create — Create calendar event
      if (url.pathname === "/api/calendar/create" && req.method === "POST") {
        const body = await req.json();
        // Auto-add user email as attendee if configured
        if (CONFIG.userEmail) {
          const existing = (body.attendees || []).map((a: any) => (typeof a === "string" ? a : a.email));
          if (!existing.includes(CONFIG.userEmail)) {
            body.attendees = [...(body.attendees || []), { email: CONFIG.userEmail }];
          }
        }
        const raw = await services.calendar.createEvent(body);
        let result: any;
        try { result = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { result = raw; }
        return Response.json(result, { headers });
      }

      // ══════════════════════════════════════════════════════════════
      // ── Meeting Notes API ──
      // ══════════════════════════════════════════════════════════════

      // GET /api/meeting/status — Get current meeting recording status
      if (url.pathname === "/api/meeting/status" && req.method === "GET") {
        return Response.json(services.meeting.getNotes(), { headers });
      }

      // POST /api/meeting/start — Start meeting recording
      if (url.pathname === "/api/meeting/start" && req.method === "POST") {
        services.meeting.startRecording();
        services.eventBus.emit("meeting.started", {});
        return Response.json({ ok: true, status: "recording" }, { headers });
      }

      // POST /api/meeting/stop — Stop meeting recording
      if (url.pathname === "/api/meeting/stop" && req.method === "POST") {
        services.meeting.stopRecording();
        services.eventBus.emit("meeting.stopped", {});
        return Response.json({ ok: true, status: "stopped" }, { headers });
      }

      // GET /api/meeting/transcript — Get current transcript
      if (url.pathname === "/api/meeting/transcript" && req.method === "GET") {
        const count = parseInt(url.searchParams.get("count") || "50");
        return Response.json(
          {
            entries: services.context.getRecentTranscript(count),
            text: services.context.getTranscriptText(count),
            total: services.context.transcript.length,
          },
          { headers }
        );
      }

      // POST /api/meeting/summary — Generate meeting summary
      if (url.pathname === "/api/meeting/summary" && req.method === "POST") {
        const summary = await services.meeting.generateSummary();
        return Response.json(summary, { headers });
      }

      // POST /api/meeting/export — Export meeting notes to markdown file
      if (url.pathname === "/api/meeting/export" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { filename?: string };
        const summary = await services.meeting.generateSummary();
        const filepath = await services.meeting.exportToMarkdown(summary, body.filename);

        // Auto-create tasks from action items
        if (summary.actionItems && summary.actionItems.length > 0) {
          services.taskStore.createFromMeetingItems(
            summary.actionItems.map((a) => ({
              task: a.task,
              assignee: a.assignee,
              deadline: a.deadline,
            })),
            services.eventBus.correlationId || undefined
          );
        }

        services.eventBus.emit("meeting.ended", {
          filepath,
          summary,
          taskCount: summary.actionItems?.length || 0,
        });

        return Response.json({ ok: true, filepath, summary }, { headers });
      }

      // GET /api/meeting/notes — List saved meeting note files
      if (url.pathname === "/api/meeting/notes" && req.method === "GET") {
        const files = await services.meeting.listSavedNotes();
        return Response.json({ files }, { headers });
      }

      // GET /api/meeting/notes/:filename — Read a specific meeting note file
      if (url.pathname.startsWith("/api/meeting/notes/") && req.method === "GET") {
        const filename = decodeURIComponent(url.pathname.replace("/api/meeting/notes/", ""));
        try {
          const content = await services.meeting.readNoteFile(filename);
          return Response.json({ filename, content }, { headers });
        } catch {
          return Response.json({ error: "Note file not found" }, { status: 404, headers });
        }
      }

      // ══════════════════════════════════════════════════════════════
      // ── Join Meeting API ──
      // ══════════════════════════════════════════════════════════════

      // POST /api/meeting/join — Join a meeting by URL (Google Meet or Zoom)
      // Integrated flow: start Voice AI → join meeting → bridge audio
      if (url.pathname === "/api/meeting/join" && req.method === "POST") {
        const body = (await req.json()) as { url: string; instructions?: string };
        if (!body.url) {
          return Response.json({ error: "url is required" }, { status: 400, headers });
        }

        const validated = validateMeetingUrl(body.url);
        if (!validated) {
          return Response.json({
            error: "Invalid meeting URL",
            hint: "Supported formats: https://meet.google.com/xxx-xxxx-xxx or https://zoom.us/j/123456789",
          }, { status: 400, headers });
        }

        // Generate stable meetingId for session tracking
        const { generateMeetingId: genId, upsertSession: upsertSess } = await import("./modules/shared-documents");
        const meetingId = genId();
        upsertSess({ meetingId, topic: body.instructions?.slice(0, 200) || "Meeting", meetUrl: validated.url, status: "active" });

        // Step 1: Start OpenAI Realtime voice session (if not already running)
        let voiceStarted = false;
        if (!services.realtime.connected && CONFIG.openai.apiKey) {
          try {
            const instructions = body.instructions || undefined;
            await services.realtime.start(instructions);
            voiceStarted = true;
            console.log("[Meeting] Voice AI started for meeting");
          } catch (e: any) {
            console.warn("[Meeting] Voice start failed:", e.message);
          }
        } else if (services.realtime.connected) {
          voiceStarted = true;
        }

        // Look up calendar event to get attendees
        let meetAttendees: any[] = [];
        let calEvent: any = null;
        if (services.calendar?.connected) {
          try {
            calEvent = await services.calendar.findEventByMeetUrl(validated.url);
            if (calEvent?.attendees) meetAttendees = calEvent.attendees;
          } catch {}
        }

        // Generate meeting prep brief via OpenClaw (best-effort, non-blocking join)
        const meetTopic = calEvent?.summary || body.instructions?.slice(0, 200) || services.context.workspace?.topic || "Meeting";
        let prepBrief: any = null;
        if (services.meetingPrepSkill && services.openclawBridge?.connected) {
          try {
            const prepResult = await prepareMeeting(services.meetingPrepSkill, meetTopic, undefined, meetAttendees, meetingId);
            prepBrief = prepResult.brief;
            if (services.realtime.connected) {
              // Layer 2: inject meeting brief via conversation.item.create
              injectMeetingBrief(services.realtime, prepResult.brief);
              console.log("[Meeting] Layer 2 meeting brief injected");
            }
          } catch (e: any) {
            console.warn("[Meeting] Prep brief failed (continuing without):", e.message);
          }
        }

        // Step 2: Configure audio + screen capture mode BEFORE joining
        // Screen capture: lock to the meeting app's display (Chrome for Meet, Zoom for Zoom)
        const meetingApp = validated.platform === "zoom" ? "zoom.us" : "Google Chrome";
        const audioConfigOk = await services.bridge.sendConfigAndVerify(
          {
            audio_mode: "meet_bridge", capture_system_audio: true, virtual_mic_output: true,
            capture_mode: "meeting_app", meeting_app: meetingApp,
          },
          { timeoutMs: 3000, retries: 3 }
        );
        if (audioConfigOk) {
          console.log(`[Meeting] ✅ Audio bridge confirmed: meet_bridge, screen locked to ${meetingApp}`);
        } else {
          console.error("[Meeting] ⚠️ Audio bridge config NOT confirmed — voice may not work!");
          // Continue anyway (meeting join still useful for screen capture / notes)
        }

        services.eventBus.emit("meeting.joining", {
          url: validated.url,
          platform: validated.platform,
        });

        // Step 3: Join the meeting
        // Primary: Playwright fast-join (deterministic JS eval, no AI model)
        // Fallback: MeetJoiner (osascript, legacy)
        let joinSuccess = false;
        let joinState: "in_meeting" | "waiting_room" | "failed" = "failed";
        let joinSummary = "";
        let joinMethod = "meetjoiner";

        // Ensure Playwright is started (lazy init — may not be connected yet)
        if (services.playwrightCli && !services.playwrightCli.connected) {
          try { await services.playwrightCli.start(); } catch (e: any) {
            console.warn("[Meeting] Playwright start failed:", e.message);
          }
        }

        if (services.playwrightCli?.connected && validated.platform === "google_meet") {
          console.log("[Meeting] Using Playwright fast-join (deterministic path)...");
          joinMethod = "playwright_eval";
          const result = await services.playwrightCli.joinGoogleMeet(validated.url, {
            muteCamera: true,
            muteMic: false, // Mic ON for BlackHole bridge
            micDevice: "BlackHole 16ch",
            speakerDevice: "BlackHole 2ch",
            onStep: (step) => services.eventBus.emit("meeting.join_step", { step }),
          });
          joinSuccess = result.success;
          joinState = result.state;
          joinSummary = result.summary;
        } else {
          // Fallback: osascript MeetJoiner
          console.log("[Meeting] Using MeetJoiner (osascript fallback)...");
          const session = await services.meetJoiner.joinMeeting({
            meetUrl: validated.url,
            muteCamera: true,
            muteMic: false, // Mic must stay ON for BlackHole audio bridge
          });
          joinSuccess = session.status === "in_meeting";
          joinState = joinSuccess ? "in_meeting" : "failed";
          joinSummary = joinSuccess ? "Joined via MeetJoiner" : (session.error || "Unknown error");
        }

        // Only emit meeting.started when ACTUALLY in the meeting (not waiting_room)
        const emitMeetingStarted = () => {
          services.meeting.startRecording();
          services.eventBus.startCorrelation("mtg");
          services.eventBus.emit("meeting.started", {
            url: validated.url,
            platform: validated.platform,
            meetingId,
          });
          services.eventBus.emit("voice.started", { audio_mode: "meet_bridge" });
          console.log("[Meeting] meeting.started emitted — now in meeting");

          // Auto-greeting: AI speaks first to confirm audio pipeline is working
          if (services.realtime.connected) {
            setTimeout(() => {
              const greeting = prepBrief
                ? "大家好，我是 CallingClaw 会议助手，已准备好参与会议。"
                : "Hello, CallingClaw meeting assistant is ready.";
              services.realtime.sendText(greeting);
              console.log("[Meeting] Auto-greeting sent to verify audio pipeline");
            }, 2000); // Wait 2s for audio bridge to fully initialize
          }
        };

        if (joinState === "in_meeting") {
          emitMeetingStarted();
        }

        // If stuck in waiting_room, keep polling in background until admitted (up to 5 min)
        // This runs AFTER the HTTP response is sent — non-blocking
        if (joinState === "waiting_room" && services.playwrightCli?.connected) {
          console.log("[Meeting] In waiting room — background poll until admitted (max 5min)...");
          (async () => {
            for (let i = 0; i < 60; i++) { // 60 × 5s = 5 minutes
              await new Promise(r => setTimeout(r, 5000));
              try {
                const check = await services.playwrightCli!.evaluate(`() => {
                  const leave = document.querySelector('[aria-label*="Leave call"], [aria-label*="退出通话"]');
                  const controls = document.querySelector('[aria-label="Call controls"]');
                  if (leave || controls) return 'in_meeting';
                  const text = document.body.innerText;
                  if (text.includes('removed') || text.includes('kicked') || text.includes('denied')) return 'rejected';
                  return 'waiting';
                }`);
                if (check.includes("in_meeting")) {
                  console.log("[Meeting] Admitted from waiting room! Triggering meeting.started...");
                  emitMeetingStarted();
                  break;
                }
                if (check.includes("rejected")) {
                  console.log("[Meeting] Rejected from waiting room");
                  break;
                }
              } catch {
                // Page might be transitioning
              }
            }
          })();
        }

        // Start admission monitor regardless (in_meeting or waiting_room)
        // — monitors OTHER participants asking to join
        if ((joinState === "in_meeting" || joinState === "waiting_room") && services.playwrightCli?.connected) {
          const names = meetAttendees.filter((a: any) => !a.self).map((a: any) => a.displayName || a.email);
          services.playwrightCli.startAdmissionMonitor(
            names,
            3000,
            async (instruction: string) => {
              await services.automationRouter.execute(instruction);
            },
          );
          console.log(`[Meeting] Admission monitor started (${names.length} attendees)`);
        }

        // ── Pre-meeting agenda: emit for user confirmation ──
        const agenda = {
          meetUrl: validated.url,
          platform: validated.platform,
          topic: body.instructions?.slice(0, 200) || "Meeting",
          joinedAt: Date.now(),
          workspace: services.context.workspace || null,
        };
        services.eventBus.emit("meeting.agenda", agenda);

        const attendeeNames = meetAttendees.filter((a: any) => !a.self).map((a: any) => a.displayName || a.email);

        return Response.json({
          meetingId,
          status: joinState,
          success: joinSuccess,
          joinSummary,
          method: joinMethod,
          validated,
          voice: voiceStarted ? "connected" : "failed",
          audio_mode: "meet_bridge",
          attendees: attendeeNames.length > 0 ? attendeeNames.join(", ") : null,
          admissionMonitor: (joinState === "in_meeting" || joinState === "waiting_room") && services.playwrightCli?.connected
            ? `active (${attendeeNames.length} attendees, 3s interval)` : null,
          prepBrief: prepBrief ? {
            topic: prepBrief.topic,
            keyPoints: prepBrief.keyPoints?.length || 0,
            attendees: meetAttendees.length,
          } : null,
          agenda,
        }, { headers });
      }

      // POST /api/meeting/join-browser — Join meeting via Playwright CLI
      // Google Meet: fast deterministic JS eval (no model needed)
      // Zoom: model-driven BrowserActionLoop (fallback)
      if (url.pathname === "/api/meeting/join-browser" && req.method === "POST") {
        const body = (await req.json()) as { url: string; displayName?: string };
        if (!body.url) {
          return Response.json({ error: "url is required" }, { status: 400, headers });
        }

        const validated = validateMeetingUrl(body.url);
        if (!validated) {
          return Response.json({
            error: "Invalid meeting URL",
            hint: "Supported formats: https://meet.google.com/xxx-xxxx-xxx or https://zoom.us/j/123456789",
          }, { status: 400, headers });
        }

        const displayName = body.displayName || "CallingClaw";
        const platform = validated.platform;

        // Google Meet: use deterministic JS eval (fast, reliable, no model calls)
        if (platform === "google_meet" && services.playwrightCli) {
          services.eventBus.emit("meeting.joining", {
            url: validated.url,
            platform,
            method: "playwright_eval",
          });

          const result = await services.playwrightCli.joinGoogleMeet(validated.url, {
            displayName,
            muteCamera: true,    // Camera OFF
            muteMic: false,      // Mic ON — needed for BlackHole audio bridge
            micDevice: "BlackHole 16ch",
            speakerDevice: "BlackHole 2ch",
            onStep: (step) => services.eventBus.emit("browser_loop.step", { step, method: "eval" }),
          });

          return Response.json({
            ...result,
            validated,
            method: "playwright_eval",
          }, { headers });
        }

        // Zoom / unknown: use model-driven BrowserActionLoop
        if (!services.browserLoop) {
          return Response.json({ error: "Browser action loop not initialized" }, { status: 500, headers });
        }

        const zoomGoal = `Join the Zoom meeting at ${validated.url}.

STEP-BY-STEP FLOW:
1. Navigate to the URL.
2. If any dialog appears, dismiss it first (press Escape or click dismiss).
3. If prompted to "Open Zoom" or "Launch Meeting", click it.
4. If there is a name field, enter "${displayName}".
5. Click Join.
6. Wait until you see the meeting view (participant grid, controls). Report done only when actually in the meeting.`;

        const result = await services.browserLoop.run(zoomGoal, {
          maxSteps: 25,
          timeoutMs: 180_000,
          context: `Platform: ${platform}\nURL: ${validated.url}\nDisplay name: ${displayName}`,
        });

        return Response.json({
          ...result,
          validated,
          method: "browser_action_loop",
        }, { headers });
      }

      // POST /api/meeting/join-browser/abort — Abort a running Browser Action Loop
      if (url.pathname === "/api/meeting/join-browser/abort" && req.method === "POST") {
        if (services.browserLoop?.running) {
          services.browserLoop.abort();
          return Response.json({ aborted: true }, { headers });
        }
        return Response.json({ aborted: false, reason: "No browser loop running" }, { headers });
      }

      // POST /api/meeting/delegate — Delegate meeting creation to OpenClaw (agent-first pattern)
      // Desktop sends topic → CallingClaw relays to OpenClaw → OpenClaw uses /callingclaw skill
      // All progress comes back via EventBus → WebSocket → Desktop side panel
      if (url.pathname === "/api/meeting/delegate" && req.method === "POST") {
        const body = (await req.json()) as { topic: string };
        if (!body.topic) {
          return Response.json({ error: "topic is required" }, { status: 400, headers });
        }
        if (!services.openclawBridge?.connected) {
          return Response.json({ error: "OpenClaw not connected" }, { status: 503, headers });
        }

        const { generateMeetingId, upsertSession } = await import("./modules/shared-documents");
        const meetingId = generateMeetingId();
        // Store raw topic initially, will update with extracted title after LLM call
        upsertSession({ meetingId, topic: body.topic, status: "preparing" });

        services.eventBus.emit("meeting.prep_progress", {
          meetingId, step: "delegating", message: "正在委托 OpenClaw 处理...",
        });

        // Fire-and-forget: CallingClaw creates calendar, OpenClaw does research only
        // IMPORTANT: Calendar creation is handled HERE (not by OpenClaw) to prevent
        // duplicate events.
        (async () => {
          try {
            // ── Step 0: Extract title + time from user input using fast LLM ──
            let title = body.topic.length > 60 ? body.topic.slice(0, 57) + "..." : body.topic;
            let parsedStart: string | null = null;
            let parsedDuration = 60; // minutes

            if (CONFIG.openrouter.apiKey) {
              try {
                const now = new Date();
                const tzOffset = now.toLocaleString("en-US", { timeZoneName: "short" }).split(" ").pop();
                const llmResp = await fetch(`${CONFIG.openrouter.baseUrl}/chat/completions`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${CONFIG.openrouter.apiKey}`,
                  },
                  body: JSON.stringify({
                    model: CONFIG.analysis?.model || "anthropic/claude-haiku-4-5",
                    messages: [{
                      role: "user",
                      content: `Extract meeting info from this user input. Current time: ${now.toISOString()} (${tzOffset})\n\nInput: "${body.topic}"\n\nRespond with ONLY JSON, no explanation:\n{"title": "concise meeting title in same language as input (max 40 chars)", "startTime": "ISO 8601 datetime or null if not mentioned", "duration": minutes_number_or_60}`
                    }],
                    max_tokens: 100,
                    temperature: 0,
                  }),
                  signal: AbortSignal.timeout(5000),
                });
                const llmData = await llmResp.json() as any;
                const content = llmData.choices?.[0]?.message?.content || "";
                const jsonMatch = content.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                  const parsed = JSON.parse(jsonMatch[0]);
                  if (parsed.title) title = parsed.title;
                  if (parsed.startTime) parsedStart = parsed.startTime;
                  if (parsed.duration) parsedDuration = parsed.duration;
                  console.log(`[Delegate] LLM extracted: title="${title}", start=${parsedStart}, duration=${parsedDuration}min`);
                }
              } catch (e: any) {
                console.warn("[Delegate] LLM title/time extraction failed, using fallback:", e.message);
              }
            }

            // ── Step 1: Create calendar event ──
            let meetUrl: string | null = null;
            let calEventId: string | null = null;

            if (services.calendar.connected) {
              services.eventBus.emit("meeting.prep_progress", {
                meetingId, step: "creating_calendar", message: "正在创建日历和会议链接...",
              });

              // Use LLM-parsed time, or fallback to next half-hour
              let startTime: string;
              let endTime: string;
              if (parsedStart) {
                const start = new Date(parsedStart);
                startTime = start.toISOString();
                endTime = new Date(start.getTime() + parsedDuration * 60000).toISOString();
              } else {
                const now = new Date();
                const mins = now.getMinutes();
                const fallback = new Date(now);
                fallback.setMinutes(mins < 30 ? 30 : 60, 0, 0);
                if (fallback.getTime() - now.getTime() < 10 * 60000) {
                  fallback.setTime(fallback.getTime() + 30 * 60000);
                }
                startTime = fallback.toISOString();
                endTime = new Date(fallback.getTime() + 60 * 60000).toISOString();
              }

              const attendees = CONFIG.userEmail ? [{ email: CONFIG.userEmail }] : [];
              const calResult = await services.calendar.createEvent({
                summary: title,
                start: startTime,
                end: endTime,
                attendees,
              });
              let calEvent: any;
              try { calEvent = typeof calResult === "string" ? JSON.parse(calResult) : calResult; } catch { calEvent = {}; }
              meetUrl = calEvent.meetLink || calEvent.hangoutLink || null;
              calEventId = calEvent.id || null;

              services.eventBus.emit("meeting.prep_progress", {
                meetingId, step: "calendar_ready",
                title, meetUrl, calendarEventId: calEventId, startTime, endTime,
                message: `日历已创建 — Meet: ${meetUrl || '无链接'}`,
              });
            } else {
              const reason = services.calendar.authError
                ? `Google OAuth 已过期`
                : "Google 日历未连接";
              services.eventBus.emit("meeting.prep_progress", {
                meetingId, step: "calendar_skipped",
                message: `⚠️ 跳过日历创建 — ${reason}`,
              });
            }

            // ── Step 2: Delegate RESEARCH ONLY to OpenClaw (no calendar creation!) ──
            const taskPrompt = [
              `用户想要准备一个会议，话题是: "${body.topic}"`,
              `会议ID（meetingId）: ${meetingId}`,
              meetUrl ? `Meet 链接（已创建，不要再创建日历！）: ${meetUrl}` : `（日历未创建，跳过）`,
              ``,
              `## 重要：不要创建日历事件！日历已由 CallingClaw 创建完毕。`,
              `## 也不要调用 /callingclaw prepare — 会导致重复创建日历。`,
              ``,
              `请完成以下步骤:`,
              ``,
              `## Step 1: 深度调研`,
              `用你的完整能力（MEMORY.md + 项目文件 + git 历史）做深度会前调研。`,
              ``,
              `## Step 2: 写入 Markdown 到共享目录（必须！）`,
              `文件路径: ~/.callingclaw/shared/${meetingId}_prep.md`,
              `注意: meetingId 已经生成好了，就是 ${meetingId}，请直接使用这个 ID！`,
              ``,
              `Markdown 自由格式，建议包含:`,
              `# 标题, 目标, 概要, 要点, 架构决策, 预期问题, 历史背景, 相关文件和链接`,
              ``,
              `## Step 3: 通知 CallingClaw 渲染`,
              `\`\`\`bash`,
              `curl -X POST http://localhost:4000/api/meeting/prep-result \\`,
              `  -H "Content-Type: application/json" \\`,
              `  -d '{"topic":"${title.replace(/'/g, "\\'")}","meetingId":"${meetingId}"${meetUrl ? `,"meetUrl":"${meetUrl}"` : ""}}'`,
              `\`\`\``,
              `CallingClaw 自动读取 ~/.callingclaw/shared/${meetingId}_prep.md 并渲染。`,
              `**不写文件 + 不调 API = Desktop 看不到！**`,
            ].join("\n");

            await services.openclawBridge.sendTask(taskPrompt);
          } catch (e: any) {
            services.eventBus.emit("meeting.prep_progress", {
              meetingId, step: "error", message: `OpenClaw 处理失败: ${e.message}`,
            });
          }
        })();

        return Response.json({ ok: true, meetingId, topic: body.topic, delegatedTo: "openclaw" }, { headers });
      }

      // POST /api/meeting/prep-result — OpenClaw notifies "prep file is ready"
      // OpenClaw wrote {meetingId}_prep.md to ~/.callingclaw/shared/
      // This endpoint tells Desktop which meetingId to render
      if (url.pathname === "/api/meeting/prep-result" && req.method === "POST") {
        const body = await req.json() as { topic: string; meetingId?: string; filePath?: string; meetUrl?: string; calendarEventId?: string };
        if (!body.topic) {
          return Response.json({ error: "topic is required" }, { status: 400, headers });
        }

        const { getMeetingFilePath, upsertSession, generateMeetingId, SHARED_DIR: SD } = await import("./modules/shared-documents");

        // meetingId must be provided (generated by /api/meeting/delegate)
        const meetingId = body.meetingId || generateMeetingId();

        // Resolve file path — by convention: {meetingId}_prep.md
        let filePath = body.filePath || getMeetingFilePath(meetingId, "prep");
        if (filePath.startsWith("~")) filePath = filePath.replace("~", process.env.HOME || "");

        // Read the markdown content
        let mdContent = "";
        try { mdContent = await Bun.file(filePath).text(); } catch {
          // Try the path OpenClaw might have used
          try { mdContent = await Bun.file(resolve(SHARED_DIR, meetingId + "_prep.md")).text(); } catch {}
        }

        // Update sessions index
        upsertSession({
          meetingId,
          topic: body.topic,
          meetUrl: body.meetUrl,
          calendarEventId: body.calendarEventId,
          status: "ready",
          files: { prep: meetingId + "_prep.md" },
        });

        // Emit event — Desktop renders markdown directly
        services.eventBus.emit("meeting.prep_ready", {
          topic: body.topic,
          title: body.topic,
          meetingId,
          meetUrl: body.meetUrl || null,
          calendarEventId: body.calendarEventId || null,
          filePath,
          mdContent, // Desktop can render directly without another file read
        });

        console.log(`[PrepResult] File ready: "${body.topic}" → ${filePath}`);
        return Response.json({ ok: true, filePath, contentLength: mdContent.length }, { headers });
      }

      // POST /api/meeting/prepare — Direct meeting creation (fallback if OpenClaw unavailable)
      // Returns: meeting prep brief + agenda items that user can review before joining
      if (url.pathname === "/api/meeting/prepare" && req.method === "POST") {
        const body = (await req.json()) as {
          topic: string;
          url?: string;
          context?: string;
          attendees?: string[];       // email addresses
          duration_minutes?: number;  // default 30
          start_time?: string;        // ISO string — when to schedule
        };
        if (!body.topic) {
          return Response.json({ error: "topic is required" }, { status: 400, headers });
        }

        // ── INSTANT RESPONSE — all AI work async via EventBus ──
        // Desktop gets response in <1s. OpenClaw handles everything in background.
        // Each step emits progress events → Desktop shows real-time log in side panel.

        const prepId = `prep_${Date.now()}`;
        const { generateMeetingId: genPrepId } = await import("./modules/shared-documents");
        const prepMeetingId = genPrepId();

        // Return immediately with just the topic
        const agenda = {
          prepId,
          meetingId: prepMeetingId,
          topic: body.topic,
          title: body.topic.length > 60 ? body.topic.slice(0, 57) + "..." : body.topic,
          meetUrl: body.url || null,
          calendarEventId: null as string | null,
          startTime: body.start_time || null,
          endTime: null as string | null,
          generatedAt: Date.now(),
          prepStatus: "processing",
          prepBrief: null,
        };

        services.eventBus.emit("meeting.agenda", agenda);

        // ── Background pipeline: title → time → calendar → deep research ──
        // Every step emits "meeting.prep_progress" so Desktop can show live log
        if (services.openclawBridge?.connected) {
          (async () => {
            const emit = (step: string, data?: any) => {
              services.eventBus.emit("meeting.prep_progress", { prepId, step, ...data });
              console.log(`[MeetingPrepare] ${step}`);
            };

            let title = agenda.title;
            let meetUrl = body.url || null;
            let startTime: string | null = body.start_time || null;
            let endTime: string | null = null;
            let calEventId: string | null = null;
            let meetAttendees: any[] = [];

            try {
              // Step 1+2: Extract title + time via fast Haiku call (NOT OpenClaw — too slow + expensive)
              emit("generating_title", { message: "正在解析会议信息..." });
              if (CONFIG.openrouter.apiKey && (body.topic.length > 15 || !startTime)) {
                try {
                  const now = new Date();
                  const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone;
                  const llmResp = await fetch(`${CONFIG.openrouter.baseUrl}/chat/completions`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${CONFIG.openrouter.apiKey}` },
                    body: JSON.stringify({
                      model: CONFIG.analysis?.model || "anthropic/claude-haiku-4-5",
                      messages: [{ role: "user", content: `Extract meeting info. Current: ${now.toISOString()} (${tzName})\nInput: "${body.topic}"\nJSON only: {"title":"concise title same language max 40 chars","startTime":"ISO8601 or null","duration":minutes_or_60}` }],
                      max_tokens: 100, temperature: 0,
                    }),
                    signal: AbortSignal.timeout(5000),
                  });
                  const llmData = await llmResp.json() as any;
                  const content = llmData.choices?.[0]?.message?.content || "";
                  const jsonMatch = content.match(/\{[\s\S]*\}/);
                  if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    if (parsed.title && body.topic.length > 15) title = parsed.title;
                    if (parsed.startTime && !startTime) startTime = new Date(parsed.startTime).toISOString();
                    if (parsed.duration) endTime = new Date(new Date(startTime || now.toISOString()).getTime() + parsed.duration * 60000).toISOString();
                    console.log(`[Prepare] LLM: title="${title}", start=${startTime}`);
                  }
                } catch (e: any) {
                  console.warn("[Prepare] LLM extraction failed:", e.message);
                }
              }
              emit("title_ready", { title, message: `标题: ${title}` });
              if (!startTime) {
                const now = new Date();
                const mins = now.getMinutes();
                const fallback = new Date(now);
                fallback.setMinutes(mins < 30 ? 30 : 60, 0, 0);
                if (fallback.getTime() - now.getTime() < 10 * 60000) {
                  fallback.setTime(fallback.getTime() + 30 * 60000);
                }
                startTime = fallback.toISOString();
              }
              if (!endTime) {
                const duration = (body.duration_minutes || 60) * 60000;
                endTime = new Date(new Date(startTime).getTime() + duration).toISOString();
              }
              emit("time_ready", { startTime, endTime, message: `时间: ${new Date(startTime).toLocaleTimeString('zh-CN')}` });

              // Step 3: Create Google Calendar
              if (services.calendar.connected) {
                emit("creating_calendar", { message: "正在创建日历和会议链接..." });
                const prepAttendees = (body.attendees || []).map((e: string) => ({ email: e }));
                if (CONFIG.userEmail && !prepAttendees.some((a: any) => a.email === CONFIG.userEmail)) {
                  prepAttendees.push({ email: CONFIG.userEmail });
                }
                const calResult = await services.calendar.createEvent({
                  summary: title,
                  start: startTime!,
                  end: endTime || new Date(new Date(startTime!).getTime() + 30*60000).toISOString(),
                  attendees: prepAttendees,
                });
                let calEvent: any;
                try { calEvent = typeof calResult === "string" ? JSON.parse(calResult) : calResult; } catch { calEvent = {}; }
                meetUrl = calEvent.meetLink || calEvent.hangoutLink || meetUrl;
                calEventId = calEvent.id || null;
                meetAttendees = calEvent.attendees || prepAttendees;
                emit("calendar_ready", { title, meetUrl, calendarEventId: calEventId, startTime, endTime, message: `日历已创建 — Meet: ${meetUrl || '无链接'}` });
              }

              // Step 4: Deep research (meeting prep)
              if (services.meetingPrepSkill) {
                emit("researching", { message: "OpenClaw 正在深度调研..." });
                const prepResult = await prepareMeeting(
                  services.meetingPrepSkill, body.topic, body.context, meetAttendees, prepMeetingId
                );
                const prepBriefData = {
                  topic: prepResult.brief.topic || title,
                  goal: prepResult.brief.goal,
                  summary: prepResult.brief.summary,
                  keyPoints: prepResult.brief.keyPoints,
                  architectureDecisions: prepResult.brief.architectureDecisions,
                  expectedQuestions: prepResult.brief.expectedQuestions,
                  filePaths: prepResult.brief.filePaths,
                  browserUrls: prepResult.brief.browserUrls,
                  previousContext: prepResult.brief.previousContext,
                };
                emit("research_complete", {
                  message: `调研完成 — ${prepBriefData.keyPoints?.length || 0} 要点, ${prepBriefData.filePaths?.length || 0} 文件`,
                });

                services.eventBus.emit("meeting.prep_ready", {
                  prepId, topic: body.topic, title, meetUrl, calendarEventId: calEventId,
                  startTime, endTime, prepBrief: prepBriefData,
                });
              }
            } catch (e: any) {
              emit("error", { message: `失败: ${e.message}` });
              services.eventBus.emit("meeting.prep_ready", {
                prepId, topic: body.topic, prepBrief: null, error: e.message,
              });
            }
          })();
        }

        return Response.json(agenda, { headers });
      }

      // GET /api/meeting/prep-brief — Get current meeting prep brief (if generated)
      if (url.pathname === "/api/meeting/prep-brief" && req.method === "GET") {
        // Return the current workspace context and ContextSync brief
        const workspace = services.context.workspace;
        const syncBrief = services.contextSync?.getBrief();

        // Also list persisted prep briefs from shared directory
        let persistedPreps: string[] = [];
        try { persistedPreps = await listPrepFiles(); } catch {}

        return Response.json({
          workspace: workspace || null,
          voiceBrief: syncBrief?.voice || null,
          computerBrief: syncBrief?.computer || null,
          voiceBriefChars: syncBrief?.voice?.length || 0,
          computerBriefChars: syncBrief?.computer?.length || 0,
          pinnedFiles: services.contextSync?.getPinnedFiles() || [],
          persistedPreps,
          sharedPrepDir: SHARED_PREP_DIR,
        }, { headers });
      }

      // POST /api/meeting/validate — Validate a meeting URL without joining
      if (url.pathname === "/api/meeting/validate" && req.method === "POST") {
        const body = (await req.json()) as { url: string };
        const validated = validateMeetingUrl(body.url || "");
        return Response.json({
          valid: !!validated,
          ...(validated || {}),
        }, { headers });
      }

      // POST /api/meeting/leave — Leave current meeting + generate follow-up report
      if (url.pathname === "/api/meeting/leave" && req.method === "POST") {
        // Stop admission monitor if running
        if (services.playwrightCli?.isAdmissionMonitoring) {
          services.playwrightCli.stopAdmissionMonitor();
        }
        const summary = await services.meeting.generateSummary();
        const filepath = await services.meeting.exportToMarkdown(summary);
        services.meeting.stopRecording();
        await services.meetJoiner.leaveMeeting();

        let createdTasks: any[] = [];
        if (summary.actionItems && summary.actionItems.length > 0) {
          createdTasks = services.taskStore.createFromMeetingItems(
            summary.actionItems.map((a) => ({
              task: a.task,
              assignee: a.assignee,
              deadline: a.deadline,
            })),
            services.eventBus.correlationId || undefined
          );
        }

        // Build structured follow-up report
        const followUp = {
          filepath,
          summary,
          tasks: createdTasks.map((t: any) => ({
            id: t.id,
            task: t.task,
            assignee: t.assignee,
            deadline: t.deadline,
            status: t.status,
          })),
          pendingConfirmation: true,
          generatedAt: Date.now(),
        };

        services.eventBus.emit("meeting.ended", followUp);
        services.eventBus.endCorrelation();

        // Trigger smart todo delivery (non-blocking)
        if (services.postMeetingDelivery) {
          services.postMeetingDelivery.deliver({
            summary,
            notesFilePath: filepath,
            prepSummary: services.meetingPrepSkill?.currentBrief ? {
              topic: services.meetingPrepSkill.currentBrief.topic,
              liveNotes: services.meetingPrepSkill.currentBrief.liveNotes || [],
              completedTasks: (services.meetingPrepSkill.currentBrief.liveNotes || []).filter((n: string) => n.startsWith("[DONE]")),
              requirements: (services.meetingPrepSkill.currentBrief.liveNotes || []).filter((n: string) => n.startsWith("[REQ]")),
            } : null,
          }).catch((e: any) => console.error("[Meeting/Leave] PostMeetingDelivery failed:", e.message));
        }

        return Response.json({ ok: true, ...followUp }, { headers });
      }

      // ══════════════════════════════════════════════════════════════
      // ── Talk Locally API ──
      // Same meeting intelligence as Join Meeting, but without Chrome/Meet
      // Audio: direct mic/speaker. Adds browser DOM context capture.
      // ══════════════════════════════════════════════════════════════

      // POST /api/meeting/talk-locally — Start a local meeting session
      // Full meeting stack: voice + transcript + auditor + vision + DOM context
      if (url.pathname === "/api/meeting/talk-locally" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { topic?: string };
        const topic = body.topic || "Local Conversation";

        // Generate stable meetingId for session tracking
        const { generateMeetingId, upsertSession } = await import("./modules/shared-documents");
        const meetingId = generateMeetingId();
        upsertSession({ meetingId, topic, status: "active" });

        // Voice session is now started by the browser client via /ws/voice-test WebSocket.
        // Browser sends {type:'start'} which triggers services.realtime.start() on the server.
        // No Python sidecar needed — browser handles mic capture + speaker playback natively.
        //
        // The /ws/voice-test handler (line ~111) builds instructions from the 'start' message.
        // To enrich with persona + soul + memory, we prepare the instructions here and pass
        // them back to the client so it can include them in the WS start message.
        let voiceInstructions: string | undefined;
        try {
          const { buildVoiceInstructions } = await import("./voice-persona");
          voiceInstructions = buildVoiceInstructions();
          // Keep instructions lean for Grok's smaller context window.
          // User profile (name/timezone) is useful; full project details are not.
          const userEmail = CONFIG.userEmail;
          if (userEmail) {
            voiceInstructions += `\n\nUser: ${userEmail}`;
          }
        } catch (e: any) {
          console.warn("[TalkLocally] Failed to build voice instructions:", e.message);
        }

        // Step 2: Generate meeting prep brief (best-effort)
        let prepBrief: any = null;
        if (services.meetingPrepSkill && services.openclawBridge?.connected) {
          try {
            const prepResult = await prepareMeeting(services.meetingPrepSkill, topic, undefined, undefined, meetingId);
            prepBrief = prepResult.brief;
            if (services.realtime.connected) {
              // Layer 2: inject brief via conversation.item.create
              injectMeetingBrief(services.realtime, prepResult.brief);
              console.log("[TalkLocally] Layer 2 meeting brief injected");
            }
          } catch (e: any) {
            console.warn("[TalkLocally] Prep brief failed (continuing without):", e.message);
          }
        }

        // Step 3: Start meeting recording (transcript)
        services.meeting.startRecording();
        services.eventBus.startCorrelation("talk");

        // Step 4: Emit meeting.started — auto-triggers TranscriptAuditor,
        // ContextRetriever, and MeetingVision via eventBus handlers in callingclaw.ts
        services.eventBus.emit("meeting.started", {
          platform: "local",
          topic,
          meetingId,
        });
        console.log("[TalkLocally] meeting.started emitted — full meeting stack active");

        // DOM context capture now unified in callingclaw.ts meeting.started handler
        // (both Talk Locally and Meet Mode get it automatically)

        return Response.json({
          ok: true,
          meetingId,
          topic,
          voice: services.realtime.connected ? "connected" : "pending_session",
          audio_mode: "pending_transport",
          voiceInstructions: voiceInstructions || undefined,
          prepBrief: prepBrief ? {
            topic: prepBrief.topic,
            keyPoints: prepBrief.keyPoints?.length || 0,
          } : null,
          modules: {
            transcript: true,
            vision: true,
            auditor: "auto-activated via meeting.started",
            contextRetriever: "auto-activated via meeting.started",
            domContext: services.playwrightCli?.connected ? "active (10s interval)" : "unavailable (no browser)",
          },
        }, { headers });
      }

      // POST /api/meeting/talk-locally/stop — Stop local talk session
      // Generates summary, creates tasks, emits meeting.ended, reverts voice
      if (url.pathname === "/api/meeting/talk-locally/stop" && req.method === "POST") {
        // Clear browser DOM context interval
        const domInterval = (services.eventBus as any)._talkLocallyDomInterval;
        if (domInterval) {
          clearInterval(domInterval);
          (services.eventBus as any)._talkLocallyDomInterval = null;
        }
        services.context.clearBrowserContext();

        // Generate summary + export markdown
        const summary = await services.meeting.generateSummary();
        const filepath = await services.meeting.exportToMarkdown(summary);
        services.meeting.stopRecording();

        // Create tasks from action items
        let createdTasks: any[] = [];
        if (summary.actionItems && summary.actionItems.length > 0) {
          createdTasks = services.taskStore.createFromMeetingItems(
            summary.actionItems.map((a: any) => ({
              task: a.task,
              assignee: a.assignee,
              deadline: a.deadline,
            })),
            services.eventBus.correlationId || undefined
          );
        }

        // Build follow-up report
        const followUp = {
          filepath,
          summary,
          tasks: createdTasks.map((t: any) => ({
            id: t.id,
            task: t.task,
            assignee: t.assignee,
            deadline: t.deadline,
            status: t.status,
          })),
          pendingConfirmation: true,
          generatedAt: Date.now(),
        };

        services.eventBus.emit("meeting.ended", followUp);
        services.eventBus.endCorrelation();

        // Trigger post-meeting delivery (non-blocking)
        if (services.postMeetingDelivery) {
          services.postMeetingDelivery.deliver({
            summary,
            notesFilePath: filepath,
            prepSummary: services.meetingPrepSkill?.currentBrief ? {
              topic: services.meetingPrepSkill.currentBrief.topic,
              liveNotes: services.meetingPrepSkill.currentBrief.liveNotes || [],
              completedTasks: (services.meetingPrepSkill.currentBrief.liveNotes || []).filter((n: string) => n.startsWith("[DONE]")),
              requirements: (services.meetingPrepSkill.currentBrief.liveNotes || []).filter((n: string) => n.startsWith("[REQ]")),
            } : null,
          }).catch((e: any) => console.error("[TalkLocally/Stop] PostMeetingDelivery failed:", e.message));
        }

        // Revert voice to default persona
        if (services.meetingPrepSkill) {
          services.meetingPrepSkill.clear();
        }
        if (services.realtime.connected) {
          services.realtime.updateInstructions(buildVoiceInstructions());
          console.log("[TalkLocally] Voice reverted to CORE_IDENTITY");
        }

        // Stop voice session
        services.realtime.stop();
        services.bridge.send("config", { audio_mode: "default", capture_mode: "mouse" });
        services.eventBus.emit("voice.stopped", {});

        console.log(`[TalkLocally] Stopped — notes: ${filepath}, tasks: ${createdTasks.length}`);
        return Response.json({ ok: true, ...followUp }, { headers });
      }

      // ══════════════════════════════════════════════════════════════
      // ── Meeting Scheduler API (Calendar → Cron → Auto-Join) ──
      // ══════════════════════════════════════════════════════════════

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

      // ══════════════════════════════════════════════════════════════
      // ── Post-Meeting Delivery API (Smart Todo → Confirm → Execute) ──
      // ══════════════════════════════════════════════════════════════

      // GET /api/postmeeting/status — Get post-meeting delivery status
      if (url.pathname === "/api/postmeeting/status" && req.method === "GET") {
        return Response.json(
          services.postMeetingDelivery?.getStatus() || { deliveries: 0, active: [] },
          { headers }
        );
      }

      // POST /api/postmeeting/callback — Handle user confirmation from Telegram inline buttons
      // Called by OpenClaw when user clicks ✅/❌ buttons
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

      // ══════════════════════════════════════════════════════════════
      // ── Screen Sharing API ──
      // ══════════════════════════════════════════════════════════════

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

      // ══════════════════════════════════════════════════════════════
      // ── Workspace Context API ──
      // ══════════════════════════════════════════════════════════════

      // GET /api/context — Get SharedContext summary
      if (url.pathname === "/api/context" && req.method === "GET") {
        return Response.json(services.context.exportSummary(), { headers });
      }

      // POST /api/context/workspace — Inject workspace context (from OpenClaw)
      if (url.pathname === "/api/context/workspace" && req.method === "POST") {
        const body = (await req.json()) as {
          topic?: string;
          files?: Array<{ path: string; summary?: string; diffLines?: number }>;
          git_summary?: string;
          discussion_points?: string[];
        };

        services.context.setWorkspace({
          topic: body.topic,
          files: body.files || [],
          gitSummary: body.git_summary,
          discussionPoints: body.discussion_points,
        });

        services.eventBus.emit("workspace.updated", {
          topic: body.topic,
          fileCount: body.files?.length || 0,
        });

        return Response.json({ ok: true, workspace: services.context.workspace }, { headers });
      }

      // DELETE /api/context/workspace — Clear workspace context
      if (url.pathname === "/api/context/workspace" && req.method === "DELETE") {
        services.context.clearWorkspace();
        return Response.json({ ok: true }, { headers });
      }

      // ══════════════════════════════════════════════════════════════
      // ── ContextSync API (shared memory across Voice/ComputerUse/OpenClaw) ──
      // ══════════════════════════════════════════════════════════════

      // GET /api/context/sync — Get ContextSync status (memory, pinned files, brief lengths)
      if (url.pathname === "/api/context/sync" && req.method === "GET") {
        if (!services.contextSync) {
          return Response.json({ error: "ContextSync not initialized" }, { status: 503, headers });
        }
        return Response.json(services.contextSync.getStatus(), { headers });
      }

      // GET /api/context/brief — Get generated briefs (voice + computer)
      if (url.pathname === "/api/context/brief" && req.method === "GET") {
        if (!services.contextSync) {
          return Response.json({ error: "ContextSync not initialized" }, { status: 503, headers });
        }
        const brief = services.contextSync.getBrief();
        return Response.json({
          voice: brief.voice,
          computer: brief.computer,
          voiceChars: brief.voice.length,
          computerChars: brief.computer.length,
        }, { headers });
      }

      // POST /api/context/pin — Pin a file to shared context
      if (url.pathname === "/api/context/pin" && req.method === "POST") {
        if (!services.contextSync) {
          return Response.json({ error: "ContextSync not initialized" }, { status: 503, headers });
        }
        const body = await req.json() as { path: string; summary?: string };
        if (!body.path) {
          return Response.json({ error: "path is required" }, { status: 400, headers });
        }
        const pinned = await services.contextSync.pinFile(body.path, body.summary);
        if (!pinned) {
          return Response.json({ error: "File not found or could not be read" }, { status: 404, headers });
        }
        return Response.json({ ok: true, pinned: { path: pinned.path, summary: pinned.summary, contentLength: pinned.content.length } }, { headers });
      }

      // DELETE /api/context/pin — Unpin a file
      if (url.pathname === "/api/context/pin" && req.method === "DELETE") {
        if (!services.contextSync) {
          return Response.json({ error: "ContextSync not initialized" }, { status: 503, headers });
        }
        const body = await req.json() as { path: string };
        const removed = services.contextSync.unpinFile(body.path);
        return Response.json({ ok: removed }, { headers });
      }

      // POST /api/context/note — Add a session note
      if (url.pathname === "/api/context/note" && req.method === "POST") {
        if (!services.contextSync) {
          return Response.json({ error: "ContextSync not initialized" }, { status: 503, headers });
        }
        const body = await req.json() as { note: string };
        if (!body.note) {
          return Response.json({ error: "note is required" }, { status: 400, headers });
        }
        services.contextSync.addNote(body.note);
        return Response.json({ ok: true }, { headers });
      }

      // POST /api/context/reload — Reload OpenClaw memory from disk
      if (url.pathname === "/api/context/reload" && req.method === "POST") {
        if (!services.contextSync) {
          return Response.json({ error: "ContextSync not initialized" }, { status: 503, headers });
        }
        const loaded = await services.contextSync.loadOpenClawMemory();
        return Response.json({ ok: loaded, status: services.contextSync.getStatus() }, { headers });
      }

      // ══════════════════════════════════════════════════════════════
      // ── Shared Documents API (~/.callingclaw/shared/) ──
      // ══════════════════════════════════════════════════════════════

      // GET /api/shared/manifest — Return meetings from SQLite DB
      if (url.pathname === "/api/shared/manifest" && req.method === "GET") {
        if (services.meetingDB) {
          return Response.json(services.meetingDB.getManifest(), { headers });
        }
        // Fallback to legacy sessions.json
        const { readSessions } = await import("./modules/shared-documents");
        return Response.json(readSessions(), { headers });
      }

      // GET /api/shared/file?path=prep/xxx.md — Read any file from shared directory
      if (url.pathname === "/api/shared/file" && req.method === "GET") {
        const filePath = url.searchParams.get("path");
        if (!filePath) {
          return Response.json({ error: "path query parameter is required" }, { status: 400, headers });
        }
        try {
          const content = await readSharedFile(filePath);
          return Response.json({ path: filePath, content }, { headers });
        } catch (e: any) {
          return Response.json({ error: e.message }, { status: 404, headers });
        }
      }

      // GET /api/shared/prep — List available prep brief files
      if (url.pathname === "/api/shared/prep" && req.method === "GET") {
        const files = await listPrepFiles();
        return Response.json({ files, dir: SHARED_PREP_DIR }, { headers });
      }

      // ══════════════════════════════════════════════════════════════
      // ── Task Store API ──
      // ══════════════════════════════════════════════════════════════

      // GET /api/tasks — List tasks with optional filters
      if (url.pathname === "/api/tasks" && req.method === "GET") {
        const filters: Record<string, string> = {};
        const status = url.searchParams.get("status");
        const meetingId = url.searchParams.get("meeting_id");
        const assignee = url.searchParams.get("assignee");
        const priority = url.searchParams.get("priority");

        if (status) filters.status = status;
        if (meetingId) filters.meetingId = meetingId;
        if (assignee) filters.assignee = assignee;
        if (priority) filters.priority = priority;

        const tasks = services.taskStore.list(filters as any);
        return Response.json({ tasks, stats: services.taskStore.stats() }, { headers });
      }

      // POST /api/tasks — Create a new task
      if (url.pathname === "/api/tasks" && req.method === "POST") {
        const body = (await req.json()) as {
          task: string;
          priority?: "high" | "medium" | "low";
          assignee?: string;
          deadline?: string;
          context?: string;
        };

        if (!body.task) {
          return Response.json({ error: "task field is required" }, { status: 400, headers });
        }

        const task = services.taskStore.create(body);
        return Response.json({ task }, { status: 201, headers });
      }

      // Task by ID routes
      const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (taskMatch) {
        const taskId = taskMatch[1];

        // GET /api/tasks/:id
        if (req.method === "GET") {
          const task = services.taskStore.get(taskId);
          if (!task) return Response.json({ error: "Task not found" }, { status: 404, headers });
          return Response.json({ task }, { headers });
        }

        // PATCH /api/tasks/:id — Update task status/result
        if (req.method === "PATCH") {
          const body = (await req.json()) as {
            status?: "pending" | "in_progress" | "done" | "cancelled";
            result?: string;
            assignee?: string;
            priority?: "high" | "medium" | "low";
            deadline?: string;
          };
          const task = services.taskStore.update(taskId, body);
          if (!task) return Response.json({ error: "Task not found" }, { status: 404, headers });
          return Response.json({ task }, { headers });
        }

        // DELETE /api/tasks/:id
        if (req.method === "DELETE") {
          const deleted = services.taskStore.delete(taskId);
          if (!deleted) return Response.json({ error: "Task not found" }, { status: 404, headers });
          return Response.json({ ok: true }, { headers });
        }
      }

      // ══════════════════════════════════════════════════════════════
      // ── Event Bus API ──
      // ══════════════════════════════════════════════════════════════

      // GET /api/events — Get recent event history
      if (url.pathname === "/api/events" && req.method === "GET") {
        const count = parseInt(url.searchParams.get("count") || "50");
        const type = url.searchParams.get("type") || undefined;
        const events = services.eventBus.getHistory(count, type);
        return Response.json({ events }, { headers });
      }

      // POST /api/webhooks — Register a webhook
      if (url.pathname === "/api/webhooks" && req.method === "POST") {
        const body = (await req.json()) as {
          url: string;
          events: string[];
          secret?: string;
        };

        if (!body.url || !body.events?.length) {
          return Response.json(
            { error: "url and events[] are required" },
            { status: 400, headers }
          );
        }

        const id = services.eventBus.registerWebhook(body.url, body.events, body.secret);
        return Response.json({ id, url: body.url, events: body.events }, { status: 201, headers });
      }

      // GET /api/webhooks — List registered webhooks
      if (url.pathname === "/api/webhooks" && req.method === "GET") {
        return Response.json({ webhooks: services.eventBus.listWebhooks() }, { headers });
      }

      // Webhook by ID routes
      const webhookMatch = url.pathname.match(/^\/api\/webhooks\/([^/]+)$/);
      if (webhookMatch && req.method === "DELETE") {
        const removed = services.eventBus.removeWebhook(webhookMatch[1]);
        if (!removed) return Response.json({ error: "Webhook not found" }, { status: 404, headers });
        return Response.json({ ok: true }, { headers });
      }

      // ══════════════════════════════════════════════════════════════
      // ── Bridge / Google / Static ──
      // ══════════════════════════════════════════════════════════════

      // POST /api/bridge/action — Send direct action to Python sidecar
      if (url.pathname === "/api/bridge/action" && req.method === "POST") {
        const body = (await req.json()) as {
          action: string;
          params?: Record<string, any>;
        };
        const sent = services.bridge.sendAction(body.action, body.params || {});
        return Response.json({ sent }, { headers });
      }

      // GET /api/google/scan — Scan local filesystem for Google OAuth credentials
      if (url.pathname === "/api/google/scan" && req.method === "GET") {
        const result = await scanForGoogleCredentials();
        return Response.json(
          {
            found: !!result.credentials,
            sources: result.sources,
            credentials: result.credentials
              ? {
                  clientId: `${result.credentials.clientId.slice(0, 12)}...`,
                  refreshToken: `${result.credentials.refreshToken.slice(0, 12)}...`,
                  hasSecret: true,
                }
              : null,
          },
          { headers }
        );
      }

      // POST /api/google/apply — Apply scanned credentials (write to .env and connect)
      if (url.pathname === "/api/google/apply" && req.method === "POST") {
        const { credentials } = await scanForGoogleCredentials();
        if (!credentials) {
          return Response.json(
            { error: "No Google credentials found on this machine" },
            { status: 404, headers }
          );
        }

        const envFile = Bun.file(ENV_PATH);
        let envContent = (await envFile.exists()) ? await envFile.text() : "";

        const updates: Record<string, string> = {
          GOOGLE_CLIENT_ID: credentials.clientId,
          GOOGLE_CLIENT_SECRET: credentials.clientSecret,
          GOOGLE_REFRESH_TOKEN: credentials.refreshToken,
        };

        for (const [key, value] of Object.entries(updates)) {
          const regex = new RegExp(`^${key}=.*$`, "m");
          if (regex.test(envContent)) {
            envContent = envContent.replace(regex, `${key}=${value}`);
          } else {
            envContent += `\n${key}=${value}`;
          }
        }

        await Bun.write(ENV_PATH, envContent);

        services.calendar.setCredentials(credentials);
        await services.calendar.connect();

        return Response.json(
          {
            ok: true,
            message: "Google credentials applied and calendar connected",
            connected: services.calendar.connected,
          },
          { headers }
        );
      }

      // POST /api/google/set — Manually set Google OAuth credentials
      if (url.pathname === "/api/google/set" && req.method === "POST") {
        const body = (await req.json()) as {
          client_id: string;
          client_secret: string;
          refresh_token: string;
        };

        if (!body.client_id || !body.client_secret || !body.refresh_token) {
          return Response.json(
            { error: "Missing required fields: client_id, client_secret, refresh_token" },
            { status: 400, headers }
          );
        }

        const envFile = Bun.file(ENV_PATH);
        let envContent = (await envFile.exists()) ? await envFile.text() : "";

        const updates: Record<string, string> = {
          GOOGLE_CLIENT_ID: body.client_id,
          GOOGLE_CLIENT_SECRET: body.client_secret,
          GOOGLE_REFRESH_TOKEN: body.refresh_token,
        };

        for (const [key, value] of Object.entries(updates)) {
          const regex = new RegExp(`^${key}=.*$`, "m");
          if (regex.test(envContent)) {
            envContent = envContent.replace(regex, `${key}=${value}`);
          } else {
            envContent += `\n${key}=${value}`;
          }
        }

        await Bun.write(ENV_PATH, envContent);

        services.calendar.setCredentials({
          clientId: body.client_id,
          clientSecret: body.client_secret,
          refreshToken: body.refresh_token,
        });
        await services.calendar.connect();

        return Response.json(
          {
            ok: true,
            message: "Google credentials saved and calendar connected",
            connected: services.calendar.connected,
          },
          { headers }
        );
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

  // ── Forward AI audio output to browser voice test clients + Electron audio bridge ──
  services.realtime.onAudioOutput((base64Pcm) => {
    for (const ws of browserVoiceClients) {
      try { ws.send(JSON.stringify({ type: "audio", audio: base64Pcm })); } catch {}
    }
    // Same audio to Electron AudioBridge (uses Python bridge protocol: audio_playback)
    const abMsg = JSON.stringify({ type: "audio_playback", payload: { audio: base64Pcm } });
    for (const ws of audioBridgeClients) {
      try { ws.send(abMsg); } catch {}
    }
  });

  // ── Interruption: user started speaking → stop playback on all clients ──
  services.realtime.onSpeechStarted(() => {
    const msg = JSON.stringify({ type: "interrupt" });
    for (const ws of browserVoiceClients) {
      try { ws.send(msg); } catch {}
    }
    for (const ws of audioBridgeClients) {
      try { ws.send(msg); } catch {}
    }
    console.log("[Voice] Speech started — interrupted AI response");
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
  console.log(`[Config] Audio bridge WS on ws://localhost:${CONFIG.port}/ws/audio-bridge`);
  return server;
}
