#!/usr/bin/env bun
/**
 * Gemini 3.1 Flash Live — Tool Loop Integration Test
 *
 * Tests:
 * 1. Can Gemini setup with 6 tools (was 4 max)?
 * 2. Does thinkingConfig=high work?
 * 3. Can Gemini call exec() → see result → call open_file() (agent loop)?
 * 4. Can Gemini call interact()?
 *
 * Runs a real Gemini Live WebSocket connection — no mocks.
 */

const WsWebSocket = require("ws");

const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || "";
const MODEL = process.env.GEMINI_LIVE_MODEL || "gemini-3.1-flash-live-preview";
const WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${API_KEY}`;

if (!API_KEY) {
  console.error("❌ No GEMINI_API_KEY set");
  process.exit(1);
}

// ── 6 tools (same as gemini-adapter.ts) ──
const TOOLS = {
  functionDeclarations: [
    { name: "recall_context", description: "Fetch facts from memory",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    { name: "open_file", description: "Search and open a file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    { name: "share_screen", description: "Present a URL in meeting",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
    { name: "save_meeting_notes", description: "Save meeting notes",
      parameters: { type: "object", properties: { notes: { type: "string" } }, required: ["notes"] } },
    { name: "exec", description: "Run a shell command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
    { name: "interact", description: "Click, scroll, or navigate the page",
      parameters: { type: "object", properties: { action: { type: "string" }, target: { type: "string" } }, required: ["action"] } },
  ],
};

interface TestResult {
  test: string;
  pass: boolean;
  detail: string;
  durationMs: number;
}

const results: TestResult[] = [];

async function runTest(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Gemini Tool Loop Test — ${MODEL}`);
  console.log(`  Tools: ${TOOLS.functionDeclarations.length}`);
  console.log("═══════════════════════════════════════════════════════\n");

  // ── Test 1: Setup with 6 tools + thinkingConfig=high ──
  console.log("▶ Test 1: Setup with 6 tools + thinking=high...");
  const t1Start = performance.now();

  const ws = new WsWebSocket(WS_URL);
  let setupComplete = false;
  let toolCalls: any[] = [];
  let audioReceived = false;
  let textReceived = "";

  const setupPromise = new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      console.log("  ⏰ Setup timeout (15s) — 6 tools may exceed limit");
      resolve(false);
    }, 15000);

    ws.on("open", () => {
      console.log("  WS connected, sending setup...");
      ws.send(JSON.stringify({
        setup: {
          model: `models/${MODEL}`,
          generationConfig: {
            responseModalities: ["TEXT"],  // text mode for testing (faster than audio)
          },
          systemInstruction: {
            parts: [{ text: "You are a meeting assistant. Use tools to help." }],
          },
          tools: [TOOLS],
          thinkingConfig: {
            thinkingLevel: "high",
            includeThoughts: false,
          },
          realtimeInputConfig: {
            automaticActivityDetection: { disabled: true },
          },
        },
      }));
    });

    ws.on("message", (data: any) => {
      const msg = JSON.parse(data.toString());

      if (msg.setupComplete !== undefined) {
        clearTimeout(timeout);
        setupComplete = true;
        console.log("  ✅ Setup complete with 6 tools + thinking=high");
        resolve(true);
      }

      // Collect tool calls
      if (msg.toolCall) {
        for (const fc of msg.toolCall.functionCalls || []) {
          toolCalls.push(fc);
          console.log(`  🔧 Tool call: ${fc.name}(${JSON.stringify(fc.args)})`);
        }
      }

      // Collect text responses
      if (msg.serverContent?.modelTurn?.parts) {
        for (const part of msg.serverContent.modelTurn.parts) {
          if (part.text) {
            textReceived += part.text;
          }
        }
      }
    });

    ws.on("error", (e: any) => {
      clearTimeout(timeout);
      console.error("  ❌ WS error:", e.message);
      resolve(false);
    });
  });

  const setupOk = await setupPromise;
  results.push({
    test: "Setup with 6 tools + thinking=high",
    pass: setupOk,
    detail: setupOk ? "setupComplete received" : "timeout or error",
    durationMs: Math.round(performance.now() - t1Start),
  });

  if (!setupOk) {
    ws.close();
    printResults();
    return;
  }

  // ── Test 2: Send text prompt → expect exec() tool call ──
  console.log("\n▶ Test 2: Prompt → expect exec() tool call...");
  const t2Start = performance.now();
  toolCalls = [];
  textReceived = "";

  ws.send(JSON.stringify({
    clientContent: {
      turns: [{
        role: "user",
        parts: [{ text: 'Find HTML files in my home directory related to "mcp tool priority". Use the exec tool to run a find command.' }],
      }],
      turnComplete: true,
    },
  }));

  // Wait for tool call or text response
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => resolve(), 20000);
    const check = setInterval(() => {
      if (toolCalls.length > 0 || textReceived.length > 50) {
        clearInterval(check);
        clearTimeout(timeout);
        resolve();
      }
    }, 500);
  });

  const execCalled = toolCalls.some(tc => tc.name === "exec");
  results.push({
    test: "Prompt triggers exec() tool call",
    pass: execCalled,
    detail: execCalled
      ? `exec called: ${JSON.stringify(toolCalls.find(tc => tc.name === "exec")?.args)}`
      : `Got ${toolCalls.length} tool calls: ${toolCalls.map(tc => tc.name).join(", ") || "none"}, text: "${textReceived.slice(0, 100)}"`,
    durationMs: Math.round(performance.now() - t2Start),
  });

  // ── Test 3: Send tool response → expect consecutive tool call (agent loop) ──
  if (execCalled) {
    console.log("\n▶ Test 3: Tool response → expect agent loop (consecutive tool call)...");
    const t3Start = performance.now();
    const execCall = toolCalls.find(tc => tc.name === "exec")!;
    toolCalls = [];
    textReceived = "";

    // Send fake tool result with file list
    ws.send(JSON.stringify({
      toolResponse: {
        functionResponses: [{
          id: execCall.id,
          response: {
            result: "/Users/admin/Library/Mobile Documents/com~apple~CloudDocs/Tanka/Tanka Link 2.0/Link Action/mcp-tool-priority.html\n/Users/admin/.callingclaw/shared/prep/mcp-integration.md",
          },
        }],
      },
    }));

    // Wait for next tool call (agent loop) or text response
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => resolve(), 20000);
      const check = setInterval(() => {
        if (toolCalls.length > 0 || textReceived.length > 30) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 500);
    });

    const loopToolCall = toolCalls.length > 0;
    const calledOpenFile = toolCalls.some(tc => tc.name === "open_file");
    results.push({
      test: "Agent loop: consecutive tool call after exec result",
      pass: loopToolCall,
      detail: loopToolCall
        ? `Loop! Called: ${toolCalls.map(tc => `${tc.name}(${JSON.stringify(tc.args)})`).join(", ")}`
        : `No loop. Text response: "${textReceived.slice(0, 150)}"`,
      durationMs: Math.round(performance.now() - t3Start),
    });

    // If it called open_file, respond and check for more
    if (calledOpenFile) {
      const openCall = toolCalls.find(tc => tc.name === "open_file")!;
      toolCalls = [];
      textReceived = "";

      ws.send(JSON.stringify({
        toolResponse: {
          functionResponses: [{
            id: openCall.id,
            response: { result: "Opened mcp-tool-priority.html in browser." },
          }],
        },
      }));

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => resolve(), 10000);
        const check = setInterval(() => {
          if (textReceived.length > 20 || toolCalls.length > 0) {
            clearInterval(check);
            clearTimeout(timeout);
            resolve();
          }
        }, 500);
      });

      console.log(`  📝 After open_file: ${toolCalls.length > 0 ? `called ${toolCalls.map(tc => tc.name).join(",")}` : `text: "${textReceived.slice(0, 100)}"`}`);
    }
  } else {
    results.push({
      test: "Agent loop: consecutive tool call after exec result",
      pass: false,
      detail: "Skipped (exec not called in Test 2)",
      durationMs: 0,
    });
  }

  // ── Test 4: Direct interact call ──
  console.log("\n▶ Test 4: Prompt → expect interact() tool call...");
  const t4Start = performance.now();
  toolCalls = [];
  textReceived = "";

  ws.send(JSON.stringify({
    clientContent: {
      turns: [{
        role: "user",
        parts: [{ text: "Scroll down on the current page to see more content. Use the interact tool." }],
      }],
      turnComplete: true,
    },
  }));

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => resolve(), 15000);
    const check = setInterval(() => {
      if (toolCalls.length > 0 || textReceived.length > 30) {
        clearInterval(check);
        clearTimeout(timeout);
        resolve();
      }
    }, 500);
  });

  const interactCalled = toolCalls.some(tc => tc.name === "interact");
  results.push({
    test: "Prompt triggers interact() tool call",
    pass: interactCalled,
    detail: interactCalled
      ? `interact called: ${JSON.stringify(toolCalls.find(tc => tc.name === "interact")?.args)}`
      : `Got: ${toolCalls.map(tc => tc.name).join(", ") || "none"}, text: "${textReceived.slice(0, 100)}"`,
    durationMs: Math.round(performance.now() - t4Start),
  });

  ws.close();
  printResults();
}

function printResults() {
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  RESULTS");
  console.log("═══════════════════════════════════════════════════════");
  for (const r of results) {
    const icon = r.pass ? "✅" : "❌";
    console.log(`${icon} ${r.test} (${r.durationMs}ms)`);
    console.log(`   ${r.detail}`);
  }
  const passed = results.filter(r => r.pass).length;
  console.log(`\n  ${passed}/${results.length} passed`);
  console.log("═══════════════════════════════════════════════════════");
}

runTest().catch(console.error);
