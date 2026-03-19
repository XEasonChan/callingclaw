// CallingClaw 2.0 — AI Tool Definitions & Handlers
// Tools: recall_context

import type { ToolModule } from "./types";
import type { ContextSync } from "../modules/context-sync";
import type { ContextRetriever } from "../modules/context-retriever";
import type { OpenClawBridge } from "../openclaw_bridge";
import type { EventBus } from "../modules/event-bus";
import { OC002_PROMPT, parseOC002, type OC002_Request } from "../openclaw-protocol";

export interface AIToolDeps {
  contextSync: ContextSync;
  contextRetriever?: ContextRetriever;
  openclawBridge: OpenClawBridge;
  eventBus: EventBus;
}

export function aiTools(deps: AIToolDeps): ToolModule {
  const { contextSync, contextRetriever, openclawBridge, eventBus } = deps;

  const isUsableOpenClawAnswer = (answer: string) => {
    const normalized = answer.trim().toLowerCase();
    if (!normalized) return false;
    if (normalized === "(no response)") return false;
    if (normalized.includes("openclaw error:")) return false;
    if (normalized.includes("openclaw disconnected:")) return false;
    if (normalized.includes("openclaw task timed out")) return false;
    if (normalized.includes("openclaw is not running")) return false;
    return true;
  };

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
              description: "quick = search local memory + already-retrieved contexts (<1s). thorough = delegate to OpenClaw agent for deep search with file access (5-15s).",
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

          // Path 0: Check ContextRetriever's already-retrieved contexts (instant, <1ms)
          // These are contexts proactively fetched by Haiku gap analysis during the meeting
          if (contextRetriever?.active) {
            const keywords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
            const cached = contextRetriever.retrievedContexts.find((r) => {
              const lower = (r.query + " " + r.content).toLowerCase();
              return keywords.some((kw) => lower.includes(kw));
            });
            if (cached) {
              console.log(`[RecallContext] Hit from ContextRetriever cache: "${cached.query.slice(0, 60)}"`);
              return `[Retrieved context]\n${cached.content}`;
            }
          }

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

          // Path B: Thorough — delegate to OpenClaw via OC-002 (2-15s)
          console.log(`[RecallContext] Delegating to OpenClaw: "${query.slice(0, 80)}"`);
          const req: OC002_Request = {
            id: "OC-002",
            query,
            localContext: localResult || undefined,
            language: "zh",
          };
          const raw = await openclawBridge.sendTask(OC002_PROMPT(req));
          const { answer } = parseOC002(raw);
          if (isUsableOpenClawAnswer(answer)) {
            return `[OpenClaw recall]\n${answer}`;
          }
          if (localResult) {
            console.warn(`[RecallContext] OpenClaw returned no usable answer, falling back to local memory for "${query.slice(0, 80)}"`);
            return `[Memory recall]\n${localResult}`;
          }
          return "I couldn't retrieve reliable context for that just now. Please try rephrasing the question or give me one more keyword to search.";
        }
        default:
          return `Unknown AI tool: ${name}`;
      }
    },
  };
}
