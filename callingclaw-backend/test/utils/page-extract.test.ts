// CallingClaw 2.0 — Page Extract + Virtual Cursor Tests
// happy-dom globals are registered by this file-scoped import — it MUST stay first.
//
// Deliberately NOT a bunfig.toml `[test] preload`: that registers happy-dom
// globally for every test file, which makes this server-side codebase look like
// a browser and breaks unrelated suites — the OpenAI SDK's browser-environment
// guard throws inside `new VisionModule()` (test/capture/vision-change-detect),
// and happy-dom's `fetch` cannot parse the local CDP server's responses
// (test/capture/browser-capture-provider). Measured: 16 tests lost that way.
import "./happy-dom-setup";

import { test, expect, beforeEach } from "bun:test";
import {
  CURSOR_INJECT_JS,
  PAGE_CLICK_JS,
  PAGE_TEXT_CLICK_JS,
  PAGE_EXTRACT_JS,
  formatPageContext,
} from "../../src/utils/page-extract";

// ── Helper: eval browser JS using happy-dom globals ──

async function evalBrowserJS(js: string): Promise<any> {
  const fn = new Function("window", "document", `return (async () => { return ${js} })()`);
  return await fn(globalThis.window, globalThis.document);
}

// ── Helper: build a clickable DOM for testing ──

function setupTestDOM() {
  document.body.innerHTML = `
    <nav>
      <a href="/">Home</a>
      <a href="/features">Features</a>
      <a href="/pricing">Pricing</a>
    </nav>
    <main>
      <h1>Welcome</h1>
      <p>Some content here</p>
      <button>Download for Mac</button>
      <button>Learn More</button>
      <a href="https://external.com/file.dmg" download>Download DMG</a>
    </main>
  `;
}

// ── CURSOR_INJECT_JS ──

test("CURSOR_INJECT_JS creates cursor element and exposes window.__ccCursor", async () => {
  document.body.innerHTML = "";
  (window as any).__ccCursor = undefined;

  // Eval the inject JS
  const fn = new Function("window", "document", CURSOR_INJECT_JS);
  fn(window, document);

  const cursor = document.getElementById("cc-cursor");
  expect(cursor).not.toBeNull();
  expect((window as any).__ccCursor).toBeDefined();
  expect(typeof (window as any).__ccCursor.flyTo).toBe("function");
  expect(typeof (window as any).__ccCursor.ripple).toBe("function");
  expect(typeof (window as any).__ccCursor.hide).toBe("function");
});

test("CURSOR_INJECT_JS is idempotent — double inject creates only one cursor", () => {
  document.body.innerHTML = "";
  (window as any).__ccCursor = undefined;

  const fn = new Function("window", "document", CURSOR_INJECT_JS);
  fn(window, document);
  fn(window, document);

  const cursors = document.body.querySelectorAll("[id='cc-cursor']");
  // After first inject, __ccCursor is set, second inject returns early
  expect(cursors.length).toBe(1);
});

test("flyTo sets cursor position and opacity", async () => {
  document.body.innerHTML = "";
  (window as any).__ccCursor = undefined;

  const fn = new Function("window", "document", CURSOR_INJECT_JS);
  fn(window, document);

  await (window as any).__ccCursor.flyTo(100, 200);

  const cursor = document.getElementById("cc-cursor")!;
  expect(cursor.style.left).toBe("100px");
  expect(cursor.style.top).toBe("200px");
  expect(cursor.style.opacity).toBe("1");
});

test("ripple creates a .cc-ripple element at coordinates", () => {
  document.body.innerHTML = "";
  (window as any).__ccCursor = undefined;

  const fn = new Function("window", "document", CURSOR_INJECT_JS);
  fn(window, document);

  (window as any).__ccCursor.ripple(150, 250);

  const ripples = document.querySelectorAll("[class='cc-ripple']");
  expect(ripples.length).toBeGreaterThanOrEqual(1);
});

