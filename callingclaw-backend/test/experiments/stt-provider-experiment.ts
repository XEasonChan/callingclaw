// STT Provider Experiment — Pluggable Speech-to-Text for CallingClaw
//
// Context:
//   CallingClaw currently uses OpenAI Realtime API which bundles STT + TTS + LLM
//   into a single WebSocket connection. This experiment explores decoupling STT
//   so we can:
//     1. Use cheaper/faster STT providers for transcription-only scenarios
//     2. Compare accuracy across providers (esp. for Chinese + English mixed speech)
//     3. Enable STT without requiring a full Realtime API session
//
// Audio flow in CallingClaw:
//   Chrome (Meet) → addInitScript intercepts RTCPeerConnection → captures remote audio
//   → PCM16 24kHz mono → base64 → WebSocket ws://localhost:4000/ws/voice-test
//   → backend receives { type: "audio", audio: "<base64>" }
//   → currently forwarded to RealtimeClient.sendAudio(base64)
//
// This experiment defines a provider interface that sits between the audio capture
// and the voice AI, allowing any STT backend to consume the same PCM16 stream.
//
// Reference: Clicky (macOS app) uses BuddyTranscriptionProvider protocol with
//   AssemblyAI (streaming WS), OpenAI (upload), and Apple Speech (local).
//   We adapt the same pattern to TypeScript/Bun.

import { test, expect } from "bun:test";

// ═══════════════════════════════════════════════════════════════════
//  STT Provider Interface
// ═══════════════════════════════════════════════════════════════════

export interface STTTranscriptEvent {
  /** The transcribed text (partial or final) */
  text: string;
  /** Whether this is a finalized transcript (vs. interim/partial) */
  isFinal: boolean;
  /** Confidence score 0-1, if available from the provider */
  confidence?: number;
  /** Provider-specific metadata */
  metadata?: Record<string, unknown>;
}

export type STTTranscriptCallback = (event: STTTranscriptEvent) => void;
export type STTErrorCallback = (error: Error) => void;

export interface STTProvider {
  /** Human-readable provider name for logging */
  readonly name: string;

  /**
   * Start the STT session. Must be called before sendAudio().
   * For streaming providers, this opens the WebSocket connection.
   * For upload-based providers, this initializes the audio buffer.
   */
  start(): Promise<void>;

  /**
   * Stop the STT session and finalize any pending transcription.
   * For streaming providers, this closes the WebSocket.
   * For upload-based providers, this triggers the upload + transcription.
   */
  stop(): Promise<void>;

  /**
   * Register a callback for transcript events (both partial and final).
   * Can be called before start(). Multiple callbacks are supported.
   */
  onTranscript(callback: STTTranscriptCallback): void;

  /**
   * Register a callback for errors.
   * Can be called before start(). Multiple callbacks are supported.
   */
  onError(callback: STTErrorCallback): void;

  /**
   * Send an audio chunk to the STT provider.
   * @param pcm16 - Raw PCM16 audio data (mono, sample rate depends on provider)
   *
   * CallingClaw canonical format: 24kHz PCM16 mono.
   * Providers that need different rates (e.g. 16kHz) must resample internally.
   */
  sendAudio(pcm16: Buffer): void;
}

// ═══════════════════════════════════════════════════════════════════
//  Shared Utilities
// ═══════════════════════════════════════════════════════════════════

/**
 * Downsample PCM16 audio from sourceRate to targetRate using linear interpolation.
 * CallingClaw captures at 24kHz; AssemblyAI and OpenAI Whisper expect 16kHz.
 */
function downsamplePCM16(input: Buffer, sourceRate: number, targetRate: number): Buffer {
  if (sourceRate === targetRate) return input;
  if (sourceRate < targetRate) {
    throw new Error(`Upsampling not supported: ${sourceRate} → ${targetRate}`);
  }

  const inputSamples = input.length / 2; // 2 bytes per PCM16 sample
  const ratio = sourceRate / targetRate;
  const outputSamples = Math.floor(inputSamples / ratio);
  const output = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const srcIndex = i * ratio;
    const srcFloor = Math.floor(srcIndex);
    const srcCeil = Math.min(srcFloor + 1, inputSamples - 1);
    const fraction = srcIndex - srcFloor;

    const sampleFloor = input.readInt16LE(srcFloor * 2);
    const sampleCeil = input.readInt16LE(srcCeil * 2);
    const interpolated = Math.round(sampleFloor + (sampleCeil - sampleFloor) * fraction);

    output.writeInt16LE(Math.max(-32768, Math.min(32767, interpolated)), i * 2);
  }

  return output;
}

