#!/usr/bin/env node
/**
 * File Agent Benchmark v4 — Fixed & Focused
 * 
 * Fixes from v3:
 * - Approach 1 (DIY): Uses OpenRouter correctly, better search prompt
 * - Approach 2 (Claude CLI): Clears ANTHROPIC_API_KEY env to avoid .env pollution
 * - Approach 3 (OpenClaw Agent): REMOVED — too slow for file search benchmark
 * - Approach 4 (Agent SDK): Uses Claude CLI's firstParty auth (embed mode)
 * 
 * Run: node file-agent-benchmark-v4.mjs
 */

import { execSync, spawn } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { performance } from "perf_hooks";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = join(__dirname, "../..");
const RESULTS_DIR = join(__dirname, "results");

// Load only OPENROUTER_API_KEY from .env (avoid polluting ANTHROPIC_API_KEY)
const envPath = join(BACKEND_DIR, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^(OPENROUTER_API_KEY)=(.+)$/);
    if (m) process.env[m[1]] = m[2];
  }
}

// CRITICAL: Remove any ANTHROPIC_API_KEY from env — it's actually an OpenRouter key
// Claude CLI uses its own auth (Team subscription), not env vars
delete process.env.ANTHROPIC_API_KEY;
delete process.env.HTTPS_PROXY;
delete process.env.HTTP_PROXY;
delete process.env.https_proxy;
delete process.env.http_proxy;

const QUERY = "帮我找到 tanka action 的第一期 mcp 列表 html 文档";
const SEARCH_ROOT = `${process.env.HOME}/Library/Mobile Documents/com~apple~CloudDocs`;
const SEARCH_DIRS = [
  `${SEARCH_ROOT}/Tanka`,
  `${SEARCH_ROOT}/Tanka/Tanka Link 2.0`,
  `${SEARCH_ROOT}/CallingClaw 2.0/callingclaw-backend/public`,
];

const VALID_TARGETS = ["link2-phase2-testing-guide", "tool-registry", "mcp", "link-action", "app-catalog"];

function isValidResult(p) {
  if (!p) return false;
  try { if (!existsSync(p)) return false; } catch { return false; }
  const lower = p.toLowerCase();
  return VALID_TARGETS.some(t => lower.includes(t));
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd || SEARCH_ROOT,
      env: { ...process.env, ...opts.env },
      timeout: opts.timeout || 120000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout?.on("data", d => { stdout += d; });
    child.stderr?.on("data", d => { stderr += d; });
    child.on("close", code => resolve({ stdout, stderr, code }));
    child.on("error", e => resolve({ stdout, stderr, code: -1, error: e.message }));
  });
}

