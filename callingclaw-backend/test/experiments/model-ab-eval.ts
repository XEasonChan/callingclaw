#!/usr/bin/env bun
/**
 * Model A/B Evaluation Runner — Sonnet vs Haiku (offline eval)
 *
 * Runs ALL test cases from eval-dataset.ts against two models via OpenRouter,
 * measures latency, scores responses, saves results to JSON, and prints a
 * human-readable comparison table.
 *
 * Usage:
 *   bun test/experiments/model-ab-eval.ts                        # full run (both models, all tests)
 *   bun test/experiments/model-ab-eval.ts --model-a only         # run model A (Haiku) only
 *   bun test/experiments/model-ab-eval.ts --model-b only         # run model B (Sonnet) only
 *   bun test/experiments/model-ab-eval.ts --category intent_classification  # filter by category
 *   bun test/experiments/model-ab-eval.ts --id IC-01,IC-02       # run specific test IDs
 *   bun test/experiments/model-ab-eval.ts --concurrency 5        # parallel requests (default 3)
 *   bun test/experiments/model-ab-eval.ts --dry-run              # show test plan without running
 *   bun test/experiments/model-ab-eval.ts --output results.json  # custom output file
 *
 * Requires: OPENROUTER_API_KEY in .env (project root or callingclaw-backend/)
 */

import {
  ALL_TESTS,
  getTestsByCategory,
  getDatasetStats,
  type TestCase,
  type TestCategory,
} from "./eval-dataset";

// ═══════════════════════════════════════════════════════════════════
//  Config & CLI Args
// ═══════════════════════════════════════════════════════════════════

const MODEL_A = "anthropic/claude-haiku-4-5";    // current production
const MODEL_B = "anthropic/claude-sonnet-4.6";   // candidate upgrade

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

// Load API key from env or .env file
function loadApiKey(): string {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const envPaths = [
      `${process.cwd()}/../../.env`,
      `${process.cwd()}/../.env`,
      `${process.cwd()}/.env`,
    ];
    for (const p of envPaths) {
      try {
        const content = require("fs").readFileSync(p, "utf-8");
        const match = content.match(/^OPENROUTER_API_KEY=(.+)$/m);
        if (match?.[1]) return match[1].trim();
      } catch { /* skip missing files */ }
    }
  } catch { /* ignore */ }
  return "";
}

const API_KEY = loadApiKey();

interface CLIArgs {
  modelAOnly: boolean;
  modelBOnly: boolean;
  category?: TestCategory;
  ids?: string[];
  concurrency: number;
  dryRun: boolean;
  outputFile: string;
  skipScreenshot: boolean;
}

