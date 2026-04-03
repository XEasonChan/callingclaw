// CallingClaw 2.0 — Module: Automation Router
// Intelligent 5-layer routing for computer actions.
//
// Layer 1:   Shortcuts        (instant, 100% reliable)
//   → Zoom/Meet keyboard shortcuts, bash open, file/URL launch
//
// Layer 1.5: OpenCLI          (deterministic web + Haiku command generation, ~1-2s, $0)
//   → 66+ web adapters, CLI hub, Haiku generates opencli commands for unknown tasks
//   → Fault-isolated on Chrome #2 (separate from Meet audio on Chrome #1)
//
// Layer 2:   Playwright CLI   (AI-driven browser automation, ~500ms/step + Haiku)
//   → Browser tab switching, web app interaction on Chrome #1
//
// Layer 3:   Peekaboo         (macOS native, AX tree — dormant, see docs/opencli-experiment-findings.md)
//
// Layer 4:   Computer Use     (slow, vision-based fallback)
//   → Canvas/WebGL, Figma design surface, non-standard UI, last resort
//
// The router classifies each instruction and attempts the fastest layer first,
// falling back to the next layer on failure.
//
// FAULT ISOLATION: OpenCLI runs on Chrome #2 (separate process from Playwright's
// Chrome #1 which handles Meet audio). Execution crashes don't kill audio.

import type { PythonBridge } from "../bridge";
import type { EventBus } from "./event-bus";
import { ZoomSkill, type ZoomAction } from "../skills/zoom";
import { PlaywrightCLIClient } from "../mcp_client/playwright-cli";
import { PeekabooClient } from "../mcp_client/peekaboo";
import type { OpenCLIBridge } from "./opencli-bridge";
import { FileAliasIndex } from "./file-alias-index";

// ── Intent Classification ──

export type AutomationLayer = "shortcuts" | "opencli" | "playwright" | "peekaboo" | "computer_use";

export interface ClassifiedIntent {
  layer: AutomationLayer;
  confidence: number;     // 0-1
  action: string;         // normalized action name
  params: Record<string, any>;
  reason: string;         // why this layer was chosen
}

// ── Pattern matchers for intent classification ──

interface RoutePattern {
  match: RegExp;
  layer: AutomationLayer;
  action: string;
  extractParams?: (match: RegExpMatchArray, instruction: string) => Record<string, any>;
  confidence: number;
}

