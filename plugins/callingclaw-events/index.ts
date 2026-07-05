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
//
// CALLINGCLAW_EVENTS_LEVEL controls how much of CallingClaw's live activity
// is surfaced to the connected agent (env read once at startup):
//   "lifecycle" — quiet: only meeting/voice/calendar milestones (old default).
//   "live"      — (default) lifecycle + research/auditor/computer-use/stage
//                 activity, so an agent can narrate what CallingClaw is doing
//                 mid-meeting instead of only polling before/after.
// Deliberately excluded even at "live": transcript-level events and
// voice.tool_call — too high-volume/noisy to push per-event.

const LIFECYCLE_EVENTS = [
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
];

const LIVE_ONLY_EVENTS = [
  // Deep research (OpenClaw/agent delegated web search during a meeting)
  "research.started",
  "research.completed",
  // TranscriptAuditor intent classification (System 2)
  "auditor.intent",
  "auditor.suggest",
  "auditor.fast_lane",
  // ComputerUseModule screen-control actions
  "computer.task_started",
  "computer.task_done",
  // Meeting Stage working documents
  "stage.documents_updated",
  // No-show detection
  "meeting.no_show",
];

const EVENTS_LEVEL = process.env.CALLINGCLAW_EVENTS_LEVEL === "lifecycle" ? "lifecycle" : "live";

const IMPORTANT_EVENTS = new Set(
  EVENTS_LEVEL === "lifecycle" ? LIFECYCLE_EVENTS : [...LIFECYCLE_EVENTS, ...LIVE_ONLY_EVENTS],
);

const buffer = new EventBuffer(300);

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
      "  meeting.summary_ready   → call callingclaw_status + callingclaw_transcript, format a summary, reply to the user",
      "  meeting.prep_ready      → read the prep brief at `filepath`, send a concise notification",
      "  meeting.started         → notify that CallingClaw joined",
      "  meeting.ended           → wait for meeting.summary_ready before the full summary",
      "  meeting.no_show         → the user hasn't joined 5min in; offer to leave/rejoin",
      "  research.started        → CallingClaw is running a background web search mid-meeting (fyi only, no action needed)",
      "  research.completed      → search finished; the findings markdown path is `meta.filepath` (may be absent on error)",
      "  auditor.intent          → CallingClaw detected a voice command and is about to act on it (fyi only)",
      "  auditor.suggest         → CallingClaw noticed a possible intent but wants user confirmation first",
      "  auditor.fast_lane       → a low-latency action (click/scroll) just fired (fyi only)",
      "  computer.task_started   → screen-control action started",
      "  computer.task_done      → screen-control action finished; summary is in the event payload",
      "  stage.documents_updated → the Meeting Stage's Working Documents changed; call callingclaw_status if curious",
      "",
      "By default (CALLINGCLAW_EVENTS_LEVEL=live) all of the above are pushed live.",
      "Set CALLINGCLAW_EVENTS_LEVEL=lifecycle for only the meeting/voice/calendar milestones.",
      "Transcript text and voice.tool_call are never pushed (too high-volume) — use callingclaw_transcript instead.",
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
            // research.completed / stage.documents_updated use `filePath` (capital P);
            // meeting.prep_ready uses `filepath`. Normalize both onto `meta.filepath`.
            ...((event.data?.filepath || event.data?.filePath) && {
              filepath: event.data.filepath || event.data.filePath,
            }),
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
