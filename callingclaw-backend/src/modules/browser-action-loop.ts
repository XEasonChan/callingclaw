// CallingClaw 2.0 — Browser Action Loop (Unified Browser Execution Layer)
//
// Replaces all hardcoded browser automation (osascript JS injection, fixed-wait flows)
// with a model-driven loop:
//
//   1. snapshot() → accessibility tree
//   2. Model analyzes snapshot + goal → decides next action
//   3. Execute action via PlaywrightCLIClient
//   4. snapshot() → model judges if goal is achieved
//   5. Repeat until done or timeout
//
// The model sees the accessibility tree (with @ref IDs) and picks from a small
// action set: click, type, pressKey, scroll, wait, navigate, done, fail.
// This gives full generalization — no hardcoded selectors or button text.

import { CONFIG } from "../config";
import type { PlaywrightCLIClient } from "../mcp_client/playwright-cli";
import type { EventBus } from "./event-bus";

// ── Types ──

export interface BrowserAction {
  action: "click" | "type" | "pressKey" | "scroll" | "wait" | "navigate" | "done" | "fail";
  ref?: string;         // @ref ID for click/type/hover
  text?: string;        // text for type, key for pressKey, url for navigate
  direction?: "up" | "down";
  reason: string;       // brief explanation of why this action
}

export interface BrowserActionResult {
  success: boolean;
  summary: string;
  steps: string[];
  durationMs: number;
  aborted?: boolean;
}

export interface BrowserLoopOptions {
  maxSteps?: number;      // default 15
  timeoutMs?: number;     // default 120_000 (2 min)
  context?: string;       // extra context for the model (e.g., meeting brief)
  onStep?: (step: string, snapshot: string) => void;  // progress callback
}

// ── Module ──

export class BrowserActionLoop {
  private browser: PlaywrightCLIClient;
  private eventBus?: EventBus;
  private _aborted = false;
  private _running = false;
  // Snapshot diff: track baseline for incremental updates
  private _baselineSnapshot = "";
  private _previousSnapshot = "";

  get running() { return this._running; }

  constructor(browser: PlaywrightCLIClient, eventBus?: EventBus) {
    this.browser = browser;
    this.eventBus = eventBus;
  }

  /** Abort the currently running loop */
  abort() {
    if (this._running) {
      this._aborted = true;
      this.eventBus?.emit("browser_loop.abort", {});
      console.log("[BrowserLoop] Abort requested");
    }
  }

