// CallingClaw 2.0 — Module 2: Voice (Multi-Provider Realtime)
// Handles: real-time voice conversation, live transcript, tool calls
// Produces: transcript entries → SharedContext
// Does NOT do: screen analysis or computer use (separate modules)
//
// Provider support:
//   "openai" — OpenAI Realtime API (default, battle-tested)
//   "grok"   — xAI Grok Voice Agent (A/B test, 6x cheaper)
//
// All event names are normalized by RealtimeClient — VoiceModule
// uses the same handlers regardless of provider.

import { RealtimeClient, type RealtimeTool, type VoiceProviderName, type ContextItem, type ProviderCapabilities } from "../ai_gateway/realtime_client";
import type { SharedContext } from "./shared-context";
import { CONFIG } from "../config";
import { VoiceTracer, type VoiceTurnTrace } from "./voice-trace";
import type { AudioStateEvent, ToolEvent, SessionEvent } from "../ai_gateway/voice-events";

export type AudioState = "idle" | "listening" | "speaking" | "interrupted" | "thinking";

/** Tools that are too slow to await inline — dispatched async to avoid blocking voice thread */
const SLOW_TOOLS = new Set([
  "browser_action",
  "computer_action",
  "take_screenshot",
  "open_file",
  "share_screen",
  // Gemini 3.1 Live is very sensitive to delays — any blocking tool call
  // causes the connection to stall or disconnect. These are normally "fast"
  // for OpenAI/Grok but must be async for Gemini to keep audio flowing.
  "recall_context",
  "save_meeting_notes",
]);

export interface VoiceModuleOptions {
  context: SharedContext;
  systemInstructions?: string;
  tools?: RealtimeTool[];
  onToolCall?: (name: string, args: any, callId: string) => Promise<string>;
  /** Called when auto-reconnect retries are exhausted */
  onReconnectFailed?: () => void;
}

export class VoiceModule {
  private client: RealtimeClient;
  private context: SharedContext;
  private onToolCall?: VoiceModuleOptions["onToolCall"];
  private _transcriptBuffer = "";
  private _lastInstructions = "";
  private _allTools: RealtimeTool[] = [];  // Full tool set (immutable reference)
  private _provider: VoiceProviderName = "openai";

  // Audio state machine
  private _audioState: AudioState = "idle";
  private _audioStateTs: number = 0;
  private _presentationMode = false;
  private _lastAudioOutputTs: number = 0;  // When AI last produced audio (for echo debounce)

  // Heard transcript tracking (interruption truncation)
  private _currentResponseAudioSamples = 0;  // Total samples received from provider
  private _currentResponseStartTime = 0;      // When first audio chunk arrived
  private _currentResponseTranscript = "";     // Accumulated transcript for heard tracking

  // Voice path tracing (observability)
  private _tracer = new VoiceTracer();

  // External callback for speech-started (registered via onSpeechStarted())
  private _onSpeechStarted?: () => void;

  // Post-tool screenshot feedback: called after visual tools complete to auto-inject screen state
  private _onScreenCapture?: () => Promise<{ screenshot: string; caption: string } | null>;

  get connected() {
    return this.client.connected;
  }

  /** Which voice provider is currently active */
  get provider(): VoiceProviderName {
    return this._provider;
  }

  /** Provider capability flags (interruption, native tools, etc.) */
  get capabilities(): ProviderCapabilities {
    return this.client.capabilities;
  }

  /** Current audio state (idle, listening, speaking, interrupted, thinking) */
  get audioState(): AudioState {
    return this._audioState;
  }

  /** Timestamp of the last audio state transition */
  get audioStateTimestamp(): number {
    return this._audioStateTs;
  }

  /** Enable/disable presentation mode — when true, slow tools are awaited instead of async */
  set presentationMode(on: boolean) {
    this._presentationMode = on;
    console.log(`[Voice] Presentation mode: ${on ? "ON" : "OFF"}`);
  }
  get presentationMode(): boolean { return this._presentationMode; }

  /** Voice path tracer for observability metrics */
  get tracer(): VoiceTracer { return this._tracer; }

  private _setAudioState(state: AudioState) {
    if (this._audioState !== state) {
      const prev = this._audioState;
      this._audioState = state;
      this._audioStateTs = Date.now();
      console.log(`[Voice] Audio state: ${prev} → ${state}`);
    }
  }

