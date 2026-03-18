#!/usr/bin/env bun
// CallingClaw 2.0 — Main Entry Point (Module-wired Architecture)
// Dedicated machine: CallingClaw owns its own screen, audio, and browser.

import { CONFIG } from "./config";
import { PythonBridge } from "./bridge";
import { SharedContext, VoiceModule, VisionModule, ComputerUseModule, MeetingModule, EventBus, TaskStore, AutomationRouter, ContextSync, TranscriptAuditor, AUDITOR_MANAGED_TOOLS, BrowserActionLoop, MeetingScheduler, PostMeetingDelivery, ContextRetriever, appendToLiveLog } from "./modules";
import { GoogleCalendarClient } from "./mcp_client/google_cal";
import { PlaywrightCLIClient } from "./mcp_client/playwright-cli";
import { PeekabooClient } from "./mcp_client/peekaboo";
import { ZoomSkill } from "./skills/zoom";
import { MeetJoiner } from "./meet_joiner";
import { OpenClawBridge } from "./openclaw_bridge";
import { BrowserCaptureProvider } from "./capture/browser-capture-provider";
import { DesktopCaptureProvider } from "./capture/desktop-capture-provider";
import { MeetingPrepSkill } from "./skills/meeting-prep";
import { buildVoiceInstructions, pushContextUpdate, notifyTaskCompletion, prepareMeeting, getPostMeetingSummary } from "./voice-persona";
// OC-007 import removed — no longer pushing screen descriptions to OpenClaw during meetings.
// ContextRetriever handles gap detection locally via fast models (Haiku/Gemini Flash).
import { startConfigServer } from "./config_server";
import { buildAllTools } from "./tool-definitions";
import { readFileSync } from "fs";
import { resolve } from "path";

// ── Read unified VERSION file ────────────────────────────────
let APP_VERSION = "2.5.0";
try {
  APP_VERSION = readFileSync(resolve(__dirname, "..", "VERSION"), "utf-8").trim();
} catch {}

console.log(`
   ██████╗ █████╗ ██╗     ██╗     ██╗███╗   ██╗ ██████╗  ██████╗██╗      █████╗ ██╗    ██╗
  ██╔════╝██╔══██╗██║     ██║     ██║████╗  ██║██╔════╝ ██╔════╝██║     ██╔══██╗██║    ██║
  ██║     ███████║██║     ██║     ██║██╔██╗ ██║██║  ███╗██║     ██║     ███████║██║ █╗ ██║
  ██║     ██╔══██║██║     ██║     ██║██║╚██╗██║██║   ██║██║     ██║     ██╔══██║██║███╗██║
  ╚██████╗██║  ██║███████╗███████╗██║██║ ╚████║╚██████╔╝╚██████╗███████╗██║  ██║╚███╔███╔╝
   ╚═════╝╚═╝  ╚═╝╚══════╝╚══════╝╚═╝╚═╝  ╚═══╝ ╚═════╝ ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝
                                          v${APP_VERSION}
`);

// ── 1. Core Infrastructure ──────────────────────────────────────

const bridge = new PythonBridge();
bridge.start();

const context = new SharedContext();
const calendar = new GoogleCalendarClient();
const meetJoiner = new MeetJoiner(bridge);
const eventBus = new EventBus();
const taskStore = new TaskStore(eventBus);

// Load persisted tasks
await taskStore.load();

// ── 1b. ContextSync + OpenClaw Bridge ─────────────────────────────

const contextSync = new ContextSync();
const openclawBridge = new OpenClawBridge();

const meetingPrepSkill = new MeetingPrepSkill(openclawBridge);

// Forward live notes to EventBus for Desktop UI visibility
meetingPrepSkill.onLiveNote((note, topic) => {
  eventBus.emit("meeting.live_note", { note, topic, timestamp: Date.now() });
});

