#!/usr/bin/env node
/**
 * File Agent Benchmark v3 — Complete & Valid Experiment
 * 
 * MUST run with Node (not Bun) — Bun.spawn breaks HTTPS for child processes.
 * 
 * Tests 4 approaches for: "帮我找到 tanka action 的第一期 mcp 列表 html 文档"
 * 
 * 1. DIY Agent Loop    — OpenRouter + Haiku tool_use (cheapest, most control)
 * 2. Claude Code CLI   — `claude -p` with Tanka team subscription
 * 3. OpenClaw Agent    — `openclaw agent --local` embedded mode
 * 4. Claude Agent SDK  — @anthropic-ai/claude-agent-sdk@0.2.91 (programmatic)
 * 
 * Each approach runs 2 times for consistency.
 */

import { execSync, spawn } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { performance } from "perf_hooks";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = join(__dirname, "../..");
const RESULTS_DIR = join(__dirname, "results");

// Load .env (skip proxy vars — proxy is for Gemini only, not running)
const envPath = join(BACKEND_DIR, ".env");
const SKIP_ENV_KEYS = new Set(["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "http_proxy", "https_proxy"]);
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (m && !SKIP_ENV_KEYS.has(m[1])) process.env[m[1]] = m[2];
  }
}
// Ensure no proxy leaks
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

/** Run a command and return { stdout, stderr, code } */
function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd || SEARCH_ROOT,
      env: { ...process.env, ...opts.env },
      timeout: opts.timeout || 90000,
    });
    let stdout = "", stderr = "";
    child.stdout?.on("data", d => stdout += d);
    child.stderr?.on("data", d => stderr += d);
    child.on("close", code => resolve({ stdout, stderr, code }));
    child.on("error", e => resolve({ stdout, stderr, code: -1, error: e.message }));
  });
}

/** Call OpenRouter API via curl */
async function callOpenRouter(body) {
  const tmpFile = `/tmp/or-bench-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
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
        description: "Run a bash command and get stdout. Use find, ls, grep to search for files.",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      }},
      { type: "function", function: {
        name: "result",
        description: "Report the found file path. Call when you've found the target.",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      }},
    ];

    const system = `You are a file search agent. Find a specific file on disk using bash (find, ls, grep).
When found, call the result tool with the absolute path.
Search directories:\n${SEARCH_DIRS.join("\n")}`;

    const userMsg = `Find: "${QUERY}"\nThis is likely an HTML file related to Tanka Link's MCP tool list/registry.`;

    let messages = [{ role: "system", content: system }, { role: "user", content: userMsg }];
    let foundPath = null;

    for (let turn = 0; turn < 8 && !foundPath; turn++) {
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
          const { stdout, stderr } = await runCmd("bash", ["-c", args.command], { timeout: 10000 });
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
      llmCalls, error: e.message?.slice(0, 300),
    };
  }
}

