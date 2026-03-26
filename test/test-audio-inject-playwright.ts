/**
 * Audio Injection Test — Playwright Library (addInitScript)
 *
 * Uses Playwright's Node.js API (not the CLI) to inject getUserMedia
 * interception BEFORE Meet's JavaScript loads.
 *
 * This solves the core problem: Meet caches getUserMedia at module load time,
 * so runtime patches (eval) never get called. addInitScript runs before any
 * page script, so our patch captures the very first getUserMedia call.
 *
 * Usage:
 *   MEET_URL=https://meet.google.com/xxx-xxx-xxx bun run test/test-audio-inject-playwright.ts
 */

import { chromium } from "../callingclaw-backend/node_modules/playwright-core";
import { resolve } from "path";
import { homedir } from "os";

const MEET_URL = process.env.MEET_URL || "https://meet.google.com/arf-acrx-rag";
const PROFILE_DIR = resolve(homedir(), ".callingclaw", "browser-profile");

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  Audio Injection Test (Playwright addInitScript)");
  console.log("═══════════════════════════════════════════════");
  console.log(`  Meet: ${MEET_URL}`);
  console.log(`  Profile: ${PROFILE_DIR}`);
  console.log("═══════════════════════════════════════════════\n");

  // Launch persistent Chrome context (keeps Google login)
  console.log("[1] Launching Chrome with persistent profile...");
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    channel: "chrome",
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--disable-infobars",
      "--disable-blink-features=AutomationControlled",
    ],
    permissions: ["microphone", "camera"],
    ignoreDefaultArgs: ["--mute-audio", "--enable-automation"],
  });

  // ── THE KEY: addInitScript runs BEFORE any page JavaScript ──
  console.log("[2] Adding init script (getUserMedia + RTCPeerConnection interception)...");
  await context.addInitScript(() => {
    // @ts-ignore — runs in browser context
    console.log("[CC-Init] Patching getUserMedia + RTCPeerConnection BEFORE page JS...");

    // ── Save originals BEFORE Meet can ──
    const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const OrigPC = window.RTCPeerConnection;

    // ── Create 440Hz sine wave as our "virtual mic" ──
    let sineStream: MediaStream | null = null;
    function getSineStream(): MediaStream {
      if (sineStream) return sineStream;
      const ctx = new AudioContext({ sampleRate: 48000 });
      const osc = ctx.createOscillator();
      osc.frequency.value = 440;
      osc.type = "sine";
      const gain = ctx.createGain();
      gain.gain.value = 0.3;
      const dest = ctx.createMediaStreamDestination();
      osc.connect(gain);
      gain.connect(dest);
      osc.start();
      sineStream = dest.stream;
      console.log("[CC-Init] Sine wave ready: 440Hz, 0.3 gain");
      return sineStream;
    }

    // ── Patch getUserMedia ──
    // @ts-ignore
    window.__ccGumCalls = 0;
    navigator.mediaDevices.getUserMedia = async function (constraints?: MediaStreamConstraints) {
      // @ts-ignore
      window.__ccGumCalls++;
      console.log("[CC-Init] getUserMedia #" + (window as any).__ccGumCalls, JSON.stringify(constraints));

      if (constraints?.audio) {
        // Return our sine wave instead of real mic
        const stream = getSineStream().clone();
        console.log("[CC-Init] → Returning 440Hz sine wave!");
        return stream;
      }
      // Pass through non-audio requests (camera)
      return origGUM(constraints!);
    };

    // ── Wrap RTCPeerConnection to track instances ──
    // @ts-ignore
    window.__ccPCs = [];
    // @ts-ignore
    window.RTCPeerConnection = function (this: any, ...args: any[]) {
      const pc = new (OrigPC as any)(...args);
      (window as any).__ccPCs.push(pc);
      console.log("[CC-Init] RTCPeerConnection created! Total:", (window as any).__ccPCs.length);
      return pc;
    } as any;
    (window.RTCPeerConnection as any).prototype = OrigPC.prototype;
    Object.getOwnPropertyNames(OrigPC).forEach((k) => {
      if (k !== "prototype" && k !== "name" && k !== "length") {
        try { (window.RTCPeerConnection as any)[k] = (OrigPC as any)[k]; } catch {}
      }
    });

    // @ts-ignore
    window.__ccInitDone = true;
    console.log("[CC-Init] All patches installed. Meet will get our sine wave.");
  });

  // Navigate to Meet
  console.log("[3] Navigating to Meet...");
  const page = context.pages()[0] || await context.newPage();
  await page.goto(MEET_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);

  // Check if init script ran
  const initCheck = await page.evaluate(() => ({
    initDone: (window as any).__ccInitDone,
    gumCalls: (window as any).__ccGumCalls,
    pcs: ((window as any).__ccPCs || []).length,
  }));
  console.log("[4] Init check:", JSON.stringify(initCheck));

  if (!initCheck.initDone) {
    console.error("❌ Init script did NOT run. Aborting.");
    await context.close();
    return;
  }

  console.log(`   ✅ Init script ran! getUserMedia called ${initCheck.gumCalls} times, ${initCheck.pcs} PeerConnections`);

  // Dismiss dialogs + configure
  console.log("[5] Configuring meeting (camera off, dismiss dialogs)...");
  await page.evaluate(() => {
    // Dismiss blocking dialogs
    document.querySelectorAll('button, [role="button"]').forEach((b) => {
      const t = (b.textContent || "").trim().toLowerCase();
      if (["got it", "dismiss", "not now", "block", "deny"].some((d) => t.includes(d))) {
        (b as HTMLElement).click();
      }
    });
    // Camera off
    const camOff = document.querySelector('[aria-label*="Turn off camera"], [aria-label*="关闭摄像头"]');
    if (camOff) (camOff as HTMLElement).click();
  });
  await page.waitForTimeout(1000);

  // Join meeting
  console.log("[6] Joining meeting...");
  const joined = await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button")];
    for (const b of btns) {
      if (["Join now", "Ask to join", "Join", "加入会议", "请求加入"].includes(b.textContent!.trim())) {
        b.click();
        return "clicked: " + b.textContent!.trim();
      }
    }
    return "no join button";
  });
  console.log("  ", joined);

  // Wait for join
  await page.waitForTimeout(8000);

  // Final status
  const status = await page.evaluate(() => ({
    gumCalls: (window as any).__ccGumCalls,
    pcs: ((window as any).__ccPCs || []).length,
    pcStates: ((window as any).__ccPCs || []).map((p: any) => p.connectionState),
    inMeeting: !!document.querySelector('[aria-label*="Leave call"], [aria-label="Call controls"]'),
  }));
  console.log("\n[7] Final status:", JSON.stringify(status, null, 2));

  console.log("\n══════════════════════════════════════════════");
  if (status.inMeeting && status.gumCalls > 0) {
    console.log("✅ IN MEETING + getUserMedia INTERCEPTED!");
    console.log("");
    console.log("→ 用手机加入: " + MEET_URL);
    console.log("→ 如果听到 440Hz 嗡嗡声 = 音频注入成功！");
    console.log("");
    console.log("Ctrl+C 结束测试");
  } else if (status.inMeeting) {
    console.log("⚠️ In meeting but getUserMedia not intercepted (" + status.gumCalls + " calls)");
  } else {
    console.log("❌ Not in meeting yet. May need to wait or be admitted.");
  }
  console.log("══════════════════════════════════════════════");

  // Keep alive — poll status every 10s
  while (true) {
    await page.waitForTimeout(10000);
    const s = await page.evaluate(() => ({
      gumCalls: (window as any).__ccGumCalls,
      pcs: ((window as any).__ccPCs || []).length,
    }));
    console.log(`[Status] gumCalls=${s.gumCalls}, pcs=${s.pcs}`);
  }
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
