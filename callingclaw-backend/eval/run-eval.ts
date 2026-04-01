#!/usr/bin/env bun
// CallingClaw — Voice Model Eval Runner
//
// Runs eval cases against multiple providers using text-mode simulation.
// Text mode tests context following, role fidelity, and informativeness
// without needing the full audio/WebSocket pipeline.
//
// Usage:
//   bun run eval/run-eval.ts                           # all cases, all providers
//   bun run eval/run-eval.ts --provider gemini          # single provider
//   bun run eval/run-eval.ts --case 1.1                 # single case
//   bun run eval/run-eval.ts --dimension context        # match dimension name
//   bun run eval/run-eval.ts --provider grok --case 1.1 # specific combo

import { ALL_EVAL_CASES, CASES_BY_DIMENSION, type EvalCase, type Dimension } from "./eval-cases";
import { CORE_IDENTITY } from "../src/prompt-constants";

// ── Provider Configs (text-mode API endpoints) ──────────────────

interface TextProvider {
  name: string;
  /** Chat completions endpoint */
  endpoint: string;
  /** Model identifier */
  model: string;
  /** Auth header builder */
  headers: () => Record<string, string>;
  /** Whether this provider supports tool_call in responses */
  supportsTools: boolean;
}

const PROVIDERS: Record<string, TextProvider> = {
  grok: {
    name: "Grok",
    endpoint: "https://api.x.ai/v1/chat/completions",
    model: process.env.GROK_EVAL_MODEL || "grok-3-mini",
    headers: () => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROK_API_KEY || process.env.XAI_API_KEY || ""}`,
    }),
    supportsTools: true,
  },
  openai: {
    name: "OpenAI",
    endpoint: "https://api.openai.com/v1/chat/completions",
    model: process.env.OPENAI_EVAL_MODEL || "gpt-4o",
    headers: () => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY || ""}`,
    }),
    supportsTools: true,
  },
  gemini: {
    name: "Gemini-2.5",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: process.env.GEMINI_EVAL_MODEL || "google/gemini-2.5-flash",
    headers: () => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY || ""}`,
    }),
    supportsTools: true,
  },
  "gemini-3": {
    name: "Gemini-3",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    model: "gemini-3-flash-preview",
    headers: () => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GEMINI_API_KEY || ""}`,
    }),
    supportsTools: true,
  },
};

// ── Tool definitions for eval (simplified) ──────────────────────

const EVAL_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "recall_context",
      description: "Silently fetch specific facts from memory. Use when you need information not in the current conversation or meeting brief.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What context you need" },
          urgency: { type: "string", enum: ["quick", "thorough"] },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "open_file",
      description: "Open a file or document for discussion.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to open" },
        },
        required: ["path"],
      },
    },
  },
];

// ── Build conversation messages from eval case ──────────────────

function buildMessages(evalCase: EvalCase): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];

  // Layer 0: System prompt
  const modeInstruction = evalCase.mode === "presenter"
    ? "\n\nYou are in PRESENTER mode. Proactively present materials without waiting for questions."
    : evalCase.mode === "reviewer"
      ? "\n\nYou are in REVIEWER mode. Evaluate materials critically. Ask sharp questions. Push back on vague proposals."
      : "";

  const systemPrompt = (evalCase.layer0 || CORE_IDENTITY) + modeInstruction;
  messages.push({ role: "system", content: systemPrompt });

  // Layer 2: Meeting brief (injected as system message)
  if (evalCase.layer2) {
    messages.push({ role: "system", content: evalCase.layer2 });
  }

  // Conversation turns with Layer 3 injections
  for (const turn of evalCase.turns) {
    // Inject Layer 3 content before this turn if specified
    if (turn.inject_before) {
      messages.push({ role: "system", content: turn.inject_before });
    }

    messages.push({ role: turn.role, content: turn.text });
  }

  return messages;
}

// ── Call provider API ───────────────────────────────────────────

interface EvalResponse {
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: string } }>;
  latency_ms: number;
  input_tokens?: number;
  output_tokens?: number;
}

