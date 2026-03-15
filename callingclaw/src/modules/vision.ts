// CallingClaw 2.0 — Module 3: Vision (Screenshot → AI Semantic Understanding)
// Handles: periodic screenshot analysis, screen change detection
// Produces: screen descriptions + context → SharedContext
// Consumes: screenshots from Python sidecar via Bridge

import type { PythonBridge } from "../bridge";
import type { SharedContext } from "./shared-context";
import { CONFIG } from "../config";
import OpenAI from "openai";

export interface VisionModuleOptions {
  bridge: PythonBridge;
  context: SharedContext;
  analysisIntervalMs?: number; // How often to analyze screen (default: 5000ms)
  autoAnalyze?: boolean;       // Auto-analyze on screen change
  onScreenDescription?: (description: string, screenshot: string) => void; // Callback when a new description is generated
}

export class VisionModule {
  private bridge: PythonBridge;
  private context: SharedContext;
  private openai: OpenAI;
  private visionClient: OpenAI; // Gemini Flash via OpenRouter for vision analysis
  private visionModel: string;
  private analysisInterval: number;
  private autoAnalyze: boolean;
  private _analyzing = false;
  private _timer: Timer | null = null;
  private _meetingMode = false;
  private _lastDescription = "";
  private _onScreenDescription?: (description: string, screenshot: string) => void;

  constructor(options: VisionModuleOptions) {
    this.bridge = options.bridge;
    this.context = options.context;
    this.openai = new OpenAI({ apiKey: CONFIG.openai.apiKey });

    // Vision analysis uses Gemini Flash via OpenRouter (much better multimodal than GPT-4o)
    this.visionClient = new OpenAI({
      apiKey: CONFIG.openrouter.apiKey,
      baseURL: CONFIG.openrouter.baseUrl,
    });
    this.visionModel = CONFIG.vision.model;

    this.analysisInterval = options.analysisIntervalMs || 5000;
    this.autoAnalyze = options.autoAnalyze ?? false;
    this._onScreenDescription = options.onScreenDescription;

    // Listen for screenshots from bridge
    this.bridge.on("screenshot", (msg) => {
      this.context.updateScreen(msg.payload.image);
      if (this.autoAnalyze && !this._analyzing) {
        this.analyzeCurrentScreen();
      }
    });
  }

  /**
   * Start periodic screen analysis
   */
  startAutoAnalysis() {
    this.autoAnalyze = true;
    this._timer = setInterval(() => {
      if (!this._analyzing && this.context.screen.latestScreenshot) {
        this.analyzeCurrentScreen();
      }
    }, this.analysisInterval);
    console.log(`[Vision] Auto-analysis started (every ${this.analysisInterval}ms)`);
  }

  /**
   * Stop periodic analysis
   */
  stopAutoAnalysis() {
    this.autoAnalyze = false;
    if (this._timer) clearInterval(this._timer);
    console.log("[Vision] Auto-analysis stopped");
  }

