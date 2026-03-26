/**
 * Minimal Audio Injection Test — replaceTrack Approach
 *
 * Purpose: Verify that CallingClaw can inject audio into Google Meet
 * via RTCPeerConnection.replaceTrack().
 *
 * What it does:
 *   1. Opens a Google Meet in Playwright-controlled Chrome
 *   2. Wraps RTCPeerConnection constructor (captures references)
 *   3. Sets up an AudioContext with a 440Hz sine wave → MediaStreamDestination
 *   4. Joins the meeting
 *   5. Calls replaceTrack() to swap Meet's mic with the sine wave
 *   6. Polls to confirm injection is active
 *
 * How to verify:
 *   - Join the SAME meeting URL from your phone or another browser
 *   - You should hear a continuous 440Hz tone (musical note A4)
 *   - If you hear it, the audio injection pipeline works end-to-end
 *
 * Usage:
 *   MEET_URL=https://meet.google.com/xxx-xxx-xxx bun run test/test-audio-inject-minimal.ts
 */

import { PlaywrightCLIClient } from "../callingclaw-backend/src/mcp_client/playwright-cli";

const MEET_URL = process.env.MEET_URL;
if (!MEET_URL) {
  console.error("Usage: MEET_URL=https://meet.google.com/xxx-xxx-xxx bun run test/test-audio-inject-minimal.ts");
  process.exit(1);
}

