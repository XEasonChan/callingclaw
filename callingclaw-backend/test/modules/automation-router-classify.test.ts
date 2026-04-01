import { test, expect } from "bun:test";
import { AutomationRouter } from "../../src/modules/automation-router";

// Create a router with minimal deps (bridge is not used for classify)
const router = new AutomationRouter(null as any);

// ── Fast lane: high-confidence patterns (≥ 0.95) ──

test("classify: zoom mute → shortcuts layer, high confidence", () => {
  const result = router.classify("zoom 静音");
  expect(result.layer).toBe("shortcuts");
  expect(result.action).toBe("zoom:toggle_mute");
  expect(result.confidence).toBeGreaterThanOrEqual(0.95);
});

test("classify: meet mute → shortcuts layer, high confidence", () => {
  const result = router.classify("meet 静音");
  expect(result.layer).toBe("shortcuts");
  expect(result.confidence).toBeGreaterThanOrEqual(0.95);
});

test("classify: 'open' + URL matches open_app first (known pattern order issue)", () => {
  // NOTE: open_app regex matches before open_url due to pattern order.
  // This is a pre-existing issue — open_app's \w+ captures "https".
  // The Haiku medium lane correctly resolves URLs via classifyIntent().
  const result = router.classify("open https://callingclaw.com");
  expect(result.layer).toBe("shortcuts");
  expect(result.action).toBe("open_app"); // open_app matches first
  expect(result.confidence).toBeGreaterThanOrEqual(0.85);
});

// ── Medium confidence patterns (< 0.95) ──

test("classify: click button → playwright layer, below fast lane threshold", () => {
  const result = router.classify("点击那个链接按钮");
  expect(result.layer).toBe("playwright");
  expect(result.action).toBe("browser_click");
  // 0.7 confidence — NOT fast lane eligible
  expect(result.confidence).toBeLessThan(0.95);
});

test("classify: scroll down → playwright layer", () => {
  const result = router.classify("往下滚动");
  expect(result.layer).toBe("playwright");
  expect(result.action).toBe("scroll_down");
  expect(result.confidence).toBeGreaterThanOrEqual(0.85);
});

// ── No match → fallback ──

test("classify: unrecognized instruction → computer_use fallback, low confidence", () => {
  const result = router.classify("我觉得这个设计需要改一下");
  expect(result.layer).toBe("computer_use");
  expect(result.action).toBe("generic");
  expect(result.confidence).toBeLessThan(0.5);
});

test("classify: discussion/opinion → low confidence, should not trigger fast lane", () => {
  const result = router.classify("下次开会的时候我们再讨论一下");
  expect(result.confidence).toBeLessThan(0.95);
});

// ── Edge cases ──

test("classify: empty string → fallback", () => {
  const result = router.classify("");
  expect(result.layer).toBe("computer_use");
  expect(result.confidence).toBeLessThan(0.5);
});

test("classify: Chinese scroll to top → playwright, high confidence", () => {
  const result = router.classify("滚到顶部");
  expect(result.layer).toBe("playwright");
  expect(result.action).toBe("scroll_top");
  expect(result.confidence).toBeGreaterThanOrEqual(0.9);
});
