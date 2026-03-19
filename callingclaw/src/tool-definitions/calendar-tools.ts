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
          "Schedule a meeting on Google Calendar. Call this when the user asks to book, schedule, or set up a meeting.",
        parameters: {
          type: "object",
          properties: {
            summary: { type: "string", description: "Meeting title" },
            start: { type: "string", description: "Start time ISO string" },
            end: { type: "string", description: "End time ISO string" },
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
          return result;
        }
        case "check_calendar": {
          eventBus.emit("voice.tool_call", { tool: "check_calendar" });
          const events = await calendar.listUpcomingEvents(args.max_results || 5);
          return JSON.stringify(events, null, 2);
        }
        default:
          return `Unknown calendar tool: ${name}`;
      }
    },
  };
}