/**
 * Build a WAV file header + data from raw PCM16 mono audio.
 * Used by upload-based STT providers (OpenAI Whisper) that need a file format.
 */
function buildWavBuffer(pcm16Data: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const dataSize = pcm16Data.length;
  const fileSize = 36 + dataSize;

  // RIFF header
  header.write("RIFF", 0);
  header.writeUInt32LE(fileSize, 4);
  header.write("WAVE", 8);

  // fmt chunk
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);       // chunk size
  header.writeUInt16LE(1, 20);        // PCM format
  header.writeUInt16LE(1, 22);        // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);  // byte rate (sampleRate * channels * bitsPerSample/8)
  header.writeUInt16LE(2, 32);        // block align (channels * bitsPerSample/8)
  header.writeUInt16LE(16, 34);       // bits per sample

  // data chunk
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm16Data]);
}

// ═══════════════════════════════════════════════════════════════════
//  Provider 1: OpenAI Whisper (Upload-based)
// ═══════════════════════════════════════════════════════════════════
//
// How it works:
//   - Buffers all PCM16 audio during the session
//   - On stop(), builds a WAV file and uploads to OpenAI /v1/audio/transcriptions
//   - Returns a single final transcript
//
// Pros: High accuracy, supports many languages, prompt-guided vocabulary
// Cons: Not real-time (must wait for stop()), upload latency, cost per request
//
// Reference: Clicky's OpenAIAudioTranscriptionProvider.swift

export class OpenAIWhisperSTTProvider implements STTProvider {
  readonly name = "OpenAI Whisper";

  private apiKey: string;
  private model: string;
  private language: string;
  private prompt?: string;
  private buffer: Buffer[] = [];
  private transcriptCallbacks: STTTranscriptCallback[] = [];
  private errorCallbacks: STTErrorCallback[] = [];
  private started = false;

  constructor(opts: {
    apiKey?: string;
    model?: string;
    language?: string;
    /** Vocabulary hint for the model (technical terms, proper nouns) */
    prompt?: string;
  } = {}) {
    // If apiKey is explicitly passed (even as ""), use it. Otherwise fall back to env.
    this.apiKey = opts.apiKey !== undefined ? opts.apiKey : (process.env.OPENAI_API_KEY || "");
    this.model = opts.model || "gpt-4o-transcribe";
    this.language = opts.language || "zh";
    this.prompt = opts.prompt;
  }

  onTranscript(callback: STTTranscriptCallback): void {
    this.transcriptCallbacks.push(callback);
  }

  onError(callback: STTErrorCallback): void {
    this.errorCallbacks.push(callback);
  }

  async start(): Promise<void> {
    if (!this.apiKey) {
      throw new Error("OpenAI API key not configured. Set OPENAI_API_KEY env var.");
    }
    this.buffer = [];
    this.started = true;
  }

