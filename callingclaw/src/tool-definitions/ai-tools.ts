// CallingClaw 2.0 — AI Tool Definitions & Handlers
// Tools: recall_context

import type { ToolModule } from "./types";
import type { ContextSync } from "../modules/context-sync";
import type { OpenClawBridge } from "../openclaw_bridge";
import type { EventBus } from "../modules/event-bus";

export interface AIToolDeps {
  contextSync: ContextSync;
  openclawBridge: OpenClawBridge;
  eventBus: EventBus;
}

export function aiTools(deps: AIToolDeps): ToolModule {
  const { contextSync, openclawBridge, eventBus } = deps;

  return {
    definitions: [
      // ── Context Recall (System 2 Memory Access) ──
      {
        name: "recall_context",
        description:
          "Recall specific context about the user's work, projects, plans, or past discussions from OpenClaw's memory and files. " +
          "Call this when the user asks about something specific that your background context doesn't cover — " +
          "like project status, blog performance metrics, past decisions, launch plans, file contents, or any domain-specific question. " +
          "Do NOT call this for general questions you can answer from your background context.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "What context you need. Be specific. Example: 'memdex blog posts published recently and their performance' or 'launch plans for Tanka Link 2.0 and what can be reused'",
            },
            urgency: {
              type: "string",
              enum: ["quick", "thorough"],
              description: "quick = search local memory only (<1s). thorough = delegate to OpenClaw agent for deep search with file access (5-15s).",
            },
          },
          required: ["query"],
        },
      },
    ],

    handler: async (name, args) => {
      switch (name) {
        case "recall_context": {
          const query = args.query as string;
          const urgency = (args.urgency as string) || "quick";
          eventBus.emit("voice.tool_call", { tool: "recall_context", query: query.slice(0, 80), urgency });

          // Path A: Quick — local MEMORY.md keyword search (<100ms)
          const localResult = contextSync.searchMemory(query);

          if (urgency === "quick" || !openclawBridge.connected) {
            if (localResult) {
              return `[Memory recall]\n${localResult}`;
            }
            if (!openclawBridge.connected) {
              return "I couldn't find specific information about that in my local memory, and OpenClaw is not currently available for a deeper search. Could you give me more context about what you're referring to?";
            }
            // Quick search found nothing — auto-escalate to thorough
          }

          // Path B: Thorough — delegate to OpenClaw (2-15s)
          console.log(`[RecallContext] Delegating to OpenClaw: "${query.slice(0, 80)}"`);
          const openclawResult = await openclawBridge.sendTask(
            `The user asked a question that requires context recall. Search your memory (MEMORY.md), recent files, and conversation history to find relevant information.\n\n` +
            `User's question context: "${query}"\n\n` +
            `${localResult ? `I found some potentially relevant local context:\n${localResult}\n\nPlease expand on this with more details.` : "No local context found. Please search broadly."}\n\n` +
            `Return a concise factual answer (under 500 words) that the voice assistant can relay to the user. Focus on concrete facts, dates, metrics, and actionable information. Answer in the user's language (likely Chinese).`
          );

          return `[OpenClaw recall]\n${openclawResult}`;
        }
        default:
          return `Unknown AI tool: ${name}`;
      }
    },
  };
}
