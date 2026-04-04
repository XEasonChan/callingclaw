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
          "Share CallingClaw's screen in the current Google Meet call so meeting participants can see what's on screen.",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "stop_sharing",
        description: "Stop sharing CallingClaw's screen in Google Meet.",
        parameters: { type: "object", properties: {} },
      },
      // ── Voice-driven scene control (sideband pattern) ──
      // These tools let the voice model control presentation pacing.
      // Registered only when a presentation is active with scenes loaded.
      {
        name: "next_scene",
        description:
          "Advance to the next presentation slide/section. Call this AFTER you finish explaining the current content. Returns a screenshot of the new scene.",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "prev_scene",
        description: "Go back to the previous presentation slide/section.",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "go_to_scene",
        description: "Jump to a specific presentation scene by number (1-based).",
        parameters: {
          type: "object",
          properties: {
            scene_number: { type: "number", description: "Scene number (1-based, e.g. 1 for first scene)" },
          },
          required: ["scene_number"],
        },
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
          const shareUrl = args.url || "";
          eventBus.emit("voice.tool_call", { tool: "share_screen", summary: shareUrl });

          // Always prefer ChromeLauncher (Playwright library) — it manages the actual Meet page.
          // MeetJoiner.shareScreen() fails when join was via ChromeLauncher because
          // MeetJoiner.currentSession.status is never set to "in_meeting" in that path.
          if (deps.chromeLauncher) {
            await deps.chromeLauncher.shareScreen(shareUrl || undefined);
          } else {
            await meetJoiner.shareScreen();
          }

          // If prep has scenes, use voice-driven SceneController (when provider supports images)
          // or fall back to timer-driven PresentationEngine
          const brief = meetingPrepSkill?.currentBrief;
          const prepScenes = brief?.scenes;
          const cl = deps.chromeLauncher;
          if (prepScenes && prepScenes.length > 0 && cl) {
            const providerName = deps.voice?.provider;
            const supportsImage = providerName === "openai15" || providerName === "gemini";

            if (supportsImage) {
              // Voice-driven mode: SceneController + next_scene/prev_scene tools
              // Voice model sees screenshots, decides when to advance (sideband pattern)
              const { SceneController } = await import("../modules/presentation-engine");
              const controller = new SceneController();
              controller.load(prepScenes, cl);
              // Store controller for scene tool handlers
              (deps as any)._sceneController = controller;

              // Inject presentation plan so voice model knows the full agenda
              const planSummary = prepScenes.map((s: any, i: number) =>
                `Scene ${i + 1}: ${s.scrollTarget || s.url} — ${s.talkingPoints.slice(0, 80)}`
              ).join("\n");
              deps.voice?.injectContext(
                `[PRESENTATION] ${prepScenes.length} scenes loaded. Use next_scene to advance.\n${planSummary}`
              );

              // Trigger first scene automatically
              const first = await controller.next();
              if (first.screenshot && deps.voice) {
                deps.voice.injectScreenshot(first.screenshot,
                  `[SCENE 1/${controller.totalScenes}] ${first.scene?.talkingPoints?.slice(0, 150) || ""}`
                );
              }
              eventBus.emit("presentation.started", { scenes: prepScenes.length, mode: "voice-driven" });
              return `Presenting ${prepScenes.length} scenes (voice-driven). First scene is on screen — describe what you see and present it. Call next_scene when ready to advance.`;
            }

            // Fallback: timer-driven PresentationEngine (for providers without image support)
            const { PresentationEngine } = await import("../modules/presentation-engine");
            const { buildSceneContext } = await import("../voice-persona");
            const engine = new PresentationEngine();
            engine.runScenes({
              scenes: prepScenes,
              chromeLauncher: cl,
              voice: deps.voice,
              context,
              onSceneAdvance: (idx: number, scene: any) => {
                if (brief) {
                  const sceneCtx = buildSceneContext(brief, idx);
                  if (sceneCtx && deps.voice?.connected) deps.voice.injectContext(sceneCtx);
                }
                eventBus.emit("presentation.scene", { index: idx, total: prepScenes.length, url: scene.url });
              },
              onComplete: () => eventBus.emit("presentation.done", { scenesCount: prepScenes.length }),
            }).catch((e: any) => console.warn("[Meeting] Presentation sequence failed:", e.message));
            return `Presenting ${prepScenes.length} slides. First: ${prepScenes[0]!.url}`;
          }

          return "Screen sharing started.";
        }
        case "stop_sharing": {
          await meetJoiner.stopSharing();
          // Clean up SceneController if active
          if ((deps as any)._sceneController) {
            (deps as any)._sceneController.unload();
            (deps as any)._sceneController = null;
            eventBus.emit("presentation.done", { mode: "voice-driven" });
          }
          return "Screen sharing stopped.";
        }
        // ── Voice-driven scene tools (sideband pattern) ──
        case "next_scene":
        case "prev_scene":
        case "go_to_scene": {
          const controller = (deps as any)?._sceneController;
          if (!controller?.isLoaded) return "No presentation active. Use share_screen first.";

          let result;
          if (name === "next_scene") result = await controller.next();
          else if (name === "prev_scene") result = await controller.prev();
          else result = await controller.goTo((args.scene_number || 1) - 1); // 1-based → 0-based

          if (!result.scene) {
            if (name === "next_scene") {
              // Presentation complete
              eventBus.emit("presentation.done", { scenesPresented: controller.totalScenes, mode: "voice-driven" });
              return `Presentation complete (${controller.totalScenes} scenes). You may stop sharing.`;
            }
            return "Cannot go to that scene.";
          }

          // Inject screenshot so voice model can see the new scene
          if (result.screenshot && deps.voice) {
            deps.voice.injectScreenshot(result.screenshot,
              `[SCENE ${result.index + 1}/${result.total}] ${result.scene.talkingPoints.slice(0, 150)}`
            );
          }
          eventBus.emit("presentation.scene", { index: result.index, total: result.total, mode: "voice-driven" });

          return `Scene ${result.index + 1}/${result.total}: ${result.scene.talkingPoints.slice(0, 200)}`;
        }
        case "open_file": {
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

          // Open the resolved file
          const app = args.app || (resolvedPath.endsWith(".html") ? "browser" : "vscode");
          console.log(`[open_file] Opening: ${resolvedPath} in ${app}`);

          if (app === "browser" && deps.chromeLauncher) {
            // Open in ChromeLauncher's presenting tab for potential screen share
            const fileUrl = resolvedPath.startsWith("http") ? resolvedPath : `file://${resolvedPath}`;
            await deps.chromeLauncher.shareScreen(fileUrl);
            return `Opened and presenting: ${resolvedPath}`;
          }
          await meetJoiner.openFile(resolvedPath, app);
          return `Opened ${resolvedPath} in ${app}.`;
        }
        default:
          return `Unknown meeting tool: ${name}`;
      }
    },
  };
}
