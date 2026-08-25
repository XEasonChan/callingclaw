// Deterministic prep enrichment tests (meeting-prep.ts):
//   - open/pending TaskStore items appended to previousContext (cap 5)
//   - most recent *_summary.md (mtime ≤ 30 days) appended
//   - total added text capped (~800 chars)
//   - dedupe when summary already substantially present
//   - graceful degradation: missing store, no summaries, malformed data → no-op
//
// enrichBriefWithLocalContext is called with explicit taskStore/sharedDir in
// every test so nothing touches the real data/tasks.json or ~/.callingclaw.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrichBriefWithLocalContext } from "../../src/skills/meeting-prep";
import type { MeetingPrepBrief, OpenTaskSource } from "../../src/skills/meeting-prep";

let root: string;

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();

function makeBrief(previousContext?: string): MeetingPrepBrief {
  return {
    topic: "test meeting", goal: "test", generatedAt: NOW,
    summary: "", keyPoints: [], architectureDecisions: [], expectedQuestions: [],
    previousContext,
    filePaths: [], browserUrls: [], folderPaths: [], attendees: [], liveNotes: [],
  };
}

function makeStore(tasks: Array<{ task: string; status: string; sourceMeetingId?: string; createdAt?: number }>): OpenTaskSource {
  return {
    list(filters) {
      const filtered = filters?.status ? tasks.filter((t) => t.status === filters.status) : tasks;
      return [...filtered].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    },
  };
}

