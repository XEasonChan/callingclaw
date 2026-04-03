#!/usr/bin/env bun
/**
 * File Agent Benchmark v2 — Fixed for China network
 * 
 * Changes from v1:
 * - Approach 1: Anthropic SDK direct (not OpenRouter) 
 * - Each approach has 60s timeout
 * - Cleaner output
 */

import Anthropic from "@anthropic-ai/sdk";

const QUERY = "帮我找到并打开 tanka action 的第一期 mcp 列表 html 文档";
const SEARCH_ROOT = `${process.env.HOME}/Library/Mobile Documents/com~apple~CloudDocs`;
const SEARCH_DIRS = [
  `${SEARCH_ROOT}/Tanka`,
  `${SEARCH_ROOT}/CallingClaw 2.0/callingclaw-backend/public`,
  `${SEARCH_ROOT}/CallingClaw 2.0/docs`,
  `${process.env.HOME}/.callingclaw/shared`,
];

interface BenchmarkResult {
  approach: string;
  durationMs: number;
  foundPath: string | null;
  success: boolean;
  llmCalls?: number;
  error?: string;
}

function timeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

// ──────────────────────────────────────────────────
// Approach 1: DIY Agent Loop (Anthropic SDK direct)
// ──────────────────────────────────────────────────
async function benchDIYAgent(): Promise<BenchmarkResult> {
  const start = performance.now();
  let llmCalls = 0;

  try {
    const client = new Anthropic(); // Uses ANTHROPIC_API_KEY env var

    const tools: Anthropic.Messages.Tool[] = [
      {
        name: "bash",
        description: "Run a bash command. Use find, grep, ls to search for files.",
        input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] },
      },
      {
        name: "open_file",
        description: "Open a file. Call when you found the target file.",
        input_schema: { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"] },
      },
    ];

    const system = `You are a file search agent. Use bash (find, grep, ls) to locate files, then call open_file. Be efficient — try targeted searches first. Search dirs: ${SEARCH_DIRS.join(", ")}`;

    let messages: Anthropic.Messages.MessageParam[] = [
      { role: "user", content: `Find the HTML file matching: "tanka action 第一期 mcp列表"` },
    ];
    let foundPath: string | null = null;

    for (let turn = 0; turn < 5; turn++) {
      llmCalls++;
      const response = await client.messages.create({
        model: "claude-haiku-4-5-20250414",
        max_tokens: 1024,
        system,
        tools,
        messages,
      });

      // Collect assistant content
      const assistantContent = response.content;
      messages.push({ role: "assistant", content: assistantContent });

      // Check for tool use
      const toolUseBlocks = assistantContent.filter((b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use");
      
      if (toolUseBlocks.length === 0) break; // No more tool calls = done

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const toolUse of toolUseBlocks) {
        const args = toolUse.input as any;
        if (toolUse.name === "bash") {
          try {
            const proc = Bun.spawn(["bash", "-c", args.command], {
              stdout: "pipe", stderr: "pipe", cwd: SEARCH_ROOT,
            });
            const out = await new Response(proc.stdout).text();
            await proc.exited;
            toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: out.slice(0, 4000) || "(empty)" });
          } catch (e: any) {
            toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: `Error: ${e.message}` });
          }
        } else if (toolUse.name === "open_file") {
          foundPath = args.path;
          toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: `Opened: ${args.path}` });
        }
      }

      messages.push({ role: "user", content: toolResults });
      if (foundPath) break;
      if (response.stop_reason === "end_turn") break;
    }

    return {
      approach: "1. DIY Agent Loop (Anthropic SDK direct, Haiku)",
      durationMs: Math.round(performance.now() - start),
      foundPath,
      success: !!foundPath,
      llmCalls,
    };
  } catch (e: any) {
    return {
      approach: "1. DIY Agent Loop (Anthropic SDK direct, Haiku)",
      durationMs: Math.round(performance.now() - start),
      foundPath: null,
      success: false,
      llmCalls,
      error: e.message?.slice(0, 200),
    };
  }
}

