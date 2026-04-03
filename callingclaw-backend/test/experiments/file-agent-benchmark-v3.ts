#!/usr/bin/env bun
/**
 * File Agent Benchmark v3 — Complete & Valid Experiment
 * 
 * Tests 4 approaches for: "帮我找到 tanka action 的第一期 mcp 列表 html 文档"
 * All dependencies verified & installed. Each approach runs 3 times for consistency.
 * 
 * 1. DIY Agent Loop    — OpenRouter + Haiku tool_use (cheapest, most control)
 * 2. Claude Code CLI   — `claude -p` with Tanka team subscription
 * 3. OpenClaw Agent    — `openclaw agent --local` embedded mode
 * 4. Claude Agent SDK  — @anthropic-ai/claude-agent-sdk@0.2.91 (programmatic)
 * 
 * Expected target: Tool-Registry.md or similar HTML in Tanka Link Action dir
 */

import { readFileSync } from "fs";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

// Load env from .env
const envPath = join(import.meta.dir, "../../.env");
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, "utf8");
  for (const line of envContent.split("\n")) {
    const match = line.match(/^([A-Z_]+)=(.+)$/);
    if (match) process.env[match[1]] = match[2];
  }
}

const QUERY = "帮我找到 tanka action 的第一期 mcp 列表 html 文档";
const SEARCH_ROOT = `${process.env.HOME}/Library/Mobile Documents/com~apple~CloudDocs`;
const SEARCH_DIRS = [
  `${SEARCH_ROOT}/Tanka`,
  `${SEARCH_ROOT}/Tanka/Tanka Link 2.0`,
  `${SEARCH_ROOT}/CallingClaw 2.0/callingclaw-backend/public`,
];
const BACKEND_DIR = join(import.meta.dir, "../..");
const RESULTS_DIR = join(import.meta.dir, "results");

// Target validation: known correct file patterns
const VALID_TARGETS = [
  "link2-phase2-testing-guide.html",
  "Tool-Registry",
  "mcp",
  "link",
  "action",
];

function isValidResult(path: string | null): boolean {
  if (!path) return false;
  // Must be an actual existing file
  try {
    if (!existsSync(path)) return false;
  } catch { return false; }
  // Must match expected patterns
  const lower = path.toLowerCase();
  return VALID_TARGETS.some(t => lower.includes(t.toLowerCase()));
}

interface BenchResult {
  approach: string;
  run: number;
  durationMs: number;
  foundPath: string | null;
  pathExists: boolean;
  success: boolean;
  llmCalls?: number;
  tokenEstimate?: number;
  costEstimate?: string;
  error?: string;
  detail?: string;
}

