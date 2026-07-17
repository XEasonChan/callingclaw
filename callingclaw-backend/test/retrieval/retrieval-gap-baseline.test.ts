// ══════════════════════════════════════════════════════════════════════════
// Retrieval-gap BASELINE eval — measures, deterministically and with NO live
// LLM calls, how much local knowledge the in-meeting retriever can actually
// reach today.
//
// WHY THIS EXISTS
// ---------------
// A known gap was reported: "in-meeting retrieval only sees FLAT directories —
// non-recursive globs, knowledgeDir defaults to empty". Grounding against
// origin/main showed the *recursion* half of that gap is ALREADY FIXED:
// ContextRetriever.walkFiles() is a bounded recursive walk (see
// test/modules/context-retriever-search.test.ts). What REMAINS, and what this
// harness quantifies, is:
//
//   1. BOUNDS  — walkFiles caps at MAX_FILES_PER_ROOT (200) files per root and
//      MAX_WALK_DEPTH (3). Files are visited in alphabetical order. In a
//      realistic ~/.callingclaw/shared (hundreds of meetings/<id>/ dirs), the
//      `meetings/` subtree exhausts the 200-file budget of the `shared` root
//      before the walk ever reaches sibling subdirs that sort after it
//      (notes/, presentations/) or the flat files that sort after "m"
//      (onboarding-context.md, sessions.json). Most meeting timelines are
//      themselves unreachable past the cap.
//
//   2. knowledgeDir DEFAULT — SEARCH_PATHS.knowledgeDir defaults to "" in
//      src/config.ts, so a user's own project/knowledge docs are NOT a search
//      root and are 0% reachable until explicitly configured.
//
// The fixture below mirrors the real tree's SHAPE (flat prep/summary files in
// shared/, a nested notes/ subdir, a large meetings/<id>/ subtree, a separate
// knowledge/ dir). Each fact-bearing file carries a UNIQUE token so hit/miss
// is unambiguous.
//
// TEST HYGIENE
// ------------
// Default `bun test` stays GREEN: the assertions here are a snapshot of
// TODAY's (gap-present) behavior. The desired-but-currently-failing state
// (everything reachable) is asserted only when RETRIEVAL_GAP_STRICT=1.
//
// Repro:  cd callingclaw-backend && bun test test/retrieval/retrieval-gap-baseline.test.ts
// Strict: RETRIEVAL_GAP_STRICT=1 bun test test/retrieval/retrieval-gap-baseline.test.ts   (expected to FAIL until fixed)
//
// The run also (re)writes test/retrieval/GAP-BASELINE.md with the exact numbers.
// Output is deterministic (no timestamps, no absolute temp paths) → re-running
// produces an identical file.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { ContextRetriever } from "../../src/modules/context-retriever";
import { aiTools } from "../../src/tool-definitions/ai-tools";

const STRICT = process.env.RETRIEVAL_GAP_STRICT === "1";

// ── Fixture scale ──
// 130 meetings × 2 searchable files (timeline.md + transcript.jsonl) = 260
// searchable files in the meetings/ subtree alone — comfortably past the
// 200-file-per-root cap so the flood effect is decisive and stable.
const N_MEETINGS = 130;

// ── Temp layout ──
let root: string;
let wsDir: string;      // fake ~/.openclaw/workspace  (WORKSPACE_DIR root)
let sharedDir: string;  // fake ~/.callingclaw/shared   (SHARED_DIR root)
let prepDir: string;    // sharedDir/prep               (PREP_DIR root — separate)
let knowDir: string;    // fake configured knowledgeDir (outside shared)

// searchable fixture corpus (all .md/.txt/.json/.jsonl we place, in-scope:
// depth ≤ 3, no dot-dirs) — the denominator for "corpus reachable %".
const corpus: string[] = []; // absolute paths

// Saved originals for restore
let savedWorkspaceDir: string;
const savedDescriptors: Record<string, PropertyDescriptor> = {};
let knowledgeDirValue = ""; // what the patched KNOWLEDGE_DIR getter returns

const SEARCH_EXTS = new Set([".md", ".txt", ".json", ".jsonl"]);
function isSearchable(p: string): boolean {
  const dot = p.lastIndexOf(".");
  return dot >= 0 && SEARCH_EXTS.has(p.slice(dot).toLowerCase());
}
function put(absPath: string, content: string) {
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content);
  if (isSearchable(absPath)) corpus.push(absPath);
}

