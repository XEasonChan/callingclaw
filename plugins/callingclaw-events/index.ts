#!/usr/bin/env bun
// CallingClaw MCP server — universal integration surface for any MCP client.
//
// Two capabilities, both backed by the CallingClaw REST API on localhost:4000:
//   1. TOOLS (universal)  — status / transcript / summary / recent_events /
//                           join_meeting / prepare_meeting / list_calendar.
//                           Callable by Hermes, Claude Code, opencode, Cursor, …
//   2. CHANNEL PUSH (Claude Code only) — meeting events are also pushed via
//                           Anthropic's `notifications/claude/channel` so a
//                           Claude session reacts live. Other agents poll
//                           `callingclaw_recent_events` instead.
//
// Architecture:
//   CallingClaw EventBus (/ws/events) → this server → MCP client
//   MCP client → tools → CallingClaw REST API (localhost:4000)

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { EventBuffer } from "./event-buffer";
import { TOOL_DEFINITIONS, handleToolCall } from "./tools";

// ── Events that matter to the user (filter out noisy internal events) ──

const IMPORTANT_EVENTS = new Set([
  // Meeting lifecycle
  "meeting.started",
  "meeting.ended",
  "meeting.summary_ready",
  "meeting.prep_ready",
  // Voice AI state
  "voice.started",
  "voice.stopped",
  // Calendar
  "calendar.updated",
]);

const buffer = new EventBuffer(100);

// ── MCP Server ──

const mcp = new Server(
  { name: "callingclaw-events", version: "0.1.0" },
  {
    capabilities: {
      tools: {},
      experimental: { "claude/channel": {} },
    },
    instructions: [
      "CallingClaw is a real-time voice AI that joins meetings, takes notes, and controls the computer.",
      "",
      "TOOLS — use these to converse with CallingClaw and launch meetings:",
      "  - callingclaw_status        → system + current meeting state",
      "  - callingclaw_transcript    → live/last transcript",
      "  - callingclaw_summary       → summary + action items",
      "  - callingclaw_recent_events → poll meeting events (pass `since` cursor); use to notify the user",
      "  - callingclaw_join_meeting  → 拉起会议: join a Meet/Zoom URL",
      "  - callingclaw_prepare_meeting → 会议议程: generate a prep brief (topic or eventId)",
      "  - callingclaw_list_calendar → upcoming meetings",
      "",
      "If your client supports Claude channels, events also arrive as",
      "<channel source=\"callingclaw-events\" type=\"...\" ...>:",
      "  meeting.summary_ready → call callingclaw_status + callingclaw_transcript, format a summary, reply to the user",
      "  meeting.prep_ready    → read the prep brief at `filepath`, send a concise notification",
      "  meeting.started       → notify that CallingClaw joined",
      "  meeting.ended         → wait for meeting.summary_ready before the full summary",
      "",
      "Agents WITHOUT channel support should poll callingclaw_recent_events on a schedule.",
    ].join("\n"),
  },
);

// ── Tool handlers ──

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFINITIONS as any,
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await handleToolCall(name, args as any, buffer);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err: any) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error: ${err?.message || String(err)}` }],
    };
  }
});

await mcp.connect(new StdioServerTransport());

// ── EventBus WebSocket Bridge ──

const BACKEND_URL = process.env.CALLINGCLAW_URL || "ws://localhost:4000/ws/events";
const RECONNECT_DELAY = 5000;

function connectEventBus() {
  const ws = new WebSocket(BACKEND_URL);

  ws.onopen = () => {
    // Log to stderr (stdout is reserved for MCP stdio protocol)
    console.error("[callingclaw-events] Connected to EventBus");
  };

  ws.onmessage = async (msg) => {
    try {
      const event = JSON.parse(String(msg.data));
      if (!event.type || !IMPORTANT_EVENTS.has(event.type)) return;

      // 1. Buffer for polling clients (Hermes, opencode, …)
      buffer.push(event.type, event.data || {});

      // 2. Push to channel-capable clients (Claude Code)
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: JSON.stringify(event.data || {}),
          meta: {
            type: event.type,
            ...(event.data?.meetingId && { meeting_id: event.data.meetingId }),
            ...(event.data?.filepath && { filepath: event.data.filepath }),
            ...(event.data?.meet_url && { meet_url: event.data.meet_url }),
          },
        },
      });
    } catch (err) {
      console.error("[callingclaw-events] Failed to push event:", err);
    }
  };

  ws.onclose = () => {
    console.error("[callingclaw-events] EventBus disconnected, reconnecting in 5s...");
    setTimeout(connectEventBus, RECONNECT_DELAY);
  };

  ws.onerror = (err) => {
    console.error("[callingclaw-events] WebSocket error:", err);
    // onclose will fire after onerror, triggering reconnect
  };
}

connectEventBus();