// Load OpenClaw's MEMORY.md at startup (non-blocking)
contextSync.loadOpenClawMemory().then((ok) => {
  if (ok) console.log("[Init] OpenClaw MEMORY.md loaded into ContextSync");
  else console.warn("[Init] OpenClaw MEMORY.md not available (recall_context will use OpenClaw bridge)");
});

// ── MeetingScheduler + PostMeetingDelivery ──
const meetingScheduler = new MeetingScheduler({
  calendar,
  openclawBridge,
  eventBus,
});

const postMeetingDelivery = new PostMeetingDelivery({
  openclawBridge,
  eventBus,
});

// Try connecting to OpenClaw Gateway (non-blocking)
openclawBridge.connect().then(() => {
  console.log("[Init] OpenClaw Bridge connected (System 2 available)");
  // Start calendar → auto-join scheduler once OpenClaw is connected
  if (calendar.connected) {
    meetingScheduler.start();
    console.log("[Init] MeetingScheduler started (calendar→cron→auto-join)");
  }
}).catch(() => {
  console.warn("[Init] OpenClaw not running — recall_context will use local memory search only");
});

// Note: calendar.connect() is called later in section 6.
// After calendar connects, start scheduler if OpenClaw is also ready.

// Periodically refresh MEMORY.md and push to live Voice session
setInterval(async () => {
  const changed = await contextSync.refreshIfChanged();
  if (changed && voice.connected) {
    const brief = contextSync.getBrief().voice;
    if (brief) {
      const currentInstructions = voice.getLastInstructions();
      // Only push if voice is in casual mode (not in a meeting with prep brief)
      if (!currentInstructions.includes("MEETING PREP BRIEF")) {
        voice.updateInstructions(
          currentInstructions.split("\n═══ BACKGROUND CONTEXT")[0] +
          `\n═══ BACKGROUND CONTEXT (from OpenClaw memory) ═══\n${brief}`
        );
        console.log("[ContextSync] Pushed updated memory to live Voice session");
      }
    }
  }
}, 60_000);

// Wire ContextSync.onUpdate() — push to voice immediately when pin/note changes
contextSync.onUpdate(() => {
  if (!voice.connected) return;
  const brief = contextSync.getBrief().voice;
  if (!brief) return;
  const currentInstructions = voice.getLastInstructions();
  // Only push in casual mode (meeting mode uses MeetingPrepBrief instead)
  if (!currentInstructions.includes("MEETING PREP BRIEF")) {
    voice.updateInstructions(
      currentInstructions.split("\n═══ BACKGROUND CONTEXT")[0] +
      `\n═══ BACKGROUND CONTEXT (from OpenClaw memory) ═══\n${brief}`
    );
    console.log("[ContextSync] Pushed updated context to live Voice session (onUpdate)");
  }
});

// Browser DOM context capture interval (started on meeting.started, cleared on meeting.ended)
let _domContextInterval: ReturnType<typeof setInterval> | null = null;

// Wire OpenClaw activity events to EventBus for real-time visibility
openclawBridge.onActivity((kind, summary, detail) => {
  eventBus.emit(kind, { summary, detail });
});

// ── 1c. Vision Module (Meeting Screen Analysis) ──────────────────

// Accumulated screen descriptions for periodic OpenClaw push
let _meetingVisionBuffer: string[] = [];

// ── Browser Capture Provider (CDP) — used by VisionModule for 1s screenshots ──
const browserCapture = new BrowserCaptureProvider();
// Desktop Capture Provider (screencapture CLI) — used by ComputerUseModule
const desktopCapture = new DesktopCaptureProvider();

