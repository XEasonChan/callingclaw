import { test, expect, describe } from "bun:test";
import { topicSimilarity } from "../../src/modules/session-manager";

describe("topicSimilarity", () => {
  test("exact match → 1.0", () => {
    expect(topicSimilarity("Project Review", "Project Review")).toBe(1.0);
  });

  test("case-insensitive match → 1.0", () => {
    expect(topicSimilarity("Project Review", "project review")).toBe(1.0);
  });

  test("strips punctuation, containment still works", () => {
    // After stripping "—", one string contains the other → 0.8
    const score = topicSimilarity("CoCo Launch Video — Personal Version", "coco launch video personal version");
    expect(score).toBeGreaterThanOrEqual(0.8);
  });

  test("containment: short topic inside long → 0.8", () => {
    expect(topicSimilarity("PRD review", "CallingClaw PRD Review")).toBe(0.8);
  });

  test("containment: long topic contains short → 0.8", () => {
    expect(topicSimilarity("CallingClaw PRD Review", "PRD review")).toBe(0.8);
  });

  test("word overlap above 50%", () => {
    const score = topicSimilarity("CoCo Launch Video", "Launch Video Discussion");
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThanOrEqual(0.8);
  });

  test("CJK bigrams: partial Chinese overlap > 0.3", () => {
    const score = topicSimilarity("视频讨论", "CoCo 视频讨论");
    expect(score).toBeGreaterThan(0.3);
  });

  test("CJK exact match", () => {
    expect(topicSimilarity("会议准备测试", "会议准备测试")).toBe(1.0);
  });

  test("no match: unrelated topics < 0.3", () => {
    const score = topicSimilarity("Team Standup", "Product Demo");
    expect(score).toBeLessThan(0.3);
  });

  test("empty string → 0", () => {
    expect(topicSimilarity("", "anything")).toBe(0);
    expect(topicSimilarity("anything", "")).toBe(0);
  });

  test("null/undefined → 0", () => {
    expect(topicSimilarity(null as any, "test")).toBe(0);
    expect(topicSimilarity("test", undefined as any)).toBe(0);
  });

  test("real scenario: prep topic vs generic 'Meeting'", () => {
    // "Meeting" is excluded by the caller, but if somehow passed, should be low
    const score = topicSimilarity("CoCo Launch Video — Personal Version 讨论", "Meeting");
    expect(score).toBeLessThan(0.3);
  });

  test("real scenario: user-typed topic vs prep topic (partial overlap)", () => {
    // "video discussion" vs long prep topic — only 1 shared word, bigram overlap low
    // This is intentionally below threshold (0.21) — prevents false matches
    const score = topicSimilarity(
      "video discussion",
      "CoCo Launch Video — Personal Version 讨论"
    );
    expect(score).toBeLessThan(0.3);
  });

  test("real scenario: better user topic vs prep topic", () => {
    // User types more specific topic that shares multiple words
    const score = topicSimilarity(
      "CoCo Launch Video",
      "CoCo Launch Video — Personal Version 讨论"
    );
    expect(score).toBeGreaterThan(0.3);
  });
});
