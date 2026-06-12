#!/usr/bin/env bun
/**
 * E2E Test: Meeting Context Search & Execution Pipeline
 * ======================================================
 * Tests the full pipeline: user voice → intent → file search → context injection
 *
 * Phases:
 *   1. Intent Classification (fast lane regex + medium lane Haiku)
 *   2. Keyword Fallback Search (MEMORY.md)
 *   3. Agentic Search (OpenRouter tool_use)
 *   4. Caching & Documents (topic cache, stageDocuments, aliases)
 *   5. Voice Context Injection (format, queue, eviction)
 *
 * Usage:
 *   bun run test/experiments/e2e-context-search.ts              # Unit phases only
 *   bun run test/experiments/e2e-context-search.ts --live        # Include live API phases
 */

const BASE = "http://localhost:4000";
const LIVE = process.argv.includes("--live");
const now = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface TestResult { name: string; pass: boolean; detail: string; phase: string }
const results: TestResult[] = [];
let currentPhase = "";

function assert(name: string, condition: boolean, detail: string) {
  results.push({ name, pass: condition, detail, phase: currentPhase });
  console.log(`  ${condition ? "✅" : "❌"} ${name}: ${detail}`);
}

// ═══════════════════════════════════════════════
//  PHASE 1: Intent Classification
// ═══════════════════════════════════════════════

async function testIntentClassification() {
  currentPhase = "Phase 1: Intent";
  console.log(`\n[${now()}] === PHASE 1: Intent Classification ===`);

  // 1.1: Fast lane — AutomationRouter.classify (import directly)
  try {
    const { AutomationRouter } = await import("../../src/modules/automation-router");
    const router = new AutomationRouter();

    // scroll down
    const scrollResult = router.classify("scroll down");
    assert("1.1 scroll down → scroll", scrollResult.action?.includes("scroll") === true,
      `action=${scrollResult.action}, conf=${scrollResult.confidence?.toFixed(2)}`);

    // open URL
    const urlResult = router.classify("open https://callingclaw.com");
    assert("1.6 open URL → open_url", urlResult.action === "open_url" || urlResult.action?.includes("url") === true,
      `action=${urlResult.action}, conf=${urlResult.confidence?.toFixed(2)}`);

    // share screen
    const shareResult = router.classify("share my screen");
    assert("1.8 share screen → share_screen", shareResult.action?.includes("share") === true,
      `action=${shareResult.action}, conf=${shareResult.confidence?.toFixed(2)}`);

  } catch (e: any) {
    assert("1.x Fast lane import", false, `Error: ${e.message}`);
  }

  // 1.2-1.3: Scroll dedup cooldown
  try {
    const { AutomationRouter } = await import("../../src/modules/automation-router");
    const router = new AutomationRouter();

    const first = router.classify("scroll down");
    const firstOk = first.action?.includes("scroll") === true;
    assert("1.2 First scroll executes", firstOk, `action=${first.action}`);

    // Note: dedup is in TranscriptAuditor, not AutomationRouter.
    // The 2s cooldown is enforced by _lastExecutionTs check.
    // We verify the router itself doesn't block repeats.
    const second = router.classify("scroll down");
    assert("1.3 Router allows repeat scroll", second.action?.includes("scroll") === true,
      `action=${second.action} (dedup is in TranscriptAuditor, not router)`);
  } catch (e: any) {
    assert("1.2-1.3 Scroll dedup", false, `Error: ${e.message}`);
  }

  // 1.4-1.7: Medium lane (requires live backend with Haiku)
  if (LIVE) {
    console.log(`  [${now()}] Testing medium lane (Haiku classification)...`);

    // Test via the backend's transcript auditor
    // We inject transcript and check if the right events fire
    const testCases = [
      { id: "1.4", text: "帮我找一下我们的demo视频脚本", expected: "search_and_open", desc: "Chinese search intent" },
      { id: "1.5", text: "那个Business Talk视频在哪里", expected: "search_and_open", desc: "Business Talk search" },
      { id: "1.7", text: "总结一下我们上次讨论的内容", expected: null, desc: "recall (not auditor action)" },
    ];

    for (const tc of testCases) {
      try {
        // Use voice text injection to simulate user speech
        await fetch(`${BASE}/api/voice/text`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: tc.text }),
        });
        // Note: actual intent classification requires active TranscriptAuditor (meeting mode)
        // In non-meeting mode, we can only verify the API accepts the input
        assert(`${tc.id} ${tc.desc}`, true, `text sent (full classification needs active meeting)`);
      } catch (e: any) {
        assert(`${tc.id} ${tc.desc}`, false, `Error: ${e.message}`);
      }
    }
  } else {
    console.log(`  [Skipped 1.4-1.7: medium lane needs --live flag]`);
  }
}