  constructor(options: VoiceModuleOptions) {
    this.client = new RealtimeClient();
    this.context = options.context;
    this.onToolCall = options.onToolCall;

    // Register tools
    if (options.tools) {
      this._allTools = [...options.tools];
      for (const tool of options.tools) {
        this.client.addTool(tool);
      }
    }

    // Wire up reconnect failure callback
    if (options.onReconnectFailed) {
      this.client.onReconnectFailed(options.onReconnectFailed);
    }

    this.setupEventHandlers();
  }

  private setupEventHandlers() {
    // ── Audio State: Session ready → listening ──
    this.client.on("session.updated", () => {
      this._setAudioState("listening");
    });

    // ── Audio State + Interruption: User starts speaking ──
    this.client.on("input_audio_buffer.speech_started", () => {
      // Echo debounce: if AI was speaking and speech_started fires very soon after
      // last audio output, this is likely echo (AI's own voice looping back via Meet).
      // In presentation mode, use a longer debounce to avoid self-interruption.
      const msSinceLastOutput = Date.now() - this._lastAudioOutputTs;
      const echoThresholdMs = this._presentationMode ? 2000 : 800;
      if (this._audioState === "speaking" && msSinceLastOutput < echoThresholdMs) {
        console.log(`[Voice] Echo debounce: speech_started ${msSinceLastOutput}ms after last audio output (threshold: ${echoThresholdMs}ms) — ignoring`);
        return; // Skip this interruption — likely echo
      }

      // Trace: mark interruption if AI was speaking, then start new turn
      if (this._audioState === "speaking") {
        this._tracer.mark('interruptionTime');
        this._tracer.endTurn();
      }
      this._tracer.startTurn();
      this._tracer.mark('userSpeechStart');

      // Heard transcript truncation: calculate what user actually heard
      if (this._audioState === "speaking" &&
          this._currentResponseAudioSamples > 0 &&
          this._currentResponseStartTime > 0) {
        this._setAudioState("interrupted");

        const elapsedMs = Date.now() - this._currentResponseStartTime;
        const totalDurationMs = (this._currentResponseAudioSamples / 24000) * 1000;
        // heardRatio: how much of the audio timeline elapsed before interrupt
        // Account for 150ms initial buffer latency
        const heardRatio = Math.min(1, Math.max(0, (elapsedMs - 150) / totalDurationMs));

        if (heardRatio < 0.95 && this._currentResponseTranscript) {
          const heardLength = Math.floor(this._currentResponseTranscript.length * heardRatio);
          const heardText = this._currentResponseTranscript.slice(0, heardLength);

          if (heardText.length > 0) {
            // Check if the full transcript was already written to context
            const recent = this.context.getRecentTranscript(5);
            const lastAssistant = recent.filter(e => e.role === "assistant").pop();
            if (lastAssistant && lastAssistant.text === this._currentResponseTranscript) {
              // Add a correction entry noting what was actually heard
              const unheardText = this._currentResponseTranscript.slice(heardLength).trim();
              const recoveryHint = unheardText.length > 20
                ? ` You were cut off mid-response. Key undelivered point: "${unheardText.slice(0, 120)}..." — weave it into your next reply if relevant, don't repeat what was already heard.`
                : "";
              this.context.addTranscript({
                role: "system",
                text: `[HEARD] AI was interrupted at ${Math.round(heardRatio * 100)}%. User heard: "${heardText.slice(0, 100)}..."${recoveryHint}`,
                ts: Date.now(),
              });
            }
            console.log(`[Voice] Interrupt: heard ${Math.round(heardRatio * 100)}% of response (${heardText.length}/${this._currentResponseTranscript.length} chars)`);
          }
        }
      }

      // Commit any buffered audio, then cancel in-progress AI response
      this.client.sendEvent("input_audio_buffer.commit", {});
      // Only cancel if AI was actively responding (avoids "response_cancel_not_active" error)
      if (this._audioState === "speaking" || this._audioState === "thinking" || this._audioState === "interrupted") {
        const cancelled = this.client.sendEvent("response.cancel", {});
        if (!cancelled) {
          // Retry if WebSocket wasn't ready
          setTimeout(() => {
            if (this.client.connected && (this._audioState === "speaking" || this._audioState === "thinking")) {
              this.client.sendEvent("response.cancel", {});
              console.log("[Voice] Retry: sent delayed response.cancel");
            }
          }, 100);
        }
      }

      // Fire external speech-started callback
      if (this._onSpeechStarted) this._onSpeechStarted();
    });

    // ── Trace: User stops speaking ──
    this.client.on("input_audio_buffer.speech_stopped", () => {
      this._tracer.mark('userSpeechEnd');
    });

    // ── Audio State: Response created → thinking ──
    this.client.on("response.created", () => {
      this._setAudioState("thinking");
      this._tracer.mark('modelFirstToken');
      // Reset heard-transcript counters for new response
      this._currentResponseAudioSamples = 0;
      this._currentResponseStartTime = 0;
      this._currentResponseTranscript = "";
    });

    // ── Audio State + Heard Tracking: Audio streaming → speaking ──
    this.client.on("response.audio.delta", (event) => {
      // Track audio samples for heard-ratio calculation
      // event.delta is base64 PCM16, each sample is 2 bytes
      const b64len = (event.delta || "").length;
      const samples = Math.round(b64len * 3 / 4 / 2);
      this._currentResponseAudioSamples += samples;
      if (!this._currentResponseStartTime) this._currentResponseStartTime = Date.now();

      // Track last audio output for echo debounce
      this._lastAudioOutputTs = Date.now();

      // First audio chunk → transition to speaking
      if (this._audioState !== "speaking") {
        this._tracer.mark('modelFirstAudio');
        this._tracer.mark('ttsPlaybackStart');
        this._setAudioState("speaking");
      }
    });

    // ── Audio State: Response audio done → listening ──
    this.client.on("response.audio.done", () => {
      this._tracer.mark('ttsPlaybackEnd');
      this._tracer.endTurn();
      this._setAudioState("listening");
    });

    this.client.on("response.done", (event: any) => {
      // Track token usage for observability
      if (event?.usage) {
        this._tracer.recordTokens(event.usage.input_tokens || 0, event.usage.output_tokens || 0);
      }
      // Only go to listening if we're not already idle (disconnected)
      if (this._audioState !== "idle") {
        this._setAudioState("listening");
      }
    });

    // ── Live Transcript: User speech ──
    // Event name is the same for both providers
    this.client.on("conversation.item.input_audio_transcription.completed", (event) => {
      if (event.transcript) {
        this.context.addTranscript({
          role: "user",
          text: event.transcript,
          ts: Date.now(),
        });
        console.log(`[Voice] User: ${event.transcript}`);

        // Feed transcript to RealtimeClient for context replay on reconnect
        this._feedTranscriptContext();
      }
    });

    // ── Live Transcript: AI speech ──
    // Grok: response.output_audio_transcript.* → normalized to response.audio_transcript.*
    this.client.on("response.audio_transcript.delta", (event) => {
      this._transcriptBuffer += event.delta || "";
      // Accumulate for heard-ratio tracking (separate from _transcriptBuffer which resets)
      this._currentResponseTranscript += event.delta || "";
    });

    this.client.on("response.audio_transcript.done", (event) => {
      const text = event.transcript || this._transcriptBuffer;
      if (text) {
        this.context.addTranscript({
          role: "assistant",
          text,
          ts: Date.now(),
        });
        console.log(`[Voice] AI: ${text}`);

        // Feed transcript to RealtimeClient for context replay on reconnect
        this._feedTranscriptContext();
      }
      this._transcriptBuffer = "";
    });

    // ── Tool Calls ──
    // Event name is the same for both providers
    this.client.on("response.function_call_arguments.done", async (event) => {
      const { call_id, name, arguments: argsStr } = event;
      let args: any;
      try {
        args = JSON.parse(argsStr);
      } catch {
        args = {};
      }

      console.log(`[Voice] Tool call: ${name}`, args);
      this._tracer.recordTool(name);

      // Record in transcript
      this.context.addTranscript({
        role: "system",
        text: `[Tool Call] ${name}(${JSON.stringify(args)})`,
        ts: Date.now(),
      });

      if (SLOW_TOOLS.has(name)) {
        // Slow tool handling depends on context:
        // - During presentation: await result (so voice waits for action to complete)
        // - During normal conversation: acknowledge immediately, execute async
        const awaitSlow = this._presentationMode;

        if (awaitSlow) {
          // Presentation mode: await the slow tool so voice and screen stay in sync
          console.log(`[Voice] Slow tool ${name} — awaiting (presentation mode)`);
          let result = "Action completed.";
          if (this.onToolCall) {
            try {
              result = await this.onToolCall(name, args, call_id);
            } catch (e: any) {
              result = `Error: ${e.message}`;
            }
          }
          this.client.submitToolResult(call_id, result);
          this.context.addTranscript({
            role: "system",
            text: `[Tool Result] ${name}: ${result.slice(0, 200)}`,
            ts: Date.now(),
          });
        } else {
          // Normal conversation: background result pattern (inspired by OpenAI Agents SDK)
          // 1. Submit tool result WITHOUT triggering response (backgroundResult)
          this.client.submitToolResultBackground(call_id, "ok");

          // 2. Let the model generate a natural filler phrase ("让我查一下..." / "One moment...")
          if (this.client.providerName === "gemini") {
            // Gemini auto-responds to context; response.create is a no-op
            this.client.injectContext(`[SYSTEM] You just started the "${name}" tool. Briefly acknowledge you're working on it, one short sentence.`);
          } else {
            // OpenAI / Grok: response.create with instructions for contextual filler
            this.client.sendEvent("response.create", {
              response: {
                instructions: `You just called the "${name}" tool. Briefly and naturally acknowledge you're working on it. One short sentence. Match the conversation language.`,
              },
            });
          }

          // 3. Execute async — inject result when ready, then trigger model to continue
          if (this.onToolCall) {
            this.onToolCall(name, args, call_id).then((result) => {
              this.injectContext(`[DONE] ${name}: ${result.slice(0, 200)}`);
              this.context.addTranscript({
                role: "system",
                text: `[Tool Result] ${name}: ${result.slice(0, 200)}`,
                ts: Date.now(),
              });
              // Auto-inject screenshot if this was a visual tool (perception-action loop)
              this._feedbackScreenshot(name).catch(() => {});
              // Trigger model to process the result and decide next action.
              // Without this, the model sees the context but won't speak or call another tool.
              // This is what closes the agent loop for slow tools.
              this.client.sendEvent("response.create", {});
              console.log(`[Voice] Slow tool ${name} completed async → triggered response`);
            }).catch((e: any) => {
              this.injectContext(`[ERROR] ${name} failed: ${e.message}`);
              this.context.addTranscript({
                role: "system",
                text: `[Tool Result] ${name}: Error: ${e.message}`,
                ts: Date.now(),
              });
              this.client.sendEvent("response.create", {});
              console.error(`[Voice] Slow tool ${name} failed → triggered response:`, e.message);
            });
          }
        }
      } else {
        // Fast tool — await inline (existing behavior)
        let result = "No handler registered";
        if (this.onToolCall) {
          try {
            result = await this.onToolCall(name, args, call_id);
          } catch (e: any) {
            result = `Error: ${e.message}`;
          }
        }

        this.client.submitToolResult(call_id, result);

        // Auto-inject screenshot if this was a visual tool
        this._feedbackScreenshot(name).catch(() => {});

        // Record result in transcript
        this.context.addTranscript({
          role: "system",
          text: `[Tool Result] ${name}: ${result.slice(0, 200)}`,
          ts: Date.now(),
        });
      }
    });
  }

