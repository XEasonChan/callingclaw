// ContextRetriever agentic-search coverage tests:
//   - recursive file discovery (nested notes/ and meetings/{id}/ subdirs)
//   - dot-dir / node_modules exclusion + depth cap
//   - list_workspace relative paths + output bound
//   - read_file nested relative path resolution
//   - per-meeting knowledgeDir adoption from prep brief folderPaths (+ reset)
//   - explicitly configured knowledgeDir keeps working
//
// The retriever's search dirs are static getters — tests patch them via
// Object.defineProperty (same "poke privates" convention as other tests here).

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextRetriever } from "../../src/modules/context-retriever";

// ── Temp directory layout ──
let root: string;
let wsDir: string;      // fake ~/.openclaw/workspace
let sharedDir: string;  // fake ~/.callingclaw/shared
let prepDir: string;    // sharedDir/prep
let knowDir: string;    // fake configured knowledgeDir
let projDirs: string[]; // fake prep folderPaths targets

// Saved originals for restore
let savedWorkspaceDir: string;
const savedDescriptors: Record<string, PropertyDescriptor> = {};
let knowledgeDirValue = ""; // what the patched KNOWLEDGE_DIR getter returns

function makeRetriever(brief: any = null) {
  const fakeCtx = {
    on() {}, off() {},
    getRecentTranscript() { return []; },
    screen: {},
    addStageDocument() {},
  } as any;
  const fakeBus = { emit() {} } as any;
  const fakeSkill = { currentBrief: brief } as any;
  return new ContextRetriever({ context: fakeCtx, eventBus: fakeBus, meetingPrepSkill: fakeSkill });
}

function makeBrief(folderPaths: Array<{ path: string; description?: string }>): any {
  return {
    topic: "test", goal: "test", generatedAt: Date.now(),
    summary: "", keyPoints: [], architectureDecisions: [], expectedQuestions: [],
    filePaths: [], browserUrls: [], folderPaths, attendees: [], liveNotes: [],
  };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ccr-search-"));
  wsDir = join(root, "workspace");
  sharedDir = join(root, "shared");
  prepDir = join(sharedDir, "prep");
  knowDir = join(root, "knowledge");
  projDirs = [join(root, "proj-a"), join(root, "proj-b"), join(root, "proj-c"), join(root, "proj-d")];

  // workspace: top-level + nested
  mkdirSync(wsDir, { recursive: true });
  writeFileSync(join(wsDir, "MEMORY.md"), "workspace memory: needle-top\n");

  // shared: nested notes/ + meetings/{id}/ + excluded dirs + deep dirs
  mkdirSync(join(sharedDir, "notes"), { recursive: true });
  writeFileSync(join(sharedDir, "notes", "note-a.md"), "meeting note body needle-in-notes\n");
  mkdirSync(join(sharedDir, "meetings", "m1"), { recursive: true });
  writeFileSync(join(sharedDir, "meetings", "m1", "timeline.md"), "10:00 kickoff needle-timeline\n");
  mkdirSync(join(sharedDir, ".hidden"), { recursive: true });
  writeFileSync(join(sharedDir, ".hidden", "secret.md"), "needle-hidden\n");
  mkdirSync(join(sharedDir, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(sharedDir, "node_modules", "pkg", "readme.md"), "needle-node-modules\n");
  // depth 3 (a/b/c/file) reachable, depth 4 (a/b/c/d/file) not
  mkdirSync(join(sharedDir, "a", "b", "c", "d"), { recursive: true });
  writeFileSync(join(sharedDir, "a", "b", "c", "depth3.md"), "needle-depth3\n");
  writeFileSync(join(sharedDir, "a", "b", "c", "d", "depth4.md"), "needle-depth4\n");
  // non-searchable extension: excluded from search, still listed
  writeFileSync(join(sharedDir, "notes", "page.html"), "<p>needle-html</p>\n");

  // prep dir (nested inside shared)
  mkdirSync(prepDir, { recursive: true });
  writeFileSync(join(prepDir, "m1_prep.md"), "prep brief needle-prep\n");

  // configured knowledge dir
  mkdirSync(knowDir, { recursive: true });
  writeFileSync(join(knowDir, "kb.md"), "knowledge base needle-knowledge\n");

  // prep folderPaths targets
  for (const [i, d] of projDirs.entries()) {
    mkdirSync(join(d, "docs"), { recursive: true });
    writeFileSync(join(d, "docs", "spec.md"), `project spec needle-proj-${"abcd"[i]}\n`);
  }

  // dot-file directly under an adopted root's top level (read_file dot-segment exploit target)
  writeFileSync(join(projDirs[0]!, ".env"), "SECRET=needle-dotfile-proj-a\n");

  // dot-file directly under a built-in root's top level (same policy applies there too)
  writeFileSync(join(wsDir, ".secret-ws.md"), "needle-dotfile-workspace\n");

  // Patch the retriever's static dir resolution
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
  rmSync(root, { recursive: true, force: true });
});

