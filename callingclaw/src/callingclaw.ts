#!/usr/bin/env bun
// CallingClaw 2.0 — Main Entry Point (Module-wired Architecture)
// Dedicated machine: CallingClaw owns its own screen, audio, and browser.

import { CONFIG } from "./config";
import { PythonBridge } from "./bridge";
import { SharedContext, VoiceModule, VisionModule, ComputerUseModule, MeetingModule, EventBus, TaskStore, AutomationRouter, ContextSync, TranscriptAuditor, AUDITOR_MANAGED_TOOLS, BrowserActionLoop, MeetingScheduler, PostMeetingDelivery } from "./modules";
import { GoogleCalendarClient } from "./mcp_client/google_cal";
import { PlaywrightCLIClient } from "./mcp_client/playwright-cli";
import { PeekabooClient } from "./mcp_client/peekaboo";
import { ZoomSkill } from "./skills/zoom";
import { MeetJoiner } from "./meet_joiner";
import { OpenClawBridge } from "./openclaw_bridge";
import { MeetingPrepSkill } from "./skills/meeting-prep";
import { buildVoiceInstructions, pushContextUpdate, notifyTaskCompletion, prepareMeeting, getPostMeetingSummary } from "./voice-persona";
import { startConfigServer } from "./config_server";
import { readFileSync } from "fs";
import { resolve } from "path";

// ── Read unified VERSION file ────────────────────────────────
let APP_VERSION = "2.4.1";
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

// Wire OpenClaw activity events to EventBus for real-time visibility
openclawBridge.onActivity((kind, summary, detail) => {
  eventBus.emit(kind, { summary, detail });
});

// ── 1c. Vision Module (Meeting Screen Analysis) ──────────────────

// Accumulated screen descriptions for periodic OpenClaw push
let _meetingVisionBuffer: string[] = [];

const vision = new VisionModule({
  bridge,
  context,
  analysisIntervalMs: 1000, // Analyze every 1 second during meetings
  onScreenDescription: (description, _screenshot) => {
    // Buffer descriptions for periodic OpenClaw push
    _meetingVisionBuffer.push(`[${new Date().toLocaleTimeString("zh-CN")}] ${description}`);

    // Push visual context to OpenClaw every 5 descriptions (~40 seconds)
    if (_meetingVisionBuffer.length >= 5 && openclawBridge.connected) {
      const batch = _meetingVisionBuffer.splice(0);
      openclawBridge.sendTask(
        `Meeting screen update — the following visual content was shown during the meeting. ` +
        `Add relevant details to your meeting context for later summary:\n\n${batch.join("\n")}`
      ).catch(() => {});
      console.log(`[MeetingVision] Pushed ${batch.length} screen descriptions to OpenClaw`);
    }
  },
});

// Auto-start meeting vision + open transparency view + activate auditor when meeting starts
eventBus.on("meeting.started", () => {
  if (!vision.isMeetingMode) {
    vision.startMeetingVision(1000);
    console.log("[Init] Meeting vision auto-started");
  }
  // Open meeting transparency panel in browser (foreground)
  Bun.spawn(["open", `http://localhost:${CONFIG.port}/meeting-view.html`]);
  console.log("[Init] Meeting transparency view opened in browser");

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
  }
});

// Auto-stop vision when meeting ends or recording stops
function stopMeetingVisionAndFlush(reason: string) {
  if (!vision.isMeetingMode) return;
  vision.stopMeetingVision();
  // Flush remaining buffer to OpenClaw
  if (_meetingVisionBuffer.length > 0 && openclawBridge.connected) {
    const batch = _meetingVisionBuffer.splice(0);
    openclawBridge.sendTask(
      `${reason} — final screen captures:\n\n${batch.join("\n")}`
    ).catch(() => {});
  }
  console.log(`[Init] Meeting vision stopped (${reason})`);
}

