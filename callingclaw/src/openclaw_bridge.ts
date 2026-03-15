// CallingClaw 2.0 — OpenClaw Gateway Bridge
// Connects to OpenClaw's local Gateway WebSocket (:18789)
// Allows CallingClaw to delegate tasks (text editing, browser automation, messaging, etc.)
// to OpenClaw's agent, which has its own tool ecosystem (bash, text_editor, skills).
//
// Protocol: JSON-RPC frames over WebSocket
//   Request:  { type: "req",   id, method, params }
//   Response: { type: "res",   id, ok, payload, error }
//   Event:    { type: "event", event, payload, seq }

export type OpenClawActivityFn = (kind: string, summary: string, detail?: string) => void;

const OPENCLAW_WS_URL = "ws://localhost:18789";
const CONNECT_TIMEOUT = 6000;
const TASK_TIMEOUT = 120000; // 2 minutes per task

interface PendingRequest {
  resolve: (payload: any) => void;
  reject: (err: Error) => void;
}

export class OpenClawBridge {
  private ws: WebSocket | null = null;
  private _connected = false;
  private sessionKey: string | null = null;
  private token: string | null = null;
  private pending = new Map<string, PendingRequest>();
  private reqCounter = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private chatResolve: ((text: string) => void) | null = null;
  private _onActivity: OpenClawActivityFn | null = null;

  get connected() { return this._connected; }

  /** Register a callback for real-time activity events (deltas, completions) */
  onActivity(fn: OpenClawActivityFn) { this._onActivity = fn; }

  constructor() {
    this.loadToken();
  }

  /** Read the gateway token from ~/.openclaw/openclaw.json */
  private loadToken() {
    try {
      const configPath = `${process.env.HOME}/.openclaw/openclaw.json`;
      const file = Bun.file(configPath);
      // Sync-ish: we'll do it async during connect
      this.token = null;
    } catch {}
  }

  async connect(): Promise<void> {
    if (this._connected) return;

    // Read token from config
    try {
      const configPath = `${process.env.HOME}/.openclaw/openclaw.json`;
      const config = await Bun.file(configPath).json();
      this.token = config?.gateway?.auth?.token || null;
    } catch (e: any) {
      console.warn("[OpenClaw] Failed to read config:", e.message);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.ws?.close();
        reject(new Error("OpenClaw connection timeout"));
      }, CONNECT_TIMEOUT);

      const ws = new WebSocket(OPENCLAW_WS_URL);

      ws.addEventListener("open", () => {
        this.ws = ws;
        // Wait for connect.challenge event
      });

      ws.addEventListener("message", (e) => {
        this.onMessage(e.data as string, resolve, reject, timeout);
      });

      ws.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("OpenClaw WebSocket error"));
      });

      ws.addEventListener("close", () => {
        this._connected = false;
        this.sessionKey = null;
        this.flushPendingErrors(new Error("OpenClaw disconnected"));
        this.scheduleReconnect();
      });
    });
  }

  private onMessage(
    raw: string,
    connectResolve?: (v: void) => void,
    connectReject?: (e: Error) => void,
    connectTimeout?: ReturnType<typeof setTimeout>
  ) {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── Event frame ──
    if (msg.type === "event") {
      if (msg.event === "connect.challenge") {
        this.sendConnectRequest();
        return;
      }

      // Chat event from agent
      if (msg.event === "chat") {
        this.handleChatEvent(msg.payload);
        return;
      }
      return;
    }

    // ── Response frame ──
    if (msg.type === "res") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);

      if (msg.ok) {
        // Hello response (has snapshot)
        if (msg.payload?.snapshot) {
          const snap = msg.payload.snapshot;
          this.sessionKey = snap.sessionDefaults?.mainSessionKey || "agent:main:main";
          this._connected = true;
          console.log(`[OpenClaw] Connected (session: ${this.sessionKey})`);
          if (connectTimeout) clearTimeout(connectTimeout);
          connectResolve?.();
        }
        p.resolve(msg.payload);
      } else {
        p.reject(new Error(msg.error?.message || "OpenClaw request failed"));
      }
    }
  }

  private sendConnectRequest() {
    const auth = this.token ? { token: this.token } : undefined;
    this.request("connect", {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "gateway-client",
        version: "2026.2.6",
        platform: "darwin",
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.admin"],
      caps: [],
      auth,
    });
  }

  /**
   * Send a task to OpenClaw and wait for the agent's response.
   * This is the main API — CallingClaw's Computer Use agent calls this
   * when it needs OpenClaw's tools (text editing, browser, messaging, etc.)
   */
  async sendTask(taskText: string): Promise<string> {
    if (!this._connected || !this.sessionKey) {
      // Try to connect first
      try {
        await this.connect();
      } catch {
        return "OpenClaw is not running. Use bash or computer tools instead.";
      }
    }

    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.chatResolve = null;
        resolve("OpenClaw task timed out (2 minutes).");
      }, TASK_TIMEOUT);

      this.chatResolve = (text: string) => {
        clearTimeout(timeout);
        resolve(text);
      };

      const idempotencyKey = crypto.randomUUID();
      this.request("chat.send", {
        sessionKey: this.sessionKey,
        message: taskText,
        idempotencyKey,
        deliver: false,
      }).catch((err) => {
        clearTimeout(timeout);
        this.chatResolve = null;
        resolve(`OpenClaw error: ${err.message}`);
      });
    });
  }

  private handleChatEvent(payload: any) {
    if (!payload) return;

    // Stream delta — forward to activity feed for real-time visibility
    if (payload.state === "delta") {
      const text = this.extractMessageText(payload.message);
      if (text) {
        this._onActivity?.("openclaw.delta", text.slice(0, 80), text);
      }
      return;
    }

    if (payload.state === "final") {
      const text = this.extractMessageText(payload.message);
      this._onActivity?.("openclaw.done", text?.slice(0, 80) || "(done)", text || "");
      if (this.chatResolve) {
        this.chatResolve(text || "(no response)");
        this.chatResolve = null;
      }
      return;
    }

    if (payload.state === "error" || payload.state === "aborted") {
      this._onActivity?.("openclaw.error", payload.errorMessage || "aborted");
      if (this.chatResolve) {
        this.chatResolve(`OpenClaw error: ${payload.errorMessage || "aborted"}`);
        this.chatResolve = null;
      }
    }
  }

  private extractMessageText(msg: any): string {
    if (!msg) return "";
    if (typeof msg.text === "string") return msg.text;
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter((p: any) => p?.type === "text" && typeof p.text === "string")
        .map((p: any) => p.text)
        .join("\n");
    }
    return "";
  }

  private request(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket not open"));
        return;
      }
      const id = String(++this.reqCounter);
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  private flushPendingErrors(err: Error) {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
    if (this.chatResolve) {
      this.chatResolve(`OpenClaw disconnected: ${err.message}`);
      this.chatResolve = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this._connected) {
        this.connect().catch(() => {});
      }
    }, 5000);
  }

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
    this._connected = false;
    this.sessionKey = null;
    this.flushPendingErrors(new Error("Disconnected"));
  }
}