  /**
   * Execute a high-level goal by driving the browser with model-guided actions.
   */
  async run(
    goal: string,
    opts: BrowserLoopOptions = {},
  ): Promise<BrowserActionResult> {
    const maxSteps = opts.maxSteps ?? 15;
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const steps: string[] = [];
    const start = performance.now();
    const deadline = start + timeoutMs;

    this._aborted = false;
    this._running = true;
    this._baselineSnapshot = "";
    this._previousSnapshot = "";

    if (!this.browser.connected) {
      this._running = false;
      this.emit("browser_loop.error", { error: "Browser not connected" });
      return { success: false, summary: "Browser not connected", steps, durationMs: 0 };
    }

    console.log(`[BrowserLoop] Starting: "${goal.slice(0, 80)}"`);
    this.emit("browser_loop.started", { goal, maxSteps, timeoutMs });

    let lastSnapshot = "";

    try {
      // Initial snapshot — becomes the baseline for subsequent diffs
      this.emit("browser_loop.snapshot", { phase: "initial" });
      lastSnapshot = await this.browser.snapshot();
      this._baselineSnapshot = lastSnapshot;
      this._previousSnapshot = lastSnapshot;
      this.emit("browser_loop.snapshot_done", {
        phase: "initial",
        length: lastSnapshot.length,
        preview: lastSnapshot.slice(0, 200),
      });

      for (let step = 0; step < maxSteps; step++) {
        // Check abort
        if (this._aborted) {
          steps.push("[Aborted] User cancelled");
          return this.result(false, "Aborted by user", steps, start, true);
        }

        if (performance.now() > deadline) {
          steps.push(`[Timeout] Exceeded ${timeoutMs}ms`);
          return this.result(false, "Timeout — goal not completed within time limit", steps, start);
        }

        // Call model
        this.emit("browser_loop.model_call", {
          step: step + 1,
          model: CONFIG.anthropic.apiKey ? "claude-haiku-4-5" : "openrouter/claude-haiku-4-5",
          snapshotLength: lastSnapshot.length,
        });

        const modelStart = performance.now();
        const action = await this.decideNextAction(goal, lastSnapshot, this._previousSnapshot, steps, opts.context);
        const modelMs = Math.round(performance.now() - modelStart);

        if (this._aborted) {
          steps.push("[Aborted] User cancelled");
          return this.result(false, "Aborted by user", steps, start, true);
        }

        this.emit("browser_loop.model_response", {
          step: step + 1,
          action: action.action,
          ref: action.ref,
          text: action.text,
          reason: action.reason,
          modelMs,
        });

        const stepDesc = `Step ${step + 1}: ${action.action}${action.ref ? ` @${action.ref}` : ""}${action.text ? ` "${action.text}"` : ""} — ${action.reason}`;
        steps.push(stepDesc);
        console.log(`[BrowserLoop] ${stepDesc}`);
        opts.onStep?.(stepDesc, lastSnapshot);

        this.emit("browser_loop.step", {
          step: step + 1,
          action: action.action,
          ref: action.ref,
          text: action.text,
          reason: action.reason,
        });

        // Terminal actions
        if (action.action === "done") {
          return this.result(true, action.reason, steps, start);
        }
        if (action.action === "fail") {
          return this.result(false, action.reason, steps, start);
        }

        // Execute action
        this.emit("browser_loop.executing", {
          step: step + 1,
          action: action.action,
          ref: action.ref,
          text: action.text,
        });

        const execStart = performance.now();
        this._previousSnapshot = lastSnapshot; // track for diff
        lastSnapshot = await this.executeAction(action);
        const execMs = Math.round(performance.now() - execStart);

        this.emit("browser_loop.executed", {
          step: step + 1,
          action: action.action,
          execMs,
          snapshotLength: lastSnapshot.length,
          snapshotPreview: lastSnapshot.slice(0, 200),
        });

        // Small pause to let page update
        await this.wait(500);
      }

      // Max steps exhausted
      steps.push(`[Max steps] Reached limit of ${maxSteps}`);
      return this.result(false, "Max steps reached without completing goal", steps, start);

    } catch (err: any) {
      steps.push(`[Error] ${err.message}`);
      this.emit("browser_loop.error", { error: err.message });
      return this.result(false, `Error: ${err.message}`, steps, start);
    } finally {
      this._running = false;
      const durationMs = Math.round(performance.now() - start);
      this.emit("browser_loop.done", {
        goal,
        steps,
        durationMs,
        success: steps.length > 0 && !steps[steps.length - 1].includes("[Error]"),
        aborted: this._aborted,
      });
    }
  }

  // ── Model Decision ──

  private async decideNextAction(
    goal: string,
    snapshot: string,
    previousSnapshot: string,
    previousSteps: string[],
    extraContext?: string,
  ): Promise<BrowserAction> {
    const prompt = this.buildPrompt(goal, snapshot, previousSnapshot, previousSteps, extraContext);
    return await this.callModel(prompt);
  }

