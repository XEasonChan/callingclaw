// CallingClaw 2.0 — Module: MeetingScheduler
// Polls Google Calendar → registers OpenClaw cron jobs → auto-join at meeting time
//
// Flow:
//   1. On startup + every 5 min: fetch next 2h of calendar events
//   2. For events with meetLink that don't have a cron yet: register "at" cron in OpenClaw
//   3. Cron payload: systemEvent telling OpenClaw to call CallingClaw /api/meeting/join
//   4. When cron fires: OpenClaw reads the event text → calls CallingClaw REST API
//
// Design decisions:
//   - Uses OpenClaw's cron system (not internal setInterval) because:
//     a. Survives CallingClaw restarts
//     b. OpenClaw can add meeting prep context before joining
//     c. Centralized scheduling visible to user
//   - Registers cron jobs 2 min before meeting start (prep time)
//   - Deduplicates by calendar event ID

import type { GoogleCalendarClient, CalendarEvent } from "../mcp_client/google_cal";
import type { OpenClawBridge } from "../openclaw_bridge";
import type { EventBus } from "./event-bus";
import type { MeetingPrepSkill } from "../skills/meeting-prep";
import { OC003_PROMPT, parseOC003, type OC003_Request } from "../openclaw-protocol";
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
  private openclawBridge: OpenClawBridge;
  private eventBus: EventBus;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private scheduled = new Map<string, ScheduledMeeting>(); // fingerprint → info
  private _everScheduled = new Set<string>(); // ALL fingerprints ever scheduled (persistent dedup)
  private _prepInFlight = new Set<string>(); // meetingIds currently being regenerated (dedup guard)
  private _active = false;
  private meetingPrepSkill: MeetingPrepSkill | null = null;

  constructor(opts: {
    calendar: GoogleCalendarClient;
    openclawBridge: OpenClawBridge;
    eventBus: EventBus;
    meetingPrepSkill?: MeetingPrepSkill;
  }) {
    this.calendar = opts.calendar;
    this.openclawBridge = opts.openclawBridge;
    this.eventBus = opts.eventBus;
    this.meetingPrepSkill = opts.meetingPrepSkill || null;
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
   * Poll calendar and schedule cron jobs for upcoming meetings.
   */
  async poll(): Promise<void> {
    if (!this.calendar.connected) {
      console.log("[MeetingScheduler] Calendar not connected, skipping poll");
      return;
    }
    if (!this.openclawBridge.connected) {
      console.log("[MeetingScheduler] OpenClaw not connected, skipping poll");
      return;
    }

    try {
      const events = await this.calendar.listUpcomingEvents(10);
      const now = Date.now();
      const cutoff = now + LOOKAHEAD_MS;

      let newScheduled = 0;

      for (const event of events) {
        // Skip events without Meet/Zoom links
        if (!event.meetLink) continue;

        // Parse start time
        const startMs = new Date(event.start).getTime();
        if (isNaN(startMs)) continue;

        // Skip events already past or too far in the future
        if (startMs < now - 60_000 || startMs > cutoff) continue;

        // Stable fingerprint: meetLink + date (NOT event.id — Google returns
        // different IDs across polls for the same event, causing duplicate crons)
        const normalizedDate = new Date(event.start).toISOString().split("T")[0];
        const eventId = `${event.meetLink}_${normalizedDate}`;

        // Skip if already scheduled (current session OR any past session)
        if (this.scheduled.has(eventId) || this._everScheduled.has(eventId)) continue;

        // Calculate when to join (2 min before start, but not in the past)
        const joinAt = Math.max(startMs - PREP_LEAD_MS, now + 30_000); // At least 30s from now
        const joinAtISO = new Date(joinAt).toISOString();

        // Register cron job with OpenClaw
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

          this.saveCache(); // Persist to disk so restarts don't re-register
          console.log(`[MeetingScheduler] Scheduled: "${event.summary}" → join at ${new Date(joinAt).toLocaleTimeString("zh-CN")}`);
          this.eventBus.emit("scheduler.meeting_scheduled", {
            summary: event.summary,
            meetUrl: event.meetLink,
            joinAt: joinAtISO,
          });

          // Trigger pre-meeting research (OC-001) in the background
          this.triggerMeetingPrep(event);
        }
      }

      // Clean up past meetings from map
      for (const [id, meeting] of this.scheduled) {
        if (meeting.scheduledAt < now - 60 * 60 * 1000) { // 1 hour past
          this.scheduled.delete(id);
        }
      }

      if (newScheduled > 0) {
        console.log(`[MeetingScheduler] ${newScheduled} new meeting(s) scheduled, ${this.scheduled.size} total tracked`);
      }

      // Check for stuck/missing preps and recover them
      await this.recoverStalePreps();
    } catch (e: any) {
      console.error("[MeetingScheduler] Poll error:", e.message);
    }
  }

  /**
   * Register a one-shot cron job in OpenClaw to join the meeting.
   * Returns the job ID, or null on failure.
   */
  private async registerCronJob(event: CalendarEvent, joinAtISO: string): Promise<string | null> {
    try {
      // Build the system event text that OpenClaw will receive
      // OpenClaw should: 1) prepare meeting context, 2) call CallingClaw API to join
      const attendeeList = event.attendees
        ?.filter(a => !a.self)
        .map(a => a.displayName || a.email)
        .join(", ") || "no attendee info";

      const eventText = [
        `Meeting starting soon — auto-join`,
        ``,
        `**Topic**: ${event.summary}`,
        `**Time**: ${new Date(event.start).toLocaleString("en-US")} ~ ${new Date(event.end).toLocaleString("en-US")}`,
        `**Attendees**: ${attendeeList}`,
        `**Meet link**: ${event.meetLink}`,
        ``,
        `Steps to execute:`,
        `1. Call CallingClaw API to join the meeting:`,
        `   curl -s -X POST http://localhost:4000/api/meeting/join -H "Content-Type: application/json" -d '{"url": "${event.meetLink}"}'`,
        `2. After confirming join success, notify the user the meeting has started`,
        `3. If join fails, inform the user and provide the Meet link for manual join`,
      ].join("\n");

      // Register cron via OC-003 protocol
      const req: OC003_Request = {
        id: "OC-003",
        cronName: `auto-join: ${event.summary.replace(/"/g, "'")}`,
        joinAtISO,
        eventSummary: event.summary,
        eventDescription: eventText,
      };
      const response = await this.openclawBridge.sendTask(OC003_PROMPT(req));
      const { jobId: cronJobId } = parseOC003(response);

      console.log(`[MeetingScheduler] Cron registered for "${event.summary}" at ${joinAtISO} (id: ${cronJobId})`);
      return cronJobId;
    } catch (e: any) {
      console.error(`[MeetingScheduler] Failed to register cron for "${event.summary}":`, e.message);
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

    // Check if there's already a session for this meeting (delegate flow already handles prep)
    const sessions = readSessions().sessions;
    const existing = sessions.find(s =>
      s.status !== "ended" && (
        (s.meetUrl && event.meetLink && s.meetUrl === event.meetLink) ||
        (s.calendarEventId && event.id && s.calendarEventId === event.id)
      )
    );
    if (existing) {
      console.log(`[MeetingScheduler] Skipping prep for "${event.summary}" — session ${existing.meetingId} already exists (status: ${existing.status})`);
      return;
    }

    const attendees = event.attendees || [];
    const meetingId = generateMeetingId();

    // Create session entry immediately so frontend shows "preparing" state
    upsertSession({
      meetingId,
      topic: event.summary,
      meetUrl: event.meetLink,
      startTime: event.start,
      status: "preparing",
    });

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
            upsertSession({
              meetingId: s.meetingId,
              status: "ready",
              files: { prep: s.meetingId + "_prep.md" },
            });
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

      // Stale session — regenerate if we have the tools
      if (!this.meetingPrepSkill || !this.openclawBridge.connected) continue;

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
      // Support both old format (array of entries) and new format (object with everScheduled)
      const entries: [string, ScheduledMeeting][] = Array.isArray(data) ? data : (data.scheduled || []);
      const ever: string[] = data.everScheduled || [];
      for (const [id, meeting] of entries) {
        if (meeting.scheduledAt > now - 60_000) {
          this.scheduled.set(id, meeting);
        }
        this._everScheduled.add(id);
      }
      // Restore ALL ever-scheduled IDs (even expired ones — prevents re-registration)
      for (const id of ever) this._everScheduled.add(id);
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
      scheduled: this.scheduled.size,
      meetings: [...this.scheduled.values()].map(m => ({
        summary: m.summary,
        meetUrl: m.meetUrl,
        joinAt: new Date(m.scheduledAt).toISOString(),
        cronJobId: m.cronJobId,
      })),
    };
  }
}