// ── Query battery: token → expected source file → category ──
interface Query {
  id: string;
  token: string;       // unique needle
  expectRel: string;   // relative-ish path fragment the tool output should contain
  category: string;
}
const QUERIES: Query[] = [
  // Controls — separate roots / flat files that sort BEFORE "meetings"
  { id: "Q01", token: "FACT_MEMORY_WORKSPACE", expectRel: "MEMORY.md", category: "workspace-root (control)" },
  { id: "Q02", token: "FACT_PREP_ROOT_CTL", expectRel: "prep/prep_control.md", category: "prep-root (control)" },
  { id: "Q03", token: "FACT_PREP_BUDGET", expectRel: "shared/cc_a1_prep.md", category: "shared flat, pre-'m'" },
  { id: "Q04", token: "FACT_SUMMARY_OWNER", expectRel: "shared/cc_a1_summary.md", category: "shared flat, pre-'m'" },
  // meetings/ subtree — early reachable, late lost past the 200-file cap
  { id: "Q05", token: "FACT_MTG_EARLY_0001", expectRel: "meetings/mtg_0001/timeline.md", category: "meeting timeline (early)" },
  { id: "Q06", token: "FACT_MTG_MID_0050", expectRel: "meetings/mtg_0050/timeline.md", category: "meeting timeline (mid)" },
  { id: "Q07", token: "FACT_MTG_LATE_0100", expectRel: "meetings/mtg_0100/timeline.md", category: "meeting timeline (late)" },
  { id: "Q08", token: "FACT_MTG_LATE_0130", expectRel: "meetings/mtg_0130/timeline.md", category: "meeting timeline (latest)" },
  // notes/ — subdir of shared that sorts AFTER meetings/
  { id: "Q09", token: "FACT_ROADMAP_LATENCY", expectRel: "notes/2026-07-01_1000_Roadmap.md", category: "notes/ (post-flood subdir)" },
  { id: "Q10", token: "FACT_HIRING_STAFFENG", expectRel: "notes/2026-07-02_1400_Hiring.md", category: "notes/ (post-flood subdir)" },
  // flat files that sort AFTER "meetings"
  { id: "Q11", token: "FACT_ONBOARDING_CONCISE", expectRel: "onboarding-context.md", category: "shared flat, post-'m'" },
  { id: "Q12", token: "FACT_SESSIONS_LASTMTG", expectRel: "sessions.json", category: "shared flat, post-'m'" },
  { id: "Q13", token: "FACT_PRES_DECK", expectRel: "presentations/pres_1.json", category: "presentations/ (post-flood subdir)" },
  // knowledgeDir — 0% by default, reachable only when configured
  { id: "Q14", token: "FACT_BILLING_STRIPE", expectRel: "spec-billing.md", category: "knowledgeDir (default empty)" },
  { id: "Q15", token: "FACT_ADR_RUST_INGEST", expectRel: "adr-007.md", category: "knowledgeDir (default empty)" },
];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ccr-gap-"));
  wsDir = join(root, "workspace");
  sharedDir = join(root, "shared");
  prepDir = join(sharedDir, "prep");
  knowDir = join(root, "project-knowledge");

  // workspace root
  put(join(wsDir, "MEMORY.md"), "workspace memory\nFACT_MEMORY_WORKSPACE core identity\n");

  // prep root (separate from shared walk) — reachable even under flood
  put(join(prepDir, "prep_control.md"), "prep control\nFACT_PREP_ROOT_CTL agenda\n");

  // shared flat files (sort before "meetings")
  put(join(sharedDir, "cc_a1_prep.md"), "prep brief\nFACT_PREP_BUDGET alpha budget is 2.4M\n");
  put(join(sharedDir, "cc_a1_summary.md"), "summary\nFACT_SUMMARY_OWNER renewal owner is Dana\n");
  // shared flat files (sort AFTER "meetings")
  put(join(sharedDir, "onboarding-context.md"), "onboarding\nFACT_ONBOARDING_CONCISE user prefers concise updates\n");
  put(join(sharedDir, "sessions.json"), JSON.stringify({ note: "FACT_SESSIONS_LASTMTG last meeting id" }) + "\n");

  // shared/notes/ — subdir sorting after "meetings"
  put(join(sharedDir, "notes", "2026-07-01_1000_Roadmap.md"), "roadmap\nFACT_ROADMAP_LATENCY Q3 priority is the latency rewrite\n");
  put(join(sharedDir, "notes", "2026-07-02_1400_Hiring.md"), "hiring\nFACT_HIRING_STAFFENG open req staff engineer headcount 3\n");
  put(join(sharedDir, "notes", "2026-07-03_0900_Sync.md"), "sync notes\nFACT_NOTE_SYNC misc\n");
  put(join(sharedDir, "notes", "2026-07-04_1100_Retro.md"), "retro notes\nFACT_NOTE_RETRO misc\n");

  // shared/presentations/ — subdir sorting after "meetings"
  put(join(sharedDir, "presentations", "pres_1.json"), JSON.stringify({ deck: "FACT_PRES_DECK slide plan" }) + "\n");

  // shared/meetings/<id>/ — the large subtree that floods the shared root
  for (let i = 1; i <= N_MEETINGS; i++) {
    const id = `mtg_${String(i).padStart(4, "0")}`;
    const d = join(sharedDir, "meetings", id);
    // A handful carry unique tokens the query battery probes for.
    const tokenLine =
      i === 1 ? "FACT_MTG_EARLY_0001 decision adopt ZephyrDB\n" :
      i === 50 ? "FACT_MTG_MID_0050 blocker migration freeze\n" :
      i === 100 ? "FACT_MTG_LATE_0100 action ship beta\n" :
      i === 130 ? "FACT_MTG_LATE_0130 owner assigned QA\n" :
      `mtg ${id} routine notes\n`;
    put(join(d, "timeline.md"), `10:00 kickoff\n${tokenLine}`);
    put(join(d, "transcript.jsonl"), JSON.stringify({ t: 0, text: `transcript ${id}` }) + "\n");
    // Non-searchable artifacts (present in the real tree; inflate list_workspace budget)
    writeFileSync(join(d, "timeline.html"), `<p>${id}</p>\n`);
    writeFileSync(join(d, "kf_01.jpg"), "x");
    writeFileSync(join(d, "kf_02.jpg"), "x");
  }

  // configured knowledgeDir (separate dir, nested docs)
  put(join(knowDir, "product", "spec-billing.md"), "billing spec\nFACT_BILLING_STRIPE uses Stripe Connect 3% platform fee\n");
  put(join(knowDir, "eng", "adr-007.md"), "ADR-007\nFACT_ADR_RUST_INGEST we chose Rust for ingest\n");

  // Patch static dir resolution (same convention as context-retriever-search.test.ts)
  savedWorkspaceDir = (ContextRetriever as any).WORKSPACE_DIR;
  (ContextRetriever as any).WORKSPACE_DIR = wsDir;
  for (const prop of ["SHARED_DIR", "PREP_DIR", "KNOWLEDGE_DIR"]) {
    savedDescriptors[prop] = Object.getOwnPropertyDescriptor(ContextRetriever, prop)!;
  }
  Object.defineProperty(ContextRetriever, "SHARED_DIR", { get: () => sharedDir, configurable: true });
  Object.defineProperty(ContextRetriever, "PREP_DIR", { get: () => prepDir, configurable: true });
  Object.defineProperty(ContextRetriever, "KNOWLEDGE_DIR", { get: () => knowledgeDirValue, configurable: true });
});

