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

export type AudioState = "idle" | "listening" | "speaking" | "interrupted" | "thinking";

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

  // Heard transcript tracking (interruption truncation)
  private _currentResponseAudioSamples = 0;  // Total samples received from provider
  private _currentResponseStartTime = 0;      // When first audio chunk arrived
  private _currentResponseTranscript = "";     // Accumulated transcript for heard tracking

  // External callback for speech-started (registered via onSpeechStarted())
  private _onSpeechStarted?: () => void;

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
              this.context.addTranscript({
                role: "system",
                text: `[HEARD] AI was interrupted. User heard: "${heardText.slice(0, 100)}..."`,
                ts: Date.now(),
              });
            }
            console.log(`[Voice] Interrupt: heard ${Math.round(heardRatio * 100)}% of response (${heardText.length}/${this._currentResponseTranscript.length} chars)`);
          }
        }
      }

      // Cancel in-progress AI response
      this.client.sendEvent("response.cancel", {});

      // Fire external speech-started callback
      if (this._onSpeechStarted) this._onSpeechStarted();
    });

    // ── Audio State: Response created → thinking ──
    this.client.on("response.created", () => {
      this._setAudioState("thinking");
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

      // First audio chunk → transition to speaking
      if (this._audioState !== "speaking") {
        this._setAudioState("speaking");
      }
    });

    // ── Audio State: Response audio done → listening ──
    this.client.on("response.audio.done", () => {
      this._setAudioState("listening");
    });

    this.client.on("response.done", () => {
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

      // Record in transcript
      this.context.addTranscript({
        role: "system",
        text: `[Tool Call] ${name}(${JSON.stringify(args)})`,
        ts: Date.now(),
      });

      let result = "No handler registered";
      if (this.onToolCall) {
        try {
          result = await this.onToolCall(name, args, call_id);
        } catch (e: any) {
          result = `Error: ${e.message}`;
        }
      }

      this.client.submitToolResult(call_id, result);

      // Record result in transcript
      this.context.addTranscript({
        role: "system",
        text: `[Tool Result] ${name}: ${result.slice(0, 200)}`,
        ts: Date.now(),
      });
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
    if (this._provider === "grok") {
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
}