/** Write a summary file with a specific mtime (ageDays before NOW) */
function writeSummary(dir: string, name: string, content: string, ageDays: number) {
  const p = join(dir, name);
  writeFileSync(p, content);
  const t = new Date(NOW - ageDays * DAY_MS);
  utimesSync(p, t, t);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "prep-enrich-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// ══════════════ (a) TaskStore injection ══════════════

test("appends up to 5 open tasks with sourceMeetingId to previousContext", async () => {
  const store = makeStore([
    ...Array.from({ length: 7 }, (_, i) => ({
      task: `Pending task ${i}`, status: "pending", sourceMeetingId: `m-${i}`, createdAt: NOW - i * 1000,
    })),
    { task: "Done task", status: "done", sourceMeetingId: "m-done", createdAt: NOW },
  ]);
  const brief = makeBrief("Existing agent-written context.");
  const result = await enrichBriefWithLocalContext(brief, { taskStore: store, sharedDir: join(root, "empty-none") });

  expect(result.addedTasks).toBe(5);
  expect(result.addedSummary).toBe(false);
  const ctx = brief.previousContext!;
  expect(ctx.startsWith("Existing agent-written context.")).toBe(true);
  expect(ctx).toContain("[Auto-added] Open action items from previous meetings:");
  expect(ctx).toContain("- Pending task 0 (from meeting m-0)");
  expect(ctx).toContain("- Pending task 4 (from meeting m-4)");
  expect(ctx).not.toContain("Pending task 5"); // capped at 5
  expect(ctx).not.toContain("Done task");      // only pending/in_progress
});

test("in_progress tasks are included alongside pending", async () => {
  const store = makeStore([
    { task: "Pending one", status: "pending", createdAt: NOW - 1000 },
    { task: "In progress one", status: "in_progress", sourceMeetingId: "m-x", createdAt: NOW },
  ]);
  const brief = makeBrief();
  const result = await enrichBriefWithLocalContext(brief, { taskStore: store, sharedDir: join(root, "empty-none") });

  expect(result.addedTasks).toBe(2);
  expect(brief.previousContext).toContain("- In progress one (from meeting m-x)");
  expect(brief.previousContext).toContain("- Pending one");
});

test("taskStore: null disables task enrichment", async () => {
  const brief = makeBrief();
  const result = await enrichBriefWithLocalContext(brief, { taskStore: null, sharedDir: join(root, "empty-none") });
  expect(result.addedTasks).toBe(0);
  expect(result.addedSummary).toBe(false);
  expect(brief.previousContext).toBeUndefined(); // untouched
});

test("throwing task store degrades gracefully", async () => {
  const store: OpenTaskSource = { list() { throw new Error("boom"); } };
  const brief = makeBrief("keep me");
  const result = await enrichBriefWithLocalContext(brief, { taskStore: store, sharedDir: join(root, "empty-none") });
  expect(result.addedTasks).toBe(0);
  expect(brief.previousContext).toBe("keep me");
});

test("malformed task entries are skipped without throwing", async () => {
  const store = makeStore([
    { task: "", status: "pending", createdAt: NOW },
    { task: null as any, status: "pending", createdAt: NOW },
    { task: "Real task", status: "pending", createdAt: NOW - 1 },
  ]);
  const brief = makeBrief();
  const result = await enrichBriefWithLocalContext(brief, { taskStore: store, sharedDir: join(root, "empty-none") });
  expect(result.addedTasks).toBe(1);
  expect(brief.previousContext).toContain("- Real task");
});

// ══════════════ (b) Recent summary injection ══════════════

test("appends the most recent *_summary.md within 30 days", async () => {
  const dir = join(root, "shared-recent");
  mkdirSync(dir, { recursive: true });
  writeSummary(dir, "old-mtg_summary.md", "Very old summary that should be ignored entirely.", 40); // > 30d
  writeSummary(dir, "week-mtg_summary.md", "Week-old summary content, still valid but not newest.", 7);
  writeSummary(dir, "new-mtg_summary.md", "Newest summary: decided to ship v3 on Friday after QA sign-off.", 1);
  writeFileSync(join(dir, "random-notes.md"), "not a summary file"); // wrong name pattern

  const brief = makeBrief("Agent context.");
  const result = await enrichBriefWithLocalContext(brief, { taskStore: null, sharedDir: dir, now: NOW });

  expect(result.addedSummary).toBe(true);
  const ctx = brief.previousContext!;
  expect(ctx).toContain("[Auto-added] Most recent meeting summary (new-mtg_summary.md):");
  expect(ctx).toContain("decided to ship v3 on Friday");
  expect(ctx).not.toContain("Week-old summary");
  expect(ctx).not.toContain("Very old summary");
  expect(ctx).not.toContain("not a summary file");
});

test("summaries older than 30 days are ignored (no-op)", async () => {
  const dir = join(root, "shared-stale");
  mkdirSync(dir, { recursive: true });
  writeSummary(dir, "ancient_summary.md", "Ancient summary content that is far too old to matter now.", 45);

  const brief = makeBrief();
  const result = await enrichBriefWithLocalContext(brief, { taskStore: null, sharedDir: dir, now: NOW });
  expect(result.addedSummary).toBe(false);
  expect(brief.previousContext).toBeUndefined();
});

test("prefers the Summary section of the file when present", async () => {
  const dir = join(root, "shared-section");
  mkdirSync(dir, { recursive: true });
  writeSummary(
    dir, "sec_summary.md",
    "# Meeting 2026-06-30\n\nAttendees: A, B\n\n## Summary\nKey outcome: adopt Gemini Live as default voice provider.\n\n## Action Items\n- follow up",
    2,
  );
  const brief = makeBrief();
  const result = await enrichBriefWithLocalContext(brief, { taskStore: null, sharedDir: dir, now: NOW });
  expect(result.addedSummary).toBe(true);
  expect(brief.previousContext).toContain("Key outcome: adopt Gemini Live");
  expect(brief.previousContext).not.toContain("Attendees: A, B");
  expect(brief.previousContext).not.toContain("- follow up");
});

test("summary already substantially present in previousContext → not re-added", async () => {
  const dir = join(root, "shared-dupe");
  mkdirSync(dir, { recursive: true });
  const body = "Decision recap: keep Haiku for in-meeting computer use, Sonnet outside meetings.";
  writeSummary(dir, "dupe_summary.md", body, 2);

  const brief = makeBrief(`The agent already covered this: ${body}`);
  const before = brief.previousContext!;
  const result = await enrichBriefWithLocalContext(brief, { taskStore: null, sharedDir: dir, now: NOW });
  expect(result.addedSummary).toBe(false);
  expect(brief.previousContext).toBe(before);
});

test("empty or trivially short summary files are skipped", async () => {
  const dir = join(root, "shared-empty");
  mkdirSync(dir, { recursive: true });
  writeSummary(dir, "empty_summary.md", "", 1);
  writeSummary(dir, "tiny_summary.md", "hi", 1);

  const brief = makeBrief();
  const result = await enrichBriefWithLocalContext(brief, { taskStore: null, sharedDir: dir, now: NOW });
  expect(result.addedSummary).toBe(false);
});

test("missing shared dir degrades gracefully", async () => {
  const brief = makeBrief();
  const result = await enrichBriefWithLocalContext(brief, {
    taskStore: null,
    sharedDir: join(root, "does-not-exist-at-all"),
  });
  expect(result.addedSummary).toBe(false);
  expect(brief.previousContext).toBeUndefined();
});

// ══════════════ Budget cap ══════════════

test("total added text is capped at ~800 chars (tasks prioritized)", async () => {
  const dir = join(root, "shared-cap");
  mkdirSync(dir, { recursive: true });
  writeSummary(dir, "big_summary.md", "S".repeat(2000), 1);

  const store = makeStore(
    Array.from({ length: 5 }, (_, i) => ({
      task: `Long task ${i} ${"x".repeat(200)}`, status: "pending", sourceMeetingId: `mtg-${i}`, createdAt: NOW - i,
    })),
  );
  const brief = makeBrief("base");
  const before = brief.previousContext!.length;
  await enrichBriefWithLocalContext(brief, { taskStore: store, sharedDir: dir, now: NOW });
  const added = brief.previousContext!.length - before;
  // budget (800) + joining "\n\n" separator to the existing context
  expect(added).toBeLessThanOrEqual(802);
  expect(brief.previousContext).toContain("[Auto-added] Open action items");
});

test("custom maxChars is honored", async () => {
  const store = makeStore([
    { task: "T".repeat(300), status: "pending", createdAt: NOW },
  ]);
  const brief = makeBrief();
  await enrichBriefWithLocalContext(brief, { taskStore: store, sharedDir: join(root, "empty-none"), maxChars: 100 });
  expect(brief.previousContext!.length).toBeLessThanOrEqual(100);
  expect(brief.previousContext).toContain("…");
});

test("nothing to add → previousContext untouched and no throw", async () => {
  const brief = makeBrief();
  const result = await enrichBriefWithLocalContext(brief, {
    taskStore: makeStore([]),
    sharedDir: join(root, "empty-none"),
  });
  expect(result).toEqual({ addedTasks: 0, addedSummary: false });
  expect(brief.previousContext).toBeUndefined();
});