// ──────────────────────────────────────────────────
// Approach 2: Claude Code CLI
// ──────────────────────────────────────────────────
async function benchClaudeCodeCLI(): Promise<BenchmarkResult> {
  const start = performance.now();
  try {
    const prompt = `Find HTML files related to "tanka action 第一期 mcp列表" in these dirs:\n${SEARCH_DIRS.join("\n")}\nUse Bash to run find/grep. Return ONLY the absolute path of the best match, nothing else.`;

    const proc = Bun.spawn(["bash", "-c", `echo '${prompt.replace(/'/g, "\\'")}' | claude -p --model haiku --permission-mode bypassPermissions --output-format json --max-turns 5 --no-session-persistence --tools "Bash,Glob,Grep,Read"`], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: `${SEARCH_ROOT}/CallingClaw 2.0`,
    });

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    const durationMs = Math.round(performance.now() - start);

    let foundPath: string | null = null;
    try {
      const parsed = JSON.parse(stdout);
      const text = parsed.result || "";
      const pathMatch = text.match(/\/[^\s"'\n`]+\.html/);
      foundPath = pathMatch?.[0] || null;
    } catch {
      const pathMatch = stdout.match(/\/[^\s"'\n`]+\.html/);
      foundPath = pathMatch?.[0] || null;
    }

    return {
      approach: "2. Claude Code CLI (claude -p haiku)",
      durationMs,
      foundPath,
      success: !!foundPath,
    };
  } catch (e: any) {
    return {
      approach: "2. Claude Code CLI (claude -p haiku)",
      durationMs: Math.round(performance.now() - start),
      foundPath: null,
      success: false,
      error: e.message,
    };
  }
}

// ──────────────────────────────────────────────────
// Approach 3: OpenClaw Agent
// ──────────────────────────────────────────────────
async function benchOpenClawAgent(): Promise<BenchmarkResult> {
  const start = performance.now();
  try {
    const prompt = `Find HTML files related to "tanka action 第一期 mcp列表" in ~/Library/Mobile Documents/com~apple~CloudDocs/Tanka/. Use bash find/grep. Return ONLY the absolute path.`;

    const proc = Bun.spawn([
      "openclaw", "agent",
      "--local",
      "--message", prompt,
      "--json",
      "--timeout", "30",
    ], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: SEARCH_ROOT,
    });

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    const durationMs = Math.round(performance.now() - start);

    let foundPath: string | null = null;
    try {
      const parsed = JSON.parse(stdout);
      const text = parsed.result || parsed.reply || parsed.content || JSON.stringify(parsed);
      const pathMatch = text.match(/\/[^\s"'\n`]+\.html/);
      foundPath = pathMatch?.[0] || null;
    } catch {
      const pathMatch = stdout.match(/\/[^\s"'\n`]+\.html/);
      foundPath = pathMatch?.[0] || null;
    }

    return {
      approach: "3. OpenClaw Agent (--local embedded)",
      durationMs,
      foundPath,
      success: !!foundPath,
    };
  } catch (e: any) {
    return {
      approach: "3. OpenClaw Agent (--local embedded)",
      durationMs: Math.round(performance.now() - start),
      foundPath: null,
      success: false,
      error: e.message,
    };
  }
}

// ──────────────────────────────────────────────────
// Approach 4: Claude Agent SDK
// ──────────────────────────────────────────────────
async function benchClaudeAgentSDK(): Promise<BenchmarkResult> {
  const start = performance.now();
  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    const prompt = `Find HTML files related to "tanka action 第一期 mcp列表" in ${SEARCH_DIRS.join(", ")}. Return ONLY the absolute path.`;

    let resultText = "";
    const stream = query({
      prompt,
      options: {
        cwd: `${SEARCH_ROOT}/CallingClaw 2.0`,
        allowedTools: ["Bash", "Glob", "Grep", "Read"],
        model: "haiku",
      },
    });

    for await (const msg of stream) {
      if (msg.type === "assistant" && msg.message?.content) {
        for (const block of msg.message.content) {
          if ((block as any).type === "text") resultText += (block as any).text;
        }
      }
    }

    const durationMs = Math.round(performance.now() - start);
    const pathMatch = resultText.match(/\/[^\s"'\n`]+\.html/);

    return {
      approach: "4. Claude Agent SDK",
      durationMs,
      foundPath: pathMatch?.[0] || null,
      success: !!pathMatch,
    };
  } catch (e: any) {
    return {
      approach: "4. Claude Agent SDK",
      durationMs: Math.round(performance.now() - start),
      foundPath: null,
      success: false,
      error: `Not available: ${e.message?.slice(0, 100)}`,
    };
  }
}

// ──────────────────────────────────────────────────
// Run all
// ──────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  File Agent Benchmark v2 (Anthropic Direct, 60s timeout)");
  console.log(`  Query: "${QUERY}"`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  const approaches = [
    { name: "DIY Agent Loop", fn: benchDIYAgent },
    { name: "Claude Code CLI", fn: benchClaudeCodeCLI },
    { name: "OpenClaw Agent", fn: benchOpenClawAgent },
    { name: "Claude Agent SDK", fn: benchClaudeAgentSDK },
  ];

  const results: BenchmarkResult[] = [];

  for (let i = 0; i < approaches.length; i++) {
    const { name, fn } = approaches[i]!;
    console.log(`▶ [${i + 1}/${approaches.length}] ${name}...`);
    try {
      const r = await timeout(fn(), 60_000, name);
      results.push(r);
      const status = r.success ? `✅ ${r.foundPath}` : `❌ ${r.error || "no path found"}`;
      console.log(`  ${r.durationMs}ms — ${status}${r.llmCalls ? ` (${r.llmCalls} LLM calls)` : ""}\n`);
    } catch (e: any) {
      results.push({
        approach: `${i + 1}. ${name}`,
        durationMs: 60000,
        foundPath: null,
        success: false,
        error: e.message,
      });
      console.log(`  60000ms — ❌ ${e.message}\n`);
    }
  }

  // Summary
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  RESULTS SUMMARY");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Approach                                    | Time      | OK | LLM");
  console.log("--------------------------------------------|-----------|----|---------");
  for (const r of results) {
    const name = r.approach.padEnd(43).slice(0, 43);
    const time = `${r.durationMs}ms`.padStart(9);
    const ok = r.success ? "✅" : "❌";
    const llm = r.llmCalls ? `${r.llmCalls} calls` : "-";
    console.log(`${name} | ${time} | ${ok} | ${llm}`);
    if (r.foundPath) console.log(`  → ${r.foundPath}`);
    if (r.error) console.log(`  ! ${r.error}`);
  }
  console.log("═══════════════════════════════════════════════════════════════");

  // Save results
  const outDir = `${import.meta.dir}/results`;
  await Bun.write(`${outDir}/file-bench-v2-${Date.now()}.json`, JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2));
  console.log(`\nResults saved to ${outDir}/`);
}

main().catch(console.error);
