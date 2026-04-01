// CallingClaw 2.0 — Module: MeetingScheduler
// Polls Google Calendar → schedules auto-join at meeting time
//
// Flow:
//   1. On startup + every 5 min: fetch next 2h of calendar events
//   2. For events with meetLink that don't have a join scheduled: create job via AgentAdapter
//   3. When job fires: CallingClaw REST API joins the meeting
//   4. Works with any agent backend (OpenClaw cron, Claude Code timer, standalone timer)
//
// Design decisions:
//   - Uses AgentAdapter.scheduleJob() — platform-agnostic scheduling
//   - OpenClawAdapter routes to OC-003 cron (survives restarts)
//   - ClaudeCodeAdapter / StandaloneAdapter use internal setTimeout + disk persistence
//   - Registers jobs 2 min before meeting start (prep time)
//   - Deduplicates by calendar event ID

import type { GoogleCalendarClient, CalendarEvent, CalendarAttendee } from "../mcp_client/google_cal";
import type { AgentAdapter } from "../agent-adapter";
import type { EventBus } from "./event-bus";
import type { MeetingPrepSkill } from "../skills/meeting-prep";
import { readSessions, upsertSession, getMeetingFilePath, generateMeetingId } from "./shared-documents";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { homedir } from "os";

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const LOOKAHEAD_MS = 2 * 60 * 60 * 1000; // 2 hours ahead
const PREP_LEAD_MS = 2 * 60 * 1000; // Join 2 min before meeting start
const PREP_STALE_MS = 12 * 60 * 1000; // 12 min — after OpenClaw's 10-min timeout, safe to retry
const CALLINGCLAW_API = "http://localhost:4000";
const SCHEDULED_CACHE_PATH = resolve(homedir(), ".callingclaw", "scheduled-meetings.json");

interface ScheduledMeeting {
  calendarEventId: string;
  cronJobId: string;
  meetUrl: string;
  summary: string;
  startTime: string;
  scheduledAt: number;
}

export class MeetingScheduler {
  private calendar: GoogleCalendarClient;
  private adapter: AgentAdapter;
  private eventBus: EventBus;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private scheduled = new Map<string, ScheduledMeeting>(); // fingerprint → info
  private _everScheduled = new Set<string>(); // ALL fingerprints ever scheduled (persistent dedup)
  private _prepInFlight = new Set<string>(); // meetingIds currently being regenerated (dedup guard)
  private _active = false;
  private meetingPrepSkill: MeetingPrepSkill | null = null;
  private sessionManager: import("./session-manager").SessionManager | null = null;
  /** CallingClaw's own email (resolved once from calendar API) */
  private _selfEmail: string | null = null;
  /** Events accepted but waiting for meetLink to appear */
  private _watchingForLink = new Map<string, { eventId: string; summary: string; start: string }>();
  /** Events already auto-accepted (dedup) */
  private _acceptedEvents = new Set<string>();

  constructor(opts: {
    calendar: GoogleCalendarClient;
    adapter: AgentAdapter;
    eventBus: EventBus;
    meetingPrepSkill?: MeetingPrepSkill;
    sessionManager?: import("./session-manager").SessionManager;
  }) {
    this.calendar = opts.calendar;
    this.adapter = opts.adapter;
    this.eventBus = opts.eventBus;
    this.meetingPrepSkill = opts.meetingPrepSkill || null;
    this.sessionManager = opts.sessionManager || null;
  }

  get active() { return this._active; }
  get scheduledMeetings() { return [...this.scheduled.values()]; }

  /**
   * Start the scheduler. Polls calendar immediately, then every 5 min.
   */
  start() {
    if (this._active) return;
    this._active = true;

    // Load previously scheduled meetings from disk (survives restarts)
    this.loadCache();

    console.log(`[MeetingScheduler] Started — ${this.scheduled.size} cached, polling every 5 min`);

    // Initial poll after 10s (let other services initialize)
    setTimeout(() => this.poll(), 10_000);

    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this._active = false;
    console.log("[MeetingScheduler] Stopped");
  }