const vision = new VisionModule({
  context,
  browserCapture,
  onScreenDescription: (description, _screenshot) => {
    // Emit vision event for Desktop UI visibility
    eventBus.emit("meeting.vision", { description, timestamp: Date.now() });

    // Append to live log file on disk (timeline for post-meeting analysis)
    if (meetingPrepSkill.liveLogPath) {
      appendToLiveLog(meetingPrepSkill.liveLogPath, `[SCREEN] ${description}`);
    }

    // Buffer for final flush only (meeting end summary)
    _meetingVisionBuffer.push(`[${new Date().toLocaleTimeString("zh-CN")}] ${description}`);

    // NOTE: No OC-007 batch push during meetings.
    // Screen descriptions feed into ContextRetriever's gap analysis instead —
    // it detects what context is MISSING and retrieves from local files/memory.
    // OpenClaw is too slow (2-15s) for meeting-time context enrichment.
    // Post-meeting: the complete live log timeline is used for summary + todos.
  },
});

// Auto-start meeting vision + open transparency view + activate auditor when meeting starts
eventBus.on("meeting.started", () => {
  if (!vision.isMeetingMode) {
    vision.startMeetingVision(1000);
    console.log("[Init] Meeting vision auto-started");
  }
  // Meeting view disabled — now shown in Electron sidebar only
  // Bun.spawn(["open", `http://localhost:${CONFIG.port}/meeting-view.html`]);
  // console.log("[Init] Meeting transparency view opened in browser");

  // ── Activate TranscriptAuditor: take over automation from OpenAI ──
  if (voice.connected) {
    // Remove automation tools from OpenAI session (auditor handles them now)
    const meetingTools = voice.getAllTools().filter(
      (t) => !AUDITOR_MANAGED_TOOLS.has(t.name)
    );
    voice.setActiveTools(meetingTools);
    console.log(`[Init] Removed ${AUDITOR_MANAGED_TOOLS.size} automation tools from OpenAI (auditor takes over)`);

    // Activate the auditor
    transcriptAuditor.activate(voice);

    // Activate context retriever (knowledge gap fill)
    contextRetriever.activate(voice);
  }

  // ── Safety: auto-stop after 3 hours to prevent cost leakage ──
  setTimeout(() => {
    if (vision.isMeetingMode) {
      console.warn("[Init] Meeting exceeded 3 hour limit — auto-stopping vision to prevent cost leakage");
      stopMeetingVisionAndFlush("3 hour safety limit reached");
    }
  }, 3 * 60 * 60 * 1000);

  // ── Start Browser DOM context capture (both modes) ──
  // Captures active browser tab DOM every 10s for richer context.
  // In Meet mode: captures non-Meet tabs when Playwright is free.
  // In Talk Locally: captures whatever the user is browsing.
  if (playwrightCli.connected) {
    _domContextInterval = setInterval(async () => {
      if (!playwrightCli.connected) return;
      try {
        const raw = await playwrightCli.evaluate(`() => {
          // Skip if on Google Meet page (Meet mode uses it for other things)
          if (location.hostname === 'meet.google.com') return JSON.stringify({ skip: true });
          return JSON.stringify({
            url: location.href,
            title: document.title,
            scrollY: window.scrollY,
            scrollHeight: document.documentElement.scrollHeight,
            viewportHeight: window.innerHeight,
            visibleText: document.body.innerText.substring(0, 2000),
            links: document.querySelectorAll('a').length,
            buttons: document.querySelectorAll('button').length,
            inputs: document.querySelectorAll('input,textarea').length,
          });
        }`);
        const domInfo = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (!domInfo.skip) {
          context.updateBrowserContext?.(domInfo);
          eventBus.emit("meeting.browser_context", { ...domInfo, timestamp: Date.now() });
        }
      } catch {} // Browser busy or not accessible
    }, 10000);
    console.log("[Init] Browser DOM context capture started (10s interval)");
  }
});

// Auto-stop vision when meeting ends or recording stops
function stopMeetingVisionAndFlush(reason: string) {
  if (!vision.isMeetingMode) return;
  vision.stopMeetingVision();
  // Clear vision buffer (screen descriptions are preserved in live log file)
  if (_meetingVisionBuffer.length > 0) {
    console.log(`[MeetingVision] Discarded ${_meetingVisionBuffer.length} buffered descriptions (preserved in live log)`);
    _meetingVisionBuffer.length = 0;
  }
  console.log(`[Init] Meeting vision stopped (${reason})`);
}