  /** Feed recent transcript entries to RealtimeClient for reconnect context replay */
  private _feedTranscriptContext() {
    const recent = this.context.getRecentTranscript(20);
    this.client.updateTranscriptContext(
      recent.map((e) => ({ role: e.role, text: e.text }))
    );
  }

  /**
   * Start the voice session.
   * @param instructions System prompt (optional — uses default if not provided)
   * @param provider Which voice provider to use (optional — uses CONFIG.voiceProvider)
   */
  async start(instructions?: string, provider?: VoiceProviderName) {
    this._provider = provider || CONFIG.voiceProvider;

    // Validate API key for selected provider
    if (this._provider === "gemini") {
      if (!CONFIG.gemini.apiKey) {
        throw new Error("Google AI API key not configured (set GOOGLE_AI_API_KEY in .env)");
      }
    } else if (this._provider === "grok") {
      if (!CONFIG.grok.apiKey) {
        throw new Error("Grok API key not configured (set XAI_API_KEY in .env)");
      }
    } else {
      if (!CONFIG.openai.apiKey) {
        throw new Error("OpenAI API key not configured");
      }
    }

    const systemPrompt =
      instructions ||
      `You are CallingClaw, an AI meeting assistant with voice, vision, and computer control capabilities.
You can:
- Schedule and join Google Meet meetings
- See the user's screen and understand what's happening
- Control the computer (click, type, scroll) to help with presentations
- Take meeting notes and track action items

Speak naturally and concisely. When you perform actions, briefly narrate what you're doing.`;

    this._lastInstructions = systemPrompt;
    await this.client.connect(systemPrompt, this._provider);
    console.log(`[Voice] Session started (provider: ${this._provider})`);
  }

