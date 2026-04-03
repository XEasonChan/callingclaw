#!/usr/bin/env bun
/**
 * Benchmark: 4 approaches for "帮我打开tanka action的第一期mcp列表html文档"
 *
 * Tests:
 * 1. DIY Agent Loop    — @anthropic-ai/sdk tool_use with Haiku (fastest, cheapest)
 * 2. Claude Code CLI   — `claude -p --model haiku --max-turns 5`
 * 3. OpenClaw Agent    — `openclaw agent --local --message ...`
 * 4. Claude Agent SDK  — @anthropic-ai/claude-agent-sdk (if installed)
 *
 * Each approach must: search local dirs → find the best matching HTML → return its path.
 * We measure: total wall time, success, found path.
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
  detail?: string;
}

// ──────────────────────────────────────────────────
// Approach 1: DIY Agent Loop (Anthropic SDK + tool_use)
// Minimal: 2 tools, Haiku, max 5 turns
// ──────────────────────────────────────────────────
/** Call OpenRouter via curl (Bun fetch has DNS/TLS issues with some endpoints) */
async function callOpenRouter(body: any): Promise<any> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const proc = Bun.spawn(["curl", "-s", "https://openrouter.ai/api/v1/chat/completions",
    "-H", "Content-Type: application/json",
    "-H", `Authorization: Bearer ${apiKey}`,
    "-d", JSON.stringify(body),
  ], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return JSON.parse(out);
}

async function benchDIYAgent(): Promise<BenchmarkResult> {
  const start = performance.now();
  let llmCalls = 0;

  try {
    if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY not set");

    const tools = [
      { type: "function", function: {
        name: "bash",
        description: "Run a bash command. Use find, grep, ls to search for files.",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      }},
      { type: "function", function: {
        name: "open_file",
        description: "Open a file. Call when you found the target file.",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      }},
    ];

    const system = `You are a file search agent. Use bash (find, grep, ls) to locate files, then call open_file. Be efficient — try targeted searches first.`;
    const userPrompt = `Find the HTML file matching: "tanka action 第一期 mcp列表"\nSearch in:\n${SEARCH_DIRS.join("\n")}`;

    let messages: any[] = [{ role: "system", content: system }, { role: "user", content: userPrompt }];
    let foundPath: string | null = null;

    for (let turn = 0; turn < 5; turn++) {
      llmCalls++;
      const data = await callOpenRouter({
        model: "anthropic/claude-haiku-4-5",
        messages,
        tools,
        max_tokens: 1024,
        temperature: 0,
      });

      const choice = data.choices?.[0];
      if (!choice) break;

      const msg = choice.message;
      messages.push(msg);

      // Process tool calls
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          const args = typeof tc.function.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function.arguments;
          if (tc.function.name === "bash") {
            try {
              const proc = Bun.spawn(["bash", "-c", args.command], {
                stdout: "pipe", stderr: "pipe", cwd: SEARCH_ROOT,
              });
              const out = await new Response(proc.stdout).text();
              await proc.exited;
              messages.push({ role: "tool", tool_call_id: tc.id, content: out.slice(0, 4000) || "(empty)" });
            } catch (e: any) {
              messages.push({ role: "tool", tool_call_id: tc.id, content: `Error: ${e.message}` });
            }
          } else if (tc.function.name === "open_file") {
            foundPath = args.path;
            messages.push({ role: "tool", tool_call_id: tc.id, content: `Opened: ${args.path}` });
          }
        }
      }

      if (foundPath || choice.finish_reason === "stop") break;
    }

    return {
      approach: "DIY Agent Loop (Haiku tool_use)",
      durationMs: Math.round(performance.now() - start),
      foundPath,
      success: !!foundPath,
      llmCalls,
    };
  } catch (e: any) {
    return {
      approach: "DIY Agent Loop (Haiku tool_use)",
      durationMs: Math.round(performance.now() - start),
      foundPath: null,
      success: false,
      llmCalls,
      error: e.message?.slice(0, 200),
    };
  }
}

// ──────────────────────────────────────────────────
// Approach 2: Claude Code CLI (`claude -p`)
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
      approach: "Claude Code CLI (claude -p haiku)",
      durationMs,
      foundPath,
      success: !!foundPath,
    };
  } catch (e: any) {
    return {
      approach: "Claude Code CLI (claude -p haiku)",
      durationMs: Math.round(performance.now() - start),
      foundPath: null,
      success: false,
      error: e.message,
    };
  }
}

// ──────────────────────────────────────────────────
// Approach 3: OpenClaw Agent (local embedded mode)
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
    const stderr = await new Response(proc.stderr).text();
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
      approach: "OpenClaw Agent (--local embedded)",
      durationMs,
      foundPath,
      success: !!foundPath,
      detail: stderr?.slice(0, 200),
    };
  } catch (e: any) {
    return {
      approach: "OpenClaw Agent (--local embedded)",
      durationMs: Math.round(performance.now() - start),
      foundPath: null,
      success: false,
      error: e.message,
    };
  }
}

// ──────────────────────────────────────────────────
// Approach 4: Claude Agent SDK (programmatic)
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
      approach: "Claude Agent SDK",
      durationMs,
      foundPath: pathMatch?.[0] || null,
      success: !!pathMatch,
    };
  } catch (e: any) {
    return {
      approach: "Claude Agent SDK",
      durationMs: Math.round(performance.now() - start),
      foundPath: null,
      success: false,
      error: `Not available: ${e.message?.slice(0, 100)}`,
    };
  }
}

// ──────────────────────────────────────────────────
// Run all benchmarks
// ──────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  File Agent Benchmark: Fuzzy File Search → Open");
  console.log(`  Query: "${QUERY}"`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  const results: BenchmarkResult[] = [];

  // Run sequentially to avoid resource contention
  const approaches = [
    { name: "DIY Agent Loop (Haiku tool_use)", fn: benchDIYAgent },
    { name: "Claude Code CLI", fn: benchClaudeCodeCLI },
    { name: "OpenClaw Agent", fn: benchOpenClawAgent },
    { name: "Claude Agent SDK", fn: benchClaudeAgentSDK },
  ];

  for (let i = 0; i < approaches.length; i++) {
    const { name, fn } = approaches[i]!;
    console.log(`▶ [${i + 1}/${approaches.length}] ${name}...`);
    const r = await fn();
    results.push(r);
    const status = r.success ? `✓ ${r.foundPath}` : `✗ ${r.error || "no path found"}`;
    console.log(`  ${r.durationMs}ms — ${status}${r.llmCalls ? ` (${r.llmCalls} LLM calls)` : ""}\n`);
  }

  // Summary table
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  RESULTS");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Approach                              | Time     | OK | LLM");
  console.log("--------------------------------------|----------|----|---------");
  for (const r of results) {
    const name = r.approach.padEnd(37).slice(0, 37);
    const time = `${r.durationMs}ms`.padStart(8);
    const ok = r.success ? "✓ " : "✗ ";
    const llm = r.llmCalls ? `${r.llmCalls} calls` : "-";
    console.log(`${name} | ${time} | ${ok} | ${llm}`);
    if (r.foundPath) console.log(`  → ${r.foundPath}`);
    if (r.error) console.log(`  ! ${r.error}`);
  }
  console.log("═══════════════════════════════════════════════════════════════");
}

main().catch(console.error);