function parseArgs(): CLIArgs {
  const args = process.argv.slice(2);
  const result: CLIArgs = {
    modelAOnly: false,
    modelBOnly: false,
    concurrency: 3,
    dryRun: false,
    outputFile: "",
    skipScreenshot: true,  // default: skip screenshot tests
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--model-a":
        if (args[i + 1] === "only") { result.modelAOnly = true; i++; }
        break;
      case "--model-b":
        if (args[i + 1] === "only") { result.modelBOnly = true; i++; }
        break;
      case "--category":
        result.category = args[++i] as TestCategory;
        break;
      case "--id":
        result.ids = args[++i].split(",").map((s) => s.trim());
        break;
      case "--concurrency":
        result.concurrency = parseInt(args[++i]) || 3;
        break;
      case "--dry-run":
        result.dryRun = true;
        break;
      case "--output":
        result.outputFile = args[++i];
        break;
      case "--include-screenshots":
        result.skipScreenshot = false;
        break;
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════
//  OpenRouter API Call
// ═══════════════════════════════════════════════════════════════════

interface ModelResponse {
  text: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
  error?: string;
}

async function callModel(
  model: string,
  systemPrompt: string,
  userMessage: string,
  maxTokens = 512,
): Promise<ModelResponse> {
  const startMs = Date.now();

  try {
    const resp = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
        "HTTP-Referer": "https://callingclaw.com",
        "X-Title": "CallingClaw Model A/B Eval",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0,  // deterministic for eval
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
      }),
    });

    const latencyMs = Date.now() - startMs;

    if (!resp.ok) {
      const errText = await resp.text();
      return {
        text: "",
        latencyMs,
        inputTokens: 0,
        outputTokens: 0,
        model,
        error: `HTTP ${resp.status}: ${errText.slice(0, 200)}`,
      };
    }

    const data = (await resp.json()) as any;
    const choice = data.choices?.[0];
    const usage = data.usage || {};

    return {
      text: choice?.message?.content || "",
      latencyMs,
      inputTokens: usage.prompt_tokens || 0,
      outputTokens: usage.completion_tokens || 0,
      model: data.model || model,
    };
  } catch (err: any) {
    return {
      text: "",
      latencyMs: Date.now() - startMs,
      inputTokens: 0,
      outputTokens: 0,
      model,
      error: err.message,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Scoring Engine
// ═══════════════════════════════════════════════════════════════════

interface TestScore {
  testId: string;
  category: TestCategory;
  model: string;
  response: ModelResponse;
  /** 0-100 composite score */
  score: number;
  /** Individual dimension scores */
  dimensions: {
    actionCorrect: boolean;
    confidenceCorrect: boolean;
    mustMentionHits: number;
    mustMentionTotal: number;
    mustNotMentionClean: boolean;
    languageCorrect: boolean;
  };
  /** Detailed scoring notes */
  notes: string[];
}

function scoreResponse(test: TestCase, response: ModelResponse): TestScore {
  const notes: string[] = [];
  const text = response.text.toLowerCase();
  const expected = test.expected;

  // ── Parse JSON for intent classification tests ──
  let parsedAction: string | null = null;
  let parsedConfidence = -1;

  if (test.category === "intent_classification") {
    try {
      // Extract JSON from response (may be wrapped in markdown code block)
      const jsonMatch = response.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        parsedAction = parsed.action || null;
        parsedConfidence = typeof parsed.confidence === "number" ? parsed.confidence : -1;
      }
    } catch {
      notes.push("Failed to parse JSON from response");
    }
  }

  // ── 1. Action correctness (30 pts) ──
  let actionCorrect = false;
  if (test.category === "intent_classification") {
    if (expected.action === null) {
      // Expect NO ACTION: action should be null and confidence should be 0 or near 0
      actionCorrect = parsedAction === null || parsedAction === "null" || parsedConfidence <= 0.1;
      if (!actionCorrect) notes.push(`Expected NO ACTION but got: ${parsedAction} (conf=${parsedConfidence})`);
    } else {
      // Expect a specific action
      // Accept similar action names (share_url and share_file both count for share_screen intent)
      const actionAliases: Record<string, string[]> = {
        share_url: ["share_url", "share_file", "share_screen", "open_url"],
        share_screen: ["share_screen", "share_url", "share_file"],
        click: ["click"],
        navigate: ["navigate", "share_url", "open_url"],
        research_task: ["research_task"],
        scroll: ["scroll"],
      };
      const acceptableActions = actionAliases[expected.action] || [expected.action];
      actionCorrect = parsedAction !== null && acceptableActions.includes(parsedAction);
      if (!actionCorrect) notes.push(`Expected action "${expected.action}" but got: "${parsedAction}"`);
    }
  } else {
    // For non-IC categories, action correctness is about whether it described vs acted
    if (expected.action === null) {
      // Should NOT suggest taking action — just describe/answer
      actionCorrect = !text.includes("i would click") || test.category === "computer_use";
      // For CU tests, action correctness is about choosing the right tool type
      if (test.category === "computer_use") {
        if (expected.action === null) {
          actionCorrect = !text.includes("click") || text.includes("don't click") || text.includes("do not click");
        }
      }
    } else {
      actionCorrect = text.includes(expected.action);
    }
  }
  const actionScore = actionCorrect ? 30 : 0;

  // ── 2. Confidence threshold (20 pts, IC only) ──
  let confidenceCorrect = true;
  let confidenceScore = 20;
  if (test.category === "intent_classification") {
    if (expected.confidence === 0) {
      confidenceCorrect = parsedConfidence <= 0.1;
      if (!confidenceCorrect) notes.push(`Expected confidence=0 but got ${parsedConfidence}`);
    } else {
      confidenceCorrect = parsedConfidence >= expected.confidence;
      if (!confidenceCorrect) notes.push(`Expected confidence>=${expected.confidence} but got ${parsedConfidence}`);
    }
    confidenceScore = confidenceCorrect ? 20 : 0;
  }

  // ── 3. Must-mention keywords (25 pts) ──
  const mustMention = expected.mustMention || [];
  const mustMentionHits = mustMention.filter((kw) => text.includes(kw.toLowerCase())).length;
  const mustMentionTotal = mustMention.length;
  const mentionScore = mustMentionTotal > 0
    ? Math.round((mustMentionHits / mustMentionTotal) * 25)
    : 25;
  if (mustMentionHits < mustMentionTotal) {
    const missed = mustMention.filter((kw) => !text.includes(kw.toLowerCase()));
    notes.push(`Missed keywords: ${missed.join(", ")}`);
  }

  // ── 4. Must-not-mention (15 pts) ──
  const mustNotMention = expected.mustNotMention || [];
  const mustNotMentionViolations = mustNotMention.filter((kw) => text.includes(kw.toLowerCase()));
  const mustNotMentionClean = mustNotMentionViolations.length === 0;
  const noMentionScore = mustNotMentionClean ? 15 : 0;
  if (!mustNotMentionClean) {
    notes.push(`Mentioned forbidden: ${mustNotMentionViolations.join(", ")}`);
  }

  // ── 5. Language correctness (10 pts) ──
  let languageCorrect = true;
  if (expected.language && expected.language !== "any") {
    if (expected.language === "zh") {
      // Check for Chinese characters
      const hasChinese = /[\u4e00-\u9fff]/.test(response.text);
      languageCorrect = hasChinese;
      if (!languageCorrect) notes.push("Expected Chinese response but got non-Chinese");
    } else if (expected.language === "en") {
      // Check that response is primarily English (few Chinese chars)
      const chineseRatio = (response.text.match(/[\u4e00-\u9fff]/g) || []).length / Math.max(response.text.length, 1);
      languageCorrect = chineseRatio < 0.1;
      if (!languageCorrect) notes.push(`Expected English but got ${Math.round(chineseRatio * 100)}% Chinese characters`);
    }
  }
  const languageScore = languageCorrect ? 10 : 0;

  const score = actionScore + confidenceScore + mentionScore + noMentionScore + languageScore;

  return {
    testId: test.id,
    category: test.category,
    model: response.model,
    response,
    score,
    dimensions: {
      actionCorrect,
      confidenceCorrect,
      mustMentionHits,
      mustMentionTotal,
      mustNotMentionClean,
      languageCorrect,
    },
    notes,
  };
}

// ═══════════════════════════════════════════════════════════════════
//  Parallel Runner with Concurrency Limit
// ═══════════════════════════════════════════════════════════════════

async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < tasks.length) {
      const idx = nextIdx++;
      results[idx] = await tasks[idx]();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ═══════════════════════════════════════════════════════════════════
//  Main Runner
// ═══════════════════════════════════════════════════════════════════

interface EvalRun {
  timestamp: string;
  modelA: string;
  modelB: string;
  testCount: number;
  results: TestScore[];
  summary: {
    modelA: ModelSummary;
    modelB: ModelSummary;
    winner: string;
    categoryBreakdown: CategoryBreakdown[];
  };
}

interface ModelSummary {
  model: string;
  avgScore: number;
  avgLatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  passCount: number;
  failCount: number;
  errorCount: number;
}

interface CategoryBreakdown {
  category: string;
  modelAAvg: number;
  modelBAvg: number;
  modelALatency: number;
  modelBLatency: number;
  winner: string;
}

function computeSummary(scores: TestScore[], model: string): ModelSummary {
  const modelScores = scores.filter((s) => s.model.includes(model.split("/")[1] || model));
  if (modelScores.length === 0) {
    return { model, avgScore: 0, avgLatencyMs: 0, totalInputTokens: 0, totalOutputTokens: 0, passCount: 0, failCount: 0, errorCount: 0 };
  }

  const validScores = modelScores.filter((s) => !s.response.error);
  const errors = modelScores.filter((s) => !!s.response.error);

  return {
    model,
    avgScore: validScores.length > 0 ? Math.round(validScores.reduce((a, s) => a + s.score, 0) / validScores.length) : 0,
    avgLatencyMs: validScores.length > 0 ? Math.round(validScores.reduce((a, s) => a + s.response.latencyMs, 0) / validScores.length) : 0,
    totalInputTokens: validScores.reduce((a, s) => a + s.response.inputTokens, 0),
    totalOutputTokens: validScores.reduce((a, s) => a + s.response.outputTokens, 0),
    passCount: validScores.filter((s) => s.score >= 70).length,
    failCount: validScores.filter((s) => s.score < 70).length,
    errorCount: errors.length,
  };
}

// ═══════════════════════════════════════════════════════════════════
//  Table Printer
// ═══════════════════════════════════════════════════════════════════

function printComparisonTable(run: EvalRun): void {
  const { summary } = run;
  const { modelA, modelB, categoryBreakdown } = summary;

  console.log("\n" + "=".repeat(80));
  console.log("  MODEL A/B EVALUATION RESULTS");
  console.log("=".repeat(80));

  // Overall summary
  console.log("\n--- Overall ---\n");
  console.log(
    `  ${"Metric".padEnd(25)} | ${modelA.model.padEnd(30)} | ${modelB.model.padEnd(30)}`
  );
  console.log("  " + "-".repeat(90));
  console.log(
    `  ${"Avg Score".padEnd(25)} | ${String(modelA.avgScore).padEnd(30)} | ${String(modelB.avgScore).padEnd(30)}`
  );
  console.log(
    `  ${"Avg Latency (ms)".padEnd(25)} | ${String(modelA.avgLatencyMs).padEnd(30)} | ${String(modelB.avgLatencyMs).padEnd(30)}`
  );
  console.log(
    `  ${"Pass (>=70)".padEnd(25)} | ${String(modelA.passCount).padEnd(30)} | ${String(modelB.passCount).padEnd(30)}`
  );
  console.log(
    `  ${"Fail (<70)".padEnd(25)} | ${String(modelA.failCount).padEnd(30)} | ${String(modelB.failCount).padEnd(30)}`
  );
  console.log(
    `  ${"Errors".padEnd(25)} | ${String(modelA.errorCount).padEnd(30)} | ${String(modelB.errorCount).padEnd(30)}`
  );
  console.log(
    `  ${"Input Tokens".padEnd(25)} | ${String(modelA.totalInputTokens).padEnd(30)} | ${String(modelB.totalInputTokens).padEnd(30)}`
  );
  console.log(
    `  ${"Output Tokens".padEnd(25)} | ${String(modelA.totalOutputTokens).padEnd(30)} | ${String(modelB.totalOutputTokens).padEnd(30)}`
  );
  console.log(
    `\n  WINNER: ${summary.winner}\n`
  );

  // Category breakdown
  console.log("--- By Category ---\n");
  console.log(
    `  ${"Category".padEnd(25)} | ${"A Score".padEnd(10)} | ${"B Score".padEnd(10)} | ${"A Lat".padEnd(10)} | ${"B Lat".padEnd(10)} | Winner`
  );
  console.log("  " + "-".repeat(85));
  for (const cat of categoryBreakdown) {
    const w = cat.winner === "tie" ? "TIE" : cat.winner === "A" ? "<<< A" : "B >>>";
    console.log(
      `  ${cat.category.padEnd(25)} | ${String(cat.modelAAvg).padEnd(10)} | ${String(cat.modelBAvg).padEnd(10)} | ${String(cat.modelALatency + "ms").padEnd(10)} | ${String(cat.modelBLatency + "ms").padEnd(10)} | ${w}`
    );
  }

  // Individual test results
  console.log("\n--- Individual Tests ---\n");
  console.log(
    `  ${"Test".padEnd(8)} | ${"Category".padEnd(24)} | ${"A".padEnd(6)} | ${"B".padEnd(6)} | ${"A ms".padEnd(8)} | ${"B ms".padEnd(8)} | Notes`
  );
  console.log("  " + "-".repeat(100));

  // Group results by test ID
  const byTestId = new Map<string, TestScore[]>();
  for (const s of run.results) {
    const arr = byTestId.get(s.testId) || [];
    arr.push(s);
    byTestId.set(s.testId, arr);
  }

  for (const [testId, scores] of byTestId) {
    const a = scores.find((s) => s.model.includes("haiku"));
    const b = scores.find((s) => !s.model.includes("haiku"));
    const cat = scores[0]?.category || "";
    const aScore = a ? String(a.score) : "N/A";
    const bScore = b ? String(b.score) : "N/A";
    const aLat = a ? String(a.response.latencyMs) : "N/A";
    const bLat = b ? String(b.response.latencyMs) : "N/A";
    const allNotes = [...(a?.notes || []), ...(b?.notes || [])].slice(0, 2).join("; ") || "OK";
    console.log(
      `  ${testId.padEnd(8)} | ${cat.padEnd(24)} | ${aScore.padEnd(6)} | ${bScore.padEnd(6)} | ${aLat.padEnd(8)} | ${bLat.padEnd(8)} | ${allNotes.slice(0, 40)}`
    );
  }

  console.log("\n" + "=".repeat(80));
}

// ═══════════════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════════════

async function main() {
  const args = parseArgs();

  if (!API_KEY) {
    console.error("OPENROUTER_API_KEY not found in environment or .env file.");
    console.error("Set it via: export OPENROUTER_API_KEY=sk-or-...");
    process.exit(1);
  }

  // ── Select tests ──
  let tests: TestCase[] = ALL_TESTS;

  if (args.category) {
    tests = getTestsByCategory(args.category);
    if (tests.length === 0) {
      console.error(`No tests found for category: ${args.category}`);
      process.exit(1);
    }
  }

  if (args.ids) {
    tests = tests.filter((t) => args.ids!.includes(t.id));
    if (tests.length === 0) {
      console.error(`No tests found for IDs: ${args.ids!.join(", ")}`);
      process.exit(1);
    }
  }

  // Skip screenshot tests if no screenshots available
  if (args.skipScreenshot) {
    const before = tests.length;
    tests = tests.filter((t) => !t.requiresScreenshot);
    const skipped = before - tests.length;
    if (skipped > 0) {
      console.log(`Skipping ${skipped} tests that require screenshots (use --include-screenshots to include)`);
    }
  }

  // ── Determine which models to run ──
  const models: string[] = [];
  if (!args.modelBOnly) models.push(MODEL_A);
  if (!args.modelAOnly) models.push(MODEL_B);

  // ── Dry run ──
  if (args.dryRun) {
    const stats = getDatasetStats();
    console.log("\n--- Dry Run: Test Plan ---\n");
    console.log(`Total tests: ${tests.length} (of ${stats.total} in dataset)`);
    console.log(`Models: ${models.join(" vs ")}`);
    console.log(`API calls: ${tests.length * models.length}`);
    console.log(`Concurrency: ${args.concurrency}`);
    console.log(`\nTests:`);
    for (const t of tests) {
      console.log(`  ${t.id.padEnd(8)} ${t.category.padEnd(24)} ${t.expected.action || "NO ACTION"}`);
    }
    console.log(`\nCategories:`);
    for (const c of stats.categories) {
      const inRun = tests.filter((t) => t.category === c.name).length;
      console.log(`  ${c.name.padEnd(24)} ${inRun}/${c.count}`);
    }
    return;
  }

  // ── Run eval ──
  console.log(`\nRunning ${tests.length} tests x ${models.length} models = ${tests.length * models.length} API calls`);
  console.log(`Models: ${models.join(" vs ")}`);
  console.log(`Concurrency: ${args.concurrency}\n`);

  const allScores: TestScore[] = [];
  let completed = 0;
  const total = tests.length * models.length;

  // Build tasks: [model, test] pairs
  const tasks: (() => Promise<TestScore>)[] = [];
  for (const model of models) {
    for (const test of tests) {
      tasks.push(async () => {
        const response = await callModel(
          model,
          test.systemPrompt,
          test.userMessage,
          test.category === "intent_classification" ? 256 : 512,
        );
        const score = scoreResponse(test, response);
        completed++;
        const pct = Math.round((completed / total) * 100);
        const emoji = score.score >= 70 ? "PASS" : score.response.error ? "ERR " : "FAIL";
        process.stdout.write(
          `\r  [${pct}%] ${emoji} ${test.id} (${model.split("/")[1]}) score=${score.score} latency=${response.latencyMs}ms`
        );
        // Pad with spaces to clear previous longer lines
        process.stdout.write("                    ");
        return score;
      });
    }
  }

  const results = await runWithConcurrency(tasks, args.concurrency);
  allScores.push(...results);
  console.log("\n");

  // ── Compute summary ──
  const modelASummary = computeSummary(allScores, MODEL_A);
  const modelBSummary = computeSummary(allScores, MODEL_B);

  // Category breakdown
  const categories = [...new Set(tests.map((t) => t.category))];
  const categoryBreakdown: CategoryBreakdown[] = categories.map((cat) => {
    const catScores = allScores.filter((s) => s.category === cat);
    const aScores = catScores.filter((s) => s.model.includes("haiku") && !s.response.error);
    const bScores = catScores.filter((s) => !s.model.includes("haiku") && !s.response.error);
    const aAvg = aScores.length > 0 ? Math.round(aScores.reduce((a, s) => a + s.score, 0) / aScores.length) : 0;
    const bAvg = bScores.length > 0 ? Math.round(bScores.reduce((a, s) => a + s.score, 0) / bScores.length) : 0;
    const aLat = aScores.length > 0 ? Math.round(aScores.reduce((a, s) => a + s.response.latencyMs, 0) / aScores.length) : 0;
    const bLat = bScores.length > 0 ? Math.round(bScores.reduce((a, s) => a + s.response.latencyMs, 0) / bScores.length) : 0;
    const winner = aAvg === bAvg ? "tie" : aAvg > bAvg ? "A" : "B";
    return { category: cat, modelAAvg: aAvg, modelBAvg: bAvg, modelALatency: aLat, modelBLatency: bLat, winner };
  });

  const winner =
    modelASummary.avgScore === modelBSummary.avgScore
      ? "TIE — prefer Haiku (faster, cheaper)"
      : modelASummary.avgScore > modelBSummary.avgScore
        ? `${MODEL_A} (Haiku) — by ${modelASummary.avgScore - modelBSummary.avgScore} pts`
        : `${MODEL_B} (Sonnet) — by ${modelBSummary.avgScore - modelASummary.avgScore} pts`;

  const evalRun: EvalRun = {
    timestamp: new Date().toISOString(),
    modelA: MODEL_A,
    modelB: MODEL_B,
    testCount: tests.length,
    results: allScores,
    summary: {
      modelA: modelASummary,
      modelB: modelBSummary,
      winner,
      categoryBreakdown,
    },
  };

  // ── Print table ──
  printComparisonTable(evalRun);

  // ── Save JSON ──
  const outputPath = args.outputFile ||
    `${__dirname}/results/model-ab-eval-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.json`;

  // Ensure results directory exists
  try {
    require("fs").mkdirSync(`${__dirname}/results`, { recursive: true });
  } catch { /* already exists */ }

  require("fs").writeFileSync(outputPath, JSON.stringify(evalRun, null, 2));
  console.log(`\nResults saved to: ${outputPath}`);

  // ── Cost estimate ──
  const totalInput = modelASummary.totalInputTokens + modelBSummary.totalInputTokens;
  const totalOutput = modelASummary.totalOutputTokens + modelBSummary.totalOutputTokens;
  // Haiku: $0.25/1M input, $1.25/1M output; Sonnet: $3/1M input, $15/1M output
  const haikuCost = (modelASummary.totalInputTokens * 0.25 + modelASummary.totalOutputTokens * 1.25) / 1_000_000;
  const sonnetCost = (modelBSummary.totalInputTokens * 3 + modelBSummary.totalOutputTokens * 15) / 1_000_000;
  console.log(`\nCost estimate: Haiku $${haikuCost.toFixed(4)} + Sonnet $${sonnetCost.toFixed(4)} = $${(haikuCost + sonnetCost).toFixed(4)}`);
  console.log(`Total tokens: ${totalInput} input + ${totalOutput} output = ${totalInput + totalOutput}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
