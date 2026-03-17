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
import { OC003_PROMPT, parseOC003, type OC003_Request } from "../openclaw-protocol";

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const LOOKAHEAD_MS = 2 * 60 * 60 * 1000; // 2 hours ahead
const PREP_LEAD_MS = 2 * 60 * 1000; // Join 2 min before meeting start
const CALLINGCLAW_API = "http://localhost:4000";

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
  private scheduled = new Map<string, ScheduledMeeting>(); // calendarEventId → info
  private _active = false;

  constructor(opts: {
    calendar: GoogleCalendarClient;
    openclawBridge: OpenClawBridge;
    eventBus: EventBus;
  }) {
    this.calendar = opts.calendar;
    this.openclawBridge = opts.openclawBridge;
    this.eventBus = opts.eventBus;
  }

  get active() { return this._active; }
  get scheduledMeetings() { return [...this.scheduled.values()]; }

  /**
   * Start the scheduler. Polls calendar immediately, then every 5 min.
   */
  start() {
    if (this._active) return;
    this._active = true;
    console.log("[MeetingScheduler] Started — polling every 5 min");

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

        // Generate a stable event ID from meetLink + start time
        const eventId = `${event.meetLink}_${event.start}`;

        // Skip if already scheduled
        if (this.scheduled.has(eventId)) continue;

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
          newScheduled++;

          console.log(`[MeetingScheduler] Scheduled: "${event.summary}" → join at ${new Date(joinAt).toLocaleTimeString("zh-CN")}`);
          this.eventBus.emit("scheduler.meeting_scheduled", {
            summary: event.summary,
            meetUrl: event.meetLink,
            joinAt: joinAtISO,
          });
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
