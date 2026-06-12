#!/usr/bin/env bun
/**
 * E2E Test: "Website Launch & GitHub Promotion Timeline" Meeting
 * ==============================================================
 * Tests the full meeting lifecycle with screen share, stage, and presentation:
 *   Phase 1: Status Check — backend, OpenClaw, meeting idle
 *   Phase 2: Prep Generation — topic, content quality, no contamination
 *   Phase 3: Join Meeting + Voice — session, transport, duplicate guard
 *   Phase 4: Screen Share + Stage — share API, stage generation, iframe
 *   Phase 5: Presentation Engine — prepare, poll, plan quality
 *   Phase 6: Screen Scroll + Interact — scroll API, iframe targeting
 *   Phase 7: Leave + Cleanup — voice cleared, meeting idle
 *
 * Usage:
 *   bun run test/experiments/e2e-website-launch-meeting.ts
 *   bun run test/experiments/e2e-website-launch-meeting.ts --prep-only
 *   bun run test/experiments/e2e-website-launch-meeting.ts --with-present   # Include presentation engine
 *   bun run test/experiments/e2e-website-launch-meeting.ts <meet-url>       # Full E2E with Google Meet
 */

const BASE = "http://localhost:4000";
const TOPIC = `Website Launch & GitHub Promotion Timeline — ${new Date().toISOString().slice(0, 16)}`;
const MEET_URL = process.argv.find(a => a.startsWith("https://")) || null;
const PREP_ONLY = process.argv.includes("--prep-only");
const WITH_PRESENT = process.argv.includes("--with-present");

