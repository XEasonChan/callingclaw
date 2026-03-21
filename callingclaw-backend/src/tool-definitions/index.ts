// CallingClaw 2.0 — Tool Definitions Index
// Assembles all tool modules into a unified definitions + handler

import type { ToolDefinition, ToolModule } from "./types";
import { calendarTools, type CalendarToolDeps } from "./calendar-tools";
import { meetingTools, type MeetingToolDeps } from "./meeting-tools";
import { automationTools, type AutomationToolDeps } from "./automation-tools";
import { aiTools, type AIToolDeps } from "./ai-tools";

export type { ToolDefinition, ToolModule } from "./types";
export type { CalendarToolDeps } from "./calendar-tools";
export type { MeetingToolDeps } from "./meeting-tools";
export type { AutomationToolDeps } from "./automation-tools";
export type { AIToolDeps } from "./ai-tools";

/** Union of all deps needed by all tool modules */
export type AllToolDeps = CalendarToolDeps & MeetingToolDeps & AutomationToolDeps & AIToolDeps;

/**
 * Build all tool definitions and a unified handler from the given dependencies.
 *
 * Usage in callingclaw.ts:
 * ```ts
 * const { definitions, handler } = buildAllTools(deps);
 * const voice = new VoiceModule({ tools: definitions, onToolCall: handler });
 * ```
 */
export function buildAllTools(deps: AllToolDeps): {
  definitions: ToolDefinition[];
  handler: (name: string, args: any) => Promise<string>;
} {
  const modules: ToolModule[] = [
    calendarTools(deps),
    meetingTools(deps),
    automationTools(deps),
    aiTools(deps),
  ];

  return {
    definitions: modules.flatMap((m) => m.definitions),
    handler: async (name, args) => {
      for (const m of modules) {
        const def = m.definitions.find((d) => d.name === name);
        if (def) return m.handler(name, args);
      }
      return `Unknown tool: ${name}`;
    },
  };
}