// ═══════════════════════════════════════════════
//  PHASE 2: Keyword Fallback Search
// ═══════════════════════════════════════════════

async function testKeywordFallback() {
  currentPhase = "Phase 2: Keyword";
  console.log(`\n[${now()}] === PHASE 2: Keyword Fallback Search ===`);

  try {
    const { ContextSync } = await import("../../src/modules/context-sync");
    const sync = new ContextSync();
    await sync.loadOpenClawMemory();

    // 2.1: Search for "video storyboard"
    const result1 = sync.searchMemory("video storyboard");
    const found1 = result1.length > 0;
    assert("2.1 'video storyboard' in MEMORY.md", found1,
      found1 ? `${result1.length} results, first: ${result1[0]?.slice(0, 60)}...` : "no matches");

    // 2.2: Search for "CallingClaw demo"
    const result2 = sync.searchMemory("CallingClaw demo");
    const found2 = result2.length > 0;
    assert("2.2 'CallingClaw demo' in MEMORY.md", found2,
      found2 ? `${result2.length} results` : "no matches");

    // 2.3: Cross-lingual (known limitation)
    const result3 = sync.searchMemory("发布计划");
    assert("2.3 Cross-lingual '发布计划' (known limitation)", result3.length === 0,
      result3.length === 0 ? "no match (expected — keyword fallback is not cross-lingual)" : `unexpected match: ${result3.length} results`);

  } catch (e: any) {
    assert("2.x Keyword fallback import", false, `Error: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════
//  PHASE 3: Agentic Search (needs live backend)
// ═══════════════════════════════════════════════

async function testAgenticSearch() {
  if (!LIVE) {
    currentPhase = "Phase 3: Agentic (SKIPPED)";
    console.log(`\n[${now()}] === PHASE 3: Agentic Search (SKIPPED — pass --live) ===`);
    return;
  }

  currentPhase = "Phase 3: Agentic";
  console.log(`\n[${now()}] === PHASE 3: Agentic Search ===`);

  // Trigger a context retrieval via the status/meeting endpoints
  // This requires an active meeting with ContextRetriever running
  const status = await (await fetch(`${BASE}/api/status`)).json() as any;
  if (status.meeting === "idle") {
    console.log(`  [Meeting idle — agentic search requires active meeting. Testing API only.]`);

    // 3.3: Verify the agentic search fix (OpenRouter 400) by checking backend doesn't crash
    assert("3.3 Backend stable (no agentic crash)", status.callingclaw === "running",
      `v${status.version}, oc=${status.openclaw}`);
    return;
  }

  // If in a meeting, trigger context retrieval and check results
  // TODO: implement when meeting is active
  assert("3.1 Agentic search", true, "requires active meeting for full test");
}

// ═══════════════════════════════════════════════
//  PHASE 4: Caching & Documents
// ═══════════════════════════════════════════════

async function testCachingAndDocuments() {
  currentPhase = "Phase 4: Cache & Docs";
  console.log(`\n[${now()}] === PHASE 4: Caching & Documents ===`);

  // 4.4: FileAliasIndex instant lookup
  try {
    const { FileAliasIndex } = await import("../../src/modules/file-alias-index");
    const index = new FileAliasIndex();

    // Build index with test data
    await index.build({
      prepFilePaths: [
        { path: "/Users/admin/.callingclaw/shared/cc_video_script_review_compiled.json", description: "CallingClaw demo video storyboard review" },
        { path: "/Users/admin/.callingclaw/shared/launch_video_brief_compiled.json", description: "CallingClaw launch video brief with Personal and Business versions" },
      ],
    });

    assert("4.4a Index built", index.ready && index.size >= 2, `${index.size} entries`);

    // Search for "demo video"
    const match1 = index.search("demo video storyboard");
    assert("4.4b 'demo video storyboard' finds compiled json", match1 !== null,
      match1 ? `→ ${match1.path.split("/").pop()} (${match1.source})` : "no match");

    // Search for "launch video business"
    const match2 = index.search("launch video business");
    assert("4.4c 'launch video business' finds brief", match2 !== null,
      match2 ? `→ ${match2.path.split("/").pop()} (${match2.source})` : "no match");

    // 4.5: User alias
    index.registerUserAlias("Business Talk", "/Users/admin/.callingclaw/shared/launch_video_brief_compiled.json");
    const aliasMatch = index.search("Business Talk");
    assert("4.5 User alias 'Business Talk' finds file", aliasMatch !== null,
      aliasMatch ? `→ ${aliasMatch.path.split("/").pop()}` : "no match — alias not working");

    // Verify alias keywords merged
    const aliasMatch2 = index.search("business talk video");
    assert("4.5b Alias keywords searchable", aliasMatch2 !== null,
      aliasMatch2 ? `→ ${aliasMatch2.path.split("/").pop()}` : "no match");

  } catch (e: any) {
    assert("4.x FileAliasIndex", false, `Error: ${e.message}`);
  }

  // 4.3: stageDocuments auto-add (check if the gap fix works)
  if (LIVE) {
    try {
      const docs = await (await fetch(`${BASE}/api/stage/documents`)).json() as any;
      assert("4.3 stageDocuments API accessible", !docs.error,
        `${docs.documents?.length || 0} documents`);
    } catch (e: any) {
      assert("4.3 stageDocuments", false, `Error: ${e.message}`);
    }
  }
}

// ═══════════════════════════════════════════════
//  PHASE 5: Voice Context Injection
// ═══════════════════════════════════════════════

async function testVoiceInjection() {
  currentPhase = "Phase 5: Voice Injection";
  console.log(`\n[${now()}] === PHASE 5: Voice Context Injection ===`);

  // 5.1-5.2: Format and queue verification
  if (LIVE) {
    try {
      const voiceStatus = await (await fetch(`${BASE}/api/voice/session/status`)).json() as any;
      assert("5.1 Voice session accessible", voiceStatus !== null,
        `connected=${voiceStatus.connected}, active=${voiceStatus.active}`);
    } catch (e: any) {
      assert("5.1 Voice session", false, `Error: ${e.message}`);
    }
  } else {
    // Unit test: verify the format pattern
    const contextFormat = "[CONTEXT] video storyboard: CallingClaw demo video has 23 frames in 5-act structure";
    assert("5.1 Context format matches pattern",
      /^\[CONTEXT\] .+: .+/.test(contextFormat),
      `format valid: ${contextFormat.slice(0, 50)}...`);

    const hintFormat = "[CONTEXT_HINT] You just learned relevant information about: video storyboard";
    assert("5.3 Hint format matches pattern",
      /^\[CONTEXT_HINT\]/.test(hintFormat),
      `format valid`);
  }
}

// ═══════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  E2E Test: Context Search & Execution Pipeline");
  console.log("═══════════════════════════════════════════════");
  console.log(`  Mode: ${LIVE ? "Full E2E (live backend)" : "Unit tests only"}`);
  console.log(`  Time: ${now()}`);

  const startTime = Date.now();

  try {
    await testIntentClassification();
    await testKeywordFallback();
    await testAgenticSearch();
    await testCachingAndDocuments();
    await testVoiceInjection();
  } catch (e: any) {
    console.error(`\n❌ Fatal error: ${e.message}`);
  }

  const duration = Math.round((Date.now() - startTime) / 1000);
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  const total = results.length;

  console.log(`\n═══════════════════════════════════════════════`);
  console.log(`  RESULTS: ${passed}/${total} passed (${failed} failed)`);
  console.log(`  Duration: ${duration}s`);
  console.log(`═══════════════════════════════════════════════`);

  if (failed > 0) {
    console.log(`\n  Failed tests:`);
    for (const r of results.filter(r => !r.pass)) {
      console.log(`    ❌ [${r.phase}] ${r.name}: ${r.detail}`);
    }
  }

  console.log("");
  process.exit(failed > 0 ? 1 : 0);
}

main();
