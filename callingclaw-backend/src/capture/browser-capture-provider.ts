// CallingClaw 2.0 — Browser Capture Provider
// Uses Chrome DevTools Protocol (CDP) WebSocket for fast browser screenshots.
// ~30ms per capture, independent of Playwright CLI pipe (no contention).
//
// CDP URL discovery:
//   1. Find Chrome process with --user-data-dir=~/.callingclaw/browser-profile
//   2. Read --remote-debugging-port from its command line
//   3. Query http://localhost:{port}/json/list for page targets
//   4. Connect to the first page's webSocketDebuggerUrl

import type { CaptureProvider, CaptureResult } from "../types/screen";

const RECONNECT_DELAY_MS = 3000;
const CDP_TIMEOUT_MS = 5000;
const PROFILE_MARKER = ".callingclaw/browser-profile";

export class BrowserCaptureProvider implements CaptureProvider {
  readonly source = "browser" as const;

  private ws: WebSocket | null = null;
  private _msgId = 0;
  private _pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (reason: any) => void;
    timer: Timer;
  }>();
  private _reconnectTimer: Timer | null = null;
  private _debugPort: number | null = null;
  private _closed = false;

  /**
   * Connect to Chrome's CDP WebSocket.
   * Discovers the debug port from Chrome's process args,
   * then connects to the first page target.
   */
  async connect(): Promise<void> {
    this._closed = false;

    // Step 1: Discover Chrome's debug port
    const port = await this.discoverDebugPort();
    if (!port) {
      console.warn("[BrowserCapture] Chrome debug port not found — is Playwright CLI running?");
      return;
    }
    this._debugPort = port;

    // Step 2: Find the first page target
    const wsUrl = await this.getPageWebSocketUrl(port);
    if (!wsUrl) {
      console.warn("[BrowserCapture] No page targets found on CDP");
      return;
    }

    // Step 3: Connect WebSocket
    await this.connectWebSocket(wsUrl);
  }

  async capture(): Promise<CaptureResult | null> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return null;

    try {
      // Parallel: screenshot + URL/title eval
      const [screenshotResult, evalResult] = await Promise.all([
        this.sendCDP("Page.captureScreenshot", {
          format: "jpeg",
          quality: 80,
        }),
        this.sendCDP("Runtime.evaluate", {
          expression: "JSON.stringify([location.href, document.title, window.innerWidth, window.innerHeight])",
          returnByValue: true,
        }),
      ]);

      const imageData = screenshotResult?.data;
      if (!imageData) return null;

      // Parse URL/title
      let url = "", title = "", width = 1920, height = 1080;
      try {
        const raw = evalResult?.result?.value;
        if (raw) {
          const [u, t, w, h] = JSON.parse(raw);
          url = u; title = t; width = w; height = h;
        }
      } catch {}

      return {
        image: imageData,
        width,
        height,
        metadata: { url, title },
      };
    } catch (e: any) {
      console.error(`[BrowserCapture] Capture error: ${e.message}`);
      return null;
    }
  }

  async isAvailable(): Promise<boolean> {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Reconnect to a different page target (e.g., after tab switch).
   * Useful when the active tab changes during a meeting.
   */
  async reconnectToActivePage(): Promise<void> {
    if (!this._debugPort) return;
    const wsUrl = await this.getPageWebSocketUrl(this._debugPort);
    if (wsUrl) {
      this.closeWebSocket();
      await this.connectWebSocket(wsUrl);
    }
  }

  close(): void {
    this._closed = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this.closeWebSocket();
    this._debugPort = null;
  }

  // ══════════════════════════════════════════════════════════════
  // CDP Discovery
  // ══════════════════════════════════════════════════════════════

  /**
   * Find Chrome's --remote-debugging-port by inspecting running processes.
   * Looks for Chrome with user-data-dir containing PROFILE_MARKER.
   */
  private async discoverDebugPort(): Promise<number | null> {
    try {
      const result = await Bun.$`ps aux`.quiet().text() as string;
      for (const line of result.split("\n")) {
        if (!line.includes(PROFILE_MARKER)) continue;
        if (!line.includes("--remote-debugging-port=")) continue;
        // Skip helper processes — only match the main Chrome process
        if (line.includes("--type=")) continue;

        const match = line.match(/--remote-debugging-port=(\d+)/);
        if (match && match[1]) {
          const port = parseInt(match[1], 10);
          console.log(`[BrowserCapture] Discovered Chrome CDP port: ${port}`);
          return port;
        }
      }
    } catch {}
    return null;
  }

  /**
   * Query CDP for page targets and return the WebSocket URL of the first one.
   * Prefers non-about:blank pages; falls back to any page.
   */
  private async getPageWebSocketUrl(port: number): Promise<string | null> {
    try {
      const response = await fetch(`http://localhost:${port}/json/list`);
      const targets = await response.json() as Array<{
        type: string;
        url: string;
        webSocketDebuggerUrl: string;
      }>;

      // Prefer non-blank page
      const pages = targets.filter(t => t.type === "page");
      const active = pages.find(p => !p.url.startsWith("about:")) || pages[0];
      return active?.webSocketDebuggerUrl || null;
    } catch (e: any) {
      console.error(`[BrowserCapture] CDP target discovery failed: ${e.message}`);
      return null;
    }
  }

  // ══════════════════════════════════════════════════════════════
  // CDP WebSocket
  // ══════════════════════════════════════════════════════════════

  private connectWebSocket(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timeout = setTimeout(() => {
        reject(new Error("CDP WebSocket connect timeout"));
      }, CDP_TIMEOUT_MS);

      ws.addEventListener("open", () => {
        clearTimeout(timeout);
        this.ws = ws;
        console.log(`[BrowserCapture] CDP connected`);
        resolve();
      });

      ws.addEventListener("message", (event) => {
        try {
          const msg = JSON.parse(String(event.data));
          const pending = this._pending.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            this._pending.delete(msg.id);
            if (msg.error) {
              pending.reject(new Error(msg.error.message));
            } else {
              pending.resolve(msg.result);
            }
          }
        } catch {}
      });

      ws.addEventListener("close", () => {
        this.ws = null;
        this.flushPending("CDP connection closed");
        if (!this._closed) {
          console.log(`[BrowserCapture] CDP disconnected — reconnecting in ${RECONNECT_DELAY_MS}ms`);
          this._reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
        }
      });

      ws.addEventListener("error", (err) => {
        clearTimeout(timeout);
        console.error(`[BrowserCapture] CDP WebSocket error`);
        // Close handler will trigger reconnect
      });
    });
  }

  private closeWebSocket(): void {
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.flushPending("closed");
  }

  private sendCDP(method: string, params: Record<string, any> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error("CDP not connected"));
      }

      const id = ++this._msgId;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, CDP_TIMEOUT_MS);

      this._pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  private flushPending(reason: string): void {
    for (const [id, pending] of this._pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this._pending.clear();
  }
}
