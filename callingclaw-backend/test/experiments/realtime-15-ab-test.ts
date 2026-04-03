/**
 * Realtime 1.5 A/B Test — Mispronunciation + Meeting Prep Context
 * 
 * Experiment: Can the model associate a mispronounced file reference with the
 * correct file path when given sufficient meeting prep context?
 * 
 * Setup:
 *   - Meeting prep context injected as system instruction (simulating real CoCo flow)
 *   - User sends TEXT (simulating transcribed audio) with deliberate mispronunciations
 *   - Compare: gpt-4o-realtime-preview (legacy) vs gpt-realtime-1.5 (GA)
 * 
 * We test via text (not actual audio) because:
 *   1. Reproducible — same input every time
 *   2. Isolates the REASONING component (can the model infer correct file from wrong name?)
 *   3. Simulates what happens after Whisper transcribes a mispronounced word
 * 
 * Run: bun test/experiments/realtime-15-ab-test.ts
 * Requires: OPENAI_API_KEY in .env
 */

import { CONFIG } from "../../src/config";
import { RealtimeClient, type VoiceProviderName } from "../../src/ai_gateway/realtime_client";

// ── Test Configuration ──────────────────────────────────────────

const MEETING_PREP_CONTEXT = `
## Meeting Context — Tanka Link 2.0 Review

### Key Documents:
- **Phase 2 Testing Guide**: /Users/admin/Library/Mobile Documents/com~apple~CloudDocs/Tanka/Tanka Link 2.0/Link data/pipedream link/link2-phase2-testing-guide.html
  - Contains: 95 app testing workflows, registration tiers (64 free / 15 trial / 16 enterprise)
  - Priority apps: ClickUp(51 actions), Salesforce(50), Stripe(47), Todoist(42), QuickBooks(40)

- **App Catalog**: /Users/admin/Library/Mobile Documents/com~apple~CloudDocs/Tanka/Tanka Link 2.0/Link data/pipedream link/tanka-link-app-catalog.html
  - 184 app icons, connection status, category grouping

- **MCP Tool Registry**: /Users/admin/Library/Mobile Documents/com~apple~CloudDocs/Tanka/Tanka Link 2.0/Link Action/mcp-tool-priority.html
  - Phase II app reduction: 95→20-30 Tier 1 apps
  - 744 actions across 10 categories

- **Action & Permission PRD**: /Users/admin/Library/Mobile Documents/com~apple~CloudDocs/Tanka/Tanka Link 2.0/Link Action/Action & Permission Phase I/PRD-Phase2-Action-Coverage.html

### Today's Agenda:
1. Review Phase 2 testing progress
2. Discuss MCP tool priority reduction (95→20-30 apps)  
3. App catalog update for Link 2.0 launch
4. Permission model for connector actions

### Participants: Andrew (PM), Engineering team
`;

// Mispronounced queries (simulating what Whisper might transcribe from Chinese-accented English)
const TEST_QUERIES = [
  {
    id: "mispronounce-1",
    // "Link Taxonomy" instead of "Link 2.0 testing" (known Whisper error: "Link Taxonomy" ≈ "Link to Pony")
    query: "Hey, can you open the Link to Pony testing guide? I need to check which apps we should test first.",
    expectedFile: "link2-phase2-testing-guide.html",
    difficulty: "hard",
  },
  {
    id: "mispronounce-2", 
    // Slightly garbled "MCP tool priority" 
    query: "I want to see the MTP tool priority list, the one about reducing from 95 to 30 apps",
    expectedFile: "mcp-tool-priority.html",
    difficulty: "medium",
  },
  {
    id: "mispronounce-3",
    // "app catalog" but with wrong emphasis
    query: "Open the app catalogue for Tanka Link, the one with all 184 app icons",
    expectedFile: "tanka-link-app-catalog.html",
    difficulty: "easy",
  },
  {
    id: "mispronounce-4",
    // Very garbled reference, relies entirely on context clues
    query: "Show me that HTML document... the one for phase two coverage, with ClickUp having 51 actions and Salesforce with 50",
    expectedFile: "link2-phase2-testing-guide.html",
    difficulty: "context-dependent",
  },
  {
    id: "mispronounce-5",
    // Chinese-English mix (common in Andrew's meetings)
    query: "把那个 PRD 打开，就是 Action and Permission 那个 phase one 的文档",
    expectedFile: "PRD-Phase2-Action-Coverage.html",
    difficulty: "bilingual",
  },
];

