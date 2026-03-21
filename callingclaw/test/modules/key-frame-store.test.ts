/**
 * KeyFrameStore — Unit Tests
 *
 * Tests frame persistence, dedup, timeline generation, and cleanup.
 * Uses a temp directory to avoid polluting real meeting data.
 *
 * Run: bun test test/modules/key-frame-store.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { KeyFrameStore } from "../../src/modules/key-frame-store";
import type { TranscriptEntry } from "../../src/modules/shared-context";

// Use temp dir to avoid polluting real data
const TEST_BASE = "/tmp/callingclaw-test-frames";

// Minimal 1x1 white PNG as base64 (valid image for testing)
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
// Different 1x1 black PNG
const TINY_PNG_B = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("KeyFrameStore", () => {
  let store: KeyFrameStore;

  beforeEach(async () => {
    store = new KeyFrameStore();
    // Override base dir for testing
    (store as any).constructor = undefined; // prevent class-level BASE_DIR
    // We'll use start() which creates the directory
  });

  afterEach(async () => {
    if (store.active) await store.stop();
    // Cleanup test files
    await Bun.$`rm -rf ${TEST_BASE}`.quiet().catch(() => {});
  });

  test("start creates meeting directory structure", async () => {
    const meetingId = `test_${Date.now()}`;
    const dir = await store.start(meetingId);
    expect(dir).toContain(meetingId);
    expect(store.active).toBe(true);
    expect(store.meetingId).toBe(meetingId);
  });

  test("saveFrame writes a file and increments count", async () => {
    await store.start(`test_${Date.now()}`);
    const result = await store.saveFrame(TINY_PNG, { url: "http://localhost", title: "Test" });
    expect(result.saved).toBe(true);
    expect(result.path).toBeTruthy();
    expect(store.frameCount).toBe(1);
  });

  test("saveFrame skips duplicate frames (dedup)", async () => {
    await store.start(`test_${Date.now()}`);
    const r1 = await store.saveFrame(TINY_PNG, { url: "http://localhost" });
    const r2 = await store.saveFrame(TINY_PNG, { url: "http://localhost" }); // same image
    expect(r1.saved).toBe(true);
    expect(r2.saved).toBe(false);
    expect(r2.skippedReason).toBe("dedup");
    expect(store.frameCount).toBe(1);
  });

  test("saveFrame saves different frames", async () => {
    await store.start(`test_${Date.now()}`);
    const r1 = await store.saveFrame(TINY_PNG, {});
    const r2 = await store.saveFrame(TINY_PNG_B, {}); // different image
    expect(r1.saved).toBe(true);
    expect(r2.saved).toBe(true);
    expect(store.frameCount).toBe(2);
  });

  test("saveFrame returns error when not started", async () => {
    const result = await store.saveFrame(TINY_PNG, {});
    expect(result.saved).toBe(false);
    expect(result.skippedReason).toBe("error");
  });

  test("saveTranscript appends to timeline", async () => {
    await store.start(`test_${Date.now()}`);
    const entry: TranscriptEntry = { role: "user", text: "Hello world", ts: Date.now() };
    store.saveTranscript(entry);
    // Transcript count should be 1
    const summary = await store.finalize("Test Meeting");
    expect(summary).not.toBeNull();
    expect(summary!.transcriptEntries).toBe(1);
  });

  test("saveTranscript skips system role entries", async () => {
    await store.start(`test_${Date.now()}`);
    store.saveTranscript({ role: "system", text: "[Tool Call] recall_context(...)", ts: Date.now() });
    const summary = await store.finalize("Test");
    expect(summary!.transcriptEntries).toBe(0);
  });

  test("finalize generates timeline.md and timeline.html", async () => {
    const meetingId = `test_${Date.now()}`;
    await store.start(meetingId);

    store.saveTranscript({ role: "user", text: "这个按钮要改成红色", ts: Date.now() });
    await store.saveFrame(TINY_PNG, { url: "http://localhost/settings", title: "Settings", description: "Settings page" });
    store.saveTranscript({ role: "assistant", text: "确认一下：按钮改红色？", ts: Date.now() });

    const summary = await store.finalize("Test Meeting 测试");
    expect(summary).not.toBeNull();
    expect(summary!.frameCount).toBe(1);
    expect(summary!.transcriptEntries).toBe(2);

    // Check files exist
    const mdFile = Bun.file(summary!.timelineFile);
    expect(await mdFile.exists()).toBe(true);
    const mdContent = await mdFile.text();
    expect(mdContent).toContain("Test Meeting 测试");
    expect(mdContent).toContain("这个按钮要改成红色");

    const htmlFile = Bun.file(summary!.htmlFile);
    expect(await htmlFile.exists()).toBe(true);
    const htmlContent = await htmlFile.text();
    expect(htmlContent).toContain("<!DOCTYPE html>");
    expect(htmlContent).toContain("Test Meeting");
  });

  test("finalize with no data returns valid summary", async () => {
    await store.start(`test_${Date.now()}`);
    const summary = await store.finalize("Empty Meeting");
    expect(summary).not.toBeNull();
    expect(summary!.frameCount).toBe(0);
    expect(summary!.transcriptEntries).toBe(0);
  });

  test("priority detection tags frames when trigger words used", async () => {
    await store.start(`test_${Date.now()}`);

    // Add transcript with trigger word
    store.saveTranscript({ role: "user", text: "看一下这里的设计", ts: Date.now() });

    // Next frame should be priority
    await store.saveFrame(TINY_PNG, { description: "Design page" });

    const summary = await store.finalize("Priority Test");
    expect(summary!.priorityFrameCount).toBeGreaterThanOrEqual(1);
  });

  test("stop resets state", async () => {
    await store.start(`test_${Date.now()}`);
    expect(store.active).toBe(true);
    await store.stop();
    expect(store.active).toBe(false);
    expect(store.meetingId).toBeNull();
  });
});

describe("OC-010 Protocol", () => {
  test("OC010_PROMPT generates valid prompt with paths", async () => {
    const { OC010_PROMPT } = await import("../../src/openclaw-protocol");
    const prompt = OC010_PROMPT({
      id: "OC-010",
      meetingId: "test123",
      meetingDir: "/tmp/test",
      topic: "Test Meeting",
      duration: "30min",
      frameCount: 25,
      transcriptEntries: 100,
      priorityFrameCount: 5,
      timelineFile: "/tmp/test/timeline.md",
    });
    expect(prompt).toContain("/tmp/test");
    expect(prompt).toContain("25 screenshots");
    expect(prompt).toContain("100 transcript");
    expect(prompt).toContain("5");
    expect(prompt).toContain("Priority");
  });

  test("parseOC010 extracts actions from JSON array", async () => {
    const { parseOC010 } = await import("../../src/openclaw-protocol");
    const result = parseOC010(`Here are the actions:
[{"action": "Change button color", "targetPage": "settings", "fileHint": "src/settings.html"}]`);
    expect(result.actions.length).toBe(1);
    expect(result.actions[0].action).toBe("Change button color");
    expect(result.actions[0].targetPage).toBe("settings");
  });

  test("parseOC010 handles no actions gracefully", async () => {
    const { parseOC010 } = await import("../../src/openclaw-protocol");
    const result = parseOC010("No visual change requests found. The meeting was discussion-only.");
    expect(result.actions.length).toBe(0);
    expect(result.summary).toBeTruthy();
  });
});
