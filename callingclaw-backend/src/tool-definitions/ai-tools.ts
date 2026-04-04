// CallingClaw 2.0 — AI Tool Definitions & Handlers
// Tools: recall_context

import type { ToolModule } from "./types";
import type { ContextSync } from "../modules/context-sync";
import type { ContextRetriever } from "../modules/context-retriever";
import type { OpenClawBridge } from "../openclaw_bridge";
import type { OpenClawDispatcher } from "../openclaw-dispatcher";
import type { EventBus } from "../modules/event-bus";
import type { MeetingPrepSkill } from "../skills/meeting-prep";
import { OC002_PROMPT, parseOC002, type OC002_Request } from "../openclaw-protocol";
import { detectLanguage } from "../prompt-constants";

export interface AIToolDeps {
  contextSync: ContextSync;
  contextRetriever?: ContextRetriever;
  openclawBridge: OpenClawBridge;
  dispatcher?: OpenClawDispatcher;
  eventBus: EventBus;
  meetingPrepSkill?: MeetingPrepSkill;
}

export function aiTools(deps: AIToolDeps): ToolModule {
  const { contextSync, contextRetriever, openclawBridge, dispatcher, eventBus, meetingPrepSkill } = deps;

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
          "Silently fetch specific facts from memory (dates, metrics, file paths, past decisions). " +
          "IMPORTANT: Never announce you are searching. Never say '让我查一下' or 'let me look that up'. " +
          "If the result arrives, weave it naturally into your response as if you always knew it. " +
          "If you can answer from your existing background context, do NOT call this tool. " +
          "If you genuinely don't know something and can't find it, ask the participant directly.",
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

          // Path -1: Check prep brief sections (instant, <0.1ms)
          // If the query matches prep content, return immediately without any API call
          if (meetingPrepSkill?.currentBrief) {
            const brief = meetingPrepSkill.currentBrief;
            const kws = query.toLowerCase().split(/\s+/).filter((w: string) => w.length > 2);
            const sections = [
              { name: "decisions", text: brief.architectureDecisions?.map((d) => `${d.decision}: ${d.rationale}`).join("\n") || "" },
              { name: "questions", text: brief.expectedQuestions?.map((q) => `Q: ${q.question} A: ${q.suggestedAnswer}`).join("\n") || "" },
              { name: "history", text: brief.previousContext || "" },
              { name: "key_points", text: brief.keyPoints?.join("\n") || "" },
              { name: "resources", text: [...(brief.filePaths?.map((f) => `${f.description} ${f.path}`) || []), ...(brief.browserUrls?.map((u) => `${u.description} ${u.url}`) || [])].join("\n") },
            ];
            for (const s of sections) {
              if (!s.text) continue;
              const lower = s.text.toLowerCase();
              const hits = kws.filter((kw) => lower.includes(kw));
              if (hits.length >= Math.min(2, kws.length)) {
                console.log(`[RecallContext] Hit from prep brief (${s.name}): "${query.slice(0, 60)}"`);
                return `[Prep brief — ${s.name}]\n${s.text}`;
              }
            }
          }

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

          // Path B: Thorough — three-channel dispatch (subprocess first, gateway fallback)
          console.log(`[RecallContext] Dispatching thorough recall: "${query.slice(0, 80)}"`);

          if (dispatcher) {
            // Use dispatcher: subprocess (3-5s) with haiku, falls back to gateway
            const dispatchResult = await dispatcher.recallThorough(query);
            console.log(`[RecallContext] Dispatch: channel=${dispatchResult.channel}, ${dispatchResult.durationMs}ms, fallback=${dispatchResult.fallback}`);
            if (isUsableOpenClawAnswer(dispatchResult.result)) {
              return `[Recall via ${dispatchResult.channel}]\n${dispatchResult.result}`;
            }
          } else {
            // Legacy path: direct Gateway call via OC-002
            const req: OC002_Request = {
              id: "OC-002",
              query,
              localContext: localResult || undefined,
              language: detectLanguage(query),
            };
            const raw = await openclawBridge.sendTask(OC002_PROMPT(req));
            const { answer } = parseOC002(raw);
            if (isUsableOpenClawAnswer(answer)) {
              return `[OpenClaw recall]\n${answer}`;
            }
          }

          if (localResult) {
            console.warn(`[RecallContext] Thorough recall returned no usable answer, falling back to local memory for "${query.slice(0, 80)}"`);
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