  /**
   * Dynamically update the Voice AI's system instructions.
   * Only works while a session is active.
   */
  updateInstructions(instructions: string): boolean {
    if (!this.client.connected) return false;
    this._lastInstructions = instructions;
    return this.client.updateInstructions(instructions);
  }

  /** Get the last system instructions sent to the Voice AI */
  getLastInstructions(): string {
    return this._lastInstructions;
  }

  /** Get all registered tools (the full set, regardless of what's active on the session) */
  getAllTools(): RealtimeTool[] {
    return [...this._allTools];
  }

  /**
   * Update which tools are active on the Realtime session.
   * Used by TranscriptAuditor to remove automation tools during meetings.
   */
  setActiveTools(tools: RealtimeTool[]): boolean {
    if (!this.client.connected) return false;
    return this.client.updateTools(tools);
  }

  /** Restore all tools to the session (call when meeting ends) */
  restoreAllTools(): boolean {
    return this.setActiveTools([...this._allTools]);
  }

  // ── Incremental Context Injection ─────────────────────────────────

  /**
   * Inject context into the live voice session as a system message.
   * Does NOT interrupt the current response or trigger a new one.
   * Uses conversation.item.create instead of session.update to avoid audio breaks.
   *
   * @param text - Context text (e.g., "[CONTEXT] PRD目标是..." or "[DONE] 已打开文件")
   * @returns The item ID if sent, false if not connected
   */
  injectContext(text: string): string | false {
    if (!this.client.connected) return false;
    return this.client.injectContext(text);
  }

