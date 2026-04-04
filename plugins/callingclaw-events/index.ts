#!/usr/bin/env bun
// CallingClaw Events Channel — MCP server that bridges CallingClaw's EventBus
// into Claude Code sessions via the Channel protocol (stdio transport).
//
// Architecture:
//   CallingClaw EventBus (/ws/events) → this MCP server → Claude Code session
//   Claude sees events as <channel source="callingclaw-events" type="..." ...>
//
// This is a one-way channel: CallingClaw pushes events, Claude acts on them.
// Claude uses the Telegram channel (separate plugin) to reply to the user.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

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

// ── MCP Server ──

const mcp = new Server(
  { name: "callingclaw-events", version: "0.0.1" },
  {
    capabilities: { experimental: { "claude/channel": {} } },
    instructions: [
      "Events from CallingClaw meeting AI arrive as <channel source=\"callingclaw-events\" type=\"...\" ...>.",
      "",
      "When you see type=\"meeting.summary_ready\":",
      "  1. Call /callingclaw status to get meeting details",
      "  2. Call /callingclaw transcript to get the transcript",
      "  3. Format a clear summary with key points and action items",
      "  4. Send it to the user via the Telegram reply tool",
      "",
      "When you see type=\"meeting.prep_ready\":",
      "  1. Read the prep brief from the filepath in the event data",
      "  2. Send a concise notification to the user via Telegram",
      "",
      "When you see type=\"meeting.started\":",
      "  1. Notify the user that CallingClaw joined the meeting",
      "",
      "When you see type=\"meeting.ended\":",
      "  1. Wait for meeting.summary_ready before sending the full summary",
      "  2. Optionally send a quick 'meeting ended' confirmation immediately",
      "",
      "When you see type=\"voice.started\" or type=\"voice.stopped\":",
      "  1. Only notify if it seems relevant (e.g., unexpected stop)",
      "",
      "When you see type=\"calendar.updated\":",
      "  1. Notify the user about new/deleted calendar events",
    ].join("\n"),
  },
);

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