  sendAudio(pcm16: Buffer): void {
    if (!this.started) return;
    this.buffer.push(pcm16);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    const totalPcm16 = Buffer.concat(this.buffer);
    this.buffer = [];

    if (totalPcm16.length === 0) {
      this._emitTranscript({ text: "", isFinal: true });
      return;
    }

    // Downsample 24kHz → 16kHz for Whisper (better accuracy at lower sample rate)
    const downsampled = downsamplePCM16(totalPcm16, 24000, 16000);
    const wavData = buildWavBuffer(downsampled, 16000);

    try {
      const transcript = await this._uploadAndTranscribe(wavData);
      this._emitTranscript({ text: transcript, isFinal: true, confidence: 1.0 });
    } catch (err) {
      this._emitError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private async _uploadAndTranscribe(wavData: Buffer): Promise<string> {
    const boundary = `----BunBoundary${Date.now()}`;

    // Build multipart form data
    let body = "";
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="model"\r\n\r\n${this.model}\r\n`;
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="language"\r\n\r\n${this.language}\r\n`;
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="response_format"\r\n\r\njson\r\n`;

    if (this.prompt) {
      body += `--${boundary}\r\n`;
      body += `Content-Disposition: form-data; name="prompt"\r\n\r\n${this.prompt}\r\n`;
    }

    // File part needs binary handling
    const preFile = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n` +
      `Content-Type: audio/wav\r\n\r\n`
    );
    const postFile = Buffer.from(`\r\n--${boundary}--\r\n`);
    const fullBody = Buffer.concat([Buffer.from(body), preFile, wavData, postFile]);

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body: fullBody,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI Whisper API error (${response.status}): ${errorText}`);
    }

    const result = (await response.json()) as { text: string };
    return result.text.trim();
  }

  private _emitTranscript(event: STTTranscriptEvent): void {
    for (const cb of this.transcriptCallbacks) cb(event);
  }

  private _emitError(error: Error): void {
    for (const cb of this.errorCallbacks) cb(error);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Provider 2: AssemblyAI (Streaming WebSocket)
// ═══════════════════════════════════════════════════════════════════
//
// How it works:
//   - Opens a WebSocket to wss://streaming.assemblyai.com/v3/ws
//   - Streams raw PCM16 binary frames in real-time
//   - Receives partial + final transcript events via JSON messages
//   - Uses "turn"-based message format (v3 API with format_turns=true)
//
// Pros: Real-time streaming, low latency, turn-based transcript assembly
// Cons: Requires API key, no free tier for streaming
//
// Reference: Clicky's AssemblyAIStreamingTranscriptionProvider.swift
// Key learning from Clicky: share a single URLSession/WebSocket across sessions
// to avoid "Socket is not connected" errors from connection pool corruption.

const WsWebSocket = require("ws");

export class AssemblyAISTTProvider implements STTProvider {
  readonly name = "AssemblyAI Streaming";

  private apiKey: string;
  private sampleRate: number;
  private keyterms: string[];
  private ws: InstanceType<typeof WsWebSocket> | null = null;
  private transcriptCallbacks: STTTranscriptCallback[] = [];
  private errorCallbacks: STTErrorCallback[] = [];
  private started = false;

  // Turn tracking (mirrors Clicky's AssemblyAIStreamingTranscriptionSession)
  private activeTurnOrder: number | null = null;
  private activeTurnText = "";
  private storedTurns = new Map<number, { text: string; isFormatted: boolean }>();

  constructor(opts: {
    apiKey?: string;
    /** Sample rate to send to AssemblyAI (default 16000) */
    sampleRate?: number;
    /** Vocabulary hints for better recognition */
    keyterms?: string[];
  } = {}) {
    // If apiKey is explicitly passed (even as ""), use it. Otherwise fall back to env.
    this.apiKey = opts.apiKey !== undefined ? opts.apiKey : (process.env.ASSEMBLYAI_API_KEY || "");
    this.sampleRate = opts.sampleRate || 16000;
    this.keyterms = opts.keyterms || [];
  }

  onTranscript(callback: STTTranscriptCallback): void {
    this.transcriptCallbacks.push(callback);
  }

  onError(callback: STTErrorCallback): void {
    this.errorCallbacks.push(callback);
  }

  async start(): Promise<void> {
    if (!this.apiKey) {
      throw new Error("AssemblyAI API key not configured. Set ASSEMBLYAI_API_KEY env var.");
    }

    this.activeTurnOrder = null;
    this.activeTurnText = "";
    this.storedTurns.clear();

    const wsUrl = this._buildWebSocketUrl();

    return new Promise<void>((resolve, reject) => {
      this.ws = new WsWebSocket(wsUrl, {
        headers: {
          Authorization: this.apiKey,
        },
      });

      const connectionTimeout = setTimeout(() => {
        reject(new Error("AssemblyAI WebSocket connection timed out (10s)"));
        this.ws?.close();
      }, 10_000);

      this.ws!.on("open", () => {
        console.log(`[STT:AssemblyAI] WebSocket connected`);
      });

      this.ws!.on("message", (data: Buffer | string) => {
        try {
          const msg = JSON.parse(typeof data === "string" ? data : data.toString());
          this._handleMessage(msg, resolve, reject, connectionTimeout);
        } catch (err) {
          // Ignore parse errors for binary frames
        }
      });

      this.ws!.on("error", (err: Error) => {
        clearTimeout(connectionTimeout);
        console.error(`[STT:AssemblyAI] WebSocket error:`, err.message);
        this._emitError(err);
        reject(err);
      });

      this.ws!.on("close", () => {
        console.log(`[STT:AssemblyAI] WebSocket closed`);
        this.started = false;
      });
    });
  }

  sendAudio(pcm16: Buffer): void {
    if (!this.started || !this.ws || this.ws.readyState !== WsWebSocket.OPEN) return;

    // Downsample 24kHz → 16kHz for AssemblyAI
    const downsampled = downsamplePCM16(pcm16, 24000, this.sampleRate);

    // AssemblyAI v3 streaming accepts raw binary PCM16 frames
    this.ws.send(downsampled);
  }

  async stop(): Promise<void> {
    if (!this.started || !this.ws) return;
    this.started = false;

    // Request final transcript before closing
    try {
      this.ws.send(JSON.stringify({ type: "ForceEndpoint" }));
    } catch {
      // WebSocket may already be closed
    }

    // Give it a moment to flush, then terminate
    await new Promise<void>((resolve) => {
      const closeTimeout = setTimeout(() => {
        this.ws?.close();
        resolve();
      }, 2000);

      // If we get a termination message, resolve immediately
      const originalHandler = this.ws!.onmessage;
      this.ws!.on("message", (data: Buffer | string) => {
        try {
          const msg = JSON.parse(typeof data === "string" ? data : data.toString());
          if (msg.type?.toLowerCase() === "termination") {
            clearTimeout(closeTimeout);
            this.ws?.close();
            resolve();
          }
        } catch {
          // Ignore
        }
      });
    });
  }

  private _buildWebSocketUrl(): string {
    const params = new URLSearchParams({
      sample_rate: String(this.sampleRate),
      encoding: "pcm_s16le",
      format_turns: "true",
      speech_model: "u3-rt-pro",
    });

    if (this.keyterms.length > 0) {
      params.set("keyterms_prompt", JSON.stringify(this.keyterms));
    }

    return `wss://streaming.assemblyai.com/v3/ws?${params.toString()}`;
  }

  private _handleMessage(
    msg: any,
    resolveStart?: (value: void) => void,
    rejectStart?: (reason: Error) => void,
    connectionTimeout?: NodeJS.Timeout,
  ): void {
    const type = (msg.type || "").toLowerCase();

    switch (type) {
      case "begin":
        // Session is ready, resolve the start() promise
        if (connectionTimeout) clearTimeout(connectionTimeout);
        this.started = true;
        resolveStart?.();
        break;

      case "turn":
        this._handleTurnMessage(msg);
        break;

      case "termination":
        // Session ended on server side
        this.started = false;
        break;

      case "error":
        const errorMsg = msg.error || msg.message || "AssemblyAI returned an error";
        const error = new Error(errorMsg);
        if (connectionTimeout) clearTimeout(connectionTimeout);
        this._emitError(error);
        rejectStart?.(error);
        break;

      default:
        // Ignore unknown message types
        break;
    }
  }

  /**
   * Handle turn-based transcript messages from AssemblyAI v3.
   * Mirrors the turn tracking logic from Clicky's AssemblyAIStreamingTranscriptionSession.
   */
  private _handleTurnMessage(msg: any): void {
    const text = (msg.transcript || "").trim();
    const turnOrder = msg.turn_order ?? this.activeTurnOrder ?? this._nextTurnOrder();
    const isEndOfTurn = msg.end_of_turn === true;
    const isFormatted = msg.turn_is_formatted === true;

    if (isEndOfTurn || isFormatted) {
      // Store finalized turn
      this.activeTurnOrder = null;
      this.activeTurnText = "";
      if (text) {
        const existing = this.storedTurns.get(turnOrder);
        // Don't overwrite formatted turn with unformatted
        if (!existing || !existing.isFormatted || isFormatted) {
          this.storedTurns.set(turnOrder, { text, isFormatted });
        }
      }
    } else {
      // Active (partial) turn
      this.activeTurnOrder = turnOrder;
      this.activeTurnText = text;
    }

    // Compose full transcript from all turns + active partial
    const fullText = this._composeFullTranscript();

    if (fullText) {
      this._emitTranscript({
        text: fullText,
        isFinal: isEndOfTurn || isFormatted,
        metadata: { turnOrder, isEndOfTurn, isFormatted },
      });
    }
  }

  private _composeFullTranscript(): string {
    const turnTexts = Array.from(this.storedTurns.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([_, turn]) => turn.text)
      .filter((t) => t.length > 0);

    if (this.activeTurnText.trim()) {
      turnTexts.push(this.activeTurnText.trim());
    }

    return turnTexts.join(" ");
  }

  private _nextTurnOrder(): number {
    const maxOrder = Math.max(-1, ...Array.from(this.storedTurns.keys()));
    return maxOrder + 1;
  }

  private _emitTranscript(event: STTTranscriptEvent): void {
    for (const cb of this.transcriptCallbacks) cb(event);
  }

  private _emitError(error: Error): void {
    for (const cb of this.errorCallbacks) cb(error);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Provider 3: DeepgramSTTProvider (Streaming WebSocket)
// ═══════════════════════════════════════════════════════════════════
//
// Stub for future implementation. Deepgram is a strong contender:
//   - Nova-2 model: excellent multilingual support
//   - WebSocket streaming with interim results
//   - Smart formatting, punctuation, speaker diarization
//   - Competitive pricing
//
// Would follow the same pattern as AssemblyAISTTProvider.

// ═══════════════════════════════════════════════════════════════════
//  Test Harness
// ═══════════════════════════════════════════════════════════════════

/**
 * Generate a synthetic PCM16 audio buffer containing a sine wave.
 * Useful for testing audio pipeline mechanics without a real microphone.
 */
function generateSineWavePCM16(
  durationSeconds: number,
  frequencyHz: number,
  sampleRate: number,
): Buffer {
  const numSamples = Math.floor(sampleRate * durationSeconds);
  const buffer = Buffer.alloc(numSamples * 2);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * frequencyHz * t) * 0.8;
    const pcm16 = Math.round(sample * 32767);
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, pcm16)), i * 2);
  }

  return buffer;
}

