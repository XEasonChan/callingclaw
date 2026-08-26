#!/usr/bin/env bun
// CallingClaw 2.0 — Scoped TypeScript gate for the System-1 / System-2 conversation loop
// (see docs/s1s2-conversation-architecture.md §12 "Risk & rollout").
//
// WHY THIS EXISTS
// ----------------
// `tsc --noEmit` is not a CI gate for this repo: the tree carries ~379
// pre-existing legacy errors (test files, evals, older modules) that would
// mask any *new* error in a full-repo gate. That masking is exactly how a
// shipped P0 blocker got through: transcript-auditor.ts called a method
// (`client.queuePendingResponse()`) that does not exist on RealtimeClient
// (TS2551) and reached a `private` field across a module boundary (TS2341
// x2) — real compile errors, invisible because nobody runs tsc as a gate.
//
// This script narrows the gate to just the S1<->S2 conversation file set
// (the live voice loop + its deliberate/System-2 producers) and compares
// against a COMMITTED BASELINE of the errors that already existed in THOSE
// files when the gate was introduced. It exits nonzero ONLY when a NEW
// error (not in the baseline) appears in a scoped file. It does not require
// fixing the legacy errors, in those files or anywhere else, to pass.
//
// USAGE
// -----
//   bun run check:s1s2-tsc              # gate: fails on any NEW scoped error
//   bun scripts/check-s1s2-tsc.ts        # same, direct invocation
//   bun scripts/check-s1s2-tsc.ts --update-baseline
//                                         # regenerate the baseline from the
//                                         # CURRENT tree and overwrite
//                                         # scripts/s1s2-tsc-baseline.txt
//
// WHEN TO REGENERATE THE BASELINE
// --------------------------------
// Run `--update-baseline` (and commit the resulting baseline file) whenever
// you *intentionally* change the error surface of a scoped file:
//   - You fixed one or more legacy/pre-existing errors in a scoped file.
//     (Removing errors always passes the gate as-is, but regenerate anyway
//     so the baseline stays tight and doesn't silently "cover for" a
//     regression that happens to reintroduce the same error text later.)
//   - You added a new scoped file (e.g. a new `src/modules/deliberate-*.ts`
//     file from P1) that ships with known, accepted pre-existing errors.
//   - You deliberately accept a new error as a tracked follow-up (rare —
//     prefer fixing it; if you must, regenerate and say so in the commit
//     message).
// Never hand-edit scripts/s1s2-tsc-baseline.txt — always regenerate it via
// `--update-baseline` so the normalization stays consistent.
//
// BASELINE FORMAT / NORMALIZATION
// --------------------------------
// tsc output lines look like:
//   <file>(<line>,<col>): error TS<code>: <message...>
// with possible wrapped continuation lines (no "file(line,col):" prefix)
// that belong to the previous diagnostic. We parse those into structured
// entries, then key each one as:
//   <file>::TS<code>::<message>
// deliberately DROPPING line/column numbers. This makes the baseline robust
// to line-shift churn (unrelated edits above an error moving it a few lines
// down) while still comparing as a MULTISET (count per key), not a plain
// set: several distinct diagnostics in one file can normalize to the exact
// same key (e.g. four separate "Object is possibly 'null'." errors at
// different lines in the same file all key identically once line/col are
// stripped). If we only tracked set-membership, a genuinely new 5th
// occurrence of that same shape would be silently invisible — the key
// would already be "seen". Tracking counts means only genuinely new
// occurrences beyond what the baseline already accounts for trip the gate,
// while a same-count reshuffle (e.g. the 4 errors moving to different
// lines) stays silent. The baseline file format is `<count>\t<key>`.

import { existsSync } from "node:fs";

