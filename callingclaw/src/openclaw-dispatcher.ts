// CallingClaw 2.0 — OpenClaw Three-Channel Dispatcher
// ═══════════════════════════════════════════════════════════════════
//
// Routes tasks to OpenClaw via the fastest available channel:
//
//   LOCAL (<100ms)       — keyword search on workspace files. No OpenClaw.
//   SUBPROCESS (3-10s)   — `claude -p --bare` single-turn. No Gateway needed.
//   GATEWAY (10s+)       — OpenClaw Gateway WS. Full session, deep research.
//
// Architecture:
//   CallingClaw task
//        │
//        ├── urgency: "realtime" → LOCAL (keyword search)
//        ├── urgency: "fast"     → SUBPROCESS (claude -p)
//        └── urgency: "background" → GATEWAY (WS :18789)
//
// The dispatcher replaces direct OpenClawBridge.sendTask() calls for
// tasks that can be served faster by a subprocess or local search.
// Gateway is still used for multi-turn, session-aware, MCP-dependent tasks.
//
// See project_three_channel_dispatch.md for the design rationale.
// ═══════════════════════════════════════════════════════════════════

import type { OpenClawBridge } from "./openclaw_bridge";

// ── Channel Types ──

export type DispatchChannel = "local" | "subprocess" | "gateway";
export type DispatchUrgency = "realtime" | "fast" | "background";

export interface DispatchOptions {
  /** Speed requirement */
  urgency?: DispatchUrgency;
  /** Model override (default: sonnet for subprocess) */
  model?: "sonnet" | "haiku" | "opus";
  /** Max agentic turns for subprocess (default: 5) */
  maxTurns?: number;
  /** Enable Chrome browser automation in subprocess */
  chrome?: boolean;
  /** Restrict available tools in subprocess */
  tools?: string[];
  /** Working directory for subprocess */
  cwd?: string;
  /** Timeout in ms (default: per channel) */
  timeout?: number;
}

export interface DispatchResult {
  channel: DispatchChannel;
  result: string;
  durationMs: number;
  /** Whether result came from fallback after primary channel failed */
  fallback: boolean;
}

// ── Config ──

const WORKSPACE_DIR = `${process.env.HOME}/.openclaw/workspace`;
const MEMORY_PATH = `${WORKSPACE_DIR}/MEMORY.md`;

const TIMEOUTS: Record<DispatchChannel, number> = {
  local: 500,       // 500ms — if keyword search is slower, something is wrong
  subprocess: 30000, // 30s — claude -p with tool use
  gateway: 600000,   // 10min — deep research
};

// ── Dispatcher ──

export class OpenClawDispatcher {
  private gateway: OpenClawBridge;
  private _memoryCache: string | null = null;
  private _memoryCacheTs = 0;
  private readonly MEMORY_CACHE_TTL = 60000; // 1 min cache for MEMORY.md

  constructor(gateway: OpenClawBridge) {
    this.gateway = gateway;
  }

  // ══════════════════════════════════════════════════════════════
  // Main Dispatch
  // ══════════════════════════════════════════════════════════════