const now = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function api(method: string, path: string, body?: any) {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path}`, opts);
  return r.json();
}

// ═══════════════════════════════════════════════
//  TEST ASSERTIONS + BUG TRACKING
// ═══════════════════════════════════════════════

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
  phase: string;
  severity?: "P0" | "P1" | "P2";
}

const results: TestResult[] = [];
const bugs: Array<{ phase: string; name: string; detail: string; severity: string }> = [];
let currentPhase = "";

function assert(name: string, condition: boolean, detail: string, severity?: "P0" | "P1" | "P2") {
  results.push({ name, pass: condition, detail, phase: currentPhase, severity });
  const icon = condition ? "✅" : "❌";
  console.log(`  ${icon} ${name}: ${detail}`);
  if (!condition && severity) {
    bugs.push({ phase: currentPhase, name, detail, severity });
  }
}

// ═══════════════════════════════════════════════
//  PHASE 1: STATUS CHECK
// ═══════════════════════════════════════════════

async function checkStatus() {
  currentPhase = "Phase 1: Status";
  console.log(`\n[${now()}] === PHASE 1: Status Check ===`);
  const status = await api("GET", "/api/status");

  assert("Backend running", status.callingclaw === "running", `v${status.version}`);
  assert("Meeting idle", status.meeting === "idle", `meeting=${status.meeting}`);

  const hasAgent = status.openclaw === "connected";
  assert("Agent available", hasAgent, `openclaw=${status.openclaw}`, "P0");

  // Verify automation capabilities
  assert("ComputerUse available", status.automation?.computer_use?.available === true,
    status.automation?.computer_use?.detail || "missing");

  return status;
}

// ═══════════════════════════════════════════════
//  PHASE 2: PREP GENERATION (with content validation)
// ═══════════════════════════════════════════════

async function testPrepGeneration() {
  currentPhase = "Phase 2: Prep";
  console.log(`\n[${now()}] === PHASE 2: Meeting Prep Generation ===`);
  console.log(`  Topic: "${TOPIC}"`);

  const prepResult = await api("POST", "/api/meeting/prepare", {
    topic: TOPIC,
    instructions: "Focus on: website redesign timeline, GitHub repo promotion strategy, launch date, and action items for each team member.",
  });

  console.log(`  [${now()}] Prep response:`, JSON.stringify(prepResult).slice(0, 200));

  const meetingId = prepResult.meetingId;
  assert("Prep triggered", !!meetingId, `meetingId=${meetingId}`, "P0");
  assert("Topic preserved", prepResult.topic === TOPIC || prepResult.meetingTopic === TOPIC,
    `topic=${prepResult.topic || prepResult.meetingTopic || "MISSING"}`);

  if (!meetingId) return null;

  // Wait for prep to complete (poll status)
  console.log(`  [${now()}] Waiting for prep to complete...`);
  let prepReady = false;
  let prepFilePath: string | null = null;
  for (let i = 0; i < 150; i++) { // 150 x 2s = 300s / 5min (Opus deep research + script generation)
    await sleep(2000);
    try {
      const sessions = await api("GET", "/api/shared/manifest");
      const session = sessions?.sessions?.find((s: any) => s.meetingId === meetingId);
      if (session?.files?.prep) {
        prepReady = true;
        prepFilePath = session.files.prep;
        console.log(`  [${now()}] Prep file ready: ${session.files.prep}`);
        break;
      }
      if (i % 5 === 4) {
        console.log(`  [${now()}] Still waiting... (${i * 2}s)`);
      }
    } catch {}
  }

  assert("Prep file created", prepReady, prepReady ? `file=${prepFilePath}` : "TIMEOUT after 5min", "P0");

  // ── Content quality validation (BUG-010 fix) ──
  // Don't just check file existence — validate the content is real
  if (prepFilePath) {
    try {
      const homeDir = process.env.HOME || "/Users/admin";
      const fullPath = `${homeDir}/.callingclaw/shared/${prepFilePath}`;
      const fileResp = await api("GET", `/api/file/read?path=${encodeURIComponent(fullPath)}`);
      const content = fileResp?.content || "";

      const hasError = content.includes("error:") || content.includes("Error:");
      assert("Prep content has no errors", !hasError,
        hasError ? `BROKEN: "${content.match(/.*[Ee]rror.*$/m)?.[0]?.trim()}"` : "clean",
        "P0");

      const hasSubstance = content.length > 200 && !content.includes("missing scope");
      assert("Prep content has substance", hasSubstance,
        `${content.length} chars, ${hasError ? "contains error" : "looks valid"}`,
        "P0");

      // Check for contamination
      const isContaminated = content.includes("视频") || content.includes("分镜") || content.includes("scenario-eval");
      assert("No test data contamination", !isContaminated,
        isContaminated ? "CONTAMINATED" : "clean");
    } catch (e: any) {
      assert("Prep file readable", false, `Error: ${e.message}`, "P1");
    }
  }

  // ── Verify prep-brief API shape ──
  try {
    const brief = await api("GET", `/api/meeting/prep-brief?meetingId=${meetingId}`);
    const hasVoiceBrief = !!brief?.voiceBrief && brief.voiceBriefChars > 0;
    assert("Prep-brief API returns voiceBrief", hasVoiceBrief,
      `voiceBriefChars=${brief?.voiceBriefChars || 0}`);
    // Note: API returns {workspace, voiceBrief, computerBrief, ...}, NOT {brief: {keyPoints}}
  } catch {}

  return meetingId;
}

// ═══════════════════════════════════════════════
//  PHASE 3: JOIN MEETING (requires Meet URL)
// ═══════════════════════════════════════════════

async function testJoinMeeting(meetingId: string | null) {
  if (!MEET_URL) {
    currentPhase = "Phase 3: Join (SKIPPED)";
    console.log(`\n[${now()}] === PHASE 3: Join Meeting (SKIPPED — no Meet URL) ===`);
    console.log(`  Pass a Meet URL to test: bun run test/experiments/e2e-website-launch-meeting.ts https://meet.google.com/xxx`);
    return null;
  }

  currentPhase = "Phase 3: Join";
  console.log(`\n[${now()}] === PHASE 3: Join Meeting ===`);
  console.log(`  URL: ${MEET_URL}`);
  console.log(`  Topic: "${TOPIC}"`);

  const joinResult = await api("POST", "/api/meeting/join", {
    url: MEET_URL,
    topic: TOPIC,
    provider: "openai",
  });

  console.log(`  [${now()}] Join response:`, JSON.stringify(joinResult).slice(0, 300));

  assert("Join succeeded", joinResult.success === true, `status=${joinResult.status}`, "P0");
  assert("Meeting ID assigned", !!joinResult.meetingId, `meetingId=${joinResult.meetingId}`);

  // Check voice session state
  await sleep(3000);
  try {
    const voiceStatus = await api("GET", "/api/voice/session/status");
    assert("Voice session active", voiceStatus?.active === true,
      `active=${voiceStatus?.active}, transport=${voiceStatus?.transport}`, "P0");
    assert("Transport = meet_bridge", voiceStatus?.transport === "meet_bridge",
      `transport=${voiceStatus?.transport}`);
    assert("Mode = meeting", voiceStatus?.mode === "meeting",
      `mode=${voiceStatus?.mode}`);
    assert("Topic in voice state", voiceStatus?.topic?.includes("Website") || voiceStatus?.topic?.includes("Launch"),
      `topic="${voiceStatus?.topic}"`);
  } catch (e: any) {
    assert("Voice session status", false, `Error: ${e.message}`, "P0");
  }

  // Test duplicate join guard
  console.log(`  [${now()}] Testing duplicate join guard...`);
  const dupeResult = await api("POST", "/api/meeting/join", { url: MEET_URL, topic: TOPIC });
  assert("Duplicate join blocked", dupeResult.status === "already_joined",
    `status=${dupeResult.status}`);

  // Wait for meeting stabilization
  console.log(`  [${now()}] In meeting for 10s...`);
  await sleep(10000);

  // Test voice interaction
  console.log(`  [${now()}] Testing voice interaction...`);
  await api("POST", "/api/voice/text", {
    text: "Let's discuss the website launch timeline. We have three tracks: the redesigned homepage, the GitHub repo promotion, and the Product Hunt launch.",
  });
  await sleep(5000);

  // Check transcript
  const transcript = await api("GET", "/api/meeting/transcript?count=5");
  const hasTranscript = Array.isArray(transcript) && transcript.length > 0;
  assert("Transcript captured", hasTranscript, `${transcript?.length || 0} entries`);

  return joinResult.meetingId;
}