  /**
   * Analyze the current screenshot using Gemini Flash via OpenRouter.
   * Produces a screen description that goes into SharedContext.
   * This description is then available to Claude Computer Use module.
   */
  async analyzeCurrentScreen(question?: string): Promise<string> {
    const screenshot = this.context.screen.latestScreenshot;
    if (!screenshot) return "No screenshot available";
    if (!CONFIG.openrouter.apiKey) return "OpenRouter API key not configured";

    this._analyzing = true;
    try {
      const recentTranscript = this.context.getTranscriptText(10);

      const response = await this.visionClient.chat.completions.create({
        model: this.visionModel,
        max_tokens: 500,
        messages: [
          {
            role: "system",
            content: `You are CallingClaw's vision module. Describe what's on the screen concisely.
Focus on: active application, visible UI elements, any text/content, button locations.
If there's a meeting/presentation, describe the content being shown.

Recent conversation context:
${recentTranscript}`,
          },
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: `data:image/png;base64,${screenshot}`,
                  detail: "low",
                },
              },
              {
                type: "text",
                text:
                  question ||
                  "Describe what's currently on screen. What app is active? What's the user doing?",
              },
            ],
          },
        ],
      });

      const description =
        response.choices[0]?.message?.content || "Unable to analyze";

      // Update shared context with the description
      this.context.updateScreen(screenshot, description);

      console.log(`[Vision] Screen: ${description.slice(0, 100)}...`);
      return description;
    } catch (e: any) {
      console.error("[Vision] Analysis error:", e.message);
      return `Error: ${e.message}`;
    } finally {
      this._analyzing = false;
    }
  }

  /**
   * Ask a specific question about the current screen
   */
  async askAboutScreen(question: string): Promise<string> {
    return this.analyzeCurrentScreen(question);
  }

  // ══════════════════════════════════════════════════════════════
  // MEETING VISION MODE
  // When active, periodically analyzes meeting window screenshots.
  // Only sends for analysis when screen content meaningfully changes.
  // Visual descriptions are injected into transcript + pushed to OpenClaw.
  // ══════════════════════════════════════════════════════════════

  get isMeetingMode() { return this._meetingMode; }

  /**
   * Start meeting vision mode.
   * Captures meeting window at intervalMs, analyzes with meeting-specific prompt,
   * and injects screen descriptions into transcript.
   *
   * @param intervalMs Analysis interval in ms (default 8000 = every 8 seconds)
   */
  startMeetingVision(intervalMs?: number) {
    if (this._meetingMode) return;
    this._meetingMode = true;
    this._lastDescription = "";
    const interval = intervalMs || 8000;

    // Request initial screenshot
    this.bridge.sendAction("screenshot", {});

    this._timer = setInterval(async () => {
      if (this._analyzing) return;

      // Request fresh screenshot from Python sidecar
      this.bridge.sendAction("screenshot", {});

      // Wait a moment for the screenshot to arrive via bridge
      await new Promise((r) => setTimeout(r, 500));

      const screenshot = this.context.screen.latestScreenshot;
      if (!screenshot) return;

      // Analyze with meeting-specific prompt
      const description = await this.analyzeMeetingScreen(screenshot);
      if (!description) return;

      // Skip if description hasn't meaningfully changed
      if (this.isSimilarDescription(description, this._lastDescription)) return;
      this._lastDescription = description;

      // Inject into transcript as a [screen] entry
      this.context.addTranscript({
        role: "system",
        text: `[Screen] ${description}`,
        ts: Date.now(),
      });

      // Notify callback (for OpenClaw push)
      this._onScreenDescription?.(description, screenshot);

      console.log(`[MeetingVision] ${description.slice(0, 120)}...`);
    }, interval);

    console.log(`[MeetingVision] Started (every ${interval}ms)`);
  }

  /**
   * Stop meeting vision mode.
   */
  stopMeetingVision() {
    this._meetingMode = false;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._lastDescription = "";
    console.log("[MeetingVision] Stopped");
  }

  /**
   * Analyze a screenshot with a meeting-focused prompt.
   * Focuses on: presentation slides, shared screen content, code, diagrams.
   */
  private async analyzeMeetingScreen(screenshot: string): Promise<string | null> {
    if (!CONFIG.openrouter.apiKey) return null;

    this._analyzing = true;
    try {
      const recentTranscript = this.context.getTranscriptText(5);
      const prevDescription = this._lastDescription
        ? `Previous screen state: ${this._lastDescription.slice(0, 200)}`
        : "No previous screen state.";

      const response = await this.visionClient.chat.completions.create({
        model: this.visionModel,
        max_tokens: 300,
        messages: [
          {
            role: "system",
            content: `You are analyzing a meeting screen capture. Focus on NEW and CHANGED content only.

Rules:
- Describe what is being SHOWN/PRESENTED (slides, code, diagrams, documents, browser tabs)
- Note any text, code, data, charts, or key visual elements visible
- If someone is sharing their screen, describe the shared content specifically
- If it's just the meeting grid (faces), say "Meeting grid view, no shared content"
- Be concise: 1-3 sentences maximum
- Focus on WHAT'S DIFFERENT from previous state
- Use the meeting's language (Chinese if the conversation is in Chinese)

${prevDescription}

Recent conversation:
${recentTranscript}`,
          },
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: `data:image/png;base64,${screenshot}`,
                  detail: "low",
                },
              },
              {
                type: "text",
                text: "What's currently shown on the meeting screen? Focus on any shared/presented content.",
              },
            ],
          },
        ],
      });

      return response.choices[0]?.message?.content || null;
    } catch (e: any) {
      console.error("[MeetingVision] Analysis error:", e.message);
      return null;
    } finally {
      this._analyzing = false;
    }
  }

  /**
   * Check if two descriptions are semantically similar (avoid duplicate entries).
   * Simple heuristic: compare key nouns/numbers after normalization.
   */
  private isSimilarDescription(a: string, b: string): boolean {
    if (!b) return false;
    // Extract significant words (>3 chars, skip common words)
    const extract = (s: string) => {
      const words = s.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, " ").split(/\s+/);
      return new Set(words.filter((w) => w.length > 3));
    };
    const setA = extract(a);
    const setB = extract(b);
    if (setA.size === 0 || setB.size === 0) return false;
    // Jaccard similarity
    let intersection = 0;
    for (const w of setA) if (setB.has(w)) intersection++;
    const union = new Set([...setA, ...setB]).size;
    return intersection / union > 0.7; // >70% similar = skip
  }
}
