// CallingClaw 2.0 — Calendar Tool Definitions & Handlers
// Tools: schedule_meeting, check_calendar

import type { ToolModule } from "./types";
import type { GoogleCalendarClient } from "../mcp_client/google_cal";
import type { EventBus } from "../modules/event-bus";

export interface CalendarToolDeps {
  calendar: GoogleCalendarClient;
  eventBus: EventBus;
}

export function calendarTools(deps: CalendarToolDeps): ToolModule {
  const { calendar, eventBus } = deps;

  return {
    definitions: [
      {
        name: "schedule_meeting",
        description:
          "Schedule a NEW meeting on Google Calendar. ONLY call when user EXPLICITLY asks to schedule/book/预约/安排 a future meeting with a specific time. NEVER use this for joining existing meetings. If the time slot overlaps with an existing event, it is likely wrong intent — the user probably wants to join that meeting, not create a conflicting one.",
        parameters: {
          type: "object",
          properties: {
            summary: { type: "string", description: "Meeting title" },
            start: { type: "string", description: "Start time as ISO 8601 string with timezone (e.g. '2026-03-31T17:00:00+08:00'). MUST use current date from system context for '今天/today'." },
            end: { type: "string", description: "End time as ISO 8601 string with timezone (e.g. '2026-03-31T18:00:00+08:00')." },
            attendees: {
              type: "array",
              items: { type: "string" },
              description: "Email addresses of attendees",
            },
          },
          required: ["summary", "start", "end"],
        },
      },
      {
        name: "check_calendar",
        description:
          "Check upcoming calendar events. Call when user asks about their schedule.",
        parameters: {
          type: "object",
          properties: {
            max_results: { type: "number", description: "Number of events to fetch" },
          },
        },
      },
      {
        name: "delete_event",
        description:
          "Delete/cancel a calendar event. First call check_calendar to find the event ID, then delete it. Use when user asks to delete, cancel, or remove a meeting from their calendar.",
        parameters: {
          type: "object",
          properties: {
            event_id: { type: "string", description: "The Google Calendar event ID to delete" },
            summary: { type: "string", description: "Event title (for confirmation logging)" },
          },
          required: ["event_id"],
        },
      },
    ],

    handler: async (name, args) => {
      switch (name) {
        case "schedule_meeting": {
          // args.attendees is string[] from OpenAI tool call — map to CalendarAttendee[]
          const attendees = (args.attendees as string[] | undefined)?.map(
            (email: string) => ({ email })
          );
          const result = await calendar.createEvent({
            summary: args.summary,
            start: args.start,
            end: args.end,
            attendees,
          });
          eventBus.emit("calendar.updated", { action: "created", summary: args.summary });
          return result;
        }
        case "check_calendar": {
          eventBus.emit("voice.tool_call", { tool: "check_calendar" });
          const events = await calendar.listUpcomingEvents(args.max_results || 5);
          return JSON.stringify(events, null, 2);
        }
        case "delete_event": {
          eventBus.emit("voice.tool_call", { tool: "delete_event", event_id: args.event_id });
          const deleted = await calendar.deleteEvent(args.event_id);
          if (deleted) {
            eventBus.emit("calendar.updated", { action: "deleted", summary: args.summary || args.event_id });
            return `Event "${args.summary || args.event_id}" has been deleted from your calendar.`;
          }
          return `Failed to delete event. The event may not exist or calendar access was denied.`;
        }
        default:
          return `Unknown calendar tool: ${name}`;
      }
    },
  };
}