// ── Screen capture lifecycle: start on voice.started, stop on voice.stopped ──
// Talk Locally: voice.started → screen capture in "talk_locally" mode
// Meeting: meeting.started → screen capture in "meeting" mode (overrides TL)
eventBus.on("voice.started", async () => {
  // Connect CDP for browser screenshots (discovers Chrome's debug port)
  if (!await browserCapture.isAvailable()) {
    await browserCapture.connect();
  }
  // Start screen capture in Talk Locally mode (meeting.started will upgrade to meeting mode)
  if (!vision.isCapturing) {
    vision.startScreenCapture("talk_locally");
  }
});

// Push screen changes to Voice AI in real-time
context.on("screen", (screenState) => {
  if (screenState.description && voice.connected) {
    // Rebuild voice instructions with latest screen context and push
    // Only push if description actually changed (not just a new screenshot)
    const brief = screenState.description.slice(0, 300);
    const screenCtx = `\n\n[Current Screen] ${brief}${screenState.url ? ` (${screenState.url})` : ""}`;
    // The existing ContextSync refresh mechanism will pick this up,
    // but we also emit an event for immediate consumers (overlay, sidebar)
    eventBus.emit("screen.updated", {
      description: screenState.description,
      url: screenState.url,
      title: screenState.title,
      timestamp: screenState.capturedAt,
    });
  }
});

// ── Safety net: auto-stop when voice disconnects ──
// Prevents vision/recording from leaking if user closes session without proper stop
eventBus.on("voice.stopped", () => {
  // Stop screen capture (both Talk Locally and Meeting modes)
  if (vision.isCapturing) {
    if (vision.isMeetingMode) {
      stopMeetingVisionAndFlush("Voice disconnected");
    } else {
      vision.stopScreenCapture();
      console.log("[Init] Talk Locally screen capture stopped (voice disconnected)");
    }
  }

  if (meeting.getNotes().isRecording) {
    console.log("[Init] Voice stopped while meeting active — auto-stopping recording");
    if (_domContextInterval) { clearInterval(_domContextInterval); _domContextInterval = null; }
    meeting.stopRecording();
    if (transcriptAuditor.active) transcriptAuditor.deactivate();
    if (contextRetriever.active) contextRetriever.deactivate();
  }
});

eventBus.on("meeting.ended", () => {
  stopMeetingVisionAndFlush("Meeting ended");

  // Stop DOM context capture
  if (_domContextInterval) {
    clearInterval(_domContextInterval);
    _domContextInterval = null;
    context.clearBrowserContext?.();
  }

  // ── Stop admission monitor ──
  if (playwrightCli.isAdmissionMonitoring) {
    playwrightCli.stopAdmissionMonitor();
  }

  // ── Deactivate TranscriptAuditor + ContextRetriever + restore all tools ──
  if (transcriptAuditor.active) {
    transcriptAuditor.deactivate();
    if (voice.connected) {
      voice.restoreAllTools();
      console.log("[Init] Restored all tools to OpenAI session (auditor deactivated)");
    }
  }
  if (contextRetriever.active) {
    contextRetriever.deactivate();
  }
});
eventBus.on("meeting.stopped", () => stopMeetingVisionAndFlush("Recording stopped"));

