// CallingClaw 2.0 — Module 4: Computer Use (Claude Computer Use)
// Handles: reading transcript + screenshot → identifying click intent → coordinates → Python
// Consumes: SharedContext (transcript + screen)
// Produces: PyAutoGUI actions via Bridge
//
// Supports two modes:
//   1. Direct Anthropic API (preferred — full beta support)
//   2. OpenRouter gateway (uses raw HTTP with x-anthropic-beta header passthrough)

import Anthropic from "@anthropic-ai/sdk";
import type { PythonBridge } from "../bridge";
import type { SharedContext } from "./shared-context";
import type { EventBus } from "./event-bus";
import type { ContextSync } from "./context-sync";
import { CONFIG } from "../config";
import { OpenClawBridge } from "../openclaw_bridge";

// ── Screenshot dimensions for API ──
// Full 1920x1080 PNG ~3-5MB base64 ~500k+ tokens per image.
// Anthropic recommends max 1280x800 for computer use.
// We use sips (macOS) to resize screenshots before sending to the API.
const API_SCREEN_WIDTH = 1280;
const API_SCREEN_HEIGHT = 800;

// ── Model → Tool Version mapping ──
// Opus 4.6, Sonnet 4.6, Opus 4.5 → computer_20251124 + computer-use-2025-11-24
// Sonnet 4.5, Haiku 4.5, older     → computer_20250124 + computer-use-2025-01-24
const LATEST_MODELS = [
  "claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-4-5",
  "anthropic/claude-opus-4-6", "anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-5",
  "anthropic/claude-opus-4.6", "anthropic/claude-sonnet-4.6", "anthropic/claude-opus-4.5",
];

function getToolVersionForModel(model: string): { toolType: string; betaFlag: string } {
  const isLatest = LATEST_MODELS.some((m) => model.includes(m.replace("anthropic/", "")));
  return isLatest
    ? { toolType: "computer_20251124", betaFlag: "computer-use-2025-11-24" }
    : { toolType: "computer_20250124", betaFlag: "computer-use-2025-01-24" };
}

export interface ComputerUseAction {
  action: string;
  coordinate?: [number, number];
  text?: string;
  scroll_direction?: string;
  scroll_amount?: number;
  region?: [number, number, number, number]; // zoom: [x1, y1, x2, y2]
}

export class ComputerUseModule {
  private client: Anthropic | null = null;
  private bridge: PythonBridge;
  private context: SharedContext;
  private _running = false;
  private _mode: "anthropic" | "openrouter" | "none" = "none";
  private openclaw: OpenClawBridge;
  private eventBus?: EventBus;
  private _contextSync?: ContextSync;

  /** Inject ContextSync for shared memory/pinned file access */
  set contextSync(cs: ContextSync) { this._contextSync = cs; }

  constructor(bridge: PythonBridge, context: SharedContext, eventBus?: EventBus) {
    this.bridge = bridge;
    this.context = context;
    this.eventBus = eventBus;
    this.openclaw = new OpenClawBridge();

    // Prefer direct Anthropic API (full beta support).
    // OpenRouter fallback uses raw HTTP with x-anthropic-beta header passthrough.
    if (CONFIG.anthropic.apiKey) {
      this.client = new Anthropic({ apiKey: CONFIG.anthropic.apiKey });
      this._mode = "anthropic";
      console.log("[ComputerUse] Using direct Anthropic API");
    } else if (CONFIG.openrouter.apiKey) {
      this._mode = "openrouter";
      console.log("[ComputerUse] Using OpenRouter gateway (raw HTTP with beta header passthrough)");
    } else {
      this._mode = "none";
      console.warn("[ComputerUse] No API key configured (set ANTHROPIC_API_KEY or OPENROUTER_API_KEY)");
    }

    // Forward OpenClaw activity events to EventBus
    this.openclaw.onActivity((kind, summary, detail) => {
      this.emitActivity(kind, summary, detail);
    });

    // Connect to OpenClaw in background (non-blocking)
    this.openclaw.connect().then(() => {
      console.log("[ComputerUse] OpenClaw bridge connected — delegated tools available");
    }).catch(() => {
      console.warn("[ComputerUse] OpenClaw not available (optional — will retry on demand)");
    });
  }

