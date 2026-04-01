#!/usr/bin/env bun
// CallingClaw — Gemini Live Eval Runner
//
// Spawns a worker subprocess per case to avoid WebSocket event loop issues.
// Worker uses ws package + proxy for Gemini Live BidiGenerateContent.
//
// Usage:
//   GEMINI_API_KEY=xxx bun eval/gemini-live-eval.ts
//   GEMINI_API_KEY=xxx bun eval/gemini-live-eval.ts --case 1.1

import { ALL_EVAL_CASES, CASES_BY_DIMENSION, type EvalCase, type Dimension } from "./eval-cases";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const MODEL = process.env.GEMINI_LIVE_MODEL || "models/gemini-3.1-flash-live-preview";

const SYS_BASE = `You are CallingClaw, a voice AI meeting assistant. Rules:
- Present data with EXACT numbers from context (never round/omit)
- Match user's language (Chinese→Chinese, English→English)
- No filler words. Lead with WHY and key decisions.
- When you don't have info, say so — never fabricate.`;

const SYS_PRESENTER = SYS_BASE + `\nPRESENTER mode: proactively present materials.`;
const SYS_REVIEWER = SYS_BASE + `\nREVIEWER mode: evaluate critically, ask sharp questions.`;

interface WorkerResult {
  transcript: string;
  textParts: string;
  toolCalls: string[];
  error: string | null;
}

async function runWorker(input: { systemInstruction: string; turns: { text: string }[]; tools?: boolean }): Promise<WorkerResult> {
  // Write input/output to temp files (Bun subprocess pipe can hang on large outputs)
  const tmpIn = `/tmp/gemini-eval-in-${Date.now()}.json`;
  const tmpOut = `/tmp/gemini-eval-out-${Date.now()}.json`;
  await Bun.write(tmpIn, JSON.stringify(input));

  const proc = Bun.spawn(["bun", "eval/gemini-ws-worker.ts", tmpIn, tmpOut], {
    stderr: "inherit", // Show worker debug output directly
    env: { ...process.env, GEMINI_API_KEY, GEMINI_LIVE_MODEL: MODEL, HTTPS_PROXY: process.env.HTTPS_PROXY || "", https_proxy: process.env.https_proxy || process.env.HTTPS_PROXY || "" },
    cwd: process.cwd(),
  });

  await proc.exited;

  try {
    const output = await Bun.file(tmpOut).text();
    try { require("fs").unlinkSync(tmpIn); } catch {}
    try { require("fs").unlinkSync(tmpOut); } catch {}
    return JSON.parse(output.trim().split("\n").pop()!);
  } catch {
    try { require("fs").unlinkSync(tmpIn); } catch {}
    return { transcript: "", textParts: "", toolCalls: [], error: "Worker produced no output file" };
  }
}

// ── Scoring ─────────────────────────────────────────────────────

function autoScore(text: string, toolCalls: string[], ec: EvalCase) {
  const low = text.toLowerCase();
  const s = ec.scoring;
  let score = 5;
  const reasons: string[] = [];

  const missed = s.must_contain.filter(kw => !low.includes(kw.toLowerCase()));
  if (s.must_contain.length > 0) {
    const rate = 1 - missed.length / s.must_contain.length;
    if (rate < 0.5) { score -= 3; reasons.push(`Missing: ${missed.join(",")}`); }
    else if (rate < 1) { score -= 1; reasons.push(`Missing: ${missed.join(",")}`); }
  }

  const forbidden = s.must_not_contain.filter(kw => low.includes(kw.toLowerCase()));
  if (forbidden.length) { score -= 2; reasons.push(`Forbidden: ${forbidden.join(",")}`); }

  const eHit = s.reference_entities.filter(e => low.includes(e.toLowerCase())).length;
  if (s.reference_entities.length > 0 && eHit / s.reference_entities.length < 0.5) { score -= 1; reasons.push("Low entity refs"); }

  const sents = text.split(/[。！？.!?]+/).filter(x => x.trim().length > 5);
  const gPat = [/通常来说/i, /一般来说/i, /听起来/i, /great question/i, /it depends/i];
  const gRatio = sents.length > 0 ? sents.filter(x => gPat.some(p => p.test(x))).length / sents.length : 0;
  if (gRatio > s.max_generic_ratio) { score -= 1; reasons.push(`Generic ${(gRatio * 100).toFixed(0)}%`); }

  return { score: Math.max(0, Math.min(5, score)), explanation: reasons.join("; ") || "All passed" };
}

// ── Run case ────────────────────────────────────────────────────