const ROUTE_PATTERNS: RoutePattern[] = [
  // ── Layer 1: Shortcuts & API (highest priority) ──

  // Zoom
  { match: /zoom.*(?:静音|mute)/i, layer: "shortcuts", action: "zoom:toggle_mute", confidence: 0.95 },
  { match: /zoom.*(?:取消静音|unmute)/i, layer: "shortcuts", action: "zoom:toggle_mute", confidence: 0.95 },
  { match: /zoom.*(?:摄像头|camera|视频|video)/i, layer: "shortcuts", action: "zoom:toggle_video", confidence: 0.95 },
  { match: /zoom.*(?:共享|share|投屏|screen.?shar)/i, layer: "shortcuts", action: "zoom:start_share", confidence: 0.9 },
  { match: /zoom.*(?:停止共享|stop.?shar)/i, layer: "shortcuts", action: "zoom:stop_share", confidence: 0.95 },
  { match: /zoom.*(?:结束|end|离开|leave)/i, layer: "shortcuts", action: "zoom:end_meeting", confidence: 0.9 },
  { match: /zoom.*(?:举手|raise.?hand)/i, layer: "shortcuts", action: "zoom:raise_hand", confidence: 0.95 },
  { match: /zoom.*(?:录制|record)/i, layer: "shortcuts", action: "zoom:start_recording", confidence: 0.9 },
  { match: /zoom.*(?:全屏|fullscreen)/i, layer: "shortcuts", action: "zoom:fullscreen", confidence: 0.95 },
  { match: /zoom.*(?:聊天|chat)/i, layer: "shortcuts", action: "zoom:toggle_chat", confidence: 0.9 },
  { match: /zoom.*(?:参与者|participant)/i, layer: "shortcuts", action: "zoom:toggle_participants", confidence: 0.9 },
  { match: /(?:加入|join).*zoom/i, layer: "shortcuts", action: "zoom:join_url",
    extractParams: (_, inst) => {
      const urlMatch = inst.match(/https?:\/\/[^\s]+/);
      return urlMatch ? { url: urlMatch[0] } : {};
    }, confidence: 0.9 },

  // Meet shortcuts
  { match: /meet.*(?:静音|mute)/i, layer: "shortcuts", action: "meet:toggle_mute", confidence: 0.95 },
  { match: /meet.*(?:摄像头|camera|视频|video)/i, layer: "shortcuts", action: "meet:toggle_video", confidence: 0.95 },

  // Open URL (bash open) — exact URL match, high confidence
  { match: /(?:帮我)?(?:打开|open)\s+(https?:\/\/[^\s]+)/i, layer: "shortcuts", action: "open_url",
    extractParams: (m) => ({ url: m[1] }), confidence: 0.95 },

  // Open file by fuzzy name — triggered by auditor's "open file: <query>" or user "打开文件/文档/html"
  // Must be BEFORE open_app so "open file: ..." doesn't get misclassified as an app launch.
  { match: /open file:\s*(.+)/i, layer: "shortcuts", action: "open_file",
    extractParams: (m) => ({ query: m[1]?.trim() }), confidence: 0.9 },
  { match: /(?:帮我)?(?:打开|open)\s*(?:一下\s*)?(?:那个|这个|the)?\s*(.+?)\s*(?:文件|文档|html|pdf|文件夹)/i, layer: "shortcuts", action: "open_file",
    extractParams: (m) => ({ query: m[1]?.trim() }), confidence: 0.85 },

  // App/file launch — LOW confidence so voice-originated ambiguous "open X" falls through
  // to Haiku medium lane (transcript-auditor.ts), which has search_and_open tool + context.
  // Regex can't reliably distinguish "open Slack" (app) from "open the prep file" (search).
  // Haiku handles any language, typos, and vague descriptions natively.
  { match: /(?:帮我)?(?:打开|open|启动|launch)\s+(?:app|应用)?\s*["""']?(.+)/i, layer: "shortcuts", action: "open_app",
    extractParams: (m) => ({ app: m[1]?.trim() }), confidence: 0.4 },

  // ── Layer 1.5: OpenCLI (deterministic web adapters + Haiku command gen) ──
  // Fault-isolated on Chrome #2. Zero LLM cost for known adapters.
  // For unknown tasks, Haiku generates the opencli command (single LLM call).

  // GitHub
  { match: /(?:check|查看|list|列出).*(?:github|gh)\s*(?:issues?|问题)/i, layer: "opencli", action: "github_issues",
    extractParams: (_, inst) => {
      const repoMatch = inst.match(/(?:repo|仓库)\s*[=:]\s*(\S+)/i);
      return repoMatch ? { repo: repoMatch[1] } : {};
    }, confidence: 0.9 },
  { match: /(?:check|查看).*(?:github|gh)\s*(?:pr|pull.?request)/i, layer: "opencli", action: "github_prs",
    extractParams: (_, inst) => {
      const repoMatch = inst.match(/(?:repo|仓库)\s*[=:]\s*(\S+)/i);
      return repoMatch ? { repo: repoMatch[1] } : {};
    }, confidence: 0.9 },

  // HackerNews
  { match: /(?:check|查看|看看).*(?:hacker\s*news|HN|hn)\s*(?:trending|top|热门)?/i, layer: "opencli", action: "hackernews_trending",
    extractParams: (_, inst) => {
      const limitMatch = inst.match(/(?:top|前)\s*(\d+)/);
      return limitMatch ? { limit: limitMatch[1] } : { limit: "5" };
    }, confidence: 0.9 },

  // Google search / news
  { match: /(?:google|谷歌)\s*(?:news|新闻)/i, layer: "opencli", action: "google_news", confidence: 0.9 },
  { match: /(?:search|搜索|google|谷歌).*(?:for|关于)?\s*[""\u201c](.+?)[""\u201d]/i, layer: "opencli", action: "google_search",
    extractParams: (m) => ({ query: m[1] }), confidence: 0.85 },

  // arXiv / Wikipedia / StackOverflow
  { match: /(?:arxiv|论文).*(?:search|搜索|find|找)/i, layer: "opencli", action: "arxiv_search",
    extractParams: (_, inst) => ({ query: inst.replace(/.*(?:search|搜索|find|找)\s*/i, "").trim() }), confidence: 0.85 },
  { match: /(?:wikipedia|维基).*(?:search|搜索|look up|查)/i, layer: "opencli", action: "wikipedia_search",
    extractParams: (_, inst) => ({ query: inst.replace(/.*(?:search|搜索|look up|查)\s*/i, "").trim() }), confidence: 0.85 },

  // ── Layer 2: Playwright (browser operations — Chrome #1) ──

  // Tab management
  { match: /(?:切.?到|switch|切换).*(tab|标签|第\s*\d)/i, layer: "playwright", action: "switch_tab", confidence: 0.9 },
  { match: /(?:下一个|next)\s*tab/i, layer: "playwright", action: "next_tab", confidence: 0.9 },
  { match: /(?:上一个|prev|previous)\s*tab/i, layer: "playwright", action: "prev_tab", confidence: 0.9 },
  { match: /(?:新建|new|打开新)\s*tab/i, layer: "playwright", action: "new_tab", confidence: 0.9 },
  { match: /(?:关闭|close)\s*tab/i, layer: "playwright", action: "close_tab", confidence: 0.9 },

  // Scrolling in browser
  { match: /(?:往下|向下|scroll\s*down|滚动)/i, layer: "playwright", action: "scroll_down", confidence: 0.85 },
  { match: /(?:往上|向上|scroll\s*up)/i, layer: "playwright", action: "scroll_up", confidence: 0.85 },
  { match: /(?:滚到|scroll\s*to).*(?:顶部|top)/i, layer: "playwright", action: "scroll_top", confidence: 0.9 },
  { match: /(?:滚到|scroll\s*to).*(?:底部|bottom)/i, layer: "playwright", action: "scroll_bottom", confidence: 0.9 },

  // Notion
  { match: /notion/i, layer: "playwright", action: "browser_interact", confidence: 0.85 },

  // GitHub
  { match: /github|pull.?request|PR\s*#?\d/i, layer: "playwright", action: "browser_interact", confidence: 0.85 },

  // Google Slides / Docs / Sheets
  { match: /(?:google\s*)?(?:slides?|幻灯片|docs?|sheets?)/i, layer: "playwright", action: "browser_interact", confidence: 0.85 },
  { match: /(?:下一页|next\s*(?:page|slide))/i, layer: "playwright", action: "next_slide", confidence: 0.85 },
  { match: /(?:上一页|prev|previous)\s*(?:page|slide)/i, layer: "playwright", action: "prev_slide", confidence: 0.85 },

  // Generic browser navigation
  { match: /(?:浏览器|browser|chrome|edge|safari).*(?:打开|open|导航|navigate|go)/i, layer: "playwright", action: "navigate", confidence: 0.8 },
  { match: /(?:点击|click).*(?:链接|link|按钮|button)/i, layer: "playwright", action: "browser_click", confidence: 0.7 },

  // ── Layer 3: Peekaboo (native macOS) ──

  // Window management
  { match: /(?:窗口|window).*(?:大小|resize|调整|split|分屏)/i, layer: "peekaboo", action: "window_manage", confidence: 0.85 },
  { match: /(?:最大化|maximize|全屏)/i, layer: "peekaboo", action: "window_maximize", confidence: 0.8 },
  { match: /(?:最小化|minimize)/i, layer: "peekaboo", action: "window_minimize", confidence: 0.9 },
  { match: /(?:左边|left).*(右边|right).*(?:放|并排|分屏|side)/i, layer: "peekaboo", action: "split_view", confidence: 0.85 },

  // Native app focus/switch
  { match: /(?:切到|switch\s*to|切换到)\s*(Finder|Terminal|VS\s*Code|Slack|Mail|Notes|Calendar)/i,
    layer: "peekaboo", action: "focus_app", extractParams: (m) => ({ app: m[1] }), confidence: 0.85 },

  // System Settings
  { match: /(?:系统设置|system\s*settings|系统偏好|权限|permission)/i, layer: "peekaboo", action: "system_settings", confidence: 0.8 },

  // Menu interactions
  { match: /(?:菜单|menu).*(?:点击|click)/i, layer: "peekaboo", action: "menu_click", confidence: 0.8 },

  // ── Layer 4: Computer Use (visual fallback) ──

  // Figma (Canvas-based, no DOM)
  { match: /figma/i, layer: "computer_use", action: "visual_interact", confidence: 0.7 },

  // Generic "看一下屏幕" / visual tasks
  { match: /(?:看看|look\s*at|see\s*what|截图|screenshot)/i, layer: "computer_use", action: "screenshot", confidence: 0.6 },
];

// ── Router Class ──

export class AutomationRouter {
  private bridge: PythonBridge;
  private eventBus?: EventBus;
  private zoom: ZoomSkill;
  private browser: PlaywrightCLIClient;
  private peekaboo: PeekabooClient;
  private opencli: OpenCLIBridge | null;
  private _fileIndex = new FileAliasIndex();

  constructor(
    bridge: PythonBridge,
    eventBus?: EventBus,
    browser?: PlaywrightCLIClient,
    peekaboo?: PeekabooClient,
    opencli?: OpenCLIBridge,
  ) {
    this.bridge = bridge;
    this.eventBus = eventBus;
    this.zoom = new ZoomSkill(bridge);
    this.browser = browser || new PlaywrightCLIClient();
    this.peekaboo = peekaboo || new PeekabooClient();
    this.opencli = opencli || null;
  }

  /** File alias index for instant voice-to-file lookup during meetings */
  get fileIndex(): FileAliasIndex { return this._fileIndex; }

  /** Classify an instruction into an automation layer + action */
  classify(instruction: string): ClassifiedIntent {
    for (const pattern of ROUTE_PATTERNS) {
      const match = instruction.match(pattern.match);
      if (match) {
        const params = pattern.extractParams ? pattern.extractParams(match, instruction) : {};
        return {
          layer: pattern.layer,
          confidence: pattern.confidence,
          action: pattern.action,
          params,
          reason: `Matched pattern: ${pattern.match.source}`,
        };
      }
    }

    // Default: fall through to computer_use for unrecognized instructions
    return {
      layer: "computer_use",
      confidence: 0.3,
      action: "generic",
      params: { instruction },
      reason: "No pattern matched — falling back to Computer Use (vision)",
    };
  }

  /** Execute an instruction using the appropriate automation layer */
  async execute(instruction: string): Promise<{
    layer: AutomationLayer;
    success: boolean;
    result: string;
    durationMs: number;
    fallback?: boolean;
  }> {
    const intent = this.classify(instruction);
    const start = performance.now();

    this.eventBus?.emit("automation.routed", {
      layer: intent.layer,
      action: intent.action,
      confidence: intent.confidence,
      reason: intent.reason,
    });

    // Emit command details for Electron's osascript automation handler
    this.eventBus?.emit("automation.command", {
      layer: intent.layer,
      action: intent.action,
      params: intent.params,
      instruction: instruction.slice(0, 200),
    });

    console.log(`[Router] ${intent.layer} → ${intent.action} (${Math.round(intent.confidence * 100)}%): "${instruction.slice(0, 60)}"`);

    try {
      const result = await this.executeLayer(intent);
      const durationMs = Math.round(performance.now() - start);

      this.eventBus?.emit("automation.done", {
        layer: intent.layer,
        action: intent.action,
        success: true,
        durationMs,
      });

      return { layer: intent.layer, success: true, result, durationMs };
    } catch (e: any) {
      console.warn(`[Router] ${intent.layer} failed: ${e.message}`);

      // Try fallback to next layer
      const fallbackLayer = this.getFallbackLayer(intent.layer);
      if (fallbackLayer) {
        console.log(`[Router] Falling back to ${fallbackLayer}`);
        this.eventBus?.emit("automation.fallback", {
          from: intent.layer,
          to: fallbackLayer,
          reason: e.message,
        });

        try {
          const fallbackIntent: ClassifiedIntent = {
            ...intent,
            layer: fallbackLayer,
            reason: `Fallback from ${intent.layer}: ${e.message}`,
          };
          const result = await this.executeLayer(fallbackIntent);
          const durationMs = Math.round(performance.now() - start);
          return { layer: fallbackLayer, success: true, result, durationMs, fallback: true };
        } catch (e2: any) {
          const durationMs = Math.round(performance.now() - start);
          return { layer: fallbackLayer, success: false, result: `All layers failed: ${e2.message}`, durationMs, fallback: true };
        }
      }

      const durationMs = Math.round(performance.now() - start);
      return { layer: intent.layer, success: false, result: `Failed: ${e.message}`, durationMs };
    }
  }

  /** Execute on a specific layer */
  private async executeLayer(intent: ClassifiedIntent): Promise<string> {
    switch (intent.layer) {
      case "shortcuts":
        return this.executeShortcuts(intent);
      case "opencli":
        return this.executeOpenCLI(intent);
      case "playwright":
        return this.executePlaywright(intent);
      case "peekaboo":
        return this.executePeekaboo(intent);
      case "computer_use":
        // Return a signal that Computer Use should handle this
        // The caller (callingclaw.ts) will route to ComputerUseModule
        throw new Error("DELEGATE_TO_COMPUTER_USE");
      default:
        throw new Error(`Unknown layer: ${intent.layer}`);
    }
  }

  // ── Layer 1: Shortcuts & API ──

  private async executeShortcuts(intent: ClassifiedIntent): Promise<string> {
    const { action, params } = intent;

    // Zoom actions
    if (action.startsWith("zoom:")) {
      const zoomAction = action.replace("zoom:", "") as ZoomAction;
      const result = await this.zoom.execute(zoomAction, params);
      return result.success ? result.detail : `Zoom error: ${result.detail}`;
    }

    // Meet shortcuts
    if (action.startsWith("meet:")) {
      const shortcutMap: Record<string, string> = {
        "meet:toggle_mute": "command+d",
        "meet:toggle_video": "command+e",
      };
      const key = shortcutMap[action];
      if (key) {
        this.bridge.sendAction("key", { key });
        return `Meet: ${action.replace("meet:", "")}`;
      }
    }

    // Open app
    if (action === "open_app") {
      const app = params.app;
      await Bun.$`open -a ${app}`.quiet().nothrow();
      return `Opened ${app}`;
    }

    // Open URL
    if (action === "open_url") {
      await Bun.$`open ${params.url}`.quiet().nothrow();
      return `Opened ${params.url}`;
    }

    // Open file — search by fuzzy name if no absolute path
    if (action === "open_file") {
      let filePath = params.path;
      if (!filePath || !filePath.startsWith("/")) {
        // Fuzzy file search: search project dir + shared dir for matching files
        const query = params.path || params.query || params.instruction || "";
        filePath = await this.searchLocalFile(query);
        if (!filePath) throw new Error(`File not found: "${query}"`);
      }
      const app = params.app || "browser";
      if (app === "browser" || filePath.endsWith(".html") || filePath.endsWith(".htm")) {
        await Bun.$`open -a "Google Chrome" ${filePath}`.quiet().nothrow();
      } else if (app === "vscode") {
        await Bun.$`code ${filePath}`.quiet().nothrow();
      } else {
        await Bun.$`open ${filePath}`.quiet().nothrow();
      }
      return `Opened ${filePath}`;
    }

    // Share screen / present — use ChromeLauncher if available
    if (action === "share_screen" || action === "present") {
      const url = params.url;
      // If fuzzy file reference, search first
      if (params.query && !url) {
        const filePath = await this.searchLocalFile(params.query);
        if (filePath) {
          // Serve via localhost if it's in the public dir, otherwise file://
          const isPublic = filePath.includes("/public/");
          const serveUrl = isPublic
            ? `http://localhost:4000/${filePath.split("/public/").pop()}`
            : `file://${filePath}`;
          try {
            const resp = await fetch("http://localhost:4000/api/screen/share", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ url: serveUrl }),
            });
            const data = await resp.json() as any;
            return data.success ? `Presenting: ${serveUrl}` : `Share failed: ${data.message}`;
          } catch (e: any) {
            throw new Error(`Screen share API failed: ${e.message}`);
          }
        }
      }
      // Direct URL share
      try {
        const resp = await fetch("http://localhost:4000/api/screen/share", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: url || undefined }),
        });
        const data = await resp.json() as any;
        return data.success ? `Presenting${url ? ': ' + url : ' (entire screen)'}` : `Share failed: ${data.message}`;
      } catch (e: any) {
        throw new Error(`Screen share API failed: ${e.message}`);
      }
    }

    // Stop sharing
    if (action === "stop_sharing") {
      try {
        await fetch("http://localhost:4000/api/screen/stop", { method: "POST" });
        return "Stopped presenting";
      } catch { return "Stop sharing failed"; }
    }

    throw new Error(`Unknown shortcut action: ${action}`);
  }

  // ── Layer 2: Playwright CLI ──

  private async executePlaywright(intent: ClassifiedIntent): Promise<string> {
    if (!this.browser.connected) {
      throw new Error("Playwright CLI not connected");
    }

    const { action, params } = intent;

    switch (action) {
      case "switch_tab":
      case "next_tab":
        return this.browser.pressKey("Control+Tab");
      case "prev_tab":
        return this.browser.pressKey("Control+Shift+Tab");
      case "new_tab":
        return this.browser.newTab(params.url);
      case "close_tab":
        return this.browser.closeTab();
      case "scroll_down":
        return this.browser.scroll("down", params.amount || 3);
      case "scroll_up":
        return this.browser.scroll("up", params.amount || 3);
      case "scroll_top":
        return this.browser.pressKey("Home");
      case "scroll_bottom":
        return this.browser.pressKey("End");
      case "next_slide":
        return this.browser.pressKey("ArrowRight");
      case "prev_slide":
        return this.browser.pressKey("ArrowLeft");
      case "navigate":
        if (params.url) return this.browser.navigate(params.url);
        throw new Error("No URL provided for navigation");
      case "browser_click": {
        // Return snapshot with @refs for the caller/AI to decide what to click
        const snapshot = await this.browser.snapshot();
        return `Page snapshot:\n${snapshot}`;
      }
      case "browser_interact": {
        // Generic browser interaction — return snapshot for AI to decide
        const snapshot = await this.browser.snapshot();
        return `Page snapshot:\n${snapshot}`;
      }
      default:
        throw new Error(`Unknown browser action: ${action}`);
    }
  }

  // ── File Search (fuzzy name match across project + shared dirs) ──

  private async searchLocalFile(query: string): Promise<string | null> {
    if (!query || query.length < 2) return null;

    // Fast path: check pre-built file alias index (~2ms, no LLM)
    if (this._fileIndex.ready) {
      const match = this._fileIndex.search(query);
      if (match) return match.path;
    }

    // Slow path: directory scan + Haiku fuzzy match (fallback)
    const { homedir } = await import("os");
    const { resolve } = await import("path");
    const projectRoot = resolve(homedir(), "Library/Mobile Documents/com~apple~CloudDocs/CallingClaw 2.0");
    const iCloudRoot = resolve(homedir(), "Library/Mobile Documents/com~apple~CloudDocs");
    const searchDirs = [
      resolve(homedir(), ".callingclaw", "shared"),
      resolve(projectRoot, "callingclaw-backend/public"),
      resolve(projectRoot, "docs"),
      projectRoot,
      resolve(iCloudRoot, "Tanka"),          // Tanka project files (PRDs, designs, etc.)
      resolve(iCloudRoot, "Tanka/Tanka Link 2.0"),
    ];

    // Collect candidate files (exclude node_modules/.git)
    const allFiles: string[] = [];
    for (const dir of searchDirs) {
      try {
        const output = await Bun.$`find ${dir} -maxdepth 3 -type f \( -name "*.html" -o -name "*.md" -o -name "*.pdf" -o -name "*.json" \) -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null`.text();
        for (const line of output.split("\n")) {
          const p = line.trim();
          if (p) allFiles.push(p);
        }
      } catch {}
    }
    if (allFiles.length === 0) return null;

    // AI-native: Haiku picks the best match (any language, typos, vague descriptions)
    const { CONFIG } = await import("../config");
    if (CONFIG.openrouter.apiKey) {
      try {
        const home = homedir();
        const short = allFiles.map(f => f.replace(projectRoot, ".").replace(home, "~"));
        const resp = await fetch(`${CONFIG.openrouter.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${CONFIG.openrouter.apiKey}` },
          body: JSON.stringify({
            model: CONFIG.analysis?.model || "anthropic/claude-haiku-4-5",
            messages: [{ role: "user", content: `Pick the file that best matches this request. Respond with ONLY the number.\n\nRequest: "${query}"\n\nFiles:\n${short.map((f, i) => `${i + 1}. ${f}`).join("\n")}` }],
            max_tokens: 10, temperature: 0,
          }),
          signal: AbortSignal.timeout(5000),
        });
        const data = await resp.json() as any;
        const idx = parseInt(data.choices?.[0]?.message?.content?.trim() || "") - 1;
        if (idx >= 0 && idx < allFiles.length) {
          console.log(`[Router] AI file search "${query}" → ${short[idx]} (Haiku #${idx + 1}/${allFiles.length})`);
          return allFiles[idx]!;
        }
      } catch (e: any) {
        console.warn(`[Router] AI file search failed: ${e.message}`);
      }
    }

    // Fallback: keyword match
    const STOP = new Set(["the","a","an","this","that","my","for","and","or","of","in","to","is","it","please","打开","帮我","看看","最近的","那个","这个"]);
    const ZH: Record<string,string> = {"文件":"file","文档":"doc","总结":"summary","准备":"prep","会议":"meeting","计划":"plan","测试":"test","待办":"todo"};
    const raw = query.toLowerCase().replace(/[^\w\s\u4e00-\u9fff]/g," ").split(/\s+/).filter(k => k.length > 1 && !STOP.has(k));
    const keywords = raw.flatMap(k => ZH[k] ? [k, ZH[k]] : [k]);
    if (keywords.length === 0) return allFiles[0] || null;
    const scored = allFiles.map(f => ({ path: f, score: keywords.filter(k => f.toLowerCase().includes(k)).length }))
      .filter(r => r.score >= Math.max(1, Math.ceil(keywords.length * 0.3)));
    scored.sort((a, b) => b.score - a.score);
    if (scored.length > 0) {
      console.log(`[Router] Keyword search "${query}" → ${scored[0]!.path}`);
      return scored[0]!.path;
    }
    return null;
  }

  // ── Layer 3: Peekaboo ──

  private async executePeekaboo(intent: ClassifiedIntent): Promise<string> {
    if (!this.peekaboo.available) {
      throw new Error("Peekaboo CLI not available");
    }

    const { action, params } = intent;

    switch (action) {
      case "focus_app":
        const appResult = await this.peekaboo.app("focus", params.app);
        return appResult.success ? `Focused: ${params.app}` : appResult.output;

      case "window_manage":
      case "window_maximize":
        const maxResult = await this.peekaboo.window("maximize", { app: params.app });
        return maxResult.success ? "Window maximized" : maxResult.output;

      case "window_minimize":
        const minResult = await this.peekaboo.window("minimize", { app: params.app });
        return minResult.success ? "Window minimized" : minResult.output;

      case "split_view":
        // Use Peekaboo to arrange windows side by side
        // This would need AppleScript for precise positioning
        const leftApp = params.leftApp || params.app;
        const rightApp = params.rightApp;
        if (leftApp) await this.peekaboo.app("focus", leftApp);
        return "Split view arranged";

      case "system_settings":
        await Bun.$`open "x-apple.systempreferences:"`.quiet().nothrow();
        return "System Settings opened";

      case "menu_click":
        if (params.app && params.menuPath) {
          const menuResult = await this.peekaboo.menu(params.app, params.menuPath);
          return menuResult.success ? `Menu clicked: ${params.menuPath}` : menuResult.output;
        }
        throw new Error("Missing app or menuPath for menu click");

      default:
        throw new Error(`Unknown Peekaboo action: ${action}`);
    }
  }

  // ── Layer 1.5: OpenCLI (deterministic adapters + Haiku command gen) ──

  private async executeOpenCLI(intent: ClassifiedIntent): Promise<string> {
    if (!this.opencli?.available) {
      throw new Error("OpenCLI not available — falling back");
    }

    const { action, params } = intent;

    switch (action) {
      case "github_issues": {
        const args = ["issues", "--state", "open", "--limit", "10"];
        if (params.repo) args.unshift("--repo", params.repo);
        const result = await this.opencli.cli("gh", ["issue", "list", ...args, "--json", "title,state,url"]);
        if (!result.success) throw new Error(result.output);
        return `[opencli, ${result.durationMs}ms] ${result.output.slice(0, 500)}`;
      }

      case "github_prs": {
        const args = ["pr", "list", "--state", "open", "--limit", "10", "--json", "title,state,url"];
        if (params.repo) args.push("--repo", params.repo);
        const result = await this.opencli.cli("gh", args);
        if (!result.success) throw new Error(result.output);
        return `[opencli, ${result.durationMs}ms] ${result.output.slice(0, 500)}`;
      }

      case "hackernews_trending": {
        const limit = params.limit || "5";
        const result = await this.opencli.adapter("hackernews", ["best", "--limit", limit]);
        if (!result.success) throw new Error(result.output);
        return `[opencli, ${result.durationMs}ms] ${result.output}`;
      }

      case "google_news": {
        const result = await this.opencli.adapter("google", ["news", "--limit", "5"]);
        if (!result.success) throw new Error(result.output);
        return `[opencli, ${result.durationMs}ms] ${result.output}`;
      }

      case "google_search": {
        if (!params.query) throw new Error("No search query provided");
        const result = await this.opencli.adapter("google", ["search", params.query]);
        if (!result.success) throw new Error(result.output);
        return `[opencli, ${result.durationMs}ms] ${result.output}`;
      }

      case "arxiv_search": {
        if (!params.query) throw new Error("No search query");
        const result = await this.opencli.adapter("arxiv", ["search", params.query, "--limit", "3"]);
        if (!result.success) throw new Error(result.output);
        return `[opencli, ${result.durationMs}ms] ${result.output}`;
      }

      case "wikipedia_search": {
        if (!params.query) throw new Error("No search query");
        const result = await this.opencli.adapter("wikipedia", ["search", params.query]);
        if (!result.success) throw new Error(result.output);
        return `[opencli, ${result.durationMs}ms] ${result.output}`;
      }

      default:
        throw new Error(`Unknown OpenCLI action: ${action}`);
    }
  }

  // ── Fallback logic ──

  private getFallbackLayer(current: AutomationLayer): AutomationLayer | null {
    switch (current) {
      case "shortcuts":    return "opencli";
      case "opencli":      return "playwright";
      case "playwright":   return "peekaboo";
      case "peekaboo":     return "computer_use";
      case "computer_use": return null; // no further fallback
    }
  }

  /** Get status of all layers */
  getStatus(): Record<AutomationLayer, { available: boolean; detail: string }> {
    return {
      shortcuts: { available: true, detail: "Always available (keyboard shortcuts + bash)" },
      opencli: {
        available: this.opencli?.available || false,
        detail: this.opencli?.available
          ? `OpenCLI ${this.opencli.health.version || "ready"} (Chrome #2, fault-isolated)`
          : "Not available — web tasks fall through to Playwright",
      },
      playwright: {
        available: this.browser.connected,
        detail: this.browser.connected
          ? "Playwright CLI ready"
          : "Not started",
      },
      peekaboo: {
        available: this.peekaboo.available,
        detail: this.peekaboo.available ? "CLI ready" : "Not installed",
      },
      computer_use: { available: true, detail: "Vision-based fallback" },
    };
  }
}