  /** Emit a real-time activity event to the EventBus for the UI feed */
  private emitActivity(type: string, summary: string, detail?: string) {
    this.eventBus?.emit(type, { summary, detail: detail || undefined });
  }

  get isConfigured(): boolean {
    return this._mode !== "none";
  }

  get openclawConnected(): boolean {
    return this.openclaw.connected;
  }

  // ══════════════════════════════════════════════════════════════
  // OpenRouter: raw HTTP call with Anthropic-format body + beta header
  // OpenRouter passes x-anthropic-beta through to Anthropic's backend
  // ══════════════════════════════════════════════════════════════
  private async callOpenRouter(body: Record<string, any>, betaFlag: string): Promise<any> {
    const url = `${CONFIG.openrouter.baseUrl}/chat/completions`;

    // Convert Anthropic-format tools & messages to OpenAI-compatible format
    // OpenRouter normalizes to OpenAI chat/completions schema
    const openaiBody = this.convertToOpenAIFormat(body);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${CONFIG.openrouter.apiKey}`,
        "HTTP-Referer": "https://github.com/anthropics/callingclaw",
        "X-Title": "CallingClaw Local Agent",
        "x-anthropic-beta": betaFlag,
      },
      body: JSON.stringify(openaiBody),
    });

    if (!res.ok) {
      const text = await res.text();
      if (text.includes("<!doctype") || text.includes("<!DOCTYPE")) {
        throw new Error(`OpenRouter returned HTML (${res.status}). The endpoint may not support this request format. Try setting ANTHROPIC_API_KEY for direct API access.`);
      }
      throw new Error(`OpenRouter API error ${res.status}: ${text.slice(0, 500)}`);
    }

    const data = await res.json();
    return this.convertFromOpenAIFormat(data);
  }

  /**
   * Convert Anthropic messages format to OpenAI chat/completions format.
   * OpenRouter accepts OpenAI format and routes to Anthropic backend.
   */
  private convertToOpenAIFormat(anthropicBody: Record<string, any>): Record<string, any> {
    const messages: any[] = [];

    // System prompt → system message
    if (anthropicBody.system) {
      messages.push({ role: "system", content: anthropicBody.system });
    }

    // Convert Anthropic messages to OpenAI format
    for (const msg of anthropicBody.messages || []) {
      if (msg.role === "user" && Array.isArray(msg.content)) {
        const parts: any[] = [];
        for (const block of msg.content) {
          if (block.type === "text") {
            parts.push({ type: "text", text: block.text });
          } else if (block.type === "image") {
            parts.push({
              type: "image_url",
              image_url: {
                url: `data:${block.source.media_type};base64,${block.source.data}`,
              },
            });
          } else if (block.type === "tool_result") {
            // Tool results need to be separate messages in OpenAI format
            messages.push({
              role: "tool",
              tool_call_id: block.tool_use_id,
              content: typeof block.content === "string"
                ? block.content
                : JSON.stringify(block.content),
            });
            continue;
          }
        }
        if (parts.length > 0) {
          messages.push({ role: "user", content: parts });
        }
      } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
        // Assistant message with potential tool_use blocks
        const textParts = msg.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
        const toolCalls = msg.content.filter((b: any) => b.type === "tool_use").map((b: any) => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        }));

        const assistantMsg: any = { role: "assistant" };
        if (textParts) assistantMsg.content = textParts;
        if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
        messages.push(assistantMsg);
      } else {
        messages.push(msg);
      }
    }

    // Convert Anthropic tools to OpenAI function tools
    const tools = (anthropicBody.tools || []).map((t: any) => {
      if (t.type?.startsWith("computer_")) {
        return {
          type: "function",
          function: {
            name: "computer",
            description: "Computer use tool for screen interaction. Actions: screenshot, left_click, right_click, double_click, middle_click, type, key, scroll, mouse_move, wait",
            parameters: {
              type: "object",
              properties: {
                action: { type: "string", enum: ["screenshot", "left_click", "right_click", "double_click", "middle_click", "type", "key", "scroll", "mouse_move", "left_click_drag", "wait"] },
                coordinate: { type: "array", items: { type: "number" }, description: "[x, y] pixel coordinates" },
                text: { type: "string", description: "Text to type or key to press" },
                scroll_direction: { type: "string", enum: ["up", "down", "left", "right"] },
                scroll_amount: { type: "number" },
              },
              required: ["action"],
            },
          },
        };
      }
      if (t.type?.startsWith("bash_")) {
        return {
          type: "function",
          function: {
            name: "bash",
            description: "Run a shell command on macOS. Use to launch apps (open -a), run scripts, install tools, or any terminal operation.",
            parameters: {
              type: "object",
              properties: {
                command: { type: "string", description: "The shell command to execute" },
                restart: { type: "boolean", description: "Restart the bash session" },
              },
            },
          },
        };
      }
      if (t.type === "custom" && t.name === "openclaw") {
        return {
          type: "function",
          function: {
            name: "openclaw",
            description: t.description,
            parameters: t.input_schema,
          },
        };
      }
      return t;
    });

    return {
      model: anthropicBody.model,
      max_tokens: anthropicBody.max_tokens,
      messages,
      tools,
    };
  }

  /**
   * Convert OpenAI chat/completions response back to Anthropic format
   */
  private convertFromOpenAIFormat(data: any): any {
    const choice = data.choices?.[0];
    if (!choice) throw new Error("No response choices from OpenRouter");

    const content: any[] = [];
    const msg = choice.message;

    if (msg.content) {
      content.push({ type: "text", text: msg.content });
    }

    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments),
        });
      }
    }

    return {
      content,
      stop_reason: msg.tool_calls?.length ? "tool_use" : "end_turn",
    };
  }

  // ══════════════════════════════════════════════════════════════
  // Main execute loop
  // ══════════════════════════════════════════════════════════════

  async execute(instruction: string, maxSteps = 15): Promise<{
    summary: string;
    steps: string[];
  }> {
    if (!this.isConfigured) {
      return { summary: "No API key configured", steps: [] };
    }

    this._running = true;
    const steps: string[] = [];
    const recentTranscript = this.context.getTranscriptText(15);

    const model = this._mode === "openrouter"
      ? CONFIG.openrouter.model
      : CONFIG.anthropic.model;

    const { toolType, betaFlag } = getToolVersionForModel(model);

    const computerTool: Record<string, any> = {
      type: toolType,
      name: "computer",
      display_width_px: API_SCREEN_WIDTH,
      display_height_px: API_SCREEN_HEIGHT,
      display_number: 1,
    };

    // computer_20251124 (Opus 4.6, Sonnet 4.6, Opus 4.5) supports zoom action
    if (toolType === "computer_20251124") {
      computerTool.enable_zoom = true;
    }

    // Bash tool — Anthropic built-in, schema-less. Claude natively knows how to use it.
    const bashTool: Record<string, any> = {
      type: "bash_20250124",
      name: "bash",
    };

    // OpenClaw tool — delegates complex tasks to the local OpenClaw agent
    // OpenClaw has its own tools (text_editor, browser, calendar, messaging, etc.)
    const openclawTool: Record<string, any> = {
      type: "custom",
      name: "openclaw",
      description:
        "Delegate a task to the OpenClaw agent running locally. OpenClaw has its own powerful tool " +
        "ecosystem including: text editor (precise file editing), browser automation, calendar management, " +
        "messaging (WhatsApp, Telegram, Slack), and cron scheduling. Use this for tasks that are better " +
        "handled by structured tools rather than raw bash commands — especially file editing, web research, " +
        "and multi-step automation workflows. OpenClaw will execute the task and return the result.",
      input_schema: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "Natural language description of the task for OpenClaw to execute",
          },
        },
        required: ["task"],
      },
    };

    // Build tools array — always include computer + bash, add openclaw if available
    const tools: Record<string, any>[] = [computerTool, bashTool];
    if (this.openclaw.connected) {
      tools.push(openclawTool);
    }

    console.log(`[ComputerUse] Mode: ${this._mode}, Model: ${model}, Tool: ${toolType}, Beta: ${betaFlag}, OpenClaw: ${this.openclaw.connected ? "yes" : "no"}`);

    // Compress initial screenshot if available
    let initialImage: string | null = null;
    if (this.context.screen.latestScreenshot) {
      initialImage = await this.compressScreenshot(this.context.screen.latestScreenshot);
    }

    // Build initial message with context
    const messages: any[] = [
      {
        role: "user",
        content: [
          ...(initialImage
            ? [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/jpeg",
                    data: initialImage,
                  },
                },
              ]
            : []),
          {
            type: "text",
            text: `Task: ${instruction}

Recent conversation context (so you understand what's happening):
${recentTranscript || "(no conversation yet)"}

${this.context.screen.description ? `Screen description: ${this.context.screen.description}` : ""}`,
          },
        ],
      },
    ];

    const openclawHint = this.openclaw.connected
      ? "\n3. `openclaw` — delegate complex tasks to the OpenClaw agent (file editing, browser automation, messaging, scheduling).\n" +
        "   Use openclaw for: precise file editing, web research, sending messages, calendar operations.\n" +
        "   Use bash for: quick commands, launching apps, simple file operations.\n" +
        "   Use computer for: visual interaction, clicking, typing in GUI apps.\n"
      : "";

    // Build shared context brief from ContextSync (OpenClaw memory + pinned files)
    const contextBrief = this._contextSync?.getBrief().computer || "";
    const contextBlock = contextBrief
      ? `\n\n--- SHARED CONTEXT (from OpenClaw memory & pinned files) ---\n${contextBrief}\n--- END SHARED CONTEXT ---\n`
      : "";

    const systemPrompt =
      "You are CallingClaw's computer control module running on macOS. You have these tools:\n" +
      "1. `computer` — take screenshots, click, type, scroll, drag on the screen.\n" +
      "2. `bash` — run shell commands directly on macOS.\n" +
      openclawHint + "\n" +
      "To launch applications that are NOT visible on screen, use bash:\n" +
      '  open -a "Microsoft Edge"   (launch any macOS app by name)\n' +
      '  open "https://meet.google.com/xxx"   (open URL in default browser)\n' +
      '  open -a "Google Chrome" "https://..."   (open URL in specific browser)\n\n' +
      "After launching an app with bash, take a screenshot to verify it appeared.\n" +
      "Use the conversation transcript to understand what the user or meeting participants are discussing. " +
      "Be precise with coordinates when clicking. Take screenshots to verify your actions." +
      contextBlock;

    this.emitActivity("ai.step", `Starting: "${instruction.slice(0, 60)}"`);

    for (let step = 0; step < maxSteps && this._running; step++) {
      console.log(`[ComputerUse] Step ${step + 1}...`);
      this.emitActivity("ai.step", `Step ${step + 1}/${maxSteps}`);

      // Prune old images from conversation to prevent token explosion
      this.pruneOldImages(messages);

      let response: any;
      try {
        if (this._mode === "anthropic") {
          // Direct Anthropic API — streaming for real-time activity feed
          const stream = this.client!.beta.messages.stream({
            model,
            max_tokens: 4096,
            tools: tools as any,
            messages,
            betas: [betaFlag],
            system: systemPrompt,
          });

          // Emit activity events for each content block as it completes
          stream.on("contentBlock", (block: any) => {
            if (block.type === "thinking") {
              this.emitActivity("ai.thinking", (block.thinking || "Reasoning...").slice(0, 80), block.thinking);
            } else if (block.type === "text" && block.text) {
              this.emitActivity("ai.text", block.text.slice(0, 80), block.text);
            } else if (block.type === "tool_use") {
              const params = JSON.stringify(block.input || {}).slice(0, 80);
              this.emitActivity("ai.tool_call", `${block.name} → ${params}`, JSON.stringify(block.input, null, 2));
            }
          });

          response = await stream.finalMessage();
        } else {
          // OpenRouter — raw HTTP with OpenAI format + beta header passthrough
          response = await this.callOpenRouter({
            model,
            max_tokens: 4096,
            tools,
            messages,
            system: systemPrompt,
          }, betaFlag);

          // Emit content events for non-streaming mode
          for (const block of (response.content || [])) {
            if (block.type === "text" && block.text) {
              this.emitActivity("ai.text", block.text.slice(0, 80), block.text);
            } else if (block.type === "tool_use") {
              const params = JSON.stringify(block.input || {}).slice(0, 80);
              this.emitActivity("ai.tool_call", `${block.name} → ${params}`, JSON.stringify(block.input, null, 2));
            }
          }
        }
      } catch (e: any) {
        const msg = e.message || String(e);
        console.error(`[ComputerUse] API call failed:`, msg);
        return { summary: `API error: ${msg}`, steps };
      }

      // Log what Claude returned
      const contentTypes = response.content.map((b: any) => b.type).join(", ");
      console.log(`[ComputerUse] Response: stop_reason=${response.stop_reason}, content=[${contentTypes}]`);

      // Append assistant response
      messages.push({ role: "assistant", content: response.content });

      // Done?
      if (response.stop_reason === "end_turn") {
        const text = response.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("\n");
        steps.push(`[Done] ${text}`);

        // Record in context
        this.context.addTranscript({
          role: "system",
          text: `[ComputerUse] Completed: ${text.slice(0, 100)}`,
          ts: Date.now(),
        });

        return { summary: text, steps };
      }

      // Process tool_use blocks
      const toolResults: any[] = [];

      for (const block of response.content) {
        if (block.type !== "tool_use") continue;

        // ── Bash tool ──
        if (block.name === "bash") {
          const cmd = block.input?.command as string;
          const restart = block.input?.restart as boolean;

          if (restart) {
            steps.push(`Step ${step + 1}: bash restart`);
            console.log(`[ComputerUse] Bash: restart session`);
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: "Bash session restarted.",
            });
            continue;
          }

          const stepDesc = `Step ${step + 1}: bash "${cmd?.slice(0, 60)}"`;
          steps.push(stepDesc);
          console.log(`[ComputerUse] ${stepDesc}`);

          // Execute command via Bun shell with timeout
          let output = "";
          try {
            const result = await Promise.race([
              Bun.$`bash -c ${cmd}`.quiet().nothrow(),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("Command timeout (30s)")), 30000)
              ),
            ]);
            const stdout = (result as any).stdout?.toString?.() || "";
            const stderr = (result as any).stderr?.toString?.() || "";
            const exitCode = (result as any).exitCode ?? 0;
            output = stdout + (stderr ? `\nSTDERR: ${stderr}` : "");
            if (exitCode !== 0) output += `\nExit code: ${exitCode}`;
            // Cap output to avoid token explosion
            if (output.length > 10000) output = output.slice(0, 10000) + "\n...(truncated)";
          } catch (e: any) {
            output = `Error: ${e.message}`;
          }

          console.log(`[ComputerUse] Bash output: ${output.slice(0, 200)}`);
          this.emitActivity("ai.bash", `$ ${cmd?.slice(0, 60)}`, `$ ${cmd}\n\n${output}`);

          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: output || "(no output)",
          });
          continue;
        }

        // ── OpenClaw tool ──
        if (block.name === "openclaw") {
          const task = block.input?.task as string;
          const stepDesc = `Step ${step + 1}: openclaw "${task?.slice(0, 60)}"`;
          steps.push(stepDesc);
          console.log(`[ComputerUse] ${stepDesc}`);
          this.emitActivity("ai.openclaw", `Task: ${task?.slice(0, 60)}`);

          // OC-008: Computer Use Task Delegation
          const result = await this.openclaw.sendTask(task);
          console.log(`[ComputerUse] OpenClaw result (OC-008): ${result.slice(0, 200)}`);

          // Cap output to prevent token explosion (per OC-008 spec: 10K limit)
          const capped = result.length > 10000
            ? result.slice(0, 10000) + "\n...(truncated)"
            : result;

          this.emitActivity("ai.openclaw", `Done: ${task?.slice(0, 40)}`, `Task: ${task}\n\nResult:\n${capped}`);

          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: capped || "(no output)",
          });
          continue;
        }

        // ── Computer tool ──
        const input = block.input as ComputerUseAction;
        const stepDesc = `Step ${step + 1}: ${input.action}${
          input.coordinate ? ` at (${input.coordinate.join(",")})` : ""
        }${input.text ? ` "${input.text.slice(0, 30)}"` : ""}`;
        steps.push(stepDesc);
        console.log(`[ComputerUse] ${stepDesc}`);
        this.emitActivity("ai.computer", stepDesc.replace(/^Step \d+: /, ""), `Action: ${input.action}${input.coordinate ? `\nCoordinates: (${input.coordinate.join(", ")})` : ""}${input.text ? `\nText: "${input.text}"` : ""}`);

        // Execute and capture screenshot
        const screenshotBase64 = await this.executeAction(input);
        console.log(`[ComputerUse] Action result: ${screenshotBase64 ? `screenshot ${Math.round(screenshotBase64.length * 0.75 / 1024)}KB` : "no screenshot"}`);

        if (screenshotBase64) {
          // Update shared context with full-res screenshot
          this.context.updateScreen(screenshotBase64);

          // Compress for API to avoid token explosion
          const compressed = await this.compressScreenshot(screenshotBase64);

          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/jpeg",
                  data: compressed,
                },
              },
            ],
          });
        } else {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: "Action executed.",
          });
        }
      }

      messages.push({ role: "user", content: toolResults });
    }

    this._running = false;
    return { summary: "Max steps reached", steps };
  }

  /**
   * Cancel a running computer use task
   */
  cancel() {
    this._running = false;
  }

  /**
   * Scale coordinates from API space (1280x800) to real screen space.
   * Claude returns coordinates based on display_width_px/display_height_px,
   * but the real screen may be larger (1920x1080).
   */
  private scaleCoord(coord: [number, number] | undefined): { x: number; y: number } | undefined {
    if (!coord) return undefined;
    const scaleX = CONFIG.screen.width / API_SCREEN_WIDTH;
    const scaleY = CONFIG.screen.height / API_SCREEN_HEIGHT;
    return {
      x: Math.round(coord[0] * scaleX),
      y: Math.round(coord[1] * scaleY),
    };
  }

  /**
   * Execute a single action via Python bridge, return screenshot if applicable.
   * Coordinates from Claude are in API space (1280x800) and get scaled to real screen.
   */
  private async executeAction(action: ComputerUseAction): Promise<string | null> {
    const scaled = this.scaleCoord(action.coordinate);

    switch (action.action) {
      case "screenshot":
        return this.requestScreenshot();

      case "left_click":
      case "right_click":
      case "double_click":
      case "middle_click":
        this.bridge.sendAction("click", {
          button: action.action.replace("_click", ""),
          x: scaled?.x,
          y: scaled?.y,
        });
        await this.wait(300);
        return this.requestScreenshot();

      case "type":
        this.bridge.sendAction("type", { text: action.text });
        await this.wait(150);
        return null;

      case "key":
        this.bridge.sendAction("key", { key: action.text });
        await this.wait(150);
        return null;

      case "scroll":
        this.bridge.sendAction("scroll", {
          x: scaled?.x,
          y: scaled?.y,
          direction: action.scroll_direction || "down",
          amount: action.scroll_amount || 3,
        });
        await this.wait(300);
        return this.requestScreenshot();

      case "mouse_move":
        this.bridge.sendAction("mouse_move", {
          x: scaled?.x,
          y: scaled?.y,
        });
        return null;

      case "left_click_drag":
        this.bridge.sendAction("drag", {
          startX: scaled?.x,
          startY: scaled?.y,
        });
        await this.wait(300);
        return this.requestScreenshot();

      case "zoom": {
        // Zoom captures a region of the screen at full resolution
        // Take a full screenshot, then crop the region using sips
        const fullShot = await this.requestScreenshot();
        if (!fullShot || !action.region) return fullShot;

        const [x1, y1, x2, y2] = action.region;
        // Scale region coords from API space to real screen
        const scaleX = CONFIG.screen.width / API_SCREEN_WIDTH;
        const scaleY = CONFIG.screen.height / API_SCREEN_HEIGHT;
        const cropX = Math.round(x1 * scaleX);
        const cropY = Math.round(y1 * scaleY);
        const cropW = Math.round((x2 - x1) * scaleX);
        const cropH = Math.round((y2 - y1) * scaleY);

        try {
          const tmpDir = "/tmp/callingclaw_screenshots";
          const id = Date.now().toString(36);
          const srcPath = `${tmpDir}/${id}_zoom_src.png`;
          const dstPath = `${tmpDir}/${id}_zoom.jpg`;

          await Bun.write(srcPath, Buffer.from(fullShot, "base64"));
          await Bun.$`sips --cropToHeightWidth ${cropH} ${cropW} --cropOffset ${cropY} ${cropX} --setProperty format jpeg --setProperty formatOptions 80 ${srcPath} --out ${dstPath}`.quiet();

          const cropped = Buffer.from(await Bun.file(dstPath).arrayBuffer()).toString("base64");
          Bun.$`rm -f ${srcPath} ${dstPath}`.quiet().catch(() => {});
          return cropped;
        } catch (e: any) {
          console.warn(`[ComputerUse] Zoom crop failed:`, e.message);
          return fullShot;
        }
      }

      case "wait":
        await this.wait(1000);
        return null;

      default:
        console.warn(`[ComputerUse] Unknown action: ${action.action}`);
        return null;
    }
  }

  private requestScreenshot(): Promise<string | null> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.warn("[ComputerUse] Screenshot timeout (5s) — Python sidecar may not be responding");
        resolve(null);
      }, 5000);

      // Use once() to avoid accumulating permanent listeners
      this.bridge.once("screenshot", (msg) => {
        clearTimeout(timeout);
        const img = msg.payload?.image;
        if (img) {
          console.log(`[ComputerUse] Screenshot received: ${Math.round(img.length * 0.75 / 1024)}KB`);
        } else {
          console.warn("[ComputerUse] Screenshot received but payload.image is empty");
        }
        resolve(img || null);
      });

      const sent = this.bridge.sendAction("screenshot", {});
      if (!sent) {
        clearTimeout(timeout);
        console.error("[ComputerUse] Failed to send screenshot request — bridge not connected");
        resolve(null);
      }
    });
  }

  /**
   * Resize and compress a base64 PNG screenshot to JPEG at API_SCREEN dimensions.
   * Uses macOS sips + temporary files. Reduces ~4MB PNG to ~100-200KB JPEG.
   */
  private async compressScreenshot(base64Png: string): Promise<string> {
    const tmpDir = "/tmp/callingclaw_screenshots";
    await Bun.$`mkdir -p ${tmpDir}`.quiet();

    const id = Date.now().toString(36);
    const pngPath = `${tmpDir}/${id}.png`;
    const jpegPath = `${tmpDir}/${id}.jpg`;

    try {
      // Write base64 PNG to file
      const buffer = Buffer.from(base64Png, "base64");
      await Bun.write(pngPath, buffer);

      // Resize with sips (macOS built-in) and convert to JPEG
      await Bun.$`sips --resampleWidth ${API_SCREEN_WIDTH} --setProperty format jpeg --setProperty formatOptions 60 ${pngPath} --out ${jpegPath}`.quiet();

      // Read back as base64
      const jpegFile = Bun.file(jpegPath);
      const jpegBuffer = await jpegFile.arrayBuffer();
      const jpegBase64 = Buffer.from(jpegBuffer).toString("base64");

      const originalKB = Math.round(base64Png.length * 0.75 / 1024);
      const compressedKB = Math.round(jpegBase64.length * 0.75 / 1024);
      console.log(`[ComputerUse] Screenshot: ${originalKB}KB PNG → ${compressedKB}KB JPEG (${Math.round(compressedKB/originalKB*100)}%)`);

      return jpegBase64;
    } catch (e: any) {
      console.warn(`[ComputerUse] Screenshot compression failed, using original:`, e.message);
      return base64Png;
    } finally {
      // Cleanup temp files
      Bun.$`rm -f ${pngPath} ${jpegPath}`.quiet().catch(() => {});
    }
  }

  /**
   * Strip old base64 images from conversation history to prevent token accumulation.
   * Only keeps images in the most recent user message (tool_result or initial).
   */
  private pruneOldImages(messages: any[]) {
    // Walk all messages except the last two (latest assistant + latest user/tool_result)
    const keepFrom = Math.max(0, messages.length - 2);
    for (let i = 0; i < keepFrom; i++) {
      const msg = messages[i];
      if (!msg.content || !Array.isArray(msg.content)) continue;

      msg.content = msg.content.map((block: any) => {
        // Replace image blocks with a text placeholder
        if (block.type === "image") {
          return { type: "text", text: "[previous screenshot removed to save tokens]" };
        }
        // Replace images inside tool_result content arrays
        if (block.type === "tool_result" && Array.isArray(block.content)) {
          block.content = block.content.map((sub: any) => {
            if (sub.type === "image") {
              return { type: "text", text: "[previous screenshot]" };
            }
            return sub;
          });
        }
        return block;
      });
    }
  }

  private wait(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
