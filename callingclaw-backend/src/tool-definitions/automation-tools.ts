// CallingClaw 2.0 — Automation Tool Definitions & Handlers
// Tools: computer_action, take_screenshot, zoom_control, browser_action

import type { ToolModule } from "./types";
import type { AutomationRouter } from "../modules/automation-router";
import type { ComputerUseModule } from "../modules/computer-use";
import type { EventBus } from "../modules/event-bus";
import type { SharedContext } from "../modules/shared-context";
import type { VoiceModule } from "../modules/voice";
import type { PythonBridge } from "../bridge";
import type { PlaywrightCLIClient } from "../mcp_client/playwright-cli";
import type { ZoomSkill } from "../skills/zoom";
import type { MeetingPrepSkill } from "../skills/meeting-prep";
import { notifyTaskCompletion } from "../voice-persona";

export interface AutomationToolDeps {
  automationRouter: AutomationRouter;
  computerUse: ComputerUseModule;
  eventBus: EventBus;
  context: SharedContext;
  voice: VoiceModule;
  bridge: PythonBridge;
  playwrightCli: PlaywrightCLIClient;
  zoomSkill: ZoomSkill;
  meetingPrepSkill: MeetingPrepSkill;
}

export function automationTools(deps: AutomationToolDeps): ToolModule {
  const {
    automationRouter,
    computerUse,
    eventBus,
    context,
    // voice accessed lazily via deps.voice (created after buildAllTools)
    bridge,
    playwrightCli,
    zoomSkill,
    meetingPrepSkill,
  } = deps;

  return {
    definitions: [
      {
        name: "computer_action",
        description:
          "Perform an action on the computer screen. Call when user asks to click, type, open, share screen, or interact with something on screen. CallingClaw has its own dedicated computer.",
        parameters: {
          type: "object",
          properties: {
            instruction: {
              type: "string",
              description: "What to do on the computer",
            },
          },
          required: ["instruction"],
        },
      },
      {
        name: "take_screenshot",
        description:
          "Take a screenshot of CallingClaw's screen. Call when you need to see what's currently displayed.",
        parameters: { type: "object", properties: {} },
      },
      // ── Zoom Controls ──
      {
        name: "zoom_control",
        description:
          "Control the Zoom desktop app. Use for: muting/unmuting, toggling video, sharing screen, " +
          "joining/leaving Zoom meetings, raising hand, toggling chat, recording. " +
          "These are instant keyboard shortcut operations — much faster than Computer Use.",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "toggle_mute", "toggle_video", "start_share", "stop_share",
                "share_screen", "end_meeting", "raise_hand", "toggle_chat",
                "toggle_participants", "start_recording", "fullscreen",
                "join_url", "send_chat", "activate",
              ],
              description: "Zoom action to perform",
            },
            url: { type: "string", description: "Zoom meeting URL (for join_url)" },
            message: { type: "string", description: "Chat message (for send_chat)" },
            target: { type: "string", description: "Share target — 'Desktop 1' or window name (for share_screen)" },
          },
          required: ["action"],
        },
      },
      // ── Local File Search (CLI agent loop) ──
      // Enables multi-turn search: model calls search_files → sees results → calls open_file
      // Not available on Gemini (4-tool limit), Gemini uses enriched open_file result instead
      {
        name: "search_files",
        description:
          "Search local files by keywords using CLI (grep/find). Returns matching file paths. " +
          "Use when you need to find a file before opening it, or when open_file returned 'not found'. " +
          "Supports searching by filename AND file content (grep).",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search keywords (e.g. 'tanka action mcp' or 'PRD phase 1')" },
            content_search: { type: "boolean", description: "If true, also grep inside file contents (slower but finds files by content)" },
          },
          required: ["query"],
        },
      },
      // ── Browser Automation (Playwright CLI) ──
      {
        name: "browser_action",
        description:
          "Control the browser via Playwright CLI (Layer 2). Much faster and more token-efficient than Computer Use. " +
          "Uses accessibility tree snapshots with @ref identifiers for precise element targeting. " +
          "Supports: navigate to URL, switch tabs, scroll, click elements by @ref, type text, take snapshot. " +
          "Use for Notion, GitHub, Google Slides, Google Calendar web, and any browser task.",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["navigate", "snapshot", "click", "type", "scroll_down", "scroll_up",
                     "next_tab", "prev_tab", "new_tab", "close_tab", "press_key"],
              description: "Browser action to perform",
            },
            url: { type: "string", description: "URL to navigate to (for navigate/new_tab)" },
            ref: { type: "string", description: "Element @ref from snapshot, e.g. 'e1' or '@e1' (for click/type)" },
            text: { type: "string", description: "Text to type or key to press" },
          },
          required: ["action"],
        },
      },
    ],

    handler: async (name, args) => {
      switch (name) {
        case "computer_action": {
          eventBus.emit("voice.tool_call", { tool: "computer_action", instruction: (args.instruction as string).slice(0, 80) });
          // Route through the 4-layer automation router first
          eventBus.emit("computer.task_started", { instruction: args.instruction });
          const routerResult = await automationRouter.execute(args.instruction);

          // If the router handled it (Layer 1-3), return immediately
          if (routerResult.success) {
            eventBus.emit("computer.task_done", {
              instruction: args.instruction,
              summary: routerResult.result,
              layer: routerResult.layer,
              durationMs: routerResult.durationMs,
            });
            // Notify Voice AI of task completion during meetings (persistent live note)
            if (meetingPrepSkill.currentBrief) {
              notifyTaskCompletion(deps.voice, meetingPrepSkill, args.instruction, routerResult.result, eventBus);
            }
            return `[${routerResult.layer}${routerResult.fallback ? " (fallback)" : ""}, ${routerResult.durationMs}ms] ${routerResult.result}`;
          }

          // Layer 4 fallback: Computer Use (vision-based)
          if (!computerUse.isConfigured) {
            return "No automation layer could handle this. Computer Use requires an API key.";
          }
          const cuResult = await computerUse.execute(args.instruction);
          eventBus.emit("computer.task_done", { instruction: args.instruction, summary: cuResult.summary, layer: "computer_use" });
          // Notify Voice AI of task completion during meetings
          if (meetingPrepSkill.currentBrief) {
            notifyTaskCompletion(deps.voice, meetingPrepSkill, args.instruction, cuResult.summary, eventBus);
          }
          return cuResult.summary;
        }
        case "take_screenshot": {
          eventBus.emit("voice.tool_call", { tool: "take_screenshot" });
          return new Promise((resolve) => {
            const timeout = setTimeout(() => resolve("Screenshot timeout"), 5000);
            bridge.once("screenshot", (msg: any) => {
              clearTimeout(timeout);
              context.updateScreen(msg.payload.image);
              resolve("Screenshot captured. I can see the current screen.");
            });
            bridge.sendAction("screenshot", {});
          });
        }
        case "zoom_control": {
          const zoomResult = await zoomSkill.execute(args.action, {
            url: args.url,
            message: args.message,
            target: args.target,
          });
          eventBus.emit("automation.zoom", {
            action: args.action,
            success: zoomResult.success,
            durationMs: zoomResult.durationMs,
          });
          return zoomResult.success
            ? `[Zoom, ${zoomResult.durationMs}ms] ${zoomResult.detail}`
            : `Zoom error: ${zoomResult.detail}`;
        }
        case "browser_action": {
          if (!playwrightCli.connected) {
            return "Playwright CLI not connected. Browser automation unavailable.";
          }
          try {
            let browserResult = "";
            switch (args.action) {
              case "navigate":
                browserResult = await playwrightCli.navigate(args.url || "about:blank");
                break;
              case "snapshot":
                browserResult = await playwrightCli.snapshot();
                break;
              case "click":
                browserResult = await playwrightCli.click(args.ref || "");
                break;
              case "type":
                browserResult = await playwrightCli.type(args.ref || "", args.text || "");
                break;
              case "scroll_down":
                browserResult = await playwrightCli.scroll("down");
                break;
              case "scroll_up":
                browserResult = await playwrightCli.scroll("up");
                break;
              case "next_tab":
                browserResult = await playwrightCli.pressKey("Control+Tab");
                break;
              case "prev_tab":
                browserResult = await playwrightCli.pressKey("Control+Shift+Tab");
                break;
              case "new_tab":
                browserResult = await playwrightCli.newTab(args.url);
                break;
              case "close_tab":
                browserResult = await playwrightCli.closeTab();
                break;
              case "press_key":
                browserResult = await playwrightCli.pressKey(args.text || "");
                break;
              default:
                browserResult = `Unknown browser action: ${args.action}`;
            }
            eventBus.emit("automation.browser", { action: args.action });
            return browserResult;
          } catch (e: any) {
            return `Browser error: ${e.message}`;
          }
        }
        case "search_files": {
          eventBus.emit("voice.tool_call", { tool: "search_files", summary: (args.query as string)?.slice(0, 80) });
          const query = (args.query as string) || "";
          const contentSearch = !!args.content_search;
          const home = require("os").homedir();
          const searchDirs = [
            `${home}/Library/Mobile Documents/com~apple~CloudDocs/Tanka`,
            `${home}/Library/Mobile Documents/com~apple~CloudDocs/CallingClaw 2.0/callingclaw-backend/public`,
            `${home}/Library/Mobile Documents/com~apple~CloudDocs/CallingClaw 2.0/docs`,
            `${home}/.callingclaw/shared`,
          ];

          const kws = query.toLowerCase().split(/[\s/\\._-]+/).filter((w: string) => w.length > 1);
          const results: string[] = [];

          for (const dir of searchDirs) {
            try {
              if (contentSearch && kws.length > 0) {
                // grep inside file contents (slower but finds files by content, not just name)
                const grepPattern = kws.slice(0, 3).join("|");
                const out = await Bun.$`grep -ril --include="*.html" --include="*.md" --include="*.json" ${grepPattern} ${dir} 2>/dev/null`.text();
                for (const line of out.split("\n")) {
                  const p = line.trim();
                  if (p && !results.includes(p)) results.push(p);
                }
              } else {
                // filename search (fast)
                const out = await Bun.$`find ${dir} -maxdepth 4 -type f \( -name "*.html" -o -name "*.md" -o -name "*.pdf" -o -name "*.json" \) -not -path "*/node_modules/*" 2>/dev/null`.text();
                for (const line of out.split("\n")) {
                  const p = line.trim();
                  if (p && kws.some(k => p.toLowerCase().includes(k))) results.push(p);
                }
              }
            } catch {}
          }

          if (results.length === 0) {
            return `No files found matching "${query}". Try different keywords${!contentSearch ? " or set content_search=true to search inside files" : ""}.`;
          }

          const short = results.slice(0, 10).map((f, i) => `${i + 1}. ${f.replace(home, "~")}`).join("\n");
          return `Found ${results.length} file(s) matching "${query}":\n${short}${results.length > 10 ? `\n... and ${results.length - 10} more` : ""}\n\nUse open_file with the full path to open one.`;
        }
        default:
          return `Unknown automation tool: ${name}`;
      }
    },
  };
}