// ═══════════════════════════════════════════════
//  PHASE 4: SCREEN SHARE + STAGE (requires Meet)
// ═══════════════════════════════════════════════

async function testScreenShareAndStage() {
  if (!MEET_URL) {
    currentPhase = "Phase 4: Screen (SKIPPED)";
    console.log(`\n[${now()}] === PHASE 4: Screen Share + Stage (SKIPPED — no Meet URL) ===`);
    return;
  }

  currentPhase = "Phase 4: Screen Share";
  console.log(`\n[${now()}] === PHASE 4: Screen Share + Stage ===`);

  // 4a: Check that ChromeLauncher is active (from join)
  const status = await api("GET", "/api/status");
  assert("ChromeLauncher active (from join)", status.meeting !== "idle",
    `meeting=${status.meeting}`, "P0");

  // 4b: Share screen with a known URL
  const testUrl = `${BASE}/stage.html`;
  console.log(`  [${now()}] Sharing screen: ${testUrl}`);
  const shareResult = await api("POST", "/api/screen/share", { url: testUrl });
  console.log(`  [${now()}] Share response:`, JSON.stringify(shareResult).slice(0, 200));
  assert("Screen share succeeded", shareResult.success === true,
    shareResult.message || shareResult.error || "unknown", "P0");

  if (shareResult.success) {
    await sleep(2000);

    // 4c: Verify sharing status
    const statusAfterShare = await api("GET", "/api/status");
    assert("Sharing flag active", statusAfterShare.sharing === true,
      `sharing=${statusAfterShare.sharing}`);

    // 4d: Get DOM snapshot of presenting page
    try {
      const snapshot = await api("GET", "/api/screen/snapshot");
      const hasSnapshot = !!snapshot.snapshot && snapshot.snapshot.length > 100;
      assert("DOM snapshot available", hasSnapshot,
        `${snapshot.snapshot?.length || 0} chars`);

      // Check it's actually a Stage page
      const isStage = snapshot.snapshot?.includes("slideFrame") || snapshot.snapshot?.includes("stage");
      assert("Presenting page is Stage", isStage,
        isStage ? "contains stage elements" : "NOT a stage page");
    } catch (e: any) {
      assert("DOM snapshot", false, `Error: ${e.message}`, "P1");
    }

    // 4e: Test stage documents API
    try {
      const docs = await api("GET", "/api/stage/documents");
      assert("Stage documents API works", !docs.error,
        `${docs.documents?.length || 0} documents`);
    } catch (e: any) {
      assert("Stage documents API", false, `Error: ${e.message}`, "P2");
    }

    // 4f: Stop sharing
    console.log(`  [${now()}] Stopping screen share...`);
    const stopResult = await api("POST", "/api/screen/stop");
    assert("Screen share stopped", stopResult.success === true || !stopResult.error,
      stopResult.error || "OK");

    await sleep(1500);
    const statusAfterStop = await api("GET", "/api/status");
    assert("Sharing flag cleared", statusAfterStop.sharing === false,
      `sharing=${statusAfterStop.sharing}`);
  }
}

// ═══════════════════════════════════════════════
//  PHASE 5: PRESENTATION ENGINE (prepare + poll)
// ═══════════════════════════════════════════════

