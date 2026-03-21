// CallingClaw 2.0 — Anthropic Computer Use Agent
// Uses the official beta.messages.create() with computer_20250124 tool

import Anthropic from "@anthropic-ai/sdk";
import { CONFIG } from "../config";
import type { PythonBridge } from "../bridge";

// The Computer Use tool definition
const COMPUTER_TOOL = {
  type: "computer_20250124" as const,
  name: "computer" as const,
  display_width_px: CONFIG.screen.width,
  display_height_px: CONFIG.screen.height,
  display_number: 1,
};

export interface ComputerAction {
  action: string;
  coordinate?: [number, number];
  text?: string;
  scroll_direction?: "up" | "down" | "left" | "right";
  scroll_amount?: number;
  duration_seconds?: number;
}

export class ClaudeAgent {
  private client: Anthropic;
  private bridge: PythonBridge;
  private conversationHistory: Anthropic.Beta.Messages.BetaMessageParam[] = [];

  constructor(bridge: PythonBridge) {
    this.client = new Anthropic({ apiKey: CONFIG.anthropic.apiKey });
    this.bridge = bridge;
  }

  /**
   * Run a full Computer Use agent loop:
   * 1. Send instruction to Claude with computer tool
   * 2. Claude returns tool_use (screenshot, click, type, etc.)
   * 3. Execute action via Python bridge, capture screenshot
   * 4. Send result back to Claude
   * 5. Repeat until Claude returns end_turn
   */
  async runComputerUseLoop(
    instruction: string,
    initialScreenshot?: string,
    maxSteps = 20
  ): Promise<{ summary: string; steps: string[] }> {
    console.log("[Claude] Starting Computer Use loop:", instruction);
    const steps: string[] = [];

    // Build initial message
    const userContent: any[] = [];
    if (initialScreenshot) {
      userContent.push({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: initialScreenshot,
        },
      });
    }
    userContent.push({ type: "text", text: instruction });

    this.conversationHistory = [{ role: "user", content: userContent }];

    for (let step = 0; step < maxSteps; step++) {
      const response = await this.client.beta.messages.create({
        model: CONFIG.anthropic.model,
        max_tokens: 4096,
        tools: [COMPUTER_TOOL],
        messages: this.conversationHistory,
        betas: ["computer-use-2025-01-24"],
        system:
          "You are CallingClaw, an AI assistant that can see and control the user's computer. " +
          "Take screenshots to verify your actions. Be precise with coordinates. " +
          "Narrate each step briefly.",
      });

      // Append assistant response to history
      this.conversationHistory.push({
        role: "assistant",
        content: response.content as any,
      });

      // If Claude is done (end_turn), extract summary
      if (response.stop_reason === "end_turn") {
        const textBlocks = response.content.filter(
          (b) => b.type === "text"
        );
        const summary = textBlocks.map((b: any) => b.text).join("\n");
        steps.push(`[Done] ${summary}`);
        return { summary, steps };
      }

      // Process tool_use blocks
      const toolResults: any[] = [];

      for (const block of response.content) {
        if (block.type !== "tool_use") continue;

        const input = block.input as ComputerAction;
        const stepDesc = `Step ${step + 1}: ${input.action}${
          input.coordinate ? ` at (${input.coordinate.join(",")})` : ""
        }${input.text ? ` "${input.text}"` : ""}`;
        steps.push(stepDesc);
        console.log(`[Claude] ${stepDesc}`);

        // Execute action and get screenshot result
        const screenshotBase64 = await this.executeAction(input);

        if (screenshotBase64) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: screenshotBase64,
                },
              },
            ],
          });
        } else {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: "Action executed successfully.",
          });
        }
      }

      // Append tool results to conversation
      this.conversationHistory.push({ role: "user", content: toolResults });
    }

    return { summary: "Max steps reached", steps };
  }

  /**
   * Execute a single Computer Use action via the Python bridge.
   * Returns a screenshot base64 if the action is "screenshot", otherwise null.
   */
  private async executeAction(
    action: ComputerAction
  ): Promise<string | null> {
    switch (action.action) {
      case "screenshot":
        return this.requestScreenshot();

      case "left_click":
      case "right_click":
      case "double_click":
      case "middle_click":
        this.bridge.sendAction("click", {
          button: action.action.replace("_click", ""),
          x: action.coordinate?.[0],
          y: action.coordinate?.[1],
        });
        await this.wait(200);
        return this.requestScreenshot();

      case "type":
        this.bridge.sendAction("type", { text: action.text });
        await this.wait(100);
        return null;

      case "key":
        this.bridge.sendAction("key", { key: action.text });
        await this.wait(100);
        return null;

      case "scroll":
        this.bridge.sendAction("scroll", {
          x: action.coordinate?.[0],
          y: action.coordinate?.[1],
          direction: action.scroll_direction || "down",
          amount: action.scroll_amount || 3,
        });
        await this.wait(200);
        return this.requestScreenshot();

      case "mouse_move":
        this.bridge.sendAction("mouse_move", {
          x: action.coordinate?.[0],
          y: action.coordinate?.[1],
        });
        await this.wait(100);
        return null;

      case "left_click_drag":
        this.bridge.sendAction("drag", {
          startX: action.coordinate?.[0],
          startY: action.coordinate?.[1],
          // endCoordinate would be in a separate field
        });
        await this.wait(200);
        return this.requestScreenshot();

      case "wait":
        await this.wait((action.duration_seconds || 1) * 1000);
        return null;

      default:
        console.warn(`[Claude] Unknown action: ${action.action}`);
        return null;
    }
  }

  /**
   * Request a screenshot from Python sidecar and wait for it.
   */
  private requestScreenshot(): Promise<string | null> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 5000);

      this.bridge.on("screenshot", (msg) => {
        clearTimeout(timeout);
        resolve(msg.payload.image);
      });

      this.bridge.sendAction("screenshot", {});
    });
  }

  /**
   * Simple vision analysis (no computer use, just image Q&A).
   */
  async analyzeImage(imageBase64: string, question: string): Promise<string> {
    const response = await this.client.messages.create({
      model: CONFIG.anthropic.model,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: imageBase64,
              },
            },
            { type: "text", text: question },
          ],
        },
      ],
    });

    return response.content[0].type === "text"
      ? response.content[0].text
      : "No response";
  }

  private wait(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