// ══════════════ Recursive search coverage ══════════════

test("search_files finds files in nested subdirs (notes/, meetings/{id}/)", async () => {
  const r = makeRetriever();
  const notes = await (r as any).executeTool("search_files", { query: "needle-in-notes" });
  expect(notes).toContain("shared/notes/note-a.md");

  const timeline = await (r as any).executeTool("search_files", { query: "needle-timeline" });
  expect(timeline).toContain("shared/meetings/m1/timeline.md");

  // top-level workspace files still found (no path prefix for workspace)
  const top = await (r as any).executeTool("search_files", { query: "needle-top" });
  expect(top).toContain("MEMORY.md");
});

test("search_files skips dot-dirs and node_modules", async () => {
  const r = makeRetriever();
  expect(await (r as any).executeTool("search_files", { query: "needle-hidden" }))
    .toContain("No matches");
  expect(await (r as any).executeTool("search_files", { query: "needle-node-modules" }))
    .toContain("No matches");
});

test("search_files respects the depth cap (3 subdirs deep)", async () => {
  const r = makeRetriever();
  expect(await (r as any).executeTool("search_files", { query: "needle-depth3" }))
    .toContain("shared/a/b/c/depth3.md");
  expect(await (r as any).executeTool("search_files", { query: "needle-depth4" }))
    .toContain("No matches");
});

test("list_workspace shows nested relative paths, no shared/prep duplicates", async () => {
  const r = makeRetriever();
  const out = await (r as any).executeTool("list_workspace", {});
  expect(out).toContain("[workspace] MEMORY.md");
  expect(out).toContain("[shared] notes/note-a.md");
  expect(out).toContain("[shared] meetings/m1/timeline.md");
  expect(out).toContain("[prep] m1_prep.md");
  // prep dir is nested inside shared — must not be double-listed
  expect(out).not.toContain("[shared] prep/m1_prep.md");
  // dot-dirs and node_modules never listed
  expect(out).not.toContain(".hidden");
  expect(out).not.toContain("node_modules");
  // non-searchable extensions still visible in listing
  expect(out).toContain("[shared] notes/page.html");
});

test("list_workspace output is bounded", async () => {
  const manyDir = join(sharedDir, "many");
  mkdirSync(manyDir, { recursive: true });
  for (let i = 0; i < 150; i++) writeFileSync(join(manyDir, `f${String(i).padStart(3, "0")}.md`), "x\n");
  try {
    const r = makeRetriever();
    const out: string = await (r as any).executeTool("list_workspace", {});
    const lines = out.split("\n");
    // MAX_LIST_ENTRIES (120) + truncation marker
    expect(lines.length).toBeLessThanOrEqual(121);
    expect(out).toContain("more files not shown");
  } finally {
    rmSync(manyDir, { recursive: true, force: true });
  }
});

test("read_file resolves nested relative paths, with or without the root prefix", async () => {
  const r = makeRetriever();
  expect(await (r as any).executeTool("read_file", { path: "notes/note-a.md" }))
    .toContain("needle-in-notes");
  expect(await (r as any).executeTool("read_file", { path: "shared/meetings/m1/timeline.md" }))
    .toContain("needle-timeline");
  expect(await (r as any).executeTool("read_file", { path: "prep/m1_prep.md" }))
    .toContain("needle-prep");
  expect(await (r as any).executeTool("read_file", { path: "does/not/exist.md" }))
    .toContain("File not found");
});

// ══════════════ Explicit knowledgeDir (unchanged behavior) ══════════════