  /**
   * Poll calendar and schedule auto-join for upcoming meetings.
   *
   * Calendar-native behavior:
   *   1. For each upcoming event where CallingClaw is an attendee:
   *      a. Auto-accept the invite (if not already accepted)
   *      b. If meetLink exists → schedule join + trigger prep
   *      c. If no meetLink yet → add to watch list (check next poll)
   *   2. For watched events: check if meetLink appeared → schedule join
   */
  async poll(): Promise<void> {
    if (!this.calendar.connected) {
      console.log("[MeetingScheduler] Calendar not connected, skipping poll");
      return;
    }
    if (!this.adapter.connected) {
      console.log(`[MeetingScheduler] Agent adapter (${this.adapter.name}) not connected, skipping poll`);
      return;
    }

    // Resolve CallingClaw's own email once (for attendee matching)
    if (!this._selfEmail) {
      this._selfEmail = await this.calendar.getSelfEmail();
      if (this._selfEmail) {
        console.log(`[MeetingScheduler] Calendar identity: ${this._selfEmail}`);
      }
    }

    try {
      const events = await this.calendar.listUpcomingEvents(10);
      const now = Date.now();
      const cutoff = now + LOOKAHEAD_MS;

      let newScheduled = 0;

      for (const event of events) {
        // Parse start time
        const startMs = new Date(event.start).getTime();
        if (isNaN(startMs)) continue;

        // Skip events already past or too far in the future
        if (startMs < now - 60_000 || startMs > cutoff) continue;

        // ── Auto-accept invite ──
        // If CallingClaw is in the attendees list with status != "accepted", accept it
        if (event.id && this._selfEmail && !this._acceptedEvents.has(event.id)) {
          const selfAttendee = this.findSelfAttendee(event);
          if (selfAttendee && selfAttendee.responseStatus !== "accepted") {
            this.calendar.acceptInvite(event.id, this._selfEmail).then((ok) => {
              if (ok) {
                console.log(`[MeetingScheduler] Auto-accepted invite: "${event.summary}"`);
                this.eventBus.emit("scheduler.invite_accepted", {
                  summary: event.summary,
                  start: event.start,
                  eventId: event.id,
                });
              }
            }).catch(() => {}); // Non-blocking, best-effort
            this._acceptedEvents.add(event.id);
          } else if (selfAttendee?.responseStatus === "accepted") {
            this._acceptedEvents.add(event.id); // Already accepted, don't re-check
          }
        }

        // ── Schedule join (events WITH meetLink) ──
        if (event.meetLink) {
          // Remove from watch list if it was waiting for a link
          if (event.id) this._watchingForLink.delete(event.id);

          // Stable fingerprint: meetLink + date
          const normalizedDate = new Date(event.start).toISOString().split("T")[0];
          const eventId = `${event.meetLink}_${normalizedDate}`;

          // Skip if already scheduled
          if (this.scheduled.has(eventId) || this._everScheduled.has(eventId)) continue;

          // Skip if SessionManager already has a session for this meetUrl
          if (this.sessionManager) {
            const existingSessions = this.sessionManager.list();
            const hasMeetUrlSession = existingSessions.some(s =>
              s.meetUrl === event.meetLink && (s.status === "active" || s.status === "pending")
            );
            if (hasMeetUrlSession) {
              this._everScheduled.add(eventId);
              continue;
            }
          }

          // Calculate when to join (2 min before start, but not in the past)
          const joinAt = Math.max(startMs - PREP_LEAD_MS, now + 30_000);
          const joinAtISO = new Date(joinAt).toISOString();

          const cronResult = await this.registerCronJob(event, joinAtISO);

          if (cronResult) {
            this.scheduled.set(eventId, {
              calendarEventId: eventId,
              cronJobId: cronResult,
              meetUrl: event.meetLink!,
              summary: event.summary,
              startTime: event.start,
              scheduledAt: joinAt,
            });
            this._everScheduled.add(eventId);
            newScheduled++;

            this.saveCache();
            console.log(`[MeetingScheduler] Scheduled: "${event.summary}" → join at ${new Date(joinAt).toLocaleTimeString("zh-CN")}`);
            this.eventBus.emit("scheduler.meeting_scheduled", {
              summary: event.summary,
              meetUrl: event.meetLink,
              joinAt: joinAtISO,
            });

            // Trigger pre-meeting research in the background
            this.triggerMeetingPrep(event);
          }
        } else if (event.id && !this._watchingForLink.has(event.id)) {
          // ── Watch for meetLink (events WITHOUT meetLink) ──
          // Only watch if CallingClaw is an attendee (or no attendee info = own event)
          const isSelfEvent = !event.attendees?.length || !!this.findSelfAttendee(event);
          if (isSelfEvent) {
            this._watchingForLink.set(event.id, {
              eventId: event.id,
              summary: event.summary,
              start: event.start,
            });
            console.log(`[MeetingScheduler] Watching for meetLink: "${event.summary}" (${event.id})`);
          }
        }
      }

      // Clean up past meetings from map
      for (const [id, meeting] of this.scheduled) {
        if (meeting.scheduledAt < now - 60 * 60 * 1000) {
          this.scheduled.delete(id);
        }
      }

      // Clean up past watched events
      for (const [id, watched] of this._watchingForLink) {
        const startMs = new Date(watched.start).getTime();
        if (startMs < now - 60_000) {
          this._watchingForLink.delete(id);
        }
      }

      // Trim _acceptedEvents (unbounded Set — cap at 200 entries)
      if (this._acceptedEvents.size > 200) {
        const arr = [...this._acceptedEvents];
        this._acceptedEvents = new Set(arr.slice(-100));
      }

      if (newScheduled > 0) {
        console.log(`[MeetingScheduler] ${newScheduled} new meeting(s) scheduled, ${this.scheduled.size} total tracked`);
      }
      if (this._watchingForLink.size > 0) {
        console.log(`[MeetingScheduler] Watching ${this._watchingForLink.size} event(s) for meetLink to appear`);
      }

      // Check for stuck/missing preps and recover them
      await this.recoverStalePreps();
    } catch (e: any) {
      console.error("[MeetingScheduler] Poll error:", e.message);
    }
  }