// ── Scoped file set ─────────────────────────────────────────────────────
// Edit this list as the S1/S2 conversation surface grows. Paths are
// relative to callingclaw-backend/ (i.e. exactly as tsc prints them when
// run from this directory).
const SCOPED_FILES: string[] = [
  "src/modules/voice.ts",
  "src/ai_gateway/realtime_client.ts",
  "src/modules/transcript-auditor.ts",
  "src/modules/context-retriever.ts",
  "src/modules/action-orchestrator.ts",
  "src/modules/shared-context.ts",
  "src/ai_gateway/gemini-adapter.ts",
];

// P1 (docs/s1s2-conversation-architecture.md §4) will add new deliberate-*
// producers/sinks under src/modules/. Auto-include any such file without
// requiring an edit here first; add the concrete filename to SCOPED_FILES
// above once it lands, for clarity/discoverability — this pattern is a
// safety net, not a substitute.
const SCOPED_GLOBS: RegExp[] = [/^src\/modules\/deliberate-.*\.ts$/];

function isScoped(file: string): boolean {
  if (SCOPED_FILES.includes(file)) return true;
  return SCOPED_GLOBS.some((re) => re.test(file));
}

// ── tsc invocation ───────────────────────────────────────────────────────

const TSC_BIN = `${import.meta.dir}/../node_modules/.bin/tsc`;
const BASELINE_PATH = `${import.meta.dir}/s1s2-tsc-baseline.txt`;

interface TscError {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
}

function runTsc(): string {
  const proc = Bun.spawnSync([TSC_BIN, "--noEmit"], {
    cwd: `${import.meta.dir}/..`,
    stdout: "pipe",
    stderr: "pipe",
  });
  // tsc exits nonzero whenever there are diagnostics — that's expected and
  // not itself a failure of this script; we parse stdout either way.
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  if (stderr.trim() && proc.stdout.toString().trim() === "") {
    // tsc failed to run at all (e.g. binary missing, config error).
    console.error("tsc invocation produced no stdout and wrote to stderr:");
    console.error(stderr);
    process.exit(2);
  }
  return stdout;
}

const DIAG_HEAD_RE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

function parseTscOutput(output: string): TscError[] {
  const errors: TscError[] = [];
  const lines = output.split("\n");
  let current: TscError | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "") continue;
    const m = DIAG_HEAD_RE.exec(line);
    if (m) {
      if (current) errors.push(current);
      const [, file, lineNo, col, code, message] = m;
      current = {
        file: file.replace(/\\/g, "/"),
        line: Number(lineNo),
        col: Number(col),
        code,
        message,
      };
    } else if (current) {
      // Continuation line (wrapped detail, e.g. nested type explanation).
      current.message += ` ${line.trim()}`;
    }
    // else: stray line before any diagnostic head (e.g. a banner) — ignore.
  }
  if (current) errors.push(current);
  return errors;
}

function normalize(e: TscError): string {
  return `${e.file}::${e.code}::${e.message}`;
}

// ── Main ─────────────────────────────────────────────────────────────────

function toCounts(keys: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  return counts;
}

function serializeBaseline(counts: Map<string, number>): string {
  const lines = [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, count]) => `${count}\t${key}`);
  return lines.join("\n") + (lines.length ? "\n" : "");
}

function parseBaseline(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const tabIdx = line.indexOf("\t");
    if (tabIdx === -1) {
      // Tolerate a hand-edited/legacy plain-key line (no count prefix) as count 1.
      counts.set(line, (counts.get(line) ?? 0) + 1);
      continue;
    }
    const count = Number(line.slice(0, tabIdx));
    const key = line.slice(tabIdx + 1);
    counts.set(key, (counts.get(key) ?? 0) + (Number.isFinite(count) ? count : 1));
  }
  return counts;
}

const args = process.argv.slice(2);
const updateBaseline = args.includes("--update-baseline");

const rawOutput = runTsc();
const allErrors = parseTscOutput(rawOutput);
const scopedErrors = allErrors.filter((e) => isScoped(e.file));
const scopedKeys = scopedErrors.map(normalize);
const currentCounts = toCounts(scopedKeys);

