#!/usr/bin/env bun
// ═══════════════════════════════════════════════════════════════
// Test: Playwright CLI — Join Google Meet + Switch Audio to BlackHole
// ═══════════════════════════════════════════════════════════════
//
// Usage:
//   bun run test-meet-join.ts <meet-url>
//   bun run test-meet-join.ts https://meet.google.com/abc-defg-hij
//
// Prerequisites:
//   bun add @playwright/cli
//   BlackHole 2ch / 16ch installed on macOS

const MEET_URL = process.argv[2] || "https://meet.google.com/landing";
const SESSION = "test-meet";
const CLI = "playwright-cli";

// ── Helpers ──────────────────────────────────────────────────

async function run(cmd: string): Promise<string> {
  const full = `${CLI} -s=${SESSION} ${cmd}`;
  console.log(`  ▸ ${full}`);
  const start = performance.now();
  try {
    const result = await Bun.$`${{ raw: full }}`.quiet().text();
    const ms = Math.round(performance.now() - start);
    const trimmed = result.trim();
    if (trimmed) console.log(`    ✓ (${ms}ms) ${trimmed.slice(0, 200)}`);
    else console.log(`    ✓ (${ms}ms)`);
    return trimmed;
  } catch (e: any) {
    const ms = Math.round(performance.now() - start);
    const msg = e.stderr?.toString?.()?.trim() || e.message;
    console.log(`    ✗ (${ms}ms) ${msg.slice(0, 200)}`);
    throw e;
  }
}

async function snapshot(): Promise<string> {
  return run("snapshot");
}

/** Find a ref by matching text in the snapshot output */
function findRef(snap: string, pattern: RegExp): string | null {
  // Playwright CLI snapshot format: ref="e1" or [ref=e1] or similar
  const lines = snap.split("\n");
  for (const line of lines) {
    if (pattern.test(line)) {
      // Extract ref from the line — formats like: [ref=e5], ref="e5"
      const refMatch = line.match(/\bref[=:]"?(\w+)"?/i) || line.match(/\[(\w+)\]/);
      if (refMatch) return refMatch[1];
    }
  }
  return null;
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Main Test Flow ───────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  Playwright CLI — Meet Join + BlackHole Test     ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`\nMeet URL: ${MEET_URL}\n`);

  // Step 1: Open browser in headed mode with persistent profile
  console.log("── Step 1: Launch headed browser ──");
  await run(`open ${MEET_URL} --headed --persistent`);
  console.log("  ⏳ Waiting for Meet page to load...");
  await sleep(5000);

  // Step 2: Take snapshot to see current state
  console.log("\n── Step 2: Snapshot — see what's on screen ──");
  let snap = await snapshot();
  console.log("\n  📋 Full snapshot:\n");
  console.log(snap);

  // Step 3: Look for settings/audio button before joining
  console.log("\n── Step 3: Look for audio settings ──");
  // In Meet's pre-join screen, there's usually a "More options" or settings icon
  // and microphone/speaker dropdowns
  await sleep(2000);
  snap = await snapshot();

  // Try to find and click the microphone button/dropdown
  // Meet pre-join screen has buttons for mic and camera
  const micRef = findRef(snap, /micro|麦克风|mic/i);
  if (micRef) {
    console.log(`  🎤 Found mic element: ${micRef}`);
    await run(`click ${micRef}`);
    await sleep(1000);
    snap = await snapshot();
    console.log("\n  📋 After mic click:\n");
    console.log(snap);

    // Look for BlackHole in the dropdown
    const bhRef = findRef(snap, /blackhole/i);
    if (bhRef) {
      console.log(`  🔊 Found BlackHole: ${bhRef}`);
      await run(`click ${bhRef}`);
    } else {
      console.log("  ⚠️  BlackHole not found in mic dropdown");
    }
  } else {
    console.log("  ⚠️  Mic button not found, trying settings button...");

    // Try "More options" / settings gear
    const settingsRef = findRef(snap, /setting|more.*option|gear|设置/i);
    if (settingsRef) {
      console.log(`  ⚙️  Found settings: ${settingsRef}`);
      await run(`click ${settingsRef}`);
      await sleep(2000);
      snap = await snapshot();
      console.log("\n  📋 Settings panel:\n");
      console.log(snap);
    }
  }

  // Step 4: Try to find and switch speaker to BlackHole
  console.log("\n── Step 4: Switch speaker to BlackHole ──");
  snap = await snapshot();
  const speakerRef = findRef(snap, /speaker|扬声器|audio.*output/i);
  if (speakerRef) {
    console.log(`  🔈 Found speaker element: ${speakerRef}`);
    await run(`click ${speakerRef}`);
    await sleep(1000);
    snap = await snapshot();

    const bhSpeakerRef = findRef(snap, /blackhole/i);
    if (bhSpeakerRef) {
      console.log(`  🔊 Found BlackHole speaker: ${bhSpeakerRef}`);
      await run(`click ${bhSpeakerRef}`);
    } else {
      console.log("  ⚠️  BlackHole not found in speaker dropdown");
    }
  } else {
    console.log("  ⚠️  Speaker dropdown not found in current view");
  }

  // Step 5: Find and click "Join now" / "Ask to join"
  console.log("\n── Step 5: Join the meeting ──");
  await sleep(1000);
  snap = await snapshot();
  const joinRef = findRef(snap, /join|加入|ask to join|参加/i);
  if (joinRef) {
    console.log(`  🚀 Found join button: ${joinRef}`);
    await run(`click ${joinRef}`);
    console.log("  ✅ Clicked Join!");
  } else {
    console.log("  ⚠️  Join button not found. Full snapshot:");
    console.log(snap);
  }

  // Step 6: Wait and take final snapshot
  console.log("\n── Step 6: Final state ──");
  await sleep(5000);
  snap = await snapshot();
  console.log("\n  📋 Final snapshot:\n");
  console.log(snap);

  console.log("\n══════════════════════════════════════════════════");
  console.log("  Test complete. Browser left open for inspection.");
  console.log("  To close: playwright-cli -s=test-meet close");
  console.log("══════════════════════════════════════════════════\n");
}

main().catch((e) => {
  console.error("\n❌ Test failed:", e.message);
  process.exit(1);
});
