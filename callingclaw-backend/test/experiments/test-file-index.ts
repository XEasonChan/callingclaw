import { FileAliasIndex } from "../../src/modules/file-alias-index.ts";

const index = new FileAliasIndex();

console.log("Building index...");
const buildStart = performance.now();
await index.build({
  // Simulate meeting prep brief with known files
  prepFilePaths: [
    { path: "/Users/admin/Library/Mobile Documents/com~apple~CloudDocs/Tanka/Tanka Link 2.0/Link Action/Action & Permission Phase I/PRD-Action-Permission-Phase1.html", description: "Tanka Action Permission Phase 1 PRD" },
    { path: "/Users/admin/Library/Mobile Documents/com~apple~CloudDocs/Tanka/Tanka Link 2.0/Link Action/Action & Permission Phase I/Phase1-Prototype.html", description: "Phase 1 Prototype" },
    { path: "/Users/admin/Library/Mobile Documents/com~apple~CloudDocs/Tanka/Tanka Link 2.0/Link Action/Action & Permission Phase I/ROADMAP.md", description: "Action Permission Roadmap" },
  ],
});
const buildMs = Math.round(performance.now() - buildStart);
console.log(`Index built: ${index.size} files in ${buildMs}ms\n`);

// Test queries — these simulate voice input
const queries = [
  "Tanka action cart phase one PRD",       // fuzzy: "cart" → "permission", "phase one" → "Phase1"
  "open the PRD",                           // vague but should match
  "action permission phase 1",              // close match
  "phase one prototype",                    // should match prototype
  "roadmap",                                // exact keyword
  "CallingClaw meeting summary",            // should find in shared dir
  "opencli experiment findings",            // should find in docs
  "something totally unrelated xyz",        // should return null
];

console.log("┌────────────────────────────────────────────────────────────────────┐");
console.log("│  FILE ALIAS INDEX — Voice Query → File Match                      │");
console.log("└────────────────────────────────────────────────────────────────────┘\n");

for (const q of queries) {
  const start = performance.now();
  const result = index.search(q);
  const ms = (performance.now() - start).toFixed(1);

  if (result) {
    const shortPath = result.path.replace("/Users/admin/Library/Mobile Documents/com~apple~CloudDocs/", "~/");
    console.log(`  [${ms}ms] "${q}"`);
    console.log(`    → ${result.description} (${result.source})`);
    console.log(`    → ${shortPath}\n`);
  } else {
    console.log(`  [${ms}ms] "${q}" → NO MATCH\n`);
  }
}
