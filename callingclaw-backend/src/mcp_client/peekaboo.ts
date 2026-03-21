// CallingClaw 2.0 — Peekaboo Client (Layer 3: macOS Native Automation)
// Wraps the Peekaboo CLI for native macOS GUI automation.
// Peekaboo uses Swift + ScreenCaptureKit + AXorcist for fast screenshots
// and accessibility-tree-based element interaction.
//
// Install: brew install steipete/tap/peekaboo
// CLI:     peekaboo <command> [options]
//
// We use the CLI directly instead of the MCP server because:
// 1. CLI is more stable than the MCP server (fewer permission issues)
// 2. Direct control over timeouts and error handling
// 3. No Node.js/npx dependency

export interface PeekabooElement {
  id: string;
  role: string;
  title?: string;
  value?: string;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
}

export interface PeekabooResult {
  success: boolean;
  output: string;
  durationMs: number;
  elements?: PeekabooElement[];
  screenshot?: string; // base64 if requested
}

export class PeekabooClient {
  private _available = false;

  get available() { return this._available; }

  /** Check if Peekaboo is installed */
  async checkAvailability(): Promise<boolean> {
    try {
      const result = await Bun.$`which peekaboo`.quiet().nothrow();
      this._available = result.exitCode === 0;
      if (this._available) {
        console.log("[Peekaboo] CLI found — Layer 3 (macOS native) available");
      } else {
        console.warn("[Peekaboo] CLI not found. Install: brew install steipete/tap/peekaboo");
      }
      return this._available;
    } catch {
      this._available = false;
      return false;
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Vision — See what's on screen
  // ══════════════════════════════════════════════════════════════

  /** Capture annotated screenshot with element IDs */
  async see(opts?: {
    app?: string;
    mode?: "screen" | "window" | "multi";
  }): Promise<PeekabooResult> {
    const args = ["see"];
    if (opts?.app) args.push("--app", opts.app);
    if (opts?.mode) args.push("--mode", opts.mode);
    args.push("--format", "json");
    return this.run(args);
  }

  /** Capture raw screenshot (no element annotation) */
  async image(opts?: {
    app?: string;
    path?: string;
  }): Promise<PeekabooResult> {
    const args = ["image"];
    if (opts?.app) args.push("--app", opts.app);
    if (opts?.path) args.push("--path", opts.path);
    return this.run(args);
  }

  // ══════════════════════════════════════════════════════════════
  // Input — Click, type, scroll
  // ══════════════════════════════════════════════════════════════

  /** Click on an element or coordinates */
  async click(target: {
    on?: string;        // element label from `see` output
    coords?: { x: number; y: number };
    app?: string;
    button?: "left" | "right" | "double";
  }): Promise<PeekabooResult> {
    const args = ["click"];
    if (target.app) args.push("--app", target.app);
    if (target.on) args.push("--on", target.on);
    if (target.coords) args.push("--coords", `${target.coords.x},${target.coords.y}`);
    if (target.button === "right") args.push("--right");
    if (target.button === "double") args.push("--double");
    return this.run(args);
  }

  /** Type text */
  async type(text: string, opts?: {
    app?: string;
    on?: string;   // target element
  }): Promise<PeekabooResult> {
    const args = ["type", text];
    if (opts?.app) args.push("--app", opts.app);
    if (opts?.on) args.push("--on", opts.on);
    return this.run(args);
  }

  /** Press keyboard keys/shortcuts */
  async press(keys: string, opts?: {
    app?: string;
  }): Promise<PeekabooResult> {
    const args = ["press", keys];
    if (opts?.app) args.push("--app", opts.app);
    return this.run(args);
  }

  /** Press a hotkey combination */
  async hotkey(combo: string, opts?: {
    app?: string;
  }): Promise<PeekabooResult> {
    const args = ["hotkey", combo];
    if (opts?.app) args.push("--app", opts.app);
    return this.run(args);
  }

  /** Scroll in a direction */
  async scroll(direction: "up" | "down" | "left" | "right", amount = 3, opts?: {
    app?: string;
    coords?: { x: number; y: number };
  }): Promise<PeekabooResult> {
    const args = ["scroll", `--${direction}`, String(amount)];
    if (opts?.app) args.push("--app", opts.app);
    if (opts?.coords) args.push("--coords", `${opts.coords.x},${opts.coords.y}`);
    return this.run(args);
  }

  // ══════════════════════════════════════════════════════════════
  // App & Window management
  // ══════════════════════════════════════════════════════════════

  /** Launch or focus an application */
  async app(action: "launch" | "quit" | "focus", appName: string): Promise<PeekabooResult> {
    const args = ["app", `--${action}`, appName];
    return this.run(args);
  }

  /** Manage windows */
  async window(action: "focus" | "minimize" | "maximize" | "close", opts?: {
    app?: string;
    title?: string;
  }): Promise<PeekabooResult> {
    const args = ["window", `--${action}`];
    if (opts?.app) args.push("--app", opts.app);
    if (opts?.title) args.push("--title", opts.title);
    return this.run(args);
  }

  /** List running applications and windows */
  async list(what: "apps" | "windows" | "screens"): Promise<PeekabooResult> {
    return this.run(["list", `--${what}`]);
  }

  // ══════════════════════════════════════════════════════════════
  // Menu & System
  // ══════════════════════════════════════════════════════════════

  /** Click a menu item */
  async menu(app: string, menuPath: string): Promise<PeekabooResult> {
    // menuPath like "File > Save" or "Edit > Copy"
    return this.run(["menu", "--app", app, "--path", menuPath]);
  }

  /** Handle system dialogs (Allow, Deny, etc.) */
  async dialog(action: "accept" | "dismiss"): Promise<PeekabooResult> {
    return this.run(["dialog", `--${action}`]);
  }

  // ══════════════════════════════════════════════════════════════
  // Agent — Natural language multi-step automation
  // ══════════════════════════════════════════════════════════════

  /** Run a natural language task (requires AI provider configured) */
  async agent(task: string, opts?: {
    maxSteps?: number;
  }): Promise<PeekabooResult> {
    const args = ["agent", task];
    if (opts?.maxSteps) args.push("--max-steps", String(opts.maxSteps));
    return this.run(args, 120000); // 2 min timeout for agent tasks
  }

  // ══════════════════════════════════════════════════════════════
  // Core runner
  // ══════════════════════════════════════════════════════════════

  /** Execute a Peekaboo CLI command */
  private async run(args: string[], timeoutMs = 15000): Promise<PeekabooResult> {
    const start = performance.now();

    try {
      const result = await Promise.race([
        Bun.$`peekaboo ${args}`.quiet().nothrow(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Peekaboo timeout (${timeoutMs}ms)`)), timeoutMs)
        ),
      ]);

      const stdout = (result as any).stdout?.toString?.() || "";
      const stderr = (result as any).stderr?.toString?.() || "";
      const exitCode = (result as any).exitCode ?? 0;
      const durationMs = Math.round(performance.now() - start);

      if (exitCode !== 0) {
        console.warn(`[Peekaboo] Command failed (exit ${exitCode}): peekaboo ${args.join(" ")}`);
        if (stderr) console.warn(`[Peekaboo] stderr: ${stderr.slice(0, 200)}`);
        return {
          success: false,
          output: stderr || stdout || `Exit code: ${exitCode}`,
          durationMs,
        };
      }

      // Try to parse JSON output (from --format json)
      let elements: PeekabooElement[] | undefined;
      try {
        const parsed = JSON.parse(stdout);
        if (Array.isArray(parsed.elements)) {
          elements = parsed.elements;
        }
      } catch {
        // Not JSON, that's fine
      }

      return {
        success: true,
        output: stdout,
        durationMs,
        elements,
      };
    } catch (e: any) {
      return {
        success: false,
        output: `Error: ${e.message}`,
        durationMs: Math.round(performance.now() - start),
      };
    }
  }
}