/**
 * Load a raw PCM16 file from disk (if testing with real audio recordings).
 * CallingClaw saves captured audio in this format during debug sessions.
 */
async function loadPCM16File(filePath: string): Promise<Buffer | null> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return null;
    const arrayBuf = await file.arrayBuffer();
    return Buffer.from(arrayBuf);
  } catch {
    return null;
  }
}

// ── Unit Tests ────────────────────────────────────────────────────

test("STTProvider interface — OpenAIWhisperSTTProvider implements interface", () => {
  const provider: STTProvider = new OpenAIWhisperSTTProvider({ apiKey: "test-key" });
  expect(provider.name).toBe("OpenAI Whisper");
  expect(typeof provider.start).toBe("function");
  expect(typeof provider.stop).toBe("function");
  expect(typeof provider.sendAudio).toBe("function");
  expect(typeof provider.onTranscript).toBe("function");
  expect(typeof provider.onError).toBe("function");
});

test("STTProvider interface — AssemblyAISTTProvider implements interface", () => {
  const provider: STTProvider = new AssemblyAISTTProvider({ apiKey: "test-key" });
  expect(provider.name).toBe("AssemblyAI Streaming");
  expect(typeof provider.start).toBe("function");
  expect(typeof provider.stop).toBe("function");
  expect(typeof provider.sendAudio).toBe("function");
  expect(typeof provider.onTranscript).toBe("function");
  expect(typeof provider.onError).toBe("function");
});

