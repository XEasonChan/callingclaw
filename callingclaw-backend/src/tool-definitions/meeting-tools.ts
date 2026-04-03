// CallingClaw 2.0 — Meeting Tool Definitions & Handlers
// Tools: join_meeting, create_and_join_meeting, leave_meeting,
//        save_meeting_notes, share_screen, stop_sharing, open_file

import type { ToolModule } from "./types";
import { CONFIG } from "../config";
import type { GoogleCalendarClient, CalendarAttendee } from "../mcp_client/google_cal";
import type { PlaywrightCLIClient } from "../mcp_client/playwright-cli";
import type { ChromeLauncher } from "../chrome-launcher";
import type { MeetJoiner } from "../meet_joiner";
import type { OpenClawBridge } from "../openclaw_bridge";
import type { MeetingPrepSkill } from "../skills/meeting-prep";
import type { VoiceModule } from "../modules/voice";
import type { MeetingModule } from "../modules/meeting";
import type { EventBus } from "../modules/event-bus";
import type { AutomationRouter } from "../modules/automation-router";
import type { TaskStore } from "../modules/task-store";
import type { SharedContext } from "../modules/shared-context";
import type { ContextSync } from "../modules/context-sync";
import type { PostMeetingDelivery } from "../modules/post-meeting-delivery";
import { buildVoiceInstructions, prepareMeeting, getPostMeetingSummary, injectMeetingBrief } from "../voice-persona";
import { generateMeetingId, upsertSession } from "../modules/shared-documents";
import { OC009_PROMPT, type OC009_Request } from "../openclaw-protocol";

export interface MeetingToolDeps {
  calendar: GoogleCalendarClient;
  playwrightCli: PlaywrightCLIClient;
  chromeLauncher?: ChromeLauncher;
  meetJoiner: MeetJoiner;
  openclawBridge: OpenClawBridge;
  meetingPrepSkill: MeetingPrepSkill;
  voice: VoiceModule;
  meeting: MeetingModule;
  eventBus: EventBus;
  automationRouter: AutomationRouter;
  taskStore: TaskStore;
  context: SharedContext;
  contextSync: ContextSync;
  postMeetingDelivery: PostMeetingDelivery;
  sessionManager?: import("../modules/session-manager").SessionManager;
  /** Called when the meeting ends externally (host ended, kicked, etc.) */
  autoLeaveMeeting: () => void;
  /** Returns the current waiting room abort controller, and allows setting it */
  getWaitingRoomAbort: () => AbortController | null;
  setWaitingRoomAbort: (abort: AbortController | null) => void;
}

