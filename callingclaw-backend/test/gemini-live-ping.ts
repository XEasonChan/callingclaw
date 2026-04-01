#!/usr/bin/env bun
// Minimal Gemini Live connectivity test
// Tests: API key + proxy + model name + setup → setupComplete → text round-trip
//
// Usage:
//   cd callingclaw-backend && bun test/gemini-live-ping.ts
//   GEMINI_LIVE_MODEL=gemini-2.0-flash-live-001 bun test/gemini-live-ping.ts
//   GEMINI_LIVE_MODEL=gemini-2.5-flash-live-preview bun test/gemini-live-ping.ts

// Use require() to get the real npm `ws` package, not Bun's native WebSocket shim.
const WebSocket = require("ws");
const { HttpsProxyAgent } = require("https-proxy-agent");

const KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || "";
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || "";
const MODEL = process.env.GEMINI_LIVE_MODEL || "gemini-3.1-flash-live-preview";
const MODE = process.argv.includes("--audio") ? "AUDIO" : "TEXT";

const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${KEY}`;
const opts: any = PROXY ? { agent: new HttpsProxyAgent(PROXY) } : {};

console.log(`Model:  models/${MODEL}`);
console.log(`Mode:   ${MODE}`);
console.log(`Proxy:  ${PROXY || "none (direct)"}`);
console.log(`Key:    ${KEY ? KEY.slice(0, 10) + "..." : "MISSING"}`);
console.log(`URL:    ${url.replace(KEY, "***")}`);
console.log("---");

if (!KEY) { console.error("ERROR: Set GEMINI_API_KEY or GOOGLE_AI_API_KEY"); process.exit(1); }

const ws = new WebSocket(url, opts);
const timer = setTimeout(() => {
  console.error("TIMEOUT (15s) — setup never completed");
  ws.close();
  process.exit(1);
}, 15000);

let msgCount = 0;

ws.on("open", () => {
  console.log("[1/4] WS OPEN");
  const setup: any = {
    setup: {
      model: `models/${MODEL}`,
      generationConfig: {
        responseModalities: [MODE],
      },
      systemInstruction: { parts: [{ text: "Say hello in one sentence." }] },
      outputAudioTranscription: {},
    },
  };
  if (MODE === "AUDIO") {
    setup.setup.generationConfig.speechConfig = {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
    };
  }
  console.log("[1/4] Sending setup...");
  ws.send(JSON.stringify(setup));
});

ws.on("message", (data: any) => {
  msgCount++;
  const raw = String(data);
  const msg = JSON.parse(raw);
  const keys = Object.keys(msg);

  if (msg.setupComplete !== undefined) {
    console.log("[2/4] SETUP COMPLETE");
    // Send a text turn
    const isV31 = MODEL.includes("3.1") || (MODEL.includes("3.") && !MODEL.includes("2."));
    if (isV31) {
      ws.send(JSON.stringify({ realtimeInput: { text: "Say hello in one word" } }));
    } else {
      ws.send(JSON.stringify({
        clientContent: {
          turns: [{ role: "user", parts: [{ text: "Say hello in one word" }] }],
          turnComplete: true,
        },
      }));
    }
    console.log("[3/4] Sent text turn, waiting for response...");
    return;
  }

  // Log all messages with truncated content
  if (msg.serverContent?.modelTurn?.parts) {
    for (const part of msg.serverContent.modelTurn.parts) {
      if (part.text) console.log(`[3/4] TEXT: "${part.text}"`);
      if (part.inlineData) {
        console.log(`[3/4] AUDIO: mimeType=${part.inlineData.mimeType}, data=${(part.inlineData.data || "").length} chars`);
      }
    }
  }
  if (msg.outputTranscription?.text) {
    console.log(`[3/4] TRANSCRIPT: "${msg.outputTranscription.text}"`);
  }
  if (msg.serverContent?.outputTranscription?.text) {
    console.log(`[3/4] TRANSCRIPT: "${msg.serverContent.outputTranscription.text}"`);
  }
  if (msg.serverContent?.turnComplete) {
    console.log(`[4/4] TURN COMPLETE — Gemini Live is WORKING (${msgCount} messages)`);
    clearTimeout(timer);
    ws.close();
    return;
  }

  // Unknown or other messages
  if (!msg.serverContent && !msg.setupComplete && !msg.outputTranscription) {
    console.log(`[?] ${keys[0]}: ${raw.slice(0, 200)}`);
  }
});

ws.on("error", (e: any) => {
  console.error(`ERROR: ${e.message}`);
  clearTimeout(timer);
  process.exit(1);
});

ws.on("close", (code: number, reason: any) => {
  console.log(`CLOSE: code=${code} reason=${reason || "none"}`);
  clearTimeout(timer);
});

ws.on("unexpected-response", (_req: any, res: any) => {
  console.error(`HTTP ${res.statusCode}: ${res.statusMessage}`);
  let body = "";
  res.on("data", (d: any) => body += d);
  res.on("end", () => {
    console.error(body.slice(0, 500));
    clearTimeout(timer);
    process.exit(1);
  });
});