async function testPresentationEngine() {
  if (!MEET_URL && !WITH_PRESENT) {
    currentPhase = "Phase 5: Presentation (SKIPPED)";
    console.log(`\n[${now()}] === PHASE 5: Presentation Engine (SKIPPED — pass --with-present or Meet URL) ===`);
    return null;
  }

  currentPhase = "Phase 5: Presentation";
  console.log(`\n[${now()}] === PHASE 5: Presentation Engine ===`);

  // 5a: Prepare a presentation from stage.html (always available, doesn't depend on prep content)
  const presUrl = `${BASE}/stage.html`;
  console.log(`  [${now()}] Preparing presentation: ${presUrl}`);

  const prepResp = await api("POST", "/api/screen/present/prepare", {
    url: presUrl,
    topic: TOPIC,
    context: "Website launch strategy meeting",
  });

  assert("Presentation prep accepted", prepResp.accepted === true,
    `prepId=${prepResp.prepId}`, "P0");

  const prepId = prepResp.prepId;
  if (!prepId) return null;

  // 5b: Poll until ready (max 60s)
  console.log(`  [${now()}] Polling prep status...`);
  let prepData: any = null;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    try {
      const pollResp = await api("GET", `/api/screen/present/prep/${prepId}`);
      if (pollResp.status === "ready") {
        prepData = pollResp;
        console.log(`  [${now()}] Prep ready: ${pollResp.plan?.slides?.length || 0} slides`);
        break;
      }
      if (pollResp.status === "error") {
        assert("Presentation prep succeeded", false,
          `ERROR: ${pollResp.error}`, "P0");
        return null;
      }
      if (i % 3 === 2) {
        console.log(`  [${now()}] Still preparing... (${i * 2}s)`);
      }
    } catch {}
  }

  assert("Presentation prep completed", !!prepData,
    prepData ? `${prepData.plan?.slides?.length} slides` : "TIMEOUT after 60s", "P0");

  if (prepData) {
    // 5c: Validate prep quality
    const plan = prepData.plan;
    const hasSlides = plan?.slides?.length > 0;
    assert("Plan has slides", hasSlides,
      `${plan?.slides?.length || 0} slides`);

    if (hasSlides) {
      // Each slide should have required fields
      const firstSlide = plan.slides[0];
      assert("Slide has sectionTitle", !!firstSlide.sectionTitle,
        `title="${firstSlide.sectionTitle?.slice(0, 40)}"`);
      assert("Slide has talkingPoints", !!firstSlide.talkingPoints,
        `${firstSlide.talkingPoints?.length || 0} chars`);
      assert("Slide has duration", firstSlide.estimatedDurationMs > 0,
        `${firstSlide.estimatedDurationMs}ms`);
    }

    const hasBrief = !!prepData.brief?.goal;
    assert("Brief has goal", hasBrief,
      `goal="${prepData.brief?.goal?.slice(0, 50)}"`);

    const totalDuration = plan?.totalEstimatedMs || 0;
    const durationReasonable = totalDuration > 10000 && totalDuration < 300000; // 10s - 5min
    assert("Duration is reasonable", durationReasonable,
      `${Math.round(totalDuration / 1000)}s`);
  }

  return prepId;
}

// ═══════════════════════════════════════════════
//  PHASE 6: SCREEN SCROLL + INTERACT (requires Meet)
// ═══════════════════════════════════════════════

async function testScrollAndInteract() {
  if (!MEET_URL) {
    currentPhase = "Phase 6: Scroll (SKIPPED)";
    console.log(`\n[${now()}] === PHASE 6: Screen Scroll + Interact (SKIPPED — no Meet URL) ===`);
    return;
  }

  currentPhase = "Phase 6: Scroll";
  console.log(`\n[${now()}] === PHASE 6: Screen Scroll + Interact ===`);

  // Need to be sharing first
  console.log(`  [${now()}] Starting screen share for scroll test...`);
  const shareResult = await api("POST", "/api/screen/share", { url: `${BASE}/stage.html` });
  if (!shareResult.success) {
    assert("Screen share for scroll test", false, `Failed: ${shareResult.error}`, "P1");
    return;
  }
  await sleep(2000);

  // 6a: Scroll down
  const scrollDown = await api("POST", "/api/screen/scroll", { direction: "down", pixels: 300 });
  assert("Scroll down works", scrollDown.success === true,
    scrollDown.result || scrollDown.error || "unknown");

  // 6b: Scroll up
  const scrollUp = await api("POST", "/api/screen/scroll", { direction: "up", pixels: 300 });
  assert("Scroll up works", scrollUp.success === true,
    scrollUp.result || scrollUp.error || "unknown");

  // 6c: Scroll to target (if on a content page)
  const scrollTarget = await api("POST", "/api/screen/scroll", { target: "CallingClaw" });
  assert("Scroll to target works", scrollTarget.success === true,
    scrollTarget.result || scrollTarget.error || "unknown");

  // 6d: Get snapshot after scrolling
  const snapshot = await api("GET", "/api/screen/snapshot");
  assert("Snapshot after scroll", !!snapshot.snapshot,
    `${snapshot.snapshot?.length || 0} chars`);

  // 6e: Stop sharing
  await api("POST", "/api/screen/stop");
  await sleep(1000);
}

