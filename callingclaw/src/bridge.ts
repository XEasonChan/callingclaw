// CallingClaw 2.0 — Python Sidecar Bridge (Bun native WebSocket Server)

import { CONFIG } from "./config";

export type BridgeMessageType =
  | "audio_chunk"       // PCM base64 from Python mic
  | "audio_playback"    // PCM base64 to Python speaker
  | "screenshot"        // Base64 PNG from Python vision
  | "action"            // PyAutoGUI command to Python
  | "action_result"     // Result from Python action
  | "status"            // Status/heartbeat
  | "config";           // Configuration update

export interface BridgeMessage {
  type: BridgeMessageType;
  payload: any;
  ts: number;
}

type MessageHandler = (msg: BridgeMessage) => void;

export class PythonBridge {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private client: any = null; // Bun ServerWebSocket
  private handlers = new Map<BridgeMessageType, MessageHandler[]>();
  private _ready = false;
  private _pingInterval: ReturnType<typeof setInterval> | null = null;
  private _lastPong = 0;
  private _pendingConfigConfirm: ((ok: boolean) => void) | null = null;

  get ready() {
    return this._ready;
  }

  start() {
    const self = this;
    this.server = Bun.serve({
      port: CONFIG.bridgePort,
      fetch(req, server) {
        if (server.upgrade(req)) return;
        return new Response("CallingClaw Bridge", { status: 200 });
      },
      websocket: {
        open(ws) {
          console.log("[Bridge] Python sidecar connected");
          // If there was an old client, close it
          if (self.client && self.client !== ws) {
            console.log("[Bridge] Replacing stale sidecar connection");
            try { self.client.close(); } catch {}
          }
          self.client = ws;
          self._ready = true;
          self._lastPong = Date.now();
          self._startPing();
        },
        message(ws, raw) {
          try {
            const msg: BridgeMessage = JSON.parse(
              typeof raw === "string" ? raw : new TextDecoder().decode(raw)
            );
            // Handle status messages for config confirmation and ping
            if (msg.type === "status") {
              self._lastPong = Date.now();
              const status = msg.payload?.status;
              if (status === "audio_mode_changed" && self._pendingConfigConfirm) {
                const ok = msg.payload?.success === true;
                console.log(`[Bridge] Audio mode confirm: ${ok ? "✅" : "❌"} ${msg.payload?.audio_mode}`);
                self._pendingConfigConfirm(ok);
                self._pendingConfigConfirm = null;
              }
            }
            const listeners = self.handlers.get(msg.type) || [];
            for (const fn of listeners) fn(msg);
          } catch (e) {
            console.error("[Bridge] Parse error:", e);
          }
        },
        close(ws) {
          console.log("[Bridge] Python sidecar disconnected");
          if (self.client === ws) {
            self.client = null;
            self._ready = false;
          }
          self._stopPing();
        },
      },
    });

    console.log(`[Bridge] WebSocket server on ws://localhost:${CONFIG.bridgePort}`);
  }

  /** Periodic ping to detect stale connections */
  private _startPing() {
    this._stopPing();
    this._pingInterval = setInterval(() => {
      if (!this.client) {
        this._ready = false;
        return;
      }
      // If no pong in 15s, mark as disconnected
      if (Date.now() - this._lastPong > 15000) {
        console.warn("[Bridge] Sidecar ping timeout — marking disconnected");
        this._ready = false;
        try { this.client.close(); } catch {}
        this.client = null;
        this._stopPing();
        return;
      }
      this.send("ping", { ts: Date.now() });
    }, 5000);
  }

  private _stopPing() {
    if (this._pingInterval) {
      clearInterval(this._pingInterval);
      this._pingInterval = null;
    }
  }

  on(type: BridgeMessageType, handler: MessageHandler) {
    const list = this.handlers.get(type) || [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  /** Register a one-time handler that auto-removes after first call */
  once(type: BridgeMessageType, handler: MessageHandler) {
    const wrapper: MessageHandler = (msg) => {
      this.off(type, wrapper);
      handler(msg);
    };
    this.on(type, wrapper);
  }

  /** Remove a specific handler */
  off(type: BridgeMessageType, handler: MessageHandler) {
    const list = this.handlers.get(type) || [];
    const idx = list.indexOf(handler);
    if (idx !== -1) list.splice(idx, 1);
  }

  send(type: BridgeMessageType, payload: any) {
    if (!this.client) {
      console.warn("[Bridge] No Python client connected");
      return false;
    }
    const msg: BridgeMessage = { type, payload, ts: Date.now() };
    try {
      this.client.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      console.error(`[Bridge] Send failed (type=${type}):`, e);
      this._ready = false;
      this.client = null;
      return false;
    }
  }

  /**
   * Send config and wait for sidecar confirmation.
   * Retries up to `retries` times with `timeoutMs` per attempt.
   * Returns true if sidecar confirmed the config change.
   */
  async sendConfigAndVerify(
    payload: any,
    { timeoutMs = 3000, retries = 3 } = {}
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      if (!this.ready) {
        console.warn(`[Bridge] sendConfigAndVerify attempt ${attempt}/${retries} — bridge not ready`);
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      const confirmed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          this._pendingConfigConfirm = null;
          resolve(false);
        }, timeoutMs);

        this._pendingConfigConfirm = (ok: boolean) => {
          clearTimeout(timer);
          resolve(ok);
        };

        const sent = this.send("config", payload);
        if (!sent) {
          clearTimeout(timer);
          this._pendingConfigConfirm = null;
          resolve(false);
        }
      });

      if (confirmed) {
        console.log(`[Bridge] Config verified on attempt ${attempt}`);
        return true;
      }
      console.warn(`[Bridge] Config not confirmed (attempt ${attempt}/${retries}), retrying...`);
      await new Promise((r) => setTimeout(r, 500));
    }
    console.error(`[Bridge] Config verification FAILED after ${retries} attempts`);
    return false;
  }

  sendAction(action: string, params: Record<string, any> = {}) {
    return this.send("action", { action, ...params });
  }

  sendAudioPlayback(base64Pcm: string) {
    return this.send("audio_playback", { audio: base64Pcm });
  }

  stop() {
    this.server?.stop();
  }
}
