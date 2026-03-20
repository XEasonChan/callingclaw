// CallingClaw 2.0 — Meeting API Routes
// /api/meeting/join, /api/meeting/leave, /api/meeting/transcript, /api/meeting/prepare,
// /api/meeting/prep-brief, /api/meeting/summary, /api/meeting/export, /api/meeting/notes,
// /api/meeting/notes/:file, /api/meeting/status, /api/meeting/start, /api/meeting/stop,
// /api/meeting/join-browser, /api/meeting/join-browser/abort, /api/meeting/validate

import { CONFIG } from "../config";
import { validateMeetingUrl } from "../meet_joiner";
import { buildVoiceInstructions, prepareMeeting, injectMeetingBrief } from "../voice-persona";
import { generateMeetingId, upsertSession } from "../modules/shared-documents";
import type { Services, RouteHandler } from "./types";

export function meetingRoutes(services: Services): RouteHandler {
  return {
    match: (pathname, method) => pathname.startsWith("/api/meeting/"),

    handle: async (req, url, headers) => {
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

        // Generate stable meetingId for session tracking
        const meetingId = generateMeetingId();

        // Look up calendar event to get attendees
        let meetAttendees: any[] = [];
        let calEvent: any = null;
        if (services.calendar?.connected) {
          try {
            calEvent = await services.calendar.findEventByMeetUrl(validated.url);
            if (calEvent?.attendees) meetAttendees = calEvent.attendees;
          } catch {}
        }

        const meetTopic = calEvent?.summary || body.instructions?.slice(0, 200) || services.context.workspace?.topic || "Meeting";
        upsertSession({ meetingId, topic: meetTopic, meetUrl: validated.url, status: "active" });

        // Generate meeting prep brief via OpenClaw (best-effort, non-blocking join)
        let prepBrief: any = null;
        if (services.meetingPrepSkill && services.openclawBridge?.connected) {
          try {
            const prepResult = await prepareMeeting(services.meetingPrepSkill, meetTopic, undefined, meetAttendees, meetingId);
            prepBrief = prepResult.brief;
            if (services.realtime.connected) {
              // Layer 0: CORE_IDENTITY via session.update (already set at voice.start)
              // Layer 2: Meeting brief via conversation.item.create
              injectMeetingBrief(services.realtime, prepResult.brief);
              console.log("[Meeting] Layer 2 meeting brief injected");
            }
          } catch (e: any) {
            console.warn("[Meeting] Prep brief failed (continuing without):", e.message);
          }
        }

        // Step 2: Configure audio bridge mode BEFORE joining (with verification)
        const audioConfigOk = await services.bridge.sendConfigAndVerify(
          { audio_mode: "meet_bridge", capture_system_audio: true, virtual_mic_output: true },
          { timeoutMs: 3000, retries: 3 }
        );
        if (audioConfigOk) {
          console.log("[Meeting] ✅ Audio bridge confirmed: meet_bridge");
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
            muteMic: true,
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

      // POST /api/meeting/prepare — Generate pre-meeting agenda for user confirmation
      // Returns: meeting prep brief + agenda items that user can review before joining
      if (url.pathname === "/api/meeting/prepare" && req.method === "POST") {
        const body = (await req.json()) as {
          topic: string;
          url?: string;
          context?: string;
        };
        if (!body.topic) {
          return Response.json({ error: "topic is required" }, { status: 400, headers });
        }

        // Generate workspace context summary
        const workspace = services.context.workspace;
        const syncBrief = services.contextSync?.getBrief();
        const calendarEvents = await services.calendar.listUpcomingEvents(3).catch(() => []);
        const prepMeetingId = generateMeetingId();

        // Generate structured meeting prep brief via OpenClaw (if available)
        let prepBriefData: any = null;
        if (services.meetingPrepSkill && services.openclawBridge?.connected) {
          try {
            const prepResult = await prepareMeeting(services.meetingPrepSkill, body.topic, body.context, undefined, prepMeetingId);
            prepBriefData = {
              topic: prepResult.brief.topic,
              goal: prepResult.brief.goal,
              keyPoints: prepResult.brief.keyPoints,
              expectedQuestions: prepResult.brief.expectedQuestions.length,
              filePaths: prepResult.brief.filePaths.length,
            };
          } catch (e: any) {
            console.warn("[MeetingPrepare] Brief generation failed:", e.message);
          }
        }

        const agenda = {
          meetingId: prepMeetingId,
          topic: body.topic,
          meetUrl: body.url || null,
          generatedAt: Date.now(),
          workspace: workspace || null,
          contextBrief: syncBrief?.voice || null,
          prepBrief: prepBriefData,
          upcomingEvents: calendarEvents,
          pendingConfirmation: true,
          instructions: `Review this agenda. Reply with /callingclaw join <url> to start the meeting, or modify the topic/context first.`,
        };

        services.eventBus.emit("meeting.agenda", agenda);

        return Response.json(agenda, { headers });
      }

      // GET /api/meeting/prep-brief — Get current meeting prep brief (if generated)
      if (url.pathname === "/api/meeting/prep-brief" && req.method === "GET") {
        // Return the current workspace context and ContextSync brief
        const workspace = services.context.workspace;
        const syncBrief = services.contextSync?.getBrief();

        return Response.json({
          workspace: workspace || null,
          voiceBrief: syncBrief?.voice || null,
          computerBrief: syncBrief?.computer || null,
          voiceBriefChars: syncBrief?.voice?.length || 0,
          computerBriefChars: syncBrief?.computer?.length || 0,
          pinnedFiles: services.contextSync?.getPinnedFiles() || [],
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
        // Stop admission monitor + meeting-end watcher
        if (services.playwrightCli?.isAdmissionMonitoring) {
          services.playwrightCli.stopAdmissionMonitor();
        }
        services.playwrightCli?.clearMeetingEndCallback();
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

      return Response.json({ error: "Not found" }, { status: 404, headers });
    },
  };
}
