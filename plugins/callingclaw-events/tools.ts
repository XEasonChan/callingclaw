// Universal MCP tool definitions for CallingClaw.
// Callable by ANY MCP client (Hermes, Claude Code, opencode, Cursor, …).
// Transport-agnostic: index.ts wires these into the MCP Server.

import { callingclaw } from "./callingclaw-client";
import type { EventBuffer } from "./event-buffer";

export const TOOL_DEFINITIONS = [
  {
    name: "callingclaw_status",
    description:
      "Get CallingClaw system + current meeting status (backend health, whether a meeting is active, platform, participants).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "callingclaw_transcript",
    description: "Get the live or most recent meeting transcript.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "callingclaw_summary",
    description: "Get the meeting summary, key points, and action items.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "callingclaw_recent_events",
    description:
      "Poll recent CallingClaw events: meeting lifecycle (started/ended/summary_ready/prep_ready/no_show), voice.*, calendar.updated, and — by default (CALLINGCLAW_EVENTS_LEVEL=live) — live in-meeting activity (research.started/completed, auditor.intent/suggest/fast_lane, computer.task_started/done, stage.documents_updated). Pass the `since` cursor from the previous call to get only new events. Use this to notify the user about meeting activity.",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "number",
          description: "Only return events with seq greater than this cursor (default 0 = all buffered).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "callingclaw_join_meeting",
    description: "拉起会议 — have CallingClaw join a Google Meet or Zoom meeting as a participant.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The Google Meet / Zoom meeting URL to join." },
        topic: { type: "string", description: "Optional meeting topic (shapes the voice persona + prep)." },
        instructions: {
          type: "string",
          description: "Optional persona instructions for this meeting (e.g. onboarding self-introduction).",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "callingclaw_create_meeting",
    description:
      "Create a Google Calendar event with a Meet link (requires calendar auth). Returns the event including the meet link — pair with callingclaw_join_meeting to start an instant meeting.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Meeting title." },
        start: { type: "string", description: "Start time, ISO 8601 with timezone (default: now)." },
        end: { type: "string", description: "End time, ISO 8601 (default: start + 30min)." },
        description: { type: "string" },
        attendees: { type: "array", items: { type: "string" }, description: "Attendee emails." },
      },
      required: ["summary"],
      additionalProperties: false,
    },
  },
  {
    name: "callingclaw_onboarding_status",
    description:
      "One-call onboarding readiness check: backend health, macOS permissions (screen recording / accessibility), and Google auth (calendar + Chrome login). Use before offering an onboarding meeting.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "callingclaw_request_auth",
    description:
      "Kick off an authorization step the user must complete: open a macOS privacy pane (`panel`: screenRecording|accessibility|microphone|camera) or open Chrome's Google sign-in (`panel`: googleLogin). Re-check with callingclaw_onboarding_status afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        panel: {
          type: "string",
          enum: ["screenRecording", "accessibility", "microphone", "camera", "googleLogin"],
        },
      },
      required: ["panel"],
      additionalProperties: false,
    },
  },
  {
    name: "callingclaw_scan_claude_projects",
    description:
      "Work-memory-lite: shallow scan of the user's local Claude Code projects (~/.claude/projects — project paths, session counts, recent session openers; NO code or file contents) and pin the result into CallingClaw's shared context so the voice AI can personalize conversations. Ask the user before running.",
    inputSchema: {
      type: "object",
      properties: {
        maxProjects: { type: "number", description: "Max projects to include (default 5)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "callingclaw_prepare_meeting",
    description:
      "会议议程 — generate a meeting prep brief. Provide either a free-text `topic` or a calendar `eventId`.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Free-text meeting topic to prepare for." },
        eventId: { type: "string", description: "Calendar event id to prepare for." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "callingclaw_list_calendar",
    description: "List upcoming calendar meetings known to CallingClaw.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;

/** Execute a tool call. Returns a plain JS value (index.ts serializes it). */
export async function handleToolCall(
  name: string,
  args: Record<string, any> | undefined,
  buffer: EventBuffer,
): Promise<unknown> {
  const a = args || {};
  switch (name) {
    case "callingclaw_status": {
      const [status, meeting] = await Promise.allSettled([
        callingclaw.status(),
        callingclaw.meetingStatus(),
      ]);
      return {
        system: status.status === "fulfilled" ? status.value : { error: String(status.reason) },
        meeting: meeting.status === "fulfilled" ? meeting.value : { error: String(meeting.reason) },
      };
    }
    case "callingclaw_transcript":
      return callingclaw.transcript();
    case "callingclaw_summary":
      return callingclaw.summary();
    case "callingclaw_recent_events": {
      const since = typeof a.since === "number" ? a.since : 0;
      const events = buffer.since(since);
      return { cursor: buffer.cursor, count: events.length, events };
    }
    case "callingclaw_join_meeting": {
      if (!a.url || typeof a.url !== "string") throw new Error("`url` is required");
      return callingclaw.joinMeeting(a.url, { topic: a.topic, instructions: a.instructions });
    }
    case "callingclaw_create_meeting": {
      if (!a.summary || typeof a.summary !== "string") throw new Error("`summary` is required");
      const start = a.start || new Date().toISOString();
      const end = a.end || new Date(new Date(start).getTime() + 30 * 60_000).toISOString();
      return callingclaw.createMeeting({
        summary: a.summary, start, end,
        ...(a.description ? { description: a.description } : {}),
        ...(a.attendees ? { attendees: a.attendees } : {}),
      });
    }
    case "callingclaw_onboarding_status": {
      const [status, permissions, google] = await Promise.allSettled([
        callingclaw.status(),
        callingclaw.permissions(),
        callingclaw.googleAuthStatus(),
      ]);
      const val = (r: PromiseSettledResult<any>) =>
        r.status === "fulfilled" ? r.value : { error: String(r.reason) };
      return { backend: val(status), permissions: val(permissions), google: val(google) };
    }
    case "callingclaw_request_auth": {
      if (!a.panel) throw new Error("`panel` is required");
      if (a.panel === "googleLogin") return callingclaw.googleChromeLogin();
      return callingclaw.openPermissionPane(a.panel);
    }
    case "callingclaw_scan_claude_projects": {
      // The MCP server runs on the same machine from <repo>/plugins/callingclaw-events,
      // so the scan script lives two levels up. Scan writes the context file,
      // then we pin it so the voice AI sees it during the onboarding meeting.
      // fileURLToPath, not .pathname — the repo lives under iCloud and the
      // URL-encoded spaces (%20) in .pathname break module resolution
      const { fileURLToPath } = await import("node:url");
      const scriptPath = fileURLToPath(new URL("../../scripts/onboarding-scan-claude-projects.ts", import.meta.url));
      const max = typeof a.maxProjects === "number" ? String(a.maxProjects) : "5";
      const proc = Bun.spawn(["bun", scriptPath, "--max-projects", max], {
        stdout: "pipe", stderr: "pipe",
      });
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      if (code !== 0) throw new Error(`scan failed (exit ${code}): ${(err || out).slice(0, 300)}`);
      const home = process.env.HOME || "";
      const contextPath = `${home}/.callingclaw/shared/onboarding-context.md`;
      let pinned = false;
      try {
        await callingclaw.pinContext(contextPath, "User recent Claude Code projects (onboarding personalization)");
        pinned = true;
      } catch {}
      return { scan: out.trim(), contextPath, pinned };
    }
    case "callingclaw_prepare_meeting": {
      if (!a.topic && !a.eventId) throw new Error("Provide `topic` or `eventId`");
      return callingclaw.prepareMeeting({ topic: a.topic, eventId: a.eventId });
    }
    case "callingclaw_list_calendar":
      return callingclaw.calendar();
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
