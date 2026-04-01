#!/usr/bin/env bun
// Worker script: runs a single Gemini Live eval case via WebSocket
// Input: JSON on stdin with { systemInstruction, turns, tools }
// Output: JSON on stdout with { transcript, textParts, toolCalls, error }

// Use require() to get the real npm `ws` package, not Bun's native WebSocket shim.
// Bun's shim ignores proxy agent, which breaks connections behind GFW.
const WS = require("ws");
const { HttpsProxyAgent } = require("https-proxy-agent");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const MODEL = process.env.GEMINI_LIVE_MODEL || "models/gemini-3.1-flash-live-preview";
const WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
const PROXY = process.env.https_proxy || process.env.HTTPS_PROXY || "";

interface WorkerInput {
  systemInstruction: string;
  turns: Array<{ text: string }>;
  tools?: boolean;
}

// Read input from file arg or stdin; optional output file as second arg
const inputPath = process.argv[2];
const outputPath = process.argv[3]; // If set, write result to this file instead of stdout
const inputText = inputPath ? await Bun.file(inputPath).text() : await Bun.stdin.text();
const input: WorkerInput = JSON.parse(inputText);

console.error(`[worker] PROXY=${PROXY || "none"} KEY=${GEMINI_API_KEY.slice(0, 8)}... MODEL=${MODEL}`);
const wsOpts: any = PROXY ? { agent: new HttpsProxyAgent(PROXY) } : {};
const ws = new WS(WS_URL, wsOpts);

let transcript = "";
let textParts = "";
let toolCalls: string[] = [];
let turnIdx = 0;

const isV31 = MODEL.includes("3.1") || (MODEL.includes("3.") && !MODEL.includes("2."));

function sendNextTurn() {
  if (turnIdx >= input.turns.length) return;
  const t = input.turns[turnIdx++];
  if (isV31) {
    // Gemini 3.1+: use realtimeInput.text
    ws.send(JSON.stringify({ realtimeInput: { text: t.text } }));
  } else {
    // Gemini 2.5: use clientContent.turns
    ws.send(JSON.stringify({
      clientContent: {
        turns: [{ role: "user", parts: [{ text: t.text }] }],
        turnComplete: true,
      },
    }));
  }
}

ws.on("open", () => {
  const setup: any = {
    setup: {
      model: MODEL,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } },
      },
      systemInstruction: { parts: [{ text: input.systemInstruction }] },
      outputAudioTranscription: {},
    },
  };

  if (input.tools) {
    setup.setup.tools = [{
      functionDeclarations: [
        { name: "recall_context", description: "Fetch facts from memory", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
        { name: "open_file", description: "Open a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      ],
    }];
  }

  ws.send(JSON.stringify(setup));
});

ws.on("message", (data: any) => {
  const msg = JSON.parse(String(data));

  if (msg.setupComplete) {
    console.error(`[worker] setupComplete`);
    sendNextTurn();
    return;
  }

  if (msg.serverContent?.outputTranscription?.text) {
    transcript += msg.serverContent.outputTranscription.text;
  }
  // Gemini 3.1+: outputTranscription at top level
  if (msg.outputTranscription?.text) {
    transcript += msg.outputTranscription.text;
  }
  if (msg.serverContent?.modelTurn?.parts) {
    for (const p of msg.serverContent.modelTurn.parts) {
      if (p.text) textParts += p.text;
      if (p.functionCall) toolCalls.push(p.functionCall.name);
    }
  }
  if (msg.toolCall?.functionCalls) {
    for (const fc of msg.toolCall.functionCalls) toolCalls.push(fc.name);
    ws.send(JSON.stringify({
      toolResponse: {
        functionResponses: msg.toolCall.functionCalls.map((fc: any) => ({
          name: fc.name, response: { result: `[Mock: ${fc.name}]` },
        })),
      },
    }));
  }

  if (msg.serverContent?.turnComplete || msg.serverContent?.generationComplete) {
    if (turnIdx < input.turns.length) {
      transcript = ""; textParts = ""; // Reset for next turn
      sendNextTurn();
    } else {
      // Wait briefly for trailing outputTranscription messages
      // (Gemini may send turnComplete before final transcription chunk)
      setTimeout(() => finish(), 2000);
    }
  }
});

ws.on("error", (e: any) => finish(e.message));
ws.on("close", (code: number, reason: any) => {
  const r = reason?.toString?.() || "";
  if (code !== 1000 && !transcript && !textParts) {
    finish(`WS close ${code}: ${r}`.trim());
  } else {
    finish();
  }
});

const timer = setTimeout(() => finish("timeout"), 45000);

async function finish(error?: string) {
  clearTimeout(timer);
  ws.close();
  const result = JSON.stringify({ transcript, textParts, toolCalls, error: error || null });
  if (outputPath) {
    await Bun.write(outputPath, result);
  } else {
    console.log(result);
  }
  process.exit(0);
}