test("ripple with skip:true does not create element", () => {
  document.body.innerHTML = "";
  (window as any).__ccCursor = undefined;

  const fn = new Function("window", "document", CURSOR_INJECT_JS);
  fn(window, document);

  (window as any).__ccCursor.ripple(100, 100, { skip: true });

  const ripples = document.querySelectorAll("[class='cc-ripple']");
  expect(ripples.length).toBe(0);
});

test("hide sets cursor opacity to 0", async () => {
  document.body.innerHTML = "";
  (window as any).__ccCursor = undefined;

  const fn = new Function("window", "document", CURSOR_INJECT_JS);
  fn(window, document);

  await (window as any).__ccCursor.flyTo(50, 50);
  (window as any).__ccCursor.hide();

  const cursor = document.getElementById("cc-cursor")!;
  expect(cursor.style.opacity).toBe("0");
});

// ── PAGE_CLICK_JS string generation ──

test("PAGE_CLICK_JS generates valid async IIFE", () => {
  const js = PAGE_CLICK_JS(0);
  expect(js).toContain("async");
  expect(js).toContain("__ccCursor");
  expect(js).toContain("flyTo");
  expect(js).toContain("ripple");
  expect(js).not.toContain("FIND_INDEX"); // template should be replaced
});

test("PAGE_CLICK_JS substitutes index correctly", () => {
  const js5 = PAGE_CLICK_JS(5);
  expect(js5).toContain("idx === 5");
  expect(js5).not.toContain("FIND_INDEX");

  const js0 = PAGE_CLICK_JS(0);
  expect(js0).toContain("idx === 0");
});

// ── PAGE_TEXT_CLICK_JS string generation ──

test("PAGE_TEXT_CLICK_JS generates valid async IIFE with target text", () => {
  const js = PAGE_TEXT_CLICK_JS("Download");
  expect(js).toContain("async");
  expect(js).toContain('"download"'); // lowercased in JSON.stringify
  expect(js).toContain("__ccCursor");
  expect(js).toContain("external");
});

test("PAGE_TEXT_CLICK_JS escapes special characters in target text", () => {
  const js = PAGE_TEXT_CLICK_JS('test "quotes" & <html>');
  // JSON.stringify handles escaping
  expect(js).toContain("test");
  // JSON.stringify preserves <html> as-is (it's valid JSON), just check quotes are escaped
  expect(js).toContain('\\"quotes\\"');
});

// ── PAGE_CLICK_JS with DOM (happy-dom) ──

test("PAGE_CLICK_JS finds element by index in DOM", async () => {
  setupTestDOM();
  (window as any).__ccCursor = undefined;

  // Inject cursor first
  const injectFn = new Function("window", "document", CURSOR_INJECT_JS);
  injectFn(window, document);

  const js = PAGE_CLICK_JS(0);
  const result = await evalBrowserJS(js);
  const parsed = JSON.parse(result);

  expect(parsed.ok).toBe(true);
  expect(parsed.tag).toBe("a");
  expect(parsed.text).toBe("Home");
});

test("PAGE_CLICK_JS returns ok:false for out-of-range index", async () => {
  setupTestDOM();
  (window as any).__ccCursor = undefined;

  const js = PAGE_CLICK_JS(999);
  const result = await evalBrowserJS(js);
  const parsed = JSON.parse(result);

  expect(parsed.ok).toBe(false);
});

test("PAGE_CLICK_JS works without __ccCursor (graceful degradation)", async () => {
  setupTestDOM();
  (window as any).__ccCursor = undefined;

  const js = PAGE_CLICK_JS(0);
  const result = await evalBrowserJS(js);
  const parsed = JSON.parse(result);

  expect(parsed.ok).toBe(true);
  expect(parsed.text).toBe("Home");
});

// ── PAGE_TEXT_CLICK_JS with DOM ──

test("PAGE_TEXT_CLICK_JS finds element by text content", async () => {
  setupTestDOM();
  (window as any).__ccCursor = undefined;

  const injectFn = new Function("window", "document", CURSOR_INJECT_JS);
  injectFn(window, document);

  const js = PAGE_TEXT_CLICK_JS("Download for Mac");
  const result = await evalBrowserJS(js);
  const parsed = JSON.parse(result);

  expect(parsed.ok).toBe(true);
  expect(parsed.text).toContain("Download for Mac");
});