  async dispatch(task: string, opts: DispatchOptions = {}): Promise<DispatchResult> {
    const urgency = opts.urgency || "fast";
    const channel = this.selectChannel(urgency, opts);
    const timeout = opts.timeout || TIMEOUTS[channel];
    const start = Date.now();

    try {
      const result = await Promise.race([
        this.execute(channel, task, opts),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error(`${channel} timeout (${timeout}ms)`)), timeout)
        ),
      ]);

      return {
        channel,
        result,
        durationMs: Date.now() - start,
        fallback: false,
      };
    } catch (e: any) {
      // Fallback chain: local fails → subprocess, subprocess fails → gateway
      console.warn(`[Dispatcher] ${channel} failed: ${e.message}, trying fallback`);

      if (channel === "local") {
        return this.dispatch(task, { ...opts, urgency: "fast" });
      }
      if (channel === "subprocess") {
        return this.dispatchGatewayFallback(task, start);
      }

      return {
        channel,
        result: `Dispatch failed: ${e.message}`,
        durationMs: Date.now() - start,
        fallback: true,
      };
    }
  }

  private selectChannel(urgency: DispatchUrgency, opts: DispatchOptions): DispatchChannel {
    if (urgency === "realtime") return "local";
    if (urgency === "fast") return "subprocess";
    return "gateway";
  }

  private async execute(channel: DispatchChannel, task: string, opts: DispatchOptions): Promise<string> {
    switch (channel) {
      case "local": return this.executeLocal(task);
      case "subprocess": return this.executeSubprocess(task, opts);
      case "gateway": return this.executeGateway(task);
    }
  }

  private async dispatchGatewayFallback(task: string, startTs: number): Promise<DispatchResult> {
    try {
      const result = await this.executeGateway(task);
      return { channel: "gateway", result, durationMs: Date.now() - startTs, fallback: true };
    } catch (e: any) {
      return { channel: "gateway", result: `All channels failed: ${e.message}`, durationMs: Date.now() - startTs, fallback: true };
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Channel: LOCAL (keyword search, <100ms)
  // ══════════════════════════════════════════════════════════════

  private async executeLocal(query: string): Promise<string> {
    const memory = await this.loadMemory();
    if (!memory) throw new Error("No memory available");

    // Extract keywords from query (>2 chars, skip stop words)
    const stopWords = new Set(["the", "is", "at", "which", "what", "how", "can", "about", "from",
      "的", "了", "在", "是", "有", "和", "就", "不", "也", "都", "这", "那", "你", "我"]);
    const keywords = query.toLowerCase()
      .replace(/[^\w\u4e00-\u9fff]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w));

    if (keywords.length === 0) throw new Error("No searchable keywords");

    // Search MEMORY.md by lines
    const lines = memory.split("\n");
    const matches: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const lower = lines[i]!.toLowerCase();
      const hits = keywords.filter((kw) => lower.includes(kw));
      if (hits.length > 0) {
        // Include surrounding context (±2 lines)
        const start = Math.max(0, i - 2);
        const end = Math.min(lines.length, i + 3);
        const ctx = lines.slice(start, end).join("\n");
        if (!matches.some((m) => m.includes(ctx.slice(0, 50)))) {
          matches.push(ctx);
        }
      }
    }

    if (matches.length === 0) throw new Error("No local matches");

    // Also search other workspace files
    const workspaceMatches = await this.searchWorkspaceFiles(keywords);
    const allMatches = [...matches, ...workspaceMatches];

    return allMatches.slice(0, 5).join("\n---\n");
  }

  /** Search .md files in workspace for keywords */
  private async searchWorkspaceFiles(keywords: string[]): Promise<string[]> {
    const results: string[] = [];
    try {
      const glob = new Bun.Glob("*.md");
      const files = await Array.fromAsync(glob.scan({ cwd: WORKSPACE_DIR, onlyFiles: true }));
      for (const f of files) {
        if (f === "MEMORY.md") continue; // Already searched
        try {
          const content = await Bun.file(`${WORKSPACE_DIR}/${f}`).text();
          const lower = content.toLowerCase();
          const hits = keywords.filter((kw) => lower.includes(kw));
          if (hits.length >= 2) { // Need at least 2 keyword matches for workspace files
            // Extract first matching paragraph
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
              const ll = lines[i]!.toLowerCase();
              if (keywords.some((kw) => ll.includes(kw))) {
                const start = Math.max(0, i - 1);
                const end = Math.min(lines.length, i + 4);
                results.push(`[${f}]\n${lines.slice(start, end).join("\n")}`);
                break;
              }
            }
          }
        } catch {}
        if (results.length >= 3) break;
      }
    } catch {}
    return results;
  }

  /** Load MEMORY.md with 1-minute cache */
  private async loadMemory(): Promise<string | null> {
    const now = Date.now();
    if (this._memoryCache && now - this._memoryCacheTs < this.MEMORY_CACHE_TTL) {
      return this._memoryCache;
    }
    try {
      const file = Bun.file(MEMORY_PATH);
      if (!(await file.exists())) return null;
      this._memoryCache = await file.text();
      this._memoryCacheTs = now;
      return this._memoryCache;
    } catch {
      return null;
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Channel: SUBPROCESS (claude -p, 3-10s)
  // ══════════════════════════════════════════════════════════════

  /**
   * Run a task via `claude -p --bare` subprocess.
   * No Gateway needed. Direct CLI invocation with full tool access.
   * Returns the model's text response.
   */
  private async executeSubprocess(task: string, opts: DispatchOptions): Promise<string> {
    const model = opts.model || "sonnet";
    const maxTurns = opts.maxTurns || 5;

    // Note: do NOT use --bare — it skips keychain/OAuth which is needed for
    // Team Account auth. Use --disable-slash-commands for faster startup instead.
    const args: string[] = [
      "claude", "-p",
      "--disable-slash-commands",
      "--model", model,
      "--permission-mode", "bypassPermissions",
      "--output-format", "json",
      "--max-turns", String(maxTurns),
      "--no-session-persistence",
    ];

    if (opts.chrome) args.push("--chrome");
    if (opts.tools && opts.tools.length > 0) args.push("--tools", opts.tools.join(","));

    args.push(task);

    const cwd = opts.cwd || WORKSPACE_DIR;

    console.log(`[Dispatcher] Subprocess: model=${model}, maxTurns=${maxTurns}, chrome=${!!opts.chrome}, cwd=${cwd}`);

    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd,
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;

    if (exitCode !== 0 && !stdout) {
      throw new Error(`claude -p exited ${exitCode}: ${stderr.slice(0, 500)}`);
    }

    // Parse JSON output format
    try {
      const parsed = JSON.parse(stdout);
      // claude -p --output-format json returns { result: string, ... }
      return parsed.result || parsed.content || parsed.text || stdout;
    } catch {
      // Plain text output
      return stdout.trim();
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Channel: GATEWAY (OpenClaw WS, 10s+)
  // ══════════════════════════════════════════════════════════════

  private async executeGateway(task: string): Promise<string> {
    if (!this.gateway.connected) {
      try {
        await this.gateway.connect();
      } catch {
        throw new Error("Gateway not available");
      }
    }
    return this.gateway.sendTask(task);
  }

  // ══════════════════════════════════════════════════════════════
  // Convenience Methods (typed shortcuts for common patterns)
  // ══════════════════════════════════════════════════════════════

  /** Quick memory recall — local first, subprocess fallback */
  async recall(query: string): Promise<DispatchResult> {
    return this.dispatch(query, { urgency: "realtime" });
  }

  /** Thorough recall — subprocess with Haiku for speed */
  async recallThorough(query: string): Promise<DispatchResult> {
    return this.dispatch(
      `Search your memory and files for: "${query}". Return concise factual answer under 500 words.`,
      { urgency: "fast", model: "haiku", maxTurns: 3 },
    );
  }

  /** Browser automation — subprocess with Chrome */
  async browserAction(instruction: string): Promise<DispatchResult> {
    return this.dispatch(instruction, {
      urgency: "fast",
      chrome: true,
      model: "sonnet",
      maxTurns: 10,
      timeout: 60000,
    });
  }

  /** Deep research — full Gateway session */
  async deepResearch(task: string): Promise<DispatchResult> {
    return this.dispatch(task, { urgency: "background" });
  }

  /** File editing — subprocess with restricted tools */
  async editFile(instruction: string, cwd?: string): Promise<DispatchResult> {
    return this.dispatch(instruction, {
      urgency: "fast",
      tools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
      cwd,
      maxTurns: 5,
    });
  }
}