  /**
   * Inject context with a fixed ID — replaces previous injection with the same ID.
   * Used for page DOM context that should show only the LATEST state,
   * not accumulate in the FIFO queue.
   */
  replaceContext(text: string, id: string): string | false {
    if (!this.client.connected) return false;
    this.client.removeContext(id);
    return this.client.injectContext(text, id);
  }

  /**
   * Inject a screenshot into the voice model's conversation.
   * Provider-aware: openai15/gemini get actual images, others get text caption.
   *
   * @param base64Jpeg - Base64-encoded JPEG (no data: prefix needed)
   * @param caption - Optional text description alongside the image
   * @returns The item ID if sent, false if not connected
   */
  injectScreenshot(base64Jpeg: string, caption?: string): string | false {
    if (!this.client.connected) return false;
    return this.client.injectImage(base64Jpeg, caption);
  }

  /**
   * Remove a previously injected context item by ID.
   * @returns true if the delete was sent
   */
  removeContext(itemId: string): boolean {
    if (!this.client.connected) return false;
    return this.client.removeContext(itemId);
  }

  /** Get the current context injection queue (for debugging/status) */
  getContextQueue(): readonly ContextItem[] {
    return this.client.getContextQueue();
  }

  /** Dynamically change the voice on the live session */
  setVoice(voice: string): boolean {
    if (!this.client.connected) return false;
    return this.client.updateVoice(voice);
  }

  /**
   * Stop the voice session (intentional disconnect — no auto-reconnect)
   */
  stop() {
    this.client.disconnect();
    this._setAudioState("idle");
  }