  /**
   * Find CallingClaw's own attendee entry in an event.
   * Matches by self flag or by email.
   */
  private findSelfAttendee(event: CalendarEvent): CalendarAttendee | undefined {
    if (!event.attendees?.length) return undefined;
    // First try the "self" flag (Google sets this for the authenticated user)
    const bySelf = event.attendees.find(a => a.self === true);
    if (bySelf) return bySelf;
    // Fallback: match by email
    if (this._selfEmail) {
      const lower = this._selfEmail.toLowerCase();
      return event.attendees.find(a => a.email?.toLowerCase() === lower);
    }
    return undefined;
  }

  /**
   * Schedule a job to join the meeting at the right time.
   * Uses AgentAdapter.scheduleJob() — routes to OpenClaw cron, internal timer, etc.
   * Returns the job ID, or null on failure.
   */
  private async registerCronJob(event: CalendarEvent, joinAtISO: string): Promise<string | null> {
    try {
      const jobId = await this.adapter.scheduleJob({
        name: `auto-join: ${event.summary.replace(/"/g, "'")}`,
        fireAt: new Date(joinAtISO),
        payload: {
          meetUrl: event.meetLink!,
          summary: event.summary,
        },
      });

      console.log(`[MeetingScheduler] Job scheduled for "${event.summary}" at ${joinAtISO} via ${this.adapter.name} (id: ${jobId})`);
      return jobId;
    } catch (e: any) {
      console.error(`[MeetingScheduler] Failed to schedule join for "${event.summary}":`, e.message);
      return null;
    }
  }

  /**
   * Force schedule a specific meeting URL at a given time.
   * Used for ad-hoc meeting scheduling via API.
   */
  async scheduleManual(meetUrl: string, joinAtISO: string, summary?: string): Promise<string | null> {
    const event: CalendarEvent = {
      summary: summary || "Manual Meeting",
      start: joinAtISO,
      end: new Date(new Date(joinAtISO).getTime() + 30 * 60 * 1000).toISOString(),
      meetLink: meetUrl,
    };
    return this.registerCronJob(event, joinAtISO);
  }

