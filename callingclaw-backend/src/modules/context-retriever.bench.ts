#!/usr/bin/env bun
// ContextRetriever Benchmark — Keyword vs Haiku 4.5 vs Gemini 3.1 Flash Lite
//
// All model calls go through OpenRouter for uniform comparison.
//
// Usage:
//   OPENROUTER_API_KEY=sk-or-xxx bun src/modules/context-retriever.bench.ts
//
// Measures: latency, hit rate, result quality (visual inspection)

const OPENCLAW_MEMORY_PATH = `${process.env.HOME}/.openclaw/workspace/MEMORY.md`;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

const MODELS = {
  haiku: "anthropic/claude-haiku-4-5",
  gemini: "google/gemini-3.1-flash-lite-preview",
};

// Test queries — deliberately tricky: cross-lingual, vague, semantic
const TEST_QUERIES = [
  "上次讨论的发布计划",                     // "release plan" — might be English in memory
  "CallingClaw audio architecture",        // exact match likely
  "那些blog效果怎么样",                     // "blog performance" — vague Chinese
  "meeting scheduler 的 cron 逻辑",        // mixed Chinese/English technical
  "之前和Jack讨论的结论",                    // person reference + "conclusions discussed"
  "Tanka Link Phase II testing progress",  // specific project/phase
  "voice AI 的成本优化方案",                 // conceptual — "cost optimization for voice AI"
];

async function loadMemory(): Promise<string> {
  try {
    return await Bun.file(OPENCLAW_MEMORY_PATH).text();
  } catch {
    console.log("⚠️  MEMORY.md not found, using sample data\n");
    return SAMPLE_MEMORY;
  }
}

// ── Backend 1: Keyword search (current implementation) ──
function keywordSearch(memory: string, query: string): string {
  const keywords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (keywords.length === 0) return "";

  const lines = memory.split("\n");
  const scored: Array<{ heading: string; content: string; score: number }> = [];
  let currentHeading = "";
  let currentLines: string[] = [];

  const flush = () => {
    if (currentLines.length === 0) return;
    const content = currentLines.join("\n");
    const lower = (currentHeading + " " + content).toLowerCase();
    let score = 0;
    for (const kw of keywords) score += lower.split(kw).length - 1;
    if (score > 0) scored.push({ heading: currentHeading, content, score });
  };

  for (const line of lines) {
    if (line.match(/^#{1,3}\s/)) { flush(); currentHeading = line; currentLines = []; }
    else currentLines.push(line);
  }
  flush();
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 3).map((s) => `${s.heading}\n${s.content.slice(0, 500)}`).join("\n\n");
}

// ── Backend 2/3: Model search via OpenRouter ──
async function modelSearch(memory: string, query: string, model: string): Promise<string> {
  if (!OPENROUTER_API_KEY) return "(no OPENROUTER_API_KEY)";

  const truncated = memory.length > 8000
    ? memory.slice(0, 8000) + "\n...(truncated)"
    : memory;

  const prompt = `You are a search engine over a personal knowledge base. Find relevant sections for the query.

## Rules
- Return ONLY content copied from the document, no commentary
- If nothing relevant, return "NO_MATCH"
- Keep result under 300 chars
- Match semantically across languages: "发布计划" = "release plan", "讨论的结论" = "decisions"

## Query
${query}

## Document
${truncated}`;

  const resp = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({ model, max_tokens: 300, messages: [{ role: "user", content: prompt }] }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`${resp.status}: ${errText.slice(0, 100)}`);
  }

  const data = (await resp.json()) as any;
  return data.choices?.[0]?.message?.content || "";
}

