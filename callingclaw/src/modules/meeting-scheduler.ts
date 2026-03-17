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
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { homedir } from "os";

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const LOOKAHEAD_MS = 2 * 60 * 60 * 1000; // 2 hours ahead
const PREP_LEAD_MS = 2 * 60 * 1000; // Join 2 min before meeting start
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

        // Use Google Calendar event ID (stable across polls) with fallback
        const eventId = event.id || `${event.meetLink}_${event.start}`;

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

          this.saveCache(); // Persist to disk so restarts don't re-register
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
        .join(", ") || "无参会人信息";

      const eventText = [
        `🗓️ 会议即将开始 — 自动加入`,
        ``,
        `**主题**: ${event.summary}`,
        `**时间**: ${new Date(event.start).toLocaleString("zh-CN")} ~ ${new Date(event.end).toLocaleString("zh-CN")}`,
        `**参会人**: ${attendeeList}`,
        `**Meet链接**: ${event.meetLink}`,
        ``,
        `请执行以下步骤:`,
        `1. 调用 CallingClaw API 加入会议:`,
        `   curl -s -X POST http://localhost:4000/api/meeting/join -H "Content-Type: application/json" -d '{"url": "${event.meetLink}"}'`,
        `2. 确认加入成功后，通知用户会议已开始`,
        `3. 如果加入失败，告知用户并提供 Meet 链接让他们手动加入`,
      ].join("\n");

      // Use OpenClaw's sendTask to register the cron (since we can't directly call the cron API)
      // Instead, we ask OpenClaw to create the cron job for us
      const cronRequest = [
        `请用 cron 工具创建一个一次性定时任务:`,
        `- action: "add"`,
        `- schedule: { kind: "at", at: "${joinAtISO}" }`,
        `- sessionTarget: "main"`,
        `- payload: { kind: "systemEvent", text: 以下内容 }`,
        `- name: "auto-join: ${event.summary.replace(/"/g, "'")}"`,
        ``,
        `systemEvent 内容:`,
        `---`,
        eventText,
        `---`,
        ``,
        `创建后回复 job ID。`,
      ].join("\n");

      const response = await this.openclawBridge.sendTask(cronRequest);

      // Try to extract job ID from response
      const idMatch = response.match(/job[_\s]?[Ii][Dd][\s:]*[`"']?([a-zA-Z0-9_-]+)[`"']?/);
      const cronJobId = idMatch?.[1] || `auto_${Date.now()}`;

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

  /** Load scheduled meetings cache from disk */
  private loadCache() {
    try {
      const raw = readFileSync(SCHEDULED_CACHE_PATH, "utf-8");
      const entries: [string, ScheduledMeeting][] = JSON.parse(raw);
      const now = Date.now();
      // Only restore entries that are still in the future (within lookahead)
      for (const [id, meeting] of entries) {
        if (meeting.scheduledAt > now - 60_000) {
          this.scheduled.set(id, meeting);
        }
      }
    } catch { /* no cache or corrupt — start fresh */ }
  }

  /** Save scheduled meetings cache to disk */
  private saveCache() {
    try {
      mkdirSync(dirname(SCHEDULED_CACHE_PATH), { recursive: true });
      writeFileSync(SCHEDULED_CACHE_PATH, JSON.stringify([...this.scheduled.entries()], null, 2));
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