test("explicitly configured knowledgeDir is searchable", async () => {
  knowledgeDirValue = knowDir;
  try {
    const r = makeRetriever();
    const out = await (r as any).executeTool("search_files", { query: "needle-knowledge" });
    expect(out).toContain("knowledge/kb.md");
    const listed = await (r as any).executeTool("list_workspace", {});
    expect(listed).toContain("[knowledge] kb.md");
  } finally {
    knowledgeDirValue = "";
  }
});

// ══════════════ Per-meeting folderPaths adoption ══════════════

test("prep brief folderPaths become searchable (validated, ~ expanded, capped at 3)", async () => {
  const savedHome = process.env.HOME;
  process.env.HOME = root; // so "~/proj-b" expands under our temp root
  try {
    const brief = makeBrief([
      { path: projDirs[0]! },                       // valid absolute
      { path: `~/${projDirs[1]!.split("/").pop()}` }, // valid via ~ expansion
      { path: join(root, "definitely-missing-xyz") }, // nonexistent → skipped
      { path: "relative/not-allowed" },              // relative → skipped
      { path: projDirs[2]! },                        // valid (3rd)
      { path: projDirs[3]! },                        // valid but over the cap of 3
    ]);
    const r = makeRetriever(brief);

    const dirs: string[] = (r as any).resolveMeetingKnowledgeDirs();
    expect(dirs).toEqual([projDirs[0]!, projDirs[1]!, projDirs[2]!]);

    // Adopted dirs are actually searchable + listed
    const out = await (r as any).executeTool("search_files", { query: "needle-proj-a" });
    expect(out).toContain("proj-a/docs/spec.md");
    const listed = await (r as any).executeTool("list_workspace", {});
    expect(listed).toContain("[proj-a] docs/spec.md");

    // Over-cap dir is NOT searchable
    const overCap = await (r as any).executeTool("search_files", { query: "needle-proj-d" });
    expect(overCap).toContain("No matches");

    // read_file works with the listed prefix and without
    expect(await (r as any).executeTool("read_file", { path: "proj-a/docs/spec.md" }))
      .toContain("needle-proj-a");
  } finally {
    process.env.HOME = savedHome;
  }
});

test("no brief / no folderPaths → no extra search roots", () => {
  const r1 = makeRetriever(null);
  expect((r1 as any).resolveMeetingKnowledgeDirs()).toEqual([]);
  const r2 = makeRetriever(makeBrief([]));
  expect((r2 as any).resolveMeetingKnowledgeDirs()).toEqual([]);
});

test("activate resolves fresh dirs; deactivate resets them", () => {
  const brief = makeBrief([{ path: projDirs[0]! }]);
  const r = makeRetriever(brief);
  const voice = {} as any;

  r.activate(voice);
  expect((r as any).resolveMeetingKnowledgeDirs()).toEqual([projDirs[0]!]);
  expect((r as any)._meetingKnowledgeDirs).toEqual([projDirs[0]!]);

  r.deactivate();
  expect((r as any)._meetingKnowledgeDirs).toEqual([]);
  expect((r as any)._meetingKnowledgeDirsKey).toBe(0);

  // Re-activate for a "new meeting" with a different brief → old dirs gone
  (r as any).meetingPrepSkill.currentBrief = makeBrief([{ path: projDirs[1]! }]);
  (r as any).meetingPrepSkill.currentBrief.generatedAt = Date.now() + 1;
  r.activate(voice);
  expect((r as any).resolveMeetingKnowledgeDirs()).toEqual([projDirs[1]!]);
  r.deactivate();
});

test("malformed folderPaths entries never throw", () => {
  const brief = makeBrief([
    { path: "" },
    { path: "   " },
    null as any,
    { path: 42 as any },
  ]);
  const r = makeRetriever(brief);
  expect((r as any).resolveMeetingKnowledgeDirs()).toEqual([]);
});

// ══════════════ FINDING 4: over-broad adoption + dot-file reads ══════════════

test("bare '~' and $HOME-resolving paths are rejected; a '~' subdir is still adopted", () => {
  const savedHome = process.env.HOME;
  process.env.HOME = root; // $HOME === root for this test
  try {
    const brief = makeBrief([
      { path: "~" },                                    // bare tilde → resolves to $HOME → rejected
      { path: root },                                    // literal $HOME path → rejected
      { path: join(root, "..") },                        // ancestor of $HOME → rejected
      { path: `~/${projDirs[0]!.split("/").pop()}` },    // ~/proj-a → allowed (descendant of $HOME)
    ]);
    const r = makeRetriever(brief);
    const dirs: string[] = (r as any).resolveMeetingKnowledgeDirs();
    expect(dirs).toEqual([projDirs[0]!]);
  } finally {
    process.env.HOME = savedHome;
  }
});

