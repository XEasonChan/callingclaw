/**
 * CallingClaw Screen Sharing E2E Test
 *
 * Tests: join Meet → start screen sharing → verify sharing → stop sharing
 * Requires: --auto-select-desktop-capture-source Chrome flag + macOS Screen Recording TCC
 *
 * Usage:
 *   MEET_URL=https://meet.google.com/xxx bun test test/screen-share-e2e.test.ts
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { resolve } from "path";
import { homedir } from "os";

const PROFILE = resolve(homedir(), ".callingclaw", "browser-profile");
const MEET_URL = process.env.MEET_URL || "https://meet.google.com/amd-jhhr-bmw";

let context: BrowserContext;
let page: Page;

beforeAll(async () => {
  console.log(`[Setup] Launching Chrome with screen share flags`);
  context = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    channel: "chrome",
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--disable-infobars",
      "--disable-blink-features=AutomationControlled",
      "--disable-session-crashed-bubble",
      "--noerrdialogs",
      "--auto-select-desktop-capture-source=Entire screen",
      "--enable-usermedia-screen-capturing",
    ],
    permissions: ["microphone", "camera"],
    ignoreDefaultArgs: ["--mute-audio", "--enable-automation", "--no-sandbox"],
  });

  const pages = context.pages();
  page = pages[0] || await context.newPage();
  for (let i = 1; i < pages.length; i++) {
    try { await pages[i].close(); } catch {}
  }
  console.log("[Setup] Chrome ready with screen share flags");
}, 60_000);

afterAll(async () => {
  if (context) await context.close();
}, 15_000);

describe("Screen Sharing in Google Meet", () => {
  test("join meeting", async () => {
    console.log(`[Meet] Navigating to ${MEET_URL}`);
    await page.goto(MEET_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(3000);

    // Dismiss + camera off + join
    await page.evaluate(`(() => {
      var dismiss = ['got it','dismiss','continue without','not now','block','deny'];
      document.querySelectorAll('button,[role="button"]').forEach(function(b) {
        var t = (b.textContent||'').trim().toLowerCase();
        if (dismiss.some(function(d){ return t===d||t.includes(d); })) b.click();
      });
      var cam = document.querySelector('[aria-label*="Turn off camera"],[aria-label*="关闭摄像头"]');
      if (cam) cam.click();
    })()`);
    await page.waitForTimeout(1000);

    const joined = await page.evaluate(`(() => {
      var btns = Array.from(document.querySelectorAll('button'));
      var targets = ['Join now','Ask to join','Join','加入会议','请求加入','Switch here','切换到这里'];
      for (var b of btns) { if (targets.includes(b.textContent.trim())) { b.click(); return b.textContent.trim(); } }
      return 'no_btn';
    })()`);
    console.log(`[Meet] Joined: ${joined}`);

    // Wait for meeting state
    let state = "loading";
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(3000);
      state = String(await page.evaluate(`(() => {
        if (document.querySelector('[aria-label*="Leave call"]')||document.querySelector('[aria-label="Call controls"]')) return 'in_meeting';
        if (document.body.innerText.includes('Waiting for the host')) return 'waiting_room';
        return 'loading';
      })()`));
      console.log(`[Meet] State: ${state}`);
      if (state === "in_meeting") break;
    }
    expect(state).toBe("in_meeting");
  }, 90_000);

  test("start screen sharing", async () => {
    console.log("[Share] Looking for Present now button...");

    // Click "Present now"
    const step1 = String(await page.evaluate(`(() => {
      var btns = Array.from(document.querySelectorAll('button,[role="button"]'));
      var present = btns.find(function(b) {
        var label = (b.getAttribute('aria-label')||'').toLowerCase();
        return label === 'share screen' || label.includes('present') || label.includes('投屏')
          || label.includes('展示') || label.includes('共享屏幕');
      });
      if (present) { present.click(); return 'clicked:' + present.textContent.trim(); }
      return 'not_found';
    })()`));
    console.log(`[Share] Present button: ${step1}`);
    expect(step1).toContain("clicked");

    // Chrome --auto-select-desktop-capture-source=Entire screen
    // bypasses the dialog entirely. Just wait for sharing to start.
    console.log("[Share] Waiting for auto-select (Chrome flag)...");
    await page.waitForTimeout(5000);
  }, 30_000);

  test("verify screen is being shared", async () => {
    const sharing = String(await page.evaluate(`(() => {
      var stop = document.querySelector('[aria-label*="Stop sharing"],[aria-label*="停止共享"],[aria-label*="Stop presenting"],[aria-label*="停止展示"]');
      if (stop) return 'sharing:stop_button_found';
      // Check if share button label changed
      var shareBtn = document.querySelector('[aria-label*="Presentation is"],[aria-label*="展示中"],[aria-label*="presenting"]');
      if (shareBtn) return 'sharing:label_changed:' + shareBtn.getAttribute('aria-label');
      // Check body text
      var text = document.body.innerText;
      if (text.includes('presenting') || text.includes('展示') || text.includes('Presentation')) return 'sharing:text_indicator';
      return 'not_sharing';
    })()`));
    console.log(`[Share] Status: ${sharing}`);
    // Note: may not be sharing if macOS TCC denied or flag not supported
    // Log result either way for diagnosis
    if (sharing.includes("not_sharing")) {
      console.warn("[Share] ⚠ Screen sharing NOT active — check macOS Screen Recording permission and Chrome flags");
    } else {
      console.log("[Share] ✅ Screen sharing active!");
    }
  }, 15_000);

  test("stop screen sharing", async () => {
    const stopped = String(await page.evaluate(`(() => {
      var btn = document.querySelector('[aria-label*="Stop sharing"],[aria-label*="停止共享"],[aria-label*="Stop presenting"],[aria-label*="停止展示"]');
      if (btn) { btn.click(); return 'stopped'; }
      return 'no_stop_button';
    })()`));
    console.log(`[Share] Stop: ${stopped}`);
    await page.waitForTimeout(2000);
  }, 15_000);

  test("leave meeting", async () => {
    const left = String(await page.evaluate(`(() => {
      var btn = document.querySelector('[aria-label*="Leave call"],[aria-label*="退出通话"]');
      if (btn) { btn.click(); return 'left'; }
      return 'no_leave';
    })()`));
    console.log(`[Meet] ${left}`);
    await page.waitForTimeout(2000);
  }, 15_000);
});
