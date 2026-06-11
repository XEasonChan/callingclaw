#!/usr/bin/env bun
// CallingClaw Eval — CLI Runner
// Runs all eval suites and produces scored reports.
//
// Usage:
//   bun eval/run.ts                    # Run all suites
//   bun eval/run.ts --suite tool       # Run only tool-calling suite
//   bun eval/run.ts --suite auditor    # Run only transcript-auditor suite
//   bun eval/run.ts --filter zh        # Run only Chinese-language cases
//   bun eval/run.ts --concurrency 3    # Run 3 cases in parallel
//   bun eval/run.ts --export           # Save JSON reports to eval/results/

import { runAllSuites, exportReport } from "./runner";
import type { EvalSuite } from "./types";

// ── Parse CLI args ──

const args = process.argv.slice(2);
const suiteName = getArg("--suite");
const filterTags = getArg("--filter")?.split(",") || [];
const concurrency = parseInt(getArg("--concurrency") || "1", 10);
const shouldExport = args.includes("--export");

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

// ── Load suites ──

const suites: EvalSuite[] = [];

if (!suiteName || suiteName === "tool" || suiteName === "tool-calling") {
  const { toolCallingSuite } = await import("./suites/tool-calling.eval");
  suites.push(toolCallingSuite);
}

if (!suiteName || suiteName === "auditor" || suiteName === "transcript-auditor") {
  const hasApiKey = !!process.env.OPENROUTER_API_KEY || !!process.env.ANTHROPIC_API_KEY;
  if (hasApiKey) {
    const { transcriptAuditorSuite } = await import("./suites/transcript-auditor.eval");
    suites.push(transcriptAuditorSuite);
  } else {
    console.log("\n  ⚠ Skipping TranscriptAuditor suite (no API key)\n");
  }
}

if (suites.length === 0) {
  console.error("No suites to run. Check --suite flag.");
  process.exit(1);
}

// ── Run ──

console.log("\n  CallingClaw Eval Framework");
console.log(`  Suites: ${suites.map((s) => s.name).join(", ")}`);
console.log(`  Filter: ${filterTags.length ? filterTags.join(", ") : "all"}`);
console.log(`  Concurrency: ${concurrency}`);

const reports = await runAllSuites(suites, {
  filter: filterTags.length ? filterTags : undefined,
  concurrency,
});

// ── Export ──

if (shouldExport) {
  console.log("\n  Exporting reports...");
  for (const report of reports) {
    await exportReport(report);
  }
}

// ── Exit code ──

const allPassed = reports.every((r) => r.failed === 0);
process.exit(allPassed ? 0 : 1);
