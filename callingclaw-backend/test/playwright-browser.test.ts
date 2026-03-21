/**
 * Playwright CLI Browser Automation — E2E Test Suite
 *
 * These are real browser tests that require a headed Chrome instance.
 * Run individually: bun run test/playwright-browser.test.ts [test-name]
 *
 * Test names:
 *   meet-join        — Join Google Meet, verify devices, leave
 *   meet-devices     — Inspect Meet pre-join device picker DOM
 *   x-search         — Navigate to X, find Sam Altman's profile
 *   google-search    — Search Google for "Manus AI news"
 *   all              — Run all tests sequentially
 *
 * NOTE: playwright-cli eval wraps JS in `() => (EXPR)`, so all evaluate()
 * calls must pass arrow functions `() => { ... }`, NOT IIFEs `(() => {})()`
 */

import { PlaywrightCLIClient } from "../src/mcp_client/playwright-cli";

const TEST_MEET_URL = process.env.MEET_URL || "https://meet.google.com/phh-sfao-ogg";
const testName = process.argv[2] || "all";

// ── Helpers ─────────────────────────────────────────────────────

const cli = new PlaywrightCLIClient();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(section: string, msg: string) {
  console.log(`\x1b[36m[${section}]\x1b[0m ${msg}`);
}
function pass(section: string, msg: string) {
  console.log(`\x1b[32m✓ [${section}]\x1b[0m ${msg}`);
}
function fail(section: string, msg: string) {
  console.log(`\x1b[31m✗ [${section}]\x1b[0m ${msg}`);
}

// ── Test: Google Meet Join + Device Selection ───────────────────

async function testMeetJoin() {
  log("meet-join", "Starting Google Meet join test...");

  const result = await cli.joinGoogleMeet(TEST_MEET_URL, {
    displayName: "CallingClaw-Test",
    muteCamera: true,
    muteMic: false,
    micDevice: "BlackHole 16ch",
    speakerDevice: "BlackHole 2ch",
    onStep: (step) => log("meet-join", step),
  });

  if (result.success && result.state === "in_meeting") {
    pass("meet-join", `Joined meeting — ${result.summary}`);
  } else if (result.state === "waiting_room") {
    pass("meet-join", `In waiting room (expected if not host)`);
  } else {
    fail("meet-join", `Join failed: ${result.summary}`);
    console.log("  Steps:", result.steps);
  }

  // Verify audio devices are correct AFTER joining
  log("meet-join", "Verifying in-meeting audio settings...");
  await wait(2000);

  // Open in-meeting settings to check devices
  const settingsCheck = await cli.evaluate(`() => {
    const more = document.querySelector('[aria-label="More options"], [aria-label="更多选项"]');
    if (more) { more.click(); return 'opened_more'; }
    return 'no_more_btn';
  }`);
  log("meet-join", `Settings: ${settingsCheck}`);

  if (settingsCheck.includes("opened_more")) {
    await wait(800);
    const clicked = await cli.evaluate(`() => {
      const items = [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], li')];
      const settings = items.find(i => {
        const t = (i.textContent || '').trim();
        return t === 'Settings' || t === '设置';
      });
      if (settings) { settings.click(); return 'opened_settings'; }
      return 'items: ' + items.map(i => i.textContent?.trim().substring(0, 30)).join(' | ');
    }`);
    log("meet-join", `Settings click: ${clicked}`);

    if (clicked.includes("opened_settings")) {
      await wait(1000);
      // Read the audio tab device selections
      const devices = await cli.evaluate(`() => {
        // Click Audio tab if visible
        const tabs = [...document.querySelectorAll('[role="tab"], button')];
        const audioTab = tabs.find(t => {
          const txt = (t.textContent || '').trim();
          return txt === 'Audio' || txt === '音频';
        });
        if (audioTab) audioTab.click();

        // Read all select/dropdown values
        const selects = [...document.querySelectorAll('select')];
        const result = selects.map(s => ({
          label: s.getAttribute('aria-label') || s.closest('label')?.textContent?.trim() || 'unknown',
          value: s.options[s.selectedIndex]?.text || s.value,
        }));

        // Also look for non-select device labels
        const labels = [...document.querySelectorAll('[aria-label*="Microphone"], [aria-label*="Speaker"], [aria-label*="麦克风"], [aria-label*="扬声器"]')];
        const ariaDevices = labels.map(l => ({
          aria: l.getAttribute('aria-label'),
          text: l.textContent?.trim().substring(0, 60),
        }));

        return JSON.stringify({ selects: result, ariaDevices });
      }`);
      log("meet-join", `Audio devices: ${devices}`);

      // Close settings
      await cli.pressKey("Escape");
    }
  }

  // Leave meeting
  log("meet-join", "Leaving meeting...");
  await cli.evaluate(`() => {
    const leave = document.querySelector('[aria-label*="Leave call"], [aria-label*="退出通话"]');
    if (leave) { leave.click(); return 'left'; }
    return 'no_leave_btn';
  }`);

  pass("meet-join", "Test complete");
}

