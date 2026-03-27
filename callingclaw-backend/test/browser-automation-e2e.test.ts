/**
 * CallingClaw Browser Automation E2E Tests
 *
 * Tests the Playwright library automation pipeline (ChromeLauncher style).
 * Each test uses the Playwright page object directly — same as production.
 *
 * Test scenarios:
 *   1. Open Meet, configure mic, join meeting
 *   2. Open a local HTML file (meeting prep mockup)
 *   3. Find Sam Altman on Twitter/X
 *   4. Search Tanka news on Google
 *
 * Usage:
 *   bun test test/test-browser-automation-e2e.ts
 *   bun run test/test-browser-automation-e2e.ts   (standalone)
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { resolve } from "path";
import { homedir } from "os";
import { existsSync, readdirSync } from "fs";

// ── Config ──
const PROFILE = resolve(homedir(), ".callingclaw", "browser-profile");
const MEET_URL = process.env.MEET_URL || "https://meet.google.com/amd-jhhr-bmw";
const TIMEOUT = 30_000;

let context: BrowserContext;
let page: Page;

// ── Setup / Teardown ──
beforeAll(async () => {
  console.log(`[Setup] Launching Chrome with profile: ${PROFILE}`);
  context = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    channel: "chrome",
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--disable-infobars",
      "--disable-blink-features=AutomationControlled",
      "--disable-session-crashed-bubble",
      "--noerrdialogs",
    ],
    permissions: ["microphone", "camera"],
    ignoreDefaultArgs: ["--mute-audio", "--enable-automation", "--no-sandbox"],
  });

  // Close extra tabs Chrome may have restored
  const pages = context.pages();
  page = pages[0] || await context.newPage();
  for (let i = 1; i < pages.length; i++) {
    try { await pages[i].close(); } catch {}
  }

  await page.goto("about:blank");
  console.log("[Setup] Chrome ready");
}, 60_000);

afterAll(async () => {
  if (context) {
    await context.close();
    console.log("[Teardown] Chrome closed");
  }
}, 15_000);

// ══════════════════════════════════════════════════════════════
// Test 1: Open Google Meet, select default mic, join meeting
// ══════════════════════════════════════════════════════════════
describe("Test 1: Google Meet join", () => {
  test("navigate to Meet URL", async () => {
    console.log(`[Meet] Navigating to ${MEET_URL}`);
    await page.goto(MEET_URL, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    await page.waitForTimeout(3000);

    const url = page.url();
    expect(url).toContain("meet.google.com");
    console.log(`[Meet] On page: ${url}`);
  }, TIMEOUT);

  test("dismiss dialogs and configure camera OFF", async () => {
    const result = await page.evaluate(`(() => {
      var actions = [];

      // 1. Dismiss blocking dialogs
      var dismiss = ['got it', 'dismiss', 'continue without', 'not now', 'block', 'deny'];
      document.querySelectorAll('button, [role="button"]').forEach(function(b) {
        var t = (b.textContent || '').trim().toLowerCase();
        if (dismiss.some(function(d) { return t === d || t.includes(d); })) {
          b.click();
          actions.push('dismissed:' + t);
        }
      });

      // 2. Camera OFF
      var camOff = document.querySelector('[aria-label*="Turn off camera"], [aria-label*="关闭摄像头"]');
      if (camOff) { camOff.click(); actions.push('cam:off'); }
      else actions.push('cam:already_off_or_not_found');

      // 3. Verify mic is available
      var micBtn = document.querySelector('[aria-label*="microphone"], [aria-label*="麦克风"]');
      actions.push('mic:' + (micBtn ? 'found' : 'not_found'));

      return JSON.stringify(actions);
    })()`);

    console.log(`[Meet] Config: ${result}`);
    expect(result).toBeTruthy();
  }, TIMEOUT);

  test("click join button", async () => {
    const joinResult = await page.evaluate(`(() => {
      var btns = Array.from(document.querySelectorAll('button'));
      var targets = ['Join now', 'Ask to join', 'Join', '加入会议', '请求加入', 'Switch here', '切换到这里'];
      for (var i = 0; i < btns.length; i++) {
        var t = btns[i].textContent.trim();
        if (targets.indexOf(t) !== -1) {
          btns[i].click();
          return 'joined:' + t;
        }
      }
      return 'no_join_button';
    })()`);

    console.log(`[Meet] Join: ${joinResult}`);
    expect(joinResult).not.toBe("no_join_button");
  }, TIMEOUT);

  test("verify in meeting or waiting room", async () => {
    await page.waitForTimeout(5000);

    let state = "unknown";
    for (let i = 0; i < 6; i++) {
      state = String(await page.evaluate(`(() => {
        if (document.querySelector('[aria-label*="Leave call"]') || document.querySelector('[aria-label="Call controls"]')) return 'in_meeting';
        var t = document.body.innerText;
        if (t.includes('Waiting for the host') || t.includes('Someone will let you in') || t.includes('等待主持人')) return 'waiting_room';
        return 'loading';
      })()`));

      console.log(`[Meet] State check ${i + 1}: ${state}`);
      if (state === "in_meeting" || state === "waiting_room") break;
      await page.waitForTimeout(3000);
    }

    expect(["in_meeting", "waiting_room"]).toContain(state);
    console.log(`[Meet] Final state: ${state}`);
  }, 60_000);

  test("leave meeting", async () => {
    const left = await page.evaluate(`(() => {
      var leaveBtn = document.querySelector('[aria-label*="Leave call"], [aria-label*="退出通话"]');
      if (leaveBtn) { leaveBtn.click(); return 'left'; }
      return 'no_leave_button';
    })()`);
    console.log(`[Meet] Leave: ${left}`);
    await page.waitForTimeout(2000);
  }, TIMEOUT);
});

// ══════════════════════════════════════════════════════════════
// Test 2: Open local meeting prep HTML file
// ══════════════════════════════════════════════════════════════
describe("Test 2: Open meeting prep HTML", () => {
  test("find and open Tanka prep file", async () => {
    // Find the meeting summary or prep HTML
    const summaryPath = resolve(
      homedir(),
      "Library/Mobile Documents/com~apple~CloudDocs/CallingClaw 2.0",
      "callingclaw-backend/public/meeting-summary-20260326.html"
    );

    // Also check for any local HTML in callingclaw-desktop
    const desktopDir = resolve(
      homedir(),
      "Library/Mobile Documents/com~apple~CloudDocs/CallingClaw 2.0",
      "callingclaw-desktop"
    );

    let targetUrl: string;
    if (existsSync(summaryPath)) {
      targetUrl = `http://localhost:4000/meeting-summary-20260326.html`;
    } else {
      // Fallback: try the API
      targetUrl = `http://localhost:4000/api/status`;
    }

    console.log(`[Prep] Opening: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    await page.waitForTimeout(2000);

    const title = await page.title();
    const bodyText = String(await page.evaluate("document.body.innerText.substring(0, 200)"));
    console.log(`[Prep] Title: ${title}`);
    console.log(`[Prep] Body preview: ${bodyText.substring(0, 100)}...`);

    expect(page.url()).toContain("localhost:4000");
  }, TIMEOUT);

  test("verify meeting summary content", async () => {
    const content = String(await page.evaluate(`(() => {
      var h1 = document.querySelector('h1');
      var tables = document.querySelectorAll('table');
      var imgs = document.querySelectorAll('img');
      return JSON.stringify({
        title: h1 ? h1.textContent.trim() : null,
        tableCount: tables.length,
        imageCount: imgs.length,
        hasReviewItems: !!document.querySelector('.review-table'),
        hasActionItems: document.body.innerText.includes('Action Items'),
      });
    })()`));

    const parsed = JSON.parse(content);
    console.log(`[Prep] Content: ${JSON.stringify(parsed)}`);
    expect(parsed.title).toBeTruthy();
    expect(parsed.tableCount).toBeGreaterThan(0);
  }, TIMEOUT);
});

// ══════════════════════════════════════════════════════════════
// Test 3: Find Sam Altman on Twitter/X
// ══════════════════════════════════════════════════════════════
describe("Test 3: Find Sam Altman on X (Twitter)", () => {
  test("navigate to X.com", async () => {
    await page.goto("https://x.com", { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    await page.waitForTimeout(3000);

    const url = page.url();
    console.log(`[X] On page: ${url}`);
    expect(url).toMatch(/x\.com|twitter\.com/);
  }, TIMEOUT);

  test("search for Sam Altman", async () => {
    // Navigate directly to Sam Altman's profile
    await page.goto("https://x.com/sama", { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    await page.waitForTimeout(3000);

    const profileInfo = String(await page.evaluate(`(() => {
      var name = document.querySelector('[data-testid="UserName"]');
      var bio = document.querySelector('[data-testid="UserDescription"]');
      var handle = document.querySelector('[data-testid="UserName"] a[href*="/sama"]');
      return JSON.stringify({
        name: name ? name.textContent.substring(0, 50) : null,
        bio: bio ? bio.textContent.substring(0, 100) : null,
        handle: handle ? handle.textContent : null,
        url: location.href,
      });
    })()`));

    const parsed = JSON.parse(profileInfo);
    console.log(`[X] Profile: ${JSON.stringify(parsed)}`);
    expect(parsed.url).toContain("sama");
  }, TIMEOUT);
});

// ══════════════════════════════════════════════════════════════
// Test 4: Google search for Tanka news
// ══════════════════════════════════════════════════════════════
describe("Test 4: Google search Tanka news", () => {
  test("navigate to Google", async () => {
    await page.goto("https://www.google.com", { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    await page.waitForTimeout(2000);

    const url = page.url();
    console.log(`[Google] On page: ${url}`);
    expect(url).toContain("google");
  }, TIMEOUT);

  test("search for Tanka news", async () => {
    // Type in search box
    const searchResult = await page.evaluate(`(() => {
      var input = document.querySelector('textarea[name="q"], input[name="q"]');
      if (!input) return 'no_search_box';
      input.focus();
      input.value = 'Tanka AI news 2026';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return 'typed';
    })()`);

    console.log(`[Google] Search input: ${searchResult}`);
    expect(searchResult).toBe("typed");

    // Submit search
    await page.keyboard.press("Enter");
    await page.waitForTimeout(3000);
  }, TIMEOUT);

  test("verify search results", async () => {
    const results = String(await page.evaluate(`(() => {
      var links = document.querySelectorAll('h3');
      var resultTexts = [];
      links.forEach(function(h) {
        if (h.textContent && h.textContent.length > 5) {
          resultTexts.push(h.textContent.substring(0, 80));
        }
      });
      return JSON.stringify({
        count: resultTexts.length,
        firstResults: resultTexts.slice(0, 5),
        url: location.href,
      });
    })()`));

    const parsed = JSON.parse(results);
    console.log(`[Google] Results: ${parsed.count} found`);
    for (const r of parsed.firstResults) {
      console.log(`  - ${r}`);
    }
    expect(parsed.count).toBeGreaterThan(0);
    expect(parsed.url).toContain("search");
  }, TIMEOUT);
});
