#!/usr/bin/env bun
/**
 * E2E Test: "Website Launch & GitHub Promotion Timeline" Meeting
 * ==============================================================
 * Tests the full meeting lifecycle with the fixes from 2026-04-10:
 *   1. Prep generation with correct topic (not "Meeting")
 *   2. Strict meetingId file matching (no test data contamination)
 *   3. Voice session activation (markVoiceSession bug)
 *   4. Session cleanup
 *
 * Usage:
 *   bun run test/experiments/e2e-website-launch-meeting.ts
 *   bun run test/experiments/e2e-website-launch-meeting.ts --prep-only   # Just test prep generation
 *   bun run test/experiments/e2e-website-launch-meeting.ts <meet-url>    # Use specific Meet URL
 */

const BASE = "http://localhost:4000";
const TOPIC = "Website Launch & GitHub Promotion Timeline";
const MEET_URL = process.argv.find(a => a.startsWith("https://")) || null;
const PREP_ONLY = process.argv.includes("--prep-only");

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
//  TEST ASSERTIONS
// ═══════════════════════════════════════════════

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: TestResult[] = [];

function assert(name: string, condition: boolean, detail: string) {
  results.push({ name, pass: condition, detail });
  const icon = condition ? "✅" : "❌";
  console.log(`  ${icon} ${name}: ${detail}`);
}

// ═══════════════════════════════════════════════
//  PHASE 1: STATUS CHECK
// ═══════════════════════════════════════════════

async function checkStatus() {
  console.log(`\n[${now()}] === PHASE 1: Status Check ===`);
  const status = await api("GET", "/api/status");

  assert("Backend running", status.callingclaw === "running", `v${status.version}`);
  assert("Meeting idle", status.meeting === "idle", `meeting=${status.meeting}`);

  // Check OpenClaw or agent adapter
  const hasAgent = status.openclaw === "connected";
  assert("Agent available", hasAgent, `openclaw=${status.openclaw}`);

  return status;
}

// ═══════════════════════════════════════════════
//  PHASE 2: PREP GENERATION
// ═══════════════════════════════════════════════

async function testPrepGeneration() {
  console.log(`\n[${now()}] === PHASE 2: Meeting Prep Generation ===`);
  console.log(`  Topic: "${TOPIC}"`);

  // Trigger prep via the /api/meeting/prepare endpoint
  const prepResult = await api("POST", "/api/meeting/prepare", {
    topic: TOPIC,
    instructions: "Focus on: website redesign timeline, GitHub repo promotion strategy, launch date, and action items for each team member.",
  });

  console.log(`  [${now()}] Prep response:`, JSON.stringify(prepResult).slice(0, 200));

  const meetingId = prepResult.meetingId;
  assert("Prep triggered", !!meetingId, `meetingId=${meetingId}`);
  assert("Topic preserved", prepResult.topic === TOPIC || prepResult.meetingTopic === TOPIC,
    `topic=${prepResult.topic || prepResult.meetingTopic || "MISSING"}`);

  if (!meetingId) return null;

  // Wait for prep to complete (poll status)
  console.log(`  [${now()}] Waiting for prep to complete...`);
  let prepReady = false;
  for (let i = 0; i < 30; i++) { // 30 x 2s = 60s max wait
    await sleep(2000);
    const status = await api("GET", "/api/status");
    // Check if session has prep file
    try {
      const sessions = await api("GET", "/api/shared/manifest");
      const session = sessions?.sessions?.find((s: any) => s.meetingId === meetingId);
      if (session?.files?.prep) {
        prepReady = true;
        console.log(`  [${now()}] Prep file ready: ${session.files.prep}`);
        break;
      }
      if (i % 5 === 4) {
        console.log(`  [${now()}] Still waiting... (${i * 2}s)`);
      }
    } catch { /* manifest endpoint may not exist */ }

    // Alternative: check via prep-brief endpoint
    try {
      const brief = await api("GET", `/api/meeting/prep-brief?meetingId=${meetingId}`);
      if (brief?.brief?.keyPoints?.length > 0) {
        prepReady = true;
        console.log(`  [${now()}] Prep brief has ${brief.brief.keyPoints.length} key points`);
        break;
      }
    } catch {}
  }

  assert("Prep generated", prepReady, prepReady ? "brief has content" : "TIMEOUT after 60s");

  // Verify no contamination — prep topic should match
  try {
    const brief = await api("GET", `/api/meeting/prep-brief?meetingId=${meetingId}`);
    if (brief?.brief) {
      const briefTopic = brief.brief.topic || "";
      const isContaminated = briefTopic.includes("视频") || briefTopic.includes("分镜") || briefTopic.includes("scenario-eval");
      assert("No test contamination", !isContaminated,
        isContaminated ? `CONTAMINATED: "${briefTopic}"` : `topic="${briefTopic}"`);

      const hasKeyPoints = (brief.brief.keyPoints?.length || 0) > 1;
      assert("Brief has substance", hasKeyPoints,
        `${brief.brief.keyPoints?.length || 0} key points`);
    }
  } catch {}

  return meetingId;
}

