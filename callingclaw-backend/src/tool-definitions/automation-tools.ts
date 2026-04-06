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
import { PAGE_EXTRACT_JS, formatPageContext, PAGE_CONTEXT_ID } from "../utils/page-extract";

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
  chromeLauncher?: any; // ChromeLauncher for interact tool (presenting page control)
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
      // Not in Gemini's hardcoded 9-tool set (gemini-adapter.ts); Gemini uses open_file + computer_action instead
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
      // ── Presenting Tab Control (click/scroll/navigate on shared page) ──
      {
        name: "interact",
        description:
          "Control the presenting tab (the page you're sharing in Meet). " +
          "Use this to click buttons, scroll through content, or navigate to a new URL while presenting. " +
          "After each action, you'll receive updated [PAGE] context showing what's now visible.",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["click", "scroll", "scroll_down", "scroll_up", "navigate"],
              description: "Action to perform on presenting page",
            },
            target: {
              type: "string",
              description: "For click: button/link text to click. For scroll: 'up'/'down' or text to scroll to. For navigate: URL.",
            },
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

          // ── Tiered search: prep resources first, then workspace dirs ──
          // Tier 1: Files referenced in current meeting prep (highest relevance)
          // Tier 2: Workspace directories (~/.callingclaw/shared, ~/.openclaw/workspace, project docs)
          const tier1Files: string[] = [];
          const prepBrief = meetingPrepSkill?.currentBrief;
          if (prepBrief) {
            if (prepBrief.filePaths) for (const f of prepBrief.filePaths) tier1Files.push(f.path);
            if (prepBrief.browserUrls) for (const u of prepBrief.browserUrls) tier1Files.push(u.url);
          }
          // Also check stageDocuments (files already opened in the meeting)
          for (const doc of context.stageDocuments) tier1Files.push(doc.path);

          const tier2Dirs = [
            `${home}/.callingclaw/shared`,
            `${home}/.openclaw/workspace`,
            `${home}/Library/Mobile Documents/com~apple~CloudDocs/CallingClaw 2.0/docs`,
            `${home}/Library/Mobile Documents/com~apple~CloudDocs/CallingClaw 2.0/callingclaw-backend/public`,
            `${home}/Library/Mobile Documents/com~apple~CloudDocs/Tanka`,
          ];

          // ── Tokenize + normalize query ──
          const kws = query.toLowerCase().split(/[\s/\\._-]+/).filter((w: string) => w.length > 1);
          if (kws.length === 0) return "No search keywords provided.";

          // ── Scoring: fuzzy match with bonus for all-keyword matches ──
          type ScoredFile = { path: string; score: number; tier: number };
          const scored: ScoredFile[] = [];
          const seen = new Set<string>();

          function scoreFile(filePath: string, tier: number) {
            if (seen.has(filePath)) return;
            seen.add(filePath);
            const name = filePath.toLowerCase().split("/").pop() || "";
            const fullLower = filePath.toLowerCase();
            let score = 0;
            let matched = 0;
            for (const kw of kws) {
              if (name.includes(kw)) { score += 10; matched++; }       // filename match (strong)
              else if (fullLower.includes(kw)) { score += 3; matched++; } // path match (weak)
            }
            if (matched === 0) return;
            // Bonus: all keywords matched → strong relevance signal
            if (matched === kws.length) score += 20;
            // Tier bonus: prep files rank higher
            if (tier === 1) score += 15;
            scored.push({ path: filePath, score, tier });
          }

          // Score tier 1 (prep resources)
          for (const f of tier1Files) scoreFile(f, 1);

          // Score tier 2 (workspace dirs)
          for (const dir of tier2Dirs) {
            try {
              if (contentSearch && kws.length > 0) {
                const grepPattern = kws.slice(0, 3).join("|");
                const out = await Bun.$`grep -ril --include="*.html" --include="*.md" --include="*.json" --include="*.pdf" ${grepPattern} ${dir} 2>/dev/null`.text();
                for (const line of out.split("\n")) {
                  const p = line.trim();
                  if (p) scoreFile(p, 2);
                }
              } else {
                const out = await Bun.$`find ${dir} -maxdepth 4 -type f \( -name "*.html" -o -name "*.md" -o -name "*.pdf" -o -name "*.json" \) -not -path "*/node_modules/*" 2>/dev/null`.text();
                for (const line of out.split("\n")) {
                  const p = line.trim();
                  if (p) scoreFile(p, 2);
                }
              }
            } catch {}
          }

          // Sort by score descending
          scored.sort((a, b) => b.score - a.score);

          if (scored.length === 0) {
            return `No files found matching "${query}". Try different keywords${!contentSearch ? " or set content_search=true to search inside files" : ""}.`;
          }

          const top = scored.slice(0, 10);
          const short = top.map((f, i) => `${i + 1}. ${f.path.replace(home, "~")} (score: ${f.score})`).join("\n");
          return `Found ${scored.length} file(s) matching "${query}":\n${short}${scored.length > 10 ? `\n... and ${scored.length - 10} more` : ""}\n\nUse open_file with the full path to open one.`;
        }
        // ── exec: run shell command (atomic action for agent loop) ──
        case "exec": {
          const command = (args.command as string) || "";
          if (!command) return "No command provided.";
          eventBus.emit("voice.tool_call", { tool: "exec", summary: command.slice(0, 80) });
          // Safety: block destructive commands
          const blocked = /\brm\s+-rf\b|mkfs|dd\s+if=|>\s*\/dev\//.test(command);
          if (blocked) return "Command blocked for safety.";
          try {
            const proc = Bun.spawn(["bash", "-c", command], {
              stdout: "pipe", stderr: "pipe",
              cwd: require("os").homedir(),
              env: { ...process.env, PATH: process.env.PATH },
            });
            const [stdout, stderr] = await Promise.all([
              new Response(proc.stdout).text(),
              new Response(proc.stderr).text(),
            ]);
            const code = await proc.exited;
            const output = (stdout || stderr).trim().slice(0, 3000);
            return code === 0
              ? (output || "(empty output)")
              : `Exit ${code}: ${output}`;
          } catch (e: any) {
            return `Error: ${e.message}`;
          }
        }
        // ── interact: click/scroll/navigate on presenting page ──
        // After each action, re-extract DOM so voice AI sees updated content.
        case "interact": {
          const action = (args.action as string) || "";
          const target = (args.target as string) || "";
          eventBus.emit("voice.tool_call", { tool: "interact", summary: `${action} ${target}`.slice(0, 80) });
          const cl = deps.chromeLauncher;
          if (!cl?.presentingPage) return "No presenting page active. Use share_screen first.";
          let actionResult: string;
          try {
            switch (action) {
              case "click": {
                if (!target) {
                  // No target: extract DOM to show what's clickable
                  const raw = await cl.evaluateOnPresentingPage(PAGE_EXTRACT_JS);
                  const ctx = formatPageContext(raw);
                  return ctx || "No clickable elements found.";
                }
                await cl.evaluateOnPresentingPage(`(() => {
                  const els = document.querySelectorAll('a,button,input,[role="button"],[onclick]');
                  for (const el of els) {
                    if ((el.textContent || '').toLowerCase().includes(${JSON.stringify(target.toLowerCase())})) {
                      el.click(); return 'clicked';
                    }
                  }
                  return 'not found';
                })()`);
                actionResult = `Clicked "${target}".`;
                break;
              }
              case "scroll":
              case "scroll_down":
                await cl.evaluateOnPresentingPage(`window.scrollBy(0, ${target === "up" ? -600 : 600})`);
                actionResult = `Scrolled ${target || "down"}.`;
                break;
              case "scroll_up":
                await cl.evaluateOnPresentingPage(`window.scrollBy(0, -600)`);
                actionResult = "Scrolled up.";
                break;
              case "navigate":
                if (!target) return "Provide a URL to navigate to.";
                await cl.navigatePresentingPage(target);
                actionResult = `Navigated to ${target}.`;
                break;
              default:
                return `Unknown action: ${action}. Use click, scroll, scroll_up, scroll_down, or navigate.`;
            }
          } catch (e: any) {
            return `Interact error: ${e.message}`;
          }

          // Re-extract DOM after action so voice AI sees updated page content.
          // Uses fixed ID — replaces previous DOM context, not accumulates.
          try {
            await new Promise(r => setTimeout(r, 300)); // brief pause for page to settle
            const raw = await cl.evaluateOnPresentingPage(PAGE_EXTRACT_JS);
            const pageCtx = formatPageContext(raw);
            if (pageCtx && deps.voice) {
              deps.voice.replaceContext(pageCtx, PAGE_CONTEXT_ID);
            }
          } catch {}

          return actionResult;
        }
        default:
          return `Unknown automation tool: ${name}`;
      }
    },
  };
}