eventBus.on("meeting.ended", () => {
  stopMeetingVisionAndFlush("Meeting ended");

  // ── Stop admission monitor ──
  if (playwrightCli.isAdmissionMonitoring) {
    playwrightCli.stopAdmissionMonitor();
  }

  // ── Deactivate TranscriptAuditor + restore all tools to OpenAI ──
  if (transcriptAuditor.active) {
    transcriptAuditor.deactivate();
    if (voice.connected) {
      voice.restoreAllTools();
      console.log("[Init] Restored all tools to OpenAI session (auditor deactivated)");
    }
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

// Update SharedContext when sidecar sends screenshots (only when vision module is NOT handling it)
bridge.on("screenshot", (msg) => {
  if (!vision.isMeetingMode) {
    context.updateScreen(msg.payload.image);
  }
});

// ── 2b. Automation Layers (Playwright + Peekaboo + Router) ──────

const playwrightCli = new PlaywrightCLIClient({
  headless: CONFIG.playwright.headless,
  profileDir: CONFIG.playwright.userDataDir || undefined,
});

const peekaboo = new PeekabooClient();
const zoomSkill = new ZoomSkill(bridge);
const automationRouter = new AutomationRouter(bridge, eventBus, playwrightCli, peekaboo);

// Start Layer 2 (Playwright CLI) in background — non-blocking
playwrightCli.start().then(() => {
  console.log("[Init] Layer 2 (Playwright CLI) ready");
}).catch((e) => {
  console.warn("[Init] Layer 2 (Playwright CLI) not available:", e.message);
});

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

// ── 3. Voice Module (OpenAI Realtime) ───────────────────────────

const voice = new VoiceModule({
  context,
  tools: [
    {
      name: "schedule_meeting",
      description:
        "Schedule a meeting on Google Calendar. Call this when the user asks to book, schedule, or set up a meeting.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Meeting title" },
          start: { type: "string", description: "Start time ISO string" },
          end: { type: "string", description: "End time ISO string" },
          attendees: {
            type: "array",
            items: { type: "string" },
            description: "Email addresses of attendees",
          },
        },
        required: ["summary", "start", "end"],
      },
    },
    {
      name: "check_calendar",
      description:
        "Check upcoming calendar events. Call when user asks about their schedule.",
      parameters: {
        type: "object",
        properties: {
          max_results: { type: "number", description: "Number of events to fetch" },
        },
      },
    },
    {
      name: "join_meeting",
      description:
        "Join a Google Meet meeting. Call when user provides a Meet link or asks to join a meeting. CallingClaw will auto-join, mute camera, and start AI voice bridging.",
      parameters: {
        type: "object",
        properties: {
          meet_url: {
            type: "string",
            description: "Google Meet URL (e.g. https://meet.google.com/abc-defg-hij)",
          },
        },
        required: ["meet_url"],
      },
    },
    {
      name: "create_and_join_meeting",
      description:
        "Create a new Google Meet meeting with attendees and auto-join it. Call when user wants to start a new meeting.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Meeting title" },
          duration_minutes: { type: "number", description: "Duration in minutes (default 30)" },
          attendees: {
            type: "array",
            items: { type: "string" },
            description: "Email addresses of attendees",
          },
        },
        required: ["summary"],
      },
    },
    {
      name: "leave_meeting",
      description: "Leave the current Google Meet meeting. Automatically saves meeting notes and creates tasks from action items.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "computer_action",
      description:
        "Perform an action on the computer screen. Call when user asks to click, type, open, share screen, or interact with something on screen. CallingClaw has its own dedicated computer.",
      parameters: {
        type: "object",
        properties: {
          instruction: {
            type: "string",
            description: "What to do on the computer",
          },
        },
        required: ["instruction"],
      },
    },
    {
      name: "take_screenshot",
      description:
        "Take a screenshot of CallingClaw's screen. Call when you need to see what's currently displayed.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "save_meeting_notes",
      description:
        "Save current meeting notes and transcript to a markdown file. Call when the meeting ends or the user asks to save notes.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Optional filename (auto-generated if omitted)" },
        },
      },
    },
    {
      name: "share_screen",
      description:
        "Share CallingClaw's screen in the current Google Meet call so meeting participants can see what's on screen.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "stop_sharing",
      description: "Stop sharing CallingClaw's screen in Google Meet.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "open_file",
      description:
        "Open a file on CallingClaw's screen for discussion or presentation. Use during meetings to show code, documents, or web pages.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path or URL to open" },
          app: {
            type: "string",
            enum: ["vscode", "browser", "finder"],
            description: "App to open with (default: vscode)",
          },
        },
        required: ["path"],
      },
    },
    // ── Context Recall (System 2 Memory Access) ──
    {
      name: "recall_context",
      description:
        "Recall specific context about the user's work, projects, plans, or past discussions from OpenClaw's memory and files. " +
        "Call this when the user asks about something specific that your background context doesn't cover — " +
        "like project status, blog performance metrics, past decisions, launch plans, file contents, or any domain-specific question. " +
        "Do NOT call this for general questions you can answer from your background context.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What context you need. Be specific. Example: 'memdex blog posts published recently and their performance' or 'launch plans for Tanka Link 2.0 and what can be reused'",
          },
          urgency: {
            type: "string",
            enum: ["quick", "thorough"],
            description: "quick = search local memory only (<1s). thorough = delegate to OpenClaw agent for deep search with file access (5-15s).",
          },
        },
        required: ["query"],
      },
    },
    // ── Zoom Controls ──
    {
      name: "zoom_control",
      description:
        "Control the Zoom desktop app. Use for: muting/unmuting, toggling video, sharing screen, " +
        "joining/leaving Zoom meetings, raising hand, toggling chat, recording. " +
        "These are instant keyboard shortcut operations — much faster than Computer Use.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "toggle_mute", "toggle_video", "start_share", "stop_share",
              "share_screen", "end_meeting", "raise_hand", "toggle_chat",
              "toggle_participants", "start_recording", "fullscreen",
              "join_url", "send_chat", "activate",
            ],
            description: "Zoom action to perform",
          },
          url: { type: "string", description: "Zoom meeting URL (for join_url)" },
          message: { type: "string", description: "Chat message (for send_chat)" },
          target: { type: "string", description: "Share target — 'Desktop 1' or window name (for share_screen)" },
        },
        required: ["action"],
      },
    },
    // ── Browser Automation (Playwright CLI) ──
    {
      name: "browser_action",
      description:
        "Control the browser via Playwright CLI (Layer 2). Much faster and more token-efficient than Computer Use. " +
        "Uses accessibility tree snapshots with @ref identifiers for precise element targeting. " +
        "Supports: navigate to URL, switch tabs, scroll, click elements by @ref, type text, take snapshot. " +
        "Use for Notion, GitHub, Google Slides, Google Calendar web, and any browser task.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["navigate", "snapshot", "click", "type", "scroll_down", "scroll_up",
                   "next_tab", "prev_tab", "new_tab", "close_tab", "press_key"],
            description: "Browser action to perform",
          },
          url: { type: "string", description: "URL to navigate to (for navigate/new_tab)" },
          ref: { type: "string", description: "Element @ref from snapshot, e.g. 'e1' or '@e1' (for click/type)" },
          text: { type: "string", description: "Text to type or key to press" },
        },
        required: ["action"],
      },
    },
  ],
  onToolCall: async (name, args) => {
    switch (name) {
      case "schedule_meeting": {
        const result = await calendar.createEvent({
          summary: args.summary,
          start: args.start,
          end: args.end,
          attendees: args.attendees,
        });
        return result;
      }
      case "check_calendar": {
        eventBus.emit("voice.tool_call", { tool: "check_calendar" });
        const events = await calendar.listUpcomingEvents(args.max_results || 5);
        return JSON.stringify(events, null, 2);
      }
      case "join_meeting": {
        // Start meeting correlation for event tracking
        const corrId = eventBus.startCorrelation("mtg");
        eventBus.emit("meeting.joining", { meet_url: args.meet_url });

        // ── Step 1: Look up calendar event to get attendees ──
        let meetAttendees: import("./mcp_client/google_cal").CalendarAttendee[] = [];
        let calEvent: import("./mcp_client/google_cal").CalendarEvent | null = null;
        if (calendar.connected) {
          try {
            calEvent = await calendar.findEventByMeetUrl(args.meet_url);
            if (calEvent?.attendees) {
              meetAttendees = calEvent.attendees;
              console.log(`[Meeting] Found ${meetAttendees.length} attendees from calendar: ${meetAttendees.map(a => a.displayName || a.email).join(", ")}`);
            }
          } catch (e: any) {
            console.warn("[Meeting] Calendar lookup failed:", e.message);
          }
        }

        // ── Step 2: Generate meeting prep brief with attendee context ──
        const meetTopic = calEvent?.summary || context.workspace?.topic || `Meeting at ${args.meet_url}`;
        let prepResult: { brief: any; instructions: string } | null = null;
        if (openclawBridge.connected) {
          try {
            prepResult = await prepareMeeting(meetingPrepSkill, meetTopic, undefined, meetAttendees);
            if (voice.connected) {
              voice.updateInstructions(prepResult.instructions);
              console.log("[Meeting] Voice switched to MEETING_PERSONA with prep brief");
            }
          } catch (e: any) {
            console.warn("[Meeting] Prep brief generation failed (continuing without):", e.message);
          }
        }

        // ── Step 3: Join via Playwright fast-path (deterministic, no AI model) ──
        // Switch system audio to BlackHole first
        let usedPlaywright = false;
        let joinSuccess = false;
        let joinSummary = "";

        let joinState: "in_meeting" | "waiting_room" | "failed" = "failed";

        if (playwrightCli.connected) {
          console.log("[Meeting] Using Playwright fast-join (deterministic path)...");
          const result = await playwrightCli.joinGoogleMeet(args.meet_url, {
            muteCamera: true,
            muteMic: false, // Keep mic ON for BlackHole bridge
            onStep: (step) => eventBus.emit("meeting.join_step", { step }),
          });
          usedPlaywright = true;
          joinSuccess = result.success;
          joinState = result.state;
          joinSummary = result.summary;

          if (result.success || result.state === "waiting_room") {
            // ── Step 4: Start admission monitor for expected attendees ──
            const attendeeNames = meetAttendees
              .filter((a) => !a.self)
              .map((a) => a.displayName || a.email);
            playwrightCli.startAdmissionMonitor(
              attendeeNames,
              3000,
              async (instruction) => {
                console.log("[Meeting] Admission fallback → AutomationRouter");
                await automationRouter.execute(instruction);
              },
            );
            console.log(`[Meeting] Admission monitor started (${attendeeNames.length} expected attendees)`);

            // ── Step 5: Register meeting-end detector (piggybacks on admission monitor) ──
            playwrightCli.onMeetingEnd(() => {
              autoLeaveMeeting();
            });
            console.log("[Meeting] Meeting-end detector registered");
          }
        }

        // Fallback to MeetJoiner (osascript) if Playwright not available
        if (!usedPlaywright) {
          console.log("[Meeting] Playwright not available, using MeetJoiner (osascript)...");
          const session = await meetJoiner.joinMeeting({
            meetUrl: args.meet_url,
            muteCamera: true,
            muteMic: true,
          });
          joinSuccess = session.status === "in_meeting";
          joinState = joinSuccess ? "in_meeting" : "failed";
          joinSummary = joinSuccess ? "Joined via MeetJoiner" : (session.error || "Unknown error");
        }

        // Only emit meeting.started when ACTUALLY in the meeting
        if (joinState === "in_meeting") {
          meeting.startRecording();
          eventBus.emit("meeting.started", { meet_url: args.meet_url, correlation_id: corrId });
        }

        // Background poll: if stuck in waiting_room, keep checking until admitted (5 min)
        // Now cancellable via _waitingRoomAbort (cleared on meeting end)
        if (joinState === "waiting_room" && playwrightCli.connected) {
          console.log("[Meeting] In waiting room — background poll until admitted...");
          _waitingRoomAbort = new AbortController();
          const signal = _waitingRoomAbort.signal;
          const meetUrl = args.meet_url;
          (async () => {
            for (let i = 0; i < 60; i++) {
              if (signal.aborted) { console.log("[Meeting] Waiting room poll cancelled"); return; }
              await new Promise(r => setTimeout(r, 5000));
              if (signal.aborted) return;
              try {
                const check = await playwrightCli.evaluate(`() => {
                  const leave = document.querySelector('[aria-label*="Leave call"], [aria-label*="退出通话"]');
                  const controls = document.querySelector('[aria-label="Call controls"]');
                  if (leave || controls) return 'in_meeting';
                  const text = document.body.innerText;
                  if (text.includes('removed') || text.includes('denied')) return 'rejected';
                  if (text.includes('meeting has ended') || text.includes('会议已结束')) return 'ended';
                  return 'waiting';
                }`);
                if (check.includes("in_meeting")) {
                  console.log("[Meeting] Admitted from waiting room!");
                  _waitingRoomAbort = null;
                  meeting.startRecording();
                  eventBus.emit("meeting.started", { meet_url: meetUrl, correlation_id: corrId });
                  break;
                }
                if (check.includes("rejected") || check.includes("ended")) {
                  console.log(`[Meeting] ${check} from waiting room`);
                  _waitingRoomAbort = null;
                  break;
                }
              } catch {}
            }
          })();
        }

        const briefStatus = prepResult ? ` Meeting brief loaded: ${prepResult.brief.keyPoints?.length || 0} key points, ${meetAttendees.length} attendees.` : "";
        const admitStatus = meetAttendees.length > 0 ? ` Admission monitor active for ${meetAttendees.filter(a => !a.self).length} attendees.` : "";
        if (joinState === "in_meeting") {
          return `Successfully joined meeting: ${args.meet_url}. Audio bridging active — I can now hear and speak in the meeting.${briefStatus}${admitStatus}`;
        }
        if (joinState === "waiting_room") {
          return `Waiting in meeting lobby for host to admit. Will auto-detect when admitted and start recording.${briefStatus}${admitStatus}`;
        }
        return `Failed to join: ${joinSummary}`;
      }
      case "create_and_join_meeting": {
        const corrId = eventBus.startCorrelation("mtg");
        eventBus.emit("meeting.creating", { summary: args.summary });

        const session = await meetJoiner.createAndJoinMeeting(
          calendar,
          args.summary,
          args.duration_minutes || 30,
          args.attendees || []
        );
        if (session.status === "in_meeting") {
          meeting.startRecording();
          eventBus.emit("meeting.started", {
            meet_url: session.meetUrl,
            summary: args.summary,
            correlation_id: corrId,
          });
        }
        return session.status === "in_meeting"
          ? `Created and joined meeting "${args.summary}" at ${session.meetUrl}. Audio bridging active.`
          : `Failed: ${session.error}`;
      }
      case "leave_meeting": {
        // Stop meeting-end watcher + admission monitor
        playwrightCli.clearMeetingEndCallback();
        if (_waitingRoomAbort) { _waitingRoomAbort.abort(); _waitingRoomAbort = null; }
        if (playwrightCli.isAdmissionMonitoring) {
          const admitted = playwrightCli.stopAdmissionMonitor();
          if (admitted.length > 0) {
            meetingPrepSkill.addLiveNote(`[ADMIT] Admitted attendees: ${admitted.join(", ")}`);
          }
        }
        // Generate summary before leaving
        const summary = await meeting.generateSummary();
        const filepath = await meeting.exportToMarkdown(summary);
        meeting.stopRecording();
        await meetJoiner.leaveMeeting();

        // Auto-create tasks from action items
        let createdTasks: any[] = [];
        if (summary.actionItems && summary.actionItems.length > 0) {
          createdTasks = taskStore.createFromMeetingItems(
            summary.actionItems.map((a) => ({
              task: a.task,
              assignee: a.assignee,
              deadline: a.deadline,
            }))
          );
        }

        // ── Build structured follow-up for user confirmation ──
        const followUp = {
          filepath,
          summary,
          tasks: createdTasks.map((t) => ({ id: t.id, task: t.task, assignee: t.assignee, deadline: t.deadline })),
          pendingConfirmation: true,
          generatedAt: Date.now(),
        };

        eventBus.emit("meeting.ended", followUp);
        eventBus.endCorrelation();

        // Gather prep skill's live notes for enriched follow-up
        const prepSummary = getPostMeetingSummary(meetingPrepSkill);

        // ── Smart Todo Delivery: send concise todos to Telegram with inline buttons ──
        // User confirms → deep research + sub-agent execution per todo
        postMeetingDelivery.deliver({
          summary,
          notesFilePath: filepath,
          prepSummary,
        }).catch((e: any) => {
          console.error("[PostMeeting] Delivery failed:", e.message);
          // Fallback: push full report to OpenClaw directly
          if (openclawBridge.connected) {
            const followUpText = [
              `## 会议结束 — Follow-up Report`,
              `**主题**: ${summary.title || "Meeting"}`,
              `**时间**: ${new Date().toLocaleString("zh-CN")}`,
              `**记录文件**: ${filepath}`,
              summary.keyPoints?.length > 0 ? `\n### 关键结论\n${summary.keyPoints.map((p: string) => `- ${p}`).join("\n")}` : "",
              createdTasks.length > 0 ? `\n### 待执行任务\n${createdTasks.map((t: any) => `- [ ] ${t.task}`).join("\n")}` : "",
            ].filter(Boolean).join("\n");
            openclawBridge.sendTask(`Meeting follow-up (delivery failed, sending raw):\n\n${followUpText}`).catch(() => {});
          }
        });

        // Clear meeting prep state + revert voice to default persona
        meetingPrepSkill.clear();
        if (voice.connected) {
          const defaultBrief = contextSync.getBrief().voice;
          const defaultInstructions = buildVoiceInstructions() +
            (defaultBrief ? `\n═══ BACKGROUND CONTEXT (from OpenClaw memory) ═══\n${defaultBrief}` : "");
          voice.updateInstructions(defaultInstructions);
          console.log("[Meeting] Voice reverted to DEFAULT_PERSONA");
        }

        return `Left the meeting. Notes saved to: ${filepath}. Created ${createdTasks.length} tasks. Follow-up report has been sent — pending your confirmation to start executing.`;
      }
      case "recall_context": {
        const query = args.query as string;
        const urgency = (args.urgency as string) || "quick";
        eventBus.emit("voice.tool_call", { tool: "recall_context", query: query.slice(0, 80), urgency });

        // Path A: Quick — local MEMORY.md keyword search (<100ms)
        const localResult = contextSync.searchMemory(query);

        if (urgency === "quick" || !openclawBridge.connected) {
          if (localResult) {
            return `[Memory recall]\n${localResult}`;
          }
          if (!openclawBridge.connected) {
            return "I couldn't find specific information about that in my local memory, and OpenClaw is not currently available for a deeper search. Could you give me more context about what you're referring to?";
          }
          // Quick search found nothing — auto-escalate to thorough
        }

        // Path B: Thorough — delegate to OpenClaw (2-15s)
        console.log(`[RecallContext] Delegating to OpenClaw: "${query.slice(0, 80)}"`);
        const openclawResult = await openclawBridge.sendTask(
          `The user asked a question that requires context recall. Search your memory (MEMORY.md), recent files, and conversation history to find relevant information.\n\n` +
          `User's question context: "${query}"\n\n` +
          `${localResult ? `I found some potentially relevant local context:\n${localResult}\n\nPlease expand on this with more details.` : "No local context found. Please search broadly."}\n\n` +
          `Return a concise factual answer (under 500 words) that the voice assistant can relay to the user. Focus on concrete facts, dates, metrics, and actionable information. Answer in the user's language (likely Chinese).`
        );

        return `[OpenClaw recall]\n${openclawResult}`;
      }
      case "computer_action": {
        eventBus.emit("voice.tool_call", { tool: "computer_action", instruction: (args.instruction as string).slice(0, 80) });
        // Route through the 4-layer automation router first
        eventBus.emit("computer.task_started", { instruction: args.instruction });
        const routerResult = await automationRouter.execute(args.instruction);

        // If the router handled it (Layer 1-3), return immediately
        if (routerResult.success) {
          eventBus.emit("computer.task_done", {
            instruction: args.instruction,
            summary: routerResult.result,
            layer: routerResult.layer,
            durationMs: routerResult.durationMs,
          });
          // Notify Voice AI of task completion during meetings (persistent live note)
          if (meetingPrepSkill.currentBrief) {
            notifyTaskCompletion(voice, meetingPrepSkill, args.instruction, routerResult.result);
          }
          return `[${routerResult.layer}${routerResult.fallback ? " (fallback)" : ""}, ${routerResult.durationMs}ms] ${routerResult.result}`;
        }

        // Layer 4 fallback: Computer Use (vision-based)
        if (!computerUse.isConfigured) {
          return "No automation layer could handle this. Computer Use requires an API key.";
        }
        const cuResult = await computerUse.execute(args.instruction);
        eventBus.emit("computer.task_done", { instruction: args.instruction, summary: cuResult.summary, layer: "computer_use" });
        // Notify Voice AI of task completion during meetings
        if (meetingPrepSkill.currentBrief) {
          notifyTaskCompletion(voice, meetingPrepSkill, args.instruction, cuResult.summary);
        }
        return cuResult.summary;
      }
      case "take_screenshot": {
        eventBus.emit("voice.tool_call", { tool: "take_screenshot" });
        return new Promise((resolve) => {
          const timeout = setTimeout(() => resolve("Screenshot timeout"), 5000);
          bridge.once("screenshot", (msg) => {
            clearTimeout(timeout);
            context.updateScreen(msg.payload.image);
            resolve("Screenshot captured. I can see the current screen.");
          });
          bridge.sendAction("screenshot", {});
        });
      }
      case "save_meeting_notes": {
        const summary = await meeting.generateSummary();
        const filepath = await meeting.exportToMarkdown(summary, args.filename);

        // Auto-create tasks
        let createdTasks: any[] = [];
        if (summary.actionItems && summary.actionItems.length > 0) {
          createdTasks = taskStore.createFromMeetingItems(
            summary.actionItems.map((a) => ({
              task: a.task,
              assignee: a.assignee,
              deadline: a.deadline,
            }))
          );
        }

        return `Meeting notes saved to: ${filepath}. Created ${createdTasks.length} tasks.`;
      }
      case "share_screen": {
        eventBus.emit("voice.tool_call", { tool: "share_screen" });
        const ok = await meetJoiner.shareScreen();
        return ok
          ? "Screen sharing started — meeting participants can now see CallingClaw's screen."
          : "Failed to start screen sharing. Make sure we're in a meeting.";
      }
      case "stop_sharing": {
        await meetJoiner.stopSharing();
        return "Screen sharing stopped.";
      }
      case "open_file": {
        eventBus.emit("voice.tool_call", { tool: "open_file", summary: args.path });
        await meetJoiner.openFile(args.path, args.app || "vscode");
        return `Opened ${args.path} in ${args.app || "vscode"}.`;
      }
      case "zoom_control": {
        const zoomResult = await zoomSkill.execute(args.action, {
          url: args.url,
          message: args.message,
          target: args.target,
        });
        eventBus.emit("automation.zoom", {
          action: args.action,
          success: zoomResult.success,
          durationMs: zoomResult.durationMs,
        });
        return zoomResult.success
          ? `[Zoom, ${zoomResult.durationMs}ms] ${zoomResult.detail}`
          : `Zoom error: ${zoomResult.detail}`;
      }
      case "browser_action": {
        if (!playwrightCli.connected) {
          return "Playwright CLI not connected. Browser automation unavailable.";
        }
        try {
          let browserResult = "";
          switch (args.action) {
            case "navigate":
              browserResult = await playwrightCli.navigate(args.url || "about:blank");
              break;
            case "snapshot":
              browserResult = await playwrightCli.snapshot();
              break;
            case "click":
              browserResult = await playwrightCli.click(args.ref || "");
              break;
            case "type":
              browserResult = await playwrightCli.type(args.ref || "", args.text || "");
              break;
            case "scroll_down":
              browserResult = await playwrightCli.scroll("down");
              break;
            case "scroll_up":
              browserResult = await playwrightCli.scroll("up");
              break;
            case "next_tab":
              browserResult = await playwrightCli.pressKey("Control+Tab");
              break;
            case "prev_tab":
              browserResult = await playwrightCli.pressKey("Control+Shift+Tab");
              break;
            case "new_tab":
              browserResult = await playwrightCli.newTab(args.url);
              break;
            case "close_tab":
              browserResult = await playwrightCli.closeTab();
              break;
            case "press_key":
              browserResult = await playwrightCli.pressKey(args.text || "");
              break;
            default:
              browserResult = `Unknown browser action: ${args.action}`;
          }
          eventBus.emit("automation.browser", { action: args.action });
          return browserResult;
        } catch (e: any) {
          return `Browser error: ${e.message}`;
        }
      }
      default:
        return `Unknown tool: ${name}`;
    }
  },
});

// ── 4. Meeting Module ───────────────────────────────────────────

const meeting = new MeetingModule(context);

// Forward meeting action items to EventBus
context.on("note", (note) => {
  if (note.type === "action_item" || note.type === "todo") {
    eventBus.emit("meeting.action_item", {
      text: note.text,
      assignee: note.assignee,
    });
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