async function callOpenRouter(body) {
  const tmpFile = `/tmp/or-bench-${Date.now()}.json`;
  writeFileSync(tmpFile, JSON.stringify(body));
  try {
    const { stdout, stderr, code } = await runCmd("curl", [
      "-s", "--max-time", "60",
      "https://openrouter.ai/api/v1/chat/completions",
      "-H", "Content-Type: application/json",
      "-H", `Authorization: Bearer ${process.env.OPENROUTER_API_KEY}`,
      "-d", `@${tmpFile}`,
    ]);
    if (code !== 0) throw new Error(`curl exit ${code}: ${stderr.slice(0,200)}`);
    if (!stdout.trim()) throw new Error("Empty response from OpenRouter");
    return JSON.parse(stdout);
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

// ═══════════════════════════════════════════════════
// Approach 1: DIY Agent Loop (OpenRouter + Haiku)
// ═══════════════════════════════════════════════════
async function benchDIYAgentLoop() {
  const start = performance.now();
  let llmCalls = 0, totalTokens = 0;

  try {
    if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY not set");

    const tools = [
      { type: "function", function: {
        name: "bash",
        description: "Run a bash command. Use find/ls/grep to search for files.",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      }},
      { type: "function", function: {
        name: "result",
        description: "Report the found file path.",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      }},
    ];

    const system = `You are a file search agent. Find a specific file on disk.
When found, call the result tool with the absolute path.
TIPS:
- The file is likely named with keywords: link2, phase2, testing, mcp, tool-registry, app-catalog
- It's an HTML file
- Search in these directories: ${SEARCH_DIRS.join(", ")}
- Use: find <dir> -name "*.html" | head -20  to list HTML files first
- Then grep or check filenames for relevance
Be efficient. Don't search too broadly.`;

    const userMsg = `Find: "${QUERY}" — an HTML file about Tanka Link's MCP tool list/registry for phase 1/2 testing.`;

    let messages = [{ role: "system", content: system }, { role: "user", content: userMsg }];
    let foundPath = null;

    for (let turn = 0; turn < 6 && !foundPath; turn++) {
      llmCalls++;
      const data = await callOpenRouter({
        model: "anthropic/claude-haiku-4-5",
        messages, tools, max_tokens: 2048, temperature: 0,
      });

      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      const choice = data.choices?.[0];
      if (!choice) throw new Error("No response choice");

      if (data.usage) totalTokens += (data.usage.prompt_tokens || 0) + (data.usage.completion_tokens || 0);

      const msg = choice.message;
      messages.push(msg);

      if (!msg.tool_calls?.length) break;

      for (const tc of msg.tool_calls) {
        const args = typeof tc.function.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function.arguments;
        
        if (tc.function.name === "bash") {
          const { stdout, stderr } = await runCmd("bash", ["-c", args.command], { timeout: 15000 });
          messages.push({ role: "tool", tool_call_id: tc.id, content: (stdout || stderr || "(empty)").slice(0, 4000) });
        } else if (tc.function.name === "result") {
          foundPath = args.path;
          messages.push({ role: "tool", tool_call_id: tc.id, content: `Found: ${args.path}` });
        }
      }
    }

    return {
      approach: "1. DIY Agent Loop (OpenRouter Haiku)",
      durationMs: Math.round(performance.now() - start),
      foundPath, pathExists: foundPath ? existsSync(foundPath) : false,
      success: isValidResult(foundPath),
      llmCalls, tokenEstimate: totalTokens,
      costEstimate: `~$${((totalTokens / 1_000_000) * 1.0).toFixed(4)}`,
    };
  } catch (e) {
    return {
      approach: "1. DIY Agent Loop (OpenRouter Haiku)",
      durationMs: Math.round(performance.now() - start),
      foundPath: null, pathExists: false, success: false,
      llmCalls, tokenEstimate: totalTokens, error: e.message?.slice(0, 300),
    };
  }
}

// ═══════════════════════════════════════════════════
// Approach 2: Claude Code CLI (Team subscription)
// ═══════════════════════════════════════════════════
async function benchClaudeCodeCLI() {
  const start = performance.now();

  try {
    const prompt = `Find the HTML file for Tanka Link's MCP tool list (第一期 mcp 列表). Search in these directories:
${SEARCH_DIRS.join("\n")}
Use find to list .html files, then identify the right one. Return ONLY the absolute path of the file, nothing else.`;

    // CRITICAL: pass clean env without ANTHROPIC_API_KEY (which is actually an OpenRouter key)
    const cleanEnv = { ...process.env };
    delete cleanEnv.ANTHROPIC_API_KEY;

    const { stdout, stderr, code } = await runCmd("claude", [
      "-p", prompt,
      "--model", "haiku",
      "--max-turns", "5",
      "--output-format", "json",
      "--no-session-persistence",
      "--permission-mode", "bypassPermissions",
    ], { cwd: SEARCH_ROOT, timeout: 120000, env: cleanEnv });

    const durationMs = Math.round(performance.now() - start);

    let foundPath = null, detail = "";
    try {
      const parsed = JSON.parse(stdout);
      const text = parsed.result || parsed.content || "";
      detail = text.slice(0, 500);
      foundPath = text.match(/\/[^\s"'\n`\]]+\.html/)?.[0] || null;
    } catch {
      detail = stdout.slice(0, 500);
      foundPath = stdout.match(/\/[^\s"'\n`\]]+\.html/)?.[0] || null;
    }

    if (stderr?.includes("Invalid API key") || stderr?.includes("401")) {
      return { approach: "2. Claude Code CLI (haiku)", durationMs, foundPath: null, success: false, error: `Auth error: ${stderr.slice(0,200)}` };
    }

    return {
      approach: "2. Claude Code CLI (haiku)",
      durationMs, foundPath,
      pathExists: foundPath ? existsSync(foundPath) : false,
      success: isValidResult(foundPath),
      detail,
    };
  } catch (e) {
    return { approach: "2. Claude Code CLI (haiku)", durationMs: Math.round(performance.now() - start), foundPath: null, success: false, error: e.message?.slice(0, 300) };
  }
}

// ═══════════════════════════════════════════════════
// Approach 3: Claude Agent SDK (embed mode, firstParty auth)
// ═══════════════════════════════════════════════════
async function benchClaudeAgentSDK() {
  const start = performance.now();

  try {
    // Import from callingclaw-backend's node_modules
    const sdkPath = join(BACKEND_DIR, "node_modules/@anthropic-ai/claude-agent-sdk/embed.js");
    if (!existsSync(sdkPath)) throw new Error("Agent SDK not found at " + sdkPath);
    
    const sdk = await import(sdkPath);
    
    // CRITICAL: clean env — remove fake ANTHROPIC_API_KEY
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const prompt = `Find the HTML file for Tanka Link's MCP tool list (第一期 mcp 列表). Search in:
${SEARCH_DIRS.join("\n")}
Use find to list .html files. Return ONLY the absolute file path.`;

    let resultText = "";
    let totalMessages = 0;

    try {
      const stream = sdk.query({
        prompt,
        options: {
          cwd: SEARCH_ROOT,
          allowedTools: ["Bash", "Glob", "Grep", "Read"],
          model: "haiku",
          maxTurns: 5,
          permissionMode: "bypassPermissions",
          dangerouslySkipPermissions: true,
        },
      });

      for await (const msg of stream) {
        totalMessages++;
        if (msg.type === "assistant" && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === "text") resultText += block.text;
          }
        }
        if (totalMessages > 100) break;
      }
    } finally {
      // Restore env
      if (savedKey) process.env.ANTHROPIC_API_KEY = savedKey;
    }

    const durationMs = Math.round(performance.now() - start);
    const foundPath = resultText.match(/\/[^\s"'\n`\]]+\.html/)?.[0] || null;

    return {
      approach: "3. Claude Agent SDK (embed)",
      durationMs, foundPath,
      pathExists: foundPath ? existsSync(foundPath) : false,
      success: isValidResult(foundPath),
      detail: resultText.slice(0, 500),
    };
  } catch (e) {
    return { approach: "3. Claude Agent SDK (embed)", durationMs: Math.round(performance.now() - start), foundPath: null, success: false, error: e.message?.slice(0, 300) };
  }
}

// ═══════════════════════════════════════════════════
// Approach 4: Single-shot deterministic (no LLM, baseline)
// ═══════════════════════════════════════════════════
async function benchDeterministic() {
  const start = performance.now();

  try {
    // Just search for HTML files with relevant names
    const { stdout } = await runCmd("bash", ["-c",
      `find ${SEARCH_DIRS.map(d => `"${d}"`).join(" ")} -maxdepth 3 -name "*.html" 2>/dev/null | grep -iE "(link2|phase2|testing|mcp|tool-registry|app-catalog)" | head -5`
    ], { timeout: 10000 });

    const durationMs = Math.round(performance.now() - start);
    const lines = stdout.trim().split("\n").filter(Boolean);
    const foundPath = lines[0] || null;

    return {
      approach: "4. Deterministic Search (baseline, no LLM)",
      durationMs, foundPath,
      pathExists: foundPath ? existsSync(foundPath) : false,
      success: isValidResult(foundPath),
      llmCalls: 0, tokenEstimate: 0, costEstimate: "$0.0000",
      allMatches: lines,
    };
  } catch (e) {
    return { approach: "4. Deterministic Search (baseline)", durationMs: Math.round(performance.now() - start), foundPath: null, success: false, error: e.message?.slice(0, 300) };
  }
}

// ═══════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════
async function main() {
  const RUNS = 2;

  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("  File Agent Benchmark v4 — Fixed & Focused");
  console.log(`  Query: "${QUERY}"`);
  console.log(`  Runs: ${RUNS}  |  Search dirs: ${SEARCH_DIRS.length}`);
  console.log(`  OpenRouter: ${process.env.OPENROUTER_API_KEY ? "✓" : "✗"}`);
  console.log(`  ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? "⚠️ SET (will be cleaned)" : "✓ not set"}`);
  console.log(`  Claude CLI: ${(() => { try { execSync("which claude", { stdio: "pipe" }); return "✓ " + execSync("claude --version", { stdio: "pipe" }).toString().trim(); } catch { return "✗"; }})()}`);
  console.log(`  Agent SDK: ${existsSync(join(BACKEND_DIR, "node_modules/@anthropic-ai/claude-agent-sdk")) ? "✓" : "✗"}`);
  console.log("═══════════════════════════════════════════════════════════════════\n");

  // Clear the bad ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_API_KEY;

  const allResults = [];
  const approaches = [
    { name: "1. DIY Agent Loop (OpenRouter)", fn: benchDIYAgentLoop },
    { name: "2. Claude Code CLI (Team)", fn: benchClaudeCodeCLI },
    { name: "3. Claude Agent SDK (embed)", fn: benchClaudeAgentSDK },
    { name: "4. Deterministic (baseline)", fn: benchDeterministic },
  ];

  for (const { name, fn } of approaches) {
    console.log(`\n▶ ${name}`);
    console.log("─".repeat(60));

    for (let run = 1; run <= RUNS; run++) {
      process.stdout.write(`  Run ${run}/${RUNS}... `);
      const result = await fn();
      result.run = run;
      allResults.push(result);

      const status = result.success
        ? `✓ ${result.foundPath}`
        : `✗ ${result.error || result.detail?.slice(0, 100) || "no valid path found"}`;
      console.log(`${result.durationMs}ms — ${status}`);
      if (result.llmCalls) console.log(`    LLM: ${result.llmCalls} calls, ~${result.tokenEstimate} tokens, ${result.costEstimate}`);
      if (result.allMatches) console.log(`    Matches: ${result.allMatches.join(", ")}`);

      // Cool-down between runs
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // ═══════════ Summary ═══════════
  console.log("\n\n═══════════════════════════════════════════════════════════════════");
  console.log("  RESULTS SUMMARY");
  console.log("═══════════════════════════════════════════════════════════════════\n");

  const grouped = {};
  for (const r of allResults) (grouped[r.approach] ??= []).push(r);

  console.log("Approach                                      | Avg Time    | Success | LLM Calls | Cost/run");
  console.log("----------------------------------------------|-------------|---------|-----------|--------");

  for (const [approach, runs] of Object.entries(grouped)) {
    const avgTime = Math.round(runs.reduce((s, r) => s + r.durationMs, 0) / runs.length);
    const successRate = `${runs.filter(r => r.success).length}/${runs.length}`;
    const avgLLM = runs[0].llmCalls != null
      ? (runs.reduce((s, r) => s + (r.llmCalls || 0), 0) / runs.length).toFixed(1)
      : "N/A";
    const cost = runs.find(r => r.costEstimate)?.costEstimate || "included";

    console.log(`${approach.padEnd(45).slice(0, 45)} | ${(avgTime + "ms").padStart(11)} | ${successRate.padStart(7)} | ${avgLLM.padStart(9)} | ${cost}`);

    for (const r of runs) {
      if (r.foundPath) console.log(`  → Run ${r.run}: ${r.foundPath} ${r.pathExists ? "✓ exists" : "✗ missing"}`);
      if (r.error) console.log(`  ⚠ Run ${r.run}: ${r.error.slice(0, 150)}`);
    }
  }

  console.log("\n═══════════════════════════════════════════════════════════════════");

  // Save results
  mkdirSync(RESULTS_DIR, { recursive: true });
  const outFile = join(RESULTS_DIR, `file-bench-v4-${Date.now()}.json`);
  writeFileSync(outFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    version: "v4",
    runtime: "Node " + process.version,
    query: QUERY,
    runsPerApproach: RUNS,
    searchDirs: SEARCH_DIRS,
    fixes: [
      "Removed ANTHROPIC_API_KEY from env (was OpenRouter key, caused 401 on Claude CLI/SDK)",
      "Improved DIY prompt with better search hints",
      "Replaced OpenClaw Agent with deterministic baseline",
      "Agent SDK uses embed mode with firstParty auth",
    ],
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

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
