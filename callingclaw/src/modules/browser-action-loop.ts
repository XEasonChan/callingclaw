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

    if (!this.browser.connected) {
      this._running = false;
      this.emit("browser_loop.error", { error: "Browser not connected" });
      return { success: false, summary: "Browser not connected", steps, durationMs: 0 };
    }

    console.log(`[BrowserLoop] Starting: "${goal.slice(0, 80)}"`);
    this.emit("browser_loop.started", { goal, maxSteps, timeoutMs });

    let lastSnapshot = "";

    try {
      // Initial snapshot
      this.emit("browser_loop.snapshot", { phase: "initial" });
      lastSnapshot = await this.browser.snapshot();
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
        const action = await this.decideNextAction(goal, lastSnapshot, steps, opts.context);
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
    previousSteps: string[],
    extraContext?: string,
  ): Promise<BrowserAction> {
    const prompt = this.buildPrompt(goal, snapshot, previousSteps, extraContext);
    return await this.callModel(prompt);
  }

  private buildPrompt(
    goal: string,
    snapshot: string,
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

    return `You are a browser automation agent. You control a browser via an accessibility tree with @ref IDs.

## Goal
${goal}

${extraContext ? `## Context\n${extraContext}\n` : ""}
## Previous Steps
${stepsText}

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
1. Elements in the snapshot have [ref=eNNN] IDs. Use the bare ID (e.g. "e123") in the ref field — do NOT include @ prefix.
2. If you see a button or link that matches the goal, click it.
3. If the page shows a waiting/loading state, use "wait" and check again next turn.
4. If you see confirmation that the goal is achieved (e.g., you're in a meeting, the file is open, etc.), respond with "done".
5. If something went wrong and the goal can't be achieved (e.g., error message, access denied, dead end), respond with "fail".
6. Be precise — pick the exact ref from the snapshot. Don't guess refs that aren't shown.
7. When filling forms, look for the input field ref in the tree, not the label.
8. After clicking a button, the page may change — you'll see the new snapshot next turn.
9. IMPORTANT: If a dialog/popup is blocking (e.g. notification permission, cookie consent), ALWAYS dismiss it first with pressKey Escape, or click "Block", "Not now", "Dismiss" before attempting other actions. If clicking doesn't dismiss it, try pressKey Escape.
10. If clicking an element repeatedly (3+ times) doesn't produce any change, try a different approach: pressKey Escape, scroll, or try a different element.

Respond with JSON only (no markdown, no explanation outside JSON):
{"action":"<action_name>","ref":"<ref ID without @ prefix>","text":"<text or omit>","direction":"<up/down or omit>","reason":"<brief explanation>"}`;
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