// ── Auto-leave when meeting ends externally (host ended, kicked, etc.) ──
// This is called from PlaywrightCLI's meeting-end detector.
let _autoLeaveInProgress = false;
async function autoLeaveMeeting() {
  if (_autoLeaveInProgress) return;
  _autoLeaveInProgress = true;
  console.log("[Meeting] Auto-leave triggered — meeting ended externally");

  try {
    // Stop admission monitor
    if (playwrightCli.isAdmissionMonitoring) {
      playwrightCli.stopAdmissionMonitor();
    }
    playwrightCli.clearMeetingEndCallback();

    // Cancel waiting room poll if running
    if (_waitingRoomAbort) {
      _waitingRoomAbort.abort();
      _waitingRoomAbort = null;
    }

    // Generate summary + export
    const summary = await meeting.generateSummary();
    const filepath = await meeting.exportToMarkdown(summary);
    meeting.stopRecording();

    // Create tasks from action items
    let createdTasks: any[] = [];
    if (summary.actionItems?.length > 0) {
      createdTasks = taskStore.createFromMeetingItems(
        summary.actionItems.map((a: any) => ({
          task: a.task, assignee: a.assignee, deadline: a.deadline,
        }))
      );
    }

    const followUp = {
      filepath, summary,
      tasks: createdTasks.map((t: any) => ({ id: t.id, task: t.task, assignee: t.assignee, deadline: t.deadline })),
      pendingConfirmation: true, generatedAt: Date.now(),
      autoDetected: true,
    };

    eventBus.emit("meeting.ended", followUp);
    eventBus.endCorrelation();

    // Post-meeting delivery
    const prepSummary = getPostMeetingSummary(meetingPrepSkill);
    postMeetingDelivery.deliver({ summary, notesFilePath: filepath, prepSummary }).catch((e: any) => {
      console.error("[AutoLeave] Delivery failed:", e.message);
    });

    // Patch calendar event with meeting notes link (non-blocking)
    const activeMeetUrl = (meetJoiner as any).currentSession?.meetUrl;
    if (calendar.connected && activeMeetUrl) {
      calendar.findEventByMeetUrl(activeMeetUrl).then(async (ev) => {
        if (ev?.id) {
          const notesLine = `\n\n📝 Meeting Notes: ${filepath}`;
          await calendar.patchEvent(ev.id, { description: (ev as any).description ? (ev as any).description + notesLine : notesLine });
        }
      }).catch(() => {});
    }

    // Revert voice to default persona
    meetingPrepSkill.clear();
    if (voice.connected) {
      const defaultBrief = contextSync.getBrief().voice;
      const defaultInstructions = buildVoiceInstructions() +
        (defaultBrief ? `\n═══ BACKGROUND CONTEXT (from OpenClaw memory) ═══\n${defaultBrief}` : "");
      voice.updateInstructions(defaultInstructions);
      voice.sendText("会议已经结束了，我已经保存了会议记录。");
    }

    console.log(`[AutoLeave] Complete — notes: ${filepath}, tasks: ${createdTasks.length}`);
  } catch (e: any) {
    console.error("[AutoLeave] Error:", e.message);
    // Even if summary fails, still emit meeting.ended to clean up state
    eventBus.emit("meeting.ended", { autoDetected: true, error: e.message });
  } finally {
    _autoLeaveInProgress = false;
  }
}

// Abort controller for waiting room background poll
let _waitingRoomAbort: AbortController | null = null;

// ── 2. Computer Use Module ──────────────────────────────────────

const computerUse = new ComputerUseModule(bridge, context, eventBus);
computerUse.desktopCapture = desktopCapture;

// Screen capture is now handled by BrowserCaptureProvider (CDP) and DesktopCaptureProvider.
// Python sidecar no longer sends screenshots.

// ── 2b. Automation Layers (Playwright + Peekaboo + Router) ──────

const playwrightCli = new PlaywrightCLIClient({
  headless: CONFIG.playwright.headless,
  profileDir: CONFIG.playwright.userDataDir || undefined,
});

const peekaboo = new PeekabooClient();
const zoomSkill = new ZoomSkill(bridge);
const automationRouter = new AutomationRouter(bridge, eventBus, playwrightCli, peekaboo);

// Layer 2 (Playwright CLI) — lazy start, only launches Chrome when first needed
// (avoids opening an empty Chrome window on CallingClaw startup)
console.log("[Init] Layer 2 (Playwright CLI) ready (lazy — Chrome launches on first use)");