export function meetingTools(deps: MeetingToolDeps): ToolModule {
  // NOTE: `voice` is NOT destructured here — it must be accessed lazily via deps.voice
  // because VoiceModule is created AFTER buildAllTools() is called.
  const {
    calendar,
    playwrightCli,
    meetJoiner,
    openclawBridge,
    meetingPrepSkill,
    meeting,
    eventBus,
    automationRouter,
    taskStore,
    context,
    contextSync,
    postMeetingDelivery,
    autoLeaveMeeting,
    getWaitingRoomAbort,
    setWaitingRoomAbort,
  } = deps;

  return {
    definitions: [
      {
        name: "join_meeting",
        description:
          "Join an EXISTING Google Meet meeting by its URL. Use this when: (1) user says '加入会议/帮我进会议/join the meeting', (2) a Meet link is available from meeting context or user input. This tool ONLY joins — it never creates a new meeting. If the meeting context already has a meetLink, use it directly without asking.",
        parameters: {
          type: "object",
          properties: {
            meet_url: {
              type: "string",
              description: "Google Meet URL — must be a real URL from meeting context or user input. NEVER fabricate a URL.",
            },
          },
          required: ["meet_url"],
        },
      },
      {
        name: "create_and_join_meeting",
        description:
          "Create a NEW Google Meet meeting on Google Calendar and auto-join it. ONLY call when user EXPLICITLY asks to CREATE/新建/发起 a new meeting (e.g. '帮我创建一个会议', 'create a new meeting'). NEVER call this for joining existing meetings — use join_meeting instead. IMPORTANT: If the intended time slot overlaps with an existing calendar event, this is almost certainly a wrong intent — the user likely wants to JOIN that existing meeting, not create a duplicate. Use check_calendar first to verify no conflict before creating. When user specifies a time (e.g. '下午6点', '18:00'), you MUST set start_time accordingly.",
        parameters: {
          type: "object",
          properties: {
            summary: { type: "string", description: "Meeting title" },
            start_time: { type: "string", description: "Meeting start time as ISO 8601 string with timezone offset (e.g. '2026-03-31T17:00:00+08:00'). MUST use the current date from system context — '今天' means TODAY's date, '明天' means tomorrow. If not specified, defaults to now." },
            duration_minutes: { type: "number", description: "Duration in minutes (default 60)" },
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
    ],

    handler: async (name, args) => {
      switch (name) {
        case "join_meeting": {
          // Start meeting correlation for event tracking
          const corrId = eventBus.startCorrelation("mtg");
          eventBus.emit("meeting.joining", { meet_url: args.meet_url });

          // ── Step 1: Look up calendar event to get attendees ──
          let meetAttendees: CalendarAttendee[] = [];
          let calEvent: import("../mcp_client/google_cal").CalendarEvent | null = null;
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

          // ── Step 2: Generate or load meeting prep brief ──
          const meetTopic = calEvent?.summary || context.workspace?.topic || `Meeting at ${args.meet_url}`;
          const toolSession = deps.sessionManager?.findOrCreate({ topic: meetTopic, meetUrl: args.meet_url })
            || { meetingId: generateMeetingId(), files: {} as Record<string, string> };
          const toolMeetingId = toolSession.meetingId;
          deps.sessionManager?.markActive(toolMeetingId, { meetUrl: args.meet_url });
          let prepResult: Awaited<ReturnType<typeof prepareMeeting>> | null = null;
          let prepInjected = false;

          // Path A: OpenClaw available → generate fresh brief
          if (openclawBridge.connected) {
            try {
              prepResult = await prepareMeeting(meetingPrepSkill, meetTopic, undefined, meetAttendees, toolMeetingId);
              if (deps.voice.connected) {
                injectMeetingBrief(deps.voice, prepResult.brief);
                prepInjected = true;
                console.log("[Meeting] Layer 2 meeting brief injected (OpenClaw)");
              }
            } catch (e: any) {
              console.warn("[Meeting] Prep brief generation failed (continuing without):", e.message);
            }
          }

          // Path B: No OpenClaw → load existing prep file from disk
          if (!prepInjected && deps.voice.connected) {
            try {
              const { SHARED_DIR } = await import("../config");
              const { resolve } = await import("path");
              // Search order: session file → prep/ subdirectory → SHARED_DIR root
              const candidates = [
                toolSession.files?.prep ? resolve(SHARED_DIR, toolSession.files.prep) : "",
                resolve(SHARED_DIR, "prep", toolMeetingId + "_prep.md"),
                resolve(SHARED_DIR, toolMeetingId + "_prep.md"),
              ].filter(Boolean);

              // Also scan prep/ directory for topic-matching files
              const { readdirSync } = await import("fs");
              try {
                const prepDir = resolve(SHARED_DIR, "prep");
                const prepFiles = readdirSync(prepDir).filter((f: string) => f.endsWith("_prep.md"));
                for (const pf of prepFiles) {
                  if (!candidates.includes(resolve(prepDir, pf))) {
                    candidates.push(resolve(prepDir, pf));
                  }
                }
              } catch {}

              for (const filePath of candidates) {
                try {
                  const content = await Bun.file(filePath).text();
                  if (content && content.length > 50) {
                    // Check if topic matches (title in first line of markdown)
                    const firstLine = content.split("\n")[0]?.replace(/^#+\s*/, "").trim() || "";
                    const topicLower = meetTopic.toLowerCase();
                    const titleLower = firstLine.toLowerCase();
                    const isMatch = titleLower.includes(topicLower) || topicLower.includes(titleLower)
                      || filePath.includes(toolMeetingId);

                    if (isMatch || candidates.indexOf(filePath) < 3) {
                      // Inject markdown directly as Layer 2 context
                      const { MISSION_CONTEXT_PREFIX, MISSION_CONTEXT_SUFFIX } = await import("../prompt-constants");
                      const briefText = [
                        MISSION_CONTEXT_PREFIX,
                        `Topic: ${meetTopic}`,
                        "",
                        content.slice(0, 4000), // Token budget ~1000 tokens
                        "",
                        MISSION_CONTEXT_SUFFIX,
                        "This is pre-vetted meeting prep material. Use it proactively when answering questions about meeting topics. Do not call recall_context for information already covered here.",
                      ].join("\n");

                      deps.voice.injectContext(briefText);
                      prepInjected = true;
                      console.log(`[Meeting] Layer 2 prep loaded from disk: ${filePath} (${content.length} chars)`);
                      break;
                    }
                  }
                } catch {}
              }
              if (!prepInjected) {
                console.log("[Meeting] No matching prep file found on disk");
              }
            } catch (e: any) {
              console.warn("[Meeting] Disk prep loading failed:", e.message);
            }
          }

          // ── Step 3: Join via ChromeLauncher (preferred — has audio injection) or Playwright CLI ──
          let usedPlaywright = false;
          let joinSuccess = false;
          let joinSummary = "";
          let joinState: "in_meeting" | "waiting_room" | "failed" = "failed";
          const chromeLauncher = deps.chromeLauncher;

          // Preferred: ChromeLauncher (Playwright library with audio injection initScript)
          if (chromeLauncher) {
            console.log("[Meeting] Using ChromeLauncher join (Playwright library, audio injection)...");
            // Ensure Chrome is launched (lazy init — first call starts the browser)
            await chromeLauncher.launch();
            const result = await chromeLauncher.joinGoogleMeet(args.meet_url, {
              muteCamera: true,
              muteMic: false, // Mic ON for audio injection
              onStep: (step) => eventBus.emit("meeting.join_step", { step }),
            });
            usedPlaywright = true;
            joinSuccess = result.success;
            joinState = result.state;
            joinSummary = result.summary;

            // Activate audio pipeline after joining (captures meeting audio + enables AI playback)
            if (joinSuccess) {
              try {
                const pipelineResult = await chromeLauncher.activateAudioPipeline();
                console.log("[Meeting] ✅ Audio pipeline activated:", pipelineResult);
              } catch (e: any) {
                console.warn("[Meeting] Audio pipeline activation failed:", e.message);
              }
            }

            if (result.success || result.state === "waiting_room") {
              // Start admission monitor via ChromeLauncher
              const attendeeNames = meetAttendees
                .filter((a) => !a.self)
                .map((a) => a.displayName || a.email);
              chromeLauncher.startAdmissionMonitor(
                attendeeNames,
                3000,
                async (instruction) => {
                  console.log("[Meeting] Admission fallback → AutomationRouter");
                  await automationRouter.execute(instruction);
                },
              );
              console.log(`[Meeting] Admission monitor started (${attendeeNames.length} expected attendees)`);

              chromeLauncher.onMeetingEnd(() => {
                autoLeaveMeeting();
              });
              console.log("[Meeting] Meeting-end detector registered");
            }
          }

          // Fallback: Playwright CLI (legacy, no audio injection)
          if (!usedPlaywright) {
            if (!playwrightCli.connected) {
              try { await playwrightCli.start(); } catch {}
            }
            if (playwrightCli.connected) {
              console.log("[Meeting] Using Playwright CLI fast-join (no audio injection)...");
              const result = await playwrightCli.joinGoogleMeet(args.meet_url, {
                muteCamera: true,
                muteMic: false,
                onStep: (step) => eventBus.emit("meeting.join_step", { step }),
              });
              usedPlaywright = true;
              joinSuccess = result.success;
              joinState = result.state;
              joinSummary = result.summary;

              if (result.success || result.state === "waiting_room") {
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
                playwrightCli.onMeetingEnd(() => {
                  autoLeaveMeeting();
                });
                console.log("[Meeting] Meeting-end detector registered");
              }
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
            const abort = new AbortController();
            setWaitingRoomAbort(abort);
            const signal = abort.signal;
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
                    setWaitingRoomAbort(null);
                    meeting.startRecording();
                    eventBus.emit("meeting.started", { meet_url: meetUrl, correlation_id: corrId });
                    break;
                  }
                  if (check.includes("rejected") || check.includes("ended")) {
                    console.log(`[Meeting] ${check} from waiting room`);
                    setWaitingRoomAbort(null);
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

          // Do NOT add CONFIG.userEmail — the organizer already has the event.
          // Adding your own email as an attendee causes Google Calendar to send
          // a self-invitation, creating a duplicate "no response" event.
          const meetingAttendees = [...(args.attendees || [])];

          const session = await meetJoiner.createAndJoinMeeting(
            calendar,
            args.summary,
            args.duration_minutes || 60,
            meetingAttendees,
            args.start_time || undefined,
          );
          eventBus.emit("calendar.updated", { action: "created", summary: args.summary });
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
          const _waitingRoomAbort = getWaitingRoomAbort();
          if (_waitingRoomAbort) { _waitingRoomAbort.abort(); setWaitingRoomAbort(null); }
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

          // Notify Electron UI that summary file is ready
          eventBus.emit("meeting.summary_ready", { filepath, title: summary.title, timestamp: Date.now() });

          // Leave via ChromeLauncher (Playwright page click) if available, otherwise fallback to keyboard shortcut
          if (deps.chromeLauncher) {
            await deps.chromeLauncher.leaveMeeting();
            deps.chromeLauncher.clearMeetingEndCallback();
          }
          await meetJoiner.leaveMeeting();

          // Auto-create tasks from action items
          let createdTasks: any[] = [];
          if (summary.actionItems && summary.actionItems.length > 0) {
            createdTasks = taskStore.createFromMeetingItems(
              summary.actionItems.map((a: any) => ({
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
            tasks: createdTasks.map((t: any) => ({ id: t.id, task: t.task, assignee: t.assignee, deadline: t.deadline })),
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
              const req: OC009_Request = {
                id: "OC-009",
                topic: summary.title || "Meeting",
                time: new Date().toISOString(),
                filepath,
                keyPoints: summary.keyPoints || [],
                tasks: createdTasks.map((t: any) => ({ task: t.task })),
              };
              openclawBridge.sendTask(OC009_PROMPT(req)).catch(() => {});
            }
          });

          // Clear meeting prep state + revert voice to CORE_IDENTITY
          meetingPrepSkill.clear();
          if (deps.voice.connected) {
            deps.voice.updateInstructions(buildVoiceInstructions());
            console.log("[Meeting] Voice reverted to CORE_IDENTITY");
          }

          return `Left the meeting. Notes saved to: ${filepath}. Created ${createdTasks.length} tasks. Follow-up report has been sent — pending your confirmation to start executing.`;
        }
        case "save_meeting_notes": {
          const summary = await meeting.generateSummary();
          const filepath = await meeting.exportToMarkdown(summary, args.filename);

          // Notify Electron UI that summary file is ready
          eventBus.emit("meeting.summary_ready", { filepath, title: summary.title, timestamp: Date.now() });

          // Auto-create tasks
          let createdTasks: any[] = [];
          if (summary.actionItems && summary.actionItems.length > 0) {
            createdTasks = taskStore.createFromMeetingItems(
              summary.actionItems.map((a: any) => ({
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
          // Use AutomationRouter's AI-powered file search for fuzzy matching
          // (voice AI passes guessed filenames like "TankaActionList_Phase1_PRD.html"
          //  that don't match real paths — Haiku resolves the intent to actual files)
          if (automationRouter) {
            try {
              const result = await automationRouter.execute(`open file: ${args.path}`);
              if (result.success) return result.result;
            } catch {}
          }
          // Fallback: direct open if router fails
          await meetJoiner.openFile(args.path, args.app || "browser");
          return `Opened ${args.path} in ${args.app || "browser"}.`;
        }
        default:
          return `Unknown meeting tool: ${name}`;
      }
    },
  };
}
