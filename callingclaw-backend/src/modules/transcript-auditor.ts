// CallingClaw 2.0 — TranscriptAuditor (System 2 Intent Classification)
//
// Replaces OpenAI Realtime's unreliable tool-calling for automation during meetings.
// Monitors the live transcript and uses Claude (Haiku) to classify user intent
// with meeting context awareness, then dispatches to AutomationRouter.
//
// Architecture:
//   User speaks → Whisper STT → SharedContext.transcript
//                                       ↓
//                            TranscriptAuditor (debounced)
//                                       ↓
//                            Claude Haiku intent classification
//                            (transcript + meeting brief context)
//                                       ↓
//                     confidence ≥ 0.85 → auto-execute via AutomationRouter
//                     confidence 0.6-0.85 → suggest via Voice AI liveNote
//                     confidence < 0.6 → ignore

import type { SharedContext, TranscriptEntry } from "./shared-context";
import type { EventBus } from "./event-bus";
import type { AutomationRouter } from "./automation-router";
import type { ComputerUseModule } from "./computer-use";
import type { VoiceModule } from "./voice";
import type { MeetJoiner } from "../meet_joiner";
import type { MeetingPrepSkill } from "../skills/meeting-prep";
import { notifyTaskCompletion, pushContextUpdate } from "../voice-persona";
import { CONFIG } from "../config";

// ── Types ──

export interface AuditResult {
  action: string | null;
  params: Record<string, any>;
  confidence: number;
  reasoning: string;
}

// Tools that the auditor takes over during meetings (removed from OpenAI session)
export const AUDITOR_MANAGED_TOOLS = new Set([
  "computer_action",
  "browser_action",
  "share_screen",
  "stop_sharing",
  "open_file",
]);

// ── Module ──

export class TranscriptAuditor {
  private context: SharedContext;
  private eventBus: EventBus;
  private automationRouter: AutomationRouter;
  private computerUse: ComputerUseModule;
  private meetingPrepSkill: MeetingPrepSkill;
  private meetJoiner: MeetJoiner;
  private voice: VoiceModule | null = null;

  private _active = false;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _lastAuditedTs = 0;
  private _processing = false;
  private _recentActions: string[] = []; // dedup ring buffer (last 5)
  private _lastExecutionTs = 0;

  // ── Tuning knobs ──
  private DEBOUNCE_MS = 2500;        // Wait 2.5s after last user utterance
  private CONFIDENCE_AUTO = 0.85;     // Auto-execute threshold
  private CONFIDENCE_SUGGEST = 0.6;   // Suggest to Voice AI threshold
  private WINDOW_ENTRIES = 15;        // Transcript entries to analyze
  private COOLDOWN_MS = 5000;         // Min gap between executions

  constructor(opts: {
    context: SharedContext;
    eventBus: EventBus;
    automationRouter: AutomationRouter;
    computerUse: ComputerUseModule;
    meetingPrepSkill: MeetingPrepSkill;
    meetJoiner: MeetJoiner;
  }) {
    this.context = opts.context;
    this.eventBus = opts.eventBus;
    this.automationRouter = opts.automationRouter;
    this.computerUse = opts.computerUse;
    this.meetingPrepSkill = opts.meetingPrepSkill;
    this.meetJoiner = opts.meetJoiner;
  }

  get active() {
    return this._active;
  }

  // ── Lifecycle ──

  /** Activate auditor when a meeting starts */
  activate(voice: VoiceModule) {
    if (this._active) return;
    this.voice = voice;
    this._active = true;
    this._lastAuditedTs = Date.now();
    this._recentActions = [];
    this._lastExecutionTs = 0;

    // Subscribe to transcript events
    this.context.on("transcript", this._onTranscript);

    console.log("[TranscriptAuditor] Activated — monitoring transcript for automation intent");
    this.eventBus.emit("auditor.activated", {});
  }

  /** Deactivate auditor when meeting ends */
  deactivate() {
    if (!this._active) return;
    this._active = false;
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    // Unsubscribe listener to prevent leaking handlers across meetings
    this.context.off("transcript", this._onTranscript);
    this.voice = null;
    console.log("[TranscriptAuditor] Deactivated");
    this.eventBus.emit("auditor.deactivated", {});
  }