// Check Layer 3 (Peekaboo) availability — non-blocking
peekaboo.checkAvailability().then((ok) => {
  if (ok) console.log("[Init] Layer 3 (Peekaboo) ready");
  else console.warn("[Init] Layer 3 (Peekaboo) not installed");
});

// ── 2c. Browser Action Loop (Unified Browser Execution) ──────────
// Model-driven browser automation: snapshot → model decides → execute → verify
const browserLoop = new BrowserActionLoop(playwrightCli, eventBus);

// ── 2d. TranscriptAuditor (System 2 Intent Classification) ──────
// During meetings, replaces OpenAI's tool-calling for automation.
// Uses Claude Haiku to classify intent from transcript + meeting brief.

const transcriptAuditor = new TranscriptAuditor({
  context,
  eventBus,
  automationRouter,
  computerUse,
  meetingPrepSkill,
  meetJoiner,
});

// ── 2e. ContextRetriever (Event-Driven Knowledge Gap Fill) ──────
// During meetings, monitors transcript for topics not covered by prep brief.
// Uses fast models (Haiku/Gemini) to detect gaps + semantic search on MEMORY.md.
// No OpenClaw in meeting loop — too slow. All retrieval via OpenRouter.
const contextRetriever = new ContextRetriever({
  context,
  eventBus,
  contextSync,
  meetingPrepSkill,
});

// ── 3. Voice Module (OpenAI Realtime) ───────────────────────────

// ── 4. Meeting Module (before voice, since tools need it) ──────

const meeting = new MeetingModule(context);

// Build tool definitions + handlers from domain-specific modules
// Uses a mutable deps object so voice/meeting refs resolve lazily via closures
const toolDeps = {
  calendar,
  eventBus,
  playwrightCli,
  meetJoiner,
  meeting,
  get voice() { return voice; }, // Lazy — voice created below
  openclawBridge,
  meetingPrepSkill,
  contextSync,
  contextRetriever,
  context,
  automationRouter,
  computerUse,
  bridge,
  zoomSkill,
  taskStore,
  postMeetingDelivery,
  autoLeaveMeeting: () => autoLeaveMeeting(),
  getWaitingRoomAbort: () => _waitingRoomAbort,
  setWaitingRoomAbort: (v: AbortController | null) => { _waitingRoomAbort = v; },
  buildVoiceInstructions,
  getPostMeetingSummary,
  prepareMeeting,
  notifyTaskCompletion,
} as any;

const { definitions: toolDefinitions, handler: toolHandler } = buildAllTools(toolDeps);

const voice = new VoiceModule({
  context,
  tools: toolDefinitions,
  onToolCall: toolHandler,
  onReconnectFailed: () => {
    console.error("[Voice] Auto-reconnect failed — all retries exhausted");
    eventBus.emit("voice.reconnect_failed", {
      provider: voice.provider,
      timestamp: Date.now(),
    });
  },
});

// Forward meeting action items to EventBus
context.on("note", (note) => {
  if (note.type === "action_item" || note.type === "todo") {
    eventBus.emit("meeting.action_item", {
      text: note.text,
      assignee: note.assignee,
    });
  }
});

// Write transcript entries to live log file on disk
context.on("transcript", (entry: any) => {
  if (meetingPrepSkill.liveLogPath && meeting.getNotes().isRecording) {
    const role = entry.role === "user" ? "USER" : entry.role === "assistant" ? "AI" : entry.role?.toUpperCase() || "???";
    appendToLiveLog(meetingPrepSkill.liveLogPath, `[${role}] ${entry.text}`);
  }
});

// ── 5. Audio Bridge (Voice ↔ Python Sidecar) ────────────────────

// Mic audio from Python → OpenAI Realtime
bridge.on("audio_chunk", (msg) => {
  voice.sendAudio(msg.payload.audio);
});

// AI audio from OpenAI → Python speaker
voice.onAudioOutput((base64Pcm) => {
  if (bridge.ready) {
    bridge.sendAudioPlayback(base64Pcm);
  }
});