afterAll(() => {
  (ContextRetriever as any).WORKSPACE_DIR = savedWorkspaceDir;
  for (const [prop, desc] of Object.entries(savedDescriptors)) {
    Object.defineProperty(ContextRetriever, prop, desc);
  }
  // NOTE: temp root left for the OS to reap; harmless under tmpdir().
});

function makeRetriever() {
  const fakeCtx = { on() {}, off() {}, getRecentTranscript() { return []; }, screen: {}, addStageDocument() {} } as any;
  const fakeBus = { emit() {} } as any;
  const fakeSkill = { currentBrief: null } as any;
  return new ContextRetriever({ context: fakeCtx, eventBus: fakeBus, meetingPrepSkill: fakeSkill });
}

// Exact set of searchable files the retriever can reach today, via the SAME
// bounded walk search_files uses (getSearchRoots + walkFiles(SEARCH_EXTENSIONS)).
async function reachableSearchable(r: any): Promise<Set<string>> {
  const roots = r.getSearchRoots();
  const reached = new Set<string>();
  for (const root of roots) {
    const rels: string[] = await r.walkFiles(root.dir, (ContextRetriever as any).SEARCH_EXTENSIONS, root.skipTopDirs);
    for (const rel of rels) reached.add(join(root.dir, rel));
  }
  return reached;
}

