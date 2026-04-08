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
import { PAGE_EXTRACT_JS, PAGE_CLICK_JS, formatPageContext, PAGE_CONTEXT_ID } from "../utils/page-extract";

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
          "For click: use the [index] number from [PAGE] context (e.g. target='3' clicks element [3]). " +
          "Text matching also works (e.g. target='Download'). " +
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
              description: "For click: element [index] number (preferred) or button/link text. For scroll: 'up'/'down'. For navigate: URL.",
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

          // ── Build prep description index for scoring ──
          // Allows matching "launch video script" → description "Personal 视频完整分镜脚本"
          const prepDescriptions = new Map<string, string>();
          if (prepBrief) {
            for (const f of (prepBrief.filePaths || [])) {
              prepDescriptions.set(f.path, f.description || "");
            }
          }

          // ── Scoring: fuzzy match with description + filename + path ──
          type ScoredFile = { path: string; score: number; tier: number };
          const scored: ScoredFile[] = [];
          const seen = new Set<string>();

          function scoreFile(filePath: string, tier: number) {
            if (seen.has(filePath)) return;
            seen.add(filePath);
            const name = filePath.toLowerCase().split("/").pop() || "";
            const fullLower = filePath.toLowerCase();
            const desc = (prepDescriptions.get(filePath) || "").toLowerCase();
            let score = 0;
            let matched = 0;
            for (const kw of kws) {
              if (name.includes(kw)) { score += 10; matched++; }       // filename match (strong)
              else if (desc.includes(kw)) { score += 8; matched++; }   // description match (strong, from prep)
              else if (fullLower.includes(kw)) { score += 3; matched++; } // path match (weak)
            }
            if (matched === 0) return;
            // Bonus: all keywords matched → strong relevance signal
            if (matched === kws.length) score += 20;
            // Partial match bonus: >60% keywords matched
            if (matched >= kws.length * 0.6 && matched < kws.length) score += 10;
            // Tier bonus: prep files rank higher
            if (tier === 1) score += 15;
            scored.push({ path: filePath, score, tier });
          }

          // Score tier 1 (prep resources — now with description matching)
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
          // Detect if presenting tab is on Meeting Stage (scroll/click should target iframe)
          const currentPageUrl = String(cl.presentingPage?.url() || "");
          const onStage = currentPageUrl.includes("/stage") || currentPageUrl.includes("callingclaw-stage-");
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

                // Index-based click (preferred): target="3" clicks element [3]
                const indexMatch = target.match(/^\d+$/);
                if (indexMatch) {
                  const clickResult = await cl.evaluateOnPresentingPage(PAGE_CLICK_JS(parseInt(target)));
                  try {
                    const r = JSON.parse(String(clickResult));
                    if (r.ok) {
                      actionResult = `Clicked [${target}] ${r.tag}: "${r.text}".`;
                    } else {
                      actionResult = `Element [${target}] not found. Use interact(action="click") without target to see available elements.`;
                    }
                  } catch {
                    actionResult = `Clicked element [${target}].`;
                  }
                } else {
                  // Text-based fallback: target="Download for Mac" (fuzzy match + W3C events)
                  const clickResult = await cl.evaluateOnPresentingPage(`(() => {
                    var els = document.querySelectorAll('a,button,input,textarea,[role="button"],[role="textbox"],[contenteditable="true"],[onclick]');
                    var target = null;
                    var targetText = ${JSON.stringify(target.toLowerCase())};
                    for (var el of els) {
                      if (el.offsetWidth === 0 || el.offsetHeight === 0) continue;
                      var text = (el.textContent || '').toLowerCase().trim();
                      if (text.includes(targetText)) { target = el; break; }
                    }
                    if (!target) {
                      // Try aria-label match
                      for (var el of els) {
                        var label = (el.getAttribute('aria-label') || '').toLowerCase();
                        if (label.includes(targetText)) { target = el; break; }
                      }
                    }
                    if (!target) return JSON.stringify({ ok: false });

                    // W3C click: scrollIntoView + hit-test + synthetic events
                    target.scrollIntoView({ behavior: 'instant', block: 'center' });
                    var rect = target.getBoundingClientRect();
                    var x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
                    var hit = document.elementFromPoint(x, y);
                    var ct = (hit instanceof HTMLElement && target.contains(hit)) ? hit : target;
                    var po = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerType: 'mouse' };
                    var mo = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
                    ct.dispatchEvent(new PointerEvent('pointerover', po));
                    ct.dispatchEvent(new PointerEvent('pointerenter', Object.assign({}, po, { bubbles: false })));
                    ct.dispatchEvent(new MouseEvent('mouseover', mo));
                    ct.dispatchEvent(new MouseEvent('mouseenter', Object.assign({}, mo, { bubbles: false })));
                    ct.dispatchEvent(new PointerEvent('pointerdown', po));
                    ct.dispatchEvent(new MouseEvent('mousedown', mo));
                    target.focus({ preventScroll: true });
                    ct.dispatchEvent(new PointerEvent('pointerup', po));
                    ct.dispatchEvent(new MouseEvent('mouseup', mo));
                    // Prevent navigation-away on external links (would kill the presenting tab)
                    var href = target.tagName === 'A' ? target.getAttribute('href') : null;
                    var isExternal = href && (href.startsWith('http') && !href.includes(location.hostname));
                    var isDownload = href && (href.includes('.dmg') || href.includes('.zip') || href.includes('.exe') || target.hasAttribute('download'));
                    if (isExternal || isDownload) {
                      return JSON.stringify({ ok: true, text: (target.textContent || '').trim().slice(0, 60), link: href, external: true });
                    }
                    ct.click();
                    return JSON.stringify({ ok: true, text: (target.textContent || '').trim().slice(0, 60) });
                  })()`);
                  try {
                    const r = JSON.parse(String(clickResult));
                    if (r.ok && r.external) {
                      actionResult = `"${r.text}" links to ${r.link}. Did NOT navigate (would leave the current page). The link is: ${r.link}`;
                    } else {
                      actionResult = r.ok ? `Clicked "${r.text}".` : `"${target}" not found on page.`;
                    }
                  } catch {
                    actionResult = `Clicked "${target}".`;
                  }
                }
                break;
              }
              case "scroll":
              case "scroll_down": {
                // If on Stage page, scroll the IFRAME content (not the outer Stage)
                if (onStage) {
                  const dir = target === "up" ? -1 : 1;
                  const iframeScroll = await cl.evaluateOnPresentingPage(`(() => {
                    var iframe = document.getElementById('slideFrame');
                    if (!iframe || !iframe.contentWindow) return JSON.stringify({ error: 'no iframe' });
                    var doc = iframe.contentDocument;
                    var vh = iframe.clientHeight;

                    // Section-aware: find next heading in iframe
                    if (${dir} > 0 && doc) {
                      var headings = doc.querySelectorAll('h1,h2,h3');
                      var currentTop = Math.max(doc.documentElement.scrollTop, doc.body.scrollTop);
                      for (var h of headings) {
                        var hTop = h.getBoundingClientRect().top + currentTop;
                        if (hTop > currentTop + vh * 0.3) {
                          h.scrollIntoView({ behavior: 'smooth', block: 'start' });
                          var st = Math.max(doc.documentElement.scrollTop, doc.body.scrollTop);
                          var sh = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight);
                          return JSON.stringify({
                            scrollY: Math.round(st), scrollMax: Math.round(sh - vh),
                            pct: Math.round(st / Math.max(1, sh - vh) * 100),
                            nextSection: (h.textContent || '').trim().substring(0, 60)
                          });
                        }
                      }
                    }

                    // Fallback: scroll by viewport height
                    iframe.contentWindow.scrollBy({ top: ${dir} * Math.round(vh * 0.75), behavior: 'smooth' });
                    var st = Math.max(doc.documentElement.scrollTop, doc.body.scrollTop);
                    var sh = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight);
                    return JSON.stringify({
                      scrollY: Math.round(st), scrollMax: Math.round(sh - vh),
                      pct: Math.round(st / Math.max(1, sh - vh) * 100), nextSection: null
                    });
                  })()`);
                  try {
                    const info = JSON.parse(String(iframeScroll));
                    if (info.error) { actionResult = `iframe: ${info.error}`; }
                    else {
                      actionResult = info.nextSection
                        ? `Scrolled iframe to: "${info.nextSection}". Position: ${info.pct}%.`
                        : `Scrolled iframe ${target || "down"}. Position: ${info.pct}%.`;
                    }
                  } catch { actionResult = `Scrolled iframe ${target || "down"}.`; }
                  break;
                }

                // Regular page scroll (not Stage)
                const scrollInfo = await cl.evaluateOnPresentingPage(`(() => {
                  var vh = window.innerHeight;
                  var currentY = window.scrollY;
                  var viewBottom = currentY + vh;
                  var dir = ${JSON.stringify(target)} === "up" ? -1 : 1;

                  // Find next section heading below current viewport
                  if (dir > 0) {
                    var headings = document.querySelectorAll('h1,h2,h3,section[id],section[class]');
                    var nextSection = null;
                    for (var h of headings) {
                      var rect = h.getBoundingClientRect();
                      var absY = rect.top + currentY;
                      if (absY > viewBottom + 50) {
                        nextSection = h;
                        break;
                      }
                    }
                    if (nextSection) {
                      nextSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      var title = (nextSection.textContent || '').trim().substring(0, 60);
                      return JSON.stringify({
                        scrollY: Math.round(window.scrollY),
                        scrollMax: Math.round(document.documentElement.scrollHeight - vh),
                        pct: Math.round(window.scrollY / Math.max(1, document.documentElement.scrollHeight - vh) * 100),
                        nextSection: title
                      });
                    }
                  }

                  // Fallback: scroll by viewport height
                  window.scrollBy(0, dir * Math.round(vh * 0.75));
                  return JSON.stringify({
                    scrollY: Math.round(window.scrollY),
                    scrollMax: Math.round(document.documentElement.scrollHeight - vh),
                    pct: Math.round(window.scrollY / Math.max(1, document.documentElement.scrollHeight - vh) * 100),
                    nextSection: null
                  });
                })()`);
                try {
                  const info = JSON.parse(String(scrollInfo));
                  actionResult = info.nextSection
                    ? `Scrolled to section: "${info.nextSection}". Position: ${info.pct}%.`
                    : `Scrolled ${target || "down"}. Position: ${info.pct}% (${info.scrollY}/${info.scrollMax}px).`;
                } catch {
                  actionResult = `Scrolled ${target || "down"}.`;
                }
                break;
              }
              case "scroll_up": {
                // Reuse the scroll_down Stage detection (target="up")
                if (onStage) {
                  const iframeUp = await cl.evaluateOnPresentingPage(`(() => {
                    var iframe = document.getElementById('slideFrame');
                    if (!iframe || !iframe.contentWindow) return JSON.stringify({ error: 'no iframe' });
                    iframe.contentWindow.scrollBy({ top: -Math.round(iframe.clientHeight * 0.75), behavior: 'smooth' });
                    var doc = iframe.contentDocument;
                    var st = Math.max(doc.documentElement.scrollTop, doc.body.scrollTop);
                    var sh = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight);
                    return JSON.stringify({ scrollY: Math.round(st), pct: Math.round(st / Math.max(1, sh - iframe.clientHeight) * 100) });
                  })()`);
                  try {
                    const info = JSON.parse(String(iframeUp));
                    actionResult = info.error ? `iframe: ${info.error}` : `Scrolled iframe up. Position: ${info.pct}%.`;
                  } catch { actionResult = "Scrolled iframe up."; }
                  break;
                }
                const upInfo = await cl.evaluateOnPresentingPage(`(() => {
                  window.scrollBy(0, -Math.round(window.innerHeight * 0.75));
                  return JSON.stringify({ scrollY: Math.round(window.scrollY), pct: Math.round(window.scrollY / Math.max(1, document.documentElement.scrollHeight - window.innerHeight) * 100) });
                })()`);
                try {
                  const info = JSON.parse(String(upInfo));
                  actionResult = `Scrolled up. Position: ${info.pct}% (${info.scrollY}px).`;
                } catch {
                  actionResult = "Scrolled up.";
                }
                break;
              }
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
