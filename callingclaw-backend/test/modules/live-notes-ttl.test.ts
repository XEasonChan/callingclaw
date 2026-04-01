import { test, expect, beforeEach } from "bun:test";
import { MeetingPrepSkill } from "../../src/skills/meeting-prep";
import type { MeetingPrepBrief } from "../../src/skills/meeting-prep";

// Minimal mock adapter
const mockAdapter = {
  name: "test",
  generateMeetingPrep: async () => ({}),
  sendMessage: async () => "",
  isAvailable: async () => true,
} as any;

function createSkillWithBrief(): MeetingPrepSkill {
  const skill = new MeetingPrepSkill(mockAdapter);
  // Manually set a brief since we can't await generate() without a real adapter
  (skill as any)._currentBrief = {
    topic: "test meeting",
    goal: "test",
    generatedAt: Date.now(),
    summary: "",
    keyPoints: [],
    architectureDecisions: [],
    expectedQuestions: [],
    filePaths: [],
    browserUrls: [],
    folderPaths: [],
    attendees: [],
    liveNotes: [],
    _liveNoteTimestamps: [],
  } satisfies MeetingPrepBrief;
  return skill;
}

test("addLiveNote adds note with timestamp", () => {
  const skill = createSkillWithBrief();
  skill.addLiveNote("[CONTEXT] test data");

  expect(skill.currentBrief!.liveNotes).toHaveLength(1);
  expect(skill.currentBrief!.liveNotes[0]).toBe("[CONTEXT] test data");
  expect(skill.currentBrief!._liveNoteTimestamps).toHaveLength(1);
});

test("[DONE] notes are never evicted", () => {
  const skill = createSkillWithBrief();
  const brief = skill.currentBrief!;

  // Add a [DONE] note with an old timestamp (10 minutes ago)
  brief.liveNotes.push("[DONE] opened PRD: success");
  brief._liveNoteTimestamps!.push(Date.now() - 10 * 60 * 1000);

  // Add a fresh note to trigger eviction
  skill.addLiveNote("[CONTEXT] new data");

  // [DONE] should still be there
  expect(brief.liveNotes.some((n) => n.startsWith("[DONE]"))).toBe(true);
  expect(brief.liveNotes).toHaveLength(2);
});

test("expired [CONTEXT] notes are evicted", () => {
  const skill = createSkillWithBrief();
  const brief = skill.currentBrief!;

  // Add an old [CONTEXT] note (6 minutes ago, past 5min TTL)
  brief.liveNotes.push("[CONTEXT] old data");
  brief._liveNoteTimestamps!.push(Date.now() - 6 * 60 * 1000);

  // Add a fresh note to trigger eviction
  skill.addLiveNote("[CONTEXT] new data");

  // Old note should be evicted
  expect(brief.liveNotes).toHaveLength(1);
  expect(brief.liveNotes[0]).toBe("[CONTEXT] new data");
});

test("fresh [CONTEXT] notes are kept", () => {
  const skill = createSkillWithBrief();
  const brief = skill.currentBrief!;

  // Add a recent [CONTEXT] note (2 minutes ago, within 5min TTL)
  brief.liveNotes.push("[CONTEXT] recent data");
  brief._liveNoteTimestamps!.push(Date.now() - 2 * 60 * 1000);

  // Add another note
  skill.addLiveNote("[CONTEXT] new data");

  // Both should be present
  expect(brief.liveNotes).toHaveLength(2);
});

test("expired [SUGGEST] notes are evicted", () => {
  const skill = createSkillWithBrief();
  const brief = skill.currentBrief!;

  // Add old [SUGGEST] note
  brief.liveNotes.push("[SUGGEST] 检测到意图: open_file");
  brief._liveNoteTimestamps!.push(Date.now() - 6 * 60 * 1000);

  skill.addLiveNote("[CONTEXT] trigger eviction");

  // Only the new note should remain
  expect(brief.liveNotes).toHaveLength(1);
  expect(brief.liveNotes[0]).toContain("trigger eviction");
});
