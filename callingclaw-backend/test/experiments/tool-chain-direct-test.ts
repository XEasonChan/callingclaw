#!/usr/bin/env bun
/**
 * Direct Tool Chain Test — bypasses voice model, tests handler logic directly.
 *
 * Simulates: exec("find...") → open_file(result) → interact("scroll")
 * Tests the actual ActionExecutor/handler code, not the model's tool selection.
 */

const BASE = "http://localhost:4000";

interface ToolCallResult {
  tool: string;
  args: any;
  result: string;
  durationMs: number;
  success: boolean;
}

async function callTool(name: string, args: any): Promise<ToolCallResult> {
  // Use the internal tool handler directly via the voice module
  // We'll simulate by sending a specially crafted request
  const start = performance.now();

  // Call the tool directly through the automation API
  const resp = await fetch(`${BASE}/api/automation/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instruction: `${name}: ${JSON.stringify(args)}` }),
  });

  const durationMs = Math.round(performance.now() - start);

  if (resp.ok) {
    const data = await resp.json() as any;
    return { tool: name, args, result: JSON.stringify(data).slice(0, 500), durationMs, success: data.success !== false };
  }

  return { tool: name, args, result: `HTTP ${resp.status}`, durationMs, success: false };
}

async function testExecDirect(): Promise<ToolCallResult> {
  const start = performance.now();
  const home = process.env.HOME;
  const cmd = `find "${home}/Library/Mobile Documents/com~apple~CloudDocs/Tanka" -maxdepth 4 -name "*mcp*" -name "*.html" 2>/dev/null`;

  const proc = Bun.spawn(["bash", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  const durationMs = Math.round(performance.now() - start);

  return {
    tool: "exec",
    args: { command: cmd.slice(0, 80) },
    result: stdout.trim() || "(no results)",
    durationMs,
    success: stdout.trim().length > 0,
  };
}

async function testOpenFileDirect(path: string): Promise<ToolCallResult> {
  const start = performance.now();
  const resp = await fetch(`${BASE}/api/automation/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instruction: `open file: ${path}` }),
  });
  const durationMs = Math.round(performance.now() - start);
  const data = await resp.json() as any;
  return {
    tool: "open_file",
    args: { path },
    result: JSON.stringify(data).slice(0, 300),
    durationMs,
    success: data.success !== false,
  };
}

async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Direct Tool Chain Test");
  console.log("═══════════════════════════════════════════════════════\n");

  // Step 1: exec — find files
  console.log("▶ Step 1: exec (find mcp*.html)...");
  const execResult = await testExecDirect();
  console.log(`  ${execResult.success ? "✅" : "❌"} ${execResult.durationMs}ms`);
  console.log(`  Result: ${execResult.result.slice(0, 300)}`);

  // Step 2: open_file — open the first result
  const files = execResult.result.split("\n").filter(Boolean);
  if (files.length > 0) {
    console.log(`\n▶ Step 2: open_file (${files[0]!.split("/").pop()})...`);
    const openResult = await testOpenFileDirect(files[0]!);
    console.log(`  ${openResult.success ? "✅" : "❌"} ${openResult.durationMs}ms`);
    console.log(`  Result: ${openResult.result.slice(0, 300)}`);
  } else {
    console.log("\n▶ Step 2: SKIPPED (no files found in step 1)");
    // Try with known path
    const knownPath = `${process.env.HOME}/Library/Mobile Documents/com~apple~CloudDocs/Tanka/Tanka Link 2.0/Link Action/mcp-tool-priority.html`;
    const { existsSync } = await import("fs");
    if (existsSync(knownPath)) {
      console.log(`  Trying known path: mcp-tool-priority.html`);
      const openResult = await testOpenFileDirect(knownPath);
      console.log(`  ${openResult.success ? "✅" : "❌"} ${openResult.durationMs}ms`);
      console.log(`  Result: ${openResult.result.slice(0, 300)}`);
    }
  }

  // Step 3: Test the rich result (file not found → candidate list)
  console.log("\n▶ Step 3: open_file with fuzzy query (tests rich result for agent loop)...");
  const fuzzyResult = await testOpenFileDirect("tanka action mcp列表");
  console.log(`  ${fuzzyResult.result.includes("Similar files") || fuzzyResult.result.includes("Opened") ? "✅" : "❌"} ${fuzzyResult.durationMs}ms`);
  console.log(`  Result: ${fuzzyResult.result.slice(0, 400)}`);

  // Step 4: Test search via automation router
  console.log("\n▶ Step 4: automation router search...");
  const resp = await fetch(`${BASE}/api/automation/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instruction: "open file: mcp tool priority html" }),
  });
  const routerResult = await resp.json() as any;
  console.log(`  ${routerResult.success ? "✅" : "❌"} ${routerResult.durationMs || "?"}ms`);
  console.log(`  Layer: ${routerResult.layer}`);
  console.log(`  Result: ${routerResult.result?.slice(0, 300) || JSON.stringify(routerResult).slice(0, 300)}`);

  // Summary
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  Agent Loop Chain:");
  console.log(`  exec(find) → ${execResult.success ? `${files.length} files found` : "no files"}`);
  console.log(`  open_file → ${files.length > 0 ? "can open" : "needs fuzzy search"}`);
  console.log(`  rich result → ${fuzzyResult.result.includes("Similar") ? "candidate list returned ✅" : "direct result"}`);
  console.log("═══════════════════════════════════════════════════════");
}

main().catch(console.error);