interface QueryResult extends Query { found: boolean; }
async function runQueries(r: any): Promise<QueryResult[]> {
  const out: QueryResult[] = [];
  for (const q of QUERIES) {
    const res: string = await r.executeTool("search_files", { query: q.token });
    out.push({ ...q, found: res.includes(q.expectRel) });
  }
  return out;
}

const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);

// Captured for the report + gated strict assertions
let report: {
  corpusTotal: number;
  reachableDefault: number;
  reachableConfigured: number;
  listedDefault: number;
  qDefault: QueryResult[];
  qConfigured: QueryResult[];
} | null = null;

test("BASELINE: measure reachability + query answerability + write GAP-BASELINE.md", async () => {
  const corpusTotal = corpus.length;

  // ── Default config: knowledgeDir = "" ──
  knowledgeDirValue = "";
  const rDefault = makeRetriever();
  const reachedDefault = await reachableSearchable(rDefault);
  // count only fixtures inside search roots (workspace/prep/shared) — knowledge
  // excluded by default; that exclusion IS the gap and shows up in the ratio.
  const reachableDefault = [...reachedDefault].filter((p) => corpus.includes(p)).length;
  const qDefault = await runQueries(rDefault);
  const listDefault: string = await rDefault.executeTool("list_workspace", {});
  const listedDefault = corpus.filter((p) => {
    // list_workspace prints relative-to-root paths; match on basename+parent to be safe
    const parts = p.split("/");
    const tail = parts.slice(-2).join("/");
    return listDefault.includes(tail) || listDefault.includes(parts[parts.length - 1]!);
  }).length;

  // ── Configured config: knowledgeDir = knowDir ──
  knowledgeDirValue = knowDir;
  const rConfigured = makeRetriever();
  const reachedConfigured = await reachableSearchable(rConfigured);
  const reachableConfigured = [...reachedConfigured].filter((p) => corpus.includes(p)).length;
  const qConfigured = await runQueries(rConfigured);
  knowledgeDirValue = "";

  report = { corpusTotal, reachableDefault, reachableConfigured, listedDefault, qDefault, qConfigured };

  // ── Console summary ──
  const answeredDefault = qDefault.filter((q) => q.found).length;
  const answeredConfigured = qConfigured.filter((q) => q.found).length;
  console.log("\n──────── RETRIEVAL GAP BASELINE ────────");
  console.log(`corpus (searchable fixture files): ${corpusTotal}`);
  console.log(`reachable via walk (knowledgeDir default ""): ${reachableDefault}  (${pct(reachableDefault, corpusTotal)}%)`);
  console.log(`reachable via walk (knowledgeDir configured):  ${reachableConfigured}  (${pct(reachableConfigured, corpusTotal)}%)`);
  console.log(`queries answerable (default):    ${answeredDefault}/${QUERIES.length}  (${pct(answeredDefault, QUERIES.length)}%)`);
  console.log(`queries answerable (configured): ${answeredConfigured}/${QUERIES.length}  (${pct(answeredConfigured, QUERIES.length)}%)`);
  console.log("────────────────────────────────────────\n");

  // ── Write GAP-BASELINE.md (deterministic) ──
  const rows = qDefault.map((q, i) => {
    const c = qConfigured[i]!;
    return `| ${q.id} | \`${q.token}\` | \`${q.expectRel}\` | ${q.category} | ${q.found ? "YES" : "NO"} | ${c.found ? "YES" : "NO"} |`;
  });
  const md = `# Retrieval Gap — Baseline (snapshot of current behavior)

> Auto-generated by \`test/retrieval/retrieval-gap-baseline.test.ts\`. Deterministic; re-running reproduces this file.
>
> Repro: \`cd callingclaw-backend && bun test test/retrieval/retrieval-gap-baseline.test.ts\`
> Strict (expected to FAIL until the gap is fixed): \`RETRIEVAL_GAP_STRICT=1 bun test test/retrieval/retrieval-gap-baseline.test.ts\`

## What is measured

The in-meeting \`ContextRetriever\` agentic-search file tools (\`list_workspace\`,
\`search_files\`, \`read_file\`) are exercised with **no live LLM calls** against a
fixture that mirrors the real \`~/.callingclaw/shared\` tree shape (flat
prep/summary files, a nested \`notes/\` subdir, a large \`meetings/<id>/\` subtree,
plus a separate \`knowledge/\` dir). Every fact-bearing file carries a unique
token so hit/miss is unambiguous.

The recursion half of the originally-reported gap is **already fixed** on
\`origin/main\` (\`walkFiles()\` is a bounded recursive walk — see
\`test/modules/context-retriever-search.test.ts\`). This baseline quantifies what
**remains**: the per-root bounds and the empty \`knowledgeDir\` default.

## Headline numbers

- **Fixture:** ${N_MEETINGS} meeting dirs, ${report.corpusTotal} searchable fixture files (\`.md/.txt/.json/.jsonl\`, depth ≤ 3).
- **Corpus reachable (knowledgeDir default \`""\`):** ${reachableDefault}/${corpusTotal} = **${pct(reachableDefault, corpusTotal)}%**
- **Corpus reachable (knowledgeDir configured):** ${reachableConfigured}/${corpusTotal} = **${pct(reachableConfigured, corpusTotal)}%**
- **Queries answerable (default):** ${answeredDefault}/${QUERIES.length} = **${pct(answeredDefault, QUERIES.length)}%**
- **Queries answerable (knowledgeDir configured):** ${answeredConfigured}/${QUERIES.length} = **${pct(answeredConfigured, QUERIES.length)}%**

## Root cause of the shortfall

- \`ContextRetriever.MAX_FILES_PER_ROOT = 200\`, \`MAX_WALK_DEPTH = 3\`, walk order
  alphabetical. In the \`shared\` root, the \`meetings/\` subtree
  (${N_MEETINGS}×2 = ${N_MEETINGS * 2} searchable files) exhausts the 200-file budget
  before the walk reaches siblings that sort after \`"m"\` — \`notes/\`,
  \`presentations/\`, and flat files like \`onboarding-context.md\` / \`sessions.json\`.
  The majority of meeting timelines past the cap are also unreachable.
- \`src/config.ts\` \`SEARCH_PATHS.knowledgeDir\` defaults to \`""\` → a user's own
  knowledge docs are not a search root until explicitly configured (or adopted
  per-meeting from a prep brief's \`folderPaths\`).

## Query table (query → expected source → found today?)

| id | token | expected source | category | found (default) | found (knowledgeDir configured) |
|----|-------|-----------------|----------|:---------------:|:-------------------------------:|
${rows.join("\n")}

## \`recall_context\` (ai-tools.ts) — note

\`recall_context\`'s LOCAL path searches only \`MEMORY.md\` (\`contextSync.searchMemory\`)
plus prep-brief sections. It does **not** walk the file tree at all; deep search
is delegated to OpenClaw (out-of-meeting). So every nested-file query above is
structurally unanswerable through \`recall_context\`'s local path — see the
\`recall_context local path\` test in this file.

## Notes on the fixture vs. reality

Real \`~/.callingclaw/shared\` at capture time: 1614 files total — 11 flat in
\`shared/\`, \`notes/\` = 12 (flat, date-prefixed filenames — NOT nested by month),
\`meetings/\` = 1590 across 684 \`<id>/\` dirs (each \`timeline.md\` + \`timeline.html\`
+ keyframe \`.jpg\` + \`.jsonl\`), \`prep/\` empty, \`presentations/\` = 1. So in
production the \`meetings/\` flood is ~3× larger than this fixture and the
shortfall is correspondingly worse.
`;
  const reportPath = join(import.meta.dir, "GAP-BASELINE.md");
  writeFileSync(reportPath, md);

  // ── Sanity: fixture is large enough that the flood actually bites ──
  expect(corpusTotal).toBeGreaterThan(200);
}, 60_000);