// ── Run benchmark ──
async function main() {
  if (!OPENROUTER_API_KEY) {
    console.error("❌ Set OPENROUTER_API_KEY to run model benchmarks");
    console.log("   Usage: OPENROUTER_API_KEY=sk-or-xxx bun src/modules/context-retriever.bench.ts\n");
    console.log("   Running keyword-only benchmark...\n");
  }

  const memory = await loadMemory();
  console.log(`📋 Memory: ${memory.length} chars`);
  console.log(`🔍 ${TEST_QUERIES.length} queries × 3 backends`);
  console.log(`📡 Models: Haiku=${MODELS.haiku}, Gemini=${MODELS.gemini}\n`);
  console.log("═".repeat(90));

  const stats = { keyword: { totalMs: 0, hits: 0 }, haiku: { totalMs: 0, hits: 0 }, gemini: { totalMs: 0, hits: 0 } };

  for (const query of TEST_QUERIES) {
    console.log(`\n🔎 "${query}"`);
    console.log("─".repeat(70));

    // Keyword
    const kwT = performance.now();
    const kwR = keywordSearch(memory, query);
    const kwMs = performance.now() - kwT;
    const kwHit = !!kwR;
    stats.keyword.totalMs += kwMs;
    if (kwHit) stats.keyword.hits++;

    // Haiku
    let hkR = "", hkMs = 0, hkHit = false;
    if (OPENROUTER_API_KEY) {
      try {
        const t = performance.now();
        hkR = await modelSearch(memory, query, MODELS.haiku);
        hkMs = performance.now() - t;
        hkHit = !!hkR && !hkR.includes("NO_MATCH") && hkR.length > 10;
        stats.haiku.totalMs += hkMs;
        if (hkHit) stats.haiku.hits++;
      } catch (e: any) { hkR = `ERR: ${e.message}`; hkMs = -1; }
    }

    // Gemini
    let gmR = "", gmMs = 0, gmHit = false;
    if (OPENROUTER_API_KEY) {
      try {
        const t = performance.now();
        gmR = await modelSearch(memory, query, MODELS.gemini);
        gmMs = performance.now() - t;
        gmHit = !!gmR && !gmR.includes("NO_MATCH") && gmR.length > 10;
        stats.gemini.totalMs += gmMs;
        if (gmHit) stats.gemini.hits++;
      } catch (e: any) { gmR = `ERR: ${e.message}`; gmMs = -1; }
    }

    const preview = (s: string) => s ? s.slice(0, 100).replace(/\n/g, " ") : "(no match)";
    console.log(`  ${kwHit ? "✅" : "❌"} Keyword  [${kwMs.toFixed(1).padStart(8)}ms] ${preview(kwR)}`);
    if (OPENROUTER_API_KEY) {
      console.log(`  ${hkHit ? "✅" : "❌"} Haiku    [${hkMs >= 0 ? (hkMs.toFixed(0) + "ms").padStart(8) : "   ERROR"}] ${preview(hkR)}`);
      console.log(`  ${gmHit ? "✅" : "❌"} Gemini   [${gmMs >= 0 ? (gmMs.toFixed(0) + "ms").padStart(8) : "   ERROR"}] ${preview(gmR)}`);
    }
  }

  // Summary
  const n = TEST_QUERIES.length;
  console.log("\n" + "═".repeat(90));
  console.log("\n📊 RESULTS\n");
  console.log("| Backend  | Avg Latency | Hit Rate | Est. Cost/query |");
  console.log("|----------|-------------|----------|-----------------|");
  console.log(`| Keyword  | ${(stats.keyword.totalMs / n).toFixed(1).padStart(8)}ms | ${stats.keyword.hits}/${n}      | $0.000          |`);
  if (OPENROUTER_API_KEY) {
    console.log(`| Haiku    | ${(stats.haiku.totalMs / n).toFixed(0).padStart(8)}ms | ${stats.haiku.hits}/${n}      | ~$0.0003        |`);
    console.log(`| Gemini   | ${(stats.gemini.totalMs / n).toFixed(0).padStart(8)}ms | ${stats.gemini.hits}/${n}      | ~$0.0001        |`);
  }
  console.log("");
}

const SAMPLE_MEMORY = `# About the User
Senior software engineer working on AI products. Based in Tokyo.
Speaks Chinese (primary), English, and Japanese.

## Current Work
Building CallingClaw 2.0 — an AI meeting assistant with voice, vision, and computer use.
Release plan: Phase I (voice + screen share) by end of March, Phase II (full automation) by May.

## Active Projects

### CallingClaw 2.0
AI meeting assistant. Uses OpenAI Realtime for voice, Claude for computer use, Gemini for vision.
Audio architecture: Python sidecar captures BlackHole virtual mic → PCM16 → OpenAI Realtime WebSocket.
Cost optimization: considering Gemini Live API as alternative to OpenAI Realtime ($0.02/min vs $0.18/min).

### Tanka Link 2.0
Multi-platform messaging bridge. Phase II testing: 53 pass / 29 fail / 13 skip.
Discussed with Jack on 2026-03-10: decided to prioritize iOS stability over Android features.

### Memdex Blog
Published 5 blog posts in February. Total views: 12,400. Top post: "AI Voice Agents in 2026" (3,200 views).
SEO strategy: targeting "AI meeting assistant" and "voice AI cost" keywords.

## Meeting Scheduler
Uses cron-based scheduling: checks Google Calendar every 5 minutes for upcoming meetings.
Auto-joins 2 minutes before start time. Cron logic in meeting-scheduler.ts.

## Infrastructure
- Dedicated Mac Mini for CallingClaw (always-on)
- OpenClaw runs on same machine (localhost:18789)
- Google OAuth for Calendar + Meet integration
`;

main().catch(console.error);