  /**
   * Send audio chunk from Python sidecar
   */
  sendAudio(base64Pcm: string) {
    if (this.client.connected) {
      this.client.sendAudio(base64Pcm);
    }
  }

  /**
   * Send text message to voice AI
   */
  sendText(text: string) {
    this.context.addTranscript({ role: "user", text, ts: Date.now() });
    this.client.sendText(text);
  }

  /**
   * Present a slide — inject talking points as system context, then trigger AI to speak.
   * Unlike sendText() (role:"user" → AI responds TO it), this uses role:"system"
   * so the AI presents FROM the content in its own words.
   */
  presentSlide(text: string, sectionTitle?: string) {
    this.context.addTranscript({ role: "system", text: `[Slide] ${(sectionTitle || text).slice(0, 100)}...`, ts: Date.now() });
    // Use replaceContext with fixed ID — only one slide in context at a time (EXP-7C finding)
    this.replaceContext(
      `[PRESENT NOW] ${sectionTitle ? sectionTitle + "\n\n" : ""}${text}`,
      "ctx_current_slide"
    );
    this.client.sendEvent("response.create", {});
  }

  /**
   * Wait for current speech to complete.
   * Resolves when audioState transitions from "speaking" to "listening" or "idle",
   * or when timeoutMs elapses (fallback for missed events).
   * Used by PresentationEngine to wait for actual speech completion instead of fixed timers.
   */
  waitForSpeechDone(timeoutMs: number = 30000): Promise<void> {
    return new Promise((resolve) => {
      // Already not speaking — resolve immediately
      if (this._audioState !== "speaking" && this._audioState !== "thinking") {
        resolve();
        return;
      }

      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };

      // Listen for state change to listening/idle
      const checkInterval = setInterval(() => {
        if (this._audioState === "listening" || this._audioState === "idle") {
          clearInterval(checkInterval);
          done();
        }
      }, 200);

      // Timeout fallback
      setTimeout(() => {
        clearInterval(checkInterval);
        done();
      }, timeoutMs);
    });
  }

  /**
   * Send a raw Realtime API event (passthrough to client).
   * Used for conversation.item.create (caption injection) etc.
   */
  sendEvent(eventName: string, payload: any) {
    if (this.client.connected) {
      this.client.sendEvent(eventName, payload);
    }
  }

  /**
   * Get the underlying client for audio output forwarding.
   * Event name is normalized — works for both providers.
   */
  onAudioOutput(handler: (base64Pcm: string) => void) {
    this.client.on("response.audio.delta", (event) => {
      handler(event.delta);
    });
  }

  /**
   * Register handler for user speech interruption.
   * Called when VAD detects user started speaking — cancel AI response + stop playback.
   * The actual interrupt logic (response.cancel, heard-transcript truncation, state machine)
   * runs in setupEventHandlers(); this just registers the external callback.
   */
  onSpeechStarted(handler: () => void) {
    this._onSpeechStarted = handler;
  }

  /**
   * Register screen capture callback for post-tool visual feedback.
   * After visual tools (interact, scroll, navigate, open_file, share_screen) complete,
   * this callback is called to capture a screenshot and inject it to the voice model.
   * This closes the perception-action loop: model sees result of its actions.
   */
  onScreenCapture(handler: () => Promise<{ screenshot: string; caption: string } | null>) {
    this._onScreenCapture = handler;
  }

  /** Tools that change what's on screen — trigger screenshot feedback after completion */
  private static VISUAL_TOOLS = new Set([
    "interact", "browser_action", "share_screen", "open_file",
    "scroll_page", "click_element", "navigate", "exec",
  ]);

  /** Auto-inject screenshot after a visual tool completes */
  private async _feedbackScreenshot(toolName: string): Promise<void> {
    if (!this._onScreenCapture || !VoiceModule.VISUAL_TOOLS.has(toolName)) return;
    try {
      const result = await this._onScreenCapture();
      if (result?.screenshot) {
        this.injectScreenshot(result.screenshot, `[SCREEN_UPDATE] after ${toolName}: ${result.caption}`);
        console.log(`[Voice] Post-tool screenshot injected (${toolName})`);
      }
    } catch (e: any) {
      // Non-fatal — screenshot feedback is best-effort
      console.warn(`[Voice] Post-tool screenshot failed: ${e.message}`);
    }
  }
}
