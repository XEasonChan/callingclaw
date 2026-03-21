// CallingClaw 2.0 — OpenAI Realtime Voice Session Integration Test
// Tests real WebSocket connection to OpenAI Realtime API
// Requires OPENAI_API_KEY in .env

import { test, expect, describe, afterEach } from "bun:test";
import { RealtimeClient } from "./realtime_client";
import { CONFIG } from "../config";

// Skip all tests if no API key
const hasKey = !!CONFIG.openai.apiKey && CONFIG.openai.apiKey !== "sk-xxx";

describe("OpenAI Realtime Voice Session", () => {
  let client: RealtimeClient;

  afterEach(() => {
    client?.disconnect();
  });

  test("API key is configured", () => {
    expect(CONFIG.openai.apiKey).toBeTruthy();
    expect(CONFIG.openai.apiKey).not.toBe("sk-xxx");
    console.log(`[Test] Key: sk-...${CONFIG.openai.apiKey.slice(-4)}`);
  });

  test("config has correct Realtime API settings", () => {
    expect(CONFIG.openai.realtimeUrl).toBe("wss://api.openai.com/v1/realtime");
    expect(CONFIG.openai.realtimeModel).toMatch(/^gpt-4o-realtime/);
    expect(CONFIG.openai.voice).toBeTruthy();
  });

  test(
    "connects to OpenAI Realtime WebSocket",
    async () => {
      if (!hasKey) {
        console.log("[Test] Skipped — no OPENAI_API_KEY");
        return;
      }

      client = new RealtimeClient();
      await client.connect("You are a test assistant. Reply briefly.");

      expect(client.connected).toBe(true);
      console.log("[Test] WebSocket connected successfully");
    },
    15000
  );

  test(
    "receives session.created and session.updated events",
    async () => {
      if (!hasKey) return;

      client = new RealtimeClient();

      const events: string[] = [];
      client.on("session.created", () => events.push("session.created"));
      client.on("session.updated", () => events.push("session.updated"));

      await client.connect("Test assistant.");

      // Wait for session events to arrive
      await new Promise((r) => setTimeout(r, 2000));

      console.log("[Test] Received events:", events);
      expect(events).toContain("session.created");
      expect(events).toContain("session.updated");
    },
    15000
  );

  test(
    "sendText triggers AI text+audio response",
    async () => {
      if (!hasKey) return;

      client = new RealtimeClient();

      const receivedEvents: string[] = [];
      let responseText = "";
      let gotAudio = false;
      let responseDone = false;

      // Listen for response events
      client.on("response.text.delta", (e) => {
        responseText += e.delta || "";
        if (!receivedEvents.includes("response.text.delta")) {
          receivedEvents.push("response.text.delta");
        }
      });

      client.on("response.audio.delta", () => {
        gotAudio = true;
        if (!receivedEvents.includes("response.audio.delta")) {
          receivedEvents.push("response.audio.delta");
        }
      });

      client.on("response.done", () => {
        responseDone = true;
        receivedEvents.push("response.done");
      });

      // Also capture output transcript
      client.on("response.audio_transcript.delta", (e) => {
        responseText += e.delta || "";
        if (!receivedEvents.includes("response.audio_transcript.delta")) {
          receivedEvents.push("response.audio_transcript.delta");
        }
      });

      client.on("*", (e) => {
        if (e.type === "error") {
          console.error("[Test] API Error:", JSON.stringify(e.error, null, 2));
        }
      });

      await client.connect("You are a test assistant. Reply with exactly: Hello test.");

      // Send text message
      const sent = client.sendText("Say hello");
      expect(sent).toBe(true);
      console.log("[Test] Sent text message, waiting for response...");

      // Wait for response (up to 15s)
      const start = Date.now();
      while (!responseDone && Date.now() - start < 15000) {
        await new Promise((r) => setTimeout(r, 200));
      }

      console.log("[Test] Events received:", receivedEvents);
      console.log("[Test] Response text:", responseText.slice(0, 200));
      console.log("[Test] Got audio:", gotAudio);
      console.log("[Test] Response done:", responseDone);

      expect(responseDone).toBe(true);
      // Should get either text or audio transcript
      expect(responseText.length > 0 || gotAudio).toBe(true);
    },
    30000
  );

  test(
    "sendAudio sends PCM16 data without error",
    async () => {
      if (!hasKey) return;

      client = new RealtimeClient();
      await client.connect("Test.");

      // Generate 20ms of silence at 24kHz (480 samples * 2 bytes = 960 bytes)
      const silenceBuffer = Buffer.alloc(960, 0);
      const b64 = silenceBuffer.toString("base64");

      // Send a few silence chunks
      for (let i = 0; i < 5; i++) {
        const sent = client.sendAudio(b64);
        expect(sent).toBe(true);
      }

      console.log("[Test] Sent 5 silence audio chunks (24kHz PCM16)");

      // No crash = success. The server won't respond to silence.
      await new Promise((r) => setTimeout(r, 1000));
      expect(client.connected).toBe(true);
    },
    15000
  );

  test(
    "tool registration works in session config",
    async () => {
      if (!hasKey) return;

      client = new RealtimeClient();
      client.addTool({
        name: "test_tool",
        description: "A test tool for unit testing",
        parameters: {
          type: "object",
          properties: {
            message: { type: "string", description: "Test message" },
          },
          required: ["message"],
        },
      });

      let sessionConfig: any = null;
      client.on("session.updated", (e) => {
        sessionConfig = e.session;
      });

      await client.connect("Test with tools.");
      await new Promise((r) => setTimeout(r, 2000));

      console.log("[Test] Session tools:", sessionConfig?.tools?.map((t: any) => t.name));
      expect(sessionConfig).toBeTruthy();
      expect(sessionConfig.tools).toBeArrayOfSize(1);
      expect(sessionConfig.tools[0].name).toBe("test_tool");
    },
    15000
  );

  test(
    "disconnect cleanly closes the WebSocket",
    async () => {
      if (!hasKey) return;

      client = new RealtimeClient();
      await client.connect("Test.");
      expect(client.connected).toBe(true);

      client.disconnect();

      // Wait a beat for close event
      await new Promise((r) => setTimeout(r, 500));
      expect(client.connected).toBe(false);
      console.log("[Test] Clean disconnect confirmed");
    },
    15000
  );
});
