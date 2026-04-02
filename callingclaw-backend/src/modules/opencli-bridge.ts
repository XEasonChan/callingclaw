// CallingClaw 2.0 — OpenCLI Bridge (Execution Layer)
//
// Single point of contact with OpenCLI. Provides:
//   1. Deterministic adapters (GitHub, HN, Google, etc.) — $0, ~200ms
//   2. AI-driven operate mode (novel browser tasks via DOM snapshots)
//   3. CLI hub (local files, app launching, external tools)
//
// Architecture: Chrome #2 (OpenCLI) is ISOLATED from Chrome #1 (Playwright/Meet).
// If OpenCLI crashes, audio stays alive. Fault isolation by design.

import type { EventBus } from "./event-bus";

const OPENCLI_BIN = "opencli"; // global install for speed (npx adds ~1.5s overhead)
const DAEMON_PORT = 19825;
const DEFAULT_TIMEOUT = 30_000;

export interface OpenCLIHealthStatus {
  available: boolean;
  daemonAlive: boolean;
  version: string | null;
  lastCheck: number;
}

export interface OpenCLIResult {
  success: boolean;
  output: string;
  durationMs: number;
  command: string;
}

export class OpenCLIBridge {
  private _health: OpenCLIHealthStatus = {
    available: false,
    daemonAlive: false,
    version: null,
    lastCheck: 0,
  };
  private eventBus?: EventBus;

  constructor(eventBus?: EventBus) {
    this.eventBus = eventBus;
  }

  get health(): OpenCLIHealthStatus { return { ...this._health }; }
  get available(): boolean { return this._health.available; }

  /** Initialize: check if opencli is installed and get version. */
  async init(): Promise<boolean> {
    try {
      const result = await this.exec(["--version"], { timeout: 10000 });
      if (result.success) {
        this._health.available = true;
        this._health.version = result.output.trim();
        this._health.lastCheck = Date.now();
        console.log(`[OpenCLIBridge] Available: ${this._health.version}`);
        return true;
      }
    } catch { /* not installed */ }
    this._health.available = false;
    console.warn("[OpenCLIBridge] Not available — falling through to other layers");
    return false;
  }