async function runCase(ec: EvalCase) {
  if (ec.skip_providers?.includes("gemini")) {
    return { id: ec.id, name: ec.name, dim: ec.dimension, score: -1, explanation: "N/A", tools: [] as string[], response: "SKIP", latency: 0 };
  }

  const sysInstr = ec.mode === "presenter" ? SYS_PRESENTER : ec.mode === "reviewer" ? SYS_REVIEWER : SYS_BASE;
  const useTools = ["tool_awareness", "agent_capabilities"].includes(ec.dimension);

  // Build turn texts (prepend context to first user turn, inject_before to respective turns)
  const turns: { text: string }[] = [];
  for (let i = 0; i < ec.turns.length; i++) {
    const turn = ec.turns[i];
    if (turn.role !== "user") continue;

    let text = "";
    if (i === 0 && ec.layer2) text += ec.layer2 + "\n\n";
    if (turn.inject_before) text += turn.inject_before + "\n\n";
    text += turn.text;
    turns.push({ text });
  }

  const start = Date.now();
  const result = await runWorker({ systemInstruction: sysInstr, turns, tools: useTools });
  const latency = Date.now() - start;

  if (result.error) {
    return { id: ec.id, name: ec.name, dim: ec.dimension, score: 0, explanation: result.error.slice(0, 100), tools: [] as string[], response: `ERROR: ${result.error}`, latency: 0 };
  }

  const responseText = result.transcript || result.textParts;
  const s = autoScore(responseText, result.toolCalls, ec);
  return { id: ec.id, name: ec.name, dim: ec.dimension, score: s.score, explanation: s.explanation, tools: result.toolCalls, response: responseText, latency };
}

// ── CLI + Main ──────────────────────────────────────────────────

function parseArgs(): EvalCase[] {
  const args = process.argv.slice(2);
  let cases = ALL_EVAL_CASES;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--case" && args[i + 1]) cases = ALL_EVAL_CASES.filter(c => c.id === args[++i]);
    else if (args[i] === "--dimension" && args[i + 1]) {
      const q = args[++i].toLowerCase();
      const dim = Object.keys(CASES_BY_DIMENSION).find(d => d.includes(q)) as Dimension | undefined;
      if (dim) cases = CASES_BY_DIMENSION[dim];
    }
  }
  return cases;
}

async function main() {
  if (!GEMINI_API_KEY) { console.error("GEMINI_API_KEY required"); process.exit(1); }
  const cases = parseArgs();
  console.log(`\nGemini Live Eval — ${MODEL}`);
  console.log(`Cases: ${cases.length}\n`);

  const results: any[] = [];
  for (const ec of cases) {
    process.stdout.write(`  [${ec.id}] ${ec.name}...`);
    const r = await runCase(ec);
    results.push(r);
    if (r.score === -1) console.log(` SKIP`);
    else { const e = r.score >= 4 ? "✓" : r.score >= 2 ? "~" : "✗"; console.log(` ${e} ${r.score}/5 (${r.latency}ms)`); }
  }

  // Summary
  console.log("\n" + "═".repeat(70));
  let lastDim = "";
  for (const r of results) {
    if (r.dim !== lastDim) { console.log(`\n  ${r.dim.toUpperCase()}`); lastDim = r.dim; }
    const icon = r.score === -1 ? "SKIP" : r.score >= 4 ? `● ${r.score}/5` : r.score >= 2 ? `◐ ${r.score}/5` : `○ ${r.score}/5`;
    console.log(`    [${r.id}] ${icon.padEnd(8)} ${r.name} (${r.latency}ms)${r.score >= 0 && r.score < 4 ? " — " + r.explanation : ""}`);
  }
  const scored = results.filter((r: any) => r.score >= 0);
  const avg = scored.reduce((s: number, r: any) => s + r.score, 0) / scored.length;
  const avgLat = scored.reduce((s: number, r: any) => s + r.latency, 0) / scored.length;
  console.log("\n  " + "─".repeat(60));
  console.log(`  AVG: ${avg.toFixed(1)}/5 | Latency: ${Math.round(avgLat)}ms | Cases: ${scored.length}`);

  for (const r of results.filter((r: any) => r.score >= 0 && r.score < 4)) {
    console.log(`\n  [${r.id}] ${r.name} — ${r.score}/5: ${r.explanation}`);
    console.log(`    ${r.response.replace(/\n/g, " ").slice(0, 300)}`);
  }

  await Bun.write(`eval/results-gemini-live-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(results, null, 2));
  console.log(`\nSaved to eval/results-gemini-live-*.json`);
}

main().catch(console.error);
