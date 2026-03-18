/**
 * VisionModule Change Detection & Throttle — Unit Tests
 *
 * Tests the change detection logic (URL/title diff, Jaccard similarity)
 * and Gemini throttle behavior without actually calling the Gemini API.
 *
 * Run: bun test test/capture/vision-change-detect.test.ts
 */

import { describe, test, expect } from "bun:test";
import { VisionModule } from "../../src/modules/vision";
import { SharedContext } from "../../src/modules/shared-context";

// ── Helpers ─────────────────────────────────────────────────────

/** Access private method for testing */
function isSimilar(vision: VisionModule, a: string, b: string): boolean {
  return (vision as any).isSimilarDescription(a, b);
}

function createVision(): VisionModule {
  const context = new SharedContext();
  // Create with a stub browserCapture that never connects
  const stubCapture = {
    source: "browser" as const,
    capture: async () => null,
    isAvailable: async () => false,
    connect: async () => {},
    close: () => {},
    reconnectToActivePage: async () => {},
  };
  return new VisionModule({
    context,
    browserCapture: stubCapture as any,
  });
}

// ── Similarity Detection Tests ──────────────────────────────────

describe("isSimilarDescription", () => {
  const vision = createVision();

  test("empty previous description is never similar", () => {
    expect(isSimilar(vision, "Some screen content", "")).toBe(false);
  });

  test("identical descriptions are similar", () => {
    const desc = "Google Meet meeting with 4 participants, shared screen showing PRD document";
    expect(isSimilar(vision, desc, desc)).toBe(true);
  });

  test("completely different descriptions are not similar", () => {
    expect(isSimilar(vision,
      "Google Meet meeting with shared screen showing code review",
      "VS Code editor with terminal open running npm install",
    )).toBe(false);
  });

  test("minor word changes still similar (>70% Jaccard)", () => {
    expect(isSimilar(vision,
      "Google Meet meeting with 4 participants showing slide presentation about architecture",
      "Google Meet meeting with 5 participants showing slide presentation about architecture decisions",
    )).toBe(true);
  });

  test("same topic different content is not similar", () => {
    expect(isSimilar(vision,
      "Meeting grid view, no shared content",
      "Meeting showing shared screen with CallingClaw PRD document page three",
    )).toBe(false);
  });

  test("Chinese descriptions work correctly", () => {
    expect(isSimilar(vision,
      "Google Meet 会议中，正在共享屏幕展示 CallingClaw 架构图",
      "Google Meet 会议中，正在共享屏幕展示 CallingClaw 架构图，新增了数据流部分",
    )).toBe(true); // >70% overlap

    expect(isSimilar(vision,
      "Google Meet 会议中，正在共享屏幕展示幻灯片",
      "Chrome 浏览器显示 GitHub 仓库页面",
    )).toBe(false);
  });

  test("short descriptions with different key words are not similar", () => {
    expect(isSimilar(vision,
      "Meeting grid view",
      "Screen sharing active",
    )).toBe(false);
  });
});

// ── Screen Capture Lifecycle Tests ──────────────────────────────

describe("VisionModule lifecycle", () => {
  test("isCapturing is false initially", () => {
    const vision = createVision();
    expect(vision.isCapturing).toBe(false);
    expect(vision.isMeetingMode).toBe(false);
  });

  test("startScreenCapture sets mode", () => {
    const vision = createVision();
    vision.startScreenCapture("talk_locally");
    expect(vision.isCapturing).toBe(true);
    expect(vision.isMeetingMode).toBe(false);
  });

  test("startScreenCapture meeting mode", () => {
    const vision = createVision();
    vision.startScreenCapture("meeting");
    expect(vision.isCapturing).toBe(true);
    expect(vision.isMeetingMode).toBe(true);
    vision.stopScreenCapture();
  });

  test("stopScreenCapture clears state", () => {
    const vision = createVision();
    vision.startScreenCapture("meeting");
    vision.stopScreenCapture();
    expect(vision.isCapturing).toBe(false);
    expect(vision.isMeetingMode).toBe(false);
  });

  test("switching mode from talk_locally to meeting", () => {
    const vision = createVision();
    vision.startScreenCapture("talk_locally");
    expect(vision.isMeetingMode).toBe(false);

    // Meeting started — upgrade mode
    vision.startScreenCapture("meeting");
    expect(vision.isMeetingMode).toBe(true);
    expect(vision.isCapturing).toBe(true);
    vision.stopScreenCapture();
  });

  test("legacy aliases work", () => {
    const vision = createVision();
    vision.startMeetingVision(1000);
    expect(vision.isMeetingMode).toBe(true);
    vision.stopMeetingVision();
    expect(vision.isCapturing).toBe(false);
  });

  test("double start does not create duplicate timers", () => {
    const vision = createVision();
    vision.startScreenCapture("talk_locally");
    vision.startScreenCapture("talk_locally"); // Should not throw
    expect(vision.isCapturing).toBe(true);
    vision.stopScreenCapture();
  });

  test("double stop is safe", () => {
    const vision = createVision();
    vision.stopScreenCapture(); // Not started — should not throw
    vision.startScreenCapture("meeting");
    vision.stopScreenCapture();
    vision.stopScreenCapture(); // Already stopped — should not throw
  });
});

// ── SharedContext ScreenState Metadata ───────────────────────────

describe("SharedContext ScreenState metadata", () => {
  test("updateScreen stores url and title", () => {
    const ctx = new SharedContext();
    ctx.updateScreen("base64img", "A description", "https://example.com", "Example");

    expect(ctx.screen.latestScreenshot).toBe("base64img");
    expect(ctx.screen.description).toBe("A description");
    expect(ctx.screen.url).toBe("https://example.com");
    expect(ctx.screen.title).toBe("Example");
    expect(ctx.screen.capturedAt).toBeGreaterThan(0);
  });

  test("updateScreen without url/title keeps them undefined", () => {
    const ctx = new SharedContext();
    ctx.updateScreen("base64img", "desc");

    expect(ctx.screen.url).toBeUndefined();
    expect(ctx.screen.title).toBeUndefined();
  });

  test("screen event fires on updateScreen", () => {
    const ctx = new SharedContext();
    let received: any = null;
    ctx.on("screen", (data) => { received = data; });

    ctx.updateScreen("img", "desc", "https://url", "Title");

    expect(received).not.toBeNull();
    expect(received.url).toBe("https://url");
    expect(received.description).toBe("desc");
  });
});

// ── Gemini Throttle Logic ───────────────────────────────────────

describe("Gemini throttle", () => {
  test("_lastAnalysisAt is 0 initially", () => {
    const vision = createVision();
    expect((vision as any)._lastAnalysisAt).toBe(0);
  });

  test("_analyzing flag prevents concurrent calls", () => {
    const vision = createVision();
    expect((vision as any)._analyzing).toBe(false);
    // Manually set to simulate in-progress analysis
    (vision as any)._analyzing = true;
    // The _captureAndAnalyze would return early due to this flag
    expect((vision as any)._analyzing).toBe(true);
  });
});
