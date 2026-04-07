// CallingClaw 2.0 — Meeting Tool Definitions & Handlers
// Tools: join_meeting, create_and_join_meeting, leave_meeting,
//        save_meeting_notes, share_screen, stop_sharing, open_file

import type { ToolModule } from "./types";
import { CONFIG } from "../config";
import { PAGE_EXTRACT_JS, formatPageContext, PAGE_CONTEXT_ID } from "../utils/page-extract";
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
            topic: {
              type: "string",
              description: "Meeting topic/title (optional — if not provided, will try to look up from calendar)",
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
          "Share a page in the Google Meet call. Pass what the user said as the url — " +
          "your agent will resolve it to a real URL. Examples: url='CallingClaw 官网', url='PRD 文档', url='Google'. " +
          "Use target='iframe' for local files to load into the Meeting Stage slide frame.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "What to share — can be a natural language description (e.g. '官网', 'PRD', 'Google') or a real URL. Your agent resolves it." },
            target: { type: "string", description: "'iframe' = load into Meeting Stage slide frame (localhost only). Omit for full page share." },
          },
        },
      },
      {
        name: "stop_sharing",
        description: "Stop sharing CallingClaw's screen in Google Meet.",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "open_file",
        description:
          "Open a file on CallingClaw's screen for discussion or presentation. Use doc_number to open a file from the Working Documents list (e.g. 'open the first document' → doc_number: 1).",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path or URL to open" },
            doc_number: { type: "number", description: "Open document by number from Working Documents list (1-based)" },
            app: {
              type: "string",
              enum: ["vscode", "browser", "finder"],
              description: "App to open with (default: vscode)",
            },
          },
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
          // Topic priority: explicit arg > calendar event > workspace context > URL fallback
          const meetTopic = args.topic || calEvent?.summary || context.workspace?.topic || `Meeting at ${args.meet_url}`;
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
              const { SHARED_DIR, SEARCH_PATHS } = await import("../config");
              const { resolve } = await import("path");
              const prepBase = SEARCH_PATHS.prepDir || SHARED_DIR;
              // Search order: session file → prep/ subdirectory → prepDir root → SHARED_DIR root
              const candidates = [
                toolSession.files?.prep ? resolve(prepBase, toolSession.files.prep) : "",
                toolSession.files?.prep ? resolve(SHARED_DIR, toolSession.files.prep) : "",
                resolve(prepBase, "prep", toolMeetingId + "_prep.md"),
                resolve(prepBase, toolMeetingId + "_prep.md"),
                resolve(SHARED_DIR, "prep", toolMeetingId + "_prep.md"),
                resolve(SHARED_DIR, toolMeetingId + "_prep.md"),
              ].filter(Boolean);

              // Also scan prep/ directory for topic-matching files
              const { readdirSync } = await import("fs");
              try {
                const prepDir = resolve(prepBase, "prep");
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
                      // Inject full markdown as Layer 2 context (up to ~8000 chars ≈ 2000 tokens)
                      const { MISSION_CONTEXT_PREFIX, MISSION_CONTEXT_SUFFIX } = await import("../prompt-constants");
                      const briefText = [
                        MISSION_CONTEXT_PREFIX,
                        `Topic: ${meetTopic}`,
                        "",
                        content.slice(0, 8000),
                        "",
                        MISSION_CONTEXT_SUFFIX,
                        "",
                        "## Purpose of this prep material:",
                        "This is background context to help you understand the meeting's topic, goals, history, and participants. Use it to:",
                        "- Understand what this meeting is about and what decisions need to be made",
                        "- Recognize references to past discussions, people, and technical terms",
                        "- Provide informed, contextual responses when users ask questions related to the meeting topic",
                        "- If the prep already contains a direct answer, use it naturally — but your primary role is contextual understanding, not reciting the prep",
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
          const activeSession = deps.sessionManager?.list({ status: "active" })[0]
            || deps.sessionManager?.list({ status: "ended" })[0];
          postMeetingDelivery.deliver({
            summary,
            notesFilePath: filepath,
            prepSummary,
            meetingId: activeSession?.meetingId,
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
          const shareUrl = args.url || "";
          const target = args.target || "";
          eventBus.emit("voice.tool_call", { tool: "share_screen", summary: shareUrl, target });

          if (target === "iframe" && deps.chromeLauncher && shareUrl) {
            // Load content into the stage's slide iframe (same-origin local content)
            const isLocal = shareUrl.startsWith("http://localhost") || shareUrl.startsWith("/") || shareUrl.startsWith("file://");
            if (isLocal) {
              const resolvedUrl = shareUrl.startsWith("/") ? `http://localhost:${CONFIG.port}${shareUrl}` : shareUrl;
              const ok = await deps.chromeLauncher.loadSlideFrame(resolvedUrl);
              if (ok) {
                eventBus.emit("presentation.loaded", { url: resolvedUrl, target: "iframe" });
                return `Loaded into stage slide frame: ${resolvedUrl}`;
              }
              return "Failed to load into stage iframe — presenting page may not be on /stage";
            } else {
              // Cross-origin: navigate the presenting tab directly (share persists on same tab)
              await deps.chromeLauncher.navigatePresentingPage(shareUrl);
              eventBus.emit("presentation.loaded", { url: shareUrl, target: "fullpage" });
              return `Opened external URL in presenting tab: ${shareUrl}. Say "back to stage" to return to Meeting Stage.`;
            }
          }

          // ── Resolve natural language → URL ──
          // Voice model passes user intent ("官网", "PRD", "Google manus"), agent resolves to real URL
          let resolvedShareUrl = shareUrl;
          if (resolvedShareUrl && !resolvedShareUrl.startsWith("http") && !resolvedShareUrl.startsWith("/") && !resolvedShareUrl.startsWith("file:")) {
            // Natural language → URL resolution
            const query = resolvedShareUrl.toLowerCase();
            const brief = meetingPrepSkill?.currentBrief;

            // 1. Check prep brief's known URLs/files
            const knownUrl = brief?.browserUrls?.find(u =>
              query.split(/\s+/).some(w => u.description.toLowerCase().includes(w) || u.url.toLowerCase().includes(w))
            );
            const knownFile = brief?.filePaths?.find(f =>
              query.split(/\s+/).some(w => f.description.toLowerCase().includes(w) || f.path.toLowerCase().includes(w))
            );

            if (knownUrl) {
              resolvedShareUrl = knownUrl.url;
              console.log(`[share_screen] Resolved "${shareUrl}" → ${resolvedShareUrl} (from prep URLs)`);
            } else if (knownFile) {
              // Markdown files → use renderer for CallingClaw-styled display
              if (/\.md$/i.test(knownFile.path)) {
                resolvedShareUrl = `http://localhost:${CONFIG.port}/render.html?file=${encodeURIComponent(knownFile.path)}`;
              } else {
                resolvedShareUrl = knownFile.path.startsWith("/")
                  ? `http://localhost:${CONFIG.port}${knownFile.path}` : knownFile.path;
              }
              console.log(`[share_screen] Resolved "${shareUrl}" → ${resolvedShareUrl} (from prep files)`);
            } else {
              // 3. Search localhost public HTML files by fuzzy name match
              try {
                const fs = require("fs");
                const publicDir = require("path").resolve(import.meta.dir, "../../public");
                const htmlFiles = fs.readdirSync(publicDir).filter((f: string) => f.endsWith(".html") && !f.startsWith("stage-"));
                const queryWords = query.split(/[\s\-_]+/).filter((w: string) => w.length > 2);
                // Score each file: count matching query words
                const scored = htmlFiles.map((f: string) => {
                  const fLower = f.toLowerCase();
                  const hits = queryWords.filter((w: string) => fLower.includes(w.toLowerCase())).length;
                  return { file: f, hits };
                }).filter(s => s.hits > 0).sort((a, b) => b.hits - a.hits);
                const matched = scored[0]?.file;
                if (matched) {
                  resolvedShareUrl = `http://localhost:${CONFIG.port}/${matched}`;
                  console.log(`[share_screen] Resolved "${shareUrl}" → ${resolvedShareUrl} (from public/ files)`);
                }
              } catch {}
            }

            // 4. Google search pattern
            if (resolvedShareUrl === shareUrl && /google/i.test(query)) {
              const searchTerms = query.replace(/google|搜索|搜一下|search/gi, "").trim();
              resolvedShareUrl = searchTerms
                ? `https://www.google.com/search?q=${encodeURIComponent(searchTerms)}`
                : "https://www.google.com";
              console.log(`[share_screen] Resolved "${shareUrl}" → ${resolvedShareUrl} (Google search)`);
            }

            // 5. Last resort: if it looks like a URL path (has dots or slashes), prepend https://
            if (resolvedShareUrl === shareUrl) {
              const cleaned = query.replace(/官网|网站|首页|homepage|文档|document|PRD/gi, "").trim();
              if (cleaned.includes(".") || cleaned.includes("/")) {
                // Already looks like a URL — just add https:// if missing
                resolvedShareUrl = cleaned.startsWith("www.") ? `https://${cleaned}` : `https://www.${cleaned}`;
              } else {
                resolvedShareUrl = `https://www.${cleaned.replace(/\s+/g, "")}.com`;
              }
              console.log(`[share_screen] Resolved "${shareUrl}" → ${resolvedShareUrl} (guessed domain)`);
            }
          }

          // ── If already sharing, load into Stage iframe or navigate tab ──
          if (resolvedShareUrl && deps.chromeLauncher?.presentingPage) {
            try {
              // If presenting tab is on /stage, load content into iframe (preferred)
              const currentUrl = String(deps.chromeLauncher.presentingPage.url());
              const isOnStage = currentUrl.includes("/stage");
              const isLocalContent = resolvedShareUrl.startsWith("http://localhost") || resolvedShareUrl.startsWith("/");

              if (isOnStage && isLocalContent) {
                // Load into Stage iframe — keeps the Meeting Stage layout with dual panels
                const loaded = await deps.chromeLauncher.loadSlideFrame(resolvedShareUrl);
                if (loaded) {
                  console.log(`[share_screen] Loaded into Stage iframe: ${resolvedShareUrl}`);
                  // Extract DOM from IFRAME for voice context
                  const { PAGE_EXTRACT_JS, formatPageContext, PAGE_CONTEXT_ID } = await import("../utils/page-extract");
                  // Wait for iframe to render
                  await new Promise(r => setTimeout(r, 1500));
                  const raw = await deps.chromeLauncher.evaluateOnSlideFrame(`
                    var body = document.body;
                    return body ? body.innerText.slice(0, 2000) : '';
                  `);
                  if (raw && deps.voice) {
                    deps.voice.replaceContext(`[PAGE] Stage iframe content:\n${String(raw).slice(0, 1500)}`, PAGE_CONTEXT_ID);
                  }
                  if (deps.voice) deps.voice.presentationMode = true;
                  return `Loaded into Meeting Stage: ${resolvedShareUrl}. The document is showing in the left panel. Describe what you see.`;
                }
                // loadSlideFrame failed — fall through to navigate
                console.warn(`[share_screen] loadSlideFrame failed, falling through to navigate`);
              }

              // Navigate the presenting tab directly (for external URLs or when Stage isn't active)
              await deps.chromeLauncher.navigatePresentingPage(resolvedShareUrl);
              console.log(`[share_screen] Navigated presenting tab to ${resolvedShareUrl} (reused tab)`);
              // Re-extract DOM to verify page loaded + give voice context
              await new Promise(r => setTimeout(r, 1000)); // wait for page render
              const { PAGE_EXTRACT_JS, formatPageContext, PAGE_CONTEXT_ID } = await import("../utils/page-extract");
              const raw = await deps.chromeLauncher.evaluateOnPresentingPage(PAGE_EXTRACT_JS);
              const pageCtx = formatPageContext(raw);
              if (pageCtx && deps.voice) {
                deps.voice.replaceContext(pageCtx, PAGE_CONTEXT_ID);
                deps.voice.presentationMode = true;
                return `Now presenting: ${resolvedShareUrl}. The page is now visible to all participants. Look at the [PAGE] context to see what's on screen and describe the actual content — headings, features, text you can see. Don't talk about the meeting agenda, describe what the page shows.`;
              }
              // DOM empty — page didn't load properly
              if (deps.voice) deps.voice.presentationMode = true;
              return `Navigated to ${resolvedShareUrl} but page content not yet visible. Wait a moment then try scrolling.`;
            } catch (e: any) {
              console.warn(`[share_screen] Navigate failed, falling through to new share: ${e.message}`);
            }
          }

          // Check for pre-generated custom Stage HTML (iframe src already baked in)
          if (!resolvedShareUrl && deps.chromeLauncher) {
            const stageFile = (() => {
              try {
                const fs = require("fs");
                const publicDir = require("path").resolve(import.meta.dir, "../../public");
                const files = fs.readdirSync(publicDir)
                  .filter((f: string) => f.startsWith("stage-") && f.endsWith(".html") && f !== "stage.html")
                  .map((f: string) => ({ name: f, mtime: fs.statSync(`${publicDir}/${f}`).mtimeMs }))
                  .sort((a: any, b: any) => b.mtime - a.mtime);
                return files[0] ? `http://localhost:${CONFIG.port}/${files[0].name}` : null;
              } catch { return null; }
            })();

            if (stageFile) {
              resolvedShareUrl = stageFile;
              console.log(`[share_screen] Using pre-generated Stage: ${stageFile}`);
            }
          }

          if (!resolvedShareUrl && deps.chromeLauncher) {
            // Fallback: try to find presentable content from prep brief
            const brief = meetingPrepSkill?.currentBrief;

            // 1. Check scenes[] for a URL (presentation.json scenes)
            const sceneUrl = brief?.scenes?.find(s => s.url)?.url;
            // 2. Check filePaths[] for a local .html file
            const htmlFile = brief?.filePaths?.find(f => /\.html?$/i.test(f.path));

            if (sceneUrl) {
              // Scene URL found — load it into Stage iframe, then share the Stage
              const sceneResolved = sceneUrl.startsWith("/")
                ? `http://localhost:${CONFIG.port}${sceneUrl}` : sceneUrl;
              await deps.chromeLauncher.loadSlideFrame(sceneResolved);
              // Share the Stage (which now has content in its iframe)
              resolvedShareUrl = "";  // will become /stage via shareScreen() default
            } else if (htmlFile) {
              // Local HTML file — load it into Stage iframe, then share the Stage
              const htmlResolved = htmlFile.path.startsWith("/")
                ? `http://localhost:${CONFIG.port}${htmlFile.path}` : htmlFile.path;
              await deps.chromeLauncher.loadSlideFrame(htmlResolved);
              resolvedShareUrl = "";  // will become /stage via shareScreen() default
            } else {
              // No content available — refuse to share an empty stage
              return "No content to present. Specify a URL or prepare presentation materials first.";
            }
          }

          // Always prefer ChromeLauncher (Playwright library) — it manages the actual Meet page.
          let shareResult: { success: boolean; message: string } = { success: false, message: "No launcher" };
          if (deps.chromeLauncher) {
            shareResult = await deps.chromeLauncher.shareScreen(resolvedShareUrl || undefined);
          } else {
            const ok = await meetJoiner.shareScreen();
            shareResult = { success: ok, message: ok ? "Sharing (legacy)" : "Failed (legacy)" };
          }

          // If share failed, tell the voice model immediately — don't proceed as if it worked
          if (!shareResult.success) {
            return `Screen share failed: ${shareResult.message}. Try again or check screen recording permission.`;
          }

          // ── Presentation mode: sync voice with screen actions ──
          if (deps.voice) deps.voice.presentationMode = true;

          // Native voice-driven presentation: inject narrative plan + live DOM context
          const brief = meetingPrepSkill?.currentBrief;
          const cl = deps.chromeLauncher;
          if (cl && deps.voice) {
            // Screenshot (best-effort, works for OpenAI 1.5 with image support)
            try {
              const page = cl.presentingPage;
              if (page) {
                const buf = await page.screenshot({ type: "jpeg", quality: 60 });
                deps.voice.injectScreenshot(buf.toString("base64"), `[PRESENTING] ${shareUrl || "screen"}`);
              }
            } catch {}

            // DOM extraction: voice AI sees actual page content (Page Agent approach)
            // Uses fixed ID so each update REPLACES the previous, not accumulates
            try {
              const raw = await cl.evaluateOnPresentingPage(PAGE_EXTRACT_JS);
              const pageCtx = formatPageContext(raw);
              if (pageCtx) deps.voice.replaceContext(pageCtx, PAGE_CONTEXT_ID);
            } catch {}

            // Narrative plan from prep brief
            const narrativeParts: string[] = [];
            if (brief?.goal) narrativeParts.push(`Goal: ${brief.goal}`);
            if (brief?.keyPoints?.length) {
              narrativeParts.push(`Key points:\n${brief.keyPoints.map((p: string, i: number) => `${i + 1}. ${p}`).join("\n")}`);
            }
            if (brief?.speakingPlan?.length) {
              const phases = brief.speakingPlan.map((p: any) => `- ${p.phase}: ${p.points}`).join("\n");
              narrativeParts.push(`Speaking plan:\n${phases}`);
            }
            if (brief?.scenes?.length) {
              const sceneGuide = brief.scenes.map((s: any, i: number) =>
                `Scene ${i + 1}: ${s.url}${s.scrollTarget ? " → " + s.scrollTarget : ""}\n  Say: ${s.talkingPoints}`
              ).join("\n");
              narrativeParts.push(`Presentation scenes (use interact tool to navigate):\n${sceneGuide}`);
            }
            if (brief?.browserUrls?.length) {
              const urls = brief.browserUrls.map((u: any) => `- ${u.url}: ${u.description}`).join("\n");
              narrativeParts.push(`Materials to show:\n${urls}`);
            }

            if (narrativeParts.length > 0) {
              deps.voice.injectContext(
                `[PRESENTATION MODE] You are presenting to the meeting. Describe what you see on the page, scroll to show key sections, and click links to navigate. Use interact tool.\n\n${narrativeParts.join("\n\n")}`
              );
            }
            eventBus.emit("presentation.started", { mode: "native" });
            return `Screen sharing started. You can see the page content — present it naturally using interact to scroll and click.`;
          }

          return "Screen sharing started.";
        }
        case "stop_sharing": {
          if (deps.voice) deps.voice.presentationMode = false;
          await meetJoiner.stopSharing();
          eventBus.emit("presentation.done", { mode: "native" });
          return "Screen sharing stopped.";
        }
        case "open_file": {
          // Resolve doc_number from Working Documents list
          if (args.doc_number && deps.context) {
            const docs = deps.context.stageDocuments;
            const idx = Number(args.doc_number) - 1;
            if (idx >= 0 && idx < docs.length) {
              args.path = docs[idx].path;
            } else {
              return `No document #${args.doc_number}. ${docs.length} documents available: ${docs.map((d: any, i: number) => `${i + 1}. ${d.name}`).join(", ")}`;
            }
          }

          eventBus.emit("voice.tool_call", { tool: "open_file", summary: args.path });

          // Strategy: try multiple search methods in order of reliability
          let resolvedPath: string | null = null;
          const queryPath = args.path || "";

          // 1. Exact path check (if user gave a full/relative path)
          try {
            const { existsSync } = await import("fs");
            const { resolve } = await import("path");
            const home = (await import("os")).homedir();
            const candidates = [
              queryPath,
              resolve(home, "Library/Mobile Documents/com~apple~CloudDocs", queryPath),
              resolve(home, "Library/Mobile Documents/com~apple~CloudDocs/CallingClaw 2.0", queryPath),
              resolve(home, "Library/Mobile Documents/com~apple~CloudDocs/Tanka", queryPath),
            ];
            for (const c of candidates) {
              if (existsSync(c)) { resolvedPath = c; break; }
            }
          } catch {}

          // 2. `find` command — search by filename keywords (fast, deterministic)
          if (!resolvedPath) {
            try {
              const keywords = queryPath.split(/[\s/\\._-]+/).filter((w: string) => w.length > 2);
              const namePattern = keywords.length > 0 ? `*${keywords.join("*")}*` : `*${queryPath}*`;
              const home = (await import("os")).homedir();
              const searchDirs = [
                `${home}/Library/Mobile Documents/com~apple~CloudDocs`,
                `${home}/Desktop`,
                `${home}/.callingclaw/shared`,
              ];
              for (const dir of searchDirs) {
                const result = await Bun.$`find ${dir} -maxdepth 5 -iname ${namePattern} -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null`.text();
                const files = result.trim().split("\n").filter(Boolean);
                if (files.length > 0) {
                  resolvedPath = files[0]!;
                  console.log(`[open_file] Found via find: ${resolvedPath} (${files.length} total matches)`);
                  break;
                }
              }
            } catch {}
          }

          // 3. FileAliasIndex (keyword matching with confidence threshold)
          if (!resolvedPath && automationRouter?.fileIndex?.ready) {
            const match = automationRouter.fileIndex.search(queryPath);
            if (match) resolvedPath = match.path;
          }

          // 4. AutomationRouter Haiku fallback (slowest but smartest)
          if (!resolvedPath && automationRouter) {
            try {
              const result = await automationRouter.execute(`open file: ${queryPath}`);
              if (result.success) return result.result;
            } catch {}
          }

          if (!resolvedPath) {
            // Rich result: return candidate list so model can retry with a better pick.
            // This enables multi-turn agent loop — model sees candidates, calls open_file
            // again with the correct path. Works across all providers (no extra tool needed).
            try {
              const home = (await import("os")).homedir();
              const searchDirs = [
                `${home}/Library/Mobile Documents/com~apple~CloudDocs/Tanka`,
                `${home}/Library/Mobile Documents/com~apple~CloudDocs/CallingClaw 2.0/callingclaw-backend/public`,
                `${home}/Library/Mobile Documents/com~apple~CloudDocs/CallingClaw 2.0/docs`,
                `${home}/.callingclaw/shared`,
              ];
              // Fuzzy search: split query into keywords, find files matching any keyword
              const kws = queryPath.toLowerCase().split(/[\s/\\._-]+/).filter((w: string) => w.length > 2);
              const allFiles: string[] = [];
              for (const dir of searchDirs) {
                try {
                  const out = await Bun.$`find ${dir} -maxdepth 4 -type f \( -name "*.html" -o -name "*.md" -o -name "*.pdf" \) -not -path "*/node_modules/*" 2>/dev/null`.text();
                  for (const line of out.split("\n")) {
                    const p = line.trim();
                    if (p && kws.some((k: string) => p.toLowerCase().includes(k))) allFiles.push(p);
                  }
                } catch {}
              }
              if (allFiles.length > 0) {
                const short = allFiles.slice(0, 8).map((f, i) => `${i + 1}. ${f.replace(home, "~")}`).join("\n");
                return `No exact match for "${queryPath}". Similar files found:\n${short}\n\nCall open_file again with the full path of the best match.`;
              }
            } catch {}
            return `File not found: "${queryPath}". Try different keywords or check the file name.`;
          }

          // Open the resolved file — if presenting, load into presenting tab (not new tab/VSCode)
          console.log(`[open_file] Opening: ${resolvedPath}`);

          if (deps.chromeLauncher?.presentingPage) {
            // Currently presenting → load file into presenting tab (visible in Meet)
            let presentUrl: string;
            if (/\.md$/i.test(resolvedPath)) {
              // Markdown → use renderer for styled display
              presentUrl = `http://localhost:${CONFIG.port}/render.html?file=${encodeURIComponent(resolvedPath)}`;
            } else if (/\.html?$/i.test(resolvedPath)) {
              // HTML → serve directly if in public/, otherwise render
              const fileName = resolvedPath.split("/").pop() || "";
              const publicPath = require("path").resolve(import.meta.dir, "../../public", fileName);
              presentUrl = require("fs").existsSync(publicPath)
                ? `http://localhost:${CONFIG.port}/${fileName}`
                : `file://${resolvedPath}`;
            } else {
              // Other files → use renderer with raw content
              presentUrl = `http://localhost:${CONFIG.port}/render.html?file=${encodeURIComponent(resolvedPath)}`;
            }

            // Navigate presenting tab (stays in Meet share)
            try {
              await deps.chromeLauncher.navigatePresentingPage(presentUrl);
              console.log(`[open_file] Loaded into presenting tab: ${presentUrl}`);
            } catch {
              // Fallback: open in new tab via shareScreen
              await deps.chromeLauncher.shareScreen(presentUrl);
            }
          } else if (deps.chromeLauncher?.context) {
            // Not presenting but Playwright Chrome is running → open in Playwright Chrome
            // (so it's in the same Chrome instance as Meet, visible when screen share starts)
            let presentUrl: string;
            if (/\.md$/i.test(resolvedPath)) {
              presentUrl = `http://localhost:${CONFIG.port}/render.html?file=${encodeURIComponent(resolvedPath)}`;
            } else if (/\.html?$/i.test(resolvedPath)) {
              const fileName = resolvedPath.split("/").pop() || "";
              const publicPath = require("path").resolve(import.meta.dir, "../../public", fileName);
              presentUrl = require("fs").existsSync(publicPath)
                ? `http://localhost:${CONFIG.port}/${fileName}`
                : `file://${resolvedPath}`;
            } else {
              presentUrl = `http://localhost:${CONFIG.port}/render.html?file=${encodeURIComponent(resolvedPath)}`;
            }
            // Open as new page in Playwright context (same Chrome window as Meet)
            const newPage = await deps.chromeLauncher.context.newPage();
            await newPage.goto(presentUrl, { waitUntil: "domcontentloaded", timeout: 10000 });
            console.log(`[open_file] Opened in Playwright Chrome: ${presentUrl}`);
          } else {
            // No Playwright Chrome → open in system default app
            const app = args.app || (resolvedPath.endsWith(".html") ? "browser" : "vscode");
            await meetJoiner.openFile(resolvedPath, app);
          }

          // Read file content and inject into voice context (meeting memory)
          const textExts = /\.(txt|md|html|json|csv|ts|tsx|js|jsx|py|yaml|yml|toml|xml|sql|sh|env|log|conf|cfg)$/i;
          if (textExts.test(resolvedPath)) {
            try {
              const fileContent = await Bun.file(resolvedPath).text();
              const maxChars = 4000;
              const truncated = fileContent.length > maxChars
                ? fileContent.slice(0, maxChars) + `\n... (truncated, ${fileContent.length} chars total)`
                : fileContent;
              const fileName = resolvedPath.split("/").pop() || resolvedPath;

              // Inject into real-time voice context
              if (deps.voice) {
                deps.voice.injectContext(`[FILE_CONTENT] ${fileName}:\n${truncated}`);
              }
              // Persist in meeting prep liveNotes
              if (deps.meetingPrepSkill) {
                deps.meetingPrepSkill.addLiveNote(`[CONTEXT] Opened ${fileName} — ${fileContent.length} chars, content injected to voice context`);
              }
              console.log(`[open_file] Injected ${Math.min(fileContent.length, maxChars)} chars from ${fileName} into voice context`);
            } catch (e: any) {
              console.warn(`[open_file] Could not read file content: ${e.message}`);
            }
          }

          return app === "browser"
            ? `Opened and presenting: ${resolvedPath}`
            : `Opened ${resolvedPath} in ${app}.`;
        }
        default:
          return `Unknown meeting tool: ${name}`;
      }
    },
  };
}
