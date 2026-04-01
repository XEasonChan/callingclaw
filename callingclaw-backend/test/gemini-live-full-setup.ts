#!/usr/bin/env bun
// Test Gemini Live with full setup (matching GeminiProtocolAdapter output)
// Verifies that tools, VAD, transcription, etc. don't break the connection

const WebSocket = require("ws");
const { HttpsProxyAgent } = require("https-proxy-agent");

const KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || "";
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || "";
const MODEL = "gemini-3.1-flash-live-preview";

const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${KEY}`;
const opts: any = PROXY ? { agent: new HttpsProxyAgent(PROXY) } : {};

console.log("Testing FULL setup (matching adapter output)...\n");

const ws = new WebSocket(url, opts);
const timer = setTimeout(() => { console.error("TIMEOUT (15s)"); ws.close(); process.exit(1); }, 15000);

ws.on("open", () => {
  console.log("[1] WS OPEN — sending full setup");

  const setup = {
    setup: {
      model: `models/${MODEL}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: "Kore" },
          },
        },
      },
      systemInstruction: {
        parts: [{ text: "You are CallingClaw, a voice AI. Rules: match language, no filler, lead with WHY." }],
      },
      tools: [{
        functionDeclarations: [
          { name: "recall_context", description: "Fetch facts from memory", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
          { name: "save_meeting_notes", description: "Save meeting notes", parameters: { type: "object", properties: { notes: { type: "string" } }, required: ["notes"] } },
        ],
      }],
      realtimeInputConfig: {
        automaticActivityDetection: { disabled: false },
        activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
      },
      outputAudioTranscription: {},
      inputAudioTranscription: {},
      contextWindowCompression: {
        slidingWindow: {},
        triggerTokens: 80000,
      },
      sessionResumption: {},
    },
  };

  console.log(`[1] Setup size: ${JSON.stringify(setup).length} bytes`);
  ws.send(JSON.stringify(setup));
});

ws.on("message", (data: any) => {
  const msg = JSON.parse(String(data));

  if (msg.setupComplete !== undefined) {
    console.log("[2] SETUP COMPLETE with full config");
    ws.send(JSON.stringify({ realtimeInput: { text: "Hello, what tools do you have available?" } }));
    console.log("[3] Sent text turn...");
    return;
  }

  if (msg.serverContent?.modelTurn?.parts) {
    for (const part of msg.serverContent.modelTurn.parts) {
      if (part.text) console.log(`[3] TEXT: "${part.text}"`);
      if (part.inlineData) console.log(`[3] AUDIO: ${part.inlineData.mimeType}, ${(part.inlineData.data || "").length} chars`);
    }
  }
  if (msg.toolCall?.functionCalls) {
    console.log(`[3] TOOL CALL: ${msg.toolCall.functionCalls.map((fc: any) => fc.name).join(", ")}`);
    ws.send(JSON.stringify({
      toolResponse: {
        functionResponses: msg.toolCall.functionCalls.map((fc: any) => ({
          id: fc.id, response: { result: `[Mock: ${fc.name}]` },
        })),
      },
    }));
  }
  if (msg.serverContent?.outputTranscription?.text) {
    console.log(`[3] TRANSCRIPT: "${msg.serverContent.outputTranscription.text}"`);
  }
  if (msg.outputTranscription?.text) {
    console.log(`[3] TRANSCRIPT: "${msg.outputTranscription.text}"`);
  }
  if (msg.sessionResumptionUpdate) {
    console.log(`[+] Session handle: ${msg.sessionResumptionUpdate.newHandle?.slice(0, 20)}... resumable=${msg.sessionResumptionUpdate.resumable}`);
  }
  if (msg.serverContent?.turnComplete) {
    console.log("[4] TURN COMPLETE — FULL SETUP WORKS");
    clearTimeout(timer);
    ws.close();
  }
});

ws.on("error", (e: any) => { console.error(`ERROR: ${e.message}`); clearTimeout(timer); process.exit(1); });
ws.on("close", (code: number, reason: any) => { console.log(`CLOSE: ${code} ${reason || ""}`); clearTimeout(timer); });