  /**
   * Build the model prompt with snapshot diff support.
   *
   * On step 1: sends the full snapshot (baseline).
   * On step 2+: sends the FULL current snapshot + a compact diff showing what changed.
   * The diff helps Haiku focus on what's new without reading the entire tree again.
   */
  private buildPrompt(
    goal: string,
    snapshot: string,
    previousSnapshot: string,
    previousSteps: string[],
    extraContext?: string,
  ): string {
    const stepsText = previousSteps.length > 0
      ? previousSteps.slice(-8).join("\n")
      : "(none yet)";

    // Truncate snapshot if too long (keep first 6000 chars)
    const snap = snapshot.length > 6000
      ? snapshot.slice(0, 6000) + "\n... (truncated)"
      : snapshot;

    // Compute diff if we have a previous snapshot (step 2+)
    let diffSection = "";
    if (previousSnapshot && previousSnapshot !== snapshot && previousSteps.length > 0) {
      const diff = this.computeSnapshotDiff(previousSnapshot, snapshot);
      if (diff) {
        diffSection = `\n## What Changed (since last action)\n${diff}\n`;
      }
    }

    return `You are a browser automation agent. You control a browser via an accessibility tree with @ref IDs.

## Goal
${goal}

${extraContext ? `## Context\n${extraContext}\n` : ""}
## Previous Steps
${stepsText}
${diffSection}
## Current Page (Accessibility Tree)
${snap}

## Available Actions
- click: Click an element. Params: { "ref": "e123" }
- type: Clear field and type text. Params: { "ref": "e123", "text": "hello" }
- pressKey: Press a key. Params: { "text": "Enter" | "Tab" | "Escape" | "ArrowDown" | ... }
- scroll: Scroll page. Params: { "direction": "up" | "down" }
- wait: Wait for page to update (use when expecting async content). Params: {}
- navigate: Go to a URL. Params: { "text": "https://..." }
- done: Goal is achieved. Params: { "reason": "why you believe goal is complete" }
- fail: Goal cannot be achieved. Params: { "reason": "what went wrong" }

## Rules
1. Elements have @eNNN refs. Use bare ID (e.g. "e123") — no @ prefix.
2. Check "What Changed" first — it shows what's new since your last action.
3. If page is loading/waiting, use "wait". If goal is confirmed, use "done". If stuck, use "fail".
4. Be precise — pick exact refs from the snapshot. Don't guess.
5. Dismiss blocking dialogs first (pressKey Escape, or click "Block"/"Dismiss").
6. If 3+ clicks on same element → try different approach.

Respond with JSON only:
{"action":"...","ref":"...","text":"...","direction":"...","reason":"..."}`;
  }

  /**
   * Compute a compact line-level diff between two accessibility tree snapshots.
   * Returns only added (+) and removed (-) lines, capped at 30 lines.
   * Returns null if snapshots are identical or diff is empty.
   */
  private computeSnapshotDiff(prev: string, curr: string): string | null {
    const prevLines = prev.split("\n");
    const currLines = curr.split("\n");

    // Quick check: if identical, no diff
    if (prev === curr) return null;

    // Set-based diff: find added and removed lines
    const prevSet = new Set(prevLines.map(l => l.trim()).filter(Boolean));
    const currSet = new Set(currLines.map(l => l.trim()).filter(Boolean));

    const added: string[] = [];
    const removed: string[] = [];

    for (const line of currSet) {
      if (!prevSet.has(line)) added.push(`+ ${line}`);
    }
    for (const line of prevSet) {
      if (!currSet.has(line)) removed.push(`- ${line}`);
    }

    if (added.length === 0 && removed.length === 0) return null;

    // Cap output to prevent token explosion
    const maxLines = 30;
    const diffLines: string[] = [];
    for (const r of removed.slice(0, maxLines / 2)) diffLines.push(r);
    for (const a of added.slice(0, maxLines / 2)) diffLines.push(a);

    if (removed.length + added.length > maxLines) {
      diffLines.push(`... (${removed.length} removed, ${added.length} added total)`);
    }

    return diffLines.join("\n");
  }

  // ── LLM API Call (reuses TranscriptAuditor's pattern) ──

  private async callModel(prompt: string): Promise<BrowserAction> {
    const FALLBACK: BrowserAction = { action: "fail", reason: "no_api_key" };

    if (CONFIG.anthropic.apiKey) {
      return this.callAnthropicDirect(prompt);
    } else if (CONFIG.openrouter.apiKey) {
      return this.callOpenRouter(prompt);
    }

    console.warn("[BrowserLoop] No API key (need ANTHROPIC_API_KEY or OPENROUTER_API_KEY)");
    return FALLBACK;
  }

  private async callAnthropicDirect(prompt: string): Promise<BrowserAction> {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CONFIG.anthropic.apiKey,
        "anthropic-version": "2024-01-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 256,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!resp.ok) {
      throw new Error(`Anthropic API ${resp.status}: ${await resp.text()}`);
    }

    const data = (await resp.json()) as any;
    return this.parseAction(data.content?.[0]?.text || "{}");
  }

  private async callOpenRouter(prompt: string): Promise<BrowserAction> {
    const resp = await fetch(`${CONFIG.openrouter.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CONFIG.openrouter.apiKey}`,
      },
      body: JSON.stringify({
        model: "anthropic/claude-haiku-4-5",
        max_tokens: 256,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!resp.ok) {
      throw new Error(`OpenRouter API ${resp.status}: ${await resp.text()}`);
    }

    const data = (await resp.json()) as any;
    return this.parseAction(data.choices?.[0]?.message?.content || "{}");
  }

  private parseAction(text: string): BrowserAction {
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { action: "fail", reason: "parse_error: no JSON found in model response" };
      }
      const parsed = JSON.parse(jsonMatch[0]);

      // Validate action
      const validActions = ["click", "type", "pressKey", "scroll", "wait", "navigate", "done", "fail"];
      if (!validActions.includes(parsed.action)) {
        return { action: "fail", reason: `invalid action: ${parsed.action}` };
      }

      // Normalize ref — strip any leading @ (client adds it)
      let ref = parsed.ref;
      if (typeof ref === "string") {
        ref = ref.replace(/^@+/, "");
        if (!ref) ref = undefined;
      }

      return {
        action: parsed.action,
        ref,
        text: parsed.text,
        direction: parsed.direction,
        reason: parsed.reason || "",
      };
    } catch {
      return { action: "fail", reason: "json_parse_error" };
    }
  }

  // ── Action Execution via PlaywrightCLIClient ──

  private async executeAction(action: BrowserAction): Promise<string> {
    switch (action.action) {
      case "click": {
        if (!action.ref) throw new Error("click requires a @ref");
        return this.browser.click(action.ref);
      }
      case "type": {
        if (!action.ref || !action.text) throw new Error("type requires @ref and text");
        return this.browser.type(action.ref, action.text);
      }
      case "pressKey": {
        if (!action.text) throw new Error("pressKey requires text (key name)");
        await this.browser.pressKey(action.text);
        return this.browser.snapshot();
      }
      case "scroll": {
        return this.browser.scroll(action.direction || "down", 3);
      }
      case "wait": {
        await this.wait(2000);
        return this.browser.snapshot();
      }
      case "navigate": {
        if (!action.text) throw new Error("navigate requires text (URL)");
        await this.browser.navigate(action.text);
        await this.wait(2000); // let page load
        return this.browser.snapshot();
      }
      default:
        return this.browser.snapshot();
    }
  }

  // ── Helpers ──

  private emit(event: string, data: any) {
    this.eventBus?.emit(event, data);
  }

  private result(
    success: boolean,
    summary: string,
    steps: string[],
    start: number,
    aborted = false,
  ): BrowserActionResult {
    const durationMs = Math.round(performance.now() - start);
    console.log(`[BrowserLoop] ${aborted ? "Aborted" : success ? "Done" : "Failed"}: ${summary} (${durationMs}ms, ${steps.length} steps)`);
    return { success, summary, steps, durationMs, aborted };
  }

  private wait(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
