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
import { extractMatchTokens, countTokenHits, keywordOverlapScore } from "../utils/text-match";

export interface AIToolDeps {
  contextSync: ContextSync;
  contextRetriever?: ContextRetriever;
  openclawBridge: OpenClawBridge;
  dispatcher?: OpenClawDispatcher;
  eventBus: EventBus;
  meetingPrepSkill?: MeetingPrepSkill;
}

// ── Recall failure sentinels (P1 STEP 3, §4.4/§6) ─────────────────────────
//
// A recall RESULT string that must NEVER be spoken as a fact: an internal
// dispatcher/gateway failure that leaked as if it were an answer ("All channels
// failed", "Gateway not available", "Dispatch failed: …"), an OpenClaw error
// sentinel, or the recall handler's own "couldn't find / retrieve" non-answer
// apology. The voice recall producer reads this to set `DeliberateResult.error`
// so the unified sink error-suppresses it (neutral internal note, never spoken).
//
// Deliberately PRECISE phrase matching (not a bare /failed/) so a genuine
// recalled fact that merely CONTAINS a word like "failed" ("the deploy failed
// last Tuesday") is not misclassified as a sentinel — the audited over-broad
// backstop risk.
export const RECALL_FAILURE_SENTINELS: readonly string[] = [
  "all channels failed",
  "dispatch failed:",
  "gateway not available",
  "openclaw error:",
  "openclaw disconnected:",
  "openclaw task timed out",
  "openclaw is not running",
  "(no response)",
  "couldn't find specific information",
  "couldn't retrieve reliable context",
];

/** True if a recall result is an unusable failure/non-answer that must not be
 *  spoken as fact. Empty/whitespace-only counts as unusable. */
export function isUnusableRecallResult(result: string | null | undefined): boolean {
  const s = (result || "").trim().toLowerCase();
  if (!s) return true;
  return RECALL_FAILURE_SENTINELS.some((sen) => s.includes(sen));
}

export function aiTools(deps: AIToolDeps): ToolModule {
  const { contextSync, contextRetriever, openclawBridge, dispatcher, eventBus, meetingPrepSkill } = deps;

  // Usable ⇔ NOT a recall failure sentinel. Broadened (P1 STEP 3) so a leaked
  // dispatcher/gateway sentinel ("All channels failed" / "Gateway not available")
  // is no longer wrapped and returned as a `[Recall via …]` answer — the leak is
  // stopped at the source, and the voice sink error-suppresses any that slip past.
  const isUsableOpenClawAnswer = (answer: string) => !isUnusableRecallResult(answer);

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
              description: "quick = local memory + cached context lookup (<100ms). thorough = agent search with file access, typically 5-30s; may fall back to a slower deep-research pass taking several minutes if the fast path fails.",
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
          // If the query matches prep content, return immediately without any API call.
          // Zero-token queries (pure interrogatives like "是什么") skip this path
          // entirely — `hits >= min(2, 0)` is trivially true and would return
          // the first section for ANY query.
          if (meetingPrepSkill?.currentBrief) {
            const brief = meetingPrepSkill.currentBrief;
            const queryTokens = extractMatchTokens(query);
            if (queryTokens.length > 0) {
              const sections = [
                { name: "decisions", text: brief.architectureDecisions?.map((d) => `${d.decision}: ${d.rationale}`).join("\n") || "" },
                { name: "questions", text: brief.expectedQuestions?.map((q) => `Q: ${q.question} A: ${q.suggestedAnswer}`).join("\n") || "" },
                { name: "history", text: brief.previousContext || "" },
                { name: "key_points", text: brief.keyPoints?.join("\n") || "" },
                { name: "resources", text: [...(brief.filePaths?.map((f) => `${f.description} ${f.path}`) || []), ...(brief.browserUrls?.map((u) => `${u.description} ${u.url}`) || [])].join("\n") },
              ];
              for (const s of sections) {
                if (!s.text) continue;
                const hits = countTokenHits(queryTokens, s.text);
                if (hits >= Math.min(2, queryTokens.length)) {
                  console.log(`[RecallContext] Hit from prep brief (${s.name}): "${query.slice(0, 60)}"`);
                  return `[Prep brief — ${s.name}]\n${s.text}`;
                }
              }
            }
          }

          // Path 0: Check ContextRetriever's already-retrieved contexts (instant, <1ms)
          // These are contexts proactively fetched by Haiku gap analysis during the meeting.
          // Require >=2 token hits OR >=30% overlap (a single coincidental token is a
          // false-positive risk — it would confidently return the wrong cached context).
          // The score branch needs >=3 query tokens: a 1-2 token query hits score
          // 0.5-1.0 off a single coincidental token, matching anything containing it.
          // Pick the best-scoring context, not just the first one that clears the bar.
          if (contextRetriever?.active) {
            const queryTokens = extractMatchTokens(query);
            let best: { query: string; content: string; score: number } | null = null;
            for (const r of contextRetriever.retrievedContexts) {
              const text = `${r.query} ${r.content}`;
              const hits = countTokenHits(queryTokens, text);
              const score = keywordOverlapScore(queryTokens, text);
              if (hits >= 2 || (queryTokens.length >= 3 && score >= 0.3)) {
                if (!best || score > best.score) {
                  best = { query: r.query, content: r.content, score };
                }
              }
            }
            if (best) {
              console.log(`[RecallContext] Hit from ContextRetriever cache: "${best.query.slice(0, 60)}"`);
              return `[Retrieved context]\n${best.content}`;
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