  /**
   * Trigger OC-001 meeting prep in the background.
   * Non-blocking — fires and logs result, does not block cron registration.
   */
  private triggerMeetingPrep(event: CalendarEvent): void {
    if (!this.meetingPrepSkill) {
      console.warn("[MeetingScheduler] No meetingPrepSkill — skipping pre-meeting research");
      return;
    }

    // Use SessionManager for dedup — finds existing session by meetUrl/calendarEventId or creates new
    if (!this.sessionManager) {
      console.warn("[MeetingScheduler] No sessionManager — skipping prep");
      return;
    }

    // If session exists AND already has a prep file, skip entirely
    const existingByUrl = event.meetLink ? this.sessionManager.findByMeetUrl(event.meetLink) : null;
    const existingByCal = event.id ? this.sessionManager.findByCalendarEventId(event.id) : null;
    const existing = existingByUrl || existingByCal;
    if (existing?.files?.prep) {
      console.log(`[MeetingScheduler] Skipping prep for "${event.summary}" — session ${existing.meetingId} already has prep`);
      return;
    }

    const attendees = event.attendees || [];
    // findOrCreate: reuses existing meetingId if delegate already created a session
    const session = this.sessionManager.findOrCreate({
      topic: event.summary,
      meetUrl: event.meetLink,
      calendarEventId: event.id,
      startTime: event.start,
    });
    const meetingId = session.meetingId;

    this.eventBus.emit("meeting.agenda", {
      meetingId,
      topic: event.summary,
      title: event.summary,
      meetUrl: event.meetLink,
      startTime: event.start,
      prepStatus: "processing",
    });

    console.log(`[MeetingScheduler] Triggering meeting prep for "${event.summary}" (${meetingId})`);

    this.meetingPrepSkill
      .generate(event.summary, undefined, attendees, meetingId)
      .then((brief) => {
        console.log(`[MeetingScheduler] Meeting prep ready: "${event.summary}" — ${brief.keyPoints.length} key points`);
        // NOTE: meeting.prep_ready is emitted by onPrepReady callback (wired in callingclaw.ts)
      })
      .catch((e: any) => {
        console.error(`[MeetingScheduler] Meeting prep failed for "${event.summary}":`, e.message);
      });
  }

  /**
   * Recover stale meeting preps — called at end of each poll().
   *
   * Handles two cases:
   *   A) File on disk but session stuck on "preparing" → index it + emit event
   *   B) No file and session stale (>12 min) → regenerate via OpenClaw
   *
   * Guards:
   *   - _prepInFlight set prevents duplicate regeneration
   *   - Only processes upcoming meetings (startTime within 2h or no startTime)
   *   - Skips if OpenClaw bridge is disconnected
   */
  async recoverStalePreps(): Promise<void> {
    const sessions = readSessions().sessions;
    const now = Date.now();

    for (const s of sessions) {
      // Only recover sessions in "preparing" state
      if (s.status !== "preparing") continue;

      // Only recover upcoming meetings (within 2h, or no startTime — could be Talk Locally)
      if (s.startTime) {
        const startMs = new Date(s.startTime).getTime();
        if (isNaN(startMs) || startMs < now - 60_000 || startMs > now + LOOKAHEAD_MS) continue;
      }

      // Already being recovered by a previous cycle
      if (this._prepInFlight.has(s.meetingId)) continue;

      const prepPath = getMeetingFilePath(s.meetingId, "prep");

      // Case A: File exists on disk but session never got updated
      // (OpenClaw wrote the file but never called /api/meeting/prep-result)
      try {
        const file = Bun.file(prepPath);
        if (await file.exists()) {
          const md = await file.text();
          if (md.length > 50) { // Non-trivial content
            if (this.sessionManager) {
              this.sessionManager.registerFile(s.meetingId, "prep", s.meetingId + "_prep.md");
              this.sessionManager.markReady(s.meetingId);
            } else {
              upsertSession({ meetingId: s.meetingId, status: "ready", files: { prep: s.meetingId + "_prep.md" } });
            }
            this.eventBus.emit("meeting.prep_ready", {
              meetingId: s.meetingId,
              topic: s.topic,
              filePath: prepPath,
              mdContent: md,
              recovered: true,
            });
            console.log(`[PrepRecovery] Indexed existing file: "${s.topic}" (${s.meetingId})`);
            continue;
          }
        }
      } catch { /* file doesn't exist or unreadable — proceed to Case B */ }

      // Case B: No file on disk — check if stale enough to regenerate
      const updatedAt = new Date(s.updatedAt).getTime();
      if (isNaN(updatedAt) || now - updatedAt < PREP_STALE_MS) {
        // Still young — OpenClaw might still be working
        continue;
      }

      // Double-check: file might have been written between Case A check and here (race)
      // Or Case A's text check rejected it (< 50 chars) but it's still valid
      try {
        const recheckFile = Bun.file(prepPath);
        if (await recheckFile.exists() && (await recheckFile.size()) > 100) {
          console.log(`[PrepRecovery] Skipping regeneration — file appeared on disk: "${s.topic}" (${s.meetingId})`);
          // Mark as ready since file exists
          if (this.sessionManager) {
            this.sessionManager.registerFile(s.meetingId, "prep", s.meetingId + "_prep.md");
            this.sessionManager.markReady(s.meetingId);
          }
          continue;
        }
      } catch { /* proceed to regenerate */ }

      // Stale session — regenerate if we have the tools
      if (!this.meetingPrepSkill || !this.adapter.connected) continue;

      console.log(`[PrepRecovery] Regenerating stale prep: "${s.topic}" (${s.meetingId}, stale ${Math.round((now - updatedAt) / 60000)}min)`);
      this._prepInFlight.add(s.meetingId);

      // Fire regeneration (non-blocking — don't block poll for other meetings)
      this.meetingPrepSkill
        .generate(s.topic, undefined, undefined, s.meetingId)
        .then((brief) => {
          console.log(`[PrepRecovery] Regenerated: "${s.topic}" — ${brief.keyPoints.length} key points`);
          // NOTE: meeting.prep_ready is emitted by onPrepReady callback (wired in callingclaw.ts)
        })
        .catch((e: any) => {
          console.error(`[PrepRecovery] Regeneration failed for "${s.topic}":`, e.message);
        })
        .finally(() => {
          this._prepInFlight.delete(s.meetingId);
        });

      // Only regenerate one at a time (OpenClawBridge is single-task)
      break;
    }
  }

