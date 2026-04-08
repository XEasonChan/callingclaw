// CallingClaw 2.0 — HTTP Config Server (Bun.serve)
// Provides REST API for the web config page + service status + meeting notes
// + EventBus WebSocket + TaskStore + Workspace Context

import { CONFIG, USER_CONFIG_PATH } from "./config";
import { detectLanguage } from "./prompt-constants";
import { readFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { homedir } from "os";
import type { PythonBridge } from "./bridge";
import { RecallAPI } from "./recall-api";

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
import { buildVoiceInstructions, prepareMeeting, injectMeetingBrief, buildMeetingIntro, buildPresentationReadyContext, buildIdleNudgeContext } from "./voice-persona";
import { generateStageHtml, resolveDocumentUrl } from "./modules/stage-generator";
import { scanForGoogleCredentials } from "./mcp_client/google_cal";
import { validateMeetingUrl } from "./meet_joiner";
import { readSessions, readSharedFile, listPrepFiles } from "./modules/shared-documents";
import { SHARED_PREP_DIR, SHARED_NOTES_DIR } from "./config";

const ENV_PATH = `${import.meta.dir}/../../.env`;

/** Fetch with retry on ECONNRESET/socket errors (Bun fetch + proxy instability) */
async function fetchWithRetry(url: string, options: RequestInit, retries = 2): Promise<Response> {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetch(url, options);
    } catch (e: any) {
      if (i < retries && (e.message?.includes("ECONNRESET") || e.message?.includes("socket") || e.message?.includes("closed"))) {
        console.warn(`[Fetch] Retry ${i + 1}/${retries} for ${url.slice(0, 60)}... (${e.message})`);
        await new Promise(r => setTimeout(r, 500 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
  throw new Error("unreachable");
}

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
  chromeLauncher?: import("./chrome-launcher").ChromeLauncher;
  meetingScheduler?: MeetingScheduler;
  postMeetingDelivery?: PostMeetingDelivery;
  meetingDB?: import("./modules/meeting-db").MeetingDB;
  sessionManager?: import("./modules/session-manager").SessionManager;
}

// ── Tool Layer Definitions (for Voice Test toggles) ──
const TOOL_LAYERS: Record<string, { label: string; tools: string[] }> = {
  memory:     { label: "Memory",     tools: ["recall_context"] },
  calendar:   { label: "Calendar",   tools: ["schedule_meeting", "check_calendar", "delete_event"] },
  meeting:    { label: "Meeting",    tools: ["join_meeting", "create_and_join_meeting", "leave_meeting", "save_meeting_notes"] },
  automation: { label: "Automation", tools: ["computer_action", "browser_action", "open_file", "share_screen", "stop_sharing", "take_screenshot"] },
  zoom:       { label: "Zoom",       tools: ["zoom_control"] },
};

export function startConfigServer(services: Services) {
  // ── Browser Voice Test clients ──
  const browserVoiceClients = new Set<any>();
  // ── Electron Audio Bridge clients (replaces Python sidecar) ──
  const audioBridgeClients = new Set<any>();
  // ── Recall.ai Bridge clients (cloud bot audio relay) ──
  const recallBridgeClients = new Set<any>();
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
    meetLink?: string;
    calendarEventId?: string;
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

    // Validate Gemini API key
    if (provider === "gemini" && !CONFIG.gemini.apiKey) {
      throw new Error("Gemini API key not configured (set GEMINI_API_KEY in .env)");
    }

    // Apply voice selection
    if (opts.voice && provider === "grok") CONFIG.grok.voice = opts.voice;
    else if (opts.voice && provider === "openai") CONFIG.openai.voice = opts.voice;
    else if (opts.voice && provider === "gemini") CONFIG.gemini.voice = opts.voice;

    const transport = opts.transport || "meet_bridge";
    const mode = opts.mode || "default";
    const instructions = buildSessionInstructions(opts.instructions);

    if (services.realtime.connected) {
      services.realtime.stop();
    }

    await services.realtime.start(instructions, provider);

    // Inject current date/time so AI can correctly parse relative time references ("今天", "明天", "下午5点")
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const timeCtx = `当前时间: ${now.toISOString()} (${tz}, ${now.toLocaleDateString("zh-CN", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: tz })})`;
    // Use injectContext() instead of raw sendEvent — proper role ("system") + FIFO queue management.
    // Raw sendEvent with role "user" would trigger AI response on OpenAI/Grok.
    services.realtime.injectContext(`[系统信息]\n${timeCtx}`);

    // Inject selected meeting context so AI knows which meeting to join/delete
    if (opts.topic || opts.meetLink) {
      const meetingCtx = [
        opts.topic ? `会议主题: ${opts.topic}` : "",
        opts.meetLink ? `Meet链接: ${opts.meetLink}` : "",
        opts.calendarEventId ? `日历事件ID: ${opts.calendarEventId}` : "",
        "用户已选择此会议。当用户要求加入会议时，直接使用上述Meet链接调用join_meeting工具，无需再次询问链接。",
        opts.calendarEventId ? "当用户要求删除/取消此会议时，直接使用上述日历事件ID调用delete_event工具。" : "",
      ].filter(Boolean).join("\n");
      services.realtime.injectContext(`[当前会议上下文]\n${meetingCtx}`);
      console.log(`[VoiceSession] Meeting context injected: ${opts.topic || "no topic"}, link: ${opts.meetLink || "none"}, calEventId: ${opts.calendarEventId || "none"}`);
    }

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

    // Notify all voice-test browser clients that voice is now connected.
    // Critical for Gemini: the initial WS status may have been sent before Gemini connected
    // (retry loop adds delay), so clients missed the transition to connected=true.
    const statusMsg = JSON.stringify({ type: "status", voiceConnected: true, provider: services.realtime.provider });
    for (const ws of browserVoiceClients) {
      try { ws.send(statusMsg); } catch {}
    }

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
        } else if (ws.data?.type === "recall-bridge") {
          recallBridgeClients.add(ws);
          console.log(`[RecallBridge] Cloud bot connected (${recallBridgeClients.size} total)`);
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
        } else if (ws.data?.type === "recall-bridge") {
          recallBridgeClients.delete(ws);
          console.log(`[RecallBridge] Cloud bot disconnected (${recallBridgeClients.size} remaining)`);
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
        // ── Recall Bridge: binary PCM16 from cloud bot → OpenAI Realtime ──
        if (ws.data?.type === "recall-bridge") {
          if (msg instanceof ArrayBuffer || msg instanceof Buffer) {
            const view = new Uint8Array(msg instanceof Buffer ? msg.buffer : msg, msg instanceof Buffer ? msg.byteOffset : 0, msg instanceof Buffer ? msg.byteLength : (msg as ArrayBuffer).byteLength);
            if (view[0] === 0x01 && view.length > 1) {
              const pcm = Buffer.from(view.buffer, view.byteOffset + 1, view.length - 1);
              services.realtime.sendAudio(pcm.toString("base64"));
            }
          }
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
            } else if (data.type === "caption") {
              // Meet captions DOM scrape — reliable transcript from Google's speech recognition.
              // TWO purposes:
              //   1. Add to SharedContext transcript (for meeting notes, summary)
              //   2. Inject into Realtime API as conversation context (so AI understands what was said)
              if (data.text && services.realtime.connected) {
                const text = String(data.text).trim();
                if (text.length > 5) {
                  // ── Filter 1: Skip Meet UI tooltip noise ──
                  if (/^Press the|^Escape to|hover tray|down arrow to open/i.test(text)) {
                    return;
                  }

                  // ── Filter 2: Skip AI echo (caption of CallingClaw's own speech) ──
                  const recentAI = services.context.getRecentTranscript(10)
                    .filter(e => e.role === "assistant" && (Date.now() - e.ts) < 30_000)
                    .map(e => e.text.toLowerCase());
                  if (recentAI.length > 0) {
                    const captionLower = text.toLowerCase();
                    const isEcho = recentAI.some(aiText => {
                      if (aiText.includes(captionLower) || captionLower.includes(aiText)) return true;
                      const captionWords = new Set(captionLower.split(/\s+/));
                      const aiWords = aiText.split(/\s+/);
                      const overlap = aiWords.filter(w => captionWords.has(w)).length;
                      return aiWords.length > 0 && overlap / aiWords.length > 0.6;
                    });
                    if (isEcho) {
                      console.log(`[VoiceTest] Caption echo filtered: "${text.substring(0, 60)}"`);
                      return;
                    }
                  }

                  // ── Filter 3: Skip if speaker is CallingClaw (STT mangles the name) ──
                  const speaker = data.speaker ? String(data.speaker).trim().toLowerCase() : "";
                  if (speaker && /calling\s*claw|colin\s*claw|calling\s*clah|calling\s*call|calling\s*clause|callingclaw/.test(speaker)) {
                    console.log(`[VoiceTest] Caption from self filtered: "${text.substring(0, 60)}"`);
                    return;
                  }

                  // Add to transcript for notes/summary
                  services.context.addTranscript({ role: "user", text, speaker: data.speaker, ts: data.ts || Date.now() });
                  // Inject into Realtime API so AI sees reliable text of what was said
                  services.realtime.sendEvent("conversation.item.create", {
                    item: {
                      type: "message",
                      role: "user",
                      content: [{ type: "input_text", text: `[会议发言] ${text}` }],
                    },
                  });
                  console.log(`[VoiceTest] Meet caption → AI: "${text.substring(0, 80)}"`);
                }
              }
            } else if (data.type === "start") {
              // Start voice session from browser (supports provider + voice + meeting context)
              // GUARD: if voice is already connected (e.g. meeting join started it),
              // do NOT restart — just send status back. But still inject meeting context
              // if provided (user may have selected a meeting after session started).
              const topic = data.topic || undefined;
              const meetLink = data.meetLink || undefined;
              const calendarEventId = data.calendarEventId || undefined;

              const injectMeetingContext = () => {
                if ((topic || meetLink) && services.realtime.connected) {
                  const meetingCtx = [
                    topic ? `会议主题: ${topic}` : "",
                    meetLink ? `Meet链接: ${meetLink}` : "",
                    calendarEventId ? `日历事件ID: ${calendarEventId}` : "",
                    "用户已选择此会议。当用户要求加入会议时，直接使用上述Meet链接调用join_meeting工具，无需再次询问链接。",
                    calendarEventId ? "当用户要求删除/取消此会议时，直接使用上述日历事件ID调用delete_event工具。" : "",
                  ].filter(Boolean).join("\n");
                  services.realtime.injectContext(`[当前会议上下文]\n${meetingCtx}`);
                  console.log(`[VoiceTest] Meeting context injected: ${topic || "no topic"}, link: ${meetLink || "none"}, calEventId: ${calendarEventId || "none"}`);
                }
              };

              if (services.realtime.connected) {
                console.log("[VoiceTest] Voice already connected — skipping start, sending status");
                ws.send(JSON.stringify({ type: "status", voiceConnected: true, provider: services.realtime.provider }));
                // Still inject meeting context if provided
                injectMeetingContext();
              } else {
                const instructions = data.instructions || undefined;
                const provider = data.provider || undefined; // "openai" | "grok"
                const voice = data.voice || undefined;

                // Update voice config for selected provider before start
                if (provider === "grok" && voice) {
                  CONFIG.grok.voice = voice;
                } else if (provider === "openai" && voice) {
                  CONFIG.openai.voice = voice;
                } else if (provider === "gemini" && voice) {
                  CONFIG.gemini.voice = voice;
                }

                services.realtime.start(instructions, provider).then(() => {
                  ws.send(JSON.stringify({ type: "status", voiceConnected: true, provider: services.realtime.provider }));
                  services.eventBus.emit("voice.started", { audio_mode: "browser", provider });
                  // Activate TranscriptAuditor for Talk Locally mode too (not just meetings).
                  if (services.transcriptAuditor && !services.transcriptAuditor.active) {
                    services.transcriptAuditor.activate(services.realtime);
                    console.log("[VoiceTest] TranscriptAuditor activated for Talk Locally");
                  }
                  // Inject current date/time via injectContext (system role, no response trigger)
                  const _now = new Date();
                  const _tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
                  services.realtime.injectContext(`[系统信息]\n当前时间: ${_now.toISOString()} (${_tz}, ${_now.toLocaleDateString("zh-CN", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: _tz })})`);
                  // Inject meeting context after session is ready
                  injectMeetingContext();
                }).catch((e: any) => {
                  ws.send(JSON.stringify({ type: "error", message: e.message }));
                });
              }
            } else if (data.type === "stop") {
              services.transcriptAuditor?.deactivate();
              services.realtime.stop();
              ws.send(JSON.stringify({ type: "status", voiceConnected: false }));
              services.eventBus.emit("voice.stopped", {});
            } else if (data.type === "inject_context" && data.text) {
              // Inject context into voice session (e.g., meeting prep brief from Talk Locally mode)
              const id = services.realtime.injectContext(data.text);
              ws.send(JSON.stringify({ type: "context_injected", ok: !!id, id }));
            } else if (data.type === "video" && data.frame) {
              // Video frame from browser screen capture (Gemini vision mode)
              services.realtime.sendVideo(data.frame);
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

      // ── WebSocket upgrade for /ws/recall-bridge (Recall.ai cloud bot audio relay) ──
      if (url.pathname === "/ws/recall-bridge") {
        const upgraded = server.upgrade(req, { data: { type: "recall-bridge" } });
        if (!upgraded) {
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return undefined as any;
      }

      // ══════════════════════════════════════════════════════════════
      // ── Recall.ai Bot Management ──
      // ══════════════════════════════════════════════════════════════

      // GET /api/recall/status — Check if Recall.ai is configured
      if (url.pathname === "/api/recall/status") {
        return Response.json({
          configured: !!CONFIG.recall.apiKey,
          clientPageUrl: CONFIG.recall.clientPageUrl || null,
          wsUrl: CONFIG.recall.wsUrl || null,
          activeBridgeClients: recallBridgeClients.size,
        }, { headers });
      }

      // POST /api/recall/bot — Create a Recall.ai bot for a meeting
      if (url.pathname === "/api/recall/bot" && req.method === "POST") {
        if (!CONFIG.recall.apiKey) {
          return Response.json({ error: "RECALL_API_KEY not configured" }, { status: 400, headers });
        }
        try {
          const body = await req.json();
          const meetUrl = body.meet_url;
          if (!meetUrl) {
            return Response.json({ error: "meet_url required" }, { status: 400, headers });
          }
          const wsUrl = CONFIG.recall.wsUrl || body.ws_url || `ws://localhost:${CONFIG.port}/ws/recall-bridge`;
          const clientBase = CONFIG.recall.clientPageUrl || `http://localhost:${CONFIG.port}/recall-client.html`;
          const clientPageUrl = `${clientBase}?ws=${encodeURIComponent(wsUrl)}`;

          const api = new RecallAPI(CONFIG.recall.apiKey, CONFIG.recall.baseUrl);
          const bot = await api.createBot({ meetUrl, clientPageUrl, botName: body.bot_name });
          console.log(`[Recall] Bot created: ${bot.id} for ${meetUrl}`);
          return Response.json(bot, { status: 201, headers });
        } catch (e: any) {
          console.error(`[Recall] Bot creation failed:`, e.message);
          return Response.json({ error: e.message }, { status: 500, headers });
        }
      }

      // GET /api/recall/bot/:id — Get bot status
      if (url.pathname.startsWith("/api/recall/bot/") && req.method === "GET") {
        const botId = url.pathname.split("/api/recall/bot/")[1]?.replace(/\/$/, "");
        if (!botId || !CONFIG.recall.apiKey) {
          return Response.json({ error: "Not found" }, { status: 404, headers });
        }
        try {
          const api = new RecallAPI(CONFIG.recall.apiKey, CONFIG.recall.baseUrl);
          const bot = await api.getBot(botId);
          return Response.json(bot, { headers });
        } catch (e: any) {
          return Response.json({ error: e.message }, { status: 500, headers });
        }
      }

      // DELETE /api/recall/bot/:id — Destroy bot (leave meeting)
      if (url.pathname.startsWith("/api/recall/bot/") && req.method === "DELETE") {
        const botId = url.pathname.split("/api/recall/bot/")[1]?.replace(/\/$/, "");
        if (!botId || !CONFIG.recall.apiKey) {
          return Response.json({ error: "Not found" }, { status: 404, headers });
        }
        try {
          const api = new RecallAPI(CONFIG.recall.apiKey, CONFIG.recall.baseUrl);
          await api.destroyBot(botId);
          console.log(`[Recall] Bot destroyed: ${botId}`);
          return Response.json({ ok: true }, { headers });
        } catch (e: any) {
          return Response.json({ error: e.message }, { status: 500, headers });
        }
      }

      // ══════════════════════════════════════════════════════════════
      // ── Prompt Dashboard API ──
      // ══════════════════════════════════════════════════════════════

      if (url.pathname === "/api/prompts" && req.method === "GET") {
        const { listPrompts } = await import("./prompt-registry");
        return Response.json(listPrompts(), { headers });
      }

      if (url.pathname.startsWith("/api/prompts/") && !url.pathname.endsWith("/reset") && req.method === "PUT") {
        const id = decodeURIComponent(url.pathname.slice("/api/prompts/".length));
        const body = (await req.json()) as { value: string };
        const { setPromptOverride } = await import("./prompt-registry");
        const ok = setPromptOverride(id, body.value);
        return Response.json({ ok, id }, { headers });
      }

      if (url.pathname.endsWith("/reset") && url.pathname.startsWith("/api/prompts/") && req.method === "POST") {
        const id = decodeURIComponent(url.pathname.slice("/api/prompts/".length, -"/reset".length));
        const { resetPrompt } = await import("./prompt-registry");
        const ok = resetPrompt(id);
        return Response.json({ ok, id }, { headers });
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
            xai: CONFIG.grok.apiKey
              ? `xai-...${CONFIG.grok.apiKey.slice(-4)}`
              : "",
            anthropic: CONFIG.anthropic.apiKey
              ? `sk-ant-...${CONFIG.anthropic.apiKey.slice(-4)}`
              : "",
            gemini: CONFIG.gemini.apiKey
              ? `AIza...${CONFIG.gemini.apiKey.slice(-4)}`
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
          if (envKey === "XAI_API_KEY") CONFIG.grok.apiKey = value;
          if (envKey === "GEMINI_API_KEY") CONFIG.gemini.apiKey = value;
          if (envKey === "GOOGLE_AI_API_KEY") CONFIG.gemini.apiKey = value;
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
            gemini_model: CONFIG.gemini.realtimeModel,
            gemini_voice: CONFIG.gemini.voice,
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

      // GET /api/config/paths — Get configurable search paths
      if (url.pathname === "/api/config/paths" && req.method === "GET") {
        const { SEARCH_PATHS, SHARED_DIR: defaultPrepDir } = await import("./config");
        return Response.json({
          prepDir: SEARCH_PATHS.prepDir,
          knowledgeDir: SEARCH_PATHS.knowledgeDir,
          defaults: { prepDir: defaultPrepDir, knowledgeDir: "" },
        }, { headers });
      }

      // POST /api/config/paths — Update configurable search paths
      if (url.pathname === "/api/config/paths" && req.method === "POST") {
        const body = await req.json();
        const { SEARCH_PATHS, CALLINGCLAW_HOME: ccHome } = await import("./config");
        const { resolve } = await import("path");
        const { mkdirSync, existsSync } = await import("fs");

        // Validate paths exist
        if (body.prepDir !== undefined) {
          const p = String(body.prepDir).trim();
          if (p && !existsSync(p)) {
            return Response.json({ error: `prepDir does not exist: ${p}` }, { status: 400, headers });
          }
          SEARCH_PATHS.prepDir = p || SHARED_DIR;
        }
        if (body.knowledgeDir !== undefined) {
          const p = String(body.knowledgeDir).trim();
          if (p && !existsSync(p)) {
            return Response.json({ error: `knowledgeDir does not exist: ${p}` }, { status: 400, headers });
          }
          SEARCH_PATHS.knowledgeDir = p;
        }

        // Persist to user-config.json
        try {
          const configPath = resolve(ccHome, "user-config.json");
          let existing: Record<string, string> = {};
          const f = Bun.file(configPath);
          if (await f.exists()) existing = await f.json();
          existing.prepDir = SEARCH_PATHS.prepDir;
          existing.knowledgeDir = SEARCH_PATHS.knowledgeDir;
          mkdirSync(ccHome, { recursive: true });
          await Bun.write(configPath, JSON.stringify(existing, null, 2));
        } catch (e: any) {
          console.warn("[Config] Failed to persist paths:", e.message);
        }

        console.log(`[Config] Paths updated: prepDir=${SEARCH_PATHS.prepDir}, knowledgeDir=${SEARCH_PATHS.knowledgeDir}`);
        return Response.json({ ok: true, prepDir: SEARCH_PATHS.prepDir, knowledgeDir: SEARCH_PATHS.knowledgeDir }, { headers });
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
            meetLink?: string;
            calendarEventId?: string;
            provider?: string;
            voice?: string;
          };
          const result = await startVoiceSession({
            instructions: body.instructions,
            transport: body.transport || "direct",
            mode: body.mode || "default",
            topic: body.topic,
            meetLink: body.meetLink,
            calendarEventId: body.calendarEventId,
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

      // POST /api/voice/inject — Inject system context into voice session (no response trigger)
      if (url.pathname === "/api/voice/inject" && req.method === "POST") {
        const body = (await req.json()) as { text: string };
        const id = services.realtime.injectContext(body.text);
        return Response.json({ ok: true, id }, { headers });
      }

      // POST /api/voice/respond — Trigger voice model to generate a response
      if (url.pathname === "/api/voice/respond" && req.method === "POST") {
        services.realtime.sendEvent("response.create", {});
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

      // POST /api/test/transcript-inject — Inject fake transcript for testing
      if (url.pathname === "/api/test/transcript-inject" && req.method === "POST") {
        const body = (await req.json()) as { text: string; role?: string; speaker?: string };
        if (!body.text) {
          return Response.json({ error: "text is required" }, { status: 400, headers });
        }
        const entry = {
          role: (body.role as any) || "user",
          text: body.text,
          speaker: body.speaker,
          ts: Date.now(),
        };
        services.context.addTranscript(entry);
        const auditorActive = services.transcriptAuditor?.active || false;
        return Response.json({ ok: true, entry, auditorActive, transcriptLength: services.context.transcript.length }, { headers });
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
        // Audio: BlackHole removed in v2.7.12 — Playwright audio injection, no virtual drivers

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
          // Audio: Playwright injection (no BlackHole needed since v2.7.12)
          audio: true,
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

        const requiredOk = screenRecording && accessibility && sidecar && voiceKey;

        return Response.json({
          ready: requiredOk,
          checklist,
          quickStart: requiredOk
            ? "/callingclaw join <your-meeting-url>"
            : null,
          hints: {
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

      // GET /api/onboarding/audio — Audio status (BlackHole removed in v2.7.12)
      if (url.pathname === "/api/onboarding/audio" && req.method === "GET") {
        let devices: string[] = [];
        let currentInput = "";
        let currentOutput = "";

        try {
          await Bun.$`which SwitchAudioSource`.quiet();
          const all = await Bun.$`SwitchAudioSource -a`.text();
          devices = all.trim().split("\n").filter(Boolean);
          currentOutput = (await Bun.$`SwitchAudioSource -c`.text()).trim();
          currentInput = (await Bun.$`SwitchAudioSource -c -t input`.text()).trim();
        } catch {}

        const ready = true; // No virtual audio drivers needed since v2.7.12

        return Response.json({
          ready,
          audioMethod: "playwright_injection",
          currentInput,
          currentOutput,
          devices,
        }, { headers });
      }

      // ══════════════════════════════════════════════════════════════
      // ── Calendar API ──
      // ══════════════════════════════════════════════════════════════

      // GET /api/calendar/events — List upcoming events + SessionManager meetings
      // Merges: Google Calendar events + sessions from /callingclaw prepare
      // So Desktop shows meetings even when Calendar is disconnected.
      if (url.pathname === "/api/calendar/events" && req.method === "GET") {
        const connected = services.calendar.connected;
        const events = await services.calendar.listUpcomingEvents();

        // Read all sessions (from prepare, join, etc.)
        let sessions: any[] = [];
        try {
          const { readSessions } = await import("./modules/shared-documents");
          sessions = readSessions().sessions || [];
        } catch {}

        // Enrich calendar events with prep brief status
        const calEventIds = new Set<string>();
        const meetUrls = new Set<string>();
        let enriched = events.map((e: any) => {
          if (e.id) calEventIds.add(e.id);
          const link = e.hangoutLink || e.meetLink;
          if (link) meetUrls.add(link);
          const titleLower = (e.summary || "").toLowerCase();
          let _prepBrief: string | null = null;
          for (const s of sessions) {
            const sTopic = (s.topic || "").toLowerCase();
            if (sTopic && (titleLower.includes(sTopic) || sTopic.includes(titleLower))) {
              if (s.files?.prep) { _prepBrief = s.files.prep; break; }
            }
            // Also match by calendarEventId or meetUrl
            if (s.calendarEventId && s.calendarEventId === e.id) {
              if (s.files?.prep) { _prepBrief = s.files.prep; break; }
            }
          }
          return { ...e, _prepBrief };
        });

        // Merge sessions NOT already in calendar events (e.g. prepare'd without calendar, or calendar disconnected)
        const now = Date.now();
        for (const s of sessions) {
          // Skip if already matched to a calendar event
          if (s.calendarEventId && calEventIds.has(s.calendarEventId)) continue;
          if (s.meetUrl && meetUrls.has(s.meetUrl)) continue;
          // Skip ended sessions — only show active/upcoming meetings
          if (s.status === "ended") continue;
          // Convert session to calendar-like event format for Desktop rendering
          enriched.push({
            id: s.meetingId,
            summary: s.topic,
            start: s.startTime || new Date().toISOString(),
            end: s.endTime || (s.startTime ? new Date(new Date(s.startTime).getTime() + 3600000).toISOString() : null),
            hangoutLink: s.meetUrl || null,
            meetLink: s.meetUrl || null,
            _prepBrief: s.files?.prep || null,
            _source: "session", // Mark so Desktop knows this came from SessionManager
            _status: s.status,
            _meetingId: s.meetingId,
          });
        }

        // Sort by start time (newest first for past, soonest first for upcoming)
        enriched.sort((a: any, b: any) => {
          const aTime = new Date(typeof a.start === "object" ? a.start.dateTime : a.start).getTime();
          const bTime = new Date(typeof b.start === "object" ? b.start.dateTime : b.start).getTime();
          return aTime - bTime;
        });

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
        services.eventBus.emit("calendar.updated", { action: "created", summary: body.summary });
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
        const body = (await req.json()) as { url: string; instructions?: string; provider?: string; voice?: string; topic?: string };
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

        // ── Auth guard: check Chrome Google login for Meet ──
        // If ChromeLauncher is available but Chrome isn't launched yet, launch it to check
        if (services.chromeLauncher && validated.platform === "google_meet") {
          try {
            await services.chromeLauncher.launch();
            const authCheck = await services.chromeLauncher.checkGoogleLogin();
            if (!authCheck.loggedIn) {
              console.log("[Meeting] Chrome not logged into Google — blocking join");
              return Response.json({
                error: "Google account required",
                needsAuth: true,
                message: "Please sign into your Google account in Chrome first.",
                steps: [
                  { action: "POST /api/google/chrome-login", description: "Opens Chrome to Google sign-in page" },
                  { action: "GET /api/google/auth-status", description: "Poll until loggedIn=true" },
                  { action: "POST /api/meeting/join", description: "Retry joining the meeting" },
                ],
                authStatusUrl: "/api/google/auth-status",
                chromeLoginUrl: "/api/google/chrome-login",
              }, { status: 401, headers });
            }
            console.log(`[Meeting] Chrome Google auth OK (${authCheck.email || "unknown"})`);
          } catch (e: any) {
            console.warn("[Meeting] Auth check failed (continuing):", e.message);
          }
        }

        // Reuse existing session for the same Meet URL, or create new one
        const session = services.sessionManager!.findOrCreate({
          topic: body.topic || body.instructions?.slice(0, 200) || "Meeting",
          meetUrl: validated.url,
        });
        const meetingId = session.meetingId;
        services.sessionManager!.markActive(meetingId, { meetUrl: validated.url });

        // Step 1: Start voice session (if not already running)
        // Uses CORE_IDENTITY as system prompt; meeting context injected later via injectMeetingBrief()
        const joinProvider = (body.provider || CONFIG.voiceProvider) as any;
        if (body.voice) {
          if (joinProvider === "gemini") CONFIG.gemini.voice = body.voice;
          else if (joinProvider === "grok") CONFIG.grok.voice = body.voice;
          else if (joinProvider === "openai") CONFIG.openai.voice = body.voice;
        }

        let voiceStarted = false;
        const hasApiKey = joinProvider === "gemini" ? !!CONFIG.gemini.apiKey
          : joinProvider === "grok" ? !!CONFIG.grok.apiKey
          : !!CONFIG.openai.apiKey;

        if (!services.realtime.connected && hasApiKey) {
          try {
            const voiceInstructions = buildVoiceInstructions();
            await services.realtime.start(voiceInstructions, joinProvider);
            voiceStarted = true;
            console.log(`[Meeting] Voice AI started with ${joinProvider}`);
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

        // Generate meeting prep brief via OpenClaw — BACKGROUND, NEVER blocks join
        const meetTopic = body.topic || calEvent?.summary || body.instructions?.slice(0, 200) || services.context.workspace?.topic || "Meeting";
        let prepBrief: any = null;

        // Check for local presentation script (prep JSON with speakingPlan + scenes)
        // This enables PRESENTER mode without waiting for OpenClaw
        if (services.meetingPrepSkill && !(services.meetingPrepSkill.currentBrief?.speakingPlan?.length > 0)) {
          const { homedir } = require("os");
          const { existsSync, readdirSync } = require("fs");
          const sharedDir = `${homedir()}/.callingclaw/shared`;
          try {
            const jsonFiles = readdirSync(sharedDir)
              .filter((f: string) => f.endsWith("_prep.json") || f.endsWith("_presentation.json"));
            for (const fname of jsonFiles) {
              const jsonPath = `${sharedDir}/${fname}`;
              const prepData = JSON.parse(await Bun.file(jsonPath).text());
              if (prepData.speakingPlan && prepData.scenes) {
                prepBrief = {
                  topic: prepData.topic || meetTopic,
                  goal: prepData.goal || "",
                  generatedAt: Date.now(),
                  summary: prepData.summary || "",
                  keyPoints: prepData.keyPoints || [],
                  architectureDecisions: [],
                  expectedQuestions: [],
                  filePaths: prepData.filePaths || [],
                  browserUrls: prepData.browserUrls || [],
                  folderPaths: [],
                  attendees: meetAttendees || [],
                  liveNotes: [],
                  speakingPlan: prepData.speakingPlan,
                  scenes: prepData.scenes,
                  decisionPoints: prepData.decisionPoints || [],
                };
                services.meetingPrepSkill.setBrief(prepBrief);
                // Register prep files as Working Documents on Stage
                for (const f of (prepData.filePaths || [])) {
                  const name = f.path.split("/").pop() || f.path;
                  services.context.addStageDocument(f.path, "new");
                }
                for (const u of (prepData.browserUrls || [])) {
                  services.context.addStageDocument(u.url, "new");
                }
                console.log(`[Meeting] ✅ Loaded presentation script from ${fname}: ${prepData.speakingPlan.length} phases, ${prepData.scenes.length} scenes, ${(prepData.filePaths?.length || 0) + (prepData.browserUrls?.length || 0)} documents`);
                break;
              }
            }
          } catch (e: any) {
            console.warn(`[Meeting] Prep JSON scan failed: ${e.message}`);
          }
        }

        if (!prepBrief && services.meetingPrepSkill && services.openclawBridge?.connected) {
          // Fire-and-forget: prep runs in background, injects when ready
          (async () => {
            try {
              const prepResult = await prepareMeeting(services.meetingPrepSkill, meetTopic, undefined, meetAttendees, meetingId);
              prepBrief = prepResult.brief;
              if (services.realtime.connected) {
                const itemId = injectMeetingBrief(services.realtime, prepResult.brief);
                console.log(`[Meeting] ✅ Layer 2 meeting brief injected (background, ${prepResult.brief.keyPoints?.length || 0} key points)`);
              }
            } catch (e: any) {
              console.warn("[Meeting] Prep brief failed (non-blocking):", e.message);
            }
          })();
          console.log("[Meeting] Prep brief started in background — join continues immediately");
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
        // Primary: ChromeLauncher (Playwright library — single Chrome, no CLI conflict)
        // Secondary: playwright-cli (legacy, if ChromeLauncher not available)
        // Fallback: MeetJoiner (osascript, legacy)
        let joinSuccess = false;
        let joinState: "in_meeting" | "waiting_room" | "failed" = "failed";
        let joinSummary = "";
        let joinMethod = "meetjoiner";

        if (services.chromeLauncher && validated.platform === "google_meet") {
          // Preferred: ChromeLauncher handles join + audio (no playwright-cli needed)
          // Audio injection via addInitScript replaces BlackHole — keep default devices
          console.log("[Meeting] Using ChromeLauncher join (Playwright library, no CLI conflict)...");
          try {
            await services.chromeLauncher.launch();
            console.log("[Meeting] ✅ ChromeLauncher: audio injection init script installed");
          } catch (e: any) {
            console.warn("[Meeting] ChromeLauncher launch failed:", e.message);
          }

          joinMethod = "chromelauncher";
          const result = await services.chromeLauncher.joinGoogleMeet(validated.url, {
            muteCamera: true,
            muteMic: false, // Mic ON for audio injection
            onStep: (step) => services.eventBus.emit("meeting.join_step", { step }),
          });
          joinSuccess = result.success;
          joinState = result.state;
          joinSummary = result.summary;

          // Activate audio pipeline after joining
          if (joinSuccess) {
            try {
              const pipelineResult = await services.chromeLauncher.activateAudioPipeline();
              console.log("[Meeting] ✅ Audio pipeline activated:", pipelineResult);
            } catch (e: any) {
              console.warn("[Meeting] Audio pipeline activation failed:", e.message);
            }
          }
        } else if (services.playwrightCli && validated.platform === "google_meet") {
          // Fallback: playwright-cli (legacy path)
          if (!services.playwrightCli.connected) {
            try { await services.playwrightCli.start(); } catch (e: any) {
              console.warn("[Meeting] Playwright start failed:", e.message);
            }
          }
          if (services.playwrightCli.connected) {
            console.log("[Meeting] Using Playwright fast-join (legacy path)...");
            joinMethod = "playwright_eval";
            const result = await services.playwrightCli.joinGoogleMeet(validated.url, {
              muteCamera: true,
              muteMic: false,
              // No device selection — keep system defaults
              onStep: (step) => services.eventBus.emit("meeting.join_step", { step }),
            });
            joinSuccess = result.success;
            joinState = result.state;
            joinSummary = result.summary;
          }
        }

        if (!joinSuccess && joinState === "failed" && joinMethod === "meetjoiner") {
          // Final fallback: osascript MeetJoiner
          console.log("[Meeting] Using MeetJoiner (osascript fallback)...");
          const session = await services.meetJoiner.joinMeeting({
            meetUrl: validated.url,
            muteCamera: true,
            muteMic: false,
          });
          joinSuccess = session.status === "in_meeting";
          joinState = joinSuccess ? "in_meeting" : "failed";
          joinSummary = joinSuccess ? "Joined via MeetJoiner" : (session.error || "Unknown error");
        }

        // ── Generate custom Meeting Stage HTML (iframe src pre-baked) ──
        let customStageUrl: string | null = null;
        {
          const brief = prepBrief || services.meetingPrepSkill?.currentBrief;
          const docUrl = resolveDocumentUrl(brief);
          console.log(`[Meeting] Stage check: prepBrief=${!!prepBrief}, currentBrief=${!!services.meetingPrepSkill?.currentBrief}, docUrl=${docUrl || "null"}, scenes=${brief?.scenes?.length || 0}, files=${brief?.filePaths?.length || 0}`);
          if (docUrl) {
            try {
              const docs = (brief?.filePaths || []).map((f: any) => ({
                name: f.path.split("/").pop() || f.path,
                path: f.path,
                badge: "new" as const,
              }));
              customStageUrl = await generateStageHtml({
                meetingId,
                title: meetTopic,
                documentUrl: docUrl,
                documents: docs,
              });
              console.log(`[Meeting] ✅ Custom Stage generated: ${customStageUrl}`);
            } catch (e: any) {
              console.warn(`[Meeting] Stage generation failed: ${e.message}`);
            }
          }
        }

        // Only emit meeting.started when ACTUALLY in the meeting (not waiting_room)
        const emitMeetingStarted = () => {
          services.meeting.startRecording();
          services.eventBus.startCorrelation("mtg");
          services.eventBus.emit("meeting.started", {
            url: validated.url,
            platform: validated.platform,
            meetingId,
            title: meetTopic,
          });
          services.eventBus.emit("voice.started", { audio_mode: "meet_bridge" });
          console.log("[Meeting] meeting.started emitted — now in meeting");

          // Self-introduction + presentation mode setup
          if (services.realtime.connected) {
            setTimeout(async () => {
              const ownerName = CONFIG.userEmail?.split("@")[0] || "";
              const topicSnippet = meetTopic && meetTopic !== "Meeting" ? meetTopic : "";
              // Auto-detect language from meeting title
              const meetingLang = detectLanguage(meetTopic || "");
              const intro = buildMeetingIntro(ownerName, topicSnippet, meetAttendees, meetingLang);
              console.log(`[Meeting] Language: ${meetingLang} (from title)`);
              services.realtime.sendText(intro);
              console.log("[Meeting] Self-introduction sent");

              // If we have a presentation script (speakingPlan + scenes), inject it
              const brief = prepBrief || services.meetingPrepSkill?.currentBrief;
              if (brief?.speakingPlan && brief.scenes?.length > 0) {
                // Primer message (EXP-7C finding: eliminates hallucination in first turns)
                services.realtime.injectContext(
                  `[PRESENTATION] 你即将进行一个 ${brief.speakingPlan.length} 部分的汇报，主题是"${brief.topic}"。每次收到 [PRESENT NOW] 内容块时，只讲那个部分的内容。引用具体数字和数据，不要编造。用自然的语气，像资深 PM 给老板做汇报。`
                );

                // Inject playbook context so voice knows the presentation plan
                injectMeetingBrief(services.realtime, brief);
                console.log(`[Meeting] ✅ Presentation mode: ${brief.speakingPlan.length} phases, ${brief.scenes.length} scenes (with primer)`);

                // Also inject the presentation ready context
                const readyCtx = buildPresentationReadyContext(brief.scenes);
                if (readyCtx) services.realtime.injectContext(readyCtx);

                // Idle nudge: if no conversation after 30s, prompt AI to start presenting
                const idleTimer = setTimeout(() => {
                  const recentEntries = services.context.getRecentTranscript(5);
                  const hasRealConversation = recentEntries.some(
                    (e: any) => e.role === "user" && e.text.length > 20 && (Date.now() - e.ts) < 25000
                  );
                  if (!hasRealConversation && services.realtime.connected) {
                    services.realtime.injectContext(buildIdleNudgeContext());
                    console.log("[Meeting] Idle nudge sent — prompting AI to start presentation");
                  }
                }, 30000);
                services.eventBus.on("meeting.ended", () => clearTimeout(idleTimer));
              }
            }, 2000);
          }
        };

        if (joinState === "in_meeting") {
          emitMeetingStarted();
        }

        // If stuck in waiting_room, keep polling in background until admitted (up to 5 min)
        const hasPageAccess = services.chromeLauncher?.page || services.playwrightCli?.connected;
        if (joinState === "waiting_room" && hasPageAccess) {
          console.log("[Meeting] In waiting room — background poll until admitted (max 5min)...");
          (async () => {
            for (let i = 0; i < 60; i++) { // 60 × 5s = 5 minutes
              await new Promise(r => setTimeout(r, 5000));
              try {
                const evalFn = `(() => {
                  var leave = document.querySelector('[aria-label*="Leave call"], [aria-label*="退出通话"]');
                  var controls = document.querySelector('[aria-label="Call controls"]');
                  if (leave || controls) return 'in_meeting';
                  var text = document.body.innerText;
                  if (text.includes('removed') || text.includes('kicked') || text.includes('denied')) return 'rejected';
                  return 'waiting';
                })()`;
                const check = services.chromeLauncher?.page
                  ? String(await services.chromeLauncher.page.evaluate(evalFn))
                  : await services.playwrightCli!.evaluate(evalFn);
                if (check.includes("in_meeting")) {
                  console.log("[Meeting] Admitted from waiting room! Triggering meeting.started...");
                  emitMeetingStarted();
                  // Activate audio pipeline now
                  if (services.chromeLauncher) {
                    try {
                      const pipelineResult = await services.chromeLauncher.activateAudioPipeline();
                      console.log("[Meeting] ✅ Audio pipeline activated (post-admit):", pipelineResult);
                    } catch (e: any) {
                      console.warn("[Meeting] Audio pipeline activation failed:", e.message);
                    }
                  }
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

        // Start admission monitor — prefer ChromeLauncher over playwright-cli
        const names = meetAttendees.filter((a: any) => !a.self).map((a: any) => a.displayName || a.email);
        if ((joinState === "in_meeting" || joinState === "waiting_room") && services.chromeLauncher?.page) {
          services.chromeLauncher.startAdmissionMonitor(
            names,
            3000,
            async (instruction: string) => {
              if (services.automationRouter) await services.automationRouter.execute(instruction);
            },
          );
          console.log(`[Meeting] Admission monitor started via ChromeLauncher (${names.length} attendees)`);
        } else if ((joinState === "in_meeting" || joinState === "waiting_room") && services.playwrightCli?.connected) {
          services.playwrightCli.startAdmissionMonitor(
            names,
            3000,
            async (instruction: string) => {
              if (services.automationRouter) await services.automationRouter.execute(instruction);
            },
          );
          console.log(`[Meeting] Admission monitor started via playwright-cli (${names.length} attendees)`);
        }

        // ── Auto-leave: detect when meeting ends (host ended, kicked, left via Meet UI) ──
        // Triggers the full leave flow: summary generation → file export → PostMeetingDelivery
        if (services.chromeLauncher?.page) {
          services.chromeLauncher.onMeetingEnd(async () => {
            console.log("[Meeting] Auto-leave: meeting ended detected by ChromeLauncher");
            try {
              // Stop monitors
              if (services.chromeLauncher?.isAdmissionMonitoring) {
                services.chromeLauncher.stopAdmissionMonitor();
              }

              // Mark session ended
              if (services.sessionManager) {
                const active = services.sessionManager.list({ status: "active" });
                if (active[0]) services.sessionManager.markEnded(active[0].meetingId);
              }

              // Generate summary + export
              const autoSummary = await services.meeting.generateSummary();
              const autoFilepath = await services.meeting.exportToMarkdown(autoSummary);
              services.meeting.stopRecording();
              console.log(`[Meeting] Auto-leave: summary exported → ${autoFilepath}`);

              // Create tasks from action items
              if (autoSummary.actionItems?.length > 0) {
                services.taskStore.createFromMeetingItems(
                  autoSummary.actionItems.map((a: any) => ({ task: a.task, assignee: a.assignee, deadline: a.deadline })),
                  services.eventBus.correlationId || undefined
                );
              }

              // Attach summary to session
              if (services.sessionManager && autoFilepath) {
                const ended = services.sessionManager.list({ status: "ended" });
                if (ended[0]) {
                  try {
                    const content = await Bun.file(autoFilepath).text();
                    await services.sessionManager.attachSummary(ended[0].meetingId, content);
                  } catch {}
                }
              }

              // Emit meeting.ended
              services.eventBus.emit("meeting.ended", {
                filepath: autoFilepath,
                summary: autoSummary,
                autoLeave: true,
              });
              services.eventBus.endCorrelation();

              // Trigger PostMeetingDelivery (OpenClaw → Telegram)
              if (services.postMeetingDelivery) {
                const endedSession = services.sessionManager?.list({ status: "ended" })[0];
                services.postMeetingDelivery.deliver({
                  summary: autoSummary,
                  notesFilePath: autoFilepath,
                  meetingId: endedSession?.meetingId,
                  prepSummary: services.meetingPrepSkill?.currentBrief ? {
                    topic: services.meetingPrepSkill.currentBrief.topic,
                    liveNotes: services.meetingPrepSkill.currentBrief.liveNotes || [],
                    completedTasks: (services.meetingPrepSkill.currentBrief.liveNotes || []).filter((n: string) => n.startsWith("[DONE]")),
                    requirements: (services.meetingPrepSkill.currentBrief.liveNotes || []).filter((n: string) => n.startsWith("[REQ]")),
                  } : null,
                }).catch((e: any) => console.error("[Meeting] Auto-leave delivery failed:", e.message));
              }

              // Stop voice session
              if (services.realtime.connected) {
                services.realtime.stop();
                services.eventBus.emit("voice.stopped", {});
              }

              console.log("[Meeting] Auto-leave complete — summary + delivery triggered");
            } catch (e: any) {
              console.error("[Meeting] Auto-leave failed:", e.message);
            }
          });
          console.log("[Meeting] Auto-leave watcher registered (detects host-end, kicked, left via Meet)");
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
          admissionMonitor: (joinState === "in_meeting" || joinState === "waiting_room") && (services.chromeLauncher?.page || services.playwrightCli?.connected)
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
            micDevice: "BlackHole 2ch",      // Meet mic: 2ch (Meet only reads first 2 channels)
            speakerDevice: "BlackHole 16ch",  // Meet speaker: 16ch (AI captures meeting audio)
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

        const session = services.sessionManager!.findOrCreate({ topic: body.topic });
        const meetingId = session.meetingId;

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
                const llmResp = await fetchWithRetry(`${CONFIG.openrouter.baseUrl}/chat/completions`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "Connection": "close",
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
                  signal: AbortSignal.timeout(10000),
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

            // ── Step 0.5: Check if meeting is too soon for prep ──
            const MIN_PREP_LEAD_MS = 10 * 60 * 1000;
            if (parsedStart) {
              const leadMs = new Date(parsedStart).getTime() - Date.now();
              if (leadMs > 0 && leadMs < MIN_PREP_LEAD_MS) {
                const minsAway = Math.round(leadMs / 60000);
                const deferred = new Date(Date.now() + MIN_PREP_LEAD_MS);
                deferred.setMinutes(Math.ceil(deferred.getMinutes() / 5) * 5, 0, 0);
                const deferredTime = deferred.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
                const deferredIso = deferred.toISOString();
                const deferredEndIso = new Date(deferred.getTime() + parsedDuration * 60000).toISOString();
                services.eventBus.emit("meeting.prep_progress", {
                  meetingId, step: "deferred",
                  message: `会议太近（${minsAway}分钟后），CallingClaw 需要至少 10 分钟准备调研和 Playbook。已自动推迟到 ${deferredTime}`,
                  originalStart: parsedStart,
                  startTime: deferredIso, endTime: deferredEndIso,
                });
                parsedStart = deferredIso;
                console.log(`[Delegate] Meeting too soon (${minsAway}min away), deferred to ${deferredTime}`);
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

              // Update session with extracted title, time, and meet URL
              services.sessionManager!.markReady(meetingId, { topic: title, meetUrl: meetUrl || undefined, startTime, calendarEventId: calEventId });

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

            // ── Step 2: Delegate to OpenClaw — dual-system meeting prep ──
            // Based on "Prompt 4: 双系统协作型" — voice brief + presentation plan
            const taskPrompt = [
              `用户想要准备一个会议，话题是: "${body.topic}"`,
              `会议ID（meetingId）: ${meetingId}`,
              meetUrl ? `Meet 链接（已创建，不要再创建日历！）: ${meetUrl}` : `（日历未创建，跳过）`,
              ``,
              `## 重要：不要创建日历事件！日历已由 CallingClaw 创建完毕。`,
              `## 也不要调用 /callingclaw prepare — 会导致重复创建日历。`,
              ``,
              `你要为 CallingClaw 的两个协作系统准备会议：`,
              `- System A: Voice Agent — 实时说话、回答问题、引导讨论`,
              `- System B: Presentation Engine — 打开页面、切换标签页、滚动、展示文件`,
              ``,
              `你的输出不是研究报告、不是产品文档、不是 launch 策略。`,
              `你的输出是"实时开会操作手册"——让 voice model 会开这场会。`,
              ``,
              `## Step 1: 深度调研（内部工作，不直接出现在 voice brief 里）`,
              `用你的完整能力（MEMORY.md + 项目文件 + git 历史）做深度调研。`,
              `**CRITICAL: Search MEMORY.md Lessons Learned for past mistakes related to this topic.**`,
              `调研结果放在文档最后的 Research 附录，不要混入 voice brief。`,
              ``,
              `## Step 2: 写入两个文件`,
              ``,
              `### 文件 1: Voice Brief（给 voice model 的操作手册）`,
              `文件路径: ~/.callingclaw/shared/${meetingId}_prep.md`,
              ``,
              `格式要求——每一句都要能直接说出口，不要写"文档段落"：`,
              ``,
              `\`\`\`markdown`,
              `# [会议标题]`,
              `> meetingId: ${meetingId}${meetUrl ? ` | Meet: ${meetUrl}` : ""}`,
              ``,
              `## 1. Meeting Basics`,
              `- Topic: [一句话]`,
              `- Type: [Pitch / Review / Strategy / Technical / Alignment]`,
              `- Goal: [这场会要达成什么——一句话]`,
              `- Desired outcome: [会后想要的结果]`,
              `- Audience: [参会人是谁，他们最关心什么]`,
              `- Tone: [专业/轻松/严肃/探索]`,
              ``,
              `## 2. One-Line Positioning`,
              `- 这场会真正要讲的是: [一句话]`,
              `- 希望大家带走的核心印象: [一句话]`,
              ``,
              `## 3. Opener`,
              `[20-40秒的开场白，自然口语，不要像在念PPT]`,
              ``,
              `## 4. Speaking Plan`,
              `### Phase 1: [阶段名] (~Xmin)`,
              `- Objective: [这段要达成什么]`,
              `- Key message: [核心信息一句话]`,
              `- Supporting points: [2-3个支撑点]`,
              `- Transition: [过渡到下一阶段的一句话]`,
              `- Show asset: [如果需要展示，写 asset ID；不需要就写 none]`,
              `- Avoid saying: [这个阶段不要说什么]`,
              ``,
              `### Phase 2: ...`,
              ``,
              `## 5. Expected Questions`,
              `### Q1: [问题]`,
              `- Short answer: [1-2句简答，先给这个]`,
              `- Deeper answer: [如果追问再展开]`,
              `- Show asset?: [yes/no, 如果 yes 写 asset ID]`,
              `- Confidence: [high/medium/low]`,
              `- If uncertain, say: [不确定时的话术]`,
              ``,
              `## 6. Presentation Triggers`,
              `[列出什么时候应该让 presentation engine 展示什么]`,
              `- Trigger: [什么情况下] → Show: [asset ID] → Say: [展示时说什么]`,
              ``,
              `## 7. Guardrails`,
              `- Do not overclaim: [哪些不能说死]`,
              `- If challenged: [被质疑时怎么说]`,
              `- If uncertain: [不确定时的话术模板]`,
              `- If interrupted: [被打断时怎么应对]`,
              ``,
              `## 8. Closing`,
              `- Land this conclusion: [要落的结论]`,
              `- Closing sentence: [结束语]`,
              `- Propose next step: [建议的下一步]`,
              ``,
              `## 9. Past Lessons (from MEMORY.md)`,
              `[和本次会议相关的历史教训，简要列出]`,
              ``,
              `---`,
              `## Research（附录——不注入 voice，仅 Desktop 侧边栏参考）`,
              `[深度调研内容放这里：背景、竞品、数据、历史等]`,
              `\`\`\``,
              ``,
              `### 文件 2: Presentation Plan（给 presentation engine 的演示计划）`,
              `文件路径: ~/.callingclaw/shared/${meetingId}_presentation.json`,
              ``,
              `JSON 格式：`,
              `\`\`\`json`,
              `{`,
              `  "scenes": [`,
              `    {`,
              `      "url": "https://example.com",`,
              `      "scrollTarget": "hero section 或 CSS 选择器",`,
              `      "talkingPoints": "展示时 voice 要说什么",`,
              `      "durationMs": 30000,`,
              `      "phase": "对应 Speaking Plan 的哪个 Phase"`,
              `    }`,
              `  ]`,
              `}`,
              `\`\`\``,
              ``,
              `注意：`,
              `- 故事线反推文件——根据 Speaking Plan 确定每个阶段需要展示哪个页面`,
              `- 优先使用用户提到的现有文件/URL，不要生成新文件`,
              `- 如果用户说"帮我讲一下xxx网页"，找到那个网页 URL 作为 scene`,
              `- 没有对应文件的阶段就不放 scene（纯语音讨论）`,
              `- 如果没有任何需要演示的内容，可以写空数组 {"scenes": []}`,
              ``,
              `## Step 3: 通知 CallingClaw 渲染`,
              `\`\`\`bash`,
              `curl -X POST http://localhost:4000/api/meeting/prep-result \\`,
              `  -H "Content-Type: application/json" \\`,
              `  -d '{"topic":"${title.replace(/'/g, "\\'")}","meetingId":"${meetingId}"${meetUrl ? `,"meetUrl":"${meetUrl}"` : ""}}'`,
              `\`\`\``,
              `CallingClaw 自动读取 ~/.callingclaw/shared/ 下的两个文件并渲染。`,
              `**不写文件 + 不调 API = Desktop 看不到！**`,
            ].join("\n");

            // Use isolated session to avoid history pollution from Memdex cron, old meetings, etc.
            await services.openclawBridge.sendTaskIsolated(taskPrompt);
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

        const { getMeetingFilePath, SHARED_DIR: SD } = await import("./modules/shared-documents");
        const sm = services.sessionManager!;

        // meetingId must be provided (generated by /api/meeting/delegate)
        const meetingId = body.meetingId || sm.generateId();

        // Resolve file path — by convention: {meetingId}_prep.md
        let filePath = body.filePath || getMeetingFilePath(meetingId, "prep");
        if (filePath.startsWith("~")) filePath = filePath.replace("~", process.env.HOME || "");

        // Read the markdown content
        let mdContent = "";
        try { mdContent = await Bun.file(filePath).text(); } catch {
          // Try the path OpenClaw might have used
          try { mdContent = await Bun.file(resolve(SHARED_DIR, meetingId + "_prep.md")).text(); } catch {}
        }

        // Check if presentation plan was also written
        let presentationPlan: any = null;
        const presentationPath = resolve(SHARED_DIR, meetingId + "_presentation.json");
        try {
          const raw = await Bun.file(presentationPath).text();
          presentationPlan = JSON.parse(raw);
          console.log(`[PrepResult] Presentation plan found: ${presentationPlan.scenes?.length || 0} scenes`);
        } catch {
          // No presentation plan — voice-only meeting, that's fine
        }

        // Update sessions index via SessionManager (merge files, don't overwrite)
        sm.update(meetingId, { topic: body.topic, meetUrl: body.meetUrl, calendarEventId: body.calendarEventId });
        sm.registerFile(meetingId, "prep", meetingId + "_prep.md");
        if (presentationPlan) {
          sm.registerFile(meetingId, "presentation", meetingId + "_presentation.json");
        }
        sm.markReady(meetingId);

        // If presentation plan has scenes, store them in the MeetingPrepBrief for auto-present
        if (presentationPlan?.scenes && services.meetingPrepSkill?.currentBrief) {
          const brief = services.meetingPrepSkill.currentBrief;
          brief.scenes = presentationPlan.scenes;
          console.log(`[PrepResult] Loaded ${brief.scenes.length} scenes into MeetingPrepBrief`);
        }

        // Emit event — Desktop renders markdown directly
        services.eventBus.emit("meeting.prep_ready", {
          topic: body.topic,
          title: body.topic,
          meetingId,
          meetUrl: body.meetUrl || null,
          calendarEventId: body.calendarEventId || null,
          filePath,
          mdContent, // Desktop can render directly without another file read
          hasPresentation: !!presentationPlan,
          scenesCount: presentationPlan?.scenes?.length || 0,
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
        const prepMeetingId = services.sessionManager!.generateId();

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
                  const llmResp = await fetchWithRetry(`${CONFIG.openrouter.baseUrl}/chat/completions`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "Connection": "close", Authorization: `Bearer ${CONFIG.openrouter.apiKey}` },
                    body: JSON.stringify({
                      model: CONFIG.analysis?.model || "anthropic/claude-haiku-4-5",
                      messages: [{ role: "user", content: `Extract meeting info. Current: ${now.toISOString()} (${tzName})\nInput: "${body.topic}"\nJSON only: {"title":"concise title same language max 40 chars","startTime":"ISO8601 or null","duration":minutes_or_60}` }],
                      max_tokens: 100, temperature: 0,
                    }),
                    signal: AbortSignal.timeout(10000),
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

      // DELETE /api/meeting/:id — Remove a meeting session from sessions.json + MeetingDB
      if (url.pathname.startsWith("/api/meeting/") && req.method === "DELETE") {
        const meetingId = url.pathname.split("/").pop();
        if (meetingId) {
          services.sessionManager!.delete(meetingId);
          // Also delete from MeetingDB (SQLite)
          if (services.meetingDB) {
            try { services.meetingDB.delete(meetingId); } catch {}
          }
          return Response.json({ ok: true, deleted: meetingId }, { headers });
        }
        return Response.json({ error: "meetingId required" }, { status: 400, headers });
      }

      // POST /api/meeting/leave — Leave current meeting + generate follow-up report
      if (url.pathname === "/api/meeting/leave" && req.method === "POST") {
        // Stop admission monitor if running (ChromeLauncher or playwright-cli)
        if (services.chromeLauncher?.isAdmissionMonitoring) {
          services.chromeLauncher.stopAdmissionMonitor();
          services.chromeLauncher.clearMeetingEndCallback();
        } else if (services.playwrightCli?.isAdmissionMonitoring) {
          services.playwrightCli.stopAdmissionMonitor();
        }

        // Mark session ended FIRST (before summary which may fail)
        if (services.sessionManager) {
          const activeSessions = services.sessionManager.list({ status: "active" });
          if (activeSessions[0]) services.sessionManager.markEnded(activeSessions[0].meetingId);
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

        // Attach summary to session (already marked ended above)
        if (services.sessionManager && filepath) {
          const endedSessions = services.sessionManager.list({ status: "ended" });
          if (endedSessions[0]) {
            try {
              const summaryContent = await Bun.file(filepath).text();
              await services.sessionManager.attachSummary(endedSessions[0].meetingId, summaryContent);
            } catch {}
          }
        }

        services.eventBus.emit("meeting.ended", followUp);
        services.eventBus.endCorrelation();

        // Trigger smart todo delivery (non-blocking)
        if (services.postMeetingDelivery) {
          const endedSession = services.sessionManager?.list({ status: "ended" })[0];
          services.postMeetingDelivery.deliver({
            summary,
            notesFilePath: filepath,
            meetingId: endedSession?.meetingId,
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
        const existing = services.sessionManager!.list({ status: "active" })[0]
          || services.sessionManager!.list({ status: "preparing" })[0];
        const session = existing || services.sessionManager!.create({ topic, status: "active" });
        const meetingId = session.meetingId;

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
              const itemId = injectMeetingBrief(services.realtime, prepResult.brief);
              if (itemId) {
                console.log(`[TalkLocally] ✅ Layer 2 brief injected (${prepResult.brief.keyPoints?.length || 0} key points, item: ${itemId})`);
              } else {
                console.warn("[TalkLocally] ⚠️ Brief injection returned false");
              }
            } else {
              console.warn("[TalkLocally] ⚠️ Voice not connected — brief generated but NOT injected");
            }
          } catch (e: any) {
            console.warn("[TalkLocally] ❌ Prep brief failed (continuing without):", e.message);
          }
        } else {
          console.warn(`[TalkLocally] ⚠️ Skipping prep brief: meetingPrepSkill=${!!services.meetingPrepSkill}, openClaw=${services.openclawBridge?.connected ?? false}`);
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

        // Mark session ended FIRST (before summary which may fail)
        if (services.sessionManager) {
          const activeSessions = services.sessionManager.list({ status: "active" });
          const activeSession = activeSessions[0];
          if (activeSession) {
            services.sessionManager.markEnded(activeSession.meetingId);
          }
        }

        // Generate summary + export markdown (may fail if no transcript)
        let summary: any = { topic: "", decisions: [], actionItems: [], keyPoints: [] };
        let filepath = "";
        try {
          summary = await services.meeting.generateSummary();
          filepath = await services.meeting.exportToMarkdown(summary);
        } catch (e: any) {
          console.warn("[TalkLocally/Stop] Summary generation failed:", e.message);
        }
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

        // Attach summary to session if available (session already marked ended above)
        if (services.sessionManager && filepath) {
          const activeSessions = services.sessionManager.list({ status: "ended" });
          const endedSession = activeSessions[0];
          if (endedSession) {
            try {
              const summaryContent = await Bun.file(filepath).text();
              await services.sessionManager.attachSummary(endedSession.meetingId, summaryContent);
            } catch {}
          }
        }

        services.eventBus.emit("meeting.ended", followUp);
        services.eventBus.endCorrelation();

        // Trigger post-meeting delivery (non-blocking)
        if (services.postMeetingDelivery) {
          const deliverySession = services.sessionManager?.list({ status: "ended" })[0];
          services.postMeetingDelivery.deliver({
            summary,
            notesFilePath: filepath,
            meetingId: deliverySession?.meetingId,
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
      // ── Screen Sharing API (legacy routes → redirect to ChromeLauncher) ──
      // New handlers are below in the Bridge/Google/Static section.
      // These legacy routes are kept for backward compatibility but now
      // prefer ChromeLauncher over meetJoiner osascript.
      // ══════════════════════════════════════════════════════════════

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
        // Fallback to SessionManager (reads sessions.json)
        if (services.sessionManager) {
          return Response.json(services.sessionManager.getManifest(), { headers });
        }
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
        } catch {
          // Return 200 with null content instead of 404 (avoids console noise in Desktop)
          return Response.json({ path: filePath, content: null }, { headers });
        }
      }

      // GET /api/meeting/frame/:meetingId/:filename — Serve meeting screenshot frame
      if (url.pathname.startsWith("/api/meeting/frame/") && req.method === "GET") {
        const parts = url.pathname.replace("/api/meeting/frame/", "").split("/");
        const meetingId = parts[0];
        const filename = parts[1];
        if (!meetingId || !filename) {
          return Response.json({ error: "meetingId and filename required" }, { status: 400, headers });
        }
        const framePath = resolve(homedir(), ".callingclaw", "shared", "meetings", meetingId, "frames", filename);
        const file = Bun.file(framePath);
        if (await file.exists()) {
          return new Response(file, { headers: { ...headers, "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" } });
        }
        return Response.json({ error: "Frame not found" }, { status: 404, headers });
      }

      // GET /api/meeting/summary/:meetingId — Serve branded HTML meeting summary
      if (url.pathname.startsWith("/api/meeting/summary/") && req.method === "GET") {
        const meetingId = url.pathname.replace("/api/meeting/summary/", "");
        if (!meetingId) {
          return Response.json({ error: "meetingId required" }, { status: 400, headers });
        }
        const summaryPath = resolve(homedir(), ".callingclaw", "shared", "meetings", meetingId, "summary.html");
        const file = Bun.file(summaryPath);
        if (await file.exists()) {
          return new Response(file, { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
        }
        return Response.json({ error: "Summary not found" }, { status: 404, headers });
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

      // GET /api/capabilities — Dynamic capability discovery for OpenClaw / external callers
      // Ensures callers always get current config without hardcoding
      if (url.pathname === "/api/capabilities" && req.method === "GET") {
        return Response.json({
          version: CONFIG.version,
          voiceProvider: CONFIG.voiceProvider,
          transcriptionLanguage: CONFIG.transcriptionLanguage,
          features: {
            meetingStage: true,           // Pre-generated Stage HTML with iframe
            markdownRenderer: true,       // /render.html?file=... for any .md file
            iframeScroll: true,           // Scroll iframe content via API
            interactTool: true,           // Click/scroll/navigate on presenting page
            readPrepTool: true,           // Zero-cost prep section queries
            naturalUrlResolution: true,   // "官网" → resolved from prep brief
            dualSystemPanels: true,       // System One (Voice) + System Two (Agent)
          },
          tools: [
            "share_screen", "stop_sharing", "interact", "read_prep", "search_files",
            "open_file", "leave_meeting", "recall_context", "take_screenshot",
          ],
          prepFiles: (() => {
            try {
              const fs = require("fs");
              const home = require("os").homedir();
              return fs.readdirSync(`${home}/.callingclaw/shared`)
                .filter((f: string) => f.endsWith("_prep.json") || f.endsWith("_compiled.json"))
                .map((f: string) => `${home}/.callingclaw/shared/${f}`);
            } catch { return []; }
          })(),
        }, { headers });
      }

      // GET /api/audio/status — Audio pipeline diagnostic
      if (url.pathname === "/api/audio/status" && req.method === "GET") {
        const log = (() => { try { return require("child_process").execSync("strings /tmp/callingclaw-backend.log | tail -100").toString(); } catch { return ""; } })();
        const audioChunks = (log.match(/Mic audio chunk/g) || []).length;
        const pipelineReady = log.includes("pipeline_ready");
        const echoSuppressed = (log.match(/Echo suppressed/g) || []).length;
        const interrupted = (log.match(/interrupted AI response/g) || []).length;
        const speechStarted = (log.match(/speech_started/g) || []).length;
        const audioDeltas = (log.match(/response\.audio\.d/g) || []).length;
        return Response.json({
          pipeline: pipelineReady ? "ready" : "not_ready",
          capture: { chunks: audioChunks, flowing: audioChunks > 0 },
          playback: { audioDeltas, hasOutput: audioDeltas > 0 },
          echo: { suppressed: echoSuppressed },
          vad: { speechStarted, interrupted },
        }, { headers });
      }

      // GET /api/stage/documents — Working documents on the Meeting Stage
      if (url.pathname === "/api/stage/documents" && req.method === "GET") {
        return Response.json({ documents: services.context.stageDocuments }, { headers });
      }

      // GET /api/file/read — Read a local file (for markdown renderer + voice context)
      if (url.pathname === "/api/file/read" && req.method === "GET") {
        const filePath = url.searchParams.get("path");
        if (!filePath) return Response.json({ error: "path required" }, { status: 400, headers });
        // Security: only allow reading from known safe directories
        const safePrefixes = [
          require("os").homedir() + "/.callingclaw/",
          require("os").homedir() + "/.openclaw/",
          require("os").homedir() + "/Library/Mobile Documents/com~apple~CloudDocs/Tanka/",
          require("os").homedir() + "/Library/Mobile Documents/com~apple~CloudDocs/CallingClaw",
        ];
        const resolved = require("path").resolve(filePath);
        if (!safePrefixes.some(p => resolved.startsWith(p))) {
          return Response.json({ error: "Access denied — path outside allowed directories" }, { status: 403, headers });
        }
        try {
          const content = await Bun.file(resolved).text();
          return Response.json({ content, path: resolved, size: content.length }, { headers });
        } catch (e: any) {
          return Response.json({ error: `File not found: ${e.message}` }, { status: 404, headers });
        }
      }

      // POST /api/screen/iframe/load — Load URL into stage slide iframe
      if (url.pathname === "/api/screen/iframe/load" && req.method === "POST") {
        if (!services.chromeLauncher?.presentingPage) {
          return Response.json({ error: "No presenting tab — start screen sharing first" }, { status: 400, headers });
        }
        const body = (await req.json().catch(() => ({}))) as { url?: string };
        if (!body.url) return Response.json({ error: "url required" }, { status: 400, headers });
        const ok = await services.chromeLauncher.loadSlideFrame(body.url);
        return Response.json({ success: ok }, { headers });
      }

      // POST /api/screen/share — Share a URL or entire screen in Meet
      if (url.pathname === "/api/screen/share" && req.method === "POST") {
        if (!services.chromeLauncher?.page) {
          return Response.json({ error: "ChromeLauncher not active — join a meeting first" }, { status: 400, headers });
        }
        const body = (await req.json().catch(() => ({}))) as { url?: string };
        let shareUrl = body.url;
        // If no URL specified, use pre-generated Stage HTML (has iframe content baked in)
        if (!shareUrl) {
          try {
            const fs = require("fs");
            const publicDir = require("path").resolve(import.meta.dir, "../public");
            const stageFiles = fs.readdirSync(publicDir)
              .filter((f: string) => f.startsWith("stage-") && f.endsWith(".html") && f !== "stage.html")
              .map((f: string) => ({ name: f, mtime: fs.statSync(`${publicDir}/${f}`).mtimeMs }))
              .sort((a: any, b: any) => b.mtime - a.mtime);
            if (stageFiles[0]) {
              shareUrl = `http://localhost:${CONFIG.port}/${stageFiles[0].name}`;
              console.log(`[API] Using pre-generated Stage: ${shareUrl}`);
            }
          } catch {}
        }
        // If presenting tab exists, navigate it. Then ensure Meet is sharing.
        if (shareUrl && services.chromeLauncher.presentingPage) {
          try {
            await services.chromeLauncher.navigatePresentingPage(shareUrl);
            console.log(`[API] Navigated presenting tab to ${shareUrl} (reused)`);
            // If Meet isn't sharing yet, start sharing
            if (!services.chromeLauncher.isSharing) {
              console.log(`[API] Meet not sharing yet — calling shareScreen(${shareUrl?.slice(0, 50)})`);
              const startResult = await services.chromeLauncher.shareScreen(shareUrl);
              console.log(`[API] shareScreen result: ${JSON.stringify(startResult)}`);
              return Response.json(startResult, { headers });
            }
            return Response.json({ success: true, message: `Presenting: ${shareUrl}` }, { headers });
          } catch {
            // Navigate failed — fall through to new share
          }
        }
        const result = await services.chromeLauncher.shareScreen(shareUrl);
        return Response.json(result, { headers });
      }

      // POST /api/screen/stop — Stop screen sharing
      if (url.pathname === "/api/screen/stop" && req.method === "POST") {
        if (!services.chromeLauncher?.page) {
          return Response.json({ error: "ChromeLauncher not active" }, { status: 400, headers });
        }
        const result = await services.chromeLauncher.stopSharing();
        return Response.json(result, { headers });
      }

      // POST /api/screen/scroll — Scroll the presenting tab (or iframe if on Stage)
      if (url.pathname === "/api/screen/scroll" && req.method === "POST") {
        if (!services.chromeLauncher?.presentingPage) {
          return Response.json({ error: "No presenting tab open" }, { status: 400, headers });
        }
        const body = (await req.json().catch(() => ({}))) as { direction?: "up" | "down"; target?: string; pixels?: number };

        // If on Stage, scroll the IFRAME content (not the Stage outer page)
        const pageUrl = String(services.chromeLauncher.presentingPage.url());
        const isOnStage = pageUrl.includes("/stage") || pageUrl.includes("callingclaw-stage-");
        if (isOnStage) {
          try {
            const px = body.pixels || 500;
            const dir = body.direction === "up" ? -px : px;
            // Scroll inside the iframe's contentDocument
            const iframeResult = await services.chromeLauncher.evaluateOnPresentingPage(`(() => {
              var iframe = document.getElementById('slideFrame');
              if (!iframe || !iframe.contentWindow) return JSON.stringify({ error: 'no iframe access' });
              // Use contentWindow.scrollBy — works regardless of scroll container (body vs documentElement)
              iframe.contentWindow.scrollBy({ top: ${dir}, behavior: 'smooth' });
              // Read position from whichever element has the scroll
              var doc = iframe.contentDocument;
              var st = Math.max(doc.documentElement.scrollTop, doc.body.scrollTop);
              var sh = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight);
              var ch = iframe.clientHeight;
              return JSON.stringify({
                scrollY: Math.round(st),
                scrollMax: Math.round(sh - ch),
                pct: Math.round(st / Math.max(1, sh - ch) * 100)
              });
            })()`);
            const info = iframeResult ? JSON.parse(String(iframeResult)) : null;
            return Response.json({
              success: true,
              result: info ? `iframe scrolled ${body.direction || "down"}: ${info.pct}% (${info.scrollY}/${info.scrollMax}px)` : "iframe scrolled"
            }, { headers });
          } catch (e: any) {
            return Response.json({ success: false, error: `iframe scroll failed: ${e.message}` }, { headers });
          }
        }

        try {
          let scrollResult: any;
          if (body.target) {
            // Scroll to a specific element by text content or CSS selector
            scrollResult = await services.chromeLauncher.evaluateOnPresentingPage(`(() => {
              // Try finding by text content
              var target = ${JSON.stringify(body.target)};
              var all = document.querySelectorAll('h1,h2,h3,h4,h5,h6,section,[id],p,div');
              for (var el of all) {
                var text = (el.textContent || '').trim();
                if (text.toLowerCase().includes(target.toLowerCase())) {
                  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  return 'scrolled_to:' + text.substring(0, 60);
                }
              }
              // Try by ID
              var byId = document.getElementById(target) || document.querySelector(target);
              if (byId) { byId.scrollIntoView({ behavior: 'smooth', block: 'center' }); return 'scrolled_to_id:' + target; }
              return 'target_not_found';
            })()`);
          } else {
            // Scroll by direction/pixels
            const px = body.pixels || 500;
            const dir = body.direction === "up" ? -px : px;
            await services.chromeLauncher.evaluateOnPresentingPage(`window.scrollBy({ top: ${dir}, behavior: 'smooth' })`);
            scrollResult = `scrolled_${body.direction || "down"}_${px}px`;
          }
          return Response.json({ success: true, result: String(scrollResult) }, { headers });
        } catch (e: any) {
          return Response.json({ success: false, error: e.message }, { headers });
        }
      }

      // POST /api/screen/snapshot — Get presenting tab DOM snapshot
      if (url.pathname === "/api/screen/snapshot" && req.method === "GET") {
        if (!services.chromeLauncher?.presentingPage) {
          return Response.json({ error: "No presenting tab" }, { status: 400, headers });
        }
        const snapshot = await services.chromeLauncher.snapshotPresentingPage();
        return Response.json({ snapshot }, { headers });
      }

      // POST /api/screen/present — Start a synchronized presentation (Haiku reads page → Grok narrates → scroll synced)
      if (url.pathname === "/api/screen/present" && req.method === "POST") {
        if (!services.chromeLauncher?.page) {
          return Response.json({ error: "Join a meeting first" }, { status: 400, headers });
        }
        const body = (await req.json().catch(() => ({}))) as { url?: string; topic?: string; context?: string };
        if (!body.url) {
          return Response.json({ error: "url is required" }, { status: 400, headers });
        }

        try {
          const { PresentationEngine } = await import("./modules/presentation-engine");
          const engine = new PresentationEngine();

          // Share the URL first
          await services.chromeLauncher.shareScreen(body.url);
          await new Promise(r => setTimeout(r, 4000)); // Wait for page load

          // Build plan (Haiku reads DOM + meeting brief context)
          const brief = services.meetingPrepSkill?.currentBrief;
          const plan = await engine.buildPlan({
            url: body.url,
            topic: body.topic || "presentation",
            context: body.context,
            briefContext: brief ? {
              goal: brief.goal,
              summary: brief.summary,
              keyPoints: brief.keyPoints,
              architectureDecisions: brief.architectureDecisions,
              expectedQuestions: brief.expectedQuestions,
              previousContext: brief.previousContext,
              attendees: brief.attendees,
              liveNotes: brief.liveNotes,
            } : undefined,
            chromeLauncher: services.chromeLauncher,
          });

          // Run in background (non-blocking)
          engine.run({
            chromeLauncher: services.chromeLauncher,
            voice: services.realtime,
            context: services.context,
            onSlide: (slide, i, total) => {
              services.eventBus.emit("presentation.slide", { slide: slide.sectionTitle, index: i, total });
            },
          }).then((result) => {
            services.eventBus.emit("presentation.done", result);
            console.log(`[Presentation] Done: ${result.slidesPresented} slides`);
          }).catch((e) => {
            console.error("[Presentation] Error:", e.message);
          });

          return Response.json({
            success: true,
            slides: plan.slides.length,
            totalEstimatedMs: plan.totalEstimatedMs,
            plan: plan.slides.map(s => ({ title: s.sectionTitle, durationMs: s.estimatedDurationMs })),
          }, { headers });
        } catch (e: any) {
          return Response.json({ error: e.message }, { status: 500, headers });
        }
      }

      // ══════════════════════════════════════════════════════════════
      // ── Standalone Presentation: Prepare → Start (no meeting required) ──
      // ══════════════════════════════════════════════════════════════

      // POST /api/screen/present/prepare — Generate story arc + slide plan (async)
      // Returns immediately with prepId. Notifies via EventBus + macOS notification when ready.
      // Must complete BEFORE /start (Bun fetch breaks after Playwright launches)
      if (url.pathname === "/api/screen/present/prepare" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { url?: string; topic?: string; context?: string };
        if (!body.url) {
          return Response.json({ error: "url is required" }, { status: 400, headers });
        }

        const prepId = `pres_${Date.now().toString(36)}`;
        const presDir = `${process.env.CALLINGCLAW_HOME || process.env.HOME + "/.callingclaw"}/shared/presentations`;

        // Return immediately — preparation runs in background
        services.eventBus.emit("presentation.preparing", { prepId, topic: body.topic, url: body.url });

        // Background: read → analyze → plan → save → notify
        (async () => {
          try {
            const { PresentationEngine } = await import("./modules/presentation-engine");

            // Step 1: Read HTML content
            console.log(`[PresentPrep] ${prepId} — Reading page content...`);
            let htmlContent = "";
            if (body.url!.startsWith("http://localhost") && body.url!.includes(`:${CONFIG.port}/`)) {
              const filename = body.url!.replace(/^http:\/\/localhost:\d+\//, "");
              htmlContent = await Bun.file(`${import.meta.dir}/../public/${filename}`).text();
            } else if (body.url!.startsWith("file://")) {
              htmlContent = await Bun.file(decodeURIComponent(body.url!.replace("file://", ""))).text();
            } else {
              const resp = await fetch(body.url!, { signal: AbortSignal.timeout(10000) });
              htmlContent = await resp.text();
            }

            const textSnapshot = htmlContent
              .replace(/<style[\s\S]*?<\/style>/gi, "")
              .replace(/<script[\s\S]*?<\/script>/gi, "")
              .replace(/<[^>]+>/g, "\n")
              .replace(/&[a-z]+;/gi, " ")
              .replace(/\n{3,}/g, "\n\n")
              .trim()
              .substring(0, 6000);

            // Step 2: Story-first — generate PresentationBriefContext
            console.log(`[PresentPrep] ${prepId} — Generating story arc (Haiku)...`);
            const engine = new PresentationEngine();
            const brief = await engine.generateBriefFromContent({
              textSnapshot,
              topic: body.topic || "presentation",
              context: body.context,
            });

            // Step 3: Map story beats to scroll positions
            console.log(`[PresentPrep] ${prepId} — Building slide plan...`);
            const snapshotAdapter = {
              async snapshotPresentingPage() { return textSnapshot; },
              async evaluateOnPresentingPage() { return null; },
              async navigatePresentingPage() { return true; },
              async shareScreen() {},
            };
            const plan = await engine.buildPlan({
              url: body.url!,
              topic: body.topic || "presentation",
              context: body.context,
              briefContext: brief,
              chromeLauncher: snapshotAdapter,
            });

            // Step 4: Save prep to disk
            await Bun.$`mkdir -p ${presDir}`;
            const prep = {
              id: prepId, status: "ready" as const,
              topic: body.topic || "presentation", sourceUrl: body.url,
              brief, plan, createdAt: Date.now(),
            };
            await Bun.write(`${presDir}/${prepId}.json`, JSON.stringify(prep, null, 2));
            console.log(`[PresentPrep] ${prepId} — Ready! ${plan.slides.length} slides, ~${Math.round(plan.totalEstimatedMs / 1000)}s`);

            // Step 5: Notify — EventBus + macOS notification
            const startUrl = `http://localhost:${CONFIG.port}/api/screen/present/start/${prepId}`;
            services.eventBus.emit("presentation.prepared", {
              prepId, topic: prep.topic, slides: plan.slides.length,
              totalEstimatedMs: plan.totalEstimatedMs, startUrl,
              brief: { goal: brief.goal, keyPoints: brief.keyPoints },
              plan: plan.slides.map(s => ({ title: s.sectionTitle, durationMs: s.estimatedDurationMs })),
            });

            // macOS notification
            const slideList = plan.slides.map((s: any) => s.sectionTitle).join(", ");
            Bun.spawn(["osascript", "-e",
              `display notification "Presentation ready: ${plan.slides.length} slides\\n${slideList}" with title "CallingClaw" subtitle "${prep.topic}"`,
            ]);

          } catch (e: any) {
            console.error(`[PresentPrep] ${prepId} — Failed:`, e.message);
            // Save error status
            await Bun.$`mkdir -p ${presDir}`.catch(() => {});
            await Bun.write(`${presDir}/${prepId}.json`, JSON.stringify({
              id: prepId, status: "error", error: e.message,
              topic: body.topic, sourceUrl: body.url, createdAt: Date.now(),
            }));
            services.eventBus.emit("presentation.error", { prepId, error: e.message });
            Bun.spawn(["osascript", "-e",
              `display notification "Preparation failed: ${e.message}" with title "CallingClaw" subtitle "Presentation Error"`,
            ]);
          }
        })();

        return Response.json({
          accepted: true,
          prepId,
          status: "preparing",
          message: "Preparation started. You'll be notified when ready (macOS notification + EventBus).",
          statusUrl: `http://localhost:${CONFIG.port}/api/screen/present/prep/${prepId}`,
        }, { headers });
      }

      // GET /api/screen/present/prep/:id — Return saved prep JSON
      if (url.pathname.startsWith("/api/screen/present/prep/") && req.method === "GET") {
        const prepId = url.pathname.replace("/api/screen/present/prep/", "");
        const presDir = `${process.env.CALLINGCLAW_HOME || process.env.HOME + "/.callingclaw"}/shared/presentations`;
        const file = Bun.file(`${presDir}/${prepId}.json`);
        if (await file.exists()) {
          return Response.json(JSON.parse(await file.text()), { headers });
        }
        return Response.json({ error: "Prep not found" }, { status: 404, headers });
      }

      // POST /api/screen/present/start/:id — Launch Playwright + voice + TranscriptAuditor
      // User should have voice-test.html open for audio before calling this
      if (url.pathname.startsWith("/api/screen/present/start/") && req.method === "POST") {
        const prepId = url.pathname.replace("/api/screen/present/start/", "");
        const presDir = `${process.env.CALLINGCLAW_HOME || process.env.HOME + "/.callingclaw"}/shared/presentations`;
        const file = Bun.file(`${presDir}/${prepId}.json`);
        if (!(await file.exists())) {
          return Response.json({ error: "Prep not found — call /prepare first" }, { status: 404, headers });
        }

        try {
          const prep = JSON.parse(await file.text());
          const { PresentationEngine } = await import("./modules/presentation-engine");
          const { buildTestPresentationContext } = await import("./voice-persona");

          // Step 1: Start voice session if not already connected
          if (!services.realtime.connected) {
            console.log("[PresentStart] Starting voice session...");
            await startVoiceSession({ transport: "direct", mode: "default" });
          }

          // Step 2: Inject presenter context (Layer 2)
          const presContext = buildTestPresentationContext(prep.brief, prep.plan);
          services.realtime.injectContext(presContext);
          console.log("[PresentStart] Presenter context injected");

          // Step 3: Launch Playwright with ChromeLauncher (reuse production code)
          console.log("[PresentStart] Launching browser...");
          await services.chromeLauncher.launchStandalone();

          // Step 4: Navigate to source URL
          // Copy to /tmp if source has spaces in path
          let targetUrl = prep.sourceUrl;
          if (prep.sourceUrl.startsWith("http://localhost") && prep.sourceUrl.includes(`:${CONFIG.port}/`)) {
            const filename = prep.sourceUrl.replace(/^http:\/\/localhost:\d+\//, "");
            const localPath = `${import.meta.dir}/../public/${filename}`;
            const tmpPath = `/tmp/callingclaw-present-${filename.replace(/[^a-zA-Z0-9.-]/g, "_")}`;
            await Bun.write(tmpPath, Bun.file(localPath));
            targetUrl = "file://" + tmpPath;
          }
          await services.chromeLauncher.navigatePresentingPage(targetUrl);
          console.log(`[PresentStart] Page loaded: ${targetUrl}`);

          // Step 5: Activate TranscriptAuditor (voice command → click/scroll)
          if (services.transcriptAuditor && !services.transcriptAuditor.active) {
            services.transcriptAuditor.activate(services.realtime);
            console.log("[PresentStart] TranscriptAuditor activated");
          }

          // Step 6: Run presentation in background
          const engine = new PresentationEngine();
          const isScript = prep.version === 1 && prep.steps; // v1 script format

          if (isScript) {
            // New script format (produced by OpenClaw)
            engine.runScript({
              script: prep,
              chromeLauncher: services.chromeLauncher,
              voice: services.realtime,
              context: services.context,
              onStep: (step: any, i: number, total: number) => {
                services.eventBus.emit("presentation.slide", { slide: `${step.action}: ${step.target || step.url || ""}`, index: i, total });
              },
            }).then((result: any) => {
              services.eventBus.emit("presentation.done", result);
              console.log(`[PresentStart] Script done: ${result.stepsExecuted} steps`);
            }).catch((e: any) => {
              console.error("[PresentStart] Script error:", e.message);
            });
          } else {
            // Legacy plan format (built by Haiku buildPlan)
            engine._plan = prep.plan;
            engine.run({
              chromeLauncher: services.chromeLauncher,
              voice: services.realtime,
              context: services.context,
              onSlide: (slide: any, i: number, total: number) => {
                services.eventBus.emit("presentation.slide", { slide: slide.sectionTitle, index: i, total });
              },
            }).then((result: any) => {
              services.eventBus.emit("presentation.done", result);
              console.log(`[PresentStart] Done: ${result.slidesPresented} slides`);
            }).catch((e: any) => {
              console.error("[PresentStart] Run error:", e.message);
            });
          }

          const stepCount = isScript ? prep.steps.length : prep.plan?.slides?.length || 0;
          const totalMs = isScript ? prep.totalDurationMs : prep.plan?.totalEstimatedMs || 0;

          return Response.json({
            success: true,
            prepId,
            mode: isScript ? "script_v1" : "legacy_plan",
            steps: stepCount,
            totalEstimatedMs: totalMs,
            voiceConnected: services.realtime.connected,
            auditorActive: services.transcriptAuditor?.active || false,
          }, { headers });
        } catch (e: any) {
          console.error("[PresentStart] Error:", e.message);
          return Response.json({ error: e.message }, { status: 500, headers });
        }
      }

      // POST /api/screen/present/pause — Pause presentation
      if (url.pathname === "/api/screen/present/pause" && req.method === "POST") {
        // TODO: store engine instance globally for pause/resume
        return Response.json({ ok: true, message: "Paused" }, { headers });
      }

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

      // ══════════════════════════════════════════════════════════════
      // ── Google Auth Onboarding — Check + Chrome Login ──
      // ══════════════════════════════════════════════════════════════

      // GET /api/google/auth-status — Check both Calendar OAuth + Chrome Google login
      if (url.pathname === "/api/google/auth-status" && req.method === "GET") {
        const calendarConnected = services.calendar?.connected ?? false;
        const hasCalendarCreds = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_REFRESH_TOKEN);

        // Check Chrome Google login via cookie check (fast)
        let chromeLoggedIn = false;
        let chromeEmail: string | null = null;
        if (services.chromeLauncher?.page) {
          try {
            const checkResult = await services.chromeLauncher.checkGoogleLogin();
            chromeLoggedIn = checkResult.loggedIn;
            chromeEmail = checkResult.email;
          } catch {}
        }

        // Auto-connect Calendar if Chrome is logged in but Calendar isn't
        let calConnected = calendarConnected;
        if (chromeLoggedIn && !calendarConnected) {
          try {
            const { credentials } = await scanForGoogleCredentials();
            if (credentials) {
              services.calendar.setCredentials(credentials);
              await services.calendar.connect();
              calConnected = services.calendar.connected;
              if (calConnected) console.log("[GoogleAuth] Calendar auto-connected via auth-status poll");
            }
          } catch {}
        }

        return Response.json({
          ready: chromeLoggedIn,
          calendar: {
            connected: calConnected,
            hasCredentials: hasCalendarCreds,
          },
          chrome: {
            loggedIn: chromeLoggedIn,
            email: chromeEmail,
            profileDir: services.chromeLauncher ? "active" : "not_launched",
          },
          nextStep: !chromeLoggedIn
            ? "chrome_login"
            : !calConnected
              ? "calendar_oauth"
              : null, // All good
        }, { headers });
      }

      // POST /api/google/chrome-login — Open Chrome to Google sign-in page
      // Returns immediately; user signs in manually. Poll /auth-status to check completion.
      if (url.pathname === "/api/google/chrome-login" && req.method === "POST") {
        if (!services.chromeLauncher) {
          return Response.json({ error: "ChromeLauncher not available" }, { status: 500, headers });
        }

        try {
          // Ensure Chrome is launched
          await services.chromeLauncher.launch();

          // Navigate to Google sign-in
          const page = services.chromeLauncher.page;
          if (!page) {
            return Response.json({ error: "No page available" }, { status: 500, headers });
          }

          // Clear login cache so next check is fresh
          services.chromeLauncher.clearGoogleLoginCache();
          await page.goto("https://accounts.google.com", { waitUntil: "domcontentloaded", timeout: 15000 });
          console.log("[GoogleAuth] Opened accounts.google.com for user sign-in");

          return Response.json({
            ok: true,
            message: "Chrome opened to Google sign-in. Please sign in, then call /api/google/auth-status to verify.",
            pollUrl: "/api/google/auth-status",
          }, { headers });
        } catch (e: any) {
          return Response.json({ error: e.message }, { status: 500, headers });
        }
      }

      // GET /api/google/chrome-login/check — Quick check if Chrome is now logged into Google
      // Always fresh (clears cache) — used during onboarding polling
      // On first successful login: auto-scan + apply OpenClaw Calendar credentials
      if (url.pathname === "/api/google/chrome-login/check" && req.method === "GET") {
        if (!services.chromeLauncher?.page) {
          return Response.json({ loggedIn: false, reason: "chrome_not_launched" }, { headers });
        }
        try {
          services.chromeLauncher.clearGoogleLoginCache();
          const result = await services.chromeLauncher.checkGoogleLogin();

          // Auto-connect Calendar when Chrome login succeeds (if not already connected)
          if (result.loggedIn && !services.calendar.connected) {
            try {
              const { credentials } = await scanForGoogleCredentials();
              if (credentials) {
                services.calendar.setCredentials(credentials);
                await services.calendar.connect();
                console.log("[GoogleAuth] Calendar auto-connected after Chrome sign-in");
              }
            } catch (e: any) {
              console.warn("[GoogleAuth] Calendar auto-connect failed:", e.message);
            }
          }

          return Response.json({
            ...result,
            calendar: services.calendar.connected,
          }, { headers });
        } catch (e: any) {
          return Response.json({ loggedIn: false, error: e.message }, { headers });
        }
      }

      // --- Static files (public/) ---
      // Friendlier URL aliases
      const pathnameAlias: Record<string, string> = {
        "/meeting-view": "/meeting-view.html",
        "/panel": "/callingclaw-panel.html",
        "/voice-test": "/voice-test.html",
        "/meeting-join-test": "/meeting-join-test.html",
        "/test-automation-router": "/test-automation-router.html",
        "/test-transcript-auditor": "/test-transcript-auditor.html",
        "/test-presentation-engine": "/test-presentation-engine.html",
        "/test-context-retriever": "/test-context-retriever.html",
        "/test-hub": "/test-hub.html",
        "/tests": "/test-hub.html",
        "/stage": "/stage.html",
      };
      const resolvedPath = pathnameAlias[url.pathname] ?? url.pathname;
      const publicPath = `${import.meta.dir}/../public${resolvedPath === "/" ? "/callingclaw-panel.html" : resolvedPath}`;
      const file = Bun.file(publicPath);
      if (await file.exists()) {
        // CORS for AudioWorklet .js files (recall-client.html loads from different origin)
        const corsHeaders = resolvedPath.endsWith(".js")
          ? { "Access-Control-Allow-Origin": "*" }
          : {};
        return new Response(file, { headers: corsHeaders });
      }

      return Response.json({ error: "Not found" }, { status: 404, headers });
    },
  });

  // ── Forward AI audio output to browser voice test clients + Electron audio bridge ──
  // Audio bridge clients receive raw binary PCM16 for lowest latency.
  // Voice test clients still use JSON (legacy UI).
  services.realtime.onAudioOutput((base64Pcm) => {
    for (const ws of browserVoiceClients) {
      try { ws.send(JSON.stringify({ type: "audio", audio: base64Pcm })); } catch {}
    }
    // Audio bridge: send raw binary PCM16 (no base64/JSON overhead)
    // Type byte 0x01 = audio, 0x02 = interrupt (see meet-audio-inject.js)
    const raw = Buffer.from(base64Pcm, "base64");
    const frame = Buffer.allocUnsafe(1 + raw.length);
    frame[0] = 0x01; // audio frame marker
    raw.copy(frame, 1);
    for (const ws of audioBridgeClients) {
      try { ws.send(frame); } catch {}
    }
    // Recall bridge clients (same binary protocol)
    for (const ws of recallBridgeClients) {
      try { ws.send(frame); } catch {}
    }
  });

  // ── Interruption: user started speaking → stop playback on all clients ──
  services.realtime.onSpeechStarted(() => {
    const msg = JSON.stringify({ type: "interrupt" });
    for (const ws of browserVoiceClients) {
      try { ws.send(msg); } catch {}
    }
    // Audio bridge: single-byte interrupt marker (0x02)
    const interruptFrame = Buffer.from([0x02]);
    for (const ws of audioBridgeClients) {
      try { ws.send(interruptFrame); } catch {}
    }
    for (const ws of recallBridgeClients) {
      try { ws.send(interruptFrame); } catch {}
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
