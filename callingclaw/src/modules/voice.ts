// CallingClaw 2.0 — Module 2: Voice (OpenAI Realtime)
// Handles: real-time voice conversation, live transcript, tool calls
// Produces: transcript entries → SharedContext
// Does NOT do: screen analysis or computer use (separate modules)

import { RealtimeClient, type RealtimeTool } from "../ai_gateway/realtime_client";
import type { SharedContext } from "./shared-context";
import { CONFIG } from "../config";

export interface VoiceModuleOptions {
  context: SharedContext;
  systemInstructions?: string;
  tools?: RealtimeTool[];
  onToolCall?: (name: string, args: any, callId: string) => Promise<string>;
}

export class VoiceModule {
  private client: RealtimeClient;
  private context: SharedContext;
  private onToolCall?: VoiceModuleOptions["onToolCall"];
  private _transcriptBuffer = "";
  private _lastInstructions = "";
  private _allTools: RealtimeTool[] = [];  // Full tool set (immutable reference)

  get connected() {
    return this.client.connected;
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

    this.setupEventHandlers();
  }

  private setupEventHandlers() {
    // ── Live Transcript: User speech ──
    this.client.on("conversation.item.input_audio_transcription.completed", (event) => {
      if (event.transcript) {
        this.context.addTranscript({
          role: "user",
          text: event.transcript,
          ts: Date.now(),
        });
        console.log(`[Voice] User: ${event.transcript}`);
      }
    });

    // ── Live Transcript: AI speech ──
    this.client.on("response.audio_transcript.delta", (event) => {
      this._transcriptBuffer += event.delta || "";
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
      }
      this._transcriptBuffer = "";
    });

    // ── Tool Calls ──
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

  /**
   * Start the voice session
   */
  async start(instructions?: string) {
    if (!CONFIG.openai.apiKey) {
      throw new Error("OpenAI API key not configured");
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
    await this.client.connect(systemPrompt);
  }

  /**
   * Dynamically update the Voice AI's system instructions (e.g. when pinned context changes).
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
   * Update which tools are active on the OpenAI Realtime session.
   * Used by TranscriptAuditor to remove automation tools during meetings.
   */
  setActiveTools(tools: RealtimeTool[]): boolean {
    if (!this.client.connected) return false;
    return this.client.updateTools(tools);
  }

  /** Restore all tools to the OpenAI session (call when meeting ends) */
  restoreAllTools(): boolean {
    return this.setActiveTools([...this._allTools]);
  }

  /** Dynamically change the voice on the live session */
  setVoice(voice: string): boolean {
    if (!this.client.connected) return false;
    return this.client.updateVoice(voice);
  }

  /**
   * Stop the voice session
   */
  stop() {
    this.client.disconnect();
  }

  /**
   * Send audio chunk from Python sidecar to OpenAI
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
   * Get the underlying client for audio output forwarding
   */
  onAudioOutput(handler: (base64Pcm: string) => void) {
    this.client.on("response.audio.delta", (event) => {
      handler(event.delta);
    });
  }
}
