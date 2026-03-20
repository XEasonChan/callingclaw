// CallingClaw 2.0 — Module 3: Vision (Screenshot → AI Semantic Understanding)
//
// Screen capture pipeline:
//   BrowserCaptureProvider (CDP) → 1s periodic
//     → URL/title change detection
//     → Jaccard similarity dedup
//     → Gemini Flash analysis (throttled: 3s min interval)
//     → SharedContext.updateScreen()
//     → EventBus "screen.updated"
//
// Two capture modes (same pipeline, different prompts):
//   "meeting"      — focuses on shared/presented content
//   "talk_locally"  — focuses on current app activity
//
// Screen capture is fully on the Bun side (CDP WebSocket + screencapture CLI).
// Python sidecar is NOT involved in any screenshot operations.

import type { SharedContext } from "./shared-context";
import type { BrowserCaptureProvider } from "../capture/browser-capture-provider";
import { CONFIG } from "../config";
import { LANGUAGE_RULE } from "../prompt-constants";
import OpenAI from "openai";

export type ScreenCaptureMode = "meeting" | "talk_locally";

export interface VisionModuleOptions {
  context: SharedContext;
  browserCapture: BrowserCaptureProvider;
  analysisIntervalMs?: number;
  onScreenDescription?: (description: string, screenshot: string) => void;
}

const CAPTURE_INTERVAL_MS = 1000;         // 1s screenshot frequency
const GEMINI_MIN_INTERVAL_MS = 3000;      // Min 3s between Gemini calls
const GEMINI_TIMEOUT_MS = 10000;          // 10s timeout for Gemini

export class VisionModule {
  private context: SharedContext;
  private browserCapture: BrowserCaptureProvider;
  private visionClient: OpenAI;
  private visionModel: string;

  private _analyzing = false;
  private _lastAnalysisAt = 0;            // Timestamp of last Gemini call
  private _timer: Timer | null = null;
  private _mode: ScreenCaptureMode | null = null;
  private _lastDescription = "";
  private _lastUrl = "";
  private _lastTitle = "";
  private _onScreenDescription?: (description: string, screenshot: string) => void;

  constructor(options: VisionModuleOptions) {
    this.context = options.context;
    this.browserCapture = options.browserCapture;
    this._onScreenDescription = options.onScreenDescription;

    // Gemini Flash via OpenRouter
    this.visionClient = new OpenAI({
      apiKey: CONFIG.openrouter.apiKey,
      baseURL: CONFIG.openrouter.baseUrl,
    });
    this.visionModel = CONFIG.vision.model;
  }

  // ── Public API ──────────────────────────────────────────────

  get isMeetingMode() { return this._mode === "meeting"; }
  get isCapturing() { return this._mode !== null; }

  /**
   * Start periodic screen capture + AI analysis.
   * Called on voice.started (talk_locally) or meeting.started (meeting).
   */
  startScreenCapture(mode: ScreenCaptureMode) {
    if (this._mode) {
      // Already capturing — just switch mode (prompt changes, not frequency)
      this._mode = mode;
      console.log(`[Vision] Switched to ${mode} mode`);
      return;
    }

    this._mode = mode;
    this._lastDescription = "";
    this._lastUrl = "";
    this._lastTitle = "";

    this._timer = setInterval(() => this._captureAndAnalyze(), CAPTURE_INTERVAL_MS);
    console.log(`[Vision] Screen capture started (${mode}, every ${CAPTURE_INTERVAL_MS}ms)`);

    // Capture immediately
    this._captureAndAnalyze();
  }

  /**
   * Stop screen capture.
   * Called on voice.stopped or meeting.ended.
   */
  stopScreenCapture() {
    if (!this._mode) return;
    const was = this._mode;
    this._mode = null;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._lastDescription = "";
    this._lastUrl = "";
    this._lastTitle = "";
    console.log(`[Vision] Screen capture stopped (was ${was})`);
  }

  // Legacy aliases for backward compatibility
  startMeetingVision(intervalMs?: number) { this.startScreenCapture("meeting"); }
  stopMeetingVision() { this.stopScreenCapture(); }

  /**
   * Analyze the current screenshot on demand.
   * Returns the latest description from SharedContext, or runs a fresh analysis.
   */
  async analyzeCurrentScreen(question?: string): Promise<string> {
    // If we have a recent description, return it immediately
    const screen = this.context.screen;
    if (!question && screen.description && Date.now() - screen.capturedAt < 30000) {
      return screen.description;
    }

    // Force a fresh capture + analysis
    const result = await this.browserCapture.capture();
    if (!result) return "No screenshot available";

    const description = await this._analyzeWithGemini(
      result.image,
      question || "Describe what's currently on screen.",
      false,
    ) || "Unable to analyze";
    this.context.updateScreen(result.image, description, result.metadata.url, result.metadata.title);
    return description;
  }

  async askAboutScreen(question: string): Promise<string> {
    return this.analyzeCurrentScreen(question);
  }

  // ── Private: Capture + Analyze Loop ─────────────────────────