test("downsamplePCM16 — 24kHz to 16kHz produces correct length", () => {
  // 1 second of 24kHz audio = 24000 samples = 48000 bytes
  const input = generateSineWavePCM16(1.0, 440, 24000);
  expect(input.length).toBe(48000);

  const output = downsamplePCM16(input, 24000, 16000);
  // 1 second of 16kHz audio = 16000 samples = 32000 bytes
  expect(output.length).toBe(32000);
});

test("downsamplePCM16 — same rate returns same buffer", () => {
  const input = generateSineWavePCM16(0.5, 440, 16000);
  const output = downsamplePCM16(input, 16000, 16000);
  expect(output).toBe(input); // Same reference
});

test("buildWavBuffer — produces valid WAV header", () => {
  const pcm16 = generateSineWavePCM16(0.1, 440, 16000);
  const wav = buildWavBuffer(pcm16, 16000);

  // WAV header is 44 bytes
  expect(wav.length).toBe(44 + pcm16.length);

  // Check RIFF header
  expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
  expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
  expect(wav.toString("ascii", 12, 16)).toBe("fmt ");
  expect(wav.toString("ascii", 36, 40)).toBe("data");

  // Check format: PCM, mono, 16kHz, 16-bit
  expect(wav.readUInt16LE(20)).toBe(1);     // PCM format
  expect(wav.readUInt16LE(22)).toBe(1);     // mono
  expect(wav.readUInt32LE(24)).toBe(16000); // sample rate
  expect(wav.readUInt16LE(34)).toBe(16);    // bits per sample
});