if (updateBaseline) {
  await Bun.write(BASELINE_PATH, serializeBaseline(currentCounts));
  const totalOccurrences = [...currentCounts.values()].reduce((a, b) => a + b, 0);
  console.log(`Wrote ${currentCounts.size} unique error shape(s), ${totalOccurrences} total occurrence(s) to ${BASELINE_PATH}`);
  console.log("Review the diff and commit scripts/s1s2-tsc-baseline.txt.");
  process.exit(0);
}

if (!existsSync(BASELINE_PATH)) {
  console.error(`No baseline found at ${BASELINE_PATH}.`);
  console.error("Generate one with: bun scripts/check-s1s2-tsc.ts --update-baseline");
  process.exit(2);
}

const baselineText = await Bun.file(BASELINE_PATH).text();
const baselineCounts = parseBaseline(baselineText);

const baselineTotal = [...baselineCounts.values()].reduce((a, b) => a + b, 0);
const currentTotal = [...currentCounts.values()].reduce((a, b) => a + b, 0);

// A key is "new" to the extent its current count exceeds its baseline count
// (0 if absent from baseline). Collect that many detail lines (by line/col)
// for reporting.
type NewOccurrence = { key: string; excess: number };
const newOccurrences: NewOccurrence[] = [];
for (const [key, count] of currentCounts) {
  const baseline = baselineCounts.get(key) ?? 0;
  if (count > baseline) newOccurrences.push({ key, excess: count - baseline });
}
newOccurrences.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

const fixedOrReduced: string[] = [];
for (const [key, count] of baselineCounts) {
  const current = currentCounts.get(key) ?? 0;
  if (current < count) fixedOrReduced.push(`${key} (${count} -> ${current})`);
}

console.log(`[check:s1s2-tsc] scoped files: ${SCOPED_FILES.length} listed + glob (${SCOPED_GLOBS.map((r) => r.source).join(", ")})`);
console.log(`[check:s1s2-tsc] baseline: ${baselineCounts.size} shape(s) / ${baselineTotal} occurrence(s) | current: ${currentCounts.size} shape(s) / ${currentTotal} occurrence(s)`);

if (fixedOrReduced.length > 0) {
  console.log(`[check:s1s2-tsc] ${fixedOrReduced.length} baseline error shape(s) reduced or fixed — `
    + `consider regenerating the baseline with --update-baseline so it stays tight:`);
  for (const f of fixedOrReduced) console.log(`    - ${f}`);
}

if (newOccurrences.length > 0) {
  const totalExcess = newOccurrences.reduce((a, o) => a + o.excess, 0);
  console.error("");
  console.error("=".repeat(72));
  console.error(`FAIL: ${totalExcess} NEW TypeScript error occurrence(s) in the S1/S2 conversation file set`);
  console.error("=".repeat(72));
  for (const { key, excess } of newOccurrences) {
    const matches = scopedErrors.filter((e) => normalize(e) === key);
    // Baseline already "covers" (baselineCounts.get(key) ?? 0) of these
    // occurrences; report the excess (newest by source order) with file:line:col.
    const covered = baselineCounts.get(key) ?? 0;
    const excessMatches = matches.slice(covered);
    for (const detail of excessMatches.length ? excessMatches : [undefined]) {
      if (detail) {
        console.error(`  ${detail.file}(${detail.line},${detail.col}): error ${detail.code}: ${detail.message}`);
      } else {
        console.error(`  ${key}  (x${excess})`);
      }
    }
  }
  console.error("");
  console.error("These exceed what scripts/s1s2-tsc-baseline.txt already accounts for. Either");
  console.error("fix them, or if this is an intentionally-accepted pre-existing error being");
  console.error("newly scoped in, regenerate the baseline:");
  console.error("  bun scripts/check-s1s2-tsc.ts --update-baseline");
  process.exit(1);
}

console.log("[check:s1s2-tsc] PASS — no new errors beyond baseline in the S1/S2 file set.");
process.exit(0);
