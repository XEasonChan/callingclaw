/**
 * BrowserCaptureProvider — Unit Tests
 *
 * Tests CDP connection, screenshot capture, reconnection, and error handling.
 * Uses a mock WebSocket server to simulate Chrome DevTools Protocol.
 *
 * Run: bun test test/capture/browser-capture-provider.test.ts
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { BrowserCaptureProvider } from "../../src/capture/browser-capture-provider";

// ── Mock CDP Server ─────────────────────────────────────────────

let mockServer: ReturnType<typeof Bun.serve> | null = null;
let lastWs: any = null;
let cdpPort = 0;

function startMockCDP(handlers?: {
  onMessage?: (ws: any, msg: any) => void;
}) {
  mockServer = Bun.serve({
    port: 0, // Random port
    fetch(req, server) {
      const url = new URL(req.url);

      // CDP target discovery endpoint
      if (url.pathname === "/json/list") {
        return Response.json([{
          type: "page",
          url: "https://meet.google.com/abc-defg-hij",
          title: "Google Meet",
          webSocketDebuggerUrl: `ws://localhost:${cdpPort}/devtools/page/FAKE123`,
        }]);
      }

      if (url.pathname === "/json/version") {
        return Response.json({
          Browser: "Chrome/130.0",
          webSocketDebuggerUrl: `ws://localhost:${cdpPort}/devtools/browser/FAKE`,
        });
      }

      // WebSocket upgrade
      if (server.upgrade(req)) return undefined;
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        lastWs = ws;
      },
      message(ws, message) {
        const msg = JSON.parse(String(message));
        if (handlers?.onMessage) {
          handlers.onMessage(ws, msg);
          return;
        }

        // Default CDP responses
        if (msg.method === "Page.captureScreenshot") {
          ws.send(JSON.stringify({
            id: msg.id,
            result: { data: "fakeBase64JPEG==" },
          }));
        } else if (msg.method === "Runtime.evaluate") {
          ws.send(JSON.stringify({
            id: msg.id,
            result: {
              result: {
                value: JSON.stringify(["https://meet.google.com/abc", "Google Meet", 1920, 1080]),
              },
            },
          }));
        } else {
          ws.send(JSON.stringify({ id: msg.id, result: {} }));
        }
      },
      close() {
        lastWs = null;
      },
    },
  });
  cdpPort = mockServer.port;
}

function stopMockCDP() {
  if (mockServer) {
    mockServer.stop(true);
    mockServer = null;
  }
  lastWs = null;
}

// ── Tests ───────────────────────────────────────────────────────

describe("BrowserCaptureProvider", () => {
  let provider: BrowserCaptureProvider;

  beforeEach(() => {
    startMockCDP();
    provider = new BrowserCaptureProvider();
  });

  afterEach(() => {
    provider.close();
    stopMockCDP();
  });

  test("isAvailable returns false before connect", async () => {
    expect(await provider.isAvailable()).toBe(false);
  });

  test("capture returns null before connect", async () => {
    const result = await provider.capture();
    expect(result).toBeNull();
  });

  describe("with mocked discoverDebugPort", () => {
    // Override private method to use our mock port instead of scanning ps
    function patchProvider(p: BrowserCaptureProvider) {
      (p as any).discoverDebugPort = async () => cdpPort;
    }

    test("connect discovers port and establishes CDP WebSocket", async () => {
      patchProvider(provider);
      await provider.connect();
      expect(await provider.isAvailable()).toBe(true);
    });

    test("capture returns JPEG + metadata after connect", async () => {
      patchProvider(provider);
      await provider.connect();

      const result = await provider.capture();
      expect(result).not.toBeNull();
      expect(result!.image).toBe("fakeBase64JPEG==");
      expect(result!.metadata.url).toBe("https://meet.google.com/abc");
      expect(result!.metadata.title).toBe("Google Meet");
      expect(result!.width).toBe(1920);
      expect(result!.height).toBe(1080);
    });

    test("capture returns null on CDP error response", async () => {
      stopMockCDP();
      startMockCDP({
        onMessage(ws, msg) {
          if (msg.method === "Page.captureScreenshot") {
            ws.send(JSON.stringify({
              id: msg.id,
              result: { data: null }, // No image data
            }));
          } else {
            ws.send(JSON.stringify({
              id: msg.id,
              result: { result: { value: "[]" } },
            }));
          }
        },
      });
      patchProvider(provider);
      await provider.connect();

      const result = await provider.capture();
      expect(result).toBeNull();
    });

    test("multiple captures work sequentially", async () => {
      patchProvider(provider);
      await provider.connect();

      const r1 = await provider.capture();
      const r2 = await provider.capture();
      const r3 = await provider.capture();

      expect(r1).not.toBeNull();
      expect(r2).not.toBeNull();
      expect(r3).not.toBeNull();
    });

    test("close makes isAvailable return false", async () => {
      patchProvider(provider);
      await provider.connect();
      expect(await provider.isAvailable()).toBe(true);

      provider.close();
      expect(await provider.isAvailable()).toBe(false);
    });

    test("capture returns null after close", async () => {
      patchProvider(provider);
      await provider.connect();
      provider.close();

      const result = await provider.capture();
      expect(result).toBeNull();
    });
  });

  describe("target discovery", () => {
    test("getPageWebSocketUrl prefers non-blank page", async () => {
      stopMockCDP();
      // Custom server with multiple targets
      mockServer = Bun.serve({
        port: 0,
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/json/list") {
            return Response.json([
              { type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://blank" },
              { type: "page", url: "https://google.com", webSocketDebuggerUrl: "ws://google" },
            ]);
          }
          return new Response("", { status: 404 });
        },
      });
      cdpPort = mockServer.port;

      // Access private method for testing
      const wsUrl = await (provider as any).getPageWebSocketUrl(cdpPort);
      expect(wsUrl).toBe("ws://google");
    });

    test("getPageWebSocketUrl falls back to blank page if only option", async () => {
      stopMockCDP();
      mockServer = Bun.serve({
        port: 0,
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/json/list") {
            return Response.json([
              { type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://blank" },
            ]);
          }
          return new Response("", { status: 404 });
        },
      });
      cdpPort = mockServer.port;

      const wsUrl = await (provider as any).getPageWebSocketUrl(cdpPort);
      expect(wsUrl).toBe("ws://blank");
    });

    test("getPageWebSocketUrl returns null on network error", async () => {
      const wsUrl = await (provider as any).getPageWebSocketUrl(1); // Port 1 = unreachable
      expect(wsUrl).toBeNull();
    });
  });
});