// ── Test: Inspect Meet Device Picker DOM ────────────────────────

async function testMeetDevices() {
  log("meet-devices", "Navigating to Meet pre-join page...");
  await cli.navigate(TEST_MEET_URL);
  await wait(3000);

  // Dismiss dialogs
  await cli.evaluate(`() => {
    const dismiss = ['got it', 'dismiss', 'continue without', 'not now', 'block', 'deny'];
    document.querySelectorAll('button, [role="button"]').forEach(b => {
      const t = (b.textContent || '').trim().toLowerCase();
      if (dismiss.some(d => t === d || t.includes(d))) b.click();
    });
    return 'dismissed';
  }`);
  await wait(1000);

  // Find device selector buttons
  const buttons = await cli.evaluate(`() => {
    const btns = [...document.querySelectorAll('[aria-label]')].filter(b => {
      const a = (b.getAttribute('aria-label') || '');
      return a.startsWith('Microphone') || a.startsWith('Speaker') || a.startsWith('Camera') ||
             a.startsWith('麦克风') || a.startsWith('扬声器') || a.startsWith('摄像头');
    });
    return JSON.stringify(btns.map(b => ({
      tag: b.tagName,
      aria: b.getAttribute('aria-label'),
      role: b.getAttribute('role'),
    })));
  }`);
  log("meet-devices", `Device buttons: ${buttons}`);

  // Open microphone dropdown and inspect DOM
  log("meet-devices", "Opening microphone dropdown...");
  const micClicked = await cli.evaluate(`() => {
    const btn = document.querySelector('[aria-label^="Microphone:"], [aria-label^="麦克风:"]');
    if (btn) { btn.click(); return 'opened: ' + btn.getAttribute('aria-label'); }
    return 'not_found';
  }`);
  log("meet-devices", `Mic dropdown: ${micClicked}`);
  await wait(800);

  // Dump full dropdown DOM structure
  const micItems = await cli.evaluate(`() => {
    const selectors = [
      '[role="menuitemradio"]',
      '[role="option"]',
      '[role="menuitem"]',
      'li[role="presentation"]',
      'ul[role="listbox"] li',
    ];
    const items = new Set();
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(el => items.add(el));
    }
    return JSON.stringify([...items].map((el) => ({
      tag: el.tagName,
      role: el.getAttribute('role'),
      text: (el.textContent || '').trim().substring(0, 80),
      children: el.children.length,
      ariaChecked: el.getAttribute('aria-checked'),
      innerHTML: el.innerHTML.substring(0, 200),
    })));
  }`);

  try {
    const parsed = JSON.parse(micItems);
    log("meet-devices", `Found ${parsed.length} dropdown items:`);
    for (const item of parsed) {
      console.log(`  ${item.role || item.tag} | checked=${item.ariaChecked} | "${item.text}"`);
      if (item.innerHTML.length > 0) {
        console.log(`    innerHTML: ${item.innerHTML.substring(0, 120)}`);
      }
    }
  } catch {
    log("meet-devices", `Raw items: ${micItems}`);
  }

  // Close dropdown
  await cli.pressKey("Escape");
  await wait(300);

  // Open speaker dropdown
  log("meet-devices", "Opening speaker dropdown...");
  const spkClicked = await cli.evaluate(`() => {
    const btn = document.querySelector('[aria-label^="Speaker:"], [aria-label^="扬声器:"]');
    if (btn) { btn.click(); return 'opened: ' + btn.getAttribute('aria-label'); }
    return 'not_found';
  }`);
  log("meet-devices", `Speaker dropdown: ${spkClicked}`);
  await wait(800);

  const spkItems = await cli.evaluate(`() => {
    const selectors = ['[role="menuitemradio"]', '[role="option"]', '[role="menuitem"]', 'li[data-value]'];
    const items = new Set();
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(el => items.add(el));
    }
    return JSON.stringify([...items].map((el) => ({
      tag: el.tagName,
      role: el.getAttribute('role'),
      text: (el.textContent || '').trim().substring(0, 80),
      ariaChecked: el.getAttribute('aria-checked'),
    })));
  }`);

  try {
    const parsed = JSON.parse(spkItems);
    log("meet-devices", `Found ${parsed.length} speaker items:`);
    for (const item of parsed) {
      console.log(`  ${item.role || item.tag} | checked=${item.ariaChecked} | "${item.text}"`);
    }
  } catch {
    log("meet-devices", `Raw items: ${spkItems}`);
  }

  await cli.pressKey("Escape");
  pass("meet-devices", "Device DOM inspection complete");
}

// ── Test: X (Twitter) — Find Sam Altman ─────────────────────────