  /** Check if the OpenCLI daemon is running. */
  async checkDaemon(): Promise<boolean> {
    try {
      const resp = await fetch(`http://localhost:${DAEMON_PORT}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      this._health.daemonAlive = resp.ok;
      return resp.ok;
    } catch {
      this._health.daemonAlive = false;
      return false;
    }
  }

  /** Run a deterministic OpenCLI adapter command. Zero LLM cost. */
  async adapter(tool: string, args: string[] = []): Promise<OpenCLIResult> {
    const command = [tool, ...args];
    const start = performance.now();
    this.eventBus?.emit("opencli.adapter_start", { tool, args });

    const result = await this.exec(command);
    const durationMs = Math.round(performance.now() - start);
    this.eventBus?.emit("opencli.adapter_done", { tool, success: result.success, durationMs });

    return {
      success: result.success,
      output: result.success ? this.formatAdapterOutput(result.output, tool) : result.output,
      durationMs,
      command: `opencli ${command.join(" ")}`,
    };
  }

  /** Run an OpenCLI operate command for AI-driven browser automation. */
  async operate(action: string, params: Record<string, string> = {}): Promise<OpenCLIResult> {
    const args = ["operate", action];
    if (action === "open" && params.url) args.push(params.url);
    else if (action === "click" && params.ref) args.push(params.ref);
    else if (action === "type" && params.ref && params.text) args.push(params.ref, params.text);
    else if (action === "scroll" && params.direction) args.push(`--direction=${params.direction}`);
    else if (action === "eval" && params.js) args.push(params.js);

    const start = performance.now();
    this.eventBus?.emit("opencli.operate_start", { action, params });
    const result = await this.exec(args, { skipJsonFormat: true });
    const durationMs = Math.round(performance.now() - start);
    this.eventBus?.emit("opencli.operate_done", { action, success: result.success, durationMs });

    return { success: result.success, output: result.output, durationMs, command: `opencli ${args.join(" ")}` };
  }

  /** Run a CLI hub command for non-browser tasks. */
  async cli(tool: string, args: string[] = []): Promise<OpenCLIResult> {
    const command = [tool, ...args];
    const start = performance.now();
    this.eventBus?.emit("opencli.cli_start", { tool, args });
    const result = await this.exec(command, { skipJsonFormat: true });
    const durationMs = Math.round(performance.now() - start);
    this.eventBus?.emit("opencli.cli_done", { tool, success: result.success, durationMs });

    return { success: result.success, output: result.output, durationMs, command: `opencli ${command.join(" ")}` };
  }

  /** Execute an opencli command via npx. All interaction goes through here. */
  private async exec(
    args: string[],
    opts: { timeout?: number; skipJsonFormat?: boolean } = {},
  ): Promise<{ success: boolean; output: string }> {
    const timeout = opts.timeout || DEFAULT_TIMEOUT;
    const fullArgs = [OPENCLI_BIN, ...args];

    // Add JSON format for adapter calls (not operate, not --version)
    if (!opts.skipJsonFormat && !args.includes("operate") && !args.includes("--version") && !args.includes("--help")) {
      if (!args.includes("--format")) {
        fullArgs.push("--format", "json");
      }
    }

    try {
      const proc = Bun.spawn(fullArgs, {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, OPENCLI_BROWSER_CONNECT_TIMEOUT: "10000" },
      });

      const [stdout, stderr] = await Promise.all([
        Promise.race([
          new Response(proc.stdout).text(),
          new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error(`opencli timeout (${timeout}ms)`)), timeout)
          ),
        ]),
        new Response(proc.stderr).text(),
      ]);

      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const errMsg = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;
        console.warn(`[OpenCLIBridge] Failed: opencli ${args.join(" ")} → ${errMsg.slice(0, 100)}`);
        return { success: false, output: errMsg };
      }
      return { success: true, output: stdout };
    } catch (e: any) {
      console.error(`[OpenCLIBridge] Exec error: ${e.message}`);
      return { success: false, output: e.message };
    }
  }

  /** Normalize adapter JSON output to human-readable string for voice AI. */
  private formatAdapterOutput(raw: string, tool: string): string {
    try {
      const data = JSON.parse(raw);

      if (tool === "github" && Array.isArray(data.issues || data)) {
        const issues = data.issues || data;
        if (issues.length === 0) return "No open issues found.";
        const list = issues.slice(0, 5).map((i: any, idx: number) =>
          `${idx + 1}. ${i.title || i.name || "Untitled"}${i.state ? ` (${i.state})` : ""}`
        ).join("; ");
        return `Found ${issues.length} issues: ${list}`;
      }

      if (tool === "hackernews" && Array.isArray(data.stories || data)) {
        const stories = data.stories || data;
        const list = stories.slice(0, 5).map((s: any, idx: number) =>
          `${idx + 1}. ${s.title || s.name || "Untitled"} (${s.points || 0} pts)`
        ).join("; ");
        return `Top stories: ${list}`;
      }

      if (tool === "google" && Array.isArray(data.results || data)) {
        const results = data.results || data;
        if (results.length === 0) return "No search results found.";
        const list = results.slice(0, 3).map((r: any, idx: number) =>
          `${idx + 1}. ${r.title || "Untitled"}: ${(r.snippet || r.description || "").slice(0, 80)}`
        ).join("; ");
        return `Search results: ${list}`;
      }

      if (typeof data === "object") return JSON.stringify(data).slice(0, 500);
      return raw.trim().slice(0, 500);
    } catch {
      return raw.trim().slice(0, 500);
    }
  }

  getStatus(): OpenCLIHealthStatus { return { ...this._health }; }
}