// The snapshot assertions below read the results computed once by the BASELINE
// test above (Bun runs tests in definition order within a file), keeping them
// instant instead of re-walking the fixture. `report` is guaranteed populated.
function byId(rows: QueryResult[]): Record<string, boolean> {
  return Object.fromEntries(rows.map((x) => [x.id, x.found]));
}

// ══════════════ Snapshot-of-today assertions (GREEN on current code) ══════════════

test("snapshot: controls + early meeting ARE reachable today", () => {
  expect(report).not.toBeNull();
  const d = byId(report!.qDefault);
  expect(d.Q01).toBe(true); // workspace MEMORY.md (own root)
  expect(d.Q02).toBe(true); // prep/ (own root)
  expect(d.Q03).toBe(true); // shared flat, pre-'m'
  expect(d.Q04).toBe(true); // shared flat, pre-'m'
  expect(d.Q05).toBe(true); // earliest meeting timeline
});

test("snapshot: post-flood shared content is NOT reachable today (the gap)", () => {
  const d = byId(report!.qDefault);
  // notes/ subdir (sorts after meetings/) — blocked by the 200-file flood
  expect(d.Q09).toBe(false);
  expect(d.Q10).toBe(false);
  // flat files sorting after "meetings"
  expect(d.Q11).toBe(false);
  expect(d.Q12).toBe(false);
  // presentations/ subdir sorting after meetings/
  expect(d.Q13).toBe(false);
  // latest meeting timeline — past the per-root cap
  expect(d.Q08).toBe(false);
});