async function testXSearch() {
  log("x-search", "Navigating to x.com/sama...");
  await cli.navigate("https://x.com/sama");
  await wait(3000);

  // Check page state
  const pageState = await cli.evaluate(`() => {
    const title = document.title;
    const url = location.href;
    const loginBtn = document.querySelector('[data-testid="loginButton"], a[href="/login"]');
    const hasTimeline = document.querySelector('[data-testid="primaryColumn"]');
    const hasProfile = document.querySelector('[data-testid="UserName"]');
    return JSON.stringify({
      title, url,
      hasLoginWall: !!loginBtn,
      hasTimeline: !!hasTimeline,
      hasProfile: !!hasProfile,
    });
  }`);
  log("x-search", `Page state: ${pageState}`);

  let state: any;
  try { state = JSON.parse(pageState); } catch { state = {}; }

  if (state.hasProfile) {
    pass("x-search", `Found Sam Altman's profile: ${state.title}`);

    // Get profile info
    const profile = await cli.evaluate(`() => {
      const name = document.querySelector('[data-testid="UserName"]')?.textContent?.trim() || 'unknown';
      const bio = document.querySelector('[data-testid="UserDescription"]')?.textContent?.trim() || 'no bio';
      const followers = document.querySelector('a[href$="/verified_followers"]')?.textContent?.trim() || 'unknown';
      return JSON.stringify({ name, bio: bio.substring(0, 120), followers });
    }`);
    log("x-search", `Profile: ${profile}`);
  } else if (state.hasLoginWall) {
    log("x-search", "Login wall detected — trying search route...");
    await cli.navigate("https://x.com/search?q=sam%20altman&src=typed_query&f=user");
    await wait(3000);

    const searchResult = await cli.evaluate(`() => {
      const users = [...document.querySelectorAll('[data-testid="UserCell"]')];
      return JSON.stringify(users.slice(0, 3).map(u => ({
        text: u.textContent?.trim().substring(0, 100),
      })));
    }`);
    log("x-search", `Search results: ${searchResult}`);
  } else {
    log("x-search", `Unexpected state — title: ${state.title}`);
    const screenshotPath = await cli.screenshot();
    log("x-search", `Screenshot: ${screenshotPath}`);
  }

  pass("x-search", "Test complete");
}

// ── Test: Google Search — Manus AI News ─────────────────────────

async function testGoogleSearch() {
  log("google-search", "Navigating to Google...");
  await cli.navigate("https://www.google.com");
  await wait(2000);

  // Accept cookie dialog if present
  await cli.evaluate(`() => {
    const btns = [...document.querySelectorAll('button')];
    const accept = btns.find(b => {
      const t = (b.textContent || '').trim().toLowerCase();
      return t.includes('accept all') || t.includes('i agree') || t.includes('全部接受');
    });
    if (accept) { accept.click(); return 'accepted'; }
    return 'no_cookie_dialog';
  }`);

  // Use direct URL navigation for Google search (most reliable)
  log("google-search", "Searching for 'Manus AI latest news 2026'...");
  await cli.navigate("https://www.google.com/search?q=Manus+AI+latest+news+2026");
  await wait(3000);

  // Check results
  const results = await cli.evaluate(`() => {
    const links = [...document.querySelectorAll('#search a h3, #rso a h3')];
    const topResults = links.slice(0, 5).map(h => ({
      title: h.textContent?.trim(),
      url: h.closest('a')?.href || '',
    }));
    return JSON.stringify({ resultCount: links.length, top: topResults });
  }`);

  try {
    const parsed = JSON.parse(results);
    if (parsed.resultCount > 0) {
      pass("google-search", `Found ${parsed.resultCount} results`);
      console.log("  Top results:");
      for (const r of parsed.top) {
        console.log(`    - ${r.title}`);
      }
    } else {
      fail("google-search", "No search results found");
      const screenshotPath = await cli.screenshot();
      log("google-search", `Screenshot: ${screenshotPath}`);
    }
  } catch {
    log("google-search", `Raw results: ${results}`);
  }

  pass("google-search", "Test complete");
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  console.log("\n\x1b[1m═══ CallingClaw Playwright CLI Browser Tests ═══\x1b[0m\n");

  try {
    await cli.start();
    log("setup", "Playwright CLI ready");
  } catch (e: any) {
    fail("setup", `Cannot start Playwright CLI: ${e.message}`);
    process.exit(1);
  }

  const tests: Record<string, () => Promise<void>> = {
    "meet-join": testMeetJoin,
    "meet-devices": testMeetDevices,
    "x-search": testXSearch,
    "google-search": testGoogleSearch,
  };

  if (testName === "all") {
    for (const [name, fn] of Object.entries(tests)) {
      console.log(`\n\x1b[1m── ${name} ──\x1b[0m`);
      try { await fn(); } catch (e: any) { fail(name, `Error: ${e.message}`); }
    }
  } else if (tests[testName]) {
    try { await tests[testName](); } catch (e: any) { fail(testName, `Error: ${e.message}`); }
  } else {
    console.log(`Unknown test: ${testName}`);
    console.log(`Available: ${Object.keys(tests).join(", ")}, all`);
    process.exit(1);
  }

  console.log("\n\x1b[1m═══ Done ═══\x1b[0m\n");
}

main().catch(console.error);
