#!/usr/bin/env bun
// CallingClaw 2.0 — Main Entry Point (Module-wired Architecture)
// Dedicated machine: CallingClaw owns its own screen, audio, and browser.

import { CONFIG } from "./config";

// Validate audio config matches provider expectations
if (CONFIG.audio.sampleRate !== 24000) {
  console.warn(`[Init] Audio sample rate ${CONFIG.audio.sampleRate}Hz != 24000Hz (provider expectation)`);
}

import { NativeBridge } from "./bridge";
import { SharedContext, VoiceModule, VisionModule, ComputerUseModule, MeetingModule, EventBus, TaskStore, AutomationRouter, ContextSync, TranscriptAuditor, AUDITOR_MANAGED_TOOLS, BrowserActionLoop, MeetingScheduler, PostMeetingDelivery, ContextRetriever, appendToLiveLog } from "./modules";
import { GoogleCalendarClient } from "./mcp_client/google_cal";
import { PlaywrightCLIClient } from "./mcp_client/playwright-cli";
import { ChromeLauncher } from "./chrome-launcher";
import { PeekabooClient } from "./mcp_client/peekaboo";
import { ZoomSkill } from "./skills/zoom";
import { MeetJoiner, detectPlatform, type MeetingPlatform } from "./meet_joiner";
import { OpenClawBridge } from "./openclaw_bridge";
import { BrowserCaptureProvider } from "./capture/browser-capture-provider";
import { DesktopCaptureProvider } from "./capture/desktop-capture-provider";
import { MeetingPrepSkill } from "./skills/meeting-prep";
import { buildVoiceInstructions, pushContextUpdate, notifyTaskCompletion, prepareMeeting, getPostMeetingSummary, resetContextInjectionState, injectMeetingBrief } from "./voice-persona";
import { KeyFrameStore } from "./modules/key-frame-store";
import { generateMeetingSummaryHtml } from "./modules/meeting-summary-html";
import { OpenClawDispatcher } from "./openclaw-dispatcher";
import { createAgentAdapter, type AgentAdapter, type AgentPlatform } from "./agent-adapter";
import { startConfigServer } from "./config_server";
import { buildAllTools } from "./tool-definitions";
import { readFileSync } from "fs";
import { resolve } from "path";

// ── Read unified VERSION file ────────────────────────────────
let APP_VERSION = "2.8.1";
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

const bridge = new NativeBridge();
bridge.start();

const context = new SharedContext();
const calendar = new GoogleCalendarClient();
const meetJoiner = new MeetJoiner(bridge);
const eventBus = new EventBus();
const taskStore = new TaskStore(eventBus);

// Meeting database (SQLite) — replaces sessions.json for metadata
import { MeetingDB } from "./modules/meeting-db";
const meetingDB = new MeetingDB();
console.log(`[Init] MeetingDB: ${meetingDB.stats().totalMeetings} meetings, ${meetingDB.stats().totalFiles} files`);

// SessionManager — single entry point for ALL session mutations
import { SessionManager } from "./modules/session-manager";
const sessionManager = new SessionManager(eventBus);

// Sync sessions.json → MeetingDB on every SessionManager mutation
sessionManager.setDBSync((session) => {
  meetingDB.upsert({
    id: session.meetingId,
    topic: session.topic || "Meeting",
    start_time: session.startTime || session.createdAt || null,
    end_time: session.endTime || null,
    status: session.status || "active",
    calendar_id: session.calendarEventId || null,
    meet_url: session.meetUrl || null,
  });
});

// Wire calendar auth error detection → EventBus + OpenClaw notification
calendar.onAuthError = (error: string) => {
  console.warn(`[Calendar] Auth error detected: ${error}`);
  eventBus.emit("calendar.auth_error", {
    error,
    message: "Google OAuth refresh token 已过期或被撤销，日历功能暂时不可用。请重新授权。",
  });
};

// Load persisted tasks
await taskStore.load();

// ── 1b. ContextSync + Agent Adapter ─────────────────────────────
// Detect agent platform: openclaw > claude-code > standalone
const _detectedPlatform: AgentPlatform = (() => {
  const envPlatform = process.env.AGENT_PLATFORM;
  if (envPlatform === "openclaw" || envPlatform === "claude-code" || envPlatform === "standalone") {
    return envPlatform;
  }
  // Auto-detect: prefer openclaw if config exists, then claude-code CLI
  try {
    if (require("fs").existsSync(`${process.env.HOME}/.openclaw/openclaw.json`)) return "openclaw";
  } catch {}
  try {
    require("child_process").execSync("which claude", { stdio: "ignore" });
    return "claude-code";
  } catch {}
  return "standalone";
})();
console.log(`[Init] Agent platform: ${_detectedPlatform}`);