test("an absolute path equal to $HOME (no tilde involved) is also rejected", () => {
  const savedHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const brief = makeBrief([{ path: `${root}/` }]); // trailing slash, same dir as $HOME
    const r = makeRetriever(brief);
    expect((r as any).resolveMeetingKnowledgeDirs()).toEqual([]);
  } finally {
    process.env.HOME = savedHome;
  }
});

test("read_file rejects a dot-file segment under an adopted root; a normal file still reads", async () => {
  const savedHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const brief = makeBrief([{ path: projDirs[0]! }]);
    const r = makeRetriever(brief);

    const dotRead = await (r as any).executeTool("read_file", { path: "proj-a/.env" });
    expect(dotRead).toContain("File not found");
    expect(dotRead).not.toContain("needle-dotfile-proj-a");

    const normalRead = await (r as any).executeTool("read_file", { path: "proj-a/docs/spec.md" });
    expect(normalRead).toContain("needle-proj-a");
  } finally {
    process.env.HOME = savedHome;
  }
});

test("read_file dot-segment rejection also applies to built-in roots (workspace)", async () => {
  const r = makeRetriever();
  const dotRead = await (r as any).executeTool("read_file", { path: ".secret-ws.md" });
  expect(dotRead).toContain("File not found");
  expect(dotRead).not.toContain("needle-dotfile-workspace");

  // Sanity: a normal top-level workspace file is unaffected
  const normalRead = await (r as any).executeTool("read_file", { path: "MEMORY.md" });
  expect(normalRead).toContain("needle-top");
});

test("adopted dirs with colliding basenames get deduped labels (suffix -2)", async () => {
  const collA = join(root, "coll-a", "shared-name");
  const collB = join(root, "coll-b", "shared-name");
  mkdirSync(collA, { recursive: true });
  mkdirSync(collB, { recursive: true });
  writeFileSync(join(collA, "spec.md"), "needle-coll-a\n");
  writeFileSync(join(collB, "spec.md"), "needle-coll-b\n");

  const brief = makeBrief([{ path: collA }, { path: collB }]);
  const r = makeRetriever(brief);

  const roots: any[] = (r as any).getSearchRoots();
  const labelA = roots.find((x) => x.dir === collA)?.label;
  const labelB = roots.find((x) => x.dir === collB)?.label;
  expect(labelA).toBe("shared-name");
  expect(labelB).toBe("shared-name-2");

  // Both remain independently searchable + readable despite the collision
  expect(await (r as any).executeTool("search_files", { query: "needle-coll-a" })).toContain("shared-name/spec.md");
  expect(await (r as any).executeTool("search_files", { query: "needle-coll-b" })).toContain("shared-name-2/spec.md");
  expect(await (r as any).executeTool("read_file", { path: "shared-name/spec.md" })).toContain("needle-coll-a");
  expect(await (r as any).executeTool("read_file", { path: "shared-name-2/spec.md" })).toContain("needle-coll-b");
});

test("adopted dir literally named 'shared' doesn't shadow the built-in shared root", async () => {
  const dirNamedShared = join(root, "collides-with-builtin", "shared");
  mkdirSync(dirNamedShared, { recursive: true });
  writeFileSync(join(dirNamedShared, "note.md"), "needle-builtin-collision\n");

  const brief = makeBrief([{ path: dirNamedShared }]);
  const r = makeRetriever(brief);

  const roots: any[] = (r as any).getSearchRoots();
  const adopted = roots.find((x) => x.dir === dirNamedShared);
  expect(adopted?.label).toBe("shared-2");

  const out = await (r as any).executeTool("search_files", { query: "needle-builtin-collision" });
  expect(out).toContain("shared-2/note.md");

  // The real shared/ root is untouched and still resolves under its own label
  const sharedOut = await (r as any).executeTool("search_files", { query: "needle-in-notes" });
  expect(sharedOut).toContain("shared/notes/note-a.md");
});
