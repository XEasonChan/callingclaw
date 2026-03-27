// CallingClaw — SenseVoice STT Client
// Connects to local SenseVoice Python service (ws://localhost:4001)
// Receives meeting audio chunks, forwards to SenseVoice, returns transcripts.

import { CONFIG } from "../config";

const DEFAULT_URL = "ws://localhost:4001";

export interface SenseVoiceTranscript {
  text: string;
  lang?: string;
  emotion?: string;
  final?: boolean;
}

export class SenseVoiceClient {
  private ws: WebSocket | null = null;
  private _connected = false;
  private url: string;
  private onTranscript: ((t: SenseVoiceTranscript) => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(url?: string) {
    this.url = url || process.env.SENSEVOICE_URL || DEFAULT_URL;
  }

  get connected() { return this._connected; }

  /** Register callback for incoming transcripts */
  onText(handler: (t: SenseVoiceTranscript) => void) {
    this.onTranscript = handler;
  }

  /** Connect to SenseVoice server */
  connect(): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
          this._connected = true;
          console.log(`[SenseVoice] Connected to ${this.url}`);
          resolve(true);
        };

        this.ws.onmessage = (event: MessageEvent) => {
          try {
            const data = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
            if (data.type === "transcript" && data.text) {
              this.onTranscript?.({
                text: data.text,
                lang: data.lang,
                emotion: data.emotion,
                final: data.final,
              });
            }
          } catch {}
        };

        this.ws.onclose = () => {
          this._connected = false;
          console.log("[SenseVoice] Disconnected — reconnecting in 5s");
          this.reconnectTimer = setTimeout(() => this.connect(), 5000);
        };

        this.ws.onerror = () => {
          this._connected = false;
          resolve(false);
        };

        // Timeout
        setTimeout(() => {
          if (!this._connected) {
            console.warn("[SenseVoice] Connection timeout (server may not be running)");
            resolve(false);
          }
        }, 3000);
      } catch {
        resolve(false);
      }
    });
  }

  /** Send audio chunk to SenseVoice for transcription */
  sendAudio(base64Pcm: string) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "audio", audio: base64Pcm }));
    }
  }

  /** Flush buffer and get final transcript */
  flush() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "stop" }));
    }
  }

  /** Disconnect */
  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this._connected = false;
  }
}
