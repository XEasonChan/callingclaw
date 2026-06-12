#!/usr/bin/env node
/**
 * CallingClaw MCP Server
 *
 * Bridges MCP-compatible AI agents to CallingClaw Desktop
 * for real-time voice meetings with AI assistance.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { toolDefinitions, handleToolCall } from "./tools.js";
import { callingClaw } from "./callingclaw.js";

const SERVER_NAME = "callingclaw-mcp";
const SERVER_VERSION = "1.0.0";

/**
 * Create and configure the MCP server
 */
function createServer(): Server {
  const server = new Server(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  );

  // Handle list tools request
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: toolDefinitions,
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleToolCall(name, (args as Record<string, unknown>) || {});
  });

  // Handle list resources request
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const isAvailable = await callingClaw.isAvailable();

    if (!isAvailable) {
      return {
        resources: [
          {
            uri: "callingclaw://setup",
            name: "CallingClaw Setup Instructions",
            description:
              "CallingClaw Desktop is not running. Read this resource for setup instructions.",
            mimeType: "text/plain",
          },
        ],
      };
    }

    return {
      resources: [
        {
          uri: "callingclaw://status",
          name: "CallingClaw Status",
          description: "Current status of CallingClaw Desktop",
          mimeType: "application/json",
        },
        {
          uri: "callingclaw://transcript",
          name: "Meeting Transcript",
          description: "Current meeting transcript",
          mimeType: "application/json",
        },
      ],
    };
  });

  // Handle read resource request
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    if (uri === "callingclaw://setup") {
      return {
        contents: [
          {
            uri,
            mimeType: "text/plain",
            text: `CallingClaw MCP Setup Instructions
=====================================

CallingClaw Desktop is not currently running or not reachable.

To use CallingClaw MCP:

1. Download CallingClaw Desktop
   Visit: https://callingclaw.com
   Download the desktop application for your platform.

2. Install and Launch
   Install the application and launch it.
   CallingClaw runs on localhost:4000.

3. Verify Connection
   Once CallingClaw is running, use the 'get_status' tool
   to verify the connection.

4. Join Meetings
   Use the 'join_meeting' tool with a Google Meet or Zoom URL
   to have the AI assistant join your meeting.

Features:
- Real-time voice AI (sub-second response via OpenAI Realtime API)
- Interactive screen sharing (Playwright-powered)
- Meeting transcription
- Action item extraction
- Context injection for smarter responses

Need help? Visit https://callingclaw.com/docs`,
          },
        ],
      };
    }

    if (uri === "callingclaw://status") {
      try {
        const status = await callingClaw.getStatus();
        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(status, null, 2),
            },
          ],
        };
      } catch {
        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(
                { error: "CallingClaw not available" },
                null,
                2
              ),
            },
          ],
        };
      }
    }

    if (uri === "callingclaw://transcript") {
      try {
        const transcript = await callingClaw.getTranscript();
        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(transcript, null, 2),
            },
          ],
        };
      } catch {
        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify({ error: "Could not fetch transcript" }, null, 2),
            },
          ],
        };
      }
    }

    throw new Error(`Unknown resource: ${uri}`);
  });

  return server;
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  // Handle errors
  server.onerror = (error) => {
    console.error("[CallingClaw MCP Error]", error);
  };

  // Handle close
  process.on("SIGINT", async () => {
    await server.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await server.close();
    process.exit(0);
  });

  // Connect and run
  await server.connect(transport);
  console.error(`[CallingClaw MCP] Server running (${SERVER_VERSION})`);
}

// Run the server
main().catch((error) => {
  console.error("[CallingClaw MCP] Fatal error:", error);
  process.exit(1);
});