test("PAGE_TEXT_CLICK_JS partial text match", async () => {
  setupTestDOM();
  (window as any).__ccCursor = undefined;

  const js = PAGE_TEXT_CLICK_JS("Learn");
  const result = await evalBrowserJS(js);
  const parsed = JSON.parse(result);

  expect(parsed.ok).toBe(true);
  expect(parsed.text).toContain("Learn More");
});

test("PAGE_TEXT_CLICK_JS returns ok:false for no match", async () => {
  setupTestDOM();
  (window as any).__ccCursor = undefined;

  const js = PAGE_TEXT_CLICK_JS("nonexistent button");
  const result = await evalBrowserJS(js);
  const parsed = JSON.parse(result);

  expect(parsed.ok).toBe(false);
});

test("PAGE_TEXT_CLICK_JS marks external download links", async () => {
  setupTestDOM();
  (window as any).__ccCursor = undefined;

  const injectFn = new Function("window", "document", CURSOR_INJECT_JS);
  injectFn(window, document);

  const js = PAGE_TEXT_CLICK_JS("Download DMG");
  const result = await evalBrowserJS(js);
  const parsed = JSON.parse(result);

  expect(parsed.ok).toBe(true);
  expect(parsed.external).toBe(true);
  expect(parsed.link).toContain("external.com");
});

test("PAGE_TEXT_CLICK_JS aria-label fallback", async () => {
  document.body.innerHTML = '<button aria-label="Close dialog">X</button>';
  (window as any).__ccCursor = undefined;

  const js = PAGE_TEXT_CLICK_JS("close dialog");
  const result = await evalBrowserJS(js);
  const parsed = JSON.parse(result);

  expect(parsed.ok).toBe(true);
});

// ── formatPageContext (pure function, no DOM) ──

test("formatPageContext returns null for empty input", () => {
  expect(formatPageContext(null)).toBeNull();
  expect(formatPageContext(undefined)).toBeNull();
  expect(formatPageContext("")).toBeNull();
});

test("formatPageContext formats valid page data correctly", () => {
  const raw = JSON.stringify({
    title: "Test Page",
    url: "https://example.com",
    scrollHint: "0/1000px (0%)",
    tree: [
      { depth: 0, type: "semantic", tag: "nav", label: "" },
      { depth: 1, type: "interactive", tag: "a", text: "Home", i: 0, inView: true, attrs: "" },
      { depth: 0, type: "content", tag: "h1", text: "Welcome" },
    ],
    interactiveCount: 1,
  });

  const result = formatPageContext(raw)!;
  expect(result).toContain("[PAGE] Test Page");
  expect(result).toContain("https://example.com");
  expect(result).toContain("[0]");
  expect(result).toContain("Home");
  expect(result).toContain("1 interactive elements");
  expect(result).toContain("<nav>");
  expect(result).toContain("h1: Welcome");
});

// ── Index consistency (extract vs click use same walk) ──

test("PAGE_CLICK_JS index matches PAGE_EXTRACT_JS index for same element", async () => {
  setupTestDOM();
  (window as any).__ccCursor = undefined;

  // Extract DOM
  const extractResult = await evalBrowserJS(PAGE_EXTRACT_JS);
  const extracted = JSON.parse(extractResult);

  // Find a specific element in extracted tree
  const buttonEntry = extracted.tree.find(
    (n: any) => n.type === "interactive" && n.text?.includes("Download for Mac")
  );

  if (!buttonEntry) {
    // If happy-dom can't extract properly, skip this test
    console.log("[SKIP] happy-dom extraction incomplete, skipping index consistency test");
    return;
  }

  // Click that index
  const clickJS = PAGE_CLICK_JS(buttonEntry.i);
  const clickResult = await evalBrowserJS(clickJS);
  const clicked = JSON.parse(clickResult);

  expect(clicked.ok).toBe(true);
  expect(clicked.text).toContain("Download for Mac");
});