test("snapshot: knowledgeDir default empty ⇒ user docs 0% reachable; configuring it recovers them", () => {
  const d = byId(report!.qDefault);
  const c = byId(report!.qConfigured);
  // Default: not a root
  expect(d.Q14).toBe(false);
  expect(d.Q15).toBe(false);
  // Configured: becomes a root (own 200-file budget) → reachable
  expect(c.Q14).toBe(true);
  expect(c.Q15).toBe(true);
});

test("recall_context local path only sees MEMORY.md — blind to notes/meetings/knowledge", async () => {
  // recall_context's local (non-OpenClaw) path is contextSync.searchMemory +
  // prep-brief sections. Prove it cannot answer a nested-file query.
  const contextSync = {
    searchMemory: (query: string) =>
      query.includes("FACT_IN_MEMORY") ? "[MEMORY.md] found the memory fact" : "",
  } as any;
  const deps = {
    contextSync,
    openclawBridge: { connected: false } as any,
    dispatcher: undefined,
    eventBus: { emit() {} } as any,
    meetingPrepSkill: { currentBrief: null } as any,
    contextRetriever: { active: false, retrievedContexts: [] } as any,
  };
  const mod = aiTools(deps);

  // A fact that only lives in notes/ (never in MEMORY.md) is NOT recalled locally
  const missed = await mod.handler("recall_context", { query: "FACT_ROADMAP_LATENCY", urgency: "quick" });
  expect(missed.toLowerCase()).toContain("couldn't find");

  // Control: a MEMORY.md fact IS recalled locally
  const hit = await mod.handler("recall_context", { query: "FACT_IN_MEMORY roadmap", urgency: "quick" });
  expect(hit).toContain("found the memory fact");
});

// ══════════════ Desired-state assertions (gated; FAIL until the gap is fixed) ══════════════

test.if(STRICT)("STRICT: 100% of the searchable corpus is reachable (default config)", async () => {
  knowledgeDirValue = "";
  const r = makeRetriever();
  const reached = await reachableSearchable(r);
  const reachable = corpus.filter((p) => reached.has(p)).length;
  // Desired: every shallow searchable file reachable regardless of meetings/ size.
  expect(reachable).toBe(corpus.length);
}, 60_000);

test.if(STRICT)("STRICT: every fixture query is answerable (knowledgeDir configured)", async () => {
  knowledgeDirValue = knowDir;
  const r = makeRetriever();
  const q = await runQueries(r);
  knowledgeDirValue = "";
  const missed = q.filter((x) => !x.found).map((x) => `${x.id} ${x.expectRel}`);
  expect(missed).toEqual([]);
}, 60_000);