  /** Load scheduled meetings cache from disk */
  private loadCache() {
    try {
      const raw = readFileSync(SCHEDULED_CACHE_PATH, "utf-8");
      const data = JSON.parse(raw);
      const now = Date.now();
      const todayStr = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

      // Support both old format (array of entries) and new format (object with everScheduled)
      const entries: [string, ScheduledMeeting][] = Array.isArray(data) ? data : (data.scheduled || []);
      const ever: string[] = data.everScheduled || [];

      for (const [id, meeting] of entries) {
        if (meeting.scheduledAt > now - 60_000) {
          this.scheduled.set(id, meeting);
        }
        this._everScheduled.add(id);
      }

      // Restore recent ever-scheduled IDs — purge entries older than 24h.
      // Fingerprint format: "{meetLink}_{YYYY-MM-DD}"
      // Only keep today's and yesterday's entries so recurring meetings
      // with the same Meet link get re-scheduled next week.
      const yesterday = new Date(now - 24 * 60 * 60 * 1000).toISOString().split("T")[0];
      let purged = 0;
      for (const id of ever) {
        // Extract date suffix from fingerprint
        const dateMatch = id.match(/_(\d{4}-\d{2}-\d{2})$/);
        if (dateMatch) {
          const entryDate = dateMatch[1];
          if (entryDate >= yesterday) {
            this._everScheduled.add(id);
          } else {
            purged++;
          }
        } else {
          // No date suffix (legacy format) — keep for backward compat
          this._everScheduled.add(id);
        }
      }
      if (purged > 0) {
        console.log(`[MeetingScheduler] Purged ${purged} stale fingerprints (>24h old)`);
      }
    } catch { /* no cache or corrupt — start fresh */ }
  }

  /** Save scheduled meetings cache to disk */
  private saveCache() {
    try {
      mkdirSync(dirname(SCHEDULED_CACHE_PATH), { recursive: true });
      writeFileSync(SCHEDULED_CACHE_PATH, JSON.stringify({
        scheduled: [...this.scheduled.entries()],
        everScheduled: [...this._everScheduled],
      }, null, 2));
    } catch (e: any) {
      console.warn("[MeetingScheduler] Cache save failed:", e.message);
    }
  }

  /**
   * Get status summary for /api/status
   */
  getStatus() {
    return {
      active: this._active,
      selfEmail: this._selfEmail,
      scheduled: this.scheduled.size,
      watchingForLink: this._watchingForLink.size,
      meetings: [...this.scheduled.values()].map(m => ({
        summary: m.summary,
        meetUrl: m.meetUrl,
        joinAt: new Date(m.scheduledAt).toISOString(),
        cronJobId: m.cronJobId,
      })),
      watching: [...this._watchingForLink.values()].map(w => ({
        summary: w.summary,
        start: w.start,
        eventId: w.eventId,
      })),
    };
  }
}