// ═══════════════════════════════════════════════
//  PHASE 7: LEAVE & VERIFY CLEANUP
// ═══════════════════════════════════════════════

async function testLeaveMeeting() {
  if (!MEET_URL) {
    currentPhase = "Phase 7: Leave (SKIPPED)";
    console.log(`\n[${now()}] === PHASE 7: Leave Meeting (SKIPPED) ===`);
    return;
  }

  currentPhase = "Phase 7: Leave";
  console.log(`\n[${now()}] === PHASE 7: Leave Meeting ===`);

  const leaveResult = await api("POST", "/api/meeting/leave");
  console.log(`  [${now()}] Leave response:`, JSON.stringify(leaveResult).slice(0, 200));

  assert("Leave succeeded", !leaveResult.error, leaveResult.error || "OK");

  await sleep(3000);

  // Check voice session cleared
  try {
    const voiceStatus = await api("GET", "/api/voice/session/status");
    assert("Voice session cleared", voiceStatus?.active === false,
      `active=${voiceStatus?.active}, transport=${voiceStatus?.transport}`);
  } catch {}

  // Check meeting is idle
  const status = await api("GET", "/api/status");
  assert("Meeting idle after leave", status.meeting === "idle", `meeting=${status.meeting}`);

  // Check sharing stopped
  assert("Sharing stopped after leave", status.sharing === false,
    `sharing=${status.sharing}`);
}

// ═══════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  E2E Test: Website Launch & GitHub Promotion");
  console.log("═══════════════════════════════════════════════");
  const mode = PREP_ONLY ? "Prep only"
    : MEET_URL ? "Full E2E (Meet + Screen + Voice)"
    : WITH_PRESENT ? "Prep + Presentation Engine"
    : "Prep + status (no Meet URL)";
  console.log(`  Mode: ${mode}`);
  console.log(`  Time: ${now()}`);

  const startTime = Date.now();

  try {
    // Phase 1: Status
    await checkStatus();

    // Phase 2: Prep (with content validation)
    const meetingId = await testPrepGeneration();

    if (!PREP_ONLY) {
      // Phase 3: Join Meeting
      await testJoinMeeting(meetingId);

      // Phase 4: Screen Share + Stage
      await testScreenShareAndStage();

      // Phase 5: Presentation Engine
      await testPresentationEngine();

      // Phase 6: Scroll + Interact
      await testScrollAndInteract();

      // Phase 7: Leave + Cleanup
      await testLeaveMeeting();
    }
  } catch (e: any) {
    console.error(`\n❌ Fatal error: ${e.message}`);
    // Try to leave if we're in a meeting
    try { await api("POST", "/api/meeting/leave"); } catch {}
  }

  // ═══════════════════════════════════════════════
  //  RESULTS
  // ═══════════════════════════════════════════════
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
      console.log(`    ❌ [${r.phase}] ${r.name}: ${r.detail}${r.severity ? ` (${r.severity})` : ""}`);
    }
  }

  // ═══════════════════════════════════════════════
  //  BUG REPORT
  // ═══════════════════════════════════════════════
  if (bugs.length > 0) {
    console.log(`\n  ── Bugs Found (${bugs.length}) ──`);
    for (const b of bugs) {
      console.log(`    🐛 [${b.severity}] [${b.phase}] ${b.name}: ${b.detail}`);
    }

    // Save bug report to file
    const reportPath = `${import.meta.dir}/results/e2e-bugs-${new Date().toISOString().slice(0, 10)}.json`;
    try {
      const { mkdirSync, writeFileSync } = require("fs");
      mkdirSync(`${import.meta.dir}/results`, { recursive: true });
      writeFileSync(reportPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        mode,
        duration,
        total, passed, failed,
        bugs,
        results: results.filter(r => !r.pass),
      }, null, 2));
      console.log(`\n  Bug report saved: ${reportPath}`);
    } catch {}
  }

  console.log("");
  process.exit(failed > 0 ? 1 : 0);
}

main();
