// CallingClaw 2.0 — Meeting API Routes
// /api/meeting/join, /api/meeting/leave, /api/meeting/transcript, /api/meeting/prepare,
// /api/meeting/prep-brief, /api/meeting/summary, /api/meeting/export, /api/meeting/notes,
// /api/meeting/notes/:file, /api/meeting/status, /api/meeting/start, /api/meeting/stop,
// /api/meeting/join-browser, /api/meeting/join-browser/abort, /api/meeting/validate

import { CONFIG } from "../config";
import { validateMeetingUrl } from "../meet_joiner";
import { buildVoiceInstructions, prepareMeeting, injectMeetingBrief, buildMeetingIntro, buildPresentationReadyContext, buildIdleNudgeContext } from "../voice-persona";
import { generateMeetingId, upsertSession } from "../modules/shared-documents";
import { PresentationEngine } from "../modules/presentation-engine";
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

        // Look up calendar event to get attendees (before voice start so calEvent is available)
        let meetAttendees: any[] = [];
        let calEvent: any = null;
        if (services.calendar?.connected) {
          try {
            calEvent = await services.calendar.findEventByMeetUrl(validated.url);
            if (calEvent?.attendees) meetAttendees = calEvent.attendees;
          } catch {}
        }

        // Step 1: Start voice session (if not already running)
        // Supports any configured provider (OpenAI, Gemini, Grok)
        let voiceStarted = false;
        const hasAnyVoiceKey = CONFIG.openai?.apiKey || CONFIG.gemini?.apiKey || CONFIG.grok?.apiKey;
        if (!services.realtime.connected && hasAnyVoiceKey) {
          try {
            const meetTopic0 = calEvent?.summary || body.instructions?.slice(0, 200) || services.context.workspace?.topic;
            const instructions = body.instructions || (meetTopic0
              ? `You are CallingClaw, an AI meeting assistant. This meeting's topic is: "${meetTopic0}". Focus your conversation on this topic. Ask clarifying questions, confirm decisions, and track action items related to it. Speak naturally and concisely.`
              : undefined);
            await services.realtime.start(instructions, body.provider as any || undefined);
            voiceStarted = true;
            console.log(`[Meeting] Voice AI started${meetTopic0 ? ` (topic: ${meetTopic0})` : ""}${body.provider ? ` [${body.provider}]` : ""}`);
          } catch (e: any) {
            console.warn("[Meeting] Voice start failed:", e.message);
          }
        } else if (services.realtime.connected) {
          voiceStarted = true;
        }

        const meetTopic = calEvent?.summary || body.instructions?.slice(0, 200) || services.context.workspace?.topic || "Meeting";
        // Use SessionManager for dedup + session creation
        const session = services.sessionManager!.findOrCreate({ topic: meetTopic, meetUrl: validated.url });
        const meetingId = session.meetingId;
        services.sessionManager!.markActive(meetingId, { meetUrl: validated.url });

        // Generate meeting prep brief via OpenClaw (best-effort, non-blocking join)
        // DEDUP: Skip if session already has a prep file (e.g., from /api/meeting/delegate)
        // or if meetingPrepSkill already has a loaded brief for this meeting.
        let prepBrief: any = null;
        const existingPrepBrief = services.meetingPrepSkill?.currentBrief;
        const sessionHasPrep = session.files?.prep;
        if (sessionHasPrep || existingPrepBrief) {
          // Prep already exists — inject into voice context
          prepBrief = existingPrepBrief;
          if (prepBrief && services.realtime.connected) {
            injectMeetingBrief(services.realtime, prepBrief);
            console.log("[Meeting] Layer 2 meeting brief injected (existing prep)");
          } else if (sessionHasPrep && services.realtime.connected) {
            // Brief not in memory but prep file exists on disk — read and inject raw markdown
            try {
              const prepPath = session.files!.prep as string;
              const raw = await Bun.file(prepPath).text();
              if (raw && raw.length > 100) {
                // Truncate to fit voice context (~4000 chars)
                // Resources are now at the top of prep markdown, simple truncation preserves them
                const content = raw.length > 4000 ? raw.slice(0, 4000) + "\n..." : raw;
                services.realtime.injectContext(`[MEETING_PREP]\n${content}\n[/MEETING_PREP]`);
                console.log(`[Meeting] Layer 2 injected from disk prep (${raw.length} chars → ${content.length} chars)`);
              }
            } catch (e: any) {
              console.warn(`[Meeting] Failed to read prep file from disk: ${e.message}`);
            }
          }
        }

        // Load presentation script if a prep JSON exists (speakingPlan + scenes)
        // This powers PRESENTER mode — voice follows the plan, shares screen, scrolls in sync
        if (!prepBrief?.speakingPlan && services.meetingPrepSkill) {
          const { homedir } = require("os");
          const { existsSync } = require("fs");
          // Look for prep JSON: cc_{meetingId}_prep.json or by topic match
          const sharedDir = `${homedir()}/.callingclaw/shared`;
          const prepJsonCandidates = [
            // Same session ID as prep markdown: cc_{id}_prep.json
            session.files?.prep?.replace(/_prep\.md$/, "_prep.json"),
            // Session-specific presentation script
            `${sharedDir}/${meetingId}_presentation.json`,
            // Topic-based fallback (for manually created prep scripts)
            ...(() => {
              try {
                const fs = require("fs");
                return fs.readdirSync(sharedDir)
                  .filter((f: string) => f.endsWith("_prep.json") || f.endsWith("_presentation.json"))
                  .map((f: string) => `${sharedDir}/${f}`);
              } catch { return []; }
            })(),
          ].filter(Boolean);
          console.log(`[Meeting] Scanning ${prepJsonCandidates.length} prep JSON candidates...`);
          for (const jsonPath of prepJsonCandidates) {
            try {
              if (jsonPath && existsSync(jsonPath)) {
                const prepData = JSON.parse(await Bun.file(jsonPath).text());
                if (prepData.speakingPlan && prepData.scenes) {
                  // Merge presentation data into the brief
                  if (!prepBrief) {
                    prepBrief = {
                      topic: prepData.topic || meetTopic,
                      goal: prepData.goal || "",
                      generatedAt: Date.now(),
                      summary: "",
                      keyPoints: [],
                      architectureDecisions: [],
                      expectedQuestions: [],
                      filePaths: prepData.filePaths || [],
                      browserUrls: prepData.browserUrls || [],
                      folderPaths: [],
                      attendees: [],
                      liveNotes: [],
                      speakingPlan: prepData.speakingPlan,
                      scenes: prepData.scenes,
                      decisionPoints: prepData.decisionPoints || [],
                    };
                    services.meetingPrepSkill.setBrief(prepBrief);
                  } else {
                    prepBrief.speakingPlan = prepData.speakingPlan;
                    prepBrief.scenes = prepData.scenes;
                    if (prepData.decisionPoints) prepBrief.decisionPoints = prepData.decisionPoints;
                    if (prepData.filePaths) prepBrief.filePaths = [...(prepBrief.filePaths || []), ...prepData.filePaths];
                  }
                  console.log(`[Meeting] Loaded presentation script: ${prepData.speakingPlan.length} phases, ${prepData.scenes.length} scenes`);
                  // Re-inject with playbook context now that speakingPlan exists
                  if (services.realtime.connected) {
                    injectMeetingBrief(services.realtime, prepBrief);
                    console.log("[Meeting] Layer 2 re-injected with presentation script");
                  }
                  break;
                }
              }
            } catch (e: any) {
              console.warn(`[Meeting] Failed to load prep JSON: ${e.message}`);
            }
          }
        }

        if (!prepBrief && services.meetingPrepSkill && services.agentAdapter?.connected) {
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

        // Step 2: Launch Chrome with audio injection (if not already running)
        // ChromeLauncher installs addInitScript for getUserMedia interception
        // before playwright-cli connects for DOM operations.
        if (services.chromeLauncher && validated.platform === "google_meet") {
          try {
            await services.chromeLauncher.launch();
            console.log("[Meeting] ✅ ChromeLauncher: audio injection init script installed");
          } catch (e: any) {
            console.warn("[Meeting] ChromeLauncher failed (continuing without audio injection):", e.message);
          }
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
          console.log("[Meeting] Using ChromeLauncher join (Playwright library, no CLI conflict)...");
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
          // Fallback: playwright-cli (legacy path, may conflict with ChromeLauncher)
          if (!services.playwrightCli.connected) {
            try { await services.playwrightCli.start(); } catch {}
          }
          console.log("[Meeting] Using playwright-cli fast-join (legacy path)...");
          joinMethod = "playwright_eval";
          const result = await services.playwrightCli.joinGoogleMeet(validated.url, {
            muteCamera: true,
            muteMic: false,
            onStep: (step) => services.eventBus.emit("meeting.join_step", { step }),
          });
          joinSuccess = result.success;
          joinState = result.state;
          joinSummary = result.summary;

          if (joinSuccess && services.chromeLauncher) {
            try {
              const pipelineResult = await services.chromeLauncher.activateAudioPipeline();
              console.log("[Meeting] ✅ Audio pipeline activated:", pipelineResult);
            } catch (e: any) {
              console.warn("[Meeting] Audio pipeline activation failed:", e.message);
            }
          }
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

          // Self-introduction + Small Talk mode
          // Don't auto-present — let user chat first, AI triggers presentation when user is ready
          if (services.realtime.connected) {
            setTimeout(() => {
              const ownerName = CONFIG.userEmail?.split("@")[0] || "";
              const topicSnippet = meetTopic && meetTopic !== "Meeting" ? meetTopic : "";
              const intro = buildMeetingIntro(ownerName, topicSnippet);
              services.realtime.sendText(intro);
              console.log("[Meeting] Self-introduction sent (Small Talk mode)");

              // Tell AI about available presentation (but don't start it — Small Talk first)
              // Uses shared prompts from voice-persona.ts so all providers get the same behavior
              const scenes = prepBrief?.scenes;
              if (scenes && scenes.length > 0) {
                services.realtime.injectContext(buildPresentationReadyContext(scenes));
                console.log(`[Meeting] Presentation ready (${scenes.length} scenes) — Small Talk mode`);

                // Idle nudge: if no real conversation after 30s, prompt AI to offer presentation
                const idleTimer = setTimeout(() => {
                  const recentEntries = services.context.getRecentTranscript(5);
                  const hasRealConversation = recentEntries.some(
                    e => e.role === "user" && e.text.length > 20 && (Date.now() - e.ts) < 25000
                  );
                  if (!hasRealConversation && services.realtime.connected) {
                    services.realtime.injectContext(buildIdleNudgeContext());
                    console.log("[Meeting] Idle nudge sent — prompting AI to offer presentation");
                  }
                }, 30000);
                services.eventBus.once("meeting.ended", () => clearTimeout(idleTimer));
              }
            }, 2000); // Wait 2s for audio bridge to fully initialize
          }
        };

        if (joinState === "in_meeting") {
          emitMeetingStarted();
        }

        // If stuck in waiting_room, keep polling in background until admitted (up to 5 min)
        // This runs AFTER the HTTP response is sent — non-blocking
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
                  // Activate audio pipeline now that we're in the meeting
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

        // Start admission monitor regardless (in_meeting or waiting_room)
        // — monitors OTHER participants asking to join
        // Prefer ChromeLauncher (Playwright library) over playwright-cli to avoid coexistence conflict
        const names = meetAttendees.filter((a: any) => !a.self).map((a: any) => a.displayName || a.email);
        if ((joinState === "in_meeting" || joinState === "waiting_room") && services.chromeLauncher?.page) {
          services.chromeLauncher.startAdmissionMonitor(
            names,
            3000,
            async (instruction: string) => {
              await services.automationRouter.execute(instruction);
            },
          );
          console.log(`[Meeting] Admission monitor started via ChromeLauncher (${names.length} attendees)`);
        } else if ((joinState === "in_meeting" || joinState === "waiting_room") && services.playwrightCli?.connected) {
          services.playwrightCli.startAdmissionMonitor(
            names,
            3000,
            async (instruction: string) => {
              await services.automationRouter.execute(instruction);
            },
          );
          console.log(`[Meeting] Admission monitor started via playwright-cli (${names.length} attendees)`);
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
            muteMic: false,      // Mic ON — for audio injection
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
        const prepMeetingId = services.sessionManager!.generateId();

        // Generate structured meeting prep brief via OpenClaw (if available)
        let prepBriefData: any = null;
        if (services.meetingPrepSkill && services.agentAdapter?.connected) {
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
        // Stop admission monitor + meeting-end watcher (ChromeLauncher or playwright-cli)
        if (services.chromeLauncher?.isAdmissionMonitoring) {
          services.chromeLauncher.stopAdmissionMonitor();
          services.chromeLauncher.clearMeetingEndCallback();
        } else if (services.playwrightCli?.isAdmissionMonitoring) {
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
          const activeSession = services.sessionManager?.list({ status: "active" })[0];
          services.postMeetingDelivery.deliver({
            summary,
            notesFilePath: filepath,
            meetingId: activeSession?.meetingId,
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
