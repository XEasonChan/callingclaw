// CallingClaw Eval Framework — Suite Runner
// Executes eval suites, collects results, produces scored reports.

import type { EvalSuite, EvalResult, SuiteReport } from "./types";

/** Run a single eval suite and produce a report */
export async function runSuite<TInput, TExpected, TActual>(
  suite: EvalSuite<TInput, TExpected, TActual>,
  opts: { filter?: string[]; concurrency?: number } = {},
): Promise<SuiteReport> {
  const startedAt = new Date();
  const startMs = Date.now();

  // Filter cases by tags if specified
  let cases = suite.cases;
  if (opts.filter?.length) {
    cases = cases.filter((c) =>
      c.tags?.some((t) => opts.filter!.includes(t))
    );
  }

  // Run cases (sequential by default for deterministic output; concurrency for speed)
  const results: EvalResult<TInput, TExpected, TActual>[] = [];
  const concurrency = opts.concurrency || 1;

  if (concurrency <= 1) {
    for (const c of cases) {
      const result = await suite.run(c);
      results.push(result);
      printCaseResult(result);
    }
  } else {
    // Parallel execution in batches
    for (let i = 0; i < cases.length; i += concurrency) {
      const batch = cases.slice(i, i + concurrency);
      const batchResults = await Promise.all(batch.map((c) => suite.run(c)));
      for (const r of batchResults) {
        results.push(r);
        printCaseResult(r);
      }
    }
  }

  const durationMs = Date.now() - startMs;
  const passed = results.filter((r) => r.passed).length;
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);

  return {
    suite: suite.name,
    description: suite.description,
    totalCases: results.length,
    passed,
    failed: results.length - passed,
    score: results.length > 0 ? results.reduce((s, r) => s + r.score, 0) / results.length : 0,
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    totalCostUsd: results.reduce((s, r) => s + (r.costUsd || 0), 0),
    results,
    startedAt: startedAt.toISOString(),
    durationMs,
  };
}

/** Run multiple suites and print a combined summary */
export async function runAllSuites(
  suites: EvalSuite[],
  opts: { filter?: string[]; concurrency?: number } = {},
): Promise<SuiteReport[]> {
  const reports: SuiteReport[] = [];

  for (const suite of suites) {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`  ${suite.name}`);
    console.log(`  ${suite.description}`);
    console.log(`${"═".repeat(60)}\n`);
    const report = await runSuite(suite, opts);
    reports.push(report);
    printSuiteReport(report);
  }

  // Combined summary
  if (reports.length > 1) {
    console.log(`\n${"═".repeat(60)}`);
    console.log("  COMBINED SUMMARY");
    console.log(`${"═".repeat(60)}\n`);
    const total = reports.reduce((s, r) => s + r.totalCases, 0);
    const passed = reports.reduce((s, r) => s + r.passed, 0);
    const avgScore = reports.reduce((s, r) => s + r.score, 0) / reports.length;
    console.log(`  Suites:  ${reports.length}`);
    console.log(`  Cases:   ${passed}/${total} passed`);
    console.log(`  Score:   ${(avgScore * 100).toFixed(1)}%`);
    console.log(`  Cost:    $${reports.reduce((s, r) => s + r.totalCostUsd, 0).toFixed(4)}`);
    console.log();
  }

  return reports;
}

// ── Scoring Helpers ──

/** Score tool name match: 1.0 for exact match, 0.0 for mismatch */
export function scoreToolName(expected: string | null, actual: string | null): number {
  if (expected === null && actual === null) return 1.0;
  if (expected === null || actual === null) return 0.0;
  return expected === actual ? 1.0 : 0.0;
}

/** Score params match: fraction of expected keys that match */
export function scoreParams(
  expected: Record<string, any> | undefined,
  actual: Record<string, any>,
): number {
  if (!expected || Object.keys(expected).length === 0) return 1.0;
  const keys = Object.keys(expected);
  let matched = 0;
  for (const key of keys) {
    const exp = expected[key];
    const act = actual[key];
    if (typeof exp === "string" && typeof act === "string") {
      // Fuzzy string match: contains check (case-insensitive)
      if (act.toLowerCase().includes(exp.toLowerCase()) || exp.toLowerCase().includes(act.toLowerCase())) {
        matched++;
      }
    } else if (exp === act) {
      matched++;
    }
  }
  return matched / keys.length;
}

/**
 * Combined score for tool calling evaluation.
 * toolName match = 60% weight, params match = 40% weight.
 */
export function scoreToolCall(
  expected: { toolName: string | null; params?: Record<string, any> },
  actual: { toolName: string | null; params: Record<string, any> },
): { score: number; toolNameMatch: boolean; paramsScore: number } {
  const toolNameMatch = scoreToolName(expected.toolName, actual.toolName) === 1.0;
  const paramsScore = toolNameMatch ? scoreParams(expected.params, actual.params) : 0;
  const score = (toolNameMatch ? 0.6 : 0) + paramsScore * 0.4;
  return { score, toolNameMatch, paramsScore };
}

// ── Output Helpers ──

function printCaseResult(result: EvalResult) {
  const icon = result.passed ? "✓" : "✗";
  const scoreStr = `${(result.score * 100).toFixed(0)}%`;
  const latency = `${result.latencyMs}ms`;
  console.log(`  ${icon} [${scoreStr}] ${result.name} (${latency})${result.passed ? "" : ` — ${result.reason}`}`);
}

function printSuiteReport(report: SuiteReport) {
  const passRate = report.totalCases > 0 ? (report.passed / report.totalCases * 100).toFixed(1) : "0.0";
  console.log(`\n  ── Results ──`);
  console.log(`  Pass rate:   ${report.passed}/${report.totalCases} (${passRate}%)`);
  console.log(`  Avg score:   ${(report.score * 100).toFixed(1)}%`);
  console.log(`  Latency:     p50=${report.p50LatencyMs}ms  p95=${report.p95LatencyMs}ms`);
  console.log(`  Total cost:  $${report.totalCostUsd.toFixed(4)}`);
  console.log(`  Duration:    ${(report.durationMs / 1000).toFixed(1)}s`);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

// ── Report Export ──

/** Export report as JSON to eval/results/ */
export async function exportReport(report: SuiteReport): Promise<string> {
  const dir = new URL("./results", import.meta.url).pathname;
  try { await Bun.write(`${dir}/.gitkeep`, ""); } catch {}
  const filename = `${report.suite.replace(/\s+/g, "-").toLowerCase()}-${new Date().toISOString().slice(0, 19).replace(/:/g, "")}.json`;
  const path = `${dir}/${filename}`;
  await Bun.write(path, JSON.stringify(report, null, 2));
  console.log(`  Report saved: ${path}`);
  return path;
}
