#!/usr/bin/env bun
/**
 * Gemini 3.1 Flash Live — Tool Limit Bisect Test
 * Tests: 4 tools, 4+thinking, 5 tools, 6 tools to find exact limit
 */

const WsWebSocket = require("ws");

const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || "";
const MODEL = "gemini-3.1-flash-live-preview";
const WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${API_KEY}`;

const ALL_TOOLS = [
  { name: "recall_context", description: "Fetch facts", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "open_file", description: "Open a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "share_screen", description: "Present URL", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "save_meeting_notes", description: "Save notes", parameters: { type: "object", properties: { notes: { type: "string" } }, required: ["notes"] } },
  { name: "exec", description: "Run command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "interact", description: "Click or scroll", parameters: { type: "object", properties: { action: { type: "string" } }, required: ["action"] } },
];

async function testSetup(label: string, toolCount: number, thinking?: string): Promise<boolean> {
  const tools = ALL_TOOLS.slice(0, toolCount);
  process.stdout.write(`  ${label} (${toolCount} tools${thinking ? `, thinking=${thinking}` : ""})... `);

  return new Promise<boolean>((resolve) => {
    const ws = new WsWebSocket(WS_URL);
    const timeout = setTimeout(() => { ws.close(); resolve(false); }, 12000);

    ws.on("open", () => {
      const setup: any = {
        setup: {
          model: `models/${MODEL}`,
          generationConfig: { responseModalities: ["TEXT"] },
          systemInstruction: { parts: [{ text: "You are a helpful assistant." }] },
          tools: [{ functionDeclarations: tools }],
          realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
        },
      };
      if (thinking) {
        setup.setup.thinkingConfig = { thinkingLevel: thinking, includeThoughts: false };
      }
      ws.send(JSON.stringify(setup));
    });

    ws.on("message", (data: any) => {
      const msg = JSON.parse(data.toString());
      if (msg.setupComplete !== undefined) {
        clearTimeout(timeout);
        ws.close();
        resolve(true);
      }
    });

    ws.on("error", () => { clearTimeout(timeout); resolve(false); });
  });
}

async function testToolCall(toolCount: number, thinking?: string): Promise<{ toolCalled: string | null; text: string }> {
  const tools = ALL_TOOLS.slice(0, toolCount);

  return new Promise((resolve) => {
    const ws = new WsWebSocket(WS_URL);
    let toolCalled: string | null = null;
    let text = "";
    const timeout = setTimeout(() => { ws.close(); resolve({ toolCalled, text }); }, 25000);

    ws.on("open", () => {
      const setup: any = {
        setup: {
          model: `models/${MODEL}`,
          generationConfig: { responseModalities: ["TEXT"] },
          systemInstruction: { parts: [{ text: "You are a file search assistant. Always use exec tool to search." }] },
          tools: [{ functionDeclarations: tools }],
          realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
        },
      };
      if (thinking) {
        setup.setup.thinkingConfig = { thinkingLevel: thinking, includeThoughts: false };
      }
      ws.send(JSON.stringify(setup));
    });

    ws.on("message", (data: any) => {
      const msg = JSON.parse(data.toString());

      if (msg.setupComplete !== undefined) {
        // Send test prompt
        ws.send(JSON.stringify({
          clientContent: {
            turns: [{ role: "user", parts: [{ text: 'Search for HTML files named "mcp-tool-priority" using the exec tool with find command.' }] }],
            turnComplete: true,
          },
        }));
      }

      if (msg.toolCall?.functionCalls) {
        for (const fc of msg.toolCall.functionCalls) {
          toolCalled = fc.name;

          // Send tool response to test agent loop
          ws.send(JSON.stringify({
            toolResponse: {
              functionResponses: [{
                id: fc.id,
                response: { result: "/Users/admin/Tanka/mcp-tool-priority.html\n/Users/admin/docs/mcp-integration.md" },
              }],
            },
          }));
        }
      }

      if (msg.serverContent?.modelTurn?.parts) {
        for (const part of msg.serverContent.modelTurn.parts) {
          if (part.text) text += part.text;
        }
      }

      // Check if we got a second tool call (agent loop) or final text
      if ((toolCalled && text.length > 20) || (msg.serverContent?.turnComplete)) {
        clearTimeout(timeout);
        setTimeout(() => { ws.close(); resolve({ toolCalled, text }); }, 2000);
      }
    });

    ws.on("error", () => { clearTimeout(timeout); resolve({ toolCalled, text }); });
  });
}

async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Gemini 3.1 Flash Live — Tool Limit Bisect");
  console.log("═══════════════════════════════════════════════════════\n");

  // Phase 1: Setup limit test
  console.log("Phase 1: Setup limit (does setupComplete arrive?)\n");

  const configs = [
    { label: "4 tools, no thinking", count: 4, thinking: undefined },
    { label: "4 tools, thinking=high", count: 4, thinking: "high" },
    { label: "5 tools, no thinking", count: 5, thinking: undefined },
    { label: "5 tools, thinking=high", count: 5, thinking: "high" },
    { label: "6 tools, no thinking", count: 6, thinking: undefined },
    { label: "6 tools, thinking=high", count: 6, thinking: "high" },
  ];

  const setupResults: Array<{ label: string; pass: boolean }> = [];
  for (const c of configs) {
    const ok = await testSetup(c.label, c.count, c.thinking);
    console.log(ok ? "✅" : "❌ (timeout)");
    setupResults.push({ label: c.label, pass: ok });
    // Brief pause between tests to avoid rate limit
    await new Promise(r => setTimeout(r, 1000));
  }

  // Phase 2: Tool call test (only for configs that passed setup)
  const bestSetup = setupResults.filter(r => r.pass).pop();
  if (bestSetup) {
    const bestConfig = configs.find(c => c.label === bestSetup.label)!;
    console.log(`\nPhase 2: Tool call test with ${bestSetup.label}...\n`);

    const result = await testToolCall(bestConfig.count, bestConfig.thinking);
    console.log(`  Tool called: ${result.toolCalled || "none"}`);
    console.log(`  Text response: "${result.text.slice(0, 200)}"`);
  }

  // Summary
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  SETUP RESULTS");
  console.log("═══════════════════════════════════════════════════════");
  for (const r of setupResults) {
    console.log(`  ${r.pass ? "✅" : "❌"} ${r.label}`);
  }
  console.log("═══════════════════════════════════════════════════════");
}

main().catch(console.error);