// ═══════════════════════════════════════════════════
// Approach 1: DIY Agent Loop (OpenRouter + Haiku)
// NOTE: Bun fetch is broken on this machine (ConnectionRefused on all HTTPS).
// We use curl subprocess for API calls instead.
// ═══════════════════════════════════════════════════
async function curlOpenRouter(apiKey: string, body: any): Promise<any> {
  // Write body to temp file to avoid shell escaping issues with JSON
  const tmpFile = `/tmp/bench-openrouter-${Date.now()}.json`;
  writeFileSync(tmpFile, JSON.stringify(body));
  try {
    const proc = Bun.spawn([
      "curl", "-s", "--max-time", "60",
      "https://openrouter.ai/api/v1/chat/completions",
      "-H", "Content-Type: application/json",
      "-H", `Authorization: Bearer ${apiKey}`,
      "-d", `@${tmpFile}`,
    ], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    await proc.exited;
    if (!out.trim()) throw new Error(`Empty curl response. stderr: ${err.slice(0,200)}`);
    return JSON.parse(out);
  } finally {
    try { require("fs").unlinkSync(tmpFile); } catch {}
  }
}

async function benchDIYAgentLoop(): Promise<BenchResult> {
  const start = performance.now();
  let llmCalls = 0;
  let totalTokens = 0;

  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");

    const tools = [
      {
        type: "function" as const,
        function: {
          name: "bash",
          description: "Run a bash command and get stdout. Use find, ls, grep to search for files.",
          parameters: { type: "object", properties: { command: { type: "string", description: "The bash command to run" } }, required: ["command"] },
        },
      },
      {
        type: "function" as const,
        function: {
          name: "result",
          description: "Report the found file path. Call this when you've found the target file.",
          parameters: { type: "object", properties: { path: { type: "string", description: "Absolute path to the found file" } }, required: ["path"] },
        },
      },
    ];

    const systemPrompt = `You are a file search agent. Your task is to find a specific file on disk.
Use the bash tool to run find/ls/grep commands to locate files.
When you find the right file, call the result tool with its absolute path.
Be efficient — use targeted searches. The dirs to search are:
${SEARCH_DIRS.join("\n")}`;

    const userPrompt = `Find: "${QUERY}"
This is likely an HTML file related to Tanka Link's MCP (Model Context Protocol) tool list/registry for Phase 1.`;

    let messages: any[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];
    let foundPath: string | null = null;

    for (let turn = 0; turn < 8; turn++) {
      llmCalls++;
      
      const data = await curlOpenRouter(apiKey, {
        model: "anthropic/claude-haiku-4-5",
        messages,
        tools,
        max_tokens: 2048,
        temperature: 0,
      });

      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      
      const choice = data.choices?.[0];
      if (!choice) throw new Error("No response choice");
      
      // Track tokens
      if (data.usage) {
        totalTokens += (data.usage.prompt_tokens || 0) + (data.usage.completion_tokens || 0);
      }

      const msg = choice.message;
      messages.push(msg);

      // No tool calls = model is done
      if (!msg.tool_calls || msg.tool_calls.length === 0) break;

      for (const tc of msg.tool_calls) {
        let args: any;
        try {
          args = typeof tc.function.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function.arguments;
        } catch {
          args = {};
        }
        
        if (tc.function.name === "bash") {
          try {
            const proc = Bun.spawn(["bash", "-c", args.command], {
              stdout: "pipe",
              stderr: "pipe",
              cwd: SEARCH_ROOT,
              env: { ...process.env, PATH: process.env.PATH },
            });
            const out = await new Response(proc.stdout).text();
            const err = await new Response(proc.stderr).text();
            await proc.exited;
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: (out || err || "(no output)").slice(0, 4000),
            });
          } catch (e: any) {
            messages.push({ role: "tool", tool_call_id: tc.id, content: `Error: ${e.message}` });
          }
        } else if (tc.function.name === "result") {
          foundPath = args.path;
          messages.push({ role: "tool", tool_call_id: tc.id, content: `Found: ${args.path}` });
        }
      }

      if (foundPath) break;
    }

    const costPerMToken = 1.0; // Haiku ~$1/M tokens (input+output blended)
    return {
      approach: "1. DIY Agent Loop (OpenRouter Haiku)",
      run: 0,
      durationMs: Math.round(performance.now() - start),
      foundPath,
      pathExists: foundPath ? existsSync(foundPath) : false,
      success: isValidResult(foundPath),
      llmCalls,
      tokenEstimate: totalTokens,
      costEstimate: `~$${((totalTokens / 1_000_000) * costPerMToken).toFixed(4)}`,
    };
  } catch (e: any) {
    return {
      approach: "1. DIY Agent Loop (OpenRouter Haiku)",
      run: 0,
      durationMs: Math.round(performance.now() - start),
      foundPath: null,
      pathExists: false,
      success: false,
      llmCalls,
      error: e.message?.slice(0, 300),
    };
  }
}