test("OpenAIWhisperSTTProvider — buffers audio during session", async () => {
  const provider = new OpenAIWhisperSTTProvider({ apiKey: "test-key" });
  const events: STTTranscriptEvent[] = [];
  provider.onTranscript((e) => events.push(e));

  await provider.start();

  // Send some audio chunks
  const chunk = generateSineWavePCM16(0.1, 440, 24000);
  provider.sendAudio(chunk);
  provider.sendAudio(chunk);
  provider.sendAudio(chunk);

  // No transcript events yet (upload-based, needs stop() to trigger)
  expect(events.length).toBe(0);
});

test("OpenAIWhisperSTTProvider — stop with empty buffer emits empty final", async () => {
  const provider = new OpenAIWhisperSTTProvider({ apiKey: "test-key" });
  const events: STTTranscriptEvent[] = [];
  provider.onTranscript((e) => events.push(e));

  await provider.start();
  await provider.stop();

  expect(events.length).toBe(1);
  expect(events[0].text).toBe("");
  expect(events[0].isFinal).toBe(true);
});

test("OpenAIWhisperSTTProvider — requires API key on start", async () => {
  const provider = new OpenAIWhisperSTTProvider({ apiKey: "" });
  expect(provider.start()).rejects.toThrow("API key not configured");
});

test("AssemblyAISTTProvider — requires API key on start", async () => {
  const provider = new AssemblyAISTTProvider({ apiKey: "" });
  expect(provider.start()).rejects.toThrow("API key not configured");
});

test("AssemblyAISTTProvider — turn tracking composes multi-turn transcript", () => {
  // Directly test the turn composition logic
  const provider = new AssemblyAISTTProvider({ apiKey: "test-key" });
  const events: STTTranscriptEvent[] = [];
  provider.onTranscript((e) => events.push(e));

  // Simulate turn messages by calling the private handler via prototype trick
  // We test the public API behavior instead: feed turns through _handleTurnMessage
  // Access private method for testing (TypeScript allows this at runtime)
  const handleTurn = (provider as any)._handleTurnMessage.bind(provider);

  // Turn 0: partial
  handleTurn({ transcript: "Hello", turn_order: 0, end_of_turn: false });
  expect(events.length).toBe(1);
  expect(events[0].text).toBe("Hello");
  expect(events[0].isFinal).toBe(false);

  // Turn 0: finalized
  handleTurn({ transcript: "Hello world", turn_order: 0, end_of_turn: true });
  expect(events.length).toBe(2);
  expect(events[1].text).toBe("Hello world");
  expect(events[1].isFinal).toBe(true);

  // Turn 1: partial (new speaker)
  handleTurn({ transcript: "How are you", turn_order: 1, end_of_turn: false });
  expect(events.length).toBe(3);
  expect(events[2].text).toBe("Hello world How are you");
  expect(events[2].isFinal).toBe(false);

  // Turn 1: finalized with formatting
  handleTurn({ transcript: "How are you?", turn_order: 1, end_of_turn: true, turn_is_formatted: true });
  expect(events.length).toBe(4);
  expect(events[3].text).toBe("Hello world How are you?");
  expect(events[3].isFinal).toBe(true);
});