const contextSync = new ContextSync();
const openclawBridge = new OpenClawBridge(); // kept for backward compat (activity events, ContextSync)
const dispatcher = new OpenClawDispatcher(openclawBridge);

// Job fire handler: when internal timer fires, auto-join the meeting
const _onJobFire = (job: import("./agent-adapter").ScheduledJob) => {
  console.log(`[JobScheduler] Firing: "${job.name}" → joining ${job.payload.meetUrl}`);
  fetch("http://localhost:4000/api/meeting/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: job.payload.meetUrl }),
  }).then(r => {
    if (r.ok) console.log(`[JobScheduler] Join request sent for "${job.payload.summary}"`);
    else console.error(`[JobScheduler] Join failed: ${r.status}`);
  }).catch(e => {
    console.error(`[JobScheduler] Join request failed: ${e.message}`);
  });
};

const agentAdapter: AgentAdapter = createAgentAdapter(_detectedPlatform, {
  openclawBridge,
  onJobFire: _onJobFire,
});

const meetingPrepSkill = new MeetingPrepSkill(agentAdapter);
meetingPrepSkill.setSessionManager(sessionManager);

// Track active meeting ID for live log event emission
let activeMeetingId: string | null = null;
let activePlatform: MeetingPlatform = "unknown";

// Forward live notes to EventBus for Desktop UI visibility + live log streaming
meetingPrepSkill.onLiveNote((note, topic) => {
  eventBus.emit("meeting.live_note", { note, topic, timestamp: Date.now() });
  // Also emit as live_entry so the frontend sidebar gets it
  if (activeMeetingId) {
    eventBus.emit("meeting.live_entry", { meetingId: activeMeetingId, entry: `[NOTE] ${note}`, timestamp: new Date().toLocaleTimeString("zh-CN", { hour12: false }) });
  }
});

// Forward prep-ready to EventBus — frontend gets instant notification when prep file is saved
meetingPrepSkill.onPrepReady((brief, meetingId, filePath) => {
  // Rebuild file index so AutomationRouter can resolve prep file paths instantly
  transcriptAuditor.refreshPrepContext();

  Bun.file(filePath).text().then((mdContent) => {
    eventBus.emit("meeting.prep_ready", {
      meetingId, topic: brief.topic, filePath, mdContent,
    });
  }).catch(() => {
    // File was just written — emit without content, frontend will fetch via API
    eventBus.emit("meeting.prep_ready", {
      meetingId, topic: brief.topic, filePath,
    });
  });
});

// Load OpenClaw's MEMORY.md at startup (non-blocking)
contextSync.loadOpenClawMemory().then((ok) => {
  if (ok) console.log("[Init] OpenClaw MEMORY.md loaded into ContextSync");
  else console.warn("[Init] OpenClaw MEMORY.md not available (recall_context will use OpenClaw bridge)");
});

// ── MeetingScheduler + PostMeetingDelivery ──
const meetingScheduler = new MeetingScheduler({
  calendar,
  adapter: agentAdapter,
  eventBus,
  meetingPrepSkill,
  sessionManager,
});

const postMeetingDelivery = new PostMeetingDelivery({
  adapter: agentAdapter,
  eventBus,
});

// Connect agent adapter (non-blocking)
agentAdapter.connect().then(() => {
  console.log(`[Init] Agent adapter (${agentAdapter.name}) connected`);
  // Start calendar → auto-join scheduler once adapter is connected
  if (calendar.connected) {
    meetingScheduler.start();
    console.log(`[Init] MeetingScheduler started (calendar→${agentAdapter.name}→auto-join)`);
  }
}).catch(() => {
  console.warn(`[Init] Agent adapter (${_detectedPlatform}) not available — using fallback mode`);
});

// Also try OpenClaw bridge for backward compat (activity events, ContextSync, OC-010)
if (_detectedPlatform === "openclaw") {
  // Already connected via adapter — skip duplicate connect
} else {
  openclawBridge.connect().then(() => {
    console.log("[Init] OpenClaw Bridge also connected (supplementary)");
  }).catch(() => {
    // Expected for non-openclaw platforms — no warning needed
  });
}