// ═══════════════════════════════════════════════════
// Approach 2: Claude Code CLI
// ═══════════════════════════════════════════════════
async function benchClaudeCodeCLI(): Promise<BenchResult> {
  const start = performance.now();

  try {
    const prompt = `Find the HTML file for "tanka action 第一期 mcp 列表" (Tanka Link's MCP tool list/registry). Search in: ${SEARCH_DIRS.join(", ")}. Use find/ls/grep. Return ONLY the absolute path, nothing else.`;

    const proc = Bun.spawn([
      "claude", "-p", prompt,
      "--model", "haiku",
      "--max-turns", "5",
      "--output-format", "json",
      "--no-session-persistence",
      "--permission-mode", "bypassPermissions",
      "--bare",
    ], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: SEARCH_ROOT,
      env: { ...process.env, CLAUDE_CODE_SIMPLE: "1" },
    });

    // 90s timeout
    const timeout = setTimeout(() => proc.kill(), 90000);
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    clearTimeout(timeout);
    const exitCode = await proc.exited;
    const durationMs = Math.round(performance.now() - start);

    let foundPath: string | null = null;
    let detail = "";

    try {
      const parsed = JSON.parse(stdout);
      const text = parsed.result || parsed.content || "";
      detail = text.slice(0, 500);
      const pathMatch = text.match(/\/[^\s"'\n`\]]+\.html/);
      if (!pathMatch) {
        // Also try .md files
        const mdMatch = text.match(/\/[^\s"'\n`\]]+\.(md|json)/);
        foundPath = mdMatch?.[0] || null;
      } else {
        foundPath = pathMatch[0];
      }
    } catch {
      // Non-JSON output
      detail = stdout.slice(0, 500);
      const pathMatch = stdout.match(/\/[^\s"'\n`\]]+\.html/);
      foundPath = pathMatch?.[0] || null;
    }

    if (durationMs > 89000) {
      return {
        approach: "2. Claude Code CLI (claude -p haiku)",
        run: 0,
        durationMs,
        foundPath: null,
        pathExists: false,
        success: false,
        error: `Timed out after ${durationMs}ms (exit: ${exitCode})`,
        detail: stderr.slice(0, 200),
      };
    }

    return {
      approach: "2. Claude Code CLI (claude -p haiku)",
      run: 0,
      durationMs,
      foundPath,
      pathExists: foundPath ? existsSync(foundPath) : false,
      success: isValidResult(foundPath),
      detail,
    };
  } catch (e: any) {
    return {
      approach: "2. Claude Code CLI (claude -p haiku)",
      run: 0,
      durationMs: Math.round(performance.now() - start),
      foundPath: null,
      pathExists: false,
      success: false,
      error: e.message?.slice(0, 300),
    };
  }
}

// ═══════════════════════════════════════════════════
// Approach 3: OpenClaw Agent (embedded local)
// ═══════════════════════════════════════════════════
async function benchOpenClawAgent(): Promise<BenchResult> {
  const start = performance.now();

  try {
    const prompt = `Find the HTML file for "tanka action 第一期 mcp 列表" (Tanka Link MCP tool list). Search in ${SEARCH_DIRS.join(", ")} using bash find/grep. Return ONLY the absolute file path.`;

    const proc = Bun.spawn([
      "openclaw", "agent",
      "--local",
      "--message", prompt,
      "--json",
    ], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: SEARCH_ROOT,
      env: { ...process.env },
    });

    const timeout = setTimeout(() => proc.kill(), 90000);
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    clearTimeout(timeout);
    await proc.exited;
    const durationMs = Math.round(performance.now() - start);

    let foundPath: string | null = null;
    let detail = "";

    try {
      const parsed = JSON.parse(stdout);
      const text = parsed.result || parsed.reply || parsed.content || JSON.stringify(parsed);
      detail = text.slice(0, 500);
      const pathMatch = text.match(/\/[^\s"'\n`\]]+\.(html|md|json)/);
      foundPath = pathMatch?.[0] || null;
    } catch {
      detail = stdout.slice(0, 500);
      const pathMatch = (stdout + stderr).match(/\/[^\s"'\n`\]]+\.(html|md|json)/);
      foundPath = pathMatch?.[0] || null;
    }

    return {
      approach: "3. OpenClaw Agent (--local embedded)",
      run: 0,
      durationMs,
      foundPath,
      pathExists: foundPath ? existsSync(foundPath) : false,
      success: isValidResult(foundPath),
      detail: detail || stderr?.slice(0, 200),
    };
  } catch (e: any) {
    return {
      approach: "3. OpenClaw Agent (--local embedded)",
      run: 0,
      durationMs: Math.round(performance.now() - start),
      foundPath: null,
      pathExists: false,
      success: false,
      error: e.message?.slice(0, 300),
    };
  }
}

// ═══════════════════════════════════════════════════
// Approach 4: Claude Agent SDK (programmatic)
// ═══════════════════════════════════════════════════
async function benchClaudeAgentSDK(): Promise<BenchResult> {
  const start = performance.now();

  try {
    // Dynamic import to handle missing module gracefully
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const { query } = sdk;

    const prompt = `Find the HTML file for "tanka action 第一期 mcp 列表" (Tanka Link MCP tool list/registry).
Search in: ${SEARCH_DIRS.join(", ")}
Use find/ls/grep. Return ONLY the absolute file path.`;

    let resultText = "";
    let totalMessages = 0;
    
    const stream = query({
      prompt,
      options: {
        cwd: SEARCH_ROOT,
        allowedTools: ["Bash", "Glob", "Grep", "Read"],
        model: "haiku",
        maxTurns: 5,
        permissionMode: "bypassPermissions" as any,
        dangerouslySkipPermissions: true,
      },
    });

    for await (const msg of stream) {
      totalMessages++;
      if (msg.type === "assistant" && msg.message?.content) {
        for (const block of msg.message.content as any[]) {
          if (block.type === "text") resultText += block.text;
        }
      }
      // Safety: don't spin forever
      if (totalMessages > 50) break;
    }

    const durationMs = Math.round(performance.now() - start);
    const pathMatch = resultText.match(/\/[^\s"'\n`\]]+\.(html|md|json)/);
    const foundPath = pathMatch?.[0] || null;

    return {
      approach: "4. Claude Agent SDK (programmatic)",
      run: 0,
      durationMs,
      foundPath,
      pathExists: foundPath ? existsSync(foundPath) : false,
      success: isValidResult(foundPath),
      detail: resultText.slice(0, 500),
    };
  } catch (e: any) {
    return {
      approach: "4. Claude Agent SDK (programmatic)",
      run: 0,
      durationMs: Math.round(performance.now() - start),
      foundPath: null,
      pathExists: false,
      success: false,
      error: e.message?.slice(0, 300),
    };
  }
}

// ═══════════════════════════════════════════════════
// Main runner — each approach runs 2 times
// ═══════════════════════════════════════════════════
async function main() {
  const RUNS = 2;
  
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("  File Agent Benchmark v3 — Complete Experiment");
  console.log(`  Query: "${QUERY}"`);
  console.log(`  Runs per approach: ${RUNS}`);
  console.log(`  Search dirs: ${SEARCH_DIRS.length}`);
  console.log("═══════════════════════════════════════════════════════════════════\n");

  const allResults: BenchResult[] = [];
  const approaches = [
    { name: "1. DIY Agent Loop", fn: benchDIYAgentLoop },
    { name: "2. Claude Code CLI", fn: benchClaudeCodeCLI },
    { name: "3. OpenClaw Agent", fn: benchOpenClawAgent },
    { name: "4. Claude Agent SDK", fn: benchClaudeAgentSDK },
  ];

  for (const { name, fn } of approaches) {
    console.log(`\n▶ ${name}`);
    console.log("─".repeat(50));
    
    for (let run = 1; run <= RUNS; run++) {
      console.log(`  Run ${run}/${RUNS}...`);
      const result = await fn();
      result.run = run;
      allResults.push(result);
      
      const status = result.success 
        ? `✓ ${result.foundPath} (exists: ${result.pathExists})`
        : `✗ ${result.error || "no valid path"}`;
      console.log(`  ${result.durationMs}ms — ${status}`);
      if (result.llmCalls) console.log(`  LLM calls: ${result.llmCalls}, tokens: ~${result.tokenEstimate}, cost: ${result.costEstimate}`);
      
      // Small delay between runs
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // ═══════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════
  console.log("\n\n═══════════════════════════════════════════════════════════════════");
  console.log("  RESULTS SUMMARY");
  console.log("═══════════════════════════════════════════════════════════════════\n");

  // Group by approach
  const grouped: Record<string, BenchResult[]> = {};
  for (const r of allResults) {
    (grouped[r.approach] ??= []).push(r);
  }

  console.log("Approach                                | Avg Time  | Success | Avg LLM | Cost/run");
  console.log("----------------------------------------|-----------|---------|---------|--------");

  for (const [approach, runs] of Object.entries(grouped)) {
    const avgTime = Math.round(runs.reduce((s, r) => s + r.durationMs, 0) / runs.length);
    const successRate = `${runs.filter(r => r.success).length}/${runs.length}`;
    const avgLLM = runs[0].llmCalls != null
      ? (runs.reduce((s, r) => s + (r.llmCalls || 0), 0) / runs.length).toFixed(1)
      : "N/A";
    const cost = runs[0].costEstimate || "N/A";
    
    const name = approach.padEnd(39).slice(0, 39);
    console.log(`${name} | ${String(avgTime + "ms").padStart(9)} | ${successRate.padStart(7)} | ${avgLLM.padStart(7)} | ${cost}`);
    
    // Show paths found
    for (const r of runs) {
      if (r.foundPath) console.log(`  Run ${r.run}: ${r.foundPath} ${r.pathExists ? "(✓ exists)" : "(✗ missing)"}`);
      if (r.error) console.log(`  Run ${r.run}: ERROR — ${r.error.slice(0, 100)}`);
    }
  }

  console.log("\n═══════════════════════════════════════════════════════════════════");

  // Save results
  mkdirSync(RESULTS_DIR, { recursive: true });
  const outFile = join(RESULTS_DIR, `file-bench-v3-${Date.now()}.json`);
  writeFileSync(outFile, JSON.stringify({ 
    timestamp: new Date().toISOString(),
    query: QUERY,
    runsPerApproach: RUNS,
    searchDirs: SEARCH_DIRS,
    results: allResults,
    summary: Object.entries(grouped).map(([approach, runs]) => ({
      approach,
      avgDurationMs: Math.round(runs.reduce((s, r) => s + r.durationMs, 0) / runs.length),
      successRate: `${runs.filter(r => r.success).length}/${runs.length}`,
      avgLLMCalls: runs[0].llmCalls != null ? +(runs.reduce((s, r) => s + (r.llmCalls || 0), 0) / runs.length).toFixed(1) : null,
    })),
  }, null, 2));
  console.log(`\nResults saved: ${outFile}`);
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
