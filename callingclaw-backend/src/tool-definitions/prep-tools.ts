// CallingClaw 2.0 — Prep Tool Definitions & Handlers
// Tools: read_prep (local, zero-cost, sub-millisecond)

import type { ToolModule } from "./types";
import type { MeetingPrepSkill } from "../skills/meeting-prep";

export interface PrepToolDeps {
  meetingPrepSkill: MeetingPrepSkill;
}

export function prepTools(deps: PrepToolDeps): ToolModule {
  const { meetingPrepSkill } = deps;

  return {
    definitions: [
      {
        name: "read_prep",
        description:
          "Instantly read a section of your meeting prep brief. Zero latency — reads from local memory. " +
          "Use this INSTEAD of recall_context for meeting prep content. " +
          "Available sections: resources, decisions, questions, history, all_points, scene, summary.",
        parameters: {
          type: "object",
          properties: {
            section: {
              type: "string",
              enum: ["resources", "decisions", "questions", "history", "all_points", "scene", "summary"],
              description: "Which prep section to read",
            },
            index: {
              type: "number",
              description: "For 'scene' section: 0-based scene index. Omit for other sections.",
            },
          },
          required: ["section"],
        },
      },
    ],

    handler: async (name, args) => {
      if (name !== "read_prep") return `Unknown tool: ${name}`;

      const brief = meetingPrepSkill?.currentBrief;
      if (!brief) {
        return "No meeting prep loaded. Use recall_context instead.";
      }

      const section = args.section as string;
      switch (section) {
        case "resources": {
          const parts: string[] = [];
          if (brief.filePaths?.length > 0) {
            parts.push("**Files:**");
            for (const f of brief.filePaths) {
              parts.push(`- ${f.path} — ${f.description}${f.action ? ` [${f.action}]` : ""}`);
            }
          }
          if (brief.browserUrls?.length > 0) {
            parts.push("**URLs:**");
            for (const u of brief.browserUrls) {
              parts.push(`- ${u.url} — ${u.description}${u.action ? ` [${u.action}]` : ""}`);
            }
          }
          if (brief.folderPaths?.length > 0) {
            parts.push("**Folders:**");
            for (const f of brief.folderPaths) {
              parts.push(`- ${f.path} — ${f.description}`);
            }
          }
          return parts.length > 0 ? parts.join("\n") : "No resources in prep.";
        }

        case "decisions": {
          if (!brief.architectureDecisions?.length) return "No architecture decisions in prep.";
          return brief.architectureDecisions
            .map((d, i) => `${i + 1}. **${d.decision}**: ${d.rationale}`)
            .join("\n\n");
        }

        case "questions": {
          if (!brief.expectedQuestions?.length) return "No expected questions in prep.";
          return brief.expectedQuestions
            .map((q, i) => `Q${i + 1}: ${q.question}\n→ ${q.suggestedAnswer}`)
            .join("\n\n");
        }

        case "history": {
          return brief.previousContext || "No historical context in prep.";
        }

        case "all_points": {
          if (!brief.keyPoints?.length) return "No key points in prep.";
          return brief.keyPoints.map((p, i) => `${i + 1}. ${p}`).join("\n");
        }

        case "scene": {
          if (!brief.scenes?.length) return "No presentation scenes in prep.";
          const idx = typeof args.index === "number" ? args.index : 0;
          if (idx < 0 || idx >= brief.scenes.length) {
            return `Scene index ${idx} out of range (0-${brief.scenes.length - 1}).`;
          }
          const s = brief.scenes[idx]!;
          return [
            `**Scene ${idx + 1}/${brief.scenes.length}**`,
            `URL: ${s.url}`,
            s.scrollTarget ? `Scroll to: ${s.scrollTarget}` : null,
            `Talking points: ${s.talkingPoints}`,
            `Duration: ${Math.round(s.durationMs / 1000)}s`,
          ].filter(Boolean).join("\n");
        }

        case "summary": {
          return brief.summary || "No summary in prep.";
        }

        default:
          return `Unknown section: ${section}. Available: resources, decisions, questions, history, all_points, scene, summary.`;
      }
    },
  };
}