// Note: calendar.connect() is called later in section 6.
// After calendar connects, start scheduler if adapter is also ready.

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

// Wire agent adapter activity events to EventBus for real-time visibility
if (agentAdapter.onActivity) {
  agentAdapter.onActivity((kind, summary, detail) => {
    eventBus.emit(kind, { summary, detail });
  });
}
// Also wire OpenClaw bridge directly (for backward-compat with existing event names)
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
// KeyFrameStore — persists meeting screenshots to disk for multimodal timeline
const keyFrameStore = new KeyFrameStore();

const vision = new VisionModule({
  context,
  browserCapture,
  // Hook: persist every CDP frame to disk via KeyFrameStore (dedup + resize handled internally)
  onFrameCapture: (image, metadata) => {
    if (keyFrameStore.active) {
      keyFrameStore.saveFrame(image, metadata).catch(() => {});
    }
  },
  onScreenDescription: (description, _screenshot) => {
    // Emit vision event for Desktop UI visibility
    eventBus.emit("meeting.vision", { description, timestamp: Date.now() });

    // Append to live log file on disk (+ emit WS event for real-time frontend)
    if (meetingPrepSkill.liveLogPath) {
      appendToLiveLog(meetingPrepSkill.liveLogPath, `[SCREEN] ${description}`, eventBus, activeMeetingId || undefined);
    }

    // Push visual context to agent every 5 descriptions (~40 seconds)
    if (_meetingVisionBuffer.length >= 5 && agentAdapter.connected) {
      const batch = _meetingVisionBuffer.splice(0);
      agentAdapter.executeTask(
        `Meeting screen update — the following visual content was shown during the meeting. ` +
        `Add relevant details to your meeting context for later summary:\n\n${batch.join("\n")}`
      ).catch(() => {});
      eventBus.emit("meeting.vision_pushed", { batchSize: batch.length });
      console.log(`[MeetingVision] Pushed ${batch.length} screen descriptions to ${agentAdapter.name}`);
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
eventBus.on("meeting.started", (data) => {
  // Track active meeting ID for live log event emission
  activeMeetingId = data?.meetingId || activeMeetingId || `cc_${Date.now().toString(36)}_live`;
  // Reset incremental context injection state for new meeting
  resetContextInjectionState();
  // Reset transcript from previous meeting to prevent context leakage
  context.resetTranscript();
  // Start KeyFrameStore for multimodal timeline (screenshots saved to disk)
  keyFrameStore.start(activeMeetingId).catch((e) => {
    console.error(`[Init] KeyFrameStore start failed: ${e.message}`);
  });
  // Wire transcript events to KeyFrameStore
  context.on("transcript", (entry) => {
    if (keyFrameStore.active) keyFrameStore.saveTranscript(entry);
  });
  if (!vision.isMeetingMode) {
    vision.startMeetingVision(1000);
    console.log("[Init] Meeting vision auto-started");
  }
  // Meeting view disabled — now shown in Electron sidebar only
  // Bun.spawn(["open", `http://localhost:${CONFIG.port}/meeting-view.html`]);
  // console.log("[Init] Meeting transparency view opened in browser");

  // ── Detect meeting platform from meetUrl ──
  const meetUrl = data?.meetUrl || sessionManager.get(activeMeetingId)?.meetUrl || "";
  activePlatform = meetUrl ? detectPlatform(meetUrl) : "unknown";
  console.log(`[Init] Meeting platform detected: ${activePlatform} (from ${meetUrl || "unknown"})`);

  // ── Activate TranscriptAuditor: take over automation from OpenAI ──
  // Platform-aware tool filtering:
  //   Google Meet: remove zoom_control (useless), keep share_screen (Playwright)
  //   Zoom: remove share_screen (use zoom_control instead)
  //   Unknown: remove zoom_control (safer default)
  const PLATFORM_EXCLUDED_TOOLS: Record<MeetingPlatform, Set<string>> = {
    google_meet: new Set(["zoom_control"]),
    zoom: new Set(["share_screen", "stop_sharing"]),  // Zoom uses zoom_control for sharing
    unknown: new Set(["zoom_control"]),
  };
  const platformExcluded = PLATFORM_EXCLUDED_TOOLS[activePlatform] || new Set();

  if (voice.connected) {
    // Remove automation tools from OpenAI session (auditor handles them now)
    // ALSO remove platform-incompatible tools (e.g., zoom_control during Meet)
    // NOTE: share_screen is kept for Realtime — it's a direct user command, not an
    // autonomous auditor action. Auditor manages computer_action/browser_action.
    const meetingTools = voice.getAllTools().filter(
      (t) => !AUDITOR_MANAGED_TOOLS.has(t.name) && !platformExcluded.has(t.name)
    );
    voice.setActiveTools(meetingTools);
    console.log(`[Init] Removed ${AUDITOR_MANAGED_TOOLS.size} auditor tools + ${platformExcluded.size} platform-excluded tools (platform: ${activePlatform})`);

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
  // Injects compact [SCREEN] updates into Voice AI when the page changes.
  let _lastScreenUrl = "";
  let _lastScreenHash = "";
  if (playwrightCli.connected) {
    _domContextInterval = setInterval(async () => {
      if (!playwrightCli.connected) return;
      try {
        const raw = await playwrightCli.evaluateIfConnected(`() => {
          if (location.hostname === 'meet.google.com') return JSON.stringify({ skip: true });
          // Extract headings for structure (voice model uses these to narrate)
          const headings = [...document.querySelectorAll('h1,h2,h3')].slice(0, 8).map(h => h.textContent?.trim()).filter(Boolean);
          return JSON.stringify({
            url: location.href,
            title: document.title,
            scrollY: window.scrollY,
            scrollHeight: document.documentElement.scrollHeight,
            viewportHeight: window.innerHeight,
            visibleText: document.body.innerText.substring(0, 2000),
            headings,
            links: document.querySelectorAll('a').length,
            buttons: document.querySelectorAll('button').length,
            inputs: document.querySelectorAll('input,textarea').length,
          });
        }`);
        const domInfo = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (!domInfo.skip) {
          context.updateBrowserContext?.(domInfo);
          eventBus.emit("meeting.browser_context", { ...domInfo, timestamp: Date.now() });

          // Inject [SCREEN] update into voice model when page changes or content shifts significantly
          const contentHash = (domInfo.url || "") + "|" + (domInfo.headings?.join(",") || "");
          const urlChanged = domInfo.url !== _lastScreenUrl;
          const contentChanged = contentHash !== _lastScreenHash;
          if ((urlChanged || contentChanged) && voice.connected) {
            _lastScreenUrl = domInfo.url;
            _lastScreenHash = contentHash;
            const headingList = (domInfo.headings || []).slice(0, 6).join(" → ");
            const screenUpdate = `[SCREEN] ${domInfo.title}${headingList ? `\nSections: ${headingList}` : ""}\n${(domInfo.visibleText || "").substring(0, 400)}`;
            voice.injectContext(screenUpdate);
          }
        }
      } catch {} // Browser busy or not accessible
    }, 10000);
    console.log("[Init] Browser DOM context capture started (10s interval, with voice [SCREEN] injection)");
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
eventBus.on("voice.started", async (data) => {
  // Skip Chrome/Playwright for local conversations — Talk Locally uses Electron audio only
  const mode = (data as any)?.mode || (data as any)?.audio_mode;
  if (mode === "local" || mode === "browser") {
    console.log("[Init] Voice started in local/browser mode — skipping Chrome CDP");
    return;
  }
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

eventBus.on("meeting.ended", async () => {
  // Finalize multimodal timeline before clearing meeting state
  const meetTopic = meetingPrepSkill.currentBrief?.topic || "Meeting";
  if (keyFrameStore.active) {
    const timeline = await keyFrameStore.finalize(meetTopic).catch(() => null);
    if (timeline) {
      console.log(`[Init] Timeline finalized: ${timeline.frameCount} frames, ${timeline.priorityFrameCount} priority → ${timeline.meetingDir}`);
      // Send timeline to agent adapter for visual action extraction (async, non-blocking)
      if (agentAdapter.connected) {
        agentAdapter.processTimeline({
          meetingId: timeline.meetingId,
          meetingDir: timeline.meetingDir,
          topic: meetTopic,
          duration: `${Math.round(timeline.durationMs / 60000)}min`,
          frameCount: timeline.frameCount,
          transcriptEntries: timeline.transcriptEntries,
          priorityFrameCount: timeline.priorityFrameCount,
          timelineFile: timeline.timelineFile,
        }).catch((e) => {
          console.warn(`[Init] Timeline processing failed: ${e.message}`);
        });
      }
    }
    await keyFrameStore.stop();
  }

  activeMeetingId = null;
  stopMeetingVisionAndFlush("Meeting ended");

  // Stop DOM context capture
  if (_domContextInterval) {
    clearInterval(_domContextInterval);
    _domContextInterval = null;
    context.clearBrowserContext?.();
  }

  // ── Stop admission monitor + browser session ──
  if (playwrightCli.isAdmissionMonitoring) {
    playwrightCli.stopAdmissionMonitor();
  }
  playwrightCli.stop(); // Prevent auto-start from spawning empty Chrome windows

  // ── Clear pinned files to prevent cross-meeting context leakage ──
  contextSync.clearPinnedFiles();

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

    // Notify Electron UI that summary file is ready
    eventBus.emit("meeting.summary_ready", { filepath, title: summary.title, timestamp: Date.now() });

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

    // Finalize key frame timeline for screenshot delivery
    let keyFrameResult: { htmlFile?: string; frameCount?: number } | null = null;
    let summaryHtmlPath: string | undefined;
    const meetingIdForHtml = activeMeetingId || `mtg_${Date.now()}`;

    if (keyFrameStore.active) {
      const timeline = await keyFrameStore.finalize(summary.title || "Meeting").catch(() => null);
      if (timeline) {
        keyFrameResult = { htmlFile: timeline.htmlFile, frameCount: timeline.frameCount };
        console.log(`[AutoLeave] Timeline: ${timeline.frameCount} frames → ${timeline.htmlFile}`);
      }
    }

    // Generate branded HTML meeting summary (always — with or without screenshots)
    try {
      const meetingDir = keyFrameStore.meetingDir
        || `${process.env.CALLINGCLAW_HOME || process.env.HOME + "/.callingclaw"}/shared/meetings/${meetingIdForHtml}`;
      await Bun.$`mkdir -p ${meetingDir}`;

      summaryHtmlPath = await generateMeetingSummaryHtml({
        summary,
        meetingId: keyFrameStore.meetingId || meetingIdForHtml,
        meetingDir,
        timelineEntries: [...keyFrameStore.timelineEntries],
        transcript: context.getRecentTranscript(200),
        startTs: keyFrameStore.startTs || Date.now(),
        endTs: Date.now(),
        version: (await Bun.file(`${import.meta.dir}/../VERSION`).text().catch(() => "2.0")).trim(),
      });
      console.log(`[AutoLeave] Summary HTML: ${summaryHtmlPath}`);
      eventBus.emit("meeting.summary_html_ready", { htmlPath: summaryHtmlPath, meetingId: meetingIdForHtml });
    } catch (e: any) {
      console.error(`[AutoLeave] Summary HTML generation failed: ${e.message}`);
    }

    if (keyFrameStore.active) {
      await keyFrameStore.stop();
    }

    // Post-meeting delivery (now includes screenshots + summary HTML)
    const prepSummary = getPostMeetingSummary(meetingPrepSkill);
    postMeetingDelivery.deliver({ summary, notesFilePath: filepath, prepSummary, keyFrameResult, summaryHtmlPath }).catch((e: any) => {
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
      // Revert to Layer 0 CORE_IDENTITY (no meeting context)
      voice.updateInstructions(buildVoiceInstructions());
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

// ChromeLauncher: Phase 1 — launches Chrome with addInitScript for audio injection.
// Provides --remote-debugging-port so playwright-cli can connect in Phase 2.
const chromeLauncher = new ChromeLauncher({
  profileDir: CONFIG.playwright.userDataDir || undefined,
});

const playwrightCli = new PlaywrightCLIClient({
  headless: CONFIG.playwright.headless,
  profileDir: CONFIG.playwright.userDataDir || undefined,
});

const peekaboo = new PeekabooClient();
const zoomSkill = new ZoomSkill(bridge);
const automationRouter = new AutomationRouter(bridge, eventBus, playwrightCli, peekaboo);

// Layer 2 (Playwright CLI) — lazy start, only launches Chrome when first needed
// ChromeLauncher.launch() is called before first playwright-cli use (in meeting join)
console.log("[Init] Layer 2 (Playwright + ChromeLauncher) ready (lazy start)");

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
  chromeLauncher,
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

// ── P2: Filler mechanism — Voice AI says "让我看看..." while search runs ──
// When ContextRetriever detects a topic shift and starts searching, the user
// would otherwise hear silence for 2-8s. The filler fills this gap naturally.
// GetStream reports this buys 1.5-2s of perceived zero-latency.
const FILLER_PHRASES = [
  "让我看看相关的资料...",
  "我查一下这个的背景...",
  "让我找一下相关信息...",
  "我看看之前的记录...",
];
let _lastFillerTs = 0;
eventBus.on("retriever.searching", (data) => {
  // Only inject filler if voice is connected and not too frequent
  const now = Date.now();
  if (voice.connected && now - _lastFillerTs > 30_000) {
    _lastFillerTs = now;
    const filler = FILLER_PHRASES[Math.floor(Math.random() * FILLER_PHRASES.length)];
    voice.sendText(filler!);
    console.log(`[Filler] Sent "${filler}" while searching for "${(data as any).topic?.slice(0, 30)}"`);
  }
});

// ── 3. Voice Module (OpenAI Realtime) ───────────────────────────

// ── 4. Meeting Module (before voice, since tools need it) ──────

const meeting = new MeetingModule(context);
meeting.openclawBridge = openclawBridge; // Delegate summary/extraction to OpenClaw for richer context

// Build tool definitions + handlers from domain-specific modules
// Uses a mutable deps object so voice/meeting refs resolve lazily via closures
const toolDeps = {
  calendar,
  eventBus,
  playwrightCli,
  chromeLauncher,
  meetJoiner,
  meeting,
  get voice() { return voice; }, // Lazy — voice created below
  openclawBridge,
  dispatcher,
  agentAdapter,
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

// Write transcript entries to live log file on disk (+ emit WS event for real-time frontend)
context.on("transcript", (entry: any) => {
  if (meetingPrepSkill.liveLogPath && meeting.getNotes().isRecording) {
    const role = entry.role === "user" ? "USER" : entry.role === "assistant" ? "AI" : entry.role?.toUpperCase() || "???";
    appendToLiveLog(meetingPrepSkill.liveLogPath, `[${role}] ${entry.text}`, eventBus, activeMeetingId || undefined);
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
  if (agentAdapter.connected && !meetingScheduler.active) {
    meetingScheduler.start();
    console.log(`[Init] MeetingScheduler started (calendar + ${agentAdapter.name} both ready)`);
  }
}).catch(async (e) => {
  console.warn("[Init] Google Calendar initial connect failed:", e.message);
  // Auto-scan credentials and retry — but only if env vars are missing.
  // If env vars are set, they take priority (may be newer than local files).
  const hasEnvCreds = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_REFRESH_TOKEN);
  if (hasEnvCreds) {
    console.log("[Init] Google env vars are set — retrying connect (not scanning local files)");
    try {
      await calendar.connect();
      console.log("[Init] Google Calendar connected on retry");
      return;
    } catch {}
  }
  try {
    const { scanForGoogleCredentials } = await import("./mcp_client/google_cal");
    const { credentials } = await scanForGoogleCredentials();
    if (credentials) {
      console.log("[Init] Found Google credentials via auto-scan — retrying...");
      calendar.setCredentials(credentials);
      await calendar.connect();
      console.log("[Init] Google Calendar connected via auto-scan");
      if (agentAdapter.connected && !meetingScheduler.active) {
        meetingScheduler.start();
        console.log(`[Init] MeetingScheduler started (calendar + ${agentAdapter.name} both ready)`);
      }
      return;
    }
  } catch {}
  console.warn("[Init] Google Calendar not available (optional) — auto-reconnect enabled");
  calendar.startAutoReconnect();
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
  agentAdapter,
  transcriptAuditor,
  browserLoop,
  playwrightCli,
  chromeLauncher,
  meetingScheduler,
  postMeetingDelivery,
  meetingDB,
  sessionManager,
});

// ── 8. Python Sidecar REMOVED — NativeBridge handles all input actions ──
// Audio: Electron AudioWorklet + SwitchAudioSource
// Input: osascript + cliclick (via NativeBridge)
// Screenshots: screencapture CLI + Chrome CDP
console.log("[Init] NativeBridge active (no Python sidecar)");

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
  bridge.stop();
  voice.stop();
  playwrightCli.stop();
  chromeLauncher.close();
  calendar.disconnect();
  process.exit(0);
});

console.log(`
╔══════════════════════════════════════════════════════╗
║  CallingClaw 2.0 is running!                        ║
║                                                      ║
║  Config UI:  http://localhost:${CONFIG.port}               ║
║  Events WS:  ws://localhost:${CONFIG.port}/ws/events       ║
║  Input:      NativeBridge (osascript + cliclick)  ║
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