const cli = new PlaywrightCLIClient();
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  CallingClaw — Minimal Audio Injection Test");
  console.log("═══════════════════════════════════════════════");
  console.log(`  Meet URL: ${MEET_URL}`);
  console.log("  Test: Inject 440Hz sine wave via replaceTrack()");
  console.log("  Verify: Join same meeting from phone → hear tone");
  console.log("═══════════════════════════════════════════════\n");

  // ── Step 1: Start browser ──
  console.log("[1/6] Starting Playwright Chrome...");
  await cli.start();

  // ── Step 2: Navigate to Meet ──
  console.log("[2/6] Navigating to Meet...");
  await cli.navigate(MEET_URL);
  await wait(3000); // Let Meet load

  // ── Step 3: Wrap RTCPeerConnection + setup audio ──
  console.log("[3/6] Wrapping RTCPeerConnection + setting up sine wave...");
  const setupResult = await cli.evaluate(`() => {
    // ── Wrap RTCPeerConnection constructor ──
    const OrigPC = window.RTCPeerConnection;
    window.__ccPCs = [];
    window.RTCPeerConnection = function() {
      const pc = new (Function.prototype.bind.apply(OrigPC, [null].concat(Array.prototype.slice.call(arguments))))();
      window.__ccPCs.push(pc);
      console.log('[CC-Test] PeerConnection created (' + window.__ccPCs.length + ' total)');
      return pc;
    };
    window.RTCPeerConnection.prototype = OrigPC.prototype;
    if (window.webkitRTCPeerConnection) {
      window.webkitRTCPeerConnection = window.RTCPeerConnection;
    }

    // ── Set up 440Hz sine wave → MediaStreamDestination ──
    const ctx = new AudioContext({ sampleRate: 48000 });
    const osc = ctx.createOscillator();
    osc.frequency.value = 440; // A4 note
    osc.type = 'sine';
    const gain = ctx.createGain();
    gain.gain.value = 0.3; // Not too loud
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gain);
    gain.connect(dest);
    osc.start();

    window.__ccTestTrack = dest.stream.getAudioTracks()[0];
    window.__ccTestCtx = ctx;

    return JSON.stringify({
      ok: true,
      audioCtxState: ctx.state,
      trackState: window.__ccTestTrack.readyState,
      pcsBeforeJoin: window.__ccPCs.length,
    });
  }`);
  console.log("  Setup:", setupResult);

  // ── Step 4: Join the meeting ──
  console.log("[4/6] Joining meeting (dismiss dialogs, click join)...");
  const joinResult = await cli.evaluate(`() => {
    const R = { actions: [] };

    // Dismiss dialogs
    const dismiss = ['got it', 'dismiss', 'continue without', 'not now', 'block', 'deny'];
    document.querySelectorAll('button, [role="button"]').forEach(b => {
      const t = (b.textContent || '').trim().toLowerCase();
      if (dismiss.some(d => t === d || t.includes(d))) { b.click(); R.actions.push('dismissed:' + t); }
    });

    // Turn off camera
    const camOff = document.querySelector('[aria-label="Turn off camera"], [aria-label="关闭摄像头"]');
    if (camOff) { camOff.click(); R.actions.push('cam:off'); }

    // Ensure mic is on (we'll replace the track anyway)
    const micOn = document.querySelector('[aria-label="Turn on microphone"], [aria-label="打开麦克风"]');
    if (micOn) { micOn.click(); R.actions.push('mic:on'); }

    // Click join
    const btns = [...document.querySelectorAll('button')];
    const joinTargets = ['Join now', 'Ask to join', 'Join', '加入会议', '请求加入'];
    for (const b of btns) {
      if (joinTargets.includes(b.textContent.trim())) {
        b.click();
        R.actions.push('joined:' + b.textContent.trim());
        break;
      }
    }

    return JSON.stringify(R);
  }`);
  console.log("  Join:", joinResult);

  // Wait for join to complete
  console.log("  Waiting for join to complete...");
  await wait(5000);

  // ── Step 5: replaceTrack ──
  console.log("[5/6] Calling replaceTrack() — injecting sine wave...");

  // Retry replaceTrack a few times (PeerConnection may take a moment)
  let injected = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await cli.evaluate(`() => {
      const pcs = window.__ccPCs || [];
      const track = window.__ccTestTrack;
      if (!track) return JSON.stringify({ error: 'no test track' });
      if (pcs.length === 0) return JSON.stringify({ error: 'no PeerConnections yet', attempt: ${attempt} });

      let replaced = 0;
      for (const pc of pcs) {
        if (pc.connectionState === 'closed') continue;
        const senders = pc.getSenders();
        for (const s of senders) {
          if (s.track && s.track.kind === 'audio' && s.track !== track) {
            s.replaceTrack(track);
            replaced++;
          }
        }
      }

      return JSON.stringify({
        pcs: pcs.length,
        replaced: replaced,
        attempt: ${attempt},
      });
    }`);

    console.log(`  Attempt ${attempt + 1}:`, result);

    try {
      const parsed = JSON.parse(result);
      if (parsed.replaced && parsed.replaced > 0) {
        injected = true;
        break;
      }
    } catch {}

    await wait(2000);
  }

  // ── Step 6: Status report ──
  console.log("\n═══════════════════════════════════════════════");
  if (injected) {
    console.log("  ✅ SINE WAVE INJECTED SUCCESSFULLY!");
    console.log("");
    console.log("  → Join this meeting from your phone now");
    console.log("  → You should hear a 440Hz tone (note A4)");
    console.log("  → If you hear it: audio injection works!");
    console.log("");
    console.log("  Press Ctrl+C to end the test.");
  } else {
    console.log("  ❌ INJECTION FAILED");
    console.log("  PeerConnection may not have audio sender yet.");
    console.log("  Check if you're actually in the meeting.");
  }
  console.log("═══════════════════════════════════════════════");

  // Keep alive so the meeting stays open
  if (injected) {
    // Poll status every 10s
    while (true) {
      await wait(10000);
      const status = await cli.evaluate(`() => {
        const pcs = (window.__ccPCs || []).filter(p => p.connectionState !== 'closed');
        const track = window.__ccTestTrack;
        return JSON.stringify({
          activePCs: pcs.length,
          trackState: track ? track.readyState : 'none',
          audioCtxState: window.__ccTestCtx ? window.__ccTestCtx.state : 'none',
        });
      }`);
      console.log("[Status]", status);
    }
  }
}

main().catch(e => {
  console.error("Test failed:", e.message);
  process.exit(1);
});