// ═══════════════════════════════════════════════
//  PHASE 3: JOIN MEETING (requires Meet URL)
// ═══════════════════════════════════════════════

async function testJoinMeeting(meetingId: string | null) {
  if (!MEET_URL) {
    console.log(`\n[${now()}] === PHASE 3: Join Meeting (SKIPPED — no Meet URL) ===`);
    console.log(`  Pass a Meet URL to test: bun run test/experiments/e2e-website-launch-meeting.ts https://meet.google.com/xxx`);
    return;
  }

  console.log(`\n[${now()}] === PHASE 3: Join Meeting ===`);
  console.log(`  URL: ${MEET_URL}`);
  console.log(`  Topic: "${TOPIC}"`);

  const joinResult = await api("POST", "/api/meeting/join", {
    url: MEET_URL,
    topic: TOPIC,
    provider: "openai",
  });

  console.log(`  [${now()}] Join response:`, JSON.stringify(joinResult).slice(0, 300));

  assert("Join succeeded", joinResult.success === true, `status=${joinResult.status}`);
  assert("Voice connected", joinResult.voice === "connected", `voice=${joinResult.voice}`);
  assert("Meeting ID assigned", !!joinResult.meetingId, `meetingId=${joinResult.meetingId}`);

  // Check voice session state
  await sleep(3000);
  try {
    const voiceStatus = await api("GET", "/api/voice/session/status");
    assert("Voice session active", voiceStatus?.active === true,
      `active=${voiceStatus?.active}, transport=${voiceStatus?.transport}`);
    assert("Transport = meet_bridge", voiceStatus?.transport === "meet_bridge",
      `transport=${voiceStatus?.transport}`);
    assert("Mode = meeting", voiceStatus?.mode === "meeting",
      `mode=${voiceStatus?.mode}`);
    assert("Topic in voice state", voiceStatus?.topic?.includes("Website") || voiceStatus?.topic?.includes("Launch"),
      `topic="${voiceStatus?.topic}"`);
  } catch (e: any) {
    assert("Voice session status", false, `Error: ${e.message}`);
  }

  // Check prep brief was loaded (not contaminated)
  if (joinResult.prepBrief) {
    const isContaminated = joinResult.prepBrief.topic?.includes("视频") || joinResult.prepBrief.topic?.includes("分镜");
    assert("Join prep not contaminated", !isContaminated,
      `prepBrief.topic="${joinResult.prepBrief.topic}"`);
  }

  // Test duplicate join guard
  console.log(`  [${now()}] Testing duplicate join guard...`);
  const dupeResult = await api("POST", "/api/meeting/join", {
    url: MEET_URL,
    topic: TOPIC,
  });
  assert("Duplicate join blocked", dupeResult.status === "already_joined",
    `status=${dupeResult.status}`);

  // Wait 10s for meeting interaction
  console.log(`  [${now()}] In meeting for 10s...`);
  await sleep(10000);

  // Test voice interaction
  console.log(`  [${now()}] Testing voice interaction...`);
  await api("POST", "/api/voice/text", {
    text: `Let's discuss the website launch timeline. We have three tracks: the redesigned homepage, the GitHub repo promotion, and the Product Hunt launch. Can you outline a suggested timeline for each?`,
  });
  await sleep(5000);

  // Check transcript
  const transcript = await api("GET", "/api/meeting/transcript?count=5");
  const hasTranscript = Array.isArray(transcript) && transcript.length > 0;
  assert("Transcript captured", hasTranscript, `${transcript?.length || 0} entries`);

  return joinResult.meetingId;
}

// ═══════════════════════════════════════════════
//  PHASE 4: LEAVE & VERIFY CLEANUP
// ═══════════════════════════════════════════════

async function testLeaveMeeting() {
  if (!MEET_URL) {
    console.log(`\n[${now()}] === PHASE 4: Leave Meeting (SKIPPED) ===`);
    return;
  }

  console.log(`\n[${now()}] === PHASE 4: Leave Meeting ===`);

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
}

// ═══════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  E2E Test: Website Launch & GitHub Promotion");
  console.log("═══════════════════════════════════════════════");
  console.log(`  Mode: ${PREP_ONLY ? "Prep only" : MEET_URL ? "Full E2E" : "Prep + status (no Meet URL)"}`);
  console.log(`  Time: ${now()}`);

  const startTime = Date.now();

  try {
    // Phase 1: Status
    await checkStatus();

    // Phase 2: Prep
    const meetingId = await testPrepGeneration();

    if (!PREP_ONLY) {
      // Phase 3: Join
      await testJoinMeeting(meetingId);

      // Phase 4: Leave
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
      console.log(`    ❌ ${r.name}: ${r.detail}`);
    }
  }

  console.log("");
  process.exit(failed > 0 ? 1 : 0);
}

main();