  // ── Event handler (arrow fn to preserve `this`) ──

  private _onTranscript = (entry: TranscriptEntry) => {
    if (!this._active) return;
    if (entry.role !== "user") return; // Only audit on user speech
    this.scheduleAudit();
  };

  private scheduleAudit() {
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => this.runAudit(), this.DEBOUNCE_MS);
  }

  // ── Core audit loop ──

  private async runAudit() {
    if (!this._active || this._processing) return;

    // Cooldown: don't fire too rapidly
    if (Date.now() - this._lastExecutionTs < this.COOLDOWN_MS) return;

    const entries = this.context.getRecentTranscript(this.WINDOW_ENTRIES);

    // Only audit if there are new user entries since last audit
    const hasNewUserSpeech = entries.some(
      (e) => e.role === "user" && e.ts > this._lastAuditedTs
    );
    if (!hasNewUserSpeech) return;

    this._processing = true;
    this._lastAuditedTs = Date.now();

    try {
      const result = await this.classifyIntent(entries);

      if (!result.action) return; // No actionable intent

      // Dedup: skip if we just did this exact action
      const actionKey = `${result.action}:${JSON.stringify(result.params)}`;
      if (this._recentActions.includes(actionKey)) {
        console.log(`[TranscriptAuditor] Skipping duplicate: ${actionKey}`);
        return;
      }

      this.eventBus.emit("auditor.intent", {
        action: result.action,
        params: result.params,
        confidence: result.confidence,
        reasoning: result.reasoning,
      });

      if (result.confidence >= this.CONFIDENCE_AUTO) {
        // ── High confidence → auto-execute ──
        console.log(
          `[TranscriptAuditor] Auto-executing: ${result.action} (confidence: ${result.confidence})`
        );
        await this.executeAction(result);
        this._recentActions.push(actionKey);
        if (this._recentActions.length > 5) this._recentActions.shift();
        this._lastExecutionTs = Date.now();
      } else if (result.confidence >= this.CONFIDENCE_SUGGEST) {
        // ── Medium confidence → suggest to Voice AI ──
        console.log(
          `[TranscriptAuditor] Suggesting: ${result.action} (confidence: ${result.confidence})`
        );
        this.suggestAction(result);
      }
      // Below threshold → silent ignore
    } catch (err: any) {
      console.error("[TranscriptAuditor] Audit error:", err.message);
      this.eventBus.emit("auditor.error", { error: err.message });
    } finally {
      this._processing = false;
    }
  }

  // ── Intent Classification (Claude Haiku) ──

  private async classifyIntent(
    entries: TranscriptEntry[]
  ): Promise<AuditResult> {
    const brief = this.meetingPrepSkill.currentBrief;

    const transcriptText = entries
      .map(
        (e) =>
          `[${e.role}${e.speaker ? ` (${e.speaker})` : ""}] ${e.text}`
      )
      .join("\n");

    const prompt = `You classify user intent from a meeting conversation transcript. The user is talking to CallingClaw, an AI meeting assistant that controls its own computer.

## Available Actions
- open_url: Open a URL in browser. Params: { "url": "https://..." }
- open_file: Open a local file. Params: { "path": "/abs/path", "app": "vscode"|"browser"|"finder" }
- share_screen: Start screen sharing in the meeting. Params: {}
- stop_sharing: Stop screen sharing. Params: {}
- navigate: Navigate/interact in browser. Params: { "instruction": "describe what to do" }
- scroll: Scroll current view. Params: { "direction": "up"|"down" }
- computer_action: General computer task. Params: { "instruction": "describe what to do" }

## Meeting Context
${
  brief
    ? `Topic: ${brief.topic}
Goal: ${brief.goal}
Known files: ${JSON.stringify(brief.filePaths || [], null, 0)}
Known URLs: ${JSON.stringify(brief.browserUrls || [], null, 0)}
Recent actions: ${
        (brief.liveNotes || [])
          .filter((n: string) => n.startsWith("[DONE]"))
          .join("; ") || "none"
      }`
    : "No meeting brief loaded."
}

## Transcript (most recent at bottom)
${transcriptText}

## Classification Rules
1. ONLY classify as actionable if the user is DIRECTING CallingClaw to perform a computer action.
2. Actionable phrases: "我们看看X" / "帮我打开X" / "跳到X" / "展示一下X" / "开始投屏" / "打开那个Y"
3. Discussion phrases: "这个要改成X" / "我觉得X应该Y" / "下次我们需要Z" → NOT commands, confidence=0
4. If user references a file/URL that matches the meeting brief's known files/URLs, resolve to the full path/URL.
5. Be conservative — a false positive (executing something the user didn't ask for) is much worse than a false negative (missing a command).
6. If the most recent user message is a response to the AI (answering a question, agreeing, etc.) and not a new command → confidence=0.

Respond with JSON only:
{"action":"<action_name or null>","params":{...},"confidence":<0.0-1.0>,"reasoning":"<brief explanation>"}`;

    return await this.callClaude(prompt);
  }

  // ── LLM API Call (Anthropic Direct or OpenRouter) ──

  private async callClaude(prompt: string): Promise<AuditResult> {
    const NULL_RESULT: AuditResult = {
      action: null,
      params: {},
      confidence: 0,
      reasoning: "no_api_key",
    };

    // Prefer OpenRouter (supports all models uniformly — Haiku, Gemini, etc.)
    if (CONFIG.openrouter.apiKey) {
      return this.callOpenRouter(prompt);
    } else if (CONFIG.anthropic.apiKey) {
      return this.callAnthropicDirect(prompt);
    }

    console.warn(
      "[TranscriptAuditor] No API key (need OPENROUTER_API_KEY or ANTHROPIC_API_KEY)"
    );
    return NULL_RESULT;
  }

  private async callAnthropicDirect(prompt: string): Promise<AuditResult> {
    // Strip OpenRouter-style prefix (e.g. "anthropic/claude-haiku-4-5" → "claude-haiku-4-5")
    const model = CONFIG.analysis.model.replace(/^anthropic\//, "");
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CONFIG.anthropic.apiKey,
        "anthropic-version": "2024-01-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 256,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!resp.ok) {
      throw new Error(`Anthropic API ${resp.status}: ${await resp.text()}`);
    }

    const data = (await resp.json()) as any;
    return this.parseResponse(data.content?.[0]?.text || "{}");
  }

  private async callOpenRouter(prompt: string): Promise<AuditResult> {
    const resp = await fetch(
      `${CONFIG.openrouter.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CONFIG.openrouter.apiKey}`,
        },
        body: JSON.stringify({
          model: CONFIG.analysis.model,
          max_tokens: 256,
          messages: [{ role: "user", content: prompt }],
        }),
      }
    );

    if (!resp.ok) {
      throw new Error(`OpenRouter API ${resp.status}: ${await resp.text()}`);
    }

    const data = (await resp.json()) as any;
    return this.parseResponse(
      data.choices?.[0]?.message?.content || "{}"
    );
  }

  private parseResponse(text: string): AuditResult {
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return {
          action: null,
          params: {},
          confidence: 0,
          reasoning: "parse_error: no JSON found",
        };
      }
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        action: parsed.action || null,
        params: parsed.params || {},
        confidence:
          typeof parsed.confidence === "number" ? parsed.confidence : 0,
        reasoning: parsed.reasoning || "",
      };
    } catch {
      return {
        action: null,
        params: {},
        confidence: 0,
        reasoning: "json_parse_error",
      };
    }
  }

  // ── Action Execution ──

  private async executeAction(result: AuditResult) {
    const { action, params } = result;

    this.eventBus.emit("auditor.executing", {
      action,
      params,
      confidence: result.confidence,
    });

    let instruction = "";
    let executionResult = "";

    try {
      switch (action) {
        case "open_url": {
          instruction = `open ${params.url} in browser`;
          const r = await this.automationRouter.execute(instruction);
          executionResult = r.success
            ? r.result
            : `Router failed: ${r.result}`;
          break;
        }

        case "open_file": {
          // Fast path: use AutomationRouter's file search + open (not legacy osascript)
          const fileQuery = params.path || params.query || "";
          instruction = `open file: ${fileQuery}`;
          const fileResult = await this.automationRouter.execute(instruction);
          if (!fileResult.success) {
            // Fallback: try legacy meetJoiner
            try {
              await this.meetJoiner.openFile(params.path, params.app || "browser");
              executionResult = `Opened ${params.path}`;
            } catch { executionResult = fileResult.result; }
          } else {
            executionResult = fileResult.result;
          }
          break;
        }

        case "share_screen": {
          // Fast path: use ChromeLauncher screen share API (not legacy osascript)
          instruction = "start screen sharing";
          const shareUrl = params.url || undefined;
          try {
            const resp = await fetch("http://localhost:4000/api/screen/share", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ url: shareUrl }),
            });
            const shareData = await resp.json() as any;
            executionResult = shareData.success ? "Screen sharing started" : `Share failed: ${shareData.message}`;
          } catch {
            // Fallback: legacy meetJoiner
            const ok = await this.meetJoiner.shareScreen();
            executionResult = ok ? "Screen sharing started (legacy)" : "Failed to start screen sharing";
          }
          break;
        }

        case "stop_sharing": {
          instruction = "stop screen sharing";
          try {
            await fetch("http://localhost:4000/api/screen/stop", { method: "POST" });
            executionResult = "Screen sharing stopped";
          } catch {
            await this.meetJoiner.stopSharing();
            executionResult = "Screen sharing stopped (legacy)";
          }
          break;
        }

        case "scroll": {
          instruction = `scroll ${params.direction || "down"}`;
          const r = await this.automationRouter.execute(instruction);
          executionResult = r.result;
          break;
        }

        case "navigate":
        case "computer_action":
        default: {
          instruction =
            params.instruction ||
            `${action} ${JSON.stringify(params)}`;

          // Route through L1→L2→L3, fallback to L4 Computer Use
          const r = await this.automationRouter.execute(instruction);

          if (r.success) {
            executionResult = r.result;
          } else if (this.computerUse.isConfigured) {
            // L4 fallback: full Computer Use agent loop
            this.eventBus.emit("computer.task_started", {
              instruction,
              source: "auditor_l4",
            });
            const cuResult = await this.computerUse.execute(instruction);
            executionResult = cuResult.summary;
          } else {
            executionResult =
              "No automation layer could handle this instruction.";
          }
          break;
        }
      }

      this.eventBus.emit("computer.task_done", {
        instruction,
        summary: executionResult,
        layer: "auditor",
        source: "transcript_auditor",
      });

      // Push completion to Voice AI as a live note
      if (
        this.voice?.connected &&
        this.meetingPrepSkill.currentBrief
      ) {
        notifyTaskCompletion(
          this.voice,
          this.meetingPrepSkill,
          instruction,
          executionResult,
          this.eventBus
        );
      }

      console.log(
        `[TranscriptAuditor] Executed: ${action} → ${executionResult}`
      );
    } catch (err: any) {
      console.error(
        `[TranscriptAuditor] Execution failed: ${err.message}`
      );
      this.eventBus.emit("auditor.error", {
        action,
        error: err.message,
      });
    }
  }

  // ── Suggestion (medium confidence) ──

  private suggestAction(result: AuditResult) {
    if (!this.meetingPrepSkill.currentBrief) return;

    const note = `[SUGGEST] 检测到可能的意图: ${result.action} (${result.reasoning})。置信度: ${(result.confidence * 100).toFixed(0)}%。如需执行请向用户确认。`;
    this.meetingPrepSkill.addLiveNote(note);

    // Push updated context to Voice AI so it can ask the user
    if (this.voice?.connected) {
      pushContextUpdate(this.voice, this.meetingPrepSkill, this.eventBus);
    }

    this.eventBus.emit("auditor.suggest", {
      action: result.action,
      params: result.params,
      confidence: result.confidence,
      reasoning: result.reasoning,
    });
  }
}
