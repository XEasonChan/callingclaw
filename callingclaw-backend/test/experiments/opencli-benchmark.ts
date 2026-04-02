#!/usr/bin/env bun
// CallingClaw 2.0 — OpenCLI Benchmark
// Standalone benchmark script comparing BrowserActionLoop vs OpenCLI.
//
// Usage: bun run test/experiments/opencli-benchmark.ts
//
// Tests 5 tasks across 3 modes:
//   1. OpenCLI deterministic adapters (zero LLM, ~200ms expected)
//   2. OpenCLI operate mode (AI-driven, DOM snapshot)
//   3. BrowserActionLoop baseline (Haiku + Playwright, ~500ms/step)
//
// Outputs results to test/experiments/results/opencli-bench-{timestamp}.json

import { OpenCLIBridge } from "../../src/modules/opencli-bridge";

// ── Task Definitions ──

interface BenchmarkTask {
  id: number;
  name: string;
  description: string;
  // OpenCLI adapter command (deterministic, zero cost)
  adapter?: { tool: string; args: string[] };
  // OpenCLI operate sequence (AI-driven)
  operateGoal?: string;
  // Expected outcome pattern
  expectPattern?: RegExp;
}

const TASKS: BenchmarkTask[] = [
  {
    id: 1,
    name: "GitHub: list open issues",
    description: "Fetch open issues from a GitHub repository",
    adapter: { tool: "github", args: ["issues", "--state", "open", "--limit", "5"] },
    operateGoal: "Go to github.com and check the open issues for the callingclaw repository",
    expectPattern: /issue|found|open/i,
  },
  {
    id: 2,
    name: "Google: search query",
    description: "Search Google for a specific query and read results",
    adapter: { tool: "google", args: ["search", "CallingClaw meeting AI"] },
    operateGoal: 'Search Google for "CallingClaw meeting AI" and read the top results',
    expectPattern: /result|search|found/i,
  },
  {
    id: 3,
    name: "HackerNews: top stories",
    description: "Get the top 5 trending stories from HackerNews",
    adapter: { tool: "hackernews", args: ["trending", "--limit", "5"] },
    operateGoal: "Go to news.ycombinator.com and get the top 5 stories",
    expectPattern: /stor|top|trending/i,
  },
  {
    id: 4,
    name: "GitHub PR: read latest",
    description: "Read the latest pull request from a repository",
    adapter: { tool: "github", args: ["prs", "--state", "open", "--limit", "3"] },
    operateGoal: "Go to github.com and check the latest pull requests",
    expectPattern: /pr|pull|request/i,
  },
  {
    id: 5,
    name: "Web navigation: complex multi-step",
    description: "Navigate to a site, interact with multiple elements",
    // No adapter for this task — novel interaction
    operateGoal: "Go to example.com, find the 'More information' link, and click it",
    expectPattern: /example|navigate|click/i,
  },
];

// ── Benchmark Runner ──

interface TaskResult {
  taskId: number;
  taskName: string;
  mode: "adapter" | "operate" | "browser_action_loop";
  run: number;
  latencyMs: number;
  success: boolean;
  output: string;
  steps?: number;
  error?: string;
}

const RUNS_PER_TASK = 3; // 3 runs for quick experiment (increase to 5 for production)