test("generateSineWavePCM16 — produces correct duration and amplitude", () => {
  const audio = generateSineWavePCM16(1.0, 440, 24000);

  // 1 second at 24kHz = 24000 samples * 2 bytes = 48000 bytes
  expect(audio.length).toBe(48000);

  // Check that peak amplitude is close to 0.8 * 32767 = 26213
  let maxAmp = 0;
  for (let i = 0; i < audio.length; i += 2) {
    const sample = Math.abs(audio.readInt16LE(i));
    if (sample > maxAmp) maxAmp = sample;
  }
  expect(maxAmp).toBeGreaterThan(26000);
  expect(maxAmp).toBeLessThan(27000);
});

// ── Integration Test (requires API keys) ──────────────────────────
//
// Run with: OPENAI_API_KEY=sk-... bun test test/experiments/stt-provider-experiment.ts
//
// These tests are skipped by default (no API key = skip).

const HAS_OPENAI_KEY = !!process.env.OPENAI_API_KEY;
const HAS_ASSEMBLYAI_KEY = !!process.env.ASSEMBLYAI_API_KEY;

const describeWithOpenAI = HAS_OPENAI_KEY ? test : test.skip;
const describeWithAssemblyAI = HAS_ASSEMBLYAI_KEY ? test : test.skip;

describeWithOpenAI("integration: OpenAI Whisper transcribes audio file", async () => {
  // Try loading a test audio file, fall back to synthetic audio
  const testAudioPath = `${process.env.HOME}/.callingclaw/shared/test-audio.pcm16`;
  let audio = await loadPCM16File(testAudioPath);

  if (!audio) {
    console.log("[STT Test] No test audio file found, using 2s of silence + tone");
    // Generate 2 seconds of 440Hz tone — won't produce meaningful transcript
    // but validates the API round-trip works
    audio = generateSineWavePCM16(2.0, 440, 24000);
  }

  const provider = new OpenAIWhisperSTTProvider();
  const events: STTTranscriptEvent[] = [];
  const errors: Error[] = [];
  provider.onTranscript((e) => events.push(e));
  provider.onError((e) => errors.push(e));

  await provider.start();

  // Send audio in 100ms chunks (simulating real-time streaming)
  const chunkSize = 24000 * 2 * 0.1; // 100ms at 24kHz = 4800 bytes
  for (let i = 0; i < audio.length; i += chunkSize) {
    provider.sendAudio(audio.subarray(i, Math.min(i + chunkSize, audio.length)));
  }

  await provider.stop();

  expect(errors.length).toBe(0);
  expect(events.length).toBeGreaterThan(0);
  expect(events[events.length - 1].isFinal).toBe(true);
  console.log(`[STT Test] OpenAI Whisper result: "${events[events.length - 1].text}"`);
}, 30_000); // 30s timeout for API call

describeWithAssemblyAI("integration: AssemblyAI streams partial transcripts", async () => {
  const testAudioPath = `${process.env.HOME}/.callingclaw/shared/test-audio.pcm16`;
  let audio = await loadPCM16File(testAudioPath);

  if (!audio) {
    console.log("[STT Test] No test audio file found, using 2s tone");
    audio = generateSineWavePCM16(2.0, 440, 24000);
  }

  const provider = new AssemblyAISTTProvider({
    keyterms: ["CallingClaw", "meeting", "action items"],
  });
  const events: STTTranscriptEvent[] = [];
  const errors: Error[] = [];
  provider.onTranscript((e) => events.push(e));
  provider.onError((e) => errors.push(e));

  await provider.start();

  // Stream audio in 100ms chunks with slight delay to simulate real-time
  const chunkSize = 24000 * 2 * 0.1;
  for (let i = 0; i < audio.length; i += chunkSize) {
    provider.sendAudio(audio.subarray(i, Math.min(i + chunkSize, audio.length)));
    // Small yield to let the event loop process incoming messages
    await new Promise((r) => setTimeout(r, 10));
  }

  await provider.stop();

  expect(errors.length).toBe(0);
  // AssemblyAI may return partial events during streaming
  console.log(`[STT Test] AssemblyAI received ${events.length} transcript events`);
  if (events.length > 0) {
    const lastEvent = events[events.length - 1];
    console.log(`[STT Test] AssemblyAI final: "${lastEvent.text}" (isFinal=${lastEvent.isFinal})`);
  }
}, 30_000);