async function callProvider(provider: TextProvider, messages: any[], includeTools: boolean): Promise<EvalResponse> {
  const start = Date.now();

  const body: any = {
    model: provider.model,
    messages,
    max_tokens: 1000,
    temperature: 0.3,
  };

  if (includeTools && provider.supportsTools) {
    body.tools = EVAL_TOOLS;
    body.tool_choice = "auto";
  }

  const resp = await fetch(provider.endpoint, {
    method: "POST",
    headers: provider.headers(),
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`${provider.name} API error ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json() as any;
  const choice = data.choices?.[0];
  const latency_ms = Date.now() - start;

  return {
    content: choice?.message?.content || "",
    tool_calls: choice?.message?.tool_calls,
    latency_ms,
    input_tokens: data.usage?.prompt_tokens,
    output_tokens: data.usage?.completion_tokens,
  };
}

// ── Auto-Scoring ────────────────────────────────────────────────

interface AutoScore {
  /** 0-5 automated score */
  score: number;
  /** Individual check results */
  checks: {
    must_contain: { passed: string[]; failed: string[] };
    must_not_contain: { passed: string[]; failed: string[] };
    reference_entities: { found: string[]; missing: string[] };
    tool_calls: string[];
    generic_ratio: number;
  };
  /** Score breakdown explanation */
  explanation: string;
}

function autoScore(response: EvalResponse, evalCase: EvalCase): AutoScore {
  const text = response.content.toLowerCase();
  const scoring = evalCase.scoring;

  // 1. must_contain checks
  const containPassed: string[] = [];
  const containFailed: string[] = [];
  for (const kw of scoring.must_contain) {
    if (text.includes(kw.toLowerCase())) {
      containPassed.push(kw);
    } else {
      containFailed.push(kw);
    }
  }

  // 2. must_not_contain checks
  const notContainPassed: string[] = [];
  const notContainFailed: string[] = [];
  for (const kw of scoring.must_not_contain) {
    if (text.includes(kw.toLowerCase())) {
      notContainFailed.push(kw);
    } else {
      notContainPassed.push(kw);
    }
  }

  // 3. reference_entities
  const entityFound: string[] = [];
  const entityMissing: string[] = [];
  for (const entity of scoring.reference_entities) {
    if (text.includes(entity.toLowerCase())) {
      entityFound.push(entity);
    } else {
      entityMissing.push(entity);
    }
  }

  // 4. tool_calls
  const toolCalls = (response.tool_calls || []).map(t => t.function.name);

  // 5. generic_ratio (heuristic: count filler/generic sentences)
  const sentences = response.content.split(/[。！？.!?]+/).filter(s => s.trim().length > 5);
  const genericPatterns = [
    /听起来/i, /确实/i, /不错/i, /很好/i, /通常来说/i, /一般来说/i,
    /great question/i, /good point/i, /that's a good/i, /generally speaking/i,
    /it depends/i, /让我.*看看/i, /我来.*帮你/i,
  ];
  const genericCount = sentences.filter(s => genericPatterns.some(p => p.test(s))).length;
  const genericRatio = sentences.length > 0 ? genericCount / sentences.length : 0;

  // ── Compute score ──
  let score = 5;
  const reasons: string[] = [];

  // Deduct for missing must_contain
  if (scoring.must_contain.length > 0) {
    const hitRate = containPassed.length / scoring.must_contain.length;
    if (hitRate < 0.5) {
      score -= 3;
      reasons.push(`Only ${containPassed.length}/${scoring.must_contain.length} required keywords found`);
    } else if (hitRate < 1) {
      score -= 1;
      reasons.push(`Missing: ${containFailed.join(", ")}`);
    }
  }

  // Deduct for must_not_contain violations
  if (notContainFailed.length > 0) {
    score -= 2;
    reasons.push(`Contains forbidden: ${notContainFailed.join(", ")}`);
  }

  // Deduct for missing entities
  if (scoring.reference_entities.length > 0) {
    const entityRate = entityFound.length / scoring.reference_entities.length;
    if (entityRate < 0.5) {
      score -= 1;
      reasons.push(`Only ${entityFound.length}/${scoring.reference_entities.length} entities referenced`);
    }
  }

  // Deduct for high generic ratio
  if (genericRatio > scoring.max_generic_ratio) {
    score -= 1;
    reasons.push(`Generic ratio ${(genericRatio * 100).toFixed(0)}% > ${(scoring.max_generic_ratio * 100).toFixed(0)}% max`);
  }

  score = Math.max(0, Math.min(5, score));

  return {
    score,
    checks: {
      must_contain: { passed: containPassed, failed: containFailed },
      must_not_contain: { passed: notContainPassed, failed: notContainFailed },
      reference_entities: { found: entityFound, missing: entityMissing },
      tool_calls: toolCalls,
      generic_ratio: genericRatio,
    },
    explanation: reasons.length > 0 ? reasons.join("; ") : "All checks passed",
  };
}

// ── Run single case ─────────────────────────────────────────────

interface CaseResult {
  case_id: string;
  case_name: string;
  dimension: Dimension;
  provider: string;
  response: string;
  tool_calls: string[];
  auto_score: AutoScore;
  latency_ms: number;
  tokens: { input: number; output: number };
}

async function runCase(evalCase: EvalCase, provider: TextProvider): Promise<CaseResult> {
  // Check if case should be skipped for this provider
  if (evalCase.skip_providers?.includes(provider.name.toLowerCase())) {
    return {
      case_id: evalCase.id,
      case_name: evalCase.name,
      dimension: evalCase.dimension,
      provider: provider.name,
      response: "[SKIPPED — N/A for this provider]",
      tool_calls: [],
      auto_score: { score: -1, checks: { must_contain: { passed: [], failed: [] }, must_not_contain: { passed: [], failed: [] }, reference_entities: { found: [], missing: [] }, tool_calls: [], generic_ratio: 0 }, explanation: "N/A" },
      latency_ms: 0,
      tokens: { input: 0, output: 0 },
    };
  }

  const messages = buildMessages(evalCase);
  const includeTools = ["tool_awareness", "agent_capabilities"].includes(evalCase.dimension);

  const response = await callProvider(provider, messages, includeTools);
  const score = autoScore(response, evalCase);

  return {
    case_id: evalCase.id,
    case_name: evalCase.name,
    dimension: evalCase.dimension,
    provider: provider.name,
    response: response.content,
    tool_calls: (response.tool_calls || []).map(t => t.function.name),
    auto_score: score,
    latency_ms: response.latency_ms,
    tokens: {
      input: response.input_tokens || 0,
      output: response.output_tokens || 0,
    },
  };
}

// ── CLI & Main ──────────────────────────────────────────────────

function parseArgs(): { providers: string[]; cases: EvalCase[] } {
  const args = process.argv.slice(2);
  let providers = Object.keys(PROVIDERS);
  let cases = ALL_EVAL_CASES;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--provider" && args[i + 1]) {
      providers = [args[++i]];
    } else if (args[i] === "--case" && args[i + 1]) {
      const caseId = args[++i];
      cases = ALL_EVAL_CASES.filter(c => c.id === caseId);
    } else if (args[i] === "--dimension" && args[i + 1]) {
      const dimQuery = args[++i].toLowerCase();
      const matchedDim = Object.keys(CASES_BY_DIMENSION).find(d => d.includes(dimQuery)) as Dimension | undefined;
      if (matchedDim) {
        cases = CASES_BY_DIMENSION[matchedDim];
      }
    }
  }

  return { providers, cases };
}

function printComparisonTable(results: CaseResult[]) {
  // Group by case
  const byCaseId = new Map<string, CaseResult[]>();
  for (const r of results) {
    const list = byCaseId.get(r.case_id) || [];
    list.push(r);
    byCaseId.set(r.case_id, list);
  }

  // Get unique providers
  const providerNames = [...new Set(results.map(r => r.provider))];

  // Header
  console.log("\n" + "═".repeat(80));
  console.log("COMPARISON MATRIX");
  console.log("═".repeat(80));

  const header = `| Case | Name | ${providerNames.map(p => p.padEnd(12)).join(" | ")} |`;
  const separator = `|------|------|${providerNames.map(() => "-".repeat(14)).join("|")}|`;
  console.log(header);
  console.log(separator);

  let lastDimension = "";
  for (const [caseId, caseResults] of byCaseId) {
    const first = caseResults[0];
    if (first.dimension !== lastDimension) {
      console.log(`| **${first.dimension}** | | ${providerNames.map(() => "").join(" | ")} |`);
      lastDimension = first.dimension;
    }

    const scores = providerNames.map(p => {
      const r = caseResults.find(cr => cr.provider === p);
      if (!r) return "  -  ".padEnd(12);
      if (r.auto_score.score === -1) return "  N/A".padEnd(12);
      const emoji = r.auto_score.score >= 4 ? "●" : r.auto_score.score >= 2 ? "◐" : "○";
      return `${emoji} ${r.auto_score.score}/5`.padEnd(12);
    });

    console.log(`| ${caseId.padEnd(4)} | ${first.case_name.slice(0, 20).padEnd(20)} | ${scores.join(" | ")} |`);
  }

  // Summary row
  console.log(separator);
  const avgScores = providerNames.map(p => {
    const providerResults = results.filter(r => r.provider === p && r.auto_score.score >= 0);
    if (providerResults.length === 0) return "  -  ".padEnd(12);
    const avg = providerResults.reduce((s, r) => s + r.auto_score.score, 0) / providerResults.length;
    return `AVG ${avg.toFixed(1)}`.padEnd(12);
  });
  console.log(`| | **AVERAGE** | ${avgScores.join(" | ")} |`);

  // Latency summary
  const avgLatency = providerNames.map(p => {
    const providerResults = results.filter(r => r.provider === p && r.latency_ms > 0);
    if (providerResults.length === 0) return "  -  ".padEnd(12);
    const avg = providerResults.reduce((s, r) => s + r.latency_ms, 0) / providerResults.length;
    return `${Math.round(avg)}ms`.padEnd(12);
  });
  console.log(`| | **Latency** | ${avgLatency.join(" | ")} |`);
  console.log("═".repeat(80));
}

function printDetailedResults(results: CaseResult[]) {
  console.log("\n" + "─".repeat(80));
  console.log("DETAILED RESULTS");
  console.log("─".repeat(80));

  for (const r of results) {
    if (r.auto_score.score === -1) continue;

    console.log(`\n[${r.case_id}] ${r.case_name} — ${r.provider} — Score: ${r.auto_score.score}/5`);
    console.log(`  Latency: ${r.latency_ms}ms | Tokens: ${r.tokens.input}in/${r.tokens.output}out`);
    console.log(`  Scoring: ${r.auto_score.explanation}`);

    if (r.tool_calls.length > 0) {
      console.log(`  Tools called: ${r.tool_calls.join(", ")}`);
    }

    // Truncated response
    const responsePreview = r.response.replace(/\n/g, " ").slice(0, 200);
    console.log(`  Response: ${responsePreview}...`);
  }
}

async function main() {
  const { providers, cases } = parseArgs();

  console.log(`\nCallingClaw Voice Model Eval`);
  console.log(`Cases: ${cases.length} | Providers: ${providers.join(", ")}`);
  console.log(`Total runs: ${cases.length * providers.length}\n`);

  const allResults: CaseResult[] = [];

  for (const providerName of providers) {
    const provider = PROVIDERS[providerName];
    if (!provider) {
      console.error(`Unknown provider: ${providerName}`);
      continue;
    }

    // Check API key
    const testHeaders = provider.headers();
    if (!testHeaders.Authorization || testHeaders.Authorization === "Bearer ") {
      console.warn(`⚠ ${provider.name}: No API key found, skipping`);
      continue;
    }

    console.log(`\n── ${provider.name} (${provider.model}) ──`);

    for (const evalCase of cases) {
      process.stdout.write(`  [${evalCase.id}] ${evalCase.name}...`);

      try {
        const result = await runCase(evalCase, provider);
        allResults.push(result);

        if (result.auto_score.score === -1) {
          console.log(` SKIP`);
        } else {
          const emoji = result.auto_score.score >= 4 ? "✓" : result.auto_score.score >= 2 ? "~" : "✗";
          console.log(` ${emoji} ${result.auto_score.score}/5 (${result.latency_ms}ms)`);
        }
      } catch (e: any) {
        console.log(` ERROR: ${e.message.slice(0, 80)}`);
        allResults.push({
          case_id: evalCase.id,
          case_name: evalCase.name,
          dimension: evalCase.dimension,
          provider: provider.name,
          response: `ERROR: ${e.message}`,
          tool_calls: [],
          auto_score: { score: 0, checks: { must_contain: { passed: [], failed: [] }, must_not_contain: { passed: [], failed: [] }, reference_entities: { found: [], missing: [] }, tool_calls: [], generic_ratio: 0 }, explanation: `Error: ${e.message.slice(0, 100)}` },
          latency_ms: 0,
          tokens: { input: 0, output: 0 },
        });
      }
    }
  }

  // Print results
  if (providers.length > 1) {
    printComparisonTable(allResults);
  }
  printDetailedResults(allResults);

  // Save results to JSON
  const outPath = `eval/results-${new Date().toISOString().slice(0, 10)}.json`;
  await Bun.write(outPath, JSON.stringify(allResults, null, 2));
  console.log(`\nResults saved to ${outPath}`);
}

main().catch(console.error);
