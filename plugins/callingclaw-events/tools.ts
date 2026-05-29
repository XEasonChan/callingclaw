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
      "Poll recent CallingClaw meeting lifecycle events (meeting.started/ended/summary_ready/prep_ready, voice.*, calendar.updated). Pass the `since` cursor from the previous call to get only new events. Use this to notify the user about meeting activity.",
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
      },
      required: ["url"],
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
      return callingclaw.joinMeeting(a.url);
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