// ── Provider Comparison Test ──────────────────────────────────────

const HAS_BOTH_KEYS = HAS_OPENAI_KEY && HAS_ASSEMBLYAI_KEY;
const describeComparison = HAS_BOTH_KEYS ? test : test.skip;

describeComparison("comparison: OpenAI vs AssemblyAI on same audio", async () => {
  const testAudioPath = `${process.env.HOME}/.callingclaw/shared/test-audio.pcm16`;
  const audio = await loadPCM16File(testAudioPath);

  if (!audio) {
    console.log("[STT Comparison] Skipping — no test audio file at", testAudioPath);
    console.log("[STT Comparison] To test: record audio with CallingClaw and save as PCM16");
    return;
  }

  console.log(`[STT Comparison] Audio: ${(audio.length / 2 / 24000).toFixed(1)}s at 24kHz`);

  // Run both providers in parallel
  const [whisperResult, assemblyResult] = await Promise.allSettled([
    (async () => {
      const provider = new OpenAIWhisperSTTProvider();
      const events: STTTranscriptEvent[] = [];
      provider.onTranscript((e) => events.push(e));
      await provider.start();
      const chunkSize = 24000 * 2 * 0.1;
      for (let i = 0; i < audio.length; i += chunkSize) {
        provider.sendAudio(audio.subarray(i, Math.min(i + chunkSize, audio.length)));
      }
      const t0 = performance.now();
      await provider.stop();
      return { events, latencyMs: performance.now() - t0 };
    })(),
    (async () => {
      const provider = new AssemblyAISTTProvider({
        keyterms: ["CallingClaw", "meeting"],
      });
      const events: STTTranscriptEvent[] = [];
      provider.onTranscript((e) => events.push(e));
      await provider.start();
      const chunkSize = 24000 * 2 * 0.1;
      for (let i = 0; i < audio.length; i += chunkSize) {
        provider.sendAudio(audio.subarray(i, Math.min(i + chunkSize, audio.length)));
        await new Promise((r) => setTimeout(r, 10));
      }
      const t0 = performance.now();
      await provider.stop();
      return { events, latencyMs: performance.now() - t0 };
    })(),
  ]);

  console.log("\n=== STT Provider Comparison ===");

  if (whisperResult.status === "fulfilled") {
    const { events, latencyMs } = whisperResult.value;
    const finalText = events.find((e) => e.isFinal)?.text || "(no final transcript)";
    console.log(`OpenAI Whisper:`);
    console.log(`  Transcript: "${finalText}"`);
    console.log(`  Finalization latency: ${latencyMs.toFixed(0)}ms`);
    console.log(`  Total events: ${events.length}`);
  } else {
    console.log(`OpenAI Whisper: FAILED — ${whisperResult.reason}`);
  }

  if (assemblyResult.status === "fulfilled") {
    const { events, latencyMs } = assemblyResult.value;
    const lastText = events[events.length - 1]?.text || "(no transcript)";
    const partialCount = events.filter((e) => !e.isFinal).length;
    console.log(`AssemblyAI:`);
    console.log(`  Transcript: "${lastText}"`);
    console.log(`  Finalization latency: ${latencyMs.toFixed(0)}ms`);
    console.log(`  Total events: ${events.length} (${partialCount} partial)`);
  } else {
    console.log(`AssemblyAI: FAILED — ${assemblyResult.reason}`);
  }

  console.log("===============================\n");
}, 60_000);