  private async _captureAndAnalyze(): Promise<void> {
    if (!this._mode) return;
    if (this._analyzing) return;

    try {
      // 1. Capture via CDP
      const result = await this.browserCapture.capture();
      if (!result) return;

      const { image, metadata } = result;
      const url = metadata.url || "";
      const title = metadata.title || "";

      // 2. Always update SharedContext with latest screenshot
      //    (even if we skip Gemini — the raw image is still fresh)
      this.context.updateScreen(image, this.context.screen.description, url, title);

      // 3. Change detection: URL or title changed?
      const urlChanged = url !== this._lastUrl && this._lastUrl !== "";
      const titleChanged = title !== this._lastTitle && this._lastTitle !== "";
      this._lastUrl = url;
      this._lastTitle = title;

      // 4. Gemini throttle: skip if too soon after last analysis
      const now = Date.now();
      if (!urlChanged && !titleChanged && (now - this._lastAnalysisAt) < GEMINI_MIN_INTERVAL_MS) {
        return;
      }

      // 5. Skip if analyzing (double-check)
      if (this._analyzing) return;

      // 6. Run Gemini analysis
      const isMeeting = this._mode === "meeting";
      const description = await this._analyzeWithGemini(image, undefined, isMeeting);
      if (!description) return;

      // 7. Similarity dedup: skip if description hasn't meaningfully changed
      if (this.isSimilarDescription(description, this._lastDescription)) return;
      this._lastDescription = description;

      // 8. Update SharedContext with analyzed description
      this.context.updateScreen(image, description, url, title);

      // 9. Inject into transcript
      if (isMeeting) {
        this.context.addTranscript({
          role: "system",
          text: `[Screen] ${description}`,
          ts: Date.now(),
        });
      }

      // 10. Notify callback (for OpenClaw push)
      this._onScreenDescription?.(description, image);

      console.log(`[Vision] ${isMeeting ? "Meeting" : "Screen"}: ${description.slice(0, 120)}...`);
    } catch (e: any) {
      // Don't let errors stop the loop
      if (this._mode) {
        console.error(`[Vision] Capture/analyze error: ${e.message}`);
      }
    }
  }

  // ── Private: Gemini Flash Analysis ──────────────────────────

  private async _analyzeWithGemini(
    screenshot: string,
    question?: string,
    meetingMode = false,
  ): Promise<string | null> {
    if (!CONFIG.openrouter.apiKey) return null;

    this._analyzing = true;
    this._lastAnalysisAt = Date.now();
    try {
      const recentTranscript = this.context.getTranscriptText(5);
      const prevDescription = this._lastDescription
        ? `Previous screen state: ${this._lastDescription.slice(0, 200)}`
        : "No previous screen state.";

      const systemPrompt = meetingMode
        ? `You are analyzing a meeting screen capture. Focus on NEW and CHANGED content only.

Rules:
- Describe what is SHOWN/PRESENTED (slides, code, diagrams, documents, browser tabs)
- Note text, code, data, charts, or key visual elements visible
- If shared screen, describe the shared content specifically
- If just meeting grid (faces), say "Meeting grid view, no shared content"
- 1-3 sentences maximum. Focus on WHAT'S DIFFERENT from previous state.
- ${LANGUAGE_RULE}

${prevDescription}

Recent conversation:
${recentTranscript}`
        : `You are CallingClaw's vision module. Describe what's on the screen concisely.
Focus on: active application, visible UI elements, any text/content.
1-3 sentences maximum. ${LANGUAGE_RULE}

${prevDescription}

Recent conversation context:
${recentTranscript}`;

      const userText = question
        || (meetingMode
          ? "What's currently shown on the meeting screen? Focus on any shared/presented content."
          : "Describe what's currently on screen. What app is active? What's the user doing?");

      const response = await this.visionClient.chat.completions.create({
        model: this.visionModel,
        max_tokens: meetingMode ? 300 : 500,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${screenshot}`,
                  detail: "low",
                },
              },
              { type: "text", text: userText },
            ],
          },
        ],
      });

      return response.choices[0]?.message?.content || null;
    } catch (e: any) {
      console.error(`[Vision] Gemini analysis error: ${e.message}`);
      return null;
    } finally {
      this._analyzing = false;
    }
  }

  // ── Private: Similarity Check ───────────────────────────────

  /**
   * Check if two descriptions are semantically similar (avoid duplicate entries).
   * Uses Jaccard similarity on significant words.
   */
  private isSimilarDescription(a: string, b: string): boolean {
    if (!b) return false;
    const extract = (s: string) => {
      const words = s.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, " ").split(/\s+/);
      return new Set(words.filter((w) => w.length > 3));
    };
    const setA = extract(a);
    const setB = extract(b);
    if (setA.size === 0 || setB.size === 0) return false;
    let intersection = 0;
    for (const w of setA) if (setB.has(w)) intersection++;
    const union = new Set([...setA, ...setB]).size;
    return intersection / union > 0.7;
  }
}