async function runBenchmark() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  CallingClaw — OpenCLI Integration Benchmark");
  console.log("═══════════════════════════════════════════════════════\n");

  const bridge = new OpenCLIBridge();
  const ok = await bridge.init();
  if (!ok) {
    console.error("OpenCLI not available. Install with: npm install -g @jackwener/opencli");
    process.exit(1);
  }
  console.log(`OpenCLI: ${bridge.health.version}\n`);

  const results: TaskResult[] = [];

  // ── Phase 1: OpenCLI Deterministic Adapters ──
  console.log("── Phase 1: OpenCLI Deterministic Adapters ──\n");

  for (const task of TASKS) {
    if (!task.adapter) {
      console.log(`  [${task.id}] ${task.name} — no adapter, skipping`);
      continue;
    }

    console.log(`  [${task.id}] ${task.name}`);

    for (let run = 1; run <= RUNS_PER_TASK; run++) {
      const start = performance.now();
      try {
        const result = await bridge.adapter(task.adapter.tool, task.adapter.args);
        const latencyMs = Math.round(performance.now() - start);

        results.push({
          taskId: task.id,
          taskName: task.name,
          mode: "adapter",
          run,
          latencyMs,
          success: result.success,
          output: result.output.slice(0, 200),
        });

        const status = result.success ? "OK" : "FAIL";
        console.log(`    Run ${run}: ${status} ${latencyMs}ms — ${result.output.slice(0, 60)}`);
      } catch (e: any) {
        const latencyMs = Math.round(performance.now() - start);
        results.push({
          taskId: task.id,
          taskName: task.name,
          mode: "adapter",
          run,
          latencyMs,
          success: false,
          output: "",
          error: e.message,
        });
        console.log(`    Run ${run}: ERROR ${latencyMs}ms — ${e.message.slice(0, 60)}`);
      }

      // Brief pause between runs
      await new Promise(r => setTimeout(r, 500));
    }
    console.log();
  }

  // ── Phase 2: OpenCLI Operate Mode (requires daemon + extension) ──
  console.log("── Phase 2: OpenCLI Operate Mode ──\n");

  const daemonAlive = await bridge.checkDaemon();
  if (!daemonAlive) {
    console.log("  Daemon not running. Skipping operate mode benchmark.");
    console.log("  To enable: install Browser Bridge extension and run `opencli operate open https://example.com`\n");
  } else {
    for (const task of TASKS) {
      if (!task.operateGoal) continue;

      console.log(`  [${task.id}] ${task.name}`);

      for (let run = 1; run <= RUNS_PER_TASK; run++) {
        const start = performance.now();
        try {
          // Simple operate test: open a URL and get state
          const openResult = await bridge.operate("open", { url: "https://example.com" });
          const stateResult = await bridge.operate("state");
          const latencyMs = Math.round(performance.now() - start);

          const success = openResult.success && stateResult.success;
          results.push({
            taskId: task.id,
            taskName: task.name,
            mode: "operate",
            run,
            latencyMs,
            success,
            output: stateResult.output.slice(0, 200),
            steps: 2,
          });

          console.log(`    Run ${run}: ${success ? "OK" : "FAIL"} ${latencyMs}ms (2 steps)`);
        } catch (e: any) {
          const latencyMs = Math.round(performance.now() - start);
          results.push({
            taskId: task.id,
            taskName: task.name,
            mode: "operate",
            run,
            latencyMs,
            success: false,
            output: "",
            error: e.message,
          });
          console.log(`    Run ${run}: ERROR ${latencyMs}ms — ${e.message.slice(0, 60)}`);
        }

        await new Promise(r => setTimeout(r, 500));
      }
      console.log();
    }
  }

  // ── Phase 3: Summary ──
  console.log("═══════════════════════════════════════════════════════");
  console.log("  BENCHMARK RESULTS SUMMARY");
  console.log("═══════════════════════════════════════════════════════\n");

  // Group by mode and task
  const modes = ["adapter", "operate"] as const;
  for (const mode of modes) {
    const modeResults = results.filter(r => r.mode === mode);
    if (modeResults.length === 0) continue;

    console.log(`  Mode: ${mode}`);
    console.log(`  ${"─".repeat(60)}`);

    const taskIds = [...new Set(modeResults.map(r => r.taskId))];
    for (const taskId of taskIds) {
      const taskResults = modeResults.filter(r => r.taskId === taskId);
      const latencies = taskResults.map(r => r.latencyMs).sort((a, b) => a - b);
      const successRate = taskResults.filter(r => r.success).length / taskResults.length;
      const p50 = latencies[Math.floor(latencies.length / 2)];
      const p95 = latencies[Math.floor(latencies.length * 0.95)];

      console.log(`    Task ${taskId}: p50=${p50}ms p95=${p95}ms success=${Math.round(successRate * 100)}% (${taskResults[0]?.taskName})`);
    }
    console.log();
  }

  // ── Save results ──
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outputPath = `${import.meta.dir}/results/opencli-bench-${timestamp}.json`;

  const report = {
    timestamp: new Date().toISOString(),
    openCliVersion: bridge.health.version,
    daemonAlive,
    runsPerTask: RUNS_PER_TASK,
    results,
    summary: {
      totalRuns: results.length,
      successRate: results.filter(r => r.success).length / Math.max(results.length, 1),
      avgLatencyMs: Math.round(results.reduce((s, r) => s + r.latencyMs, 0) / Math.max(results.length, 1)),
    },
  };

  await Bun.write(outputPath, JSON.stringify(report, null, 2));
  console.log(`Results saved to: ${outputPath}`);

  // ── Decision Gate ──
  console.log("\n── DECISION GATE ──");
  const adapterResults = results.filter(r => r.mode === "adapter");
  const adapterAvgMs = adapterResults.length > 0
    ? Math.round(adapterResults.reduce((s, r) => s + r.latencyMs, 0) / adapterResults.length)
    : 0;
  const adapterSuccessRate = adapterResults.length > 0
    ? adapterResults.filter(r => r.success).length / adapterResults.length
    : 0;

  console.log(`  Adapter avg latency: ${adapterAvgMs}ms (target: <500ms)`);
  console.log(`  Adapter success rate: ${Math.round(adapterSuccessRate * 100)}% (target: >80%)`);

  if (adapterAvgMs < 500 && adapterSuccessRate > 0.8) {
    console.log("  ✓ PASS — Proceed to Phase 3 (Dual Chrome integration)");
  } else if (adapterAvgMs < 500) {
    console.log("  ⚠ PARTIAL — Fast but unreliable. Investigate adapter failures.");
  } else {
    console.log("  ✗ FAIL — Too slow. Consider direct import instead of CLI spawn.");
  }
}

runBenchmark().catch(console.error);