// Tool definition: the model can call this to "open" a file
const OPEN_FILE_TOOL = {
  name: "open_file",
  description: "Open a file at the given absolute path. Use this when the user asks to open, show, or display a document.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute file path to open",
      },
      reason: {
        type: "string",
        description: "Brief explanation of why this file matches the user's request",
      },
    },
    required: ["path"],
  },
};

// ── Test Runner ─────────────────────────────────────────────────

interface TestResult {
  provider: string;
  queryId: string;
  query: string;
  difficulty: string;
  expectedFile: string;
  toolCalled: boolean;
  toolCallId: string | null;
  calledPath: string | null;
  calledReason: string | null;
  pathCorrect: boolean;
  responseText: string;
  durationMs: number;
  error?: string;
}

async function runSingleTest(
  providerName: VoiceProviderName,
  queryDef: typeof TEST_QUERIES[0],
  timeoutMs = 30000
): Promise<TestResult> {
  const start = Date.now();
  const client = new RealtimeClient();
  
  const result: TestResult = {
    provider: providerName,
    queryId: queryDef.id,
    query: queryDef.query,
    difficulty: queryDef.difficulty,
    expectedFile: queryDef.expectedFile,
    toolCalled: false,
    toolCallId: null,
    calledPath: null,
    calledReason: null,
    pathCorrect: false,
    responseText: "",
    durationMs: 0,
  };

  try {
    // Register the open_file tool
    client.addTool(OPEN_FILE_TOOL);

    // Connect with meeting prep as system instructions
    const systemPrompt = `You are CoCo, an AI meeting assistant participating in a Tanka Link 2.0 review meeting.

Your capabilities:
- You can open files using the open_file tool
- You have access to the meeting context below
- When the user asks to open/show/display a document, identify the correct file path from the context and call open_file

IMPORTANT: The user may mispronounce file names or use approximate descriptions. Use the meeting context to infer which document they mean.

${MEETING_PREP_CONTEXT}`;

    await client.connect(systemPrompt, providerName);

    // Wait for session setup
    await new Promise<void>((resolve) => {
      client.on("session.updated", () => resolve());
      setTimeout(resolve, 3000); // fallback
    });

    // Send the test query as text
    let responseDone = false;
    
    client.on("response.audio_transcript.delta", (e) => {
      result.responseText += e.delta || "";
    });
    
    client.on("response.text.delta", (e) => {
      result.responseText += e.delta || "";
    });

    // Listen for function calls — capture call_id for proper tool result submission
    client.on("response.function_call_arguments.done", (e) => {
      console.log(`[Test] Function call detected: ${e.name} (call_id: ${e.call_id})`, e.arguments);
      if (e.name === "open_file") {
        result.toolCalled = true;
        result.toolCallId = e.call_id || null;
        try {
          const args = JSON.parse(e.arguments || "{}");
          result.calledPath = args.path || null;
          result.calledReason = args.reason || null;
        } catch {}
      }
    });

    // Also listen for the tool call in the response output items
    client.on("response.output_item.done", (e) => {
      if (e.item?.type === "function_call" && e.item?.name === "open_file") {
        result.toolCalled = true;
        result.toolCallId = result.toolCallId || e.item.call_id || null;
        try {
          const args = JSON.parse(e.item.arguments || "{}");
          result.calledPath = result.calledPath || args.path || null;
          result.calledReason = result.calledReason || args.reason || null;
        } catch {}
      }
    });

    client.on("response.done", () => {
      responseDone = true;
    });

    client.on("error", (e) => {
      // Don't overwrite if we already got a successful tool call
      if (!result.toolCalled) {
        result.error = JSON.stringify(e.error || e);
      }
    });

    // Send the query
    client.sendText(queryDef.query);

    // Wait for response (or timeout)
    const deadline = Date.now() + timeoutMs;
    while (!responseDone && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200));
    }

    // If tool was called, submit a result using the real call_id
    if (result.toolCalled && result.calledPath && result.toolCallId) {
      client.submitToolResult(
        result.toolCallId,
        JSON.stringify({ success: true, message: `Opened: ${result.calledPath}` })
      );
      // Wait a bit for the follow-up response
      await new Promise(r => setTimeout(r, 3000));
    }

    // Check if the called path matches expected
    if (result.calledPath) {
      result.pathCorrect = result.calledPath.toLowerCase().includes(
        queryDef.expectedFile.toLowerCase()
      );
    }

    result.durationMs = Date.now() - start;
    client.disconnect();
    
  } catch (e: any) {
    result.error = e.message;
    result.durationMs = Date.now() - start;
    try { client.disconnect(); } catch {}
  }

  return result;
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Realtime 1.5 A/B Test — Mispronunciation + Meeting Prep");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  OpenAI API Key: ${CONFIG.openai.apiKey ? "✓" : "✗"}`);
  console.log(`  Legacy model: ${CONFIG.openai.realtimeModel}`);
  console.log(`  GA 1.5 model: ${CONFIG.openai15.realtimeModel}`);
  console.log(`  Queries: ${TEST_QUERIES.length}`);
  console.log(`  Providers: openai (legacy) vs openai15 (GA 1.5)`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  if (!CONFIG.openai.apiKey) {
    console.error("❌ No OPENAI_API_KEY set. Exiting.");
    process.exit(1);
  }

  const allResults: TestResult[] = [];
  const providers: VoiceProviderName[] = ["openai", "openai15"];

  for (const queryDef of TEST_QUERIES) {
    console.log(`\n── Query: "${queryDef.query.slice(0, 60)}..." [${queryDef.difficulty}]`);
    console.log(`   Expected: ${queryDef.expectedFile}`);

    for (const provider of providers) {
      process.stdout.write(`   ${provider.padEnd(10)} → `);
      
      const result = await runSingleTest(provider, queryDef, 30000);
      allResults.push(result);

      if (result.error) {
        console.log(`❌ Error: ${result.error.slice(0, 80)} (${result.durationMs}ms)`);
      } else if (result.toolCalled) {
        const icon = result.pathCorrect ? "✅" : "⚠️";
        console.log(`${icon} open_file("${result.calledPath?.split("/").pop()}") ${result.pathCorrect ? "CORRECT" : "WRONG"} (${result.durationMs}ms)`);
        if (result.calledReason) console.log(`            reason: "${result.calledReason.slice(0, 80)}"`);
      } else {
        console.log(`❌ No tool call (${result.durationMs}ms) — text: "${result.responseText.slice(0, 100)}"`);
      }

      // Cool-down between tests
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // ── Summary ──────────────────────────────────────────────────

  console.log("\n\n═══════════════════════════════════════════════════════════════");
  console.log("  SUMMARY");
  console.log("═══════════════════════════════════════════════════════════════\n");

  for (const provider of providers) {
    const pResults = allResults.filter(r => r.provider === provider);
    const toolCalls = pResults.filter(r => r.toolCalled).length;
    const correct = pResults.filter(r => r.pathCorrect).length;
    const avgTime = Math.round(pResults.reduce((s, r) => s + r.durationMs, 0) / pResults.length);

    console.log(`${provider.padEnd(12)}: ${correct}/${pResults.length} correct | ${toolCalls}/${pResults.length} tool calls | avg ${avgTime}ms`);
    
    for (const r of pResults) {
      const icon = r.pathCorrect ? "✅" : r.toolCalled ? "⚠️" : "❌";
      console.log(`  ${icon} [${r.difficulty}] ${r.queryId} → ${r.calledPath?.split("/").pop() || "(no call)"}`);
    }
    console.log();
  }

  // Save results
  const outFile = `${__dirname}/results/realtime-15-ab-${Date.now()}.json`;
  const { mkdirSync, writeFileSync } = require("fs");
  mkdirSync(`${__dirname}/results`, { recursive: true });
  writeFileSync(outFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    experiment: "realtime-1.5-mispronunciation-ab-test",
    providers: { legacy: CONFIG.openai.realtimeModel, ga15: CONFIG.openai15.realtimeModel },
    queries: TEST_QUERIES,
    results: allResults,
    summary: providers.map(p => {
      const pr = allResults.filter(r => r.provider === p);
      return {
        provider: p,
        correct: pr.filter(r => r.pathCorrect).length,
        total: pr.length,
        toolCalls: pr.filter(r => r.toolCalled).length,
        avgMs: Math.round(pr.reduce((s, r) => s + r.durationMs, 0) / pr.length),
      };
    }),
  }, null, 2));
  console.log(`Results saved: ${outFile}`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