// ═══════════════════════════════════════════════════
// Approach 2: Claude Code CLI
// ═══════════════════════════════════════════════════
async function benchClaudeCodeCLI() {
  const start = performance.now();

  try {
    const prompt = `Find the HTML file for "tanka action 第一期 mcp 列表" (Tanka Link's MCP tool list/registry). Search in: ${SEARCH_DIRS.join(", ")}. Use find/ls/grep. Return ONLY the absolute path, nothing else.`;

    const { stdout, stderr, code } = await runCmd("claude", [
      "-p", prompt,
      "--model", "haiku",
      "--max-turns", "5",
      "--output-format", "json",
      "--no-session-persistence",
      "--permission-mode", "bypassPermissions",
      "--bare",
    ], { cwd: SEARCH_ROOT, timeout: 120000 });

    const durationMs = Math.round(performance.now() - start);

    let foundPath = null, detail = "";
    try {
      const parsed = JSON.parse(stdout);
      const text = parsed.result || parsed.content || "";
      detail = text.slice(0, 500);
      foundPath = text.match(/\/[^\s"'\n`\]]+\.(html|md|json)/)?.[0] || null;
    } catch {
      detail = stdout.slice(0, 500);
      foundPath = stdout.match(/\/[^\s"'\n`\]]+\.(html|md|json)/)?.[0] || null;
    }

    if (durationMs > 119000) {
      return { approach: "2. Claude Code CLI (haiku)", durationMs, foundPath: null, pathExists: false, success: false, error: `Timeout (${durationMs}ms)`, detail: stderr.slice(0,200) };
    }

    return { approach: "2. Claude Code CLI (haiku)", durationMs, foundPath, pathExists: foundPath ? existsSync(foundPath) : false, success: isValidResult(foundPath), detail };
  } catch (e) {
    return { approach: "2. Claude Code CLI (haiku)", durationMs: Math.round(performance.now() - start), foundPath: null, pathExists: false, success: false, error: e.message?.slice(0, 300) };
  }
}

// ═══════════════════════════════════════════════════
// Approach 3: OpenClaw Agent
// ═══════════════════════════════════════════════════
async function benchOpenClawAgent() {
  const start = performance.now();

  try {
    const prompt = `Find the HTML file for "tanka action 第一期 mcp 列表" (Tanka Link MCP tool list). Search in ${SEARCH_DIRS.join(", ")} using bash find/grep. Return ONLY the absolute file path.`;

    const { stdout, stderr, code } = await runCmd("openclaw", [
      "agent", "--local", "--message", prompt, "--json",
    ], { cwd: SEARCH_ROOT, timeout: 120000 });

    const durationMs = Math.round(performance.now() - start);

    let foundPath = null, detail = "";
    try {
      const parsed = JSON.parse(stdout);
      const text = parsed.result || parsed.reply || parsed.content || JSON.stringify(parsed);
      detail = text.slice(0, 500);
      foundPath = text.match(/\/[^\s"'\n`\]]+\.(html|md|json)/)?.[0] || null;
    } catch {
      detail = stdout.slice(0, 500);
      foundPath = (stdout + stderr).match(/\/[^\s"'\n`\]]+\.(html|md|json)/)?.[0] || null;
    }

    return { approach: "3. OpenClaw Agent (--local)", durationMs, foundPath, pathExists: foundPath ? existsSync(foundPath) : false, success: isValidResult(foundPath), detail: detail || stderr?.slice(0, 200) };
  } catch (e) {
    return { approach: "3. OpenClaw Agent (--local)", durationMs: Math.round(performance.now() - start), foundPath: null, pathExists: false, success: false, error: e.message?.slice(0, 300) };
  }
}

// ═══════════════════════════════════════════════════
// Approach 4: Claude Agent SDK
// ═══════════════════════════════════════════════════
async function benchClaudeAgentSDK() {
  const start = performance.now();

  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const { query } = sdk;

    const prompt = `Find the HTML file for "tanka action 第一期 mcp 列表" (Tanka Link MCP tool list).
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

    const durationMs = Math.round(performance.now() - start);
    const foundPath = resultText.match(/\/[^\s"'\n`\]]+\.(html|md|json)/)?.[0] || null;

    return { approach: "4. Claude Agent SDK", durationMs, foundPath, pathExists: foundPath ? existsSync(foundPath) : false, success: isValidResult(foundPath), detail: resultText.slice(0, 500) };
  } catch (e) {
    return { approach: "4. Claude Agent SDK", durationMs: Math.round(performance.now() - start), foundPath: null, pathExists: false, success: false, error: e.message?.slice(0, 300) };
  }
}

// ═══════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════
async function main() {
  const RUNS = 2;

  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("  File Agent Benchmark v3 — Complete Experiment (Node runtime)");
  console.log(`  Query: "${QUERY}"`);
  console.log(`  Runs: ${RUNS}  |  Search dirs: ${SEARCH_DIRS.length}`);
  console.log(`  OpenRouter: ${process.env.OPENROUTER_API_KEY ? "✓" : "✗"}`);
  console.log(`  Claude CLI: ${(() => { try { execSync("which claude"); return "✓"; } catch { return "✗"; }})()}`);
  console.log(`  OpenClaw: ${(() => { try { execSync("which openclaw"); return "✓"; } catch { return "✗"; }})()}`);
  console.log(`  Agent SDK: ${(() => { try { return "✓ (checking at runtime)"; } catch { return "✗"; }})()}`);
  console.log("═══════════════════════════════════════════════════════════════════\n");

  const allResults = [];
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
        : `✗ ${result.error || result.detail?.slice(0, 80) || "no valid path"}`;
      console.log(`  ${result.durationMs}ms — ${status}`);
      if (result.llmCalls) console.log(`    LLM: ${result.llmCalls} calls, ~${result.tokenEstimate} tokens, ${result.costEstimate}`);

      await new Promise(r => setTimeout(r, 1500));
    }
  }

  // Summary
  console.log("\n\n═══════════════════════════════════════════════════════════════════");
  console.log("  RESULTS SUMMARY");
  console.log("═══════════════════════════════════════════════════════════════════\n");

  const grouped = {};
  for (const r of allResults) (grouped[r.approach] ??= []).push(r);

  console.log("Approach                                | Avg Time  | Success | LLM Calls | Cost/run");
  console.log("----------------------------------------|-----------|---------|-----------|--------");

  for (const [approach, runs] of Object.entries(grouped)) {
    const avgTime = Math.round(runs.reduce((s, r) => s + r.durationMs, 0) / runs.length);
    const successRate = `${runs.filter(r => r.success).length}/${runs.length}`;
    const avgLLM = runs[0].llmCalls != null
      ? (runs.reduce((s, r) => s + (r.llmCalls || 0), 0) / runs.length).toFixed(1)
      : "N/A";
    const cost = runs.find(r => r.costEstimate)?.costEstimate || "included";

    console.log(`${approach.padEnd(39).slice(0, 39)} | ${(avgTime + "ms").padStart(9)} | ${successRate.padStart(7)} | ${avgLLM.padStart(9)} | ${cost}`);

    for (const r of runs) {
      if (r.foundPath) console.log(`  Run ${r.run}: → ${r.foundPath} ${r.pathExists ? "✓" : "✗ (missing)"}`);
      if (r.error) console.log(`  Run ${r.run}: ERROR — ${r.error.slice(0, 120)}`);
    }
  }

  console.log("\n═══════════════════════════════════════════════════════════════════");

  // Save
  mkdirSync(RESULTS_DIR, { recursive: true });
  const outFile = join(RESULTS_DIR, `file-bench-v3-${Date.now()}.json`);
  writeFileSync(outFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    runtime: "Node " + process.version,
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

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