// ── 6. Google Calendar (non-blocking) ───────────────────────────

calendar.connect().then(() => {
  // Start meeting scheduler once calendar is available
  if (openclawBridge.connected && !meetingScheduler.active) {
    meetingScheduler.start();
    console.log("[Init] MeetingScheduler started (calendar + OpenClaw both ready)");
  }
}).catch((e) => {
  console.warn("[Init] Google Calendar not available (optional):", e.message);
});

// ── 7. HTTP Config Server ───────────────────────────────────────

startConfigServer({
  bridge,
  realtime: voice,
  calendar,
  context,
  meeting,
  computerUse,
  meetJoiner,
  eventBus,
  taskStore,
  automationRouter,
  contextSync,
  meetingPrepSkill,
  openclawBridge,
  transcriptAuditor,
  browserLoop,
  playwrightCli,
  meetingScheduler,
  postMeetingDelivery,
});

// ── 8. Launch Python Sidecar ────────────────────────────────────

const pythonPath = `${import.meta.dir}/../python_sidecar/main.py`;
const pythonFile = Bun.file(pythonPath);

if (await pythonFile.exists()) {
  console.log("[Init] Launching Python sidecar...");
  const pythonBin = process.env.PYTHON_PATH || "/opt/miniconda3/bin/python3";
  console.log(`[Init] Using Python: ${pythonBin}`);
  const proc = Bun.spawn([pythonBin, pythonPath], {
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      BRIDGE_PORT: String(CONFIG.bridgePort),
    },
  });

  process.on("SIGINT", async () => {
    console.log("\n[Shutdown] Stopping CallingClaw...");

    // Save meeting notes if recording
    if (meeting.getNotes().isRecording) {
      console.log("[Shutdown] Saving meeting notes...");
      const summary = await meeting.generateSummary();
      await meeting.exportToMarkdown(summary);
      meeting.stopRecording();

      // Create tasks from final summary
      if (summary.actionItems && summary.actionItems.length > 0) {
        taskStore.createFromMeetingItems(
          summary.actionItems.map((a) => ({
            task: a.task,
            assignee: a.assignee,
            deadline: a.deadline,
          }))
        );
      }
    }

    transcriptAuditor.deactivate();
    contextRetriever.deactivate();
    proc.kill();
    bridge.stop();
    voice.stop();
    playwrightCli.stop();
    calendar.disconnect();
    process.exit(0);
  });
} else {
  console.warn("[Init] Python sidecar not found at", pythonPath);
  console.warn("[Init] Running in API-only mode (no hardware control)");
}

console.log(`
╔══════════════════════════════════════════════════════╗
║  CallingClaw 2.0 is running!                        ║
║                                                      ║
║  Config UI:  http://localhost:${CONFIG.port}               ║
║  Events WS:  ws://localhost:${CONFIG.port}/ws/events       ║
║  Bridge WS:  ws://localhost:${CONFIG.bridgePort}                ║
║                                                      ║
║  Modules: Voice ✓  ComputerUse ✓  Calendar ✓        ║
║  Context: SharedContext ✓  ContextSync ✓  Meeting ✓  ║
║  Memory:  OpenClaw Bridge ✓  recall_context ✓        ║
║  Events:  EventBus ✓  TaskStore ✓  ScreenShare ✓    ║
║  Auditor: TranscriptAuditor ✓ (Claude Haiku)        ║
║  Sched:  MeetingScheduler ✓  PostMeetingDelivery ✓  ║
║                                                      ║
║  Automation Layers:                                  ║
║    L1: Shortcuts + API (Zoom, Meet, Calendar)  ✓    ║
║    L2: Playwright CLI (AX Tree + Chrome)        …    ║
║    L3: Peekaboo (macOS Native GUI)             …    ║
║    L4: Computer Use (Vision Fallback)          ✓    ║
║                                                      ║
║  Press Ctrl+C to stop                                ║
╚══════════════════════════════════════════════════════╝
`);
